import { BadRequestException } from '@nestjs/common';
import { Args, Context, Field, Float, ID, Int, Mutation, ObjectType, Resolver } from '@nestjs/graphql';
import { DbService } from '../infra/db.service';
import { EventsService } from '../infra/events.service';
import { ModelClient } from '../infra/model.client';
import { MeService, type Request } from '../me/me.service';
import { LatLng } from '../regions/regions.resolver';
import { ShopHit } from '../shops/search.resolver';
import { searchShops } from '../shops/search';

@ObjectType()
export class StyleWeight {
  @Field()
  id: string;

  @Field(() => Float)
  weight: number;
}

@ObjectType({ description: '글을 읽고 만든 요청서 초안. 비어 있는 칸은 사용자가 말하지 않은 것' })
export class ParsedPrompt {
  @Field(() => ID, { nullable: true })
  regionId?: string;

  @Field({ nullable: true })
  regionName?: string;

  @Field(() => LatLng, { nullable: true, description: '지역 목록에 없는 장소(역 등)를 찾은 좌표' })
  point?: LatLng;

  @Field({ nullable: true })
  placeName?: string;

  @Field(() => [StyleWeight])
  styles: StyleWeight[];

  @Field(() => Int, { nullable: true })
  stopCount?: number;

  @Field()
  maxStops: boolean;

  @Field(() => Int, { nullable: true })
  timeBudgetMin?: number;

  @Field()
  budget: string;

  @Field(() => [String])
  items: string[];

  @Field()
  wantsCafe: boolean;

  @Field({ description: '가는 길에 밥·맛집을 넣고 싶어 함' })
  wantsFood: boolean;

  @Field({ description: 'any | men | women (남성복 / 여성복)' })
  gender: string;

  @Field(() => [ShopHit], { description: '꼭 넣어 달라고 한 가게 (이름으로 찾은 것)' })
  mustShops: ShopHit[];

  @Field(() => [String], { description: '꼭 넣어 달라고 했지만 찾지 못한 이름' })
  mustNotFound: string[];

  @Field(() => [String], { description: '지금은 못 하는 요청 (서울 밖, 대중교통 …)' })
  unsupported: string[];

  @Field({ description: '이해한 내용 한 줄' })
  summary: string;
}

@ObjectType()
export class PhotoStyles {
  @Field(() => [StyleWeight])
  styles: StyleWeight[];

  @Field(() => [String])
  items: string[];

  @Field()
  description: string;
}

interface ModelParse {
  parsed: {
    region_name: string | null;
    place: string | null;
    styles: { id: string; weight: number }[];
    stop_count: number | null;
    max_stops: boolean;
    time_budget_min: number | null;
    budget: string;
    items: string[];
    wants_cafe: boolean;
    wants_food?: boolean;
    must_shops?: string[];
    gender?: string;
    unsupported: string[];
    summary: string;
  };
  place_point: { lat: number; lng: number; name: string } | null;
}

const MAX_IMAGE_BASE64 = 6_000_000; // ~4.5 MB; the client resizes photos to ~768px first

@Resolver()
export class ParseResolver {
  constructor(
    private readonly db: DbService,
    private readonly model: ModelClient,
    private readonly me: MeService,
    private readonly events: EventsService,
  ) {}

  @Mutation(() => ParsedPrompt, { description: '자유롭게 쓴 글 → 요청서 초안 (AI)' })
  async parsePrompt(@Args('text') text: string, @Context('req') req: Request): Promise<ParsedPrompt> {
    const trimmed = text.trim();
    if (!trimmed) throw new BadRequestException('원하는 코스를 적어 주세요');
    if (trimmed.length > 500) throw new BadRequestException('500자 안으로 적어 주세요');
    return this.events.timed(
      'parse_text',
      { userId: await this.me.userId(req, false), data: { chars: trimmed.length } },
      () => this.parse(trimmed),
      (p) => ({ data: { place: !!(p.regionId || p.point), styles: p.styles.length, unsupported: p.unsupported.length } }),
    );
  }

  private async parse(trimmed: string): Promise<ParsedPrompt> {
    const regions = (await this.db.pool.query<{ id: string; name: string }>('SELECT id::text, name FROM regions')).rows;
    const res = await this.model.post<ModelParse>('/parse', { text: trimmed, region_names: regions.map((r) => r.name) }, 30000);
    const p = res.parsed;
    const region = regions.find((r) => r.name === p.region_name);
    // "○○는 무조건 넣어 줘": the closest name match near where the course starts (the region's middle or the place).
    const near = region
      ? (await this.db.pool.query<{ lat: number; lng: number }>(
          'SELECT ST_Y(ST_Centroid(polygon)::geometry) AS lat, ST_X(ST_Centroid(polygon)::geometry) AS lng FROM regions WHERE id = $1',
          [region.id],
        )).rows[0]
      : res.place_point ?? undefined;
    const names = [...new Set((p.must_shops ?? []).map((n) => n.trim()).filter(Boolean))].slice(0, 8);
    const hits = await Promise.all(names.map((n) => searchShops(this.db.pool, n, near, 1, true).then((h) => h[0])));
    return {
      mustShops: hits.filter((h): h is ShopHit => !!h),
      mustNotFound: names.filter((_, i) => !hits[i]),
      regionId: region?.id,
      regionName: region?.name,
      point: !region && res.place_point ? { lat: res.place_point.lat, lng: res.place_point.lng } : undefined,
      placeName: !region ? (res.place_point?.name ?? p.place ?? undefined) : undefined,
      styles: p.styles,
      stopCount: p.stop_count ?? undefined,
      maxStops: p.max_stops,
      timeBudgetMin: p.time_budget_min ?? undefined,
      budget: p.budget,
      items: p.items,
      wantsCafe: p.wants_cafe,
      wantsFood: p.wants_food === true,
      gender: p.gender === 'men' || p.gender === 'women' ? p.gender : 'any',
      unsupported: p.unsupported,
      summary: p.summary,
    };
  }

  @Mutation(() => PhotoStyles, { description: '옷 사진 → 스타일 (AI). 사진은 저장하지 않는다' })
  async parsePhoto(
    @Args('imageBase64') imageBase64: string,
    @Args('mimeType') mimeType: string,
    @Context('req') req: Request,
  ): Promise<PhotoStyles> {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new BadRequestException('JPG, PNG, WEBP 사진만 돼요');
    if (imageBase64.length > MAX_IMAGE_BASE64) throw new BadRequestException('사진이 너무 커요');
    return this.events.timed(
      'parse_photo',
      { userId: await this.me.userId(req, false) },
      () => this.model.post<PhotoStyles>('/photo', { image_base64: imageBase64, mime_type: mimeType }, 30000),
      (p) => ({ data: { styles: p.styles.length } }),
    );
  }
}
