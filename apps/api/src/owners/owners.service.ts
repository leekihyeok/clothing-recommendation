import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../infra/db.service';
import { PRIVATE_DIR, UPLOAD_DIR } from '../me/profile.service';
import { mediaUrl } from '../shops/detail.service';
import { cleanName } from '../shops/names';
import { DISPLAY_NAME_SQL } from '../shops/shops.resolver';

export interface HoursDay {
  closed: boolean;
  open?: string;
  close?: string;
}

const NTS_URL = 'https://api.odcloud.kr/api/nts-businessman/v1/status';
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 1_500_000; // the page sends ~1200 px JPEGs
// 사업자등록증: a ~1600 px JPEG so the small print stays readable.
const MAX_DOC_BYTES = 3_000_000;
const CLAIM_DOCS = 'claims';
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'];

/** Korean business registration numbers end in a check digit; a typo almost always fails it. */
export function validBusinessNo(no: string): boolean {
  if (!/^\d{10}$/.test(no)) return false;
  const d = [...no].map(Number);
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = w.reduce((a, k, i) => a + d[i] * k, 0);
  sum += Math.floor((d[8] * 5) / 10);
  return (10 - (sum % 10)) % 10 === d[9];
}

/** Now in Seoul: weekday 0 = Monday and minutes since midnight. */
export function seoulNow(): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  return { day, minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * Open at a given time? Closing past midnight ("02:00") counts into the next day. null when the hours don't say.
 * Exported for course planning (stage G).
 */
export function openAt(hours: HoursDay[] | null, day: number, minutes: number): boolean | null {
  if (!hours || hours.length !== 7) return null;
  const today = hours[day];
  const yesterday = hours[(day + 6) % 7];
  if (yesterday && !yesterday.closed && yesterday.open && yesterday.close && toMin(yesterday.close) <= toMin(yesterday.open) && minutes < toMin(yesterday.close)) {
    return true;
  }
  if (!today || today.closed || !today.open || !today.close) return today?.closed ? false : null;
  const o = toMin(today.open);
  const c = toMin(today.close);
  return c > o ? minutes >= o && minutes < c : minutes >= o;
}

/** Shop owners: claims (with the tax service check), admin review, and the info owners keep. */
@Injectable()
export class OwnersService {
  private readonly log = new Logger(OwnersService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  /** National Tax Service status for a business number, or null without DATA_GO_KR_SERVICE_KEY / on failure. */
  private async nts(no: string): Promise<{ b_stt?: string; b_stt_cd?: string; tax_type?: string } | null> {
    const key = this.config.get<string>('DATA_GO_KR_SERVICE_KEY');
    if (!key) return null;
    try {
      const res = await fetch(`${NTS_URL}?serviceKey=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ b_no: [no] }),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) {
        this.log.warn(`NTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return null;
      }
      return ((await res.json()) as { data?: { b_stt?: string; b_stt_cd?: string; tax_type?: string }[] }).data?.[0] ?? null;
    } catch (e) {
      this.log.warn(`NTS request failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  async claim(userId: string, shopId: string, input: { businessNo: string; ownerName: string; contact: string; message?: string; documentBase64?: string }) {
    const no = input.businessNo.replace(/\D/g, '');
    // The business registration certificate: the admin compares its name, owner and number with the claim (the tax
    // service's status API isn't available to us). JPEG only, kept privately, deleted once the claim is decided.
    const doc = input.documentBase64 ? Buffer.from(input.documentBase64, 'base64') : null;
    if (!doc?.length) throw new BadRequestException('사업자등록증 사진을 올려 주세요');
    if (doc.length > MAX_DOC_BYTES) throw new BadRequestException('사진이 너무 커요. 다른 사진을 골라 주세요');
    if (!(doc[0] === 0xff && doc[1] === 0xd8 && doc[2] === 0xff)) throw new BadRequestException('JPG 사진만 올릴 수 있어요');
    if (!validBusinessNo(no)) throw new BadRequestException('사업자등록번호 10자리를 확인해 주세요');
    const name = input.ownerName.trim();
    const contact = input.contact.trim();
    if (name.length < 2 || name.length > 30) throw new BadRequestException('대표자 이름을 적어 주세요');
    if (contact.length < 6 || contact.length > 50) throw new BadRequestException('연락받을 전화번호나 이메일을 적어 주세요');
    const owned = await this.db.pool.query('SELECT 1 FROM shop_owners WHERE shop_id = $1 AND user_id = $2', [shopId, userId]);
    if (owned.rowCount) throw new BadRequestException('이미 이 가게의 사장님으로 등록돼 있어요');
    const nts = await this.nts(no);
    // With the tax service on: an unregistered or closed business is refused right away (the admin never sees it).
    if (nts && (!nts.b_stt_cd || nts.b_stt_cd === '03')) {
      throw new BadRequestException(nts.b_stt_cd === '03' ? '국세청에 폐업으로 나오는 사업자등록번호예요' : '국세청에 등록되지 않은 사업자등록번호예요');
    }
    const r = await this.db.pool
      .query<{ id: string }>(
        `INSERT INTO shop_owner_claims (shop_id, user_id, business_no, owner_name, contact, message, nts)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
        [shopId, userId, no, name, contact, input.message?.trim().slice(0, 500) || null, nts ? JSON.stringify(nts) : null],
      )
      .catch((e: { code?: string }) => {
        if (e.code === '23505') throw new BadRequestException('이미 신청해서 확인을 기다리는 중이에요');
        if (e.code === '23503') throw new BadRequestException('가게를 찾지 못했어요');
        throw e;
      });
    const id = r.rows[0].id;
    const rel = `${CLAIM_DOCS}/${id}.jpg`;
    await mkdir(join(PRIVATE_DIR, CLAIM_DOCS), { recursive: true });
    await writeFile(join(PRIVATE_DIR, rel), doc);
    await this.db.pool.query('UPDATE shop_owner_claims SET doc_path = $2 WHERE id = $1', [id, rel]);
    return { id, status: 'pending', checked: !!nts };
  }

  async myClaims(userId: string) {
    const r = await this.db.pool.query(
      `SELECT c.id::text, c.status, c.review_note, c.created_at, s.id::text AS shop_id, ${DISPLAY_NAME_SQL} AS shop_name
       FROM shop_owner_claims c JOIN shops s ON s.id = c.shop_id WHERE c.user_id = $1 ORDER BY c.created_at DESC LIMIT 20`,
      [userId],
    );
    return r.rows.map((x) => ({
      id: x.id, status: x.status, reviewNote: x.review_note ?? undefined, createdAt: x.created_at, shopId: x.shop_id, shopName: cleanName(x.shop_name),
    }));
  }

  async ownedShops(userId: string) {
    const r = await this.db.pool.query(
      `SELECT s.id::text AS shop_id, ${DISPLAY_NAME_SQL} AS shop_name FROM shop_owners o JOIN shops s ON s.id = o.shop_id
       WHERE o.user_id = $1 ORDER BY o.approved_at`,
      [userId],
    );
    return r.rows.map((x) => ({ shopId: x.shop_id, shopName: cleanName(x.shop_name) }));
  }

  async isOwner(userId: string, shopId: string): Promise<boolean> {
    const r = await this.db.pool.query('SELECT 1 FROM shop_owners WHERE shop_id = $1 AND user_id = $2', [shopId, userId]);
    return (r.rowCount ?? 0) > 0;
  }

  private async requireOwner(userId: string, shopId: string) {
    if (!(await this.isOwner(userId, shopId))) throw new ForbiddenException('이 가게의 사장님만 고칠 수 있어요');
  }

  /** Owner info for the shop page: hours (and whether it's open now in Seoul), intro, links, photos. */
  async info(shopId: string) {
    const r = await this.db.pool.query(
      `SELECT hours, hours_note, intro, instagram, phone, website, photos, updated_at FROM shop_owner_info WHERE shop_id = $1`,
      [shopId],
    );
    const i = r.rows[0];
    if (!i) return null;
    const hours = i.hours as HoursDay[] | null;
    const now = seoulNow();
    return {
      hours: hours ?? undefined,
      hoursNote: i.hours_note ?? undefined,
      intro: i.intro ?? undefined,
      instagram: i.instagram ?? undefined,
      phone: i.phone ?? undefined,
      website: i.website ?? undefined,
      photos: (i.photos as string[]).map((p) => mediaUrl(p)!),
      updatedAt: i.updated_at as Date,
      openNow: openAt(hours, now.day, now.minutes) ?? undefined,
      today: now.day,
    };
  }

  async updateInfo(userId: string, shopId: string, input: { hours?: HoursDay[]; hoursNote?: string; intro?: string; instagram?: string; phone?: string; website?: string }) {
    await this.requireOwner(userId, shopId);
    let hours: HoursDay[] | null = null;
    if (input.hours) {
      if (input.hours.length !== 7) throw new BadRequestException('요일 7개의 영업시간을 모두 정해 주세요');
      hours = input.hours.map((h, i) => {
        if (h.closed) return { closed: true };
        if (!h.open || !h.close || !TIME.test(h.open) || !TIME.test(h.close)) {
          throw new BadRequestException(`${DAY_NAMES[i]}요일 여는 시간과 닫는 시간을 00:00 형식으로 적어 주세요`);
        }
        return { closed: false, open: h.open, close: h.close };
      });
    }
    const insta = input.instagram?.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/$/, '') || null;
    if (insta && !/^[A-Za-z0-9._]{1,30}$/.test(insta)) throw new BadRequestException('인스타그램 아이디를 확인해 주세요');
    const website = webUrl(input.website);
    await this.db.pool.query(
      `INSERT INTO shop_owner_info (shop_id, hours, hours_note, intro, instagram, phone, website, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (shop_id) DO UPDATE SET hours = EXCLUDED.hours, hours_note = EXCLUDED.hours_note, intro = EXCLUDED.intro,
         instagram = EXCLUDED.instagram, phone = EXCLUDED.phone, website = EXCLUDED.website, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [shopId, hours ? JSON.stringify(hours) : null, input.hoursNote?.trim().slice(0, 100) || null, input.intro?.trim().slice(0, 1000) || null, insta,
        input.phone?.trim().slice(0, 30) || null, website, userId],
    );
    return true;
  }

  async addPhoto(userId: string, shopId: string, base64: string): Promise<string[]> {
    await this.requireOwner(userId, shopId);
    const buf = Buffer.from(base64, 'base64');
    if (!buf.length || buf.length > MAX_PHOTO_BYTES) throw new BadRequestException('사진이 너무 커요');
    if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) throw new BadRequestException('JPG 사진만 올릴 수 있어요');
    const cur = await this.db.pool.query<{ photos: string[] }>('SELECT photos FROM shop_owner_info WHERE shop_id = $1', [shopId]);
    if ((cur.rows[0]?.photos.length ?? 0) >= MAX_PHOTOS) throw new BadRequestException(`사진은 ${MAX_PHOTOS}장까지예요`);
    await mkdir(join(UPLOAD_DIR, 'shops', shopId), { recursive: true });
    const rel = `shops/${shopId}/${Date.now()}.jpg`;
    await writeFile(join(UPLOAD_DIR, rel), buf);
    const r = await this.db.pool.query<{ photos: string[] }>(
      `INSERT INTO shop_owner_info (shop_id, photos, updated_by) VALUES ($1, ARRAY[$2], $3)
       ON CONFLICT (shop_id) DO UPDATE SET photos = shop_owner_info.photos || $2, updated_by = $3, updated_at = now()
       RETURNING photos`,
      [shopId, rel, userId],
    );
    return r.rows[0].photos.map((p) => mediaUrl(p)!);
  }

  async removePhoto(userId: string, shopId: string, url: string): Promise<string[]> {
    await this.requireOwner(userId, shopId);
    const rel = url.replace(/^\/media\//, '');
    // Only a photo this shop actually has is removed, and its file only if it resolves inside the shop's own folder
    // (a crafted "shops/<id>/../../.env" must not delete anything).
    const r = await this.db.pool.query<{ photos: string[]; had: boolean }>(
      `UPDATE shop_owner_info SET photos = array_remove(photos, $2), updated_at = now()
        WHERE shop_id = $1 AND $2 = ANY(photos) RETURNING photos, true AS had`,
      [shopId, rel],
    );
    const dir = resolve(UPLOAD_DIR, 'shops', shopId) + sep;
    const file = resolve(UPLOAD_DIR, rel);
    if (r.rows[0]?.had && file.startsWith(dir)) await unlink(file).catch(() => undefined);
    const left = r.rows[0]?.photos
      ?? (await this.db.pool.query<{ photos: string[] }>('SELECT photos FROM shop_owner_info WHERE shop_id = $1', [shopId])).rows[0]?.photos
      ?? [];
    return left.map((p) => mediaUrl(p)!);
  }

  // ---------- admin ----------

  /** The claim's 사업자등록증 as a data URL, for the admin page only (the file isn't served anywhere). */
  async claimDocument(claimId: string): Promise<string | null> {
    const r = await this.db.pool.query<{ doc_path: string | null }>('SELECT doc_path FROM shop_owner_claims WHERE id = $1', [claimId]);
    const rel = r.rows[0]?.doc_path;
    if (!rel) return null;
    const buf = await readFile(join(PRIVATE_DIR, rel)).catch(() => null);
    return buf ? `data:image/jpeg;base64,${buf.toString('base64')}` : null;
  }

  /** Once a claim is decided its certificate photo is gone (file and path). */
  async removeDocument(claimId: string): Promise<void> {
    const r = await this.db.pool.query<{ doc_path: string | null }>(
      `UPDATE shop_owner_claims SET doc_path = NULL, doc_removed_at = now() WHERE id = $1 AND doc_path IS NOT NULL
       RETURNING (SELECT doc_path FROM shop_owner_claims WHERE id = $1)`,
      [claimId],
    );
    const rel = r.rows[0]?.doc_path;
    if (rel) await unlink(join(PRIVATE_DIR, rel)).catch(() => undefined);
  }

  async claims(status: string) {
    const r = await this.db.pool.query(
      `SELECT c.id::text, c.status, c.business_no, c.owner_name, c.contact, c.message, c.nts, c.created_at, c.review_note, c.doc_path IS NOT NULL AS has_doc,
              s.id::text AS shop_id, ${DISPLAY_NAME_SQL} AS shop_name, s.road_address, coalesce(u.nickname, '') AS nickname
       FROM shop_owner_claims c JOIN shops s ON s.id = c.shop_id JOIN users u ON u.id = c.user_id
       WHERE c.status = $1 ORDER BY c.created_at LIMIT 100`,
      [status],
    );
    return r.rows.map((x) => ({
      id: x.id, status: x.status, businessNo: x.business_no, ownerName: x.owner_name, contact: x.contact, message: x.message ?? undefined,
      nts: x.nts ? `${x.nts.b_stt || '미등록'}${x.nts.tax_type ? ` · ${x.nts.tax_type}` : ''}` : '국세청 조회 안 씀 · 사업자등록증으로 확인',
      hasDocument: x.has_doc,
      createdAt: x.created_at, reviewNote: x.review_note ?? undefined, shopId: x.shop_id, shopName: cleanName(x.shop_name),
      roadAddress: x.road_address ?? undefined, nickname: x.nickname,
    }));
  }

  async review(adminId: string, claimId: string, approve: boolean, note: string | undefined) {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const c = await client.query<{ shop_id: string; user_id: string }>(
        `UPDATE shop_owner_claims SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now()
         WHERE id = $1 AND status = 'pending' RETURNING shop_id, user_id`,
        [claimId, approve ? 'approved' : 'rejected', note?.trim() || null, adminId],
      );
      if (!c.rows[0]) throw new BadRequestException('이미 처리했거나 없는 신청이에요');
      if (approve) {
        await client.query(
          'INSERT INTO shop_owners (shop_id, user_id, claim_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [c.rows[0].shop_id, c.rows[0].user_id, claimId],
        );
      }
      await client.query('COMMIT');
      await this.removeDocument(claimId);
      return true;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

/** "www.shop.com" → "https://www.shop.com". Only http(s) links with a real host; anything else is refused. */
function webUrl(raw?: string): string | null {
  const t = raw?.trim();
  if (!t) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    throw new BadRequestException('웹사이트 주소를 확인해 주세요 (예: https://myshop.com)');
  }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.') || u.href.length > 300) {
    throw new BadRequestException('웹사이트 주소를 확인해 주세요 (예: https://myshop.com)');
  }
  return u.href;
}
