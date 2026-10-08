import type { Pool } from 'pg';

// Style guesses for shops not scored yet (pipeline ⑤ still running), by category. 0-10 like real scores.
// Shared by course scoring and the taste profile.
export const CATEGORY_PRIOR: Record<string, Record<string, number>> = {
  vintage: { vintage: 8, secondhand: 8, amekaji: 4, workwear: 4, street: 3 },
  select_shop: { designer: 6, street: 5, minimal: 5, casual: 4 },
  brand: { casual: 5, minimal: 3 },
  spa: { casual: 7, minimal: 5 },
  general: { casual: 4 },
  complex: { casual: 6, minimal: 4, designer: 4 },
};

// How much each thing a person did says about their taste. Recent signals count more (half-life below).
const EVENT_WEIGHT: Record<string, number> = {
  purchase: 2, like: 1.5, save: 1, unsave: -1, visit: 0.5, unvisit: -0.5, dislike: -1.5, unrate: 0, view: 0.05, closed: 0,
};
const REVIEW_WEIGHT_PER_STAR = 0.75; // 5★ → +1.5, 3★ → 0, 1★ → -1.5
const SAVED_COURSE_STOP = 0.3;
const HALF_LIFE_DAYS = 60;
// Shops from the person's own courses this recently are pushed back, so the next course brings something new.
export const RECENT_COURSE_DAYS = 30;

export interface Taste {
  /** style id → -1..1: how much the person goes for (or away from) it. */
  weights: Record<string, number>;
  /** How many shops the profile rests on. Under MIN_SIGNALS it isn't used. */
  signals: number;
  /** The price range of the shops they liked, when one clearly dominates. */
  price: string | null;
  /** Shops in their courses of the last RECENT_COURSE_DAYS days. */
  recent: Set<string>;
  /** Shops they have any record with (to tell "new to them" apart). */
  known: Set<string>;
}

export const MIN_SIGNALS = 2;

/**
 * The taste profile, computed from the person's records each time a course is planned (a few dozen rows; no batch).
 * Each shop gets a signal weight (events, review stars, stops of saved courses, decayed by age); the profile is the
 * weighted average of those shops' style vectors (real scores, or the category guess when not scored yet).
 */
export async function loadTaste(pool: Pool, userId: string): Promise<Taste> {
  const decay = `exp(-ln(2) * extract(epoch FROM now() - t) / 86400 / ${HALF_LIFE_DAYS})`;
  const cases = Object.entries(EVENT_WEIGHT).map(([k, w]) => `WHEN '${k}' THEN ${w}`).join(' ');
  const signals = await pool.query<{ shop_id: string; w: number; category: string; price_range: string | null; scores: Record<string, number> | null }>(
    `WITH raw AS (
       SELECT shop_id, (CASE kind ${cases} ELSE 0 END) AS w, created_at AS t FROM user_shop_events WHERE user_id = $1
       UNION ALL
       SELECT shop_id, (rating - 3) * ${REVIEW_WEIGHT_PER_STAR}, updated_at FROM shop_reviews WHERE user_id = $1
       UNION ALL
       SELECT (st->'shop'->>'id')::bigint, ${SAVED_COURSE_STOP}, sc.created_at
       FROM saved_courses sc JOIN courses c ON c.id = sc.course_id, jsonb_array_elements(c.result->0->'stops') st
       WHERE sc.user_id = $1
     ), per AS (
       SELECT shop_id, sum(w * ${decay}) AS w FROM raw GROUP BY shop_id HAVING abs(sum(w * ${decay})) > 0.02
     )
     SELECT per.shop_id::text, per.w, s.category, s.price_range,
            (SELECT jsonb_object_agg(style_id, score) FROM shop_style_scores x WHERE x.shop_id = s.id) AS scores
     FROM per JOIN shops s ON s.id = per.shop_id`,
    [userId],
  );
  const recent = await pool.query<{ id: string }>(
    `SELECT DISTINCT st->'shop'->>'id' AS id
     FROM courses c, jsonb_array_elements(c.result) v, jsonb_array_elements(v->'stops') st
     WHERE c.user_id = $1 AND NOT c.frozen AND c.created_at > now() - make_interval(days => $2)`,
    [userId, RECENT_COURSE_DAYS],
  );

  const sums: Record<string, number> = {};
  let total = 0;
  const priceVotes: Record<string, number> = {};
  for (const s of signals.rows) {
    const vec = s.scores && Object.keys(s.scores).length ? s.scores : CATEGORY_PRIOR[s.category] ?? {};
    for (const [style, score] of Object.entries(vec)) sums[style] = (sums[style] ?? 0) + s.w * (score / 10);
    total += Math.abs(s.w);
    if (s.w > 0 && s.price_range && s.price_range !== 'unknown') priceVotes[s.price_range] = (priceVotes[s.price_range] ?? 0) + s.w;
  }
  const weights = Object.fromEntries(
    Object.entries(sums)
      .map(([k, v]) => [k, total ? Math.max(-1, Math.min(1, v / total)) : 0] as const)
      .filter(([, v]) => Math.abs(v) >= 0.02),
  );
  const votes = Object.entries(priceVotes).sort((a, b) => b[1] - a[1]);
  const voteTotal = votes.reduce((a, [, v]) => a + v, 0);
  const price = votes.length && votes[0][1] / voteTotal >= 0.5 ? votes[0][0] : null;
  return {
    weights,
    signals: signals.rows.filter((s) => Math.abs(s.w) >= 0.3).length,
    price,
    recent: new Set(recent.rows.map((r) => r.id)),
    known: new Set(signals.rows.map((r) => r.shop_id)),
  };
}

/** -1..1: how well a shop's style vector (0-10 scores) matches the taste. */
export function tasteFit(taste: Taste, fit: Record<string, number>): number {
  let dot = 0;
  let norm = 0;
  for (const [style, w] of Object.entries(taste.weights)) {
    dot += w * ((fit[style] ?? 0) / 10);
    norm += Math.abs(w);
  }
  return norm ? Math.max(-1, Math.min(1, dot / norm)) : 0;
}

/** The styles the taste leans towards (and away from), strongest first. */
export function tasteSummary(taste: Taste) {
  const entries = Object.entries(taste.weights).sort((a, b) => b[1] - a[1]);
  return {
    likes: entries.filter(([, w]) => w > 0.05).slice(0, 4),
    avoids: entries.filter(([, w]) => w < -0.03).slice(-3).reverse(),
  };
}
