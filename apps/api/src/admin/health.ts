import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

// The data keeper (services/model pipeline.refresh) writes this every 5 minutes; quiet for longer = stopped or hung.
const HEARTBEAT = resolve(process.cwd(), process.env.LOGS_DIR ?? '../../data/logs', 'heartbeat.json');
const QUIET_MIN = 15;
// The bigger Gemini models people's AI falls back to: about 20 calls a day each on the free tier (2026-10-12).
const LIVE_RESERVE = ['gemini-flash-latest', 'gemini-3.7-flash', 'gemini-3.5-flash'];
const LIVE_RESERVE_CAP = 20;

const SHOPS = `FROM shops s WHERE s.kind = 'store' AND s.status = 'candidate' AND s.category IS NOT NULL AND s.category <> 'excluded'`;
const HOURS_HINT = String.raw`(영업|운영)\s*(시간|일)|휴무|[0-2]?[0-9]\s*:\s*[0-5][0-9]\s*[~∼\-–—]`;

/** One pipeline step: what's left across Seoul, how much got done in the last 3 days, when it might be done. */
export interface StepHealth {
  step: string;
  remaining: number;
  last3d: number | null;
  /** days to go at the last 3 days' pace; null when nothing moved (or not measurable) */
  etaDays: number | null;
}

/**
 * "데이터 건강" for the admin page: is the data keeper alive, what each step still has to do and when it might be
 * done, the last runs, today's AI use per model (pipeline vs people, against the free quotas), and course ratings.
 */
export async function dataHealth(pool: Pool, batchCap: number, tmapToday: number, tmapCap: number) {
  const q = async <T>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];

  let keeper: { at: string | null; step: string | null; minutesAgo: number | null; alive: boolean } = { at: null, step: null, minutesAgo: null, alive: false };
  try {
    const beat = JSON.parse(await readFile(HEARTBEAT, 'utf8')) as { at: string; step?: string };
    const ago = Math.floor((Date.now() - new Date(beat.at).getTime()) / 60_000);
    keeper = { at: beat.at, step: beat.step ?? null, minutesAgo: ago, alive: ago <= QUIET_MIN };
  } catch {
    /* no heartbeat file: never started with the new keeper, or the logs folder is elsewhere */
  }

  const [c] = await q<Record<string, number>>(
    `SELECT count(*) FILTER (WHERE s.evidence_at IS NULL)::int AS evidence,
            count(*) FILTER (WHERE s.evidence_at > now() - interval '3 days')::int AS evidence_3d,
            count(*) FILTER (WHERE s.evidence_at IS NOT NULL AND s.scored_at IS NULL)::int AS score,
            count(*) FILTER (WHERE s.scored_at > now() - interval '3 days')::int AS score_3d,
            count(*) FILTER (WHERE s.scored_at IS NOT NULL AND s.confidence IS NULL)::int AS verify,
            count(*) FILTER (WHERE coalesce(s.matched_posts, 0) > 0 AND s.evidence_at IS NOT NULL
                               AND (s.reputation_at IS NULL OR s.reputation_at < s.evidence_at))::int AS reputation,
            count(*) FILTER (WHERE s.reputation_at > now() - interval '3 days')::int AS reputation_3d,
            count(*) FILTER (WHERE s.evidence_at IS NOT NULL AND (s.hours_at IS NULL OR s.hours_at < s.evidence_at)
                               AND EXISTS (SELECT 1 FROM shop_facts f WHERE f.shop_id = s.id AND f.snippet ~ $1))::int AS hours,
            count(*) FILTER (WHERE s.hours_at > now() - interval '3 days')::int AS hours_3d,
            count(*) FILTER (WHERE s.summary IS NOT NULL AND s.scored_at IS NOT NULL
                               AND (s.embedded_at IS NULL OR s.embedded_at < s.scored_at))::int AS embed,
            count(*) FILTER (WHERE s.embedded_at > now() - interval '3 days')::int AS embed_3d,
            count(*) FILTER (WHERE s.summary IS NOT NULL AND NOT EXISTS (SELECT 1 FROM translations t WHERE t.ko = s.summary))::int AS translate,
            (SELECT count(*)::int FROM translations WHERE created_at > now() - interval '3 days') AS translate_3d
     ${SHOPS}`,
    [HOURS_HINT],
  );
  const step = (name: string, remaining: number, last3d: number | null): StepHealth => ({
    step: name, remaining, last3d, etaDays: last3d ? Math.ceil(remaining / (last3d / 3)) : null,
  });
  const steps: StepHealth[] = [
    step('evidence', c.evidence, c.evidence_3d),
    step('score', c.score, c.score_3d),
    step('verify', c.verify, null),
    step('reputation', c.reputation, c.reputation_3d),
    step('hours', c.hours, c.hours_3d),
    step('embed', c.embed, c.embed_3d),
    step('translate', c.translate, c.translate_3d),
  ];

  const runs = await q<{ step: string; status: string; started_at: string; finished_at: string | null; error: string | null }>(
    `SELECT step, status, started_at, finished_at, left(error, 200) AS error FROM pipeline_runs ORDER BY started_at DESC LIMIT 12`,
  );
  // Failed runs in the last day, per step: a step that keeps failing shows up here.
  const failing = await q<{ step: string; n: number }>(
    `SELECT step, count(*)::int AS n FROM pipeline_runs WHERE status <> 'ok' AND status <> 'running' AND started_at > now() - interval '1 day'
     GROUP BY step ORDER BY n DESC`,
  );

  // Since the free quota day began (midnight Pacific).
  const models = await q<{ model: string; batch: number; live: number; failed: number }>(
    `SELECT requested_model AS model,
            count(*) FILTER (WHERE ok AND run_id IS NOT NULL)::int AS batch,
            count(*) FILTER (WHERE ok AND run_id IS NULL)::int AS live,
            count(*) FILTER (WHERE NOT ok)::int AS failed
     FROM llm_calls
     WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles'
       AND requested_model IS NOT NULL
     GROUP BY 1 ORDER BY 2 DESC, 3 DESC`,
  );
  const ai = models.map((m) => ({ ...m, cap: LIVE_RESERVE.includes(m.model) ? LIVE_RESERVE_CAP : m.model.includes('embedding') ? 1000 : batchCap, reserve: LIVE_RESERVE.includes(m.model) }));

  const [ratings] = await q<{ n: number; good: number; ok: number; bad: number }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE rating > 0)::int AS good, count(*) FILTER (WHERE rating = 0)::int AS ok,
            count(*) FILTER (WHERE rating < 0)::int AS bad
     FROM course_ratings WHERE created_at > now() - interval '30 days'`,
  );
  const notes = await q<{ rating: number; note: string; created_at: string; region: string | null }>(
    `SELECT r.rating, r.note, r.created_at, c.request->>'regionName' AS region
     FROM course_ratings r JOIN courses c ON c.id = r.course_id
     WHERE r.note IS NOT NULL AND r.note <> '' ORDER BY r.created_at DESC LIMIT 6`,
  );

  return { keeper, steps, runs, failing, ai, ratings: { ...ratings, notes }, tmap: { today: tmapToday, cap: tmapCap } };
}
