import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Args, Context, Field, ID, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { Pool } from 'pg';
import { DbService } from '../infra/db.service';
import { MeService, type Request } from '../me/me.service';
import { cleanName } from '../shops/names';
import { DISPLAY_NAME_SQL } from '../shops/shops.resolver';
import { OwnersService } from './owners.service';
import { L, lang } from '../infra/lang';

export const NEWS_KINDS = ['new', 'sale', 'event', 'notice'] as const;
const KIND_LABEL: Record<string, string> = { new: '신상 입고', sale: '세일', event: '이벤트', notice: '공지' };
const KIND_LABEL_EN: Record<string, string> = { new: 'New in', sale: 'Sale', event: 'Event', notice: 'Notice' };
// A post without an end date shows this long after it went up.
const DEFAULT_DAYS = 30;
const MAX_PER_DAY = 5;

@ObjectType({ description: '사장님 소식 한 건' })
export class ShopNews {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  shopId: string;

  @Field()
  shopName: string;

  @Field({ description: 'new | sale | event | notice' })
  kind: string;

  @Field({ description: '"신상 입고", "세일" …' })
  kindLabel: string;

  @Field()
  title: string;

  @Field({ nullable: true })
  body?: string;

  @Field({ nullable: true, description: '끝나는 날 (YYYY-MM-DD)' })
  endsOn?: string;

  @Field()
  createdAt: Date;
}

interface Row {
  id: string;
  shop_id: string;
  shop_name: string;
  kind: string;
  title: string;
  body: string | null;
  ends_on: string | null;
  created_at: Date;
}

// Still showing: not deleted, and before its end date (or, without one, within 30 days of posting).
const ACTIVE = `n.deleted_at IS NULL AND (CASE WHEN n.ends_on IS NOT NULL THEN n.ends_on >= (now() AT TIME ZONE 'Asia/Seoul')::date
                                           ELSE n.created_at > now() - interval '${DEFAULT_DAYS} days' END)`;
const SELECT = `SELECT n.id::text, n.shop_id::text, ${DISPLAY_NAME_SQL} AS shop_name, n.kind, n.title, n.body,
                       to_char(n.ends_on, 'YYYY-MM-DD') AS ends_on, n.created_at
                FROM shop_news n JOIN shops s ON s.id = n.shop_id`;

const toNews = (r: Row): ShopNews => ({
  id: r.id, shopId: r.shop_id, shopName: cleanName(r.shop_name), kind: r.kind, kindLabel: (lang() === 'en' ? KIND_LABEL_EN : KIND_LABEL)[r.kind] ?? r.kind,
  title: r.title, body: r.body ?? undefined, endsOn: r.ends_on ?? undefined, createdAt: r.created_at,
});

/** Active news for shops, newest first (the shop page, saved shops). */
export async function newsFor(pool: Pool, shopIds: string[], limit: number): Promise<ShopNews[]> {
  const ids = shopIds.filter((x) => /^\d+$/.test(x));
  if (!ids.length) return [];
  const r = await pool.query<Row>(`${SELECT} WHERE n.shop_id = ANY($1::bigint[]) AND ${ACTIVE} ORDER BY n.created_at DESC LIMIT $2`, [ids, limit]);
  return r.rows.map(toNews);
}

/** For course cards: the newest running sale / new arrivals / event per shop ("세일 중"). */
export async function newsTags(pool: Pool, shopIds: string[]): Promise<Map<string, string>> {
  const ids = shopIds.filter((x) => /^\d+$/.test(x));
  if (!ids.length) return new Map();
  const r = await pool.query<{ shop_id: string; kind: string }>(
    `SELECT DISTINCT ON (n.shop_id) n.shop_id::text, n.kind FROM shop_news n
     WHERE n.shop_id = ANY($1::bigint[]) AND n.kind IN ('sale', 'new', 'event') AND ${ACTIVE}
     ORDER BY n.shop_id, n.created_at DESC`,
    [ids],
  );
  const tag: Record<string, string> = { sale: L('세일 중', 'On sale'), new: L('신상 입고', 'New in'), event: L('이벤트 중', 'Event on') };
  return new Map(r.rows.map((x) => [x.shop_id, tag[x.kind]]));
}

