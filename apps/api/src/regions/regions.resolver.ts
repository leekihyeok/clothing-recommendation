import { inLang } from '../infra/translations';
import { Args, Field, Float, ID, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { DbService } from '../infra/db.service';

@ObjectType()
export class LatLng {
  @Field(() => Float)
  lat: number;

  @Field(() => Float)
  lng: number;
}

@ObjectType()
export class CategoryCount {
  @Field()
  category: string;

  @Field(() => Int)
  count: number;
}

@ObjectType({ description: '가게가 모여 있는 쇼핑 지역 (자동 탐지, AI가 이름 붙임)' })
export class Region {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field({ nullable: true })
  intro?: string;

  @Field(() => LatLng)
  center: LatLng;

  @Field(() => [LatLng], { description: '영역 외곽선' })
  polygon: LatLng[];

  @Field(() => Int)
  shopCount: number;

  @Field(() => [CategoryCount], { description: '가게 종류별 수, 많은 순' })
  categories: CategoryCount[];

  @Field(() => [String])
  stations: string[];
}

// Categories that make an area worth a trip; used to sort regions for a chosen category.
const SORTABLE = new Set(['select_shop', 'vintage', 'brand', 'spa', 'general', 'complex']);

@Resolver(() => Region)
export class RegionsResolver {
  constructor(private readonly db: DbService) {}

  @Query(() => [Region], { description: '쇼핑 지역. category를 주면 그 종류 가게가 많은 순' })
  async regions(@Args('category', { nullable: true }) category?: string): Promise<Region[]> {
    const { rows } = await this.db.pool.query(
      `SELECT id, name, intro, shop_count, category_counts, stations,
              ST_Y(center::geometry) AS lat, ST_X(center::geometry) AS lng,
              ST_AsGeoJSON(polygon)::json AS polygon
       FROM regions ORDER BY shop_count DESC`,
    );
    const en = await inLang(this.db.pool, rows.flatMap((r) => [r.name, r.intro]));
    const regions: Region[] = rows.map((r) => ({
      id: String(r.id),
      name: en.get(r.name) ?? r.name,
      intro: r.intro ? (en.get(r.intro) ?? r.intro) : undefined,
      center: { lat: r.lat, lng: r.lng },
      // GeoJSON polygon: first ring is the outline, as [lng, lat] pairs.
      polygon: (r.polygon.coordinates[0] as [number, number][]).map(([lng, lat]) => ({ lat, lng })),
      shopCount: r.shop_count,
      categories: Object.entries(r.category_counts as Record<string, number>)
        .map(([c, n]) => ({ category: c, count: n }))
        .sort((a, b) => b.count - a.count),
      stations: r.stations,
    }));
    if (category && SORTABLE.has(category)) {
      const n = (r: Region) => r.categories.find((c) => c.category === category)?.count ?? 0;
      regions.sort((a, b) => n(b) - n(a));
    }
    return regions;
  }
}
