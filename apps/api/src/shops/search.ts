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

// Latin letters as Korean says them, longest first (the reverse of pipeline/merge_dupes.py LETTER).
const LETTER_READINGS: [string, string][] = (
  [['더블유', 'w'], ['에이치', 'h'], ['에이', 'a'], ['에프', 'f'], ['에스', 's'], ['엑스', 'x'], ['아이', 'i'], ['와이', 'y'], ['제이', 'j'],
   ['케이', 'k'], ['브이', 'v'], ['엘', 'l'], ['엠', 'm'], ['엔', 'n'], ['오', 'o'], ['피', 'p'], ['큐', 'q'], ['알', 'r'], ['티', 't'],
   ['유', 'u'], ['비', 'b'], ['씨', 'c'], ['디', 'd'], ['이', 'e'], ['지', 'g'], ['제트', 'z'], ['지', 'z']] as [string, string][]
).sort((a, b) => b[0].length - a[0].length);

/** "이큐엘" → "eql", "엠엘비" → "mlb": a brand written as the names of its letters. null when it doesn't read so. */
export function lettersToLatin(q: string): string | null {
  if (!/^[가-힣]{2,12}$/.test(q)) return null;
  let out = '';
  for (let i = 0; i < q.length; ) {
    const hit = LETTER_READINGS.find(([ko]) => q.startsWith(ko, i));
    if (!hit) return null;
    out += hit[1];
    i += hit[0].length;
  }
  return out.length >= 2 ? out : null;
}

/**
 * Shops by name, for "이 가게 넣어 줘" and the add / replace search on a course. Spaces and case don't matter
 * ("트리밍버드성수" finds "트리밍버드 성수"); exact and prefix matches first, then trigram similarity, nearer first
 * when a point is given. Our own name, Kakao's and the shop's aliases all count; "이큐엘"-style letter names find
 * the Latin name too.
 */
export async function searchShops(
  pool: Pool,
  q: string,
  near?: { lat: number; lng: number },
  limit = 8,
  strict = false,
): Promise<ShopHitRow[]> {
  // "이큐엘" also means EQL: search its letters too and keep the better of the two per shop.
  const latin = lettersToLatin(q.replace(/\s+/g, ''));
  if (!latin) return searchOnce(pool, q, near, limit, strict);
  const [a, b] = await Promise.all([searchOnce(pool, q, near, limit, strict), searchOnce(pool, latin, near, limit, strict)]);
  const seen = new Set<string>();
  return [...b, ...a].filter((h) => !seen.has(h.id) && (seen.add(h.id), true)).slice(0, limit);
}

async function searchOnce(
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
              -- the shop's other spellings (English names, names of shops merged into it)
              OR EXISTS (SELECT 1 FROM unnest(coalesce(s.aliases, '{}')) a WHERE replace(lower(a), ' ', '') LIKE '%' || $1 || '%')
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
