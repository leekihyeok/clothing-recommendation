import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { DbService } from '../infra/db.service';
import { AuthService, SESSION_COOKIE } from './auth.service';
import { ClosuresService } from './closures.service';
import { loadTaste } from './taste';

/** The part of the HTTP request we read (Apollo passes the Express request as context.req). */
export type Request = { headers?: Record<string, string | string[] | undefined> };

const ANON_HEADER = 'x-route-anon';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isAnonKey = (v: string) => UUID.test(v);

/** One cookie from the request (no cookie-parser middleware). */
export function cookie(req: Request | undefined, name: string): string | null {
  const raw = req?.headers?.cookie;
  for (const part of (Array.isArray(raw) ? raw.join(';') : raw ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Per-request memo of the logged-in user (several resolvers ask within one request). */
const SESSION_MEMO = Symbol('routeSessionUser');

export const ACTIONS = ['view', 'save', 'unsave', 'visit', 'unvisit', 'like', 'dislike', 'unrate', 'purchase', 'closed'] as const;
export type Action = (typeof ACTIONS)[number];

export interface ShopState {
  shopId: string;
  saved: boolean;
  visits: number;
  /** 1 좋았어요, -1 별로였어요, 0 없음 */
  rating: number;
  purchased: boolean;
  views: number;
  closedReported: boolean;
  lastVisitAt?: Date;
  lastSeenAt: Date;
}

/** Per-shop summary of a user's events: saved / rating come from the latest toggle, visits and views are counts. */
const STATE_SQL = `
  SELECT shop_id::text AS "shopId",
         coalesce((array_agg(kind ORDER BY created_at DESC) FILTER (WHERE kind IN ('save', 'unsave')))[1] = 'save', false) AS saved,
         (count(*) FILTER (WHERE kind = 'visit') - count(*) FILTER (WHERE kind = 'unvisit'))::int AS visits,
         CASE (array_agg(kind ORDER BY created_at DESC) FILTER (WHERE kind IN ('like', 'dislike', 'unrate')))[1]
              WHEN 'like' THEN 1 WHEN 'dislike' THEN -1 ELSE 0 END AS rating,
         bool_or(kind = 'purchase') AS purchased,
         count(*) FILTER (WHERE kind = 'view')::int AS views,
         bool_or(kind = 'closed') AS "closedReported",
         max(created_at) FILTER (WHERE kind = 'visit') AS "lastVisitAt",
         max(created_at) AS "lastSeenAt"
  FROM user_shop_events WHERE user_id = $1 AND ($2::bigint[] IS NULL OR shop_id = ANY($2))
  GROUP BY shop_id`;

/** Who is asking: the Kakao account when logged in (session cookie), otherwise the anonymous browser id. */
@Injectable()
export class MeService {
  constructor(
    private readonly db: DbService,
    private readonly auth: AuthService,
    private readonly closures: ClosuresService,
  ) {}

  /** The logged-in user, or null. */
  async sessionUser(req: Request | undefined): Promise<string | null> {
    if (!req) return null;
    const memo = req as Request & { [SESSION_MEMO]?: Promise<string | null> };
    if (memo[SESSION_MEMO] === undefined) {
      const token = cookie(req, SESSION_COOKIE);
      memo[SESSION_MEMO] = token ? this.auth.sessionUser(token) : Promise.resolve(null);
    }
    return memo[SESSION_MEMO]!;
  }

  /**
   * The logged-in user, or a 401 the client turns into the login modal (saving shops and courses, reviews, my page).
   */
  async requireLogin(req: Request | undefined): Promise<string> {
    const id = await this.sessionUser(req);
    if (!id) throw new UnauthorizedException('로그인이 필요해요');
    return id;
  }

  async account(req: Request | undefined): Promise<{ loggedIn: boolean; nickname: string | null }> {
    const id = await this.sessionUser(req);
    if (!id) return { loggedIn: false, nickname: null };
    const r = await this.db.pool.query<{ nickname: string | null }>('SELECT nickname FROM users WHERE id = $1', [id]);
    return { loggedIn: true, nickname: r.rows[0]?.nickname ?? null };
  }

  anonKey(req: Request | undefined): string | null {
    const v = req?.headers?.[ANON_HEADER];
    const key = Array.isArray(v) ? v[0] : v;
    return key && UUID.test(key) ? key.toLowerCase() : null;
  }

  /** The user row: the account when logged in, else this browser's. With create=false a first-time visitor (no row yet) is null. */
  async userId(req: Request | undefined, create: boolean): Promise<string | null> {
    const loggedIn = await this.sessionUser(req);
    if (loggedIn) return loggedIn;
    const key = this.anonKey(req);
    if (!key) {
      if (create) throw new BadRequestException('브라우저 저장소를 쓸 수 없어서 기록할 수 없어요');
      return null;
    }
    if (create) {
      const r = await this.db.pool.query<{ id: string }>(
        `INSERT INTO users (anon_key) VALUES ($1)
         ON CONFLICT (anon_key) DO UPDATE SET last_seen_at = now() RETURNING id`,
        [key],
      );
      return r.rows[0].id;
    }
    const r = await this.db.pool.query<{ id: string }>('SELECT id FROM users WHERE anon_key = $1', [key]);
    return r.rows[0]?.id ?? null;
  }

  async record(userId: string, shopId: string, action: Action, courseId?: string): Promise<ShopState> {
    if (!ACTIONS.includes(action)) throw new BadRequestException(`모르는 기록이에요: ${action}`);
    // A view is counted at most once every 10 minutes per shop, so reopening a card doesn't inflate "자주 본 곳".
    if (action === 'view') {
      const recent = await this.db.pool.query(
        `SELECT 1 FROM user_shop_events WHERE user_id = $1 AND shop_id = $2 AND kind = 'view' AND created_at > now() - interval '10 minutes'`,
        [userId, shopId],
      );
      if (recent.rowCount) return (await this.states(userId, [shopId]))[0];
    }
    await this.db.pool
      .query(`INSERT INTO user_shop_events (user_id, shop_id, kind, course_id) VALUES ($1, $2, $3, $4)`, [userId, shopId, action, courseId ?? null])
      .catch((e: { code?: string }) => {
        if (e.code === '23503') throw new BadRequestException('가게나 코스를 찾지 못했어요');
        throw e;
      });
    if (action === 'closed') await this.closures.evaluate(shopId);
    return (await this.states(userId, [shopId]))[0];
  }

  async states(userId: string, shopIds: string[] | null): Promise<ShopState[]> {
    const r = await this.db.pool.query<ShopState>(STATE_SQL, [userId, shopIds]);
    if (!shopIds) return r.rows;
    const byId = new Map(r.rows.map((s) => [s.shopId, s]));
    return shopIds.map((id) => byId.get(id) ?? empty(id));
  }

  /**
   * Signals for course planning: shops to favour, avoid or skip, and the taste profile learnt from everything the
   * person did (me/taste.ts).
   */
  async personal(userId: string) {
    const [states, taste] = await Promise.all([this.states(userId, null), loadTaste(this.db.pool, userId)]);
    return {
      liked: new Set(states.filter((s) => s.saved || s.rating > 0 || s.purchased).map((s) => s.shopId)),
      disliked: new Set(states.filter((s) => s.rating < 0).map((s) => s.shopId)),
      visited: new Set(states.filter((s) => s.visits > 0).map((s) => s.shopId)),
      closed: new Set(states.filter((s) => s.closedReported).map((s) => s.shopId)),
      taste,
    };
  }
}

export type Personal = Awaited<ReturnType<MeService['personal']>>;

function empty(shopId: string): ShopState {
  return { shopId, saved: false, visits: 0, rating: 0, purchased: false, views: 0, closedReported: false, lastSeenAt: new Date(0) };
}
