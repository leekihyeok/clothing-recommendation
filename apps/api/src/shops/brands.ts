import { Args, Field, ID, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { Pool } from 'pg';
import { DbService } from '../infra/db.service';

@ObjectType({ description: '브랜드 (pipeline.brands의 브랜드 사전)' })
export class BrandRef {
  @Field(() => ID, { description: '정규화한 이름 (예: adererror)' })
  key: string;

  @Field({ description: '보여 줄 이름 (예: 아더에러)' })
  name: string;

  @Field({ nullable: true, description: '영문 표기' })
  nameEn?: string;

  @Field(() => Int, { description: '이 브랜드를 다루는 가게 수' })
  shops: number;

  @Field(() => [String], { description: '그 가게가 많은 지역 (많은 순, 최대 2곳)' })
  areas: string[];
}

/** Same rule as services/model/pipeline/brands.py norm(): lower case, letters and Hangul only. */
export const brandKey = (text: string) => text.toLowerCase().replace(/[^0-9a-z가-힣]/g, '');

/**
 * Brands for a typed name: an exact spelling first ("아더에러", "ader error"), then names starting with it, then
 * containing it; more shops first. Only brands at least one open shop carries.
 */
export async function findBrands(pool: Pool, q: string, limit: number): Promise<BrandRef[]> {
  const k = brandKey(q);
  if (k.length < 2) return [];
  const r = await pool.query<{ key: string; name: string; name_en: string | null; shops: number; areas: string[] | null }>(
    `SELECT b.key, b.name, b.name_en, count(DISTINCT sb.shop_id)::int AS shops,
            (SELECT array_agg(a.name ORDER BY a.n DESC) FROM (
               SELECT g.name, count(*) AS n FROM shop_brands x JOIN shops y ON y.id = x.shop_id AND y.status = 'candidate'
               JOIN regions g ON ST_Intersects(g.polygon, y.geom)
               WHERE x.brand_key = b.key GROUP BY g.name ORDER BY n DESC LIMIT 2) a) AS areas,
            min(CASE WHEN $1 = ANY(b.aliases) THEN 0 WHEN EXISTS (SELECT 1 FROM unnest(b.aliases) a WHERE a LIKE $1 || '%') THEN 1 ELSE 2 END) AS rank
     FROM brands b
     JOIN shop_brands sb ON sb.brand_key = b.key
     JOIN shops s ON s.id = sb.shop_id AND s.status = 'candidate'
     WHERE EXISTS (SELECT 1 FROM unnest(b.aliases) a WHERE a LIKE '%' || $1 || '%')
     GROUP BY b.key
     ORDER BY rank, shops DESC, length(b.name)
     LIMIT $2`,
    [k, limit],
  );
  return r.rows.map((x) => ({ key: x.key, name: x.name, nameEn: x.name_en ?? undefined, shops: x.shops, areas: x.areas ?? [] }));
}

/** The best brand for each name, for text like "아더에러 파는 데" (exact spelling or a clear prefix only). */
export async function resolveBrands(pool: Pool, names: string[]): Promise<{ found: BrandRef[]; missing: string[] }> {
  const found: BrandRef[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const [best] = await findBrands(pool, n, 1);
    if (best && (best.key === brandKey(n) || brandKey(best.name).startsWith(brandKey(n)) || (best.nameEn && brandKey(best.nameEn).startsWith(brandKey(n))))) {
      if (!found.some((f) => f.key === best.key)) found.push(best);
    } else missing.push(n);
  }
  return { found, missing };
}

export async function brandsByKey(pool: Pool, keys: string[]): Promise<BrandRef[]> {
  if (!keys.length) return [];
  const r = await pool.query<{ key: string; name: string; name_en: string | null }>('SELECT key, name, name_en FROM brands WHERE key = ANY($1)', [keys]);
  const byKey = new Map(r.rows.map((x) => [x.key, x]));
  return keys.filter((k) => byKey.has(k)).map((k) => ({ key: k, name: byKey.get(k)!.name, nameEn: byKey.get(k)!.name_en ?? undefined, shops: 0, areas: [] }));
}

@Resolver()
export class BrandsResolver {
  constructor(private readonly db: DbService) {}

  @Query(() => [BrandRef], { description: '브랜드 이름으로 찾기 (한글·영문 어느 쪽이든). 다루는 가게가 있는 브랜드만' })
  brandSearch(@Args('q') q: string, @Args('limit', { type: () => Int, defaultValue: 8 }) limit: number): Promise<BrandRef[]> {
    return findBrands(this.db.pool, q.slice(0, 40), Math.min(20, Math.max(1, limit)));
  }
}
