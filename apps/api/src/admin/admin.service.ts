import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../infra/db.service';

/** Confidence below this counts as "low" (same cut as pipeline.verify / pipeline.status). */
const LOW_CONFIDENCE = 0.35;

/**
 * Numbers for the admin page (PLAN.md 13): how courses get asked for and how fast, what happens to them afterwards
 * (shared, edited, walked), reports, AI use, pipeline runs, and the shops that need a look.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  /** Kakao account ids allowed on the admin page: ADMIN_KAKAO_IDS=123,456 in .env. */
  async isAdmin(userId: string | null): Promise<boolean> {
    if (!userId) return false;
    const allowed = (this.config.get<string>('ADMIN_KAKAO_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowed.length) return false;
    const r = await this.db.pool.query<{ kakao_id: string | null }>('SELECT kakao_id::text FROM users WHERE id = $1', [userId]);
    return !!r.rows[0]?.kakao_id && allowed.includes(r.rows[0].kakao_id);
  }

  async report(days: number) {
    const d = Math.min(Math.max(Math.round(days), 1), 365);
    const q = async <T>(sql: string, params: unknown[] = []) => (await this.db.pool.query(sql, [d, ...params])).rows as T[];
    const since = `now() - make_interval(days => $1)`;

    const [users] = await q<{ active: number; logged_in: number; new_users: number }>(
      `SELECT count(DISTINCT e.user_id)::int AS active,
              count(DISTINCT e.user_id) FILTER (WHERE u.kind = 'kakao')::int AS logged_in,
              (SELECT count(*)::int FROM users WHERE created_at > ${since}) AS new_users
       FROM app_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.created_at > ${since}`,
    );

    const byMode = await q<{ mode: string; n: number; p50: number | null; p90: number | null }>(
      `SELECT input_mode AS mode, count(*)::int AS n,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY plan_ms))::int AS p50,
              round(percentile_cont(0.9) WITHIN GROUP (ORDER BY plan_ms))::int AS p90
       FROM courses WHERE NOT frozen AND shared_from IS NULL AND created_at > ${since}
       GROUP BY input_mode ORDER BY n DESC`,
    );

    const actions = await q<{ kind: string; n: number; failed: number; p50: number | null; p90: number | null }>(
      `SELECT kind, count(*)::int AS n, count(*) FILTER (WHERE NOT ok)::int AS failed,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms))::int AS p50,
              round(percentile_cont(0.9) WITHIN GROUP (ORDER BY ms))::int AS p90
       FROM app_events WHERE created_at > ${since} GROUP BY kind ORDER BY n DESC`,
    );

    // What happened to the courses made in the window. A course counts as walked when its owner marked stops of it
    // as visited afterwards; completed when every stop of one of its versions was.
    const [outcomes] = await q<{
      courses: number; shared: number; share_opens: number; reopened: number; edited: number; started: number; completed: number;
    }>(
      `WITH c AS (
         SELECT id, user_id, created_at, result, edits FROM courses
         WHERE NOT frozen AND shared_from IS NULL AND created_at > ${since}
       ), v AS (
         SELECT c.id, r.i, array_agg(DISTINCT (st->'shop'->>'id')::bigint) AS ids
         FROM c, jsonb_array_elements(c.result) WITH ORDINALITY AS r(var, i), jsonb_array_elements(r.var->'stops') st
         GROUP BY c.id, r.i
       ), walked AS (
         SELECT v.id, cardinality(v.ids) AS n,
                (SELECT count(DISTINCT e.shop_id) FROM user_shop_events e JOIN c ON c.id = v.id
                 WHERE e.user_id = c.user_id AND e.kind = 'visit' AND e.shop_id = ANY(v.ids) AND e.created_at > c.created_at) AS visited
         FROM v
       )
       SELECT (SELECT count(*)::int FROM c) AS courses,
              (SELECT count(DISTINCT shared_from)::int FROM courses WHERE frozen AND shared_from IN (SELECT id FROM c)) AS shared,
              (SELECT count(*)::int FROM app_events WHERE kind = 'share_open' AND created_at > ${since}) AS share_opens,
              (SELECT count(DISTINCT course_id)::int FROM app_events WHERE kind = 'reopen' AND course_id IN (SELECT id FROM c)) AS reopened,
              (SELECT count(*)::int FROM c WHERE jsonb_array_length(edits) > 0) AS edited,
              (SELECT count(DISTINCT id)::int FROM walked WHERE visited > 0) AS started,
              (SELECT count(DISTINCT id)::int FROM walked WHERE visited = n AND n > 0) AS completed`,
    );

    const editsByOp = await q<{ op: string; n: number }>(
      `SELECT coalesce(e->>'op', '?') AS op, count(*)::int AS n
       FROM courses, jsonb_array_elements(edits) e
       WHERE created_at > ${since} GROUP BY 1 ORDER BY n DESC`,
    );

    const [reports] = await q<{ closed: number; disliked: number; liked: number; visits: number; stops_shown: number }>(
      `SELECT count(*) FILTER (WHERE kind = 'closed')::int AS closed,
              count(*) FILTER (WHERE kind = 'dislike')::int AS disliked,
              count(*) FILTER (WHERE kind = 'like')::int AS liked,
              count(*) FILTER (WHERE kind = 'visit')::int AS visits,
              (SELECT coalesce(sum(jsonb_array_length(result->0->'stops')), 0)::int FROM courses
               WHERE NOT frozen AND shared_from IS NULL AND created_at > ${since}) AS stops_shown
       FROM user_shop_events WHERE created_at > ${since}`,
    );

    const ai = await q<{ purpose: string; calls: number; failed: number; p50: number | null; tokens_in: number; tokens_out: number; cost: string }>(
      `SELECT purpose, count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms))::int AS p50,
              coalesce(sum(input_tokens), 0)::int AS tokens_in, coalesce(sum(output_tokens), 0)::int AS tokens_out,
              coalesce(sum(cost_usd), 0)::text AS cost
       FROM llm_calls WHERE created_at > ${since} GROUP BY purpose ORDER BY calls DESC`,
    );

    const aiByDay = await q<{ day: string; calls: number; failed: number }>(
      `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'Asia/Seoul'), 'MM-DD') AS day,
              count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed
       FROM llm_calls WHERE created_at > ${since} GROUP BY 1 ORDER BY 1`,
    );

    const runs = await q<{ step: string; status: string; started: string; minutes: number | null; error: string | null; stats: string }>(
      `SELECT step, status, to_char(started_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') AS started,
              round(extract(epoch FROM (finished_at - started_at)) / 60)::int AS minutes,
              left(error, 160) AS error, left((stats - 'run_id')::text, 220) AS stats
       FROM pipeline_runs WHERE started_at > ${since} ORDER BY started_at DESC LIMIT 25`,
    );

    const [data] = await q<{ candidates: number; scored: number; verified: number; low: number; suspended: number; closed: number }>(
      `SELECT count(*) FILTER (WHERE status = 'candidate')::int AS candidates,
              count(*) FILTER (WHERE status = 'candidate' AND scored_at IS NOT NULL)::int AS scored,
              count(*) FILTER (WHERE status = 'candidate' AND confidence IS NOT NULL)::int AS verified,
              count(*) FILTER (WHERE status = 'candidate' AND confidence < ${LOW_CONFIDENCE})::int AS low,
              count(*) FILTER (WHERE status = 'suspended')::int AS suspended,
              count(*) FILTER (WHERE status = 'closed')::int AS closed
       FROM shops WHERE kind = 'store' AND category IS NOT NULL AND category <> 'excluded' AND $1 > 0`,
    );

    // Hidden after reports or checks and still undecided: worth a look by hand.
    const unsure = await q<{ id: string; name: string; result: string; checked: string; detail: string }>(
      `SELECT s.id::text, s.name, c.result, to_char(c.checked_at AT TIME ZONE 'Asia/Seoul', 'MM-DD') AS checked, left(c.detail::text, 160) AS detail
       FROM shops s JOIN LATERAL (
         SELECT result, checked_at, detail FROM shop_checks WHERE shop_id = s.id ORDER BY checked_at DESC LIMIT 1
       ) c ON true
       WHERE s.status = 'suspended' AND $1 > 0 ORDER BY c.checked_at DESC LIMIT 30`,
    );

    // Low-confidence shops that courses keep recommending: the data to fix first.
    const lowInCourses = await q<{ id: string; name: string; category: string; confidence: string; times: number }>(
      `SELECT s.id::text, s.name, s.category, round(s.confidence::numeric, 2)::text AS confidence, count(*)::int AS times
       FROM courses c, jsonb_array_elements(c.result->0->'stops') st JOIN shops s ON s.id = (st->'shop'->>'id')::bigint
       WHERE NOT c.frozen AND c.shared_from IS NULL AND c.created_at > ${since} AND s.confidence < ${LOW_CONFIDENCE}
       GROUP BY s.id ORDER BY times DESC LIMIT 20`,
    );

    return {
      days: d, users, courses: { byMode, ...outcomes, editsByOp }, actions, reports, ai: { byPurpose: ai, byDay: aiByDay },
      runs, data, unsure, lowInCourses,
    };
  }
}

export type AdminReport = Awaited<ReturnType<AdminService['report']>>;
