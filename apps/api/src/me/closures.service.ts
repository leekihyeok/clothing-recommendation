import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../infra/db.service';

/** Shops whose own data is thin: one report is enough to take them out until they're re-checked. */
const LOW_CONFIDENCE = 0.35;
const REPORTS_NEEDED = 2;
const REPORT_WINDOW_DAYS = 180;

/**
 * "문 닫혀 있었어요" acting on its own: enough distinct reporters put the shop on 'suspended' at once (no longer in
 * courses or on the map); pipeline.closures re-checks it later and brings it back or marks it closed.
 * Counted: reports since the last 'open' check, within 180 days, one per person, minus people who said they were
 * there (visit / like / purchase) after the first of those reports.
 */
@Injectable()
export class ClosuresService {
  private readonly log = new Logger(ClosuresService.name);

  constructor(private readonly db: DbService) {}

  async evaluate(shopId: string): Promise<boolean> {
    const r = await this.db.pool.query<{
      reporters: number;
      seen_open: number;
      status: string;
      weak: boolean;
    }>(
      `WITH last_open AS (
         SELECT coalesce(max(checked_at), '-infinity') AS t FROM shop_checks WHERE shop_id = $1 AND kind = 'closure' AND result = 'open'
       ), rep AS (
         SELECT e.user_id, min(e.created_at) AS at FROM user_shop_events e, last_open
         WHERE e.shop_id = $1 AND e.kind = 'closed' AND e.created_at > last_open.t
           AND e.created_at > now() - make_interval(days => $2)
         GROUP BY e.user_id
       ), seen AS (
         SELECT count(DISTINCT v.user_id)::int AS n FROM user_shop_events v
         WHERE v.shop_id = $1 AND v.kind IN ('visit', 'like', 'purchase')
           AND v.created_at > (SELECT min(at) FROM rep) AND v.user_id NOT IN (SELECT user_id FROM rep)
       )
       SELECT (SELECT count(*) FROM rep)::int AS reporters, (SELECT n FROM seen) AS seen_open, s.status,
              (NOT EXISTS (SELECT 1 FROM raw_sources k WHERE k.shop_id = s.id AND k.source = 'kakao')
               OR coalesce(s.confidence, 1) < $3) AS weak
       FROM shops s WHERE s.id = $1`,
      [shopId, REPORT_WINDOW_DAYS, LOW_CONFIDENCE],
    );
    const s = r.rows[0];
    if (!s || s.status !== 'candidate') return false;
    const net = s.reporters - s.seen_open;
    if (net < (s.weak ? 1 : REPORTS_NEEDED)) return false;
    const changed = await this.db.pool.query(`UPDATE shops SET status = 'suspended' WHERE id = $1 AND status = 'candidate'`, [shopId]);
    if (!changed.rowCount) return false;
    await this.db.pool.query(`INSERT INTO shop_checks (shop_id, trigger, result, detail) VALUES ($1, 'reports', 'suspended', $2)`, [
      shopId,
      JSON.stringify({ reporters: s.reporters, seenOpen: s.seen_open, weak: s.weak }),
    ]);
    this.log.log(`shop ${shopId} suspended after ${s.reporters} closed report(s)${s.weak ? ' (thin data)' : ''}`);
    return true;
  }
}
