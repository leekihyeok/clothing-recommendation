import { Args, Context, Field, Float, ID, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { loadTaste, MIN_SIGNALS, tasteSummary } from './taste';
import { DbService } from '../infra/db.service';
import { cleanName } from '../shops/names';
import { DISPLAY_NAME_SQL } from '../shops/shops.resolver';
import { MapShop } from '../shops/shops.model';
import { Action, MeService, type Request } from './me.service';

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
    // 찜 needs a Kakao login (the client opens the login modal on the 401); visits and ratings stay anonymous-friendly.
    if (action === 'save' || action === 'unsave') await this.me.requireLogin(req);
    const userId = (await this.me.userId(req, true))!;
    return this.me.record(userId, shopId, action as Action, courseId);
  }

  @Mutation(() => Boolean, { description: '내 가게 기록을 모두 지운다 (로그인 중이면 계정과 그 기록)' })
  async forgetMe(@Context('req') req: Request): Promise<boolean> {
    const userId = await this.me.userId(req, false);
    if (userId) await this.me.forget(userId);
    return true;
  }
}
