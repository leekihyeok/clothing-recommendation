import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../infra/db.service';
import { mediaUrl } from '../shops/detail.service';
import { cleanName } from '../shops/names';
import { DISPLAY_NAME_SQL } from '../shops/shops.resolver';

/** Where uploaded files live; main.ts serves this folder at /media. */
export const UPLOAD_DIR = resolve(process.cwd(), process.env.UPLOAD_DIR ?? '../../data/uploads');
// Files nobody but the admin sees (사업자등록증 photos of owner claims): not under UPLOAD_DIR, which /media serves.
export const PRIVATE_DIR = resolve(process.cwd(), process.env.PRIVATE_DIR ?? '../../data/private');

const MAX_AVATAR_BYTES = 400_000; // the page sends a 256 px JPEG, ~20-40 KB
const NICKNAME_MIN = 2;
const NICKNAME_MAX = 20;

/** First bytes of the image types we accept, so a renamed file of another kind is refused. */
function imageKind(buf: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/** My page: profile (nickname, photo), counts, my reviews, leaving. */
@Injectable()
export class ProfileService {
  private readonly log = new Logger(ProfileService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  async profile(userId: string) {
    const r = await this.db.pool.query(
      `SELECT u.nickname, u.avatar_path, u.created_at,
              (SELECT count(*)::int FROM saved_courses WHERE user_id = u.id) AS saved_courses,
              (SELECT count(*)::int FROM shop_reviews WHERE user_id = u.id) AS reviews
       FROM users u WHERE u.id = $1`,
      [userId],
    );
    const u = r.rows[0];
    if (!u) throw new BadRequestException('계정을 찾지 못했어요');
    return {
      nickname: (u.nickname as string | null) ?? '이름 없음',
      avatarUrl: mediaUrl(u.avatar_path),
      joinedAt: u.created_at as Date,
      savedCourses: u.saved_courses as number,
      reviews: u.reviews as number,
    };
  }

  async setNickname(userId: string, nickname: string): Promise<string> {
    const name = nickname.replace(/\s+/g, ' ').trim();
    if (name.length < NICKNAME_MIN || name.length > NICKNAME_MAX) {
      throw new BadRequestException(`닉네임은 ${NICKNAME_MIN}~${NICKNAME_MAX}자로 정해 주세요`);
    }
    await this.db.pool.query('UPDATE users SET nickname = $2, nickname_custom = true WHERE id = $1', [userId, name]);
    return name;
  }

  /** A small square photo the page already resized; stored as a file, the old one removed. */
  async setAvatar(userId: string, base64: string): Promise<string> {
    const buf = Buffer.from(base64, 'base64');
    if (!buf.length || buf.length > MAX_AVATAR_BYTES) throw new BadRequestException('사진이 너무 커요. 다른 사진을 골라 주세요');
    const ext = imageKind(buf);
    if (!ext) throw new BadRequestException('JPG, PNG, WEBP 사진만 올릴 수 있어요');
    const dir = join(UPLOAD_DIR, 'avatars');
    await mkdir(dir, { recursive: true });
    const rel = `avatars/${userId}-${Date.now()}.${ext}`;
    await writeFile(join(UPLOAD_DIR, rel), buf);
    const old = await this.swapAvatar(userId, rel);
    if (old) await unlink(join(UPLOAD_DIR, old)).catch(() => undefined);
    return mediaUrl(rel)!;
  }

  async removeAvatar(userId: string): Promise<boolean> {
    const old = await this.swapAvatar(userId, null);
    if (old) await unlink(join(UPLOAD_DIR, old)).catch(() => undefined);
    return true;
  }

  private async swapAvatar(userId: string, path: string | null): Promise<string | null> {
    const r = await this.db.pool.query<{ old: string | null }>(
      `UPDATE users u SET avatar_path = $2 FROM (SELECT avatar_path AS old FROM users WHERE id = $1) o WHERE u.id = $1 RETURNING o.old`,
      [userId, path],
    );
    return r.rows[0]?.old ?? null;
  }

  async myReviews(userId: string) {
    const r = await this.db.pool.query(
      `SELECT r.id::text, r.rating, r.body, r.updated_at, s.id::text AS shop_id, ${DISPLAY_NAME_SQL} AS shop_name, s.category
       FROM shop_reviews r JOIN shops s ON s.id = r.shop_id WHERE r.user_id = $1 ORDER BY r.updated_at DESC LIMIT 100`,
      [userId],
    );
    return r.rows.map((x) => ({
      id: x.id, rating: x.rating, body: x.body ?? undefined, updatedAt: x.updated_at,
      shopId: x.shop_id, shopName: cleanName(x.shop_name), category: x.category,
    }));
  }

  /**
   * 회원 탈퇴: the account and everything tied to it (saves, visits, reviews, saved courses, sessions, photo). Courses
   * stay without an owner (they may be shared links others use). With KAKAO_ADMIN_KEY set, the app is also
   * disconnected from the person's Kakao account; without it they can do that in their Kakao settings.
   */
  async deleteAccount(userId: string): Promise<{ kakaoUnlinked: boolean }> {
    const u = (await this.db.pool.query<{ kakao_id: string | null; avatar_path: string | null }>(
      'SELECT kakao_id::text, avatar_path FROM users WHERE id = $1', [userId],
    )).rows[0];
    if (!u) return { kakaoUnlinked: false };
    let kakaoUnlinked = false;
    const adminKey = this.config.get<string>('KAKAO_ADMIN_KEY');
    if (u.kakao_id && adminKey) {
      const res = await fetch('https://kapi.kakao.com/v1/user/unlink', {
        method: 'POST',
        headers: { Authorization: `KakaoAK ${adminKey}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ target_id_type: 'user_id', target_id: u.kakao_id }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);
      kakaoUnlinked = !!res?.ok;
      if (!kakaoUnlinked) this.log.warn(`kakao unlink failed for user ${userId}: ${res?.status ?? 'network'}`);
    }
    // Their claims' certificate photos go with the account (the rows cascade, the files wouldn't).
    const docs = await this.db.pool.query<{ doc_path: string }>('SELECT doc_path FROM shop_owner_claims WHERE user_id = $1 AND doc_path IS NOT NULL', [userId]);
    await this.db.pool.query('DELETE FROM users WHERE id = $1', [userId]); // cascades; courses.user_id → null
    for (const d of docs.rows) await unlink(join(PRIVATE_DIR, d.doc_path)).catch(() => undefined);
    if (u.avatar_path) await unlink(join(UPLOAD_DIR, u.avatar_path)).catch(() => undefined);
    return { kakaoUnlinked };
  }
}
