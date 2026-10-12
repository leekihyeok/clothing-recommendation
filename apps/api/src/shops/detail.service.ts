import { inLang } from '../infra/translations';
import { BadRequestException, Injectable } from '@nestjs/common';
import { DbService } from '../infra/db.service';
import { cleanName } from './names';
import { DISPLAY_NAME_SQL } from './shops.resolver';
import { Review, ShopDetail, SourcePost } from './detail.model';

const SOURCE_LABEL: Record<string, string> = { daum_blog: '블로그', daum_cafe: '카페', daum_web: '웹문서', daum_vclip: '영상' };
// How much the blog reputation counts in the combined rating: as many "votes" as posts it rests on, at most this.
const BLOG_WEIGHT_MAX = 5;
const REVIEW_PAGE = 10;

/** Public URL of an uploaded file (users.avatar_path), served by the API under /media. */
export const mediaUrl = (path: string | null | undefined) => (path ? `/media/${path}` : undefined);

const REVIEW_SQL = `
  SELECT r.id::text, r.rating, r.body, r.created_at, r.updated_at, r.user_id,
         coalesce(u.nickname, '이름 없음') AS nickname, u.avatar_path
  FROM shop_reviews r JOIN users u ON u.id = r.user_id`;

interface ReviewRow {
  id: string; rating: number; body: string | null; created_at: Date; updated_at: Date; user_id: string; nickname: string; avatar_path: string | null;
}

function toReview(r: ReviewRow, viewer: string | null): Review {
  return {
    id: r.id, rating: r.rating, body: r.body ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
    mine: r.user_id === viewer, author: { nickname: r.nickname, avatarUrl: mediaUrl(r.avatar_path) },
  };
}

/** Shop detail page: what we know about the shop, how many people saved / visited it, reviews and ratings. */
@Injectable()
export class ShopDetailService {
  constructor(private readonly db: DbService) {}

  async detail(shopId: string, viewer: string | null): Promise<ShopDetail | null> {
    if (!/^\d+$/.test(shopId)) return null;
    const r = await this.db.pool.query(
      `SELECT s.id::text, ${DISPLAY_NAME_SQL} AS name, s.kind, s.category, s.status, s.in_market, s.summary, s.reason_material,
              s.price_range, coalesce(s.items, '{}') AS items, s.confidence, coalesce(s.matched_posts, 0) AS posts,
              s.blog_score, coalesce(s.blog_pros, '{}') AS pros, coalesce(s.blog_cons, '{}') AS cons, s.road_address,
              ST_Y(s.geom::geometry) AS lat, ST_X(s.geom::geometry) AS lng,
              (SELECT r.payload->>'place_url' FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao' LIMIT 1) AS place_url,
              (SELECT nullif(r.payload->>'phone', '') FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao' LIMIT 1) AS phone,
              (SELECT coalesce(jsonb_agg(jsonb_build_object('style', style_id, 'score', score) ORDER BY score DESC), '[]')
                 FROM shop_style_scores x WHERE x.shop_id = s.id AND x.score >= 5) AS styles,
              s.merged_into::text AS merged_into
       FROM shops s WHERE s.id = $1 AND s.category IS NOT NULL AND s.category <> 'excluded'`,
      [shopId],
    );
    const s = r.rows[0];
    if (!s) return null;
    // A duplicate merged into another listing (pipeline.merge_dupes): show the one that stayed.
    if (s.status === 'merged' && s.merged_into) return this.detail(s.merged_into, viewer);

    // Saved = the person's latest save/unsave is a save; visitors = anyone with a visit left (visit minus unvisit).
    const people = await this.db.pool.query<{ saves: number; visitors: number }>(
      `WITH per AS (
         SELECT user_id,
                (array_agg(kind ORDER BY created_at DESC) FILTER (WHERE kind IN ('save', 'unsave')))[1] = 'save' AS saved,
                count(*) FILTER (WHERE kind = 'visit') - count(*) FILTER (WHERE kind = 'unvisit') AS visits
         FROM user_shop_events WHERE shop_id = $1 GROUP BY user_id
       )
       SELECT count(*) FILTER (WHERE saved)::int AS saves, count(*) FILTER (WHERE visits > 0)::int AS visitors FROM per`,
      [shopId],
    );
    const ratings = await this.db.pool.query<{ rating: number; n: number }>(
      'SELECT rating, count(*)::int AS n FROM shop_reviews WHERE shop_id = $1 AND NOT hidden GROUP BY rating',
      [shopId],
    );
    const histogram = [1, 2, 3, 4, 5].map((k) => ratings.rows.find((x) => x.rating === k)?.n ?? 0);
    const count = histogram.reduce((a, n) => a + n, 0);
    const sum = histogram.reduce((a, n, i) => a + n * (i + 1), 0);
    const average = count ? Math.round((sum / count) * 10) / 10 : undefined;

    const blogScore = s.blog_score == null ? undefined : Number(s.blog_score);
    const blogWeight = blogScore == null ? 0 : Math.min(Number(s.posts), BLOG_WEIGHT_MAX);
    const combined =
      count + blogWeight > 0
        ? {
            score: Math.round(((sum + (blogScore ?? 0) * blogWeight) / (count + blogWeight)) * 10) / 10,
            basis: [count ? `ROUTE 01 후기 ${count}개` : '', blogWeight ? `블로그 글 ${s.posts}건` : ''].filter(Boolean).join(' + '),
          }
        : undefined;

    const posts = await this.db.pool.query<{ title: string; url: string; posted_on: string | null; source: string }>(
      `SELECT title, url, to_char(posted_on, 'YYYY-MM-DD') AS posted_on, source FROM shop_facts
       WHERE shop_id = $1 AND kind IN ('blog_post', 'cafe_post', 'video', 'web_page') AND url IS NOT NULL
       ORDER BY posted_on DESC NULLS LAST LIMIT 5`,
      [shopId],
    );
    const mine = viewer
      ? (await this.db.pool.query<ReviewRow>(`${REVIEW_SQL} WHERE r.shop_id = $1 AND r.user_id = $2`, [shopId, viewer])).rows[0]
      : undefined;

    const en = await inLang(this.db.pool, [s.summary, s.reason_material]);
    return {
      id: s.id, name: cleanName(s.name), kind: s.kind, category: s.category, status: s.status, lat: s.lat, lng: s.lng,
      roadAddress: s.road_address ?? undefined, phone: s.phone ?? undefined, placeUrl: s.place_url ?? undefined, inMarket: s.in_market,
      summary: s.summary ? (en.get(s.summary) ?? s.summary) : undefined,
      reason: s.reason_material ? (en.get(s.reason_material) ?? s.reason_material) : undefined, priceRange: s.price_range ?? undefined, items: s.items,
      styles: s.styles, littleKnown: Number(s.posts) === 0,
      saves: people.rows[0].saves, visitors: people.rows[0].visitors,
      rating: { average, count, histogram },
      blog: { score: blogScore, posts: Number(s.posts), pros: s.pros, cons: s.cons },
      combined,
      posts: posts.rows.map<SourcePost>((p) => ({
        title: p.title, url: p.url, postedOn: p.posted_on ?? undefined, source: SOURCE_LABEL[p.source] ?? p.source,
      })),
      myReview: mine ? toReview(mine, viewer) : undefined,
    };
  }

