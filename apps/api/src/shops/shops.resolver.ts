import { Args, ID, Int, Query, Resolver } from '@nestjs/graphql';
import { DbService } from '../infra/db.service';
import { cleanName } from './names';
import { BoundsInput, ShopsInBounds } from './shops.model';

/**
 * How notable a shop is, 0-1: blog popularity, confidence and shop type. Department stores and malls are steady
 * landmarks (0.7) but a well-known select shop or vintage store outranks them.
 * Shops not scored yet (no evidence collected) rank low until the pipeline reaches them.
 */
export const PROMINENCE_SQL = `CASE WHEN s.kind = 'complex' THEN 0.7 ELSE
    0.45 * least(1, ln(1 + coalesce(s.matched_posts, 0)) / ln(31))
  + 0.20 * coalesce(s.confidence, 0.4)
  + 0.35 * CASE s.category WHEN 'select_shop' THEN 1 WHEN 'vintage' THEN 0.95 WHEN 'brand' THEN 0.7 WHEN 'spa' THEN 0.5 ELSE 0.2 END
END`;

/**
 * Name to show: Kakao's place name when the shop is on Kakao ("무신사 킥스 성수"), otherwise ours. Public-data names
 * often carry a company prefix or a doubled brand ("무신사무신사킥스성수").
 */
// Kakao's name first (public data has company names). Not for a department store / mall (kind complex): the Kakao
// place merged into it is one of the stores inside ("몽클레르 갤러리아백화점 EAST점"), the building's own name is ours.
export const DISPLAY_NAME_SQL = `CASE WHEN s.kind = 'complex' THEN s.name ELSE coalesce((SELECT r.name FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao' ORDER BY r.id LIMIT 1), s.name) END`;

/**
 * Kakao map level (1 = street, 14 = country) → how many of the most notable shops in view to show.
 * Zoomed out you see the landmarks; each zoom step reveals more.
 */
export function shopsForLevel(level: number): number {
  if (level <= 2) return 1500;
  if (level === 3) return 400;
  if (level === 4) return 150;
  if (level === 5) return 70;
  if (level === 6) return 40;
  if (level === 7) return 30;
  return 20;
}

const GRID = 6;

/** The top few in view also get a name label on the map. */
export function labelsForLevel(level: number): number {
  return level <= 3 ? 30 : level <= 5 ? 14 : 8;
}

@Resolver()
export class ShopsResolver {
  constructor(private readonly db: DbService) {}

  @Query(() => ShopsInBounds, { description: '지도 화면 안의 추천 후보 가게, 눈에 띄는 순. 확대할수록 더 많이' })
  async shopsInBounds(
    @Args('bounds') b: BoundsInput,
    @Args('categories', { type: () => [String], nullable: true }) categories?: string[],
    @Args('regionId', { type: () => ID, nullable: true, description: '주면 그 지역 영역 안 가게만' }) regionId?: string,
    @Args('level', { type: () => Int, nullable: true, description: '카카오맵 확대 레벨. 주면 그에 맞는 수만' }) level?: number,
  ): Promise<ShopsInBounds> {
    const where = `s.status = 'candidate' AND s.category IS NOT NULL AND s.category <> 'excluded'
      AND s.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography
      AND ($5::text[] IS NULL OR s.category = ANY($5))
      AND ($6::bigint IS NULL OR EXISTS (SELECT 1 FROM regions g WHERE g.id = $6 AND ST_Intersects(g.polygon, s.geom)))`;
    const params = [b.swLng, b.swLat, b.neLng, b.neLat, categories?.length ? categories : null, regionId ?? null];
    const limit = shopsForLevel(level ?? 3);
    const labels = labelsForLevel(level ?? 3);

    // Spread picks over the screen: split it into a GRID×GRID grid and take each cell's most notable shop first,
    // then each cell's second, … so a zoomed-out map shows every area's landmarks, not one dense block.
    const [rows, count] = await Promise.all([
      this.db.pool.query(
        `WITH c AS (
           SELECT s.id, ${DISPLAY_NAME_SQL} AS name, s.kind, s.category, s.road_address, s.in_market,
                  ST_Y(s.geom::geometry) AS lat, ST_X(s.geom::geometry) AS lng, ${PROMINENCE_SQL} AS prominence
           FROM shops s WHERE ${where}
         ), ranked AS (
           SELECT c.*, row_number() OVER (
                    PARTITION BY floor((c.lng - $1) / (($3 - $1) / ${GRID})), floor((c.lat - $2) / (($4 - $2) / ${GRID}))
                    ORDER BY c.prominence DESC, c.id) AS cell_rank
           FROM c
         )
         SELECT r.*, (SELECT x.payload->>'place_url' FROM raw_sources x
                       WHERE x.shop_id = r.id AND x.source = 'kakao' LIMIT 1) AS place_url
         FROM ranked r
         ORDER BY r.cell_rank, r.prominence DESC, r.id
         LIMIT $7`,
        [...params, limit],
      ),
      this.db.pool.query(`SELECT count(*)::int AS n FROM shops s WHERE ${where}`, params),
    ]);

    return {
      total: count.rows[0].n,
      // Labels go to the most notable of the picked shops, wherever they are on screen.
      shops: labelTop(rows.rows, labels).map(({ r, labeled }) => ({
        id: String(r.id),
        name: cleanName(r.name),
        kind: r.kind,
        category: r.category,
        lat: r.lat,
        lng: r.lng,
        roadAddress: r.road_address ?? undefined,
        inMarket: r.in_market,
        placeUrl: r.place_url ?? undefined,
        prominence: Number(r.prominence),
        labeled,
      })),
    };
  }
}

function labelTop<T extends { prominence: number | string }>(rows: T[], n: number): { r: T; labeled: boolean }[] {
  const cutoff = [...rows].map((r) => Number(r.prominence)).sort((a, b) => b - a)[n - 1] ?? -1;
  let left = n;
  return rows.map((r) => {
    const labeled = left > 0 && Number(r.prominence) >= cutoff;
    if (labeled) left -= 1;
    return { r, labeled };
  });
}