@Resolver()
export class ShopNewsResolver {
  constructor(
    private readonly db: DbService,
    private readonly me: MeService,
    private readonly owners: OwnersService,
  ) {}

  @Query(() => [ShopNews], { description: '가게의 사장님 소식 (지금 보이는 것, 최신순)' })
  shopNews(@Args('shopId', { type: () => ID }) shopId: string, @Args('limit', { type: () => Int, defaultValue: 5 }) limit: number) {
    return newsFor(this.db.pool, [shopId], Math.min(20, Math.max(1, limit)));
  }

  @Query(() => [ShopNews], { description: '찜한 가게들의 사장님 소식 (최신순)' })
  async mySavedNews(@Args('limit', { type: () => Int, defaultValue: 30 }) limit: number, @Context('req') req: Request): Promise<ShopNews[]> {
    const userId = await this.me.userId(req, false);
    if (!userId) return [];
    const saved = (await this.me.states(userId, null)).filter((s) => s.saved).map((s) => s.shopId);
    return newsFor(this.db.pool, saved, Math.min(50, Math.max(1, limit)));
  }

  @Mutation(() => ShopNews, { description: '사장님: 소식 올리기 (kind: new | sale | event | notice, 끝나는 날은 선택)' })
  async postShopNews(
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('kind') kind: string,
    @Args('title') title: string,
    @Args('body', { type: () => String, nullable: true }) body: string | undefined,
    @Args('endsOn', { type: () => String, nullable: true, description: 'YYYY-MM-DD' }) endsOn: string | undefined,
    @Context('req') req: Request,
  ): Promise<ShopNews> {
    const userId = await this.me.requireLogin(req);
    if (!(await this.owners.isOwner(userId, shopId))) throw new ForbiddenException('이 가게의 사장님만 소식을 올릴 수 있어요');
    if (!(NEWS_KINDS as readonly string[]).includes(kind)) throw new BadRequestException('소식 종류를 골라 주세요');
    const t = title.trim();
    if (!t) throw new BadRequestException('제목을 적어 주세요');
    if (endsOn && (!/^\d{4}-\d{2}-\d{2}$/.test(endsOn) || endsOn < new Date().toISOString().slice(0, 10))) {
      throw new BadRequestException('끝나는 날은 오늘이나 그 뒤로 골라 주세요');
    }
    const today = await this.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM shop_news WHERE shop_id = $1 AND created_at > now() - interval '1 day'`,
      [shopId],
    );
    if (today.rows[0].n >= MAX_PER_DAY) throw new BadRequestException(`소식은 하루 ${MAX_PER_DAY}개까지 올릴 수 있어요`);
    const r = await this.db.pool.query<{ id: string }>(
      `INSERT INTO shop_news (shop_id, author_id, kind, title, body, ends_on) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`,
      [shopId, userId, kind, t.slice(0, 60), body?.trim().slice(0, 500) || null, endsOn || null],
    );
    const row = (await this.db.pool.query<Row>(`${SELECT} WHERE n.id = $1`, [r.rows[0].id])).rows[0];
    return toNews(row);
  }

  @Mutation(() => Boolean, { description: '사장님: 소식 지우기' })
  async deleteShopNews(@Args('id', { type: () => ID }) id: string, @Context('req') req: Request): Promise<boolean> {
    const userId = await this.me.requireLogin(req);
    const n = (await this.db.pool.query<{ shop_id: string }>('SELECT shop_id::text FROM shop_news WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
    if (!n) return false;
    if (!(await this.owners.isOwner(userId, n.shop_id))) throw new ForbiddenException('이 가게의 사장님만 지울 수 있어요');
    await this.db.pool.query('UPDATE shop_news SET deleted_at = now() WHERE id = $1', [id]);
    return true;
  }
}