  /** Newest first, a page at a time. The viewer's own review is in the detail (myReview), not repeated here. */
  async reviews(shopId: string, viewer: string | null, offset: number): Promise<Review[]> {
    if (!/^\d+$/.test(shopId)) return [];
    const r = await this.db.pool.query<ReviewRow>(
      `${REVIEW_SQL} WHERE r.shop_id = $1 AND NOT r.hidden AND r.user_id IS DISTINCT FROM $2::uuid
       ORDER BY r.created_at DESC OFFSET $3 LIMIT $4`,
      [shopId, viewer, Math.max(0, offset), REVIEW_PAGE],
    );
    return r.rows.map((x) => toReview(x, viewer));
  }

  async save(shopId: string, userId: string, rating: number, body: string | undefined): Promise<Review> {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new BadRequestException('별점은 1~5개로 골라 주세요');
    const text = body?.trim() || null;
    if (text && text.length > 1000) throw new BadRequestException('후기는 1,000자 안으로 써 주세요');
    await this.db.pool
      .query(
        `INSERT INTO shop_reviews (shop_id, user_id, rating, body) VALUES ($1, $2, $3, $4)
         ON CONFLICT (shop_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, body = EXCLUDED.body, updated_at = now()`,
        [shopId, userId, rating, text],
      )
      .catch((e: { code?: string }) => {
        if (e.code === '23503') throw new BadRequestException('가게를 찾지 못했어요');
        throw e;
      });
    const r = await this.db.pool.query<ReviewRow>(`${REVIEW_SQL} WHERE r.shop_id = $1 AND r.user_id = $2`, [shopId, userId]);
    return toReview(r.rows[0], userId);
  }

  async remove(shopId: string, userId: string): Promise<boolean> {
    const r = await this.db.pool.query('DELETE FROM shop_reviews WHERE shop_id = $1 AND user_id = $2', [shopId, userId]);
    return (r.rowCount ?? 0) > 0;
  }
}
