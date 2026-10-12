import { Args, Context, Field, Float, ID, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { loadTaste, MIN_SIGNALS, tasteSummary } from './taste';
import { DbService } from '../infra/db.service';
import { cleanName } from '../shops/names';
import { DISPLAY_NAME_SQL } from '../shops/shops.resolver';
import { MapShop } from '../shops/shops.model';
import { LatLng } from '../regions/regions.resolver';
import { Action, MeService, type Request } from './me.service';
import { ProfileService } from './profile.service';
import { RateLimitService } from '../infra/rate-limit.service';

@ObjectType({ description: '이 사용자와 가게 하나의 관계' })
export class MyShopState {
  @Field(() => ID)
  shopId: string;

  @Field()
  saved: boolean;

  @Field(() => Int)
  visits: number;

  @Field(() => Int, { description: '1 좋았어요, -1 별로였어요, 0 없음' })
  rating: number;

  @Field()
  purchased: boolean;

  @Field(() => Int)
  views: number;

  @Field()
  closedReported: boolean;

  @Field({ nullable: true })
  lastVisitAt?: Date;
}

@ObjectType({ description: '찜한 가게 한 묶음 (같은 동네): 이 가게들로 코스를 짤 수 있다' })
export class SavedGroup {
  @Field({ description: '지역 이름, 또는 지역 밖이면 "○○ 근처"' })
  name: string;

  @Field(() => ID, { nullable: true, description: '지역 안이면 그 지역 (지하철역에서 출발)' })
  regionId?: string;

  @Field(() => LatLng, { description: '묶음 가운데 (지역 밖일 때 출발점)' })
  center: LatLng;

  @Field(() => [SavedGroupShop], { description: '찜한 가게들 (최근에 찜한 순)' })
  shops: SavedGroupShop[];
}

@ObjectType()
export class SavedGroupShop {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;
}

// A saved shop just outside every region still joins the nearest one within this distance (a street off 성수).
const GROUP_NEAR_REGION_M = 1500;
// Saved shops outside any region group with those this close.
const GROUP_RADIUS_M = 1200;

@ObjectType()
export class MyShop {
  @Field(() => MapShop)
  shop: MapShop;

  @Field(() => MyShopState)
  state: MyShopState;
}

@ObjectType()
export class TasteStyle {
  @Field()
  style: string;

  @Field(() => Float, { description: '-1~1' })
  weight: number;
}

@ObjectType({ description: '기록으로 배운 취향 (코스 추천에 쓰임)' })
export class MyTaste {
  @Field(() => [TasteStyle], { description: '좋아하는 쪽, 강한 순' })
  likes: TasteStyle[];

  @Field(() => [TasteStyle], { description: '덜 좋아하는 쪽' })
  avoids: TasteStyle[];

  @Field(() => Int, { description: '취향을 배운 가게 수' })
  signals: number;

  @Field({ description: '추천에 반영되고 있나 (기록이 2곳 이상)' })
  active: boolean;

  @Field({ nullable: true, description: '자주 좋아한 가격대 low | mid | high' })
  price?: string;
}

@ObjectType({ description: '로그인 상태' })
export class Account {
  @Field()
  loggedIn: boolean;

  @Field({ nullable: true, description: '카카오 닉네임' })
  nickname?: string;
}

@ObjectType({ description: '내 가게: 찜한 곳, 다녀온 곳, 자주 본 곳' })
export class MyShops {
  @Field(() => [MyShop])
  saved: MyShop[];

  @Field(() => [MyShop])
  visited: MyShop[];

  @Field(() => [MyShop], { description: '두 번 이상 열어 본 곳 (찜·방문 제외)' })
  frequent: MyShop[];
}

@Resolver()
export class MeResolver {
  constructor(
    private readonly me: MeService,
    private readonly db: DbService,
    private readonly profile: ProfileService,
    private readonly limits: RateLimitService,
  ) {}

  @Query(() => Account, { name: 'me', description: '카카오 로그인 상태' })
  async account(@Context('req') req: Request): Promise<Account> {
    const a = await this.me.account(req);
    return { loggedIn: a.loggedIn, nickname: a.nickname ?? undefined };
  }

  @Query(() => MyTaste, { description: '내 취향 프로필 (찜·좋았어요·샀어요·후기·저장한 코스로 배움)' })
  async myTaste(@Context('req') req: Request): Promise<MyTaste> {
    const userId = await this.me.userId(req, false);
    if (!userId) return { likes: [], avoids: [], signals: 0, active: false };
    const taste = await loadTaste(this.db.pool, userId);
    const { likes, avoids } = tasteSummary(taste);
    const round = ([style, w]: readonly [string, number]) => ({ style, weight: Math.round(w * 100) / 100 });
    return {
      likes: likes.map(round), avoids: avoids.map(round), signals: taste.signals, active: taste.signals >= MIN_SIGNALS,
      price: taste.price ?? undefined,
    };
  }

  @Query(() => [MyShopState], { description: '가게들에 대한 내 상태 (찜, 방문, 만족도). 기록이 없으면 빈 상태' })
  async myShopStates(@Args('shopIds', { type: () => [ID] }) shopIds: string[], @Context('req') req: Request): Promise<MyShopState[]> {
    const ids = shopIds.filter((x) => /^\d+$/.test(x)).slice(0, 200);
    const userId = await this.me.userId(req, false);
    if (!userId) return ids.map((shopId) => ({ shopId, saved: false, visits: 0, rating: 0, purchased: false, views: 0, closedReported: false }));
    return this.me.states(userId, ids);
  }

  /**
   * "찜한 가게로 코스 짜기": saved shops (still open) by neighbourhood — the region they're in, else the nearest region
   * within 1.5 km, else a group of their own around them. Biggest group first.
   */
  @Query(() => [SavedGroup])
  async mySavedGroups(@Context('req') req: Request): Promise<SavedGroup[]> {
    const userId = await this.me.userId(req, false);
    if (!userId) return [];
    const saved = (await this.me.states(userId, null)).filter((s) => s.saved).sort((a, b) => +b.lastSeenAt - +a.lastSeenAt);
    if (!saved.length) return [];
    const rows = (
      await this.db.pool.query<{ id: string; name: string; lat: number; lng: number; region_id: string | null; region: string | null }>(
        `SELECT s.id::text, ${DISPLAY_NAME_SQL} AS name, ST_Y(s.geom::geometry) AS lat, ST_X(s.geom::geometry) AS lng, g.id::text AS region_id, g.name AS region
         FROM shops s
         LEFT JOIN LATERAL (
           SELECT g.id, g.name FROM regions g
           WHERE ST_Intersects(g.polygon, s.geom) OR ST_DWithin(g.polygon::geography, s.geom::geography, $2)
           ORDER BY ST_Intersects(g.polygon, s.geom) DESC, ST_Distance(g.polygon::geography, s.geom::geography), g.shop_count DESC LIMIT 1
         ) g ON true
         WHERE s.id = ANY($1::bigint[]) AND s.status = 'candidate'`,
        [saved.map((s) => s.shopId), GROUP_NEAR_REGION_M],
      )
    ).rows;
    const order = new Map(saved.map((s, i) => [s.shopId, i]));
    rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    const groups: (SavedGroup & { pts: { lat: number; lng: number }[] })[] = [];
    const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
      const k = Math.PI / 180;
      const x = (b.lng - a.lng) * k * Math.cos(((a.lat + b.lat) / 2) * k);
      return Math.hypot(x, (b.lat - a.lat) * k) * 6_371_000;
    };
    for (const r of rows) {
      const shop = { id: r.id, name: cleanName(r.name) };
      let g = r.region_id
        ? groups.find((x) => x.regionId === r.region_id)
        : groups.find((x) => !x.regionId && metres(x.center, r) <= GROUP_RADIUS_M);
      if (!g) {
        g = { name: r.region ?? `${shop.name} 근처`, regionId: r.region_id ?? undefined, center: { lat: r.lat, lng: r.lng }, shops: [], pts: [] };
        groups.push(g);
      }
      g.shops.push(shop);
      g.pts.push({ lat: r.lat, lng: r.lng });
      g.center = { lat: g.pts.reduce((a, p) => a + p.lat, 0) / g.pts.length, lng: g.pts.reduce((a, p) => a + p.lng, 0) / g.pts.length };
    }
    return groups.sort((a, b) => b.shops.length - a.shops.length).map(({ pts: _pts, ...g }) => g);
  }

  @Query(() => MyShops)
  async myShops(@Context('req') req: Request): Promise<MyShops> {
    const userId = await this.me.userId(req, false);
    if (!userId) return { saved: [], visited: [], frequent: [] };
    const states = await this.me.states(userId, null);
    if (!states.length) return { saved: [], visited: [], frequent: [] };
    const shops = await this.db.pool.query(
      `SELECT s.id::text AS id, ${DISPLAY_NAME_SQL} AS name, s.kind, s.category, s.road_address, s.in_market, s.status,
              ST_Y(s.geom::geometry) AS lat, ST_X(s.geom::geometry) AS lng,
              (SELECT r.payload->>'place_url' FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao' LIMIT 1) AS place_url
       FROM shops s WHERE s.id = ANY($1::bigint[])`,
      [states.map((x) => x.shopId)],
    );
    const byId = new Map(
      shops.rows.map((r) => [
        r.id as string,
        {
          id: r.id, name: cleanName(r.name), kind: r.kind, category: r.category, lat: r.lat, lng: r.lng,
          roadAddress: r.road_address ?? undefined, inMarket: r.in_market, placeUrl: r.place_url ?? undefined, status: r.status,
          prominence: 0, labeled: true,
        } as MapShop,
      ]),
    );
    const recent = (a: { lastSeenAt: Date }, b: { lastSeenAt: Date }) => +new Date(b.lastSeenAt) - +new Date(a.lastSeenAt);
    const items = [...states].sort(recent).flatMap((state) => (byId.has(state.shopId) ? [{ shop: byId.get(state.shopId)!, state }] : []));
    return {
      saved: items.filter((x) => x.state.saved),
      visited: items.filter((x) => x.state.visits > 0),
      frequent: items.filter((x) => !x.state.saved && x.state.visits <= 0 && x.state.views >= 2),
    };
  }

  @Mutation(() => MyShopState, { description: 'save | unsave | visit | unvisit | like | dislike | unrate | purchase | closed | view' })
  async recordShop(
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('action') action: string,
    @Args('courseId', { type: () => ID, nullable: true }) courseId: string | undefined,
    @Context('req') req: Request,
  ): Promise<MyShopState> {
    // 찜 and 폐업 신고 need a Kakao login (the client opens the login modal on the 401); visits and ratings stay
    // anonymous-friendly. A 폐업 report counts toward hiding the shop, so a fresh anonymous key per request mustn't count.
    if (action === 'save' || action === 'unsave' || action === 'closed') await this.me.requireLogin(req);
    const userId = (await this.me.userId(req, true))!;
    await this.limits.hit('record', req, userId);
    return this.me.record(userId, shopId, action as Action, courseId);
  }

  @Mutation(() => Boolean, { description: '내 가게 기록을 모두 지운다 (로그인 중이면 계정과 그 기록)' })
  async forgetMe(@Context('req') req: Request): Promise<boolean> {
    // The whole account: rows, the avatar and certificate files, and the Kakao link.
    const userId = await this.me.userId(req, false);
    if (userId) await this.profile.deleteAccount(userId);
    return true;
  }
}
