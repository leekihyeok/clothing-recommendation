import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../infra/db.service';
import { RedisService } from '../infra/redis.service';
import { cleanName } from './names';
import { DISPLAY_NAME_SQL } from './shops.resolver';

export interface ShopPhoto {
  /** Daum-hosted thumbnail (the search API's own copy, meant for showing results). */
  url: string;
  /** The post or page the picture is from: every photo links back to it. */
  sourceUrl: string;
  source: string;
  /** From a post our pipeline already matched to this shop (step ④ evidence), not only a name match. */
  matched: boolean;
}

const API = 'https://dapi.kakao.com/v2/search';
const CACHE_DAYS = 7;
const MAX_PHOTOS = 8;

interface PostDoc { title: string; contents: string; url: string; thumbnail?: string; blogname?: string; cafename?: string }
interface ImageDoc { thumbnail_url: string; doc_url: string; display_sitename: string; width: number; height: number }

/** "blog.naver.com/x/1?y" and "m.blog.naver.com/x/1" are the same post. */
const normUrl = (u: string) => u.replace(/^https?:\/\//, '').replace(/^(m|www)\./, '').replace(/[?#].*$/, '').replace(/\/$/, '');
/** Compare names without spaces, case or the markup the search puts around hits. */
const flat = (t: string) => t.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, '').toLowerCase();

/**
 * Shop photos for the detail page from the official Kakao (Daum) search APIs. Kakao Map's place photos have no public
 * API. Only pictures that are about this shop are kept: thumbnails of blog/café posts that name the shop (and, for a
 * very short name, its neighbourhood too), and image-search pictures from posts the pipeline already matched to it.
 * A plain image search for "금나라" brings charts and maps, so unmatched image hits are never shown. Cached a week.
 */
@Injectable()
export class ShopPhotosService {
  private readonly log = new Logger(ShopPhotosService.name);

  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async photos(shopId: string): Promise<ShopPhoto[]> {
    const key = this.config.get<string>('KAKAO_REST_API_KEY');
    if (!key || !/^\d+$/.test(shopId)) return [];
    const cacheKey = `shop-photos:v3:${shopId}`;
    const cached = await this.cacheGet(cacheKey);
    if (cached) return cached;

    const s = (await this.db.pool.query<{ name: string; address: string | null }>(
      `SELECT ${DISPLAY_NAME_SQL} AS name, coalesce(s.address, s.road_address) AS address FROM shops s WHERE s.id = $1`,
      [shopId],
    )).rows[0];
    if (!s) return [];
    const posts = new Set(
      (await this.db.pool.query<{ url: string }>('SELECT url FROM shop_facts WHERE shop_id = $1 AND url IS NOT NULL', [shopId])).rows.map((r) =>
        normUrl(r.url),
      ),
    );
    const name = cleanName(s.name);
    const tokens = s.address?.split(/\s+/) ?? [];
    const dong = tokens.slice(2, 4).find((t) => /[동가]$/.test(t) && !/^\d/.test(t))?.replace(/\d+[가동]$/, '동');
    const gu = tokens.find((t) => /구$/.test(t));
    const area = dong ?? gu;
    // The name without a trailing branch word ("성수점") must appear in the post; a short name needs the area as well.
    const nameKey = flat(name.replace(/\s+\S+점$/, ''));
    const needsArea = nameKey.length <= 3;
    const about = (d: PostDoc) => {
      const text = flat(`${d.title} ${d.contents}`);
      return nameKey.length >= 2 && text.includes(nameKey) && (!needsArea || !area || text.includes(flat(area).replace(/동$/, '')));
    };

    const query = area ? `${name} ${area}` : name;
    const [blog, cafe, images] = await Promise.all([
      this.search<PostDoc>(key, 'blog', query),
      this.search<PostDoc>(key, 'cafe', query),
      posts.size ? this.search<ImageDoc>(key, 'image', name) : Promise.resolve([] as ImageDoc[]),
    ]);
    if (blog === null && cafe === null) return []; // the API itself failed: try again next time

    const seen = new Set<string>();
    const out: ShopPhoto[] = [];
    const add = (p: ShopPhoto) => {
      if (!p.url || seen.has(p.url) || seen.has(normUrl(p.sourceUrl))) return;
      seen.add(p.url);
      seen.add(normUrl(p.sourceUrl)); // one picture per post: a strip of different posts
      out.push(p);
    };
    // Posts the pipeline matched first, then image-search pictures from those posts, then posts that name the shop.
    const postDocs = [...(blog ?? []).map((d) => ({ ...d, kind: '블로그' })), ...(cafe ?? []).map((d) => ({ ...d, kind: '카페' }))].filter((d) => d.thumbnail);
    for (const d of postDocs.filter((x) => posts.has(normUrl(x.url)))) {
      add({ url: d.thumbnail!, sourceUrl: d.url, source: d.blogname || d.cafename || d.kind, matched: true });
    }
    for (const d of images ?? []) {
      if (posts.has(normUrl(d.doc_url)) && d.width >= 300 && d.height >= 200) {
        add({ url: d.thumbnail_url, sourceUrl: d.doc_url, source: d.display_sitename || '웹', matched: true });
      }
    }
    for (const d of postDocs.filter((x) => !posts.has(normUrl(x.url)) && about(x))) {
      add({ url: d.thumbnail!, sourceUrl: d.url, source: d.blogname || d.cafename || d.kind, matched: false });
    }
    const result = out.slice(0, MAX_PHOTOS);
    await this.cacheSet(cacheKey, result);
    return result;
  }

  /** One Kakao search (blog | cafe | image); null when the API itself failed (nothing is cached then). */
  private async search<T>(key: string, kind: 'blog' | 'cafe' | 'image', query: string): Promise<T[] | null> {
    try {
      const params = new URLSearchParams({ query, size: kind === 'image' ? '40' : '30', sort: 'accuracy' });
      const res = await fetch(`${API}/${kind}?${params}`, { headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        this.log.warn(`${kind} search ${res.status}`);
        return null;
      }
      return ((await res.json()) as { documents: T[] }).documents;
    } catch (e) {
      this.log.warn(`${kind} search failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  private async cacheGet(key: string): Promise<ShopPhoto[] | null> {
    try {
      if (this.redis.client.status === 'wait') await this.redis.client.connect();
      const v = await this.redis.client.get(key);
      return v ? (JSON.parse(v) as ShopPhoto[]) : null;
    } catch {
      return null;
    }
  }

  private async cacheSet(key: string, v: ShopPhoto[]): Promise<void> {
    try {
      await this.redis.client.set(key, JSON.stringify(v), 'EX', CACHE_DAYS * 86400);
    } catch {
      // no cache
    }
  }
}
