import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import { STYLES } from '@cr/shared';
import type { Pool } from 'pg';
import { cleanName } from './names';
import { DISPLAY_NAME_SQL } from './shops.resolver';

@ObjectType({ description: '비슷한 가게 한 곳 (가게 화면 "여기 좋았다면")' })
export class SimilarShop {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field()
  kind: string;

  @Field()
  category: string;

  @Field(() => Float)
  lat: number;

  @Field(() => Float)
  lng: number;

  @Field(() => Int, { description: '이 가게에서 떨어진 거리 (직선, m)' })
  distanceM: number;

  @Field({ description: '왜 비슷한가 한 줄 ("빈티지·워크웨어 쪽이 비슷해요")' })
  reason: string;
}

const STYLE_LABEL = Object.fromEntries(STYLES.map((s) => [s.id, s.label]));
const CATEGORY_LABEL: Record<string, string> = {
  select_shop: '편집숍', vintage: '빈티지·구제 숍', brand: '브랜드 매장', spa: 'SPA 매장', general: '옷가게', complex: '백화점·몰',
};
// Similar first, near a little ahead: within a couple of km closeness decides between close matches.
const KM_PENALTY = 0.02;
const MAX_KM_PENALTY = 0.12;
// Without a profile of its own (not scored yet), only these kinds get "nearby shops of the same kind": a plain
// clothes shop next to other plain clothes shops says nothing about being alike.
const FALLBACK_KINDS = new Set(['vintage', 'select_shop', 'brand']);
const CANDIDATES = 80;

interface Row {
  id: string;
  name: string;
  kind: string;
  category: string;
  lat: number;
  lng: number;
  sim: number;
  dist_m: number;
  scores: Record<string, number> | null;
  /** the brand a brand store is a store of (pipeline.brands, from its name) */
  store_brand: string | null;
}

/** The brand part of a name: "무신사 엠프티 성수" and "무신사 엠프티 한남" are one chain, not a suggestion. */
const chainKey = (name: string) =>
  cleanName(name)
    .replace(/\s*\S*(점|호점|본점|매장|스토어|store)$/i, '')
    .replace(/\s+(성수|홍대|연남|한남|가로수길|압구정|명동|강남|신사|합정|망원|이태원|동대문|잠실|여의도)\S*$/, '')
    .replace(/\s+/g, '')
    .toLowerCase();

function cosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function reason(target: { category: string; scores: Record<string, number> | null }, r: Row, alike: boolean): string {
  if (!alike) return `근처의 같은 ${CATEGORY_LABEL[r.category] ?? '가게'}`;
  const shared = Object.entries(r.scores ?? {})
    .filter(([k, v]) => v >= 6 && (target.scores?.[k] ?? 0) >= 6)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => STYLE_LABEL[k] ?? k);
  if (shared.length) return `${shared.join('·')} 쪽이 비슷해요`;
  if (r.category === target.category) return `분위기가 비슷한 ${CATEGORY_LABEL[r.category] ?? '가게'}`;
  return '소개가 비슷한 가게';
}

/**
 * "여기 좋았다면": shops most like this one. With an embedding (pipeline.embed: the shop's summary, reason, styles,
 * items, price in words) the nearest by cosine; without one, by style scores (or, unscored, the same kind nearby).
 * Other branches of the same chain don't count as suggestions.
 */
export async function similarShops(pool: Pool, shopId: string, limit: number): Promise<SimilarShop[]> {
  if (!/^\d+$/.test(shopId)) return [];
  const t = (
    await pool.query<{ name: string; category: string; has_vec: boolean; scores: Record<string, number> | null; store_brand: string | null }>(
      `SELECT ${DISPLAY_NAME_SQL} AS name, s.category, s.embedding IS NOT NULL AS has_vec,
              (SELECT b.brand_key FROM shop_brands b WHERE b.shop_id = s.id AND b.source = 'name' LIMIT 1) AS store_brand,
              (SELECT jsonb_object_agg(style_id, score) FROM shop_style_scores x WHERE x.shop_id = s.id) AS scores
       FROM shops s WHERE s.id = $1`,
      [shopId],
    )
  ).rows[0];
  if (!t) return [];
  const common = `s.id::text, ${DISPLAY_NAME_SQL} AS name, s.kind, s.category, ST_Y(s.geom::geometry) AS lat, ST_X(s.geom::geometry) AS lng,
                  ST_Distance(s.geom::geography, t.geom::geography) AS dist_m,
                  (SELECT jsonb_object_agg(style_id, score) FROM shop_style_scores x WHERE x.shop_id = s.id) AS scores,
                  (SELECT b.brand_key FROM shop_brands b WHERE b.shop_id = s.id AND b.source = 'name' LIMIT 1) AS store_brand`;
  const where = `s.id <> t.id AND s.status = 'candidate' AND s.category IS NOT NULL AND s.category <> 'excluded'`;
  let rows: Row[];
  if (t.has_vec) {
    rows = (
      await pool.query<Row>(
        `SELECT ${common}, 1 - (s.embedding <=> t.embedding) AS sim
         FROM shops s, (SELECT id, geom, embedding FROM shops WHERE id = $1) t
         WHERE ${where} AND s.embedding IS NOT NULL
         ORDER BY s.embedding <=> t.embedding LIMIT ${CANDIDATES}`,
        [shopId],
      )
    ).rows;
  } else {
    // No embedding yet: shops with style scores within 5 km (by style likeness); unscored, scored shops of the same
    // (distinctive) kind nearby — said as such, not as "similar".
    if (!t.scores && !FALLBACK_KINDS.has(t.category)) return [];
    rows = (
      await pool.query<Row>(
        `SELECT ${common}, 0::float AS sim
         FROM shops s, (SELECT id, geom FROM shops WHERE id = $1) t
         WHERE ${where} AND ST_DWithin(s.geom::geography, t.geom::geography, 5000)
           AND s.scored_at IS NOT NULL ${t.scores ? '' : 'AND s.category = $2'}
         ORDER BY s.geom <-> t.geom LIMIT ${CANDIDATES * 2}`,
        t.scores ? [shopId] : [shopId, t.category],
      )
    ).rows.map((r) => ({ ...r, sim: t.scores && r.scores ? cosine(t.scores, r.scores) : 0.5 }));
  }
  // One store per chain or brand, and none of this shop's own (아더에러 성수 → not 아더에러 한남).
  const keyOf = (name: string, brand: string | null) => (brand ? `b:${brand}` : `n:${chainKey(name)}`);
  const seen = new Set<string>([keyOf(t.name, t.store_brand), `n:${chainKey(t.name)}`]);
  return rows
    .map((r) => ({ r, score: r.sim - Math.min(MAX_KM_PENALTY, (r.dist_m / 1000) * KM_PENALTY) }))
    .sort((a, b) => b.score - a.score)
    .filter(({ r }) => {
      const keys = [keyOf(r.name, r.store_brand), `n:${chainKey(r.name)}`];
      if (keys.some((k) => seen.has(k))) return false; // same chain as this shop, or one already suggested
      keys.forEach((k) => seen.add(k));
      return true;
    })
    .slice(0, limit)
    .map(({ r }) => ({
      id: r.id, name: cleanName(r.name), kind: r.kind, category: r.category, lat: r.lat, lng: r.lng,
      distanceM: Math.round(r.dist_m), reason: reason(t, r, t.has_vec || !!t.scores),
    }));
}
