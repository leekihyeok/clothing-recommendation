import type { Pool } from 'pg';
import { cleanName } from './names';
import { DISPLAY_NAME_SQL } from './shops.resolver';

export interface ShopHitRow {
  id: string;
  name: string;
  category: string;
  roadAddress?: string;
  lat: number;
  lng: number;
  distanceM?: number;
}

// Matches farther than this from `near` drop down the list (a 성수 course asking for "폴유" means the one in 성수).
const NEAR_SCALE_M = 3000;
// Below this a hit is a loose look-alike: fine in a list to pick from, not to add on its own ("strict").
const STRICT_SCORE = 0.5;

/**
 * Shops by name, for "이 가게 넣어 줘" and the add / replace search on a course. Spaces and case don't matter
 * ("트리밍버드성수" finds "트리밍버드 성수"); exact and prefix matches first, then trigram similarity, nearer first
 * when a point is given. Our own name and Kakao's both count.
 */
export async function searchShops(
  pool: Pool,
  q: string,
  near?: { lat: number; lng: number },
  limit = 8,
  strict = false,
): Promise<ShopHitRow[]> {
  const norm = q.replace(/\s+/g, '').toLowerCase().slice(0, 40);
  if (norm.length < 1) return [];
  const r = await pool.query<{ id: string; name: string; category: string; road_address: string | null; lat: number; lng: number; dist: number | null; score: number }>(
    `WITH named AS (
       SELECT s.id, s.category, s.road_address, s.geom, ${DISPLAY_NAME_SQL} AS name
       FROM shops s
       WHERE s.status = 'candidate' AND s.category IS NOT NULL AND s.category <> 'excluded'
         AND (replace(lower(s.name), ' ', '') LIKE '%' || $1 || '%' OR lower(s.name) % $1
              OR EXISTS (SELECT 1 FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao'
                           AND (replace(lower(r.name), ' ', '') LIKE '%' || $1 || '%' OR lower(r.name) % $1)))
     ), scored AS (
       SELECT id, category, road_address, geom, name,
              CASE WHEN $2::float IS NULL THEN NULL ELSE ST_Distance(geom, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography) END AS dist,
              (SELECT CASE WHEN n = $1 THEN 1 WHEN n LIKE $1 || '%' THEN 0.8 WHEN n LIKE '%' || $1 || '%' THEN 0.6 ELSE similarity(n, $1) * 0.6 END
                 FROM (SELECT replace(lower(name), ' ', '') AS n) x) AS score
       FROM named
     )
     SELECT id::text, name, category, road_address, ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lng, dist, score
     FROM scored
     WHERE score >= $5
     ORDER BY score / (1 + coalesce(dist, 0) / ${NEAR_SCALE_M}) DESC, length(name)
     LIMIT $4`,
    [norm, near?.lat ?? null, near?.lng ?? null, Math.min(Math.max(limit, 1), 20), strict ? STRICT_SCORE : 0.15],
  );
  return r.rows.map((x) => ({
    id: x.id, name: cleanName(x.name), category: x.category, roadAddress: x.road_address ?? undefined, lat: x.lat, lng: x.lng,
    distanceM: x.dist == null ? undefined : Math.round(x.dist),
  }));
}
