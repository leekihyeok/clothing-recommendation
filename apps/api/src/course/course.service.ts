import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULTS, ITEMS, STYLES, STYLE_IDS } from '@cr/shared';
import { DbService } from '../infra/db.service';
import { ModelClient } from '../infra/model.client';
import { TransitService } from '../infra/transit.service';
import { WalkService } from '../infra/walk.service';
import { type CourseWeatherInfo, WeatherService } from '../infra/weather.service';
import { MeService, type Personal } from '../me/me.service';
import { CATEGORY_PRIOR, MIN_SIGNALS, tasteFit, tasteSummary } from '../me/taste';
import type { HoursDay } from '../owners/owners.service';
import { cleanName } from '../shops/names';
import { searchShops } from '../shops/search';
import { newsTags } from '../owners/news';
import { lang } from '../infra/lang';
import { inLang } from '../infra/translations';
import { noteEn, reasonEn, tasteNoteEn, VARIANT_LABEL_EN, weatherEn } from './localize';
import { BrandRef, brandsByKey } from '../shops/brands';
import { DISPLAY_NAME_SQL } from '../shops/shops.resolver';
import { BrandRegion, BreakStop, Course, CourseEditInput, CourseEditResult, CourseLink, CourseRequestInput, CourseStop, CourseVariant, CourseWeather, EndInput, Leg, PinnedShop } from './course.model';
import { type Clock, clockAt, closedOnArrival, dayHours, hhmm, MAX_WAIT_MIN, minutesUntil, storedClock, windowFor } from './hours';

const STYLE_LABEL = Object.fromEntries(STYLES.map((s) => [s.id, s.label]));
const ITEM_LABEL = Object.fromEntries(ITEMS.map((i) => [i.id, i.label]));
/** "캐주얼은" / "Y2K는": the topic particle that fits the word's last sound. */
function topic(word: string): string {
  const c = word.charCodeAt(word.length - 1);
  const hangul = c >= 0xac00 && c <= 0xd7a3;
  return `${word}${hangul && (c - 0xac00) % 28 !== 0 ? '은' : '는'}`;
}

// 으로/로 and 을/를 after a name (ㄹ받침 takes 로; Latin or digits: as if no 받침).
function toward(word: string): string {
  const c = word.charCodeAt(word.length - 1);
  const jong = c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0;
  return `${word}${jong && jong !== 8 ? '으로' : '로'}`;
}
function object(word: string): string {
  const c = word.charCodeAt(word.length - 1);
  const jong = c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0;
  return `${word}${jong ? '을' : '를'}`;
}

// Breaks between shops (stage G): a café and/or a place to eat, from Kakao keyword search ("카페" / "맛집" within the
// category) around the spot in the course where the break goes. Kakao has no ratings in its API, so these are its
// best matches nearby, not rated picks; the page says so. Neighbourhood places before the big chains.
export const BREAKS = {
  cafe: {
    code: 'CE7', query: '카페', minutes: 30, label: '카페',
    chain: /스타벅스|투썸|이디야|메가MGC|메가커피|빽다방|컴포즈|할리스|커피빈|폴바셋|파스쿠찌|엔제리너스|탐앤탐스|더벤티|매머드|공차|드롭탑/,
  },
  food: {
    code: 'FD6', query: '맛집', minutes: 50, label: '맛집',
    chain: /맥도날드|버거킹|롯데리아|KFC|맘스터치|김밥천국|이삭토스트|서브웨이|파리바게뜨|뚜레쥬르|본죽|한솥|신전떡볶이|교촌|BBQ|bhc|도미노|피자헛|노브랜드버거/,
  },
} as const;
export type BreakKind = keyof typeof BREAKS;
const BREAK_RADIUS_M = 400;
const BREAK_MIN_RADIUS_M = 200;
// Picking a break: metres of extra walking are the cost; these turn the other wishes into metres too.
const SLOT_PENALTY_M = 60; // per stop away from the preferred spot
const RANK_PENALTY_M = 8; // per place down Kakao's ranking
const CHAIN_PENALTY_M = 150;
const MAX_BREAK_DETOUR_M = 450; // more than this is not "on the way": say none was found instead

interface KakaoPlace { place_name: string; x: string; y: string; road_address_name?: string; address_name?: string; place_url?: string; category_name?: string }

/** Where breaks go: one alone in the middle; both → the meal after the first third, the café after the second. */
function breakSlots(n: number, kinds: BreakKind[]): Partial<Record<BreakKind, number>> {
  const mid = Math.max(1, Math.ceil(n / 2));
  if (kinds.length < 2) return Object.fromEntries(kinds.map((k) => [k, mid]));
  const food = Math.max(1, Math.ceil(n / 3));
  return { food, cafe: Math.min(n, Math.max(food + 1, Math.ceil((2 * n) / 3))) };
}

/** Breaks inserted after their stops: totals grow by each detour walk and the time spent there. */
function withBreaks(v: CourseVariant, breaks: BreakStop[]): CourseVariant {
  let out: CourseVariant = { ...v, breaks: [] };
  // In course order; on the same walk the meal comes before the café.
  for (const br of [...breaks].sort((a, b) => a.afterOrder - b.afterOrder || (a.kind === 'food' ? -1 : 1))) {
    const k = Math.min(Math.max(1, br.afterOrder), v.stops.length);
    const a = v.stops[k - 1].shop;
    const b = v.stops[k]?.shop;
    const detour = Math.round(streetM(a, br) + (b ? streetM(br, b) - streetM(a, b) : 0));
    const walk = detour / WALK_M_PER_MIN;
    out = {
      ...out,
      breaks: [...(out.breaks ?? []), { ...br, afterOrder: k, detourM: detour }],
      totalDistanceM: out.totalDistanceM + detour,
      walkMin: Math.round((out.walkMin + walk) * 10) / 10,
      totalMin: Math.round((out.totalMin + walk + br.minutes) * 10) / 10,
    };
  }
  return out;
}

/** The variant's totals without its breaks (to put them back differently). */
function withoutBreaks(v: CourseVariant): CourseVariant {
  const brs = v.breaks ?? [];
  const detour = brs.reduce((a, b) => a + b.detourM, 0);
  const walk = detour / WALK_M_PER_MIN;
  return {
    ...v,
    breaks: [],
    totalDistanceM: v.totalDistanceM - detour,
    walkMin: Math.round((v.walkMin - walk) * 10) / 10,
    totalMin: Math.round((v.totalMin - walk - brs.reduce((a, b) => a + b.minutes, 0)) * 10) / 10,
  };
}

/**
 * Where a place belongs in the order: after the stop k whose walk to the next stop it adds least to (after the last
 * shop, the walk there). lo / hi limit k, e.g. a café not before the meal.
 */
function slotFor(v: CourseVariant, place: LatLngT, lo = 1, hi = v.stops.length): { k: number; detour: number } {
  let k = lo;
  let detour = Infinity;
  for (let i = lo; i <= Math.min(hi, v.stops.length); i++) {
    const a = v.stops[i - 1].shop;
    const b = v.stops[i]?.shop;
    const d = b ? streetM(a, place) + streetM(place, b) - streetM(a, b) : streetM(a, place);
    if (d < detour) [k, detour] = [i, d];
  }
  return { k, detour };
}

const bestSlot = (v: CourseVariant, place: LatLngT) => slotFor(v, place).k;

/** After an edit the same places stay, each where it now fits best along the new order (meal before café). */
function keepBreaks(v: CourseVariant, breaks: BreakStop[] | undefined): CourseVariant {
  if (!breaks?.length || v.stops.length < 1) return v;
  const placed = breaks.map((b) => ({ ...b, afterOrder: bestSlot(v, b) }));
  const food = placed.find((b) => b.kind === 'food');
  const cafe = placed.find((b) => b.kind === 'cafe');
  // Meal before café: if the café now sits before the meal, it goes where it fits best from the meal on.
  if (food && cafe && cafe.afterOrder < food.afterOrder) cafe.afterOrder = slotFor(v, cafe, food.afterOrder).k;
  return withBreaks(v, placed);
}

const INPUT_MODES = new Set(['buttons', 'here', 'point', 'text', 'photo', 'preset', 'again', 'saved', 'group']);
const VARIANT_LABEL: Record<string, string> = { recommended: '추천', nearby: '가까운 위주', taste: '취향 우선' };
const CATEGORY_LABEL: Record<string, string> = {
  select_shop: '편집숍', vintage: '빈티지·구제 숍', brand: '브랜드 매장', spa: 'SPA 매장', general: '옷가게', complex: '백화점·몰',
};

// Taste learning (me/taste.ts): how much the profile counts, and what novelty is worth.
const TASTE_SHARE_WITH_STYLES = 0.15; // styles chosen: the taste only nudges
const TASTE_SHARE_ALONE = 0.6; // no styles chosen: the taste mostly decides
const RECENT_FACTOR = 0.88; // a shop from the person's own recent courses
const NEW_MATCH_BONUS = 0.04; // a shop that fits the taste and they haven't met yet
const PRICE_MATCH_BONUS = 0.04;
// With no styles chosen, how interesting a shop type is for a shopping walk.
const CATEGORY_APPEAL: Record<string, number> = {
  select_shop: 0.8, vintage: 0.75, brand: 0.6, complex: 0.55, spa: 0.4, general: 0.3,
};

const SEARCH_RADIUS_M = [1200, 2000];
// "지도 가운데서" uses the visible map as the search area; zoomed out further than this, it falls back to the radius.
const MAX_BOUNDS_DEG = 0.12;
// The start station is the one nearest the shops the course will most likely use (the top candidates' centre).
const STATION_NEAR_TOP = 10;
// A brand store known only from the public data (no Kakao listing, no posts): its name claims a brand nobody has
// confirmed ("샤넬", "발렌티노" registered at some address), so it counts this much in a course. Asked for by name, it's in.
const UNVERIFIED_BRAND_FACTOR = 0.5;
const STATION_RADIUS_M = 1200;

interface Box { swLat: number; swLng: number; neLat: number; neLng: number }
const usableBox = (b?: Box | null): Box | undefined =>
  b && b.neLat > b.swLat && b.neLng > b.swLng && b.neLat - b.swLat <= MAX_BOUNDS_DEG && b.neLng - b.swLng <= MAX_BOUNDS_DEG * 1.3 ? b : undefined;
// Bad weather: indoor places (kind complex: 백화점·몰·지하상가) gain this much value, walking costs this many times more.
const INDOOR_BONUS = 0.3;
const BAD_WEATHER_WALK = 2.5;
// …and one of them near the start is always in (within this walk of it) — if it fits the chosen styles this well.
const INDOOR_MAX_M = 1000;
const INDOOR_MIN_FIT = 0.5;
const WEATHER_WHY: Record<string, string> = { rain: '비 소식이 있어서', snow: '눈 소식이 있어서', hot: '더운 날이라', cold: '추운 날이라' };

function courseWeather(w: CourseWeatherInfo, applied: boolean, indoor: boolean): CourseWeather {
  const why = WEATHER_WHY[w.condition];
  const note = !applied || !why
    ? undefined
    : indoor
      ? `${why} 백화점·몰 같은 실내를 한 곳 넣고, 가게 사이 걷는 길이 짧은 쪽으로 짰어요`
      : `${why} 가게 사이 걷는 길이 짧은 쪽으로 짰어요 (고른 스타일에 맞는 실내 가게는 근처에 없어요)`;
  return { condition: w.condition, summary: w.summary, rainChance: w.rainChance, tempC: w.tempC, applied, note };
}

type EndPoint = LatLngT & { name?: string; back?: boolean };
// The client's placeholder names for a point picked on the map; the server looks up a real one.
const GENERIC_PLACE = new Set(['', '고른 곳', '고른 위치', 'Picked spot']);
const PICKED_STATION_M = 350;
/** Where the walk finishes: back at the start, at a chosen place, or (undefined) at the last shop. */
function resolveEnd(e: EndInput | undefined, origin: LatLngT, startName: string | undefined): EndPoint | undefined {
  if (e?.back) return { lat: origin.lat, lng: origin.lng, name: startName ?? '출발점', back: true };
  if (e?.point && Math.abs(e.point.lat - 37.55) < 0.5 && Math.abs(e.point.lng - 126.99) < 0.6) {
    return { lat: e.point.lat, lng: e.point.lng, name: e.label?.trim().slice(0, 30) || '끝나는 곳' };
  }
  return undefined;
}

// Free stop count (the UI has a −/+ stepper and "as many as fit"). The optimiser handles up to 12 in about a second.
export const MIN_STOPS = 2;
// A whole day: 20 stops plan in about 1.5 s (services/model/app/optimize.py narrows its search past 12).
export const MAX_STOPS = 20;
// Time budget when the user picked a stop count but no time: effectively unlimited for a walking day.
const NO_TIME_LIMIT_MIN = 720;
const MAX_CANDIDATES = 50;
// Value kept by a shop the user already saw for these conditions; low enough that unseen shops of similar fit win.
const SEEN_FACTOR = 0.45;
// "다른 코스" keeps about a quarter of the last course (its best-fitting shops and any the user saved), changes the rest.
const KEEP_SHARE = 0.25;
// "남성복 / 여성복": shops for the other side and kids' shops are out; shops nothing tells us about stay, a little lower
// (most small shops have no gender on record — dropping them would empty the map).
const GENDERS = new Set(['men', 'women']);
const GENDER_UNKNOWN_FACTOR = 0.85;
function genderFit(r: { gender: string | null; kind: string }, want: string | undefined): number {
  if (!want || r.kind === 'complex') return 1;
  if (r.gender === want || r.gender === 'unisex') return 1;
  return r.gender == null ? GENDER_UNKNOWN_FACTOR : 0;
}
// …and what isn't kept should really change: shown shops drop further back than on a plain "again".
const SEEN_FACTOR_KEEPING = 0.25;
const MAX_MUST = 8;
// A shop asked for by name but this far from the start is another trip, not a stop on this walk.
const MUST_MAX_M = 3000;
// A shop named in a text edit farther than this from the course gets a note about the longer walk.
const FAR_PICK_M = 1500;
// A replacement should stay in the neighbourhood: more than this extra walk isn't "another shop here".
const MAX_REPLACE_DETOUR_M = 1200;

// Same walking model as services/model/app/optimize.py.
const WALK_M_PER_MIN = 70;
const DETOUR = 1.3;
const dwellMin = (kind: string) => (kind === 'complex' ? 40 : 15);

type LatLngT = { lat: number; lng: number };

/** "폴유" → "폴유를", "빈티지산타 성수점" → "빈티지산타 성수점을": 을/를 by the last syllable's final consonant. */
export function obj(word: string): string {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return `${word}을(를)`; // not Hangul (e.g. "MO-NO-HA"): keep both
  return `${word}${code % 28 ? '을' : '를'}`;
}

const tidy = (r: Row): Row => ({ ...r, name: cleanName(r.name) });

/**
 * One shop per name: two branches of the same shop (발발빈티지 on 연무장길 and 연무장13길) or a double listing shouldn't
 * both land in one course. Keeps the best-valued one, or one already in the course.
 */
function onePerName(shops: Scored[], prefer: Set<string> = new Set()): Scored[] {
  const best = new Map<string, Scored>();
  for (const s of shops) {
    // Drop a trailing branch word only when it is its own word ("주코빈티지 성수점"), never inside a name.
    const key = s.name.replace(/\s+\S*점$/, '').replace(/\s+/g, '').toLowerCase();
    const cur = best.get(key);
    if (!cur || (prefer.has(s.id) && !prefer.has(cur.id)) || (!prefer.has(cur.id) && s.value > cur.value)) best.set(key, s);
  }
  return [...best.values()];
}

/** Letters and digits only, lower case: "Supreme 도산" → "supreme도산". */
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** A brand store whose name starts with the brand ("Supreme도산", "아더에러 성수") is that brand's own store. */
function namedFor(name: string, b: BrandRef): boolean {
  const n = squash(name);
  return [b.name, b.nameEn, b.key].some((x) => !!x && squash(x).length >= 2 && n.startsWith(squash(x)));
}

/** The brand's own store, not a select shop that stocks it. */
const ownStore = (s: { category: string; brand_keys: string[] | null }, key: string) => s.category === 'brand' && !!s.brand_keys?.includes(key);

/**
 * One store per brand: 아더에러 has several stores in 성수 alone, and a course of four of them (or two MLB stores)
 * isn't a walk worth making. The best-valued store of each brand stays (or one already in the course); select shops
 * carrying the brand aren't stores of it and stay too.
 */
function oneStorePerBrand(shops: Scored[], prefer: Set<string> = new Set()): Scored[] {
  const best = new Map<string, Scored>();
  const rest: Scored[] = [];
  for (const s of shops) {
    const key = s.category === 'brand' ? s.brand_keys?.[0] : undefined;
    if (!key) {
      rest.push(s);
      continue;
    }
    const cur = best.get(key);
    if (!cur || (prefer.has(s.id) && !prefer.has(cur.id)) || (!prefer.has(cur.id) && s.value > cur.value)) best.set(key, s);
    else if (prefer.has(s.id)) rest.push(s); // a second store the user asked for by name stays
  }
  return [...rest, ...best.values()];
}

/**
 * Shortest open walk from the origin through all points (order only, the set is fixed). Up to 8 stops every order is
 * tried (8! = 40,320); longer courses start nearest-first and are improved with 2-opt.
 */
export function shortestOrder(origin: LatLngT, pts: (LatLngT & { id: string })[], end?: LatLngT): string[] {
  const n = pts.length;
  if (n <= 1) return pts.map((p) => p.id);
  const d = (a: LatLngT, b: LatLngT) => streetM(a, b);
  // With an end point (a station, back to the start) the walk there counts too.
  const length = (order: number[]) =>
    order.reduce((acc, k, i) => acc + d(i === 0 ? origin : pts[order[i - 1]], pts[k]), 0) + (end ? d(pts[order[order.length - 1]], end) : 0);
  let best: number[];
  if (n <= 8) {
    best = [...Array(n).keys()];
    let bestLen = length(best);
    const perm = [...best];
    const permute = (k: number) => {
      if (k === n) {
        const len = length(perm);
        if (len < bestLen - 1e-6) [best, bestLen] = [[...perm], len];
        return;
      }
      for (let i = k; i < n; i++) {
        [perm[k], perm[i]] = [perm[i], perm[k]];
        permute(k + 1);
        [perm[k], perm[i]] = [perm[i], perm[k]];
      }
    };
    permute(0);
  } else {
    const left = new Set([...Array(n).keys()]);
    best = [];
    let at: LatLngT = origin;
    while (left.size) {
      const next = [...left].reduce((a, b) => (d(at, pts[a]) <= d(at, pts[b]) ? a : b));
      best.push(next);
      left.delete(next);
      at = pts[next];
    }
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < n - 1; i++) {
        for (let j = i + 1; j < n; j++) {
          const cand = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
          if (length(cand) < length(best) - 1e-6) [best, improved] = [cand, true];
        }
      }
    }
  }
  return best.map((k) => pts[k].id);
}

/**
 * A shop is worth walking to only if it's open at some point the course could reach it (owner hours, else blog hours;
 * shops without hours — still most — stay, marked "영업시간 확인 필요" on their card). The optimiser then fits the
 * order to the hours.
 */
function openDuring(r: Row, clock: Clock, budgetMin: number): boolean {
  return windowFor(r.hours, clock, budgetMin) !== 'closed';
}

// Blog hours (pipeline.hours) older than this aren't trusted: shops change their hours.
const BLOG_HOURS_MAX_AGE = "interval '3 years'";

// One candidate row per shop, with its scores, sources and hours (the owner's, else read from a recent blog post).
const CANDIDATE_SELECT = `
      SELECT s.id::text, ${DISPLAY_NAME_SQL} AS name, s.kind, s.category, s.gender, ST_Y(s.geom::geometry) AS lat, ST_X(s.geom::geometry) AS lng,
             s.road_address, s.summary, s.reason_material, s.price_range, s.items, s.confidence, s.matched_posts, s.evidence_at,
             EXISTS (SELECT 1 FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao') AS on_kakao,
             -- a complex's Kakao link would open one store inside it, not the building
             CASE WHEN s.kind = 'complex' THEN NULL
                  ELSE (SELECT r.payload->>'place_url' FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao' LIMIT 1) END AS place_url,
             (SELECT jsonb_object_agg(style_id, score) FROM shop_style_scores x WHERE x.shop_id = s.id) AS scores,
             (SELECT array_agg(DISTINCT r.category_name) FROM raw_sources r WHERE r.shop_id = s.id) AS source_categories,
             COALESCE(oh.hours, CASE WHEN s.hours_posted_on > now() - ${BLOG_HOURS_MAX_AGE} THEN s.hours END) AS hours,
             CASE WHEN oh.hours IS NOT NULL THEN 'owner' WHEN s.hours_posted_on > now() - ${BLOG_HOURS_MAX_AGE} AND s.hours IS NOT NULL THEN 'blog' END AS hours_source,
             (SELECT array_agg(b.brand_key) FROM shop_brands b WHERE b.shop_id = s.id) AS brand_keys
      FROM shops s
      LEFT JOIN LATERAL (SELECT oi.hours FROM shop_owner_info oi WHERE oi.shop_id = s.id) oh ON true
      WHERE s.status = 'candidate' AND s.category IS NOT NULL AND s.category <> 'excluded'`;

/** Shops the user marked 별로였어요 or reported closed never come back; visited ones only when asked to skip them. */
function keep(r: Row, personal: Personal | null, skipVisited: boolean, clock: Clock, budgetMin: number): boolean {
  if (!openDuring(r, clock, budgetMin)) return false;
  if (!personal) return true;
  if (personal.disliked.has(r.id) || personal.closed.has(r.id)) return false;
  return !(skipVisited && personal.visited.has(r.id));
}

function streetM(a: LatLngT, b: LatLngT): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h)) * DETOUR;
}

interface Row {
  id: string;
  name: string;
  kind: string;
  category: string;
  /** men | women | unisex | kids, null = unknown (pipeline.gender) */
  gender: string | null;
  lat: number;
  lng: number;
  road_address: string | null;
  summary: string | null;
  reason_material: string | null;
  price_range: string | null;
  items: string[] | null;
  confidence: number | null;
  matched_posts: number | null;
  evidence_at: Date | null;
  on_kakao: boolean;
  place_url: string | null;
  scores: Record<string, number> | null;
  source_categories: string[] | null;
  /** Weekly hours, Mon..Sun: the owner's (owners/), else read from a recent blog post (pipeline.hours); often null. */
  hours: HoursDay[] | null;
  hours_source: 'owner' | 'blog' | null;
  /** brands the shop carries (pipeline.brands) */
  brand_keys: string[] | null;
}

interface Scored extends Row {
  value: number;
  fit: Record<string, number>;
  /** A stop kept from the stored course (shop left the pool since): its stored reason line. */
  keptReason?: string;
  /** Asked-for brands this shop carries ("아더에러 취급" on its card). */
  brandHit?: string[];
}

interface ModelCourse {
  variant: string;
  stop_ids: string[];
  legs: { distance_m: number; duration_min: number }[];
  end_leg?: { distance_m: number; duration_min: number } | null;
  total_distance_m: number;
  walk_min: number;
  total_min: number;
  note: string | null;
}

/** /edit-intent response (services/model/app/edit_intent.py). */
interface ModelIntent {
  ops: {
    op: string;
    order: number | null;
    to_order: number | null;
    want_category: string | null;
    want_style: string | null;
    want_item: string | null;
    want_budget: string | null;
    prefer: string | null;
    shop_name?: string | null;
  }[];
  reply: string;
}

/** What `courses.request` holds (written by plan()). */
interface StoredRequest {
  styles: string[];
  stopCount: number;
  maxStops: boolean;
  timeBudgetMin: number;
  budget?: string;
  items?: string[];
  regionName?: string;
  origin: LatLngT;
  regionId?: string;
  skipVisited?: boolean;
  bounds?: Box;
  gender?: string;
  /** chosen start ("2026-10-17T14:00", Seoul); none = planned for "now" */
  startAt?: string;
  endBy?: string;
  /** where the walk ends, if not at the last shop */
  end?: LatLngT & { name?: string; back?: boolean };
  /** asked-for brands: keys and names */
  brands?: BrandRef[];
  /** pinned shops ("꼭 넣을 가게", or put in by hand on the course): in again whenever the course is planned anew */
  mustShops?: PinnedShop[];
  ignoreWeather?: boolean;
  weather?: CourseWeather;
  groupId?: string;
  groupNames?: string[];
  /** the region was picked for the brands asked for (no place chosen) */
  regionPicked?: boolean;
  brandRegions?: BrandRegion[];
}

interface CourseRow {
  id: string;
  request: StoredRequest & { defaultedFields?: string[]; startName?: string; tasteNote?: string; link?: CourseLink; withCafe?: boolean; withFood?: boolean };
  result: CourseVariant[];
  frozen: boolean;
  created_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toCourse(r: CourseRow): Course {
  const q = r.request;
  return {
    id: r.id,
    request: {
      styles: q.styles ?? [], stopCount: q.stopCount, maxStops: q.maxStops === true, timeBudgetMin: q.timeBudgetMin,
      budget: q.budget ?? 'any', items: q.items ?? [], regionName: q.regionName, regionId: q.regionId, defaultedFields: q.defaultedFields ?? [],
      tasteNote: q.tasteNote,
      withCafe: q.withCafe,
      withFood: q.withFood,
      gender: q.gender,
      startAt: q.startAt,
      endBy: q.endBy,
      roundTrip: q.end?.back || undefined,
      brands: q.brands ?? [],
      mustShops: q.mustShops ?? [],
      skipVisited: q.skipVisited === true,
      bounds: q.bounds,
      ignoreWeather: q.ignoreWeather === true,
      regionPicked: q.regionPicked,
      brandRegions: q.brandRegions,
      groupId: q.groupId,
      groupNames: q.groupNames,
    },
    weather: q.weather,
    origin: q.origin,
    startName: q.startName,
    end: q.end ? { lat: q.end.lat, lng: q.end.lng } : undefined,
    endName: q.end?.name,
    variants: r.result,
    shared: r.frozen,
    createdAt: r.created_at,
    link: q.link,
  };
}

/** A saved course variant being edited, with its candidate pool rebuilt from the stored request. */
export interface EditContext {
  courseId: string;
  variantIndex: number;
  req: StoredRequest;
  result: CourseVariant[];
  current: CourseVariant;
  styleIds: string[];
  pool: Scored[];
  byId: Map<string, Scored>;
  ids: string[];
}

@Injectable()
export class CourseService {
  constructor(
    private readonly db: DbService,
    private readonly model: ModelClient,
    private readonly me: MeService,
    private readonly config: ConfigService,
    private readonly walk: WalkService,
    private readonly transit: TransitService,
    private readonly weather: WeatherService,
  ) {}

  /**
   * Swaps the straight-line legs for real walking routes (T map) where available and recomputes the totals.
   * Optimisation itself keeps using straight-line × 1.3; only the course shown gets the real streets.
   */
  async withStreets(origin: LatLngT, v: CourseVariant, end?: LatLngT): Promise<CourseVariant> {
    if (!this.walk.enabled || !v.stops.length) return v;
    const pts = [origin, ...v.stops.map((s) => ({ lat: s.shop.lat, lng: s.shop.lng })), ...(end ? [end] : [])];
    const legs = await this.walk.legs(pts);
    if (legs.every((l) => !l)) return v;
    const stops = v.stops.map((s, i) => (legs[i] ? { ...s, legFromPrev: legs[i]! } : s));
    const endLeg: Leg | undefined = end ? legs[stops.length] ?? v.endLeg : undefined;
    const all = [...stops.map((s) => s.legFromPrev), ...(endLeg ? [endLeg] : [])];
    const distance = all.reduce((a, l) => a + l.distanceM, 0);
    const walkMin = Math.round(all.reduce((a, l) => a + l.durationMin, 0) * 10) / 10;
    const dwell = stops.reduce((a, s) => a + dwellMin(s.shop.kind), 0);
    return { ...v, stops, endLeg, totalDistanceM: distance, walkMin, totalMin: Math.round((walkMin + dwell) * 10) / 10 };
  }

  /** Hours per shop for course cards: the owner's, else a recent blog post's. */
  private async hoursOf(ids: string[]): Promise<Map<string, { hours: HoursDay[] | null; source: 'owner' | 'blog' | null }>> {
    if (!ids.length) return new Map();
    const r = await this.db.pool.query<{ id: string; hours: HoursDay[] | null; source: 'owner' | 'blog' | null }>(
      `SELECT s.id::text,
              COALESCE(oh.hours, CASE WHEN s.hours_posted_on > now() - ${BLOG_HOURS_MAX_AGE} THEN s.hours END) AS hours,
              CASE WHEN oh.hours IS NOT NULL THEN 'owner' WHEN s.hours_posted_on > now() - ${BLOG_HOURS_MAX_AGE} AND s.hours IS NOT NULL THEN 'blog' END AS source
       FROM shops s LEFT JOIN LATERAL (SELECT oi.hours FROM shop_owner_info oi WHERE oi.shop_id = s.id) oh ON true
       WHERE s.id = ANY($1::bigint[])`,
      [ids.filter((id) => /^\d+$/.test(id))],
    );
    return new Map(r.rows.map((x) => [x.id, { hours: x.hours, source: x.source }]));
  }

  /**
   * The course against the clock: each shop's hours on the course's day, a warning where the walk reaches it closed
   * (after an edit, say — planning itself avoids that), arrival times when the user picked the start, and the total
   * including any short wait for a shop to open (the same rules as the optimiser).
   */
  async timed(v: CourseVariant, clock: Clock, pre?: Prefetch): Promise<CourseVariant> {
    const ids = v.stops.map((s) => s.shop.id);
    const [hours, news] = pre ? [pre.hours, pre.news] : await Promise.all([this.hoursOf(ids), newsTags(this.db.pool, ids)]);
    const today = clockAt();
    let t = 0;
    const stops = v.stops.map((s) => {
      t += s.legFromPrev.durationMin;
      const h = hours.get(s.shop.id);
      const w = windowFor(h?.hours, clock, Infinity);
      if (w && w !== 'closed' && t < w.from && w.from - t <= MAX_WAIT_MIN) t = w.from;
      const arrive = t;
      t += dwellMin(s.shop.kind);
      for (const b of (v.breaks ?? []).filter((x) => x.afterOrder === s.order)) t += b.detourM / WALK_M_PER_MIN + b.minutes;
      return {
        ...s,
        arriveAt: clock.chosen ? hhmm(clock.minutes + arrive) : undefined,
        shop: {
          ...s.shop,
          hoursToday: dayHours(h?.hours, clock, today),
          hoursSource: h?.source ?? undefined,
          hoursWarning: closedOnArrival(h?.hours, clock, arrive),
          newsTag: news.get(s.shop.id),
        },
      };
    });
    t += v.endLeg?.durationMin ?? 0;
    return { ...v, stops, totalMin: Math.round(t * 10) / 10, finishAt: clock.chosen ? hhmm(clock.minutes + t) : undefined };
  }

  /** Nearest subway station per region (looked up once per process). */
  private readonly stations = new Map<string, { lat: number; lng: number; name: string } | null>();

  async plan(input: CourseRequestInput, userId: string | null = null): Promise<Course> {
    const t0 = Date.now();
    input = coarseGps(input);
    const defaulted: string[] = [];
    const styles = (input.styles ?? []).filter((s) => STYLE_IDS.includes(s.id) && s.weight > 0);
    if (!input.styles?.length) defaulted.push('styles');
    const maxStops = input.maxStops === true;
    let stopCount: number;
    if (maxStops) stopCount = MAX_STOPS;
    else if (input.stopCount != null) stopCount = Math.min(MAX_STOPS, Math.max(MIN_STOPS, Math.round(input.stopCount)));
    else stopCount = (defaulted.push('stopCount'), DEFAULTS.stopCount);
    // When: now, or the start the user picked (shops are then checked against that day's hours).
    const clock = clockAt(input.startAt);
    const endBy = input.endBy?.trim() || undefined;
    // A stop count the user chose wins over the default time: plan all of them and let the time follow.
    // Only a time the user chose themselves limits the count — a length, or "6시까지" (start → that time).
    const timeChosen = endBy != null || (input.timeBudgetMin != null && input.timeBudgetMin >= 30 && input.timeBudgetMin <= 720);
    const countChosen = !maxStops && input.stopCount != null;
    let timeBudgetMin: number;
    if (endBy) timeBudgetMin = Math.min(NO_TIME_LIMIT_MIN, minutesUntil(clock, endBy));
    else if (timeChosen) timeBudgetMin = Math.round(input.timeBudgetMin!);
    else {
      defaulted.push('timeBudgetMin');
      timeBudgetMin = countChosen ? NO_TIME_LIMIT_MIN : DEFAULTS.timeBudgetMin;
    }

    const budget = ['low', 'mid', 'high'].includes(input.budget ?? '') ? input.budget! : 'any';
    const itemIds = new Set(ITEMS.map((i) => i.id));
    const items = (input.items ?? []).filter((i) => itemIds.has(i));

    // Brands asked for ("아더에러 파는 데"): shops carrying them move well up; their cards say so.
    const brands = await brandsByKey(this.db.pool, [...new Set((input.brands ?? []).map((b) => b.trim()).filter(Boolean))].slice(0, 5));
    // Brands asked for but no place chosen (the map as it happened to be): plan where those brands are. From "내 위치"
    // the start stays, and the regions are only offered when the brands aren't nearby.
    const brandPick = brands.length && !input.continueFrom ? await this.brandRegionsFor(input, brands, stopCount) : undefined;
    if (brandPick?.picked) input = { ...input, origin: { regionId: brandPick.regions[0].id } };
    const pickedStart = input.origin.point && !input.origin.regionId && !input.origin.gps && GENERIC_PLACE.has(input.origin.label?.trim() ?? '__');
    const pickedName = pickedStart ? await this.nameOfPoint(input.origin.point!) : undefined;
    const resolved = await this.resolveOrigin(pickedName ? { ...input, origin: { ...input.origin, label: pickedName } } : input);
    const { regionId, regionName } = resolved;
    let { origin, startName } = resolved;
    // The forecast comes in while the shops are fetched and scored (a first ask for an area takes ~1 s).
    const forecastAsk = this.weather.forCourse(origin, clock.date, clock.minutes, Math.min(timeBudgetMin, 300)).catch(() => null);
    const bounds = regionId ? undefined : usableBox(input.origin.bounds);
    const personal = userId ? await this.me.personal(userId) : null;
    const skipVisited = input.skipVisited === true;
    const asked = [...new Set((input.mustShopIds ?? []).filter((id) => /^\d+$/.test(id)))].slice(0, MAX_MUST);
    // More pinned shops than stops asked for: the course grows to hold them all instead of dropping some silently.
    const pinsNote = asked.length > stopCount ? `고정한 가게가 ${asked.length}곳이라 ${asked.length}곳으로 짰어요` : undefined;
    if (asked.length > stopCount) stopCount = asked.length;
    const pool = await this.candidates(origin, regionId, stopCount, bounds);
    // A shop asked for by name may be just outside the area searched: it comes along if it is within reach.
    const missingMust = asked.filter((id) => !pool.some((r) => r.id === id));
    const far: string[] = [];
    for (const r of missingMust.length ? await this.candidatesById(missingMust) : []) {
      if (streetM(origin, r) <= MUST_MAX_M) pool.push(r);
      else far.push(`${r.name}(${(streetM(origin, r) / 1000).toFixed(1)}km)`);
    }
    const mustIds = asked.filter((id) => pool.some((r) => r.id === id));
    const farNote = far.length ? `${topic(far.join('·'))} 출발점에서 멀어서 넣지 않았어요` : undefined;
    const gender = GENDERS.has(input.gender ?? '') ? input.gender : undefined;
    const rows = pool.filter((r) => mustIds.includes(r.id) || (keep(r, personal, skipVisited, clock, timeBudgetMin) && genderFit(r, gender) > 0));
    // A brand's store known only by its name (no brand link yet) counts as that brand's store, first among its keys so
    // one-store-per-brand sees it. Only shops on Kakao: a public-data registration called "슈프림" in 상봉동, with no
    // listing or posts, is a shop of that name, not the brand's store (pipeline.brands links Kakao names the same way).
    for (const r of rows) {
      if (r.category !== 'brand' || !r.on_kakao) continue;
      for (const b of brands) if (!r.brand_keys?.includes(b.key) && namedFor(r.name, b)) r.brand_keys = [b.key, ...(r.brand_keys ?? [])];
    }
    if (!rows.length) {
      throw new BadRequestException(
        bounds ? '지금 지도 화면 안에는 추천할 가게가 없어요. 지도를 옮기거나 조금 넓혀 주세요' : '이 근처에서 추천할 가게를 찾지 못했어요. 다른 지역을 골라 주세요',
      );
    }
    // Shops known to be closed then are out (above); a pool emptied by the hours says so.
    const closedThen = pool.filter((r) => !mustIds.includes(r.id) && windowFor(r.hours, clock, timeBudgetMin) === 'closed').length;

    // "같은 조건으로 다른 코스": shops the user was just shown drop back (not out, so small areas still fill a course).
    const seen = new Set((input.seenShopIds ?? []).slice(0, 200));
    // Weather for the course's hours (origin, start, length): rain, snow, heat or cold → indoor places (백화점·몰·
    // 지하상가) move up and every walk between shops counts more, so the course stays under a roof and short.
    const ignoreWeather = input.weather === false;
    const forecast = await forecastAsk;
    const bad = !!forecast && forecast.condition !== 'fine';
    const applyWeather = bad && !ignoreWeather;
    // How well a shop fits the chosen styles (0-1); with none chosen, everything fits.
    const styleFit = (s: Scored) => {
      if (!styles.length) return 1;
      const total = styles.reduce((a, x) => a + x.weight, 0);
      return styles.reduce((a, x) => a + x.weight * ((s.fit[x.id] ?? 0) / 10), 0) / total;
    };
    const fresh = rows.map((r) => {
      const s = this.score(r, styles, budget, items, personal, brands);
      // Indoors counts for as much as it fits: a department store doesn't become a vintage stop because it rains.
      const indoor = applyWeather && r.kind === 'complex' ? INDOOR_BONUS * styleFit(s) : 0;
      const unverified = r.category === 'brand' && !r.on_kakao && !r.matched_posts ? UNVERIFIED_BRAND_FACTOR : 1;
      return mustIds.includes(r.id) ? s : { ...s, value: Math.min(1, s.value * genderFit(r, gender) * unverified + indoor) };
    });
    // Each brand asked for is in every course like a pin: its own store here when there is one (슈프림 asked for →
    // the Supreme store, not a select shop stocking it), else the best shop carrying it. On "다른 코스" the best one not
    // shown yet, so the brand stays but the shop can change. A pinned shop of the same kind already covers it.
    const brandPicks: string[] = [];
    const freshValue = (s: Scored) => (seen.has(s.id) ? s.value * SEEN_FACTOR : s.value);
    for (const b of brands) {
      if (mustIds.length + brandPicks.length >= stopCount) break;
      const carriers = fresh.filter((s) => s.brand_keys?.includes(b.key));
      const own = carriers.filter((s) => ownStore(s, b.key));
      const options = own.length ? own : carriers;
      if ([...mustIds, ...brandPicks].some((id) => options.some((s) => s.id === id))) continue;
      const best = options.sort((x, y) => freshValue(y) - freshValue(x))[0];
      if (best) brandPicks.push(best.id);
    }
    let indoorPicked = false;
    // Bad weather: one indoor place near the start is in the course too (the best-valued complex within reach), so
    // there's somewhere under a roof — unless a pinned shop already is one.
    if (applyWeather && mustIds.length + brandPicks.length < stopCount && ![...mustIds, ...brandPicks].some((id) => fresh.find((f) => f.id === id)?.kind === 'complex')) {
      const indoor = fresh
        .filter((s) => s.kind === 'complex' && streetM(origin, s) <= INDOOR_MAX_M && styleFit(s) >= INDOOR_MIN_FIT)
        .sort((x, y) => freshValue(y) - freshValue(x))[0];
      if (indoor) brandPicks.push(indoor.id);
      indoorPicked = !!indoor;
    }
    // A store of a brand already covered by its pick doesn't stay from the last course too (two 아더에러 stores).
    const storeBrand = (id: string) => {
      const f = fresh.find((x) => x.id === id);
      return f?.category === 'brand' ? f.brand_keys?.[0] : undefined;
    };
    const picked = new Set(brandPicks.flatMap((id) => fresh.find((x) => x.id === id)?.brand_keys ?? []));
    const kept = this.keyShops(
      (input.keepShopIds ?? []).filter((id) => !brandPicks.includes(id) && !picked.has(storeBrand(id) ?? '')),
      fresh, personal, stopCount - mustIds.length - brandPicks.length,
    );
    const must = new Set([...mustIds, ...brandPicks, ...kept]);
    const seenFactor = kept.length ? SEEN_FACTOR_KEEPING : SEEN_FACTOR;
    const ranked = oneStorePerBrand(
      onePerName(
        fresh.map((s) => (seen.has(s.id) && !must.has(s.id) ? { ...s, value: s.value * seenFactor } : s)),
        must,
      ),
      must,
    ).sort((a, b) => b.value - a.value);
    const limit = Math.max(MAX_CANDIDATES, Math.min(80, Math.ceil(stopCount * 3.5)));
    const scored = [...ranked.filter((s) => must.has(s.id)), ...ranked.filter((s) => !must.has(s.id)).slice(0, limit)];
    const byId = new Map(scored.map((s) => [s.id, s]));

    // The first brand asked for that has its own store here: the walk starts there ("슈프림" → the Supreme store first,
    // not a select shop stocking it), the rest ordered from it. A brand only stocked by other shops isn't put first.
    const first = brands
      .map((b) => brandPicks.map((id) => byId.get(id)).find((s) => s && ownStore(s, b.key)))
      .find((s): s is Scored => !!s);

    // A region starts at the station nearest the shops this course will most likely use, not the area's centre
    // (동대문·동묘 for vintage → 동묘앞역, not 동대문역) — or nearest that brand store when the walk starts there.
    if (regionId && first) {
      const station = await this.stationNear(first);
      if (station) ({ origin, startName } = { origin: { lat: station.lat, lng: station.lng }, startName: station.name });
    } else if (regionId) {
      const top = scored.slice(0, STATION_NEAR_TOP);
      const w = top.reduce((a, s) => a + s.value, 0) || 1;
      const centre = { lat: top.reduce((a, s) => a + s.lat * s.value, 0) / w, lng: top.reduce((a, s) => a + s.lng * s.value, 0) / w };
      const station = await this.stationNear(centre);
      if (station) ({ origin, startName } = { origin: { lat: station.lat, lng: station.lng }, startName: station.name });
    }

    // Where it ends: the start again, a chosen place, or (default) the last shop.
    // A finish picked on the map gets a real name ("합정역", "망원동") instead of "고른 곳".
    const endInput = input.end?.point && GENERIC_PLACE.has(input.end.label?.trim() ?? '')
      ? { ...input.end, label: (await this.nameOfPoint(input.end.point)) ?? input.end.label }
      : input.end;
    const end = resolveEnd(endInput, origin, startName);
    const res = await this.optimize(origin, scored, stopCount, timeBudgetMin, countChosen, must, {
      clock, end, distanceScale: applyWeather ? BAD_WEATHER_WALK : 1, firstId: first?.id,
    });
    const weather = forecast ? courseWeather(forecast, applyWeather, indoorPicked) : undefined;

    const styleIds = styles.map((x) => x.id);
    const hoursNote = clock.chosen && closedThen ? `${hhmm(clock.minutes)} 출발에 맞춰 그때 닫는 가게 ${closedThen}곳은 뺐어요` : undefined;
    const unseenBrands = brands.filter((b) => !fresh.some((s) => s.brand_keys?.includes(b.key))).map((b) => b.name);
    const brandNote = unseenBrands.length ? `이 근처에서 ${obj(unseenBrands.join('·'))} 다루는 가게를 찾지 못했어요` : undefined;
    const filled = res.filter((c) => c.stop_ids.length);
    const variants: CourseVariant[] = (filled.length ? filled : res.slice(0, 1)).map((c) => {
      const stops = this.stops(origin, c.stop_ids.map((id) => byId.get(id)!), styleIds, c.legs);
      const last = stops[stops.length - 1]?.shop ?? origin;
      return {
        variant: c.variant, label: VARIANT_LABEL[c.variant] ?? c.variant, stops,
        totalDistanceM: c.total_distance_m, walkMin: c.walk_min, totalMin: c.total_min,
        endLeg: end && c.end_leg ? { distanceM: c.end_leg.distance_m, durationMin: c.end_leg.duration_min, path: [{ lat: last.lat, lng: last.lng }, end] } : undefined,
        // "as many as fit" asked for the maximum on purpose, so fewer stops is the answer, not a warning.
        note: [maxStops ? `시간 안에 ${stops.length}곳을 넣었어요` : c.note, pinsNote, this.mustNote(c.stop_ids, mustIds, kept, byId), farNote, hoursNote, brandNote].filter(Boolean).join(' · ') || undefined,
      };
    });

    const routed = await Promise.all(
      variants.map(async (v) => {
        const streets = await this.withStreets(origin, v, end);
        if (!input.withCafe && !input.withFood) return streets;
        const n = streets.stops.length;
        const kinds: BreakKind[] = [...(input.withFood ? (['food'] as const) : []), ...(input.withCafe ? (['cafe'] as const) : [])];
        const slots = breakSlots(n, kinds);
        const food = input.withFood ? await this.findBreak(streets, 'food', slots.food!) : undefined;
        const cafe = input.withCafe ? await this.findBreak(streets, 'cafe', slots.cafe!, food?.afterOrder ?? 1) : undefined;
        const missing = [input.withFood && !food ? '맛집' : '', input.withCafe && !cafe ? '카페' : ''].filter(Boolean);
        const withStops = withBreaks(streets, [food, cafe].filter((b): b is BreakStop => !!b));
        return missing.length ? { ...withStops, note: [withStops.note, `코스 가까이에서 들를 ${object(missing.join('·'))} 찾지 못했어요`].filter(Boolean).join(' · ') } : withStops;
      }),
    );
    variants.splice(0, variants.length, ...(await Promise.all(routed.map((v) => this.timed(v, clock)))));

    const request = {
      withCafe: input.withCafe === true || undefined,
      withFood: input.withFood === true || undefined,
      gender,
      styles: styleIds, stopCount, maxStops, timeBudgetMin, budget, items, regionName, regionId, defaultedFields: defaulted,
      tasteNote: this.tasteNote(personal, styleIds.length > 0),
      startAt: clock.chosen ? input.startAt!.trim() : undefined,
      endBy,
      roundTrip: end?.back || undefined,
      brands,
      mustShops: mustIds.map((id) => ({ id, name: byId.get(id)?.name ?? pool.find((r) => r.id === id)?.name ?? '' })),
      skipVisited,
      bounds,
      ignoreWeather,
      regionPicked: brandPick?.picked || undefined,
      brandRegions: brandPick?.regions,
    };
    // "다른 지역으로 이어 가기": how to get from the previous course's last shop to this one's start.
    const link = input.continueFrom ? await this.linkFrom(input.continueFrom, origin, startName) : undefined;
    const saved = await this.db.pool.query<{ id: string }>(
      `INSERT INTO courses (request, result, user_id, input_mode, plan_ms) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        JSON.stringify({ ...request, origin, startName, link, end, weather }), JSON.stringify(variants), userId,
        INPUT_MODES.has(input.inputMode ?? '') ? input.inputMode : 'buttons', Date.now() - t0,
      ],
    );
    return {
      id: saved.rows[0].id, request, origin, startName, variants, shared: false, createdAt: new Date(), link,
      end: end ? { lat: end.lat, lng: end.lng } : undefined, endName: end?.name, weather,
    };
  }

  /** The previous course's last shop → this course's start, by public transit (or the Kakao Map link). */
  private async linkFrom(prevId: string, to: LatLngT, toName: string | undefined): Promise<CourseLink | undefined> {
    if (!UUID.test(prevId)) return undefined;
    const r = await this.db.pool.query<{ request: { regionName?: string; startName?: string }; result: CourseVariant[] }>(
      'SELECT request, result FROM courses WHERE id = $1',
      [prevId],
    );
    const prev = r.rows[0];
    const stops = prev?.result[0]?.stops ?? [];
    const last = stops[stops.length - 1]?.shop;
    if (!prev || !last) return undefined;
    const transit = await this.transit.route({ lat: last.lat, lng: last.lng, name: last.name }, { ...to, name: toName ?? '다음 코스 출발점' });
    return { prevCourseId: prevId, prevName: prev.request.regionName ?? prev.request.startName ?? '앞 코스', fromShop: last.name, transit };
  }

  /** Kakao keyword search within the break's category near its spot in the course, cached per kind and ~100 m. */
  private readonly breakPlaces = new Map<string, KakaoPlace[]>();

  /**
   * A place on the way, not off it: Kakao keyword search ("카페" / "맛집" within the category) around every walk
   * between two shops, then the place that adds the least walking wins. Ties lean towards the preferred spot in the
   * course (a meal in the first third, a café in the second), Kakao's ranking and neighbourhood places over chains.
   * minSlot / maxSlot keep a café after the meal when both are in.
   */
  private async findBreak(
    v: CourseVariant, kind: BreakKind, preferred: number, minSlot = 1, maxSlot = v.stops.length, skip: Set<string> = new Set(),
  ): Promise<BreakStop | undefined> {
    const n = v.stops.length;
    if (!n) return undefined;
    const key = this.config.get<string>('KAKAO_REST_API_KEY');
    if (!key) return undefined;
    const spec = BREAKS[kind];
    const lo = Math.max(1, Math.min(minSlot, n));
    const hi = Math.max(lo, Math.min(maxSlot, n));
    let best: { cost: number; place: KakaoPlace; k: number; detour: number } | null = null;
    const seen = new Set<string>();
    for (let leg = lo; leg <= hi; leg++) {
      const a = v.stops[leg - 1].shop;
      const b = v.stops[leg]?.shop;
      // Around the walk a→b (or around the last shop, where the course ends); wide enough to cover the whole walk.
      const centre = b ? { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 } : { lat: a.lat, lng: a.lng };
      const radius = Math.round(Math.min(BREAK_RADIUS_M, Math.max(BREAK_MIN_RADIUS_M, (b ? streetM(a, b) / 2 : 0) + 120)));
      const places = await this.breakSearch(key, kind, centre, radius);
      places.forEach((p, rank) => {
        const id = `${p.place_name}@${p.x},${p.y}`;
        if (seen.has(id) || skip.has(p.place_name)) return; // "다른 곳으로": places already turned down
        seen.add(id);
        // Its place in the order is where it really is: the walk it adds least to (never a slot it isn't near).
        const { k, detour } = slotFor(v, { lat: Number(p.y), lng: Number(p.x) }, lo, hi);
        const cost = detour + SLOT_PENALTY_M * Math.abs(k - preferred) + RANK_PENALTY_M * rank + (spec.chain.test(p.place_name) ? CHAIN_PENALTY_M : 0);
        if (!best || cost < best.cost) best = { cost, place: p, k, detour };
      });
    }
    const pick = best as { cost: number; place: KakaoPlace; k: number; detour: number } | null;
    if (!pick || pick.detour > MAX_BREAK_DETOUR_M) return undefined;
    const p = pick.place;
    return {
      kind, afterOrder: pick.k, name: p.place_name, lat: Number(p.y), lng: Number(p.x),
      address: p.road_address_name || p.address_name || undefined, placeUrl: p.place_url || undefined,
      category: p.category_name?.split(' > ').slice(-1)[0], minutes: spec.minutes, detourM: 0,
    };
  }

  private async breakSearch(key: string, kind: BreakKind, centre: LatLngT, radius: number): Promise<KakaoPlace[]> {
    const spec = BREAKS[kind];
    const cacheKey = `${kind}:${centre.lat.toFixed(4)},${centre.lng.toFixed(4)}:${radius}`;
    const hit = this.breakPlaces.get(cacheKey);
    if (hit) return hit;
    const q = new URLSearchParams({
      query: spec.query, category_group_code: spec.code, x: String(centre.lng), y: String(centre.lat), radius: String(radius), sort: 'accuracy', size: '15',
    });
    let places: KakaoPlace[] = [];
    try {
      const res = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?${q}`, {
        headers: { Authorization: `KakaoAK ${key}` },
        signal: AbortSignal.timeout(4000),
      });
      places = res.ok ? ((await res.json()) as { documents: KakaoPlace[] }).documents : [];
    } catch {
      places = [];
    }
    this.breakPlaces.set(cacheKey, places);
    return places;
  }

  /**
   * "카페 넣기" / "맛집 넣기" on a planned course: adds (or removes) one break of that kind. The other kind, if there,
   * stays (same place, slots re-arranged). Shared / someone else's courses are copied first, as for any edit.
   */
  async setBreak(
    courseId: string, variantIndex: number, kind: BreakKind, on: boolean, stopIds?: string[], userId: string | null = null, avoid: string[] = [],
  ): Promise<CourseEditResult> {
    if (!(kind in BREAKS)) throw new BadRequestException('cafe 또는 food만 넣을 수 있어요');
    const ctx = await this.editContext(await this.editable(courseId, userId), variantIndex, stopIds);
    const stored = ctx.result[variantIndex];
    const sameStops = ctx.ids.join() === stored.stops.map((s) => s.shop.id).join();
    const base = sameStops ? withoutBreaks(stored) : await this.withStreets(ctx.req.origin, ctx.current, ctx.req.end);
    const clock = storedClock(ctx.req.startAt);
    const current = (stored.breaks ?? []).find((b) => b.kind === kind);
    const others = (stored.breaks ?? []).filter((b) => b.kind !== kind).map((b) => ({ ...b, afterOrder: bestSlot(base, b) }));
    // Asking again while one is in: another place, never the one shown now or any turned down before.
    const skip = new Set([...avoid, ...(on && current ? [current.name] : [])].slice(0, 50));
    const list = [...others];
    let message = `${object(BREAKS[kind].label)} 뺐어요`;
    if (on) {
      const n = base.stops.length;
      const other = others[0];
      const preferred = breakSlots(n, other ? ['food', 'cafe'] : [kind])[kind]!;
      // The meal comes first: a café is not put before it, nor a meal after the café.
      const [minSlot, maxSlot] = !other ? [1, n] : kind === 'cafe' ? [other.afterOrder, n] : [1, other.afterOrder];
      const found = await this.findBreak(base, kind, preferred, minSlot, maxSlot, skip);
      if (!found) {
        // Nothing else on the way: keep the one there was rather than dropping it.
        const kept = current ? [...list, { ...current, afterOrder: bestSlot(base, current) }] : list;
        const what = current ? `다른 ${BREAKS[kind].label}` : `들를 ${BREAKS[kind].label}`;
        return { courseId: ctx.courseId, variant: await this.timed(withBreaks(base, kept), clock), message: `코스 가까이에서 ${object(what)} 찾지 못했어요`, mustShops: ctx.req.mustShops ?? [] };
      }
      list.push(found);
      message = current ? `${current.name} 대신 ${toward(found.name)} 바꿨어요` : `${found.afterOrder}번 다음, 가는 길에 있는 ${object(found.name)} 넣었어요`;
    }
    const variant = await this.timed(withBreaks(base, list), clock);
    await this.saveEdit(ctx, variant, [{ op: 'break', kind, on, source: 'button' }]);
    return { courseId: ctx.courseId, variant, message, mustShops: ctx.req.mustShops ?? [] };
  }

  /**
   * 같이 가기: the base course's own conditions (area, time, end, pins, brands, count …) with everyone's taste instead
   * of the first person's. Returns the request to plan and the names for the course header.
   */
  async groupRequest(
    baseId: string, taste: { styles: { id: string; weight: number }[]; gender?: string; budget?: string }, names: string[],
  ): Promise<{ input: CourseRequestInput; names: string[] }> {
    const row = (await this.db.pool.query<CourseRow>('SELECT id, request, result, frozen, created_at FROM courses WHERE id = $1', [baseId])).rows[0];
    if (!row) throw new BadRequestException('처음 코스를 찾지 못했어요');
    const q = row.request;
    const chosen = (f: string) => !(q.defaultedFields ?? []).includes(f);
    const startAt = q.startAt && storedClock(q.startAt).chosen ? q.startAt : undefined;
    const input: CourseRequestInput = {
      origin: q.regionId ? { regionId: q.regionId } : { point: q.origin, label: q.startName, bounds: q.bounds },
      styles: taste.styles,
      stopCount: !q.maxStops && chosen('stopCount') ? q.stopCount : undefined,
      maxStops: q.maxStops || undefined,
      timeBudgetMin: chosen('timeBudgetMin') && !q.endBy ? q.timeBudgetMin : undefined,
      budget: taste.budget,
      items: q.items?.length ? q.items : undefined,
      withCafe: q.withCafe,
      withFood: q.withFood,
      gender: taste.gender,
      startAt,
      endBy: q.endBy && endStillAhead(startAt, q.endBy) ? q.endBy : undefined,
      end: q.end?.back ? { back: true } : q.end ? { point: { lat: q.end.lat, lng: q.end.lng }, label: q.end.name } : undefined,
      mustShopIds: (q.mustShops ?? []).map((m) => m.id),
      brands: (q.brands ?? []).map((b) => b.key),
      weather: q.ignoreWeather ? false : undefined,
      inputMode: 'group',
    };
    return { input, names };
  }

  /** Marks a course as planned for a group (the header says whose tastes went in). */
  async markGroup(courseId: string, groupId: string, names: string[]): Promise<void> {
    await this.db.pool.query(
      `UPDATE courses SET request = request || jsonb_build_object('groupId', $2::text, 'groupNames', $3::jsonb) WHERE id = $1`,
      [courseId, groupId, JSON.stringify(names)],
    );
  }

  // ---------- English (the client's English mode) ----------

  /**
   * A course in the request's language. Stored courses keep their Korean text; for English this rewrites it on the
   * way out: each card's reason from the shop's translated summary (pipeline.translate), hours / warnings / news tags
   * recomputed (they're written in the request's language), notes and labels through localize.ts.
   */
  /**
   * Many courses in the request's language (저장한 코스, 최근 코스) with a handful of queries for all of them, not about
   * fourteen per course: shops, hours, news, translations and brand names are fetched once up front.
   */
  async localizeMany(courses: Course[]): Promise<Course[]> {
    if (lang() !== 'en' || !courses.length) return courses;
    const ids = [...new Set(courses.flatMap((c) => c.variants.flatMap((v) => v.stops.map((s) => s.shop.id))))];
    const [rows, hours, news] = await Promise.all([this.shopTexts(ids), this.hoursOf(ids), newsTags(this.db.pool, ids)]);
    // Warms inLang's cache, so each course's own lookups below need no query.
    await inLang(this.db.pool, [
      ...courses.flatMap((c) => [c.request.regionName, c.startName, c.endName].map((x) => x?.replace(/ 근처$/, ''))),
      ...[...rows.values()].flatMap((r) => [r.reason_material, r.summary]),
    ]);
    const brandsEn = await this.brandNamesEn(courses.flatMap((c) => [...c.request.brands.map((b) => b.name), ...c.variants.flatMap((v) => v.stops.flatMap((s) => s.brands ?? []))]));
    const pre: Prefetch = { rows, hours, news, brandsEn };
    return Promise.all(courses.map((c) => this.localize(c, pre)));
  }

  /** The shop texts a card's English is made from. */
  private async shopTexts(ids: string[]): Promise<Map<string, ShopText>> {
    const want = ids.filter((id) => /^\d+$/.test(id));
    if (!want.length) return new Map();
    const r = await this.db.pool.query<ShopText>(
      `SELECT s.id::text, s.category, s.summary, s.reason_material,
              (SELECT jsonb_object_agg(style_id, score) FROM shop_style_scores x WHERE x.shop_id = s.id) AS scores
       FROM shops s WHERE s.id = ANY($1::bigint[])`,
      [want],
    );
    return new Map(r.rows.map((x) => [x.id, x]));
  }

  async localize(c: Course, pre?: Prefetch): Promise<Course> {
    if (lang() !== 'en') return c;
    const q = c.request;
    const tr = await inLang(this.db.pool, [q.regionName, c.startName, c.endName].map((x) => x?.replace(/ 근처$/, '')));
    const place = (name?: string) => {
      if (!name) return name;
      const near = / 근처$/.test(name);
      const base = name.replace(/ 근처$/, '');
      const en = tr.get(base) ?? ({ '내 위치': 'My location', '고른 위치': 'Picked spot', '출발점': 'the start', '끝나는 곳': 'Finish', '고른 곳': 'Picked spot' } as Record<string, string>)[base] ?? base;
      return near ? `Near ${en}` : en;
    };
    const brandsEn = pre?.brandsEn ?? (await this.brandNamesEn([...q.brands.map((b) => b.name), ...c.variants.flatMap((v) => v.stops.flatMap((s) => s.brands ?? []))]));
    return {
      ...c,
      startName: place(c.startName),
      endName: place(c.endName),
      weather: weatherEn(c.weather),
      request: {
        ...q,
        regionName: place(q.regionName),
        tasteNote: tasteNoteEn(q.tasteNote),
        brands: q.brands.map((b) => ({ ...b, name: b.nameEn ?? brandsEn.get(b.name) ?? b.name })),
        brandRegions: q.brandRegions && (await this.brandRegionsEn(q.brandRegions, q.brands, brandsEn)),
      },
      variants: await Promise.all(c.variants.map((v) => this.localizeVariant(v, q.styles, q.startAt, brandsEn, pre))),
    };
  }

  /** One version of a course in the request's language (see localize). */
  async localizeVariant(v: CourseVariant, styleIds: string[], startAt?: string, brandsEn?: Map<string, string>, pre?: Prefetch): Promise<CourseVariant> {
    if (lang() !== 'en') return v;
    const byId = pre?.rows ?? (await this.shopTexts(v.stops.map((s) => s.shop.id)));
    const rows = v.stops.map((s) => byId.get(s.shop.id)).filter((r): r is ShopText => !!r);
    const tr = await inLang(this.db.pool, rows.flatMap((r) => [r.reason_material, r.summary]));
    const brands = brandsEn ?? (await this.brandNamesEn(v.stops.flatMap((s) => s.brands ?? [])));
    const timed = await this.timed(v, storedClock(startAt), pre);
    return {
      ...timed,
      label: VARIANT_LABEL_EN[v.variant] ?? v.label,
      // Brand names inside the note too ("…carries 아더에러" → ADER ERROR).
      note: [...brands].reduce<string | undefined>((n, [ko, en]) => n?.split(ko).join(en), noteEn(v.note)),
      stops: timed.stops.map((s) => {
        const r = byId.get(s.shop.id);
        if (!r) return s;
        const best = styleIds
          .map((id) => ({ id, score: r.scores?.[id] ?? 0 }))
          .filter((x) => x.score >= 5)
          .sort((a, b) => b.score - a.score)[0];
        const label = best ? (STYLES.find((x) => x.id === best.id)?.labelEn ?? best.id) : undefined;
        const text = (r.reason_material && tr.get(r.reason_material)) || (r.summary && tr.get(r.summary)) || undefined;
        const stopBrands = (s.brands ?? []).map((b) => brands.get(b) ?? b);
        return {
          ...s,
          brands: stopBrands,
          reason: reasonEn({ brands: stopBrands, style: best && label ? { label, score: best.score } : undefined, text, category: r.category }),
          shop: { ...s.shop, summary: (r.summary && tr.get(r.summary)) || s.shop.summary },
        };
      }),
    };
  }

  /** English spellings of brand names (the brand dictionary's name_en). */
  private async brandNamesEn(names: string[]): Promise<Map<string, string>> {
    const want = [...new Set(names.filter(Boolean))];
    if (!want.length || lang() !== 'en') return new Map();
    const r = await this.db.pool.query<{ name: string; name_en: string }>('SELECT name, name_en FROM brands WHERE name = ANY($1) AND name_en IS NOT NULL', [want]);
    return new Map(r.rows.map((x) => [x.name, x.name_en]));
  }

  /** An edit's result in the request's language. */
  async localizeEdit(r: CourseEditResult): Promise<CourseEditResult> {
    if (lang() !== 'en') return r;
    const row = (await this.db.pool.query<{ request: StoredRequest }>('SELECT request FROM courses WHERE id = $1', [r.courseId])).rows[0];
    return { ...r, message: noteEn(r.message), variant: await this.localizeVariant(r.variant, row?.request.styles ?? [], row?.request.startAt) };
  }

  /** Public transit between two points (getting to a course's start). */
  transitRoute(from: LatLngT & { name?: string }, to: LatLngT & { name?: string }) {
    return this.transit.route(from, to);
  }

  // ---------- editing (stage 6) ----------

  /** Applies one edit to a saved course's variant and stores it. */
  async edit(courseId: string, variantIndex: number, edit: CourseEditInput, stopIds?: string[], userId: string | null = null): Promise<CourseEditResult> {
    const ctx = await this.editContext(await this.editable(courseId, userId), variantIndex, stopIds);
    const { ids, message } = await this.applyEdit(ctx, ctx.ids, edit);
    const variant = await this.timed(
      keepBreaks(await this.withStreets(ctx.req.origin, this.rebuild(ctx, ids), ctx.req.end), ctx.result[ctx.variantIndex].breaks),
      storedClock(ctx.req.startAt),
    );
    await this.saveEdit(ctx, variant, [{ ...edit, source: 'button' }]);
    const mustShops = await this.savePins(ctx, ids, edit.shopId && (edit.op === 'add' || edit.op === 'replace') ? [edit.shopId] : []);
    return { courseId: ctx.courseId, variant, message, mustShops };
  }

  /**
   * Pins after an edit: a pinned shop taken out of the course by hand is unpinned; a shop the user put in by hand
   * (by name, from the map) is pinned, so "다른 코스" keeps it. At most MAX_MUST.
   */
  private async savePins(ctx: EditContext, ids: string[], added: string[]): Promise<PinnedShop[]> {
    const before = ctx.req.mustShops ?? [];
    const kept = before.filter((m) => ids.includes(m.id));
    const fresh = added.filter((id) => ids.includes(id) && !kept.some((m) => m.id === id)).map((id) => ({ id, name: this.nameOf(ctx, id) }));
    const pins = [...kept, ...fresh].slice(0, MAX_MUST);
    if (JSON.stringify(pins) !== JSON.stringify(before)) await this.writePins(ctx.courseId, pins);
    return pins;
  }

  private async writePins(courseId: string, pins: PinnedShop[]): Promise<void> {
    await this.db.pool.query(`UPDATE courses SET request = jsonb_set(request, '{mustShops}', $2::jsonb) WHERE id = $1`, [courseId, JSON.stringify(pins)]);
  }

  /** The card's pin: keep this shop in whatever course comes next ("다른 코스", 누구 옷, 시간 제한 없이). */
  async pin(courseId: string, shopId: string, on: boolean, userId: string | null): Promise<{ courseId: string; mustShops: PinnedShop[] }> {
    const own = await this.editable(courseId, userId);
    const row = (await this.db.pool.query<{ request: StoredRequest; result: CourseVariant[] }>('SELECT request, result FROM courses WHERE id = $1', [own])).rows[0];
    if (!row) throw new BadRequestException('코스를 찾지 못했어요');
    const pins = (row.request.mustShops ?? []).filter((m) => m.id !== shopId);
    if (on) {
      if (pins.length >= MAX_MUST) throw new BadRequestException(`고정은 ${MAX_MUST}곳까지예요. 다른 가게의 고정을 풀어 주세요`);
      const stop = row.result.flatMap((v) => v.stops).find((s) => s.shop.id === shopId);
      if (!stop) throw new BadRequestException('코스에 있는 가게만 고정할 수 있어요');
      pins.push({ id: shopId, name: stop.shop.name });
    }
    await this.writePins(own, pins);
    return { courseId: own, mustShops: pins };
  }

  /**
   * Course assistant: the model turns the sentence into edit operations, then they are applied in order. Numbers in
   * the sentence refer to the course as the user saw it, so each op is pinned to a shop before anything moves.
   */
  async editByText(courseId: string, variantIndex: number, text: string, stopIds?: string[], userId: string | null = null): Promise<CourseEditResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new BadRequestException('어떻게 고칠지 적어 주세요');
    // Only an edit that changes something forks a shared course, so a question like "카페도 넣어 줘" doesn't copy it.
    let ctx = await this.editContext(courseId, variantIndex, stopIds);
    const intent = await this.model.post<ModelIntent>(
      '/edit-intent',
      {
        text: trimmed.slice(0, 300),
        lang: lang(),
        stops: ctx.current.stops.map((st) => ({
          order: st.order, name: st.shop.name, category: st.shop.category, summary: st.shop.summary ?? null, price_range: st.shop.priceRange ?? null,
        })),
      },
      30000,
    );
    if (!intent.ops.length) {
      return { courseId, variant: ctx.current, message: intent.reply || '어떻게 고칠지 잘 모르겠어요. 다르게 말해 주세요', mustShops: ctx.req.mustShops ?? [] };
    }
    const own = await this.editable(courseId, userId);
    if (own !== courseId) ctx = { ...ctx, courseId: own };

    const original = [...ctx.ids];
    const pinned = intent.ops.map((o) => ({ op: o, shopId: o.order ? original[o.order - 1] : undefined }));
    let ids = [...original];
    const done: string[] = [];
    // Shops named in the sentence ("팔라스 넣어줘") count as put in by hand: pinned.
    const byName: string[] = [];
    for (const { op, shopId } of pinned) {
      if (op.order && !shopId) continue; // a number that isn't in the course
      const order = shopId ? ids.indexOf(shopId) + 1 : undefined;
      if (shopId && !order) continue; // already removed by an earlier op
      // "팔라스 넣어줘": that shop, found by name near the course — never a look-alike in its place.
      let pickedId: string | undefined;
      let farNote = '';
      const named = op.shop_name?.trim();
      if (named && (op.op === 'add' || op.op === 'replace')) {
        const hits = await searchShops(this.db.pool, named, this.middle(ctx, ids), 5, true);
        const hit = hits.find((h) => !ids.includes(h.id));
        if (!hit) {
          const inCourse = hits.find((h) => ids.includes(h.id));
          done.push(inCourse ? `${topic(inCourse.name)} 이미 코스에 있어요` : `‘${named}’ 가게를 찾지 못했어요. 이름을 확인하거나 ‘가게 이름으로 찾아 넣기’로 찾아 주세요`);
          continue;
        }
        pickedId = hit.id;
        byName.push(hit.id);
        // The only shop of that name may be in another neighbourhood: say so, the walk gets long.
        if ((hit.distanceM ?? 0) > FAR_PICK_M) farNote = ` (코스에서 ${((hit.distanceM ?? 0) / 1000).toFixed(1)}km 떨어진 곳이라 걷는 길이 길어져요)`;
      }
      // A swap's other number is pinned to its shop too, like order: earlier ops may have moved it.
      const swapWith = op.op === 'swap' && op.to_order ? ids.indexOf(original[op.to_order - 1] ?? '') + 1 : 0;
      if (op.op === 'swap' && !swapWith) continue;
      // "4번을 맨 앞으로": same as the card's 1번으로 — that shop first, the rest re-ordered from it.
      const opName = op.op === 'move' && op.to_order === 1 ? 'first' : op.op;
      const edit: CourseEditInput = {
        op: opName, order, toOrder: op.op === 'swap' ? swapWith : (op.to_order ?? undefined), shopId: pickedId,
        wantCategory: op.want_category ?? undefined, wantStyle: op.want_style ?? undefined,
        wantItem: op.want_item ?? undefined, wantBudget: op.want_budget ?? undefined, prefer: op.prefer ?? undefined,
      };
      try {
        const r = await this.applyEdit(ctx, ids, edit);
        ids = r.ids;
        done.push(r.message + farNote);
      } catch (e) {
        done.push(e instanceof Error ? e.message : String(e));
      }
    }
    const variant = await this.timed(
      keepBreaks(await this.withStreets(ctx.req.origin, this.rebuild(ctx, ids), ctx.req.end), ctx.result[ctx.variantIndex].breaks),
      storedClock(ctx.req.startAt),
    );
    await this.saveEdit(ctx, variant, [{ op: 'text', text: trimmed, ops: intent.ops, source: 'assistant' }]);
    const mustShops = await this.savePins(ctx, ids, byName);
    return { courseId: ctx.courseId, variant, message: done.join(' · ') || intent.reply, mustShops };
  }

  // ---------- sharing and history (stage 7) ----------

  /**
   * Freezes the variant on screen (the client's stop order, so an undo is respected) into a copy for a share link.
   * That variant goes first so the link opens on it. Sharing the same thing twice gives the same link.
   */
  async share(courseId: string, variantIndex: number, stopIds?: string[]): Promise<string> {
    const frozen = (await this.db.pool.query<{ frozen: boolean }>('SELECT frozen FROM courses WHERE id = $1', [courseId])).rows[0];
    if (!frozen) throw new BadRequestException('코스를 찾지 못했어요');
    if (frozen.frozen) return courseId; // passing on a link that was shared with me
    const ctx = await this.editContext(courseId, variantIndex, stopIds);
    const stored = ctx.result[variantIndex].stops.map((st) => st.shop.id);
    const shown = ctx.ids.join() === stored.join()
      ? ctx.current
      : await this.timed(
          keepBreaks(await this.withStreets(ctx.req.origin, ctx.current, ctx.req.end), ctx.result[variantIndex].breaks),
          storedClock(ctx.req.startAt),
        );
    const result = JSON.stringify([shown, ...ctx.result.filter((_, i) => i !== variantIndex)]);
    const same = await this.db.pool.query<{ id: string }>(
      'SELECT id FROM courses WHERE shared_from = $1 AND frozen AND result = $2::jsonb LIMIT 1',
      [courseId, result],
    );
    if (same.rows[0]) return same.rows[0].id;
    const r = await this.db.pool.query<{ id: string }>(
      `INSERT INTO courses (request, result, input_mode, user_id, frozen, shared_from)
       SELECT request, $2, input_mode, user_id, true, id FROM courses WHERE id = $1 RETURNING id`,
      [courseId, result],
    );
    return r.rows[0].id;
  }

  /**
   * A saved course as the client shows it. Opening a share link counts as one open. Someone else's course shows as
   * shared (editing it makes a copy, see editable()).
   */
  async load(courseId: string, viewerId: string | null = null): Promise<Course | null> {
    if (!UUID.test(courseId)) return null;
    const r = await this.db.pool.query<CourseRow & { user_id: string | null }>(
      `UPDATE courses SET opened = opened + (CASE WHEN frozen THEN 1 ELSE 0 END) WHERE id = $1
       RETURNING id, request, result, frozen, created_at, user_id`,
      [courseId],
    );
    const row = r.rows[0];
    if (!row) return null;
    const othersCourse = row.user_id !== null && row.user_id !== viewerId;
    return toCourse({ ...row, frozen: row.frozen || othersCourse });
  }

  /** "지난번처럼": this user's latest courses (shared copies left out; the originals are there). */
  async recent(userId: string, limit: number): Promise<Course[]> {
    const r = await this.db.pool.query<CourseRow>(
      `SELECT id, request, result, frozen, created_at FROM courses
       WHERE user_id = $1 AND NOT frozen AND jsonb_array_length(result) > 0
       ORDER BY created_at DESC LIMIT $2`,
      [userId, Math.min(Math.max(limit, 1), 30)],
    );
    return r.rows.map(toCourse);
  }

  /**
   * "코스 저장": keeps the course on my page. Someone else's or a shared course is copied first (as for an edit), so the
   * saved one is mine; the id saved is returned (the page switches to it).
   */
  async saveCourse(courseId: string, userId: string): Promise<string> {
    if (!UUID.test(courseId)) throw new BadRequestException('코스를 찾지 못했어요');
    const own = await this.editable(courseId, userId);
    const r = await this.db.pool.query(
      `INSERT INTO saved_courses (user_id, course_id) SELECT $1, id FROM courses WHERE id = $2 ON CONFLICT DO NOTHING`,
      [userId, own],
    );
    if (r.rowCount === 0) {
      const exists = await this.db.pool.query('SELECT 1 FROM courses WHERE id = $1', [own]);
      if (!exists.rowCount) throw new BadRequestException('코스를 찾지 못했어요');
    }
    return own;
  }

  async unsaveCourse(courseId: string, userId: string): Promise<boolean> {
    if (!UUID.test(courseId)) return false;
    const r = await this.db.pool.query('DELETE FROM saved_courses WHERE user_id = $1 AND course_id = $2', [userId, courseId]);
    return (r.rowCount ?? 0) > 0;
  }

  async savedIds(userId: string): Promise<string[]> {
    const r = await this.db.pool.query<{ course_id: string }>('SELECT course_id FROM saved_courses WHERE user_id = $1', [userId]);
    return r.rows.map((x) => x.course_id);
  }

  async saved(userId: string): Promise<Course[]> {
    const r = await this.db.pool.query<CourseRow>(
      `SELECT c.id, c.request, c.result, false AS frozen, c.created_at FROM saved_courses s JOIN courses c ON c.id = s.course_id
       WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 100`,
      [userId],
    );
    return r.rows.map(toCourse);
  }

  /**
   * The course id an edit should write to. A shared (frozen) course, or someone else's course opened from its address
   * (the page keeps ?c=<id> in the URL), is first copied for whoever edits it. So is a course nobody owns (made
   * without browser storage, or its account deleted): otherwise anyone with its link could change it in place.
   */
  private async editable(courseId: string, userId: string | null): Promise<string> {
    const r = await this.db.pool.query<{ id: string }>(
      `INSERT INTO courses (request, result, input_mode, user_id, shared_from, undo)
       SELECT request, result, input_mode, $2, id, undo FROM courses
       WHERE id = $1 AND (frozen OR user_id IS NULL OR user_id IS DISTINCT FROM $2::uuid) RETURNING id`,
      [courseId, userId],
    );
    return r.rows[0]?.id ?? courseId;
  }

  /** Loads a course and rebuilds its candidate pool from the stored request. */
  async editContext(courseId: string, variantIndex: number, stopIds?: string[]): Promise<EditContext> {
    const row = (
      await this.db.pool.query<{ request: StoredRequest; result: CourseVariant[]; user_id: string | null }>(
        'SELECT request, result, user_id FROM courses WHERE id = $1',
        [courseId],
      )
    ).rows[0];
    if (!row) throw new BadRequestException('코스를 찾지 못했어요');
    const current = row.result[variantIndex];
    if (!current) throw new BadRequestException('코스 버전을 찾지 못했어요');
    const req = row.request;
    const styles = (req.styles ?? []).map((id) => ({ id, weight: 1 }));
    const personal = row.user_id ? await this.me.personal(row.user_id) : null;
    const clock = storedClock(req.startAt);
    const rows = (await this.candidates(req.origin, req.regionId, Math.max(current.stops.length, 4) * 2, req.bounds)).filter((r) =>
      keep(r, personal, req.skipVisited === true, clock, req.timeBudgetMin ?? NO_TIME_LIMIT_MIN) && genderFit(r, req.gender) > 0,
    );
    const scored = rows.map((r) => {
      const s = this.score(r, styles, req.budget ?? 'any', req.items ?? [], personal, req.brands ?? []);
      return { ...s, value: s.value * genderFit(r, req.gender) };
    });
    // Keep the course's own shops even if a same-name branch scores higher, so "다른 가게로" never swaps 지점 for 지점.
    const inCourse = new Set(current.stops.map((st) => st.shop.id));
    const pool = onePerName(scored, inCourse);
    const byId = new Map(pool.map((x) => [x.id, x]));
    const stored = current.stops.map((st) => st.shop.id);
    // The client sends the stops it shows (they differ from the stored ones after an undo). Use them if every one is
    // a shop we know; otherwise fall back to the stored course.
    const known = (id: string) => byId.has(id) || stored.includes(id);
    const ids = stopIds?.length && stopIds.length <= MAX_STOPS && stopIds.every(known) ? stopIds : stored;
    // The prompt to the assistant numbers the stops as shown.
    const shown = ids === stored ? current : this.rebuild({ courseId, variantIndex, req, result: row.result, current, styleIds: req.styles ?? [], pool, byId, ids }, ids);
    return { courseId, variantIndex, req, result: row.result, current: shown, styleIds: req.styles ?? [], pool, byId, ids };
  }

  /** One edit on a list of shop ids → the new list and a short message for the user. */
  async applyEdit(ctx: EditContext, start: string[], edit: CourseEditInput): Promise<{ ids: string[]; message: string }> {
    let ids = [...start];
    const at = (order?: number | null) => {
      const i = (order ?? 0) - 1;
      if (i < 0 || i >= ids.length) throw new BadRequestException(`${order ?? '?'}번 가게가 코스에 없어요`);
      return i;
    };
    switch (edit.op) {
      case 'remove': {
        if (ids.length <= 1) throw new BadRequestException('마지막 한 곳은 뺄 수 없어요');
        const i = at(edit.order);
        const name = this.nameOf(ctx, ids[i]);
        ids.splice(i, 1);
        return this.reordered(ctx, ids, `${obj(name)} 뺐어요`);
      }
      case 'move': {
        const from = at(edit.order);
        const to = Math.max(0, Math.min(ids.length - 1, (edit.toOrder ?? 1) - 1));
        const [id] = ids.splice(from, 1);
        ids.splice(to, 0, id);
        return { ids, message: `${obj(this.nameOf(ctx, id))} ${to + 1}번으로 옮겼어요` };
      }
      case 'first': {
        // "1번으로": that shop is walked to first, then the rest in the shortest order from it (and on to the end).
        const i = at(edit.order);
        const [id] = ids.splice(i, 1);
        const rest = shortestOrder(this.pos(ctx, id), ids.map((x) => ({ id: x, ...this.pos(ctx, x) })), ctx.req.end);
        const changed = rest.some((x, k) => x !== ids[k]);
        const message = `${obj(this.nameOf(ctx, id))} 1번으로 옮겼어요`;
        return { ids: [id, ...rest], message: changed ? `${message} · 걷는 순서도 다시 맞췄어요` : message };
      }
      case 'swap': {
        // Two stops trade places (a number dropped on another on the map); the rest stay where they are.
        const i = at(edit.order);
        const j = at(edit.toOrder);
        if (i === j) return { ids, message: '그대로예요' };
        [ids[i], ids[j]] = [ids[j], ids[i]];
        return { ids, message: `${i + 1}번 ${this.nameOf(ctx, ids[j])} ↔ ${j + 1}번 ${this.nameOf(ctx, ids[i])} 순서를 바꿨어요` };
      }
      case 'reverse': {
        if (ids.length < 2) return { ids, message: '그대로예요' };
        ids.reverse();
        return { ids, message: '코스를 거꾸로 걸어요' };
      }
      case 'replace': {
        const i = at(edit.order);
        const pick = edit.shopId ? await this.chosen(ctx, ids, edit.shopId) : this.bestFor(ctx, ids, i, edit);
        if (!pick) throw new BadRequestException(this.noneMessage(edit));
        const old = this.nameOf(ctx, ids[i]);
        ids[i] = pick.id;
        return this.reordered(ctx, ids, `${old} 대신 ${pick.name}`);
      }
      case 'add': {
        if (ids.length >= MAX_STOPS) throw new BadRequestException(`${MAX_STOPS}곳까지만 넣을 수 있어요`);
        const pick = edit.shopId ? await this.chosen(ctx, ids, edit.shopId) : this.bestFor(ctx, ids, null, edit);
        if (!pick) throw new BadRequestException(this.noneMessage(edit));
        ids.splice(this.cheapestSlot(ctx.req.origin, ids.map((x) => this.pos(ctx, x)), pick), 0, pick.id);
        return this.reordered(ctx, ids, `${obj(pick.name)} 넣었어요`);
      }
      case 'replan': {
        // "좀 더 가깝게" / "취향 위주로": same pool and count, re-optimised with that variant's weighting.
        const prefer = edit.prefer === 'taste' ? 'taste' : 'nearby';
        const pool = [...ctx.pool].sort((a, b) => b.value - a.value).slice(0, MAX_CANDIDATES);
        // Pinned shops stay in a re-plan (they join the pool even if they'd rank lower).
        const pins = new Set((ctx.req.mustShops ?? []).map((m) => m.id).filter((id) => ids.includes(id)));
        // A brand asked for in the conditions stays like a pin: the course's shop carrying it.
        for (const b of ctx.req.brands ?? []) {
          const carrier = ids.find((id) => ctx.byId.get(id)?.brand_keys?.includes(b.key));
          if (carrier) pins.add(carrier);
        }
        for (const id of pins) if (!pool.some((s) => s.id === id)) pool.push(ctx.byId.get(id) ?? this.kept(ctx, id));
        const res = await this.optimize(ctx.req.origin, oneStorePerBrand(pool, pins), ids.length, NO_TIME_LIMIT_MIN, true, pins, {
          clock: storedClock(ctx.req.startAt), end: ctx.req.end,
        });
        ids = (res.find((x) => x.variant === prefer) ?? res[0]).stop_ids;
        return { ids, message: prefer === 'nearby' ? '더 가까운 가게 위주로 다시 짰어요' : '취향에 더 맞는 가게 위주로 다시 짰어요' };
      }
      default:
        throw new BadRequestException(`모르는 고치기예요: ${edit.op}`);
    }
  }

  /** Middle of the course's shops: where "near the course" is measured from. */
  private middle(ctx: EditContext, ids: string[]): LatLngT {
    const pts = ids.map((id) => this.pos(ctx, id));
    if (!pts.length) return ctx.req.origin;
    return { lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length };
  }

  /** A shop the user picked by name or from the map: scored like the rest and added to this edit's pool. */
  private async chosen(ctx: EditContext, ids: string[], shopId: string): Promise<Scored> {
    if (ids.includes(shopId)) throw new BadRequestException('이미 코스에 있는 가게예요');
    const known = ctx.byId.get(shopId);
    if (known) return known;
    const row = /^\d+$/.test(shopId) ? (await this.candidatesById([shopId]))[0] : undefined;
    if (!row) throw new BadRequestException('그 가게를 찾지 못했어요 (문을 닫았거나 정보가 없는 곳일 수 있어요)');
    if (streetM(ctx.req.origin, row) > MUST_MAX_M * 2) throw new BadRequestException(`${topic(row.name)} 이 코스에서 너무 멀어요`);
    const s = this.score(row, ctx.styleIds.map((id) => ({ id, weight: 1 })), ctx.req.budget ?? 'any', ctx.req.items ?? [], null, ctx.req.brands ?? []);
    ctx.byId.set(s.id, s);
    ctx.pool.push(s);
    return s;
  }

  /**
   * After the set of shops changes (replace / add / remove) the walk is re-ordered to be as short as possible from the
   * start. A "move", "swap" or "reverse" is the user's own order and is left alone ("first" re-orders only the rest).
   */
  private reordered(ctx: EditContext, ids: string[], message: string): { ids: string[]; message: string } {
    const best = shortestOrder(ctx.req.origin, ids.map((id) => ({ id, ...this.pos(ctx, id) })), ctx.req.end);
    const changed = best.some((id, i) => id !== ids[i]);
    return { ids: best, message: changed ? `${message} · 걷는 순서도 다시 맞췄어요` : message };
  }

  async saveEdit(ctx: EditContext, variant: CourseVariant, edits: object[]): Promise<void> {
    const result = [...ctx.result];
    const before = ctx.result[ctx.variantIndex];
    result[ctx.variantIndex] = variant;
    const log = edits.map((e) => ({ ...e, variant: ctx.variantIndex, at: new Date().toISOString() }));
    // The version before goes on the undo stack (the newest UNDO_KEEP), unless the edit changed nothing to undo.
    const step = routeKey(before) === routeKey(variant) ? null : JSON.stringify([{ variant: ctx.variantIndex, before }]);
    await this.db.pool.query(
      `UPDATE courses SET result = $2, edits = edits || $3::jsonb,
              undo = CASE WHEN $4::jsonb IS NULL THEN undo ELSE (
                SELECT coalesce(jsonb_agg(e ORDER BY i), '[]'::jsonb)
                FROM jsonb_array_elements(undo || $4::jsonb) WITH ORDINALITY AS x(e, i)
                WHERE i > jsonb_array_length(undo || $4::jsonb) - ${UNDO_KEEP}) END
       WHERE id = $1`,
      [ctx.courseId, JSON.stringify(result), JSON.stringify(log), step],
    );
  }

  /** "이 코스 어땠어요?" after a walk: one rating per person and course (asked again = changed). */
  async rate(courseId: string, userId: string, rating: number, note?: string): Promise<boolean> {
    if (!UUID.test(courseId)) throw new BadRequestException('코스를 찾지 못했어요');
    if (![-1, 0, 1].includes(rating)) throw new BadRequestException('평가는 좋았어요·그저 그랬어요·별로였어요 중 하나예요');
    const text = note?.trim() || null;
    if (text && text.length > 300) throw new BadRequestException('한 줄은 300자 안으로 써 주세요');
    const r = await this.db.pool.query(
      `INSERT INTO course_ratings (course_id, user_id, rating, note) SELECT id, $2, $3, $4 FROM courses WHERE id = $1
       ON CONFLICT (course_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, note = coalesce(EXCLUDED.note, course_ratings.note), created_at = now()`,
      [courseId, userId, rating, text],
    );
    if (!r.rowCount) throw new BadRequestException('코스를 찾지 못했어요');
    return true;
  }

  /**
   * 되돌리기: the version before this variant's last edit comes back, on the server too, so a reload doesn't bring the
   * undone edit back. A shared course is copied first, like any edit (its undo stack comes along).
   */
  async undo(courseId: string, variantIndex: number, userId: string | null): Promise<CourseEditResult> {
    if (!UUID.test(courseId)) throw new BadRequestException('코스를 찾지 못했어요');
    const own = await this.editable(courseId, userId);
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query<{ request: StoredRequest; result: CourseVariant[]; undo: { variant: number; before: CourseVariant }[] }>(
        'SELECT request, result, undo FROM courses WHERE id = $1 FOR UPDATE', [own],
      )).rows[0];
      if (!row) throw new BadRequestException('코스를 찾지 못했어요');
      const at = row.undo.map((u) => u.variant).lastIndexOf(variantIndex);
      if (at < 0) throw new BadRequestException('되돌릴 고치기가 없어요');
      const before = row.undo[at].before;
      const result = row.result.map((v, i) => (i === variantIndex ? before : v));
      const log = [{ op: 'undo', variant: variantIndex, at: new Date().toISOString() }];
      await client.query('UPDATE courses SET result = $2, undo = $3, edits = edits || $4::jsonb WHERE id = $1', [
        own, JSON.stringify(result), JSON.stringify(row.undo.filter((_, i) => i !== at)), JSON.stringify(log),
      ]);
      await client.query('COMMIT');
      return { courseId: own, variant: await this.timed(before, storedClock(row.request.startAt)), message: '되돌렸어요', mustShops: row.request.mustShops ?? [] };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Recomputes legs and times for shops in the given order (same walking model as /optimize). */
  rebuild(ctx: EditContext, ids: string[]): CourseVariant {
    const origin = ctx.req.origin;
    const shops = ids.map((id) => ctx.byId.get(id) ?? this.kept(ctx, id));
    let prev: LatLngT = origin;
    const legs = shops.map((s) => {
      const d = streetM(prev, s);
      prev = s;
      return { distance_m: Math.round(d), duration_min: Math.round((d / WALK_M_PER_MIN) * 10) / 10 };
    });
    const end = ctx.req.end;
    const toEnd = end ? Math.round(streetM(prev, end)) : 0;
    const distance = legs.reduce((a, l) => a + l.distance_m, 0) + toEnd;
    const walk = distance / WALK_M_PER_MIN;
    const dwell = shops.reduce((a, s) => a + dwellMin(s.kind), 0);
    return {
      variant: ctx.current.variant,
      label: ctx.current.label,
      stops: this.stops(origin, shops, ctx.styleIds, legs),
      totalDistanceM: distance,
      walkMin: Math.round(walk * 10) / 10,
      totalMin: Math.round((walk + dwell) * 10) / 10,
      endLeg: end ? { distanceM: toEnd, durationMin: Math.round((toEnd / WALK_M_PER_MIN) * 10) / 10, path: [prev, { lat: end.lat, lng: end.lng }] } : undefined,
    };
  }

  /** Best shop for a slot (null = anywhere): value minus the extra walk it adds, honouring "신발 가게로"-type wishes. */
  private bestFor(ctx: EditContext, ids: string[], slot: number | null, edit: CourseEditInput): Scored | null {
    const taken = new Set([...ids, ...(edit.avoid ?? [])]);
    const posList = ids.map((x) => this.pos(ctx, x));
    // One store per brand: no second 아더에러 store next to the one the course keeps.
    const brandsIn = new Set(ids.filter((_, k) => k !== slot).map((id) => storeBrandKey(ctx.byId.get(id) ?? this.kept(ctx, id))).filter(Boolean));
    let best: { s: Scored; score: number } | null = null;
    for (const c of ctx.pool) {
      if (taken.has(c.id) || !this.wants(c, edit)) continue;
      if (brandsIn.has(storeBrandKey(c))) continue;
      let extraM: number;
      if (slot === null) {
        extraM = this.insertCost(ctx.req.origin, posList, this.cheapestSlot(ctx.req.origin, posList, c), c);
      } else {
        // The course is re-ordered after a swap, so judge the new shop by its best place in the walk, not the old slot:
        // walk saved by dropping the old shop vs. walk added by fitting the new one in wherever it fits best.
        const prev = slot === 0 ? ctx.req.origin : posList[slot - 1];
        const next = posList[slot + 1];
        const saved = streetM(prev, posList[slot]) + (next ? streetM(posList[slot], next) - streetM(prev, next) : 0);
        const rest = posList.filter((_, k) => k !== slot);
        extraM = this.insertCost(ctx.req.origin, rest, this.cheapestSlot(ctx.req.origin, rest, c), c) - saved;
        if (extraM > MAX_REPLACE_DETOUR_M) continue;
      }
      const score = c.value - 0.25 * (extraM / 1000);
      if (!best || score > best.score) best = { s: c, score };
    }
    return best?.s ?? null;
  }

  private wants(c: Scored, e: CourseEditInput): boolean {
    if (e.wantCategory && c.category !== e.wantCategory) return false;
    if (e.wantStyle && (c.fit[e.wantStyle] ?? 0) < 5) return false;
    if (e.wantItem && !this.sellsMainly(c, e.wantItem)) return false;
    if (e.wantBudget && c.price_range && c.price_range !== 'unknown' && c.price_range !== e.wantBudget) return false;
    return true;
  }

  /**
   * "신발 가게로" means a shop that is about shoes, not a vintage shop that also has a few pairs. Shoes and bags have
   * their own Kakao / public-data categories, so those (or the name) decide; other items fall back to what the
   * scorer listed for the shop.
   */
  private sellsMainly(c: Scored, item: string): boolean {
    const cats = (c.source_categories ?? []).join(' ');
    if (item === 'shoes') return /구두|신발/.test(cats) || /신발|구두|슈즈|shoe|sneaker/i.test(c.name);
    if (item === 'bag') return /가방/.test(cats) || /가방|bag/i.test(c.name);
    return (c.items ?? []).includes(item);
  }

  private noneMessage(e: CourseEditInput): string {
    const want = [e.wantStyle && STYLE_LABEL[e.wantStyle], e.wantCategory && CATEGORY_LABEL[e.wantCategory], e.wantItem && ITEM_LABEL[e.wantItem]]
      .filter(Boolean)
      .join(' ');
    return want ? `근처에서 ${want} 가게를 더 찾지 못했어요` : '근처에서 바꿀 만한 가게를 더 찾지 못했어요';
  }

  private cheapestSlot(origin: LatLngT, posList: LatLngT[], c: LatLngT): number {
    let best = posList.length;
    let bestCost = Infinity;
    for (let k = 0; k <= posList.length; k++) {
      const cost = this.insertCost(origin, posList, k, c);
      if (cost < bestCost) [best, bestCost] = [k, cost];
    }
    return best;
  }

  private insertCost(origin: LatLngT, posList: LatLngT[], k: number, c: LatLngT): number {
    const prev = k === 0 ? origin : posList[k - 1];
    const next = posList[k];
    return streetM(prev, c) + (next ? streetM(c, next) - streetM(prev, next) : 0);
  }

  private pos(ctx: EditContext, id: string): LatLngT {
    const s = ctx.byId.get(id) ?? this.kept(ctx, id);
    return { lat: s.lat, lng: s.lng };
  }

  private nameOf(ctx: EditContext, id: string): string {
    return (ctx.byId.get(id) ?? this.kept(ctx, id)).name;
  }

  /** A stop no longer in the candidate pool (closed, rescored): rebuilt from its stored card so it still renders. */
  private kept(ctx: EditContext, id: string): Scored {
    const st = ctx.current.stops.find((x) => x.shop.id === id);
    if (!st) throw new BadRequestException('코스의 가게 정보를 찾지 못했어요');
    const sh = st.shop;
    return {
      id, name: sh.name, kind: sh.kind, category: sh.category, gender: null, lat: sh.lat, lng: sh.lng,
      road_address: sh.roadAddress ?? null, summary: sh.summary ?? null, reason_material: null, hours: null, hours_source: null, brand_keys: null,
      price_range: sh.priceRange ?? null, items: null, confidence: null, matched_posts: sh.littleKnown ? 0 : null,
      evidence_at: null, on_kakao: true, place_url: sh.placeUrl ?? null, source_categories: null,
      scores: Object.fromEntries(sh.topStyles.map((t) => [t.style, t.score])),
      value: 0, fit: {}, keptReason: st.reason,
    };
  }

  // ---------- shared ----------

  /**
   * "다른 코스": what to keep of the course on screen — every shop the user saved, then the best-fitting ones, about a
   * quarter of the course (at least one), never all of it. The rest drops back as before so the course does change.
   */
  private keyShops(shown: string[], fresh: Scored[], personal: Personal | null, room: number): string[] {
    const byId = new Map(fresh.map((s) => [s.id, s]));
    const present = shown.filter((id) => byId.has(id));
    if (present.length < 2 || room < 2) return [];
    const quota = Math.min(room - 1, present.length - 1, Math.max(1, Math.ceil(present.length * KEEP_SHARE)));
    const liked = present.filter((id) => personal?.liked.has(id));
    const best = present.filter((id) => !liked.includes(id)).sort((a, b) => byId.get(b)!.value - byId.get(a)!.value);
    // Saved shops stay too, but never more than the room the pinned shops leave (they come first).
    return [...liked, ...best].slice(0, Math.min(room - 1, Math.max(quota, Math.min(liked.length, present.length - 1))));
  }

  /** "X·Y는 그대로 두고 나머지를 바꿨어요" / "꼭 넣을 가게 Z는 시간 안에 넣지 못했어요". */
  private mustNote(ids: string[], mustIds: string[], kept: string[], byId: Map<string, Scored>): string | undefined {
    const name = (id: string) => byId.get(id)?.name;
    const keptIn = kept.filter((id) => ids.includes(id)).map(name).filter(Boolean) as string[];
    const missed = mustIds.filter((id) => !ids.includes(id)).map(name).filter(Boolean) as string[];
    const parts = [
      keptIn.length ? `${topic(keptIn.join('·'))} 그대로 두고 나머지를 바꿨어요` : '',
      missed.length ? `${topic(missed.join('·'))} 시간 안에 넣지 못했어요` : '',
    ];
    return parts.filter(Boolean).join(' · ') || undefined;
  }

  private async optimize(
    origin: LatLngT, pool: Scored[], stopCount: number, timeBudgetMin: number, exact: boolean, must: Set<string> = new Set(),
    opts: { clock?: Clock; end?: LatLngT; distanceScale?: number; firstId?: string } = {},
  ) {
    const res = await this.model.post<{ courses: ModelCourse[] }>('/optimize', {
      origin,
      candidates: pool.map((s) => {
        // Hours known: the optimiser reaches the shop only while it's open — a pinned shop too, so one that opens at 12
        // isn't the first stop of a 10:00 walk. A pinned shop closed all through the course has no window and stays in
        // (its card says it's closed then).
        const w = opts.clock ? windowFor(s.hours, opts.clock, timeBudgetMin) : null;
        return {
          id: s.id, lat: s.lat, lng: s.lng, value: Number(s.value.toFixed(4)), dwell_min: dwellMin(s.kind), ...(must.has(s.id) ? { must: true } : {}),
          ...(w && w !== 'closed' ? { open_from: Math.round(w.from), open_until: Math.round(w.until) } : {}),
        };
      }),
      stop_count: stopCount,
      time_budget_min: timeBudgetMin,
      exact_count: exact,
      ...(opts.end ? { end: { lat: opts.end.lat, lng: opts.end.lng } } : {}),
      ...(opts.distanceScale && opts.distanceScale !== 1 ? { distance_scale: opts.distanceScale } : {}),
      ...(opts.firstId ? { first_id: opts.firstId } : {}),
    });
    return res.courses;
  }

  /** Course cards for shops in order, with legs from /optimize or recomputed. */
  private stops(origin: LatLngT, shops: Scored[], styleIds: string[], legs: { distance_m: number; duration_min: number }[]): CourseStop[] {
    let prev = origin;
    return shops.map((s, i) => {
      const here = { lat: s.lat, lng: s.lng };
      const stop: CourseStop = {
        order: i + 1,
        shop: {
          id: s.id, name: s.name, kind: s.kind, category: s.category, lat: s.lat, lng: s.lng,
          roadAddress: s.road_address ?? undefined, placeUrl: s.place_url ?? undefined,
          summary: s.summary ?? undefined, priceRange: s.price_range ?? undefined,
          topStyles: Object.entries(s.scores ?? {})
            .filter(([, v]) => v >= 5)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([style, score]) => ({ style, score })),
          littleKnown: s.matched_posts === 0 || (s.evidence_at !== null && !s.matched_posts),
        },
        brands: s.brandHit ?? [],
        reason: s.keptReason ?? this.reason(s, styleIds),
        legFromPrev: { distanceM: legs[i].distance_m, durationMin: legs[i].duration_min, path: [prev, here] },
      };
      prev = here;
      return stop;
    });
  }

  /**
   * Regions ranked for the brands asked for: the most of them first (all in one walk beats one each), then how many
   * shops carry them (a brand's own store counts more than a select shop stocking it), then room for a full course.
   * Returns nothing when the place chosen already has as many of the brands as the best region, or none has any.
   * picked = no place was chosen (only the map's view), so the course moves there; otherwise they're suggestions.
   */
  private async brandRegionsFor(input: CourseRequestInput, brands: BrandRef[], stopCount: number): Promise<{ picked: boolean; regions: BrandRegion[] } | undefined> {
    const o = input.origin;
    const unplaced = !o.regionId && !o.gps && !o.label?.trim() && !input.mustShopIds?.length;
    if (o.regionId || (!unplaced && !o.gps)) return undefined;
    const keys = brands.map((b) => b.key);
    const rows = (
      await this.db.pool.query<{ id: string; name: string; shop_count: number; brand_key: string; shops: number; own: number }>(
        `SELECT g.id::text, g.name, g.shop_count, b.brand_key, count(DISTINCT s.id)::int AS shops,
                count(DISTINCT s.id) FILTER (WHERE s.category = 'brand')::int AS own
           FROM shop_brands b
           JOIN shops s ON s.id = b.shop_id AND s.status = 'candidate' AND s.category IS NOT NULL AND s.category <> 'excluded'
           JOIN regions g ON ST_Intersects(g.polygon, s.geom)
          WHERE b.brand_key = ANY($1)
          GROUP BY 1, 2, 3, 4`,
        [keys],
      )
    ).rows;
    const byRegion = new Map<string, { id: string; name: string; size: number; keys: Set<string>; shops: number; weight: number }>();
    for (const r of rows) {
      const g = byRegion.get(r.id) ?? { id: r.id, name: r.name, size: r.shop_count, keys: new Set<string>(), shops: 0, weight: 0 };
      g.keys.add(r.brand_key);
      g.shops += r.shops;
      // Past three shops of one brand a region isn't much better for it.
      g.weight += Math.min(3, r.shops + 0.5 * r.own);
      byRegion.set(r.id, g);
    }
    const score = (g: { keys: Set<string>; weight: number; size: number }) =>
      g.keys.size * 1000 + g.weight * 10 + Math.min(1, g.size / (stopCount * 4)) * 5;
    const ranked = [...byRegion.values()].sort((a, b) => score(b) - score(a));
    if (!ranked.length) return undefined;
    // Already where the brands are: the shops in view (or within 1.5 km of "내 위치") carry as many of them.
    const here = o.bounds && unplaced ? usableBox(o.bounds) : undefined;
    const p = o.gps ?? o.point;
    if (here || p) {
      const near = await this.db.pool.query<{ n: number }>(
        `SELECT count(DISTINCT b.brand_key)::int AS n
           FROM shop_brands b JOIN shops s ON s.id = b.shop_id AND s.status = 'candidate' AND s.category IS NOT NULL AND s.category <> 'excluded'
          WHERE b.brand_key = ANY($1) AND ${
            here ? 'ST_Intersects(s.geom, ST_MakeEnvelope($2, $3, $4, $5, 4326)::geography)' : 'ST_DWithin(s.geom, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, 1500)'
          }`,
        here ? [keys, here.swLng, here.swLat, here.neLng, here.neLat] : [keys, p!.lng, p!.lat],
      );
      if ((near.rows[0]?.n ?? 0) >= ranked[0].keys.size) return undefined;
    }
    const nameOf = new Map(brands.map((b) => [b.key, b.name]));
    return {
      picked: unplaced,
      regions: ranked.slice(0, 3).map((g) => ({ id: g.id, name: g.name, brands: keys.filter((k) => g.keys.has(k)).map((k) => nameOf.get(k)!), shops: g.shops })),
    };
  }

  /** Region and brand names of the brand regions in English. */
  private async brandRegionsEn(regions: BrandRegion[], brands: BrandRef[], brandsEn: Map<string, string>): Promise<BrandRegion[]> {
    const tr = await inLang(this.db.pool, regions.map((r) => r.name));
    const en = new Map(brands.map((b) => [b.name, b.nameEn ?? brandsEn.get(b.name) ?? b.name]));
    return regions.map((r) => ({ ...r, name: tr.get(r.name) ?? r.name, brands: r.brands.map((b) => en.get(b) ?? b) }));
  }

  private async resolveOrigin(input: CourseRequestInput) {
    const { gps, point, regionId, label } = input.origin;
    if (regionId) {
      const r = await this.db.pool.query(
        `SELECT name, ST_Y(center::geometry) AS lat, ST_X(center::geometry) AS lng FROM regions WHERE id = $1`,
        [regionId],
      );
      if (!r.rows[0]) throw new BadRequestException('지역을 찾지 못했어요');
      const { name, lat, lng } = r.rows[0];
      // The centre for now; plan() moves the start to the station nearest the chosen shops.
      return { origin: { lat, lng }, regionId, regionName: name as string, startName: undefined as string | undefined };
    }
    const p = gps ?? point;
    if (!p) throw new BadRequestException('출발점을 정해 주세요 (내 위치, 지역, 지도에서 고르기)');
    const named = label?.trim().slice(0, 30);
    return {
      origin: { lat: p.lat, lng: p.lng },
      regionId: undefined,
      regionName: named ? `${named} 근처` : undefined,
      startName: named || (gps ? '내 위치' : undefined),
    };
  }

  /** Kakao category search for the subway station (SW8) nearest a point, within 1.2 km. Cached per ~100 m cell. */
  /**
   * A name for a point picked on the map ("고른 곳" says nothing on the course): the subway station within a few
   * hundred metres, else the building there, else the neighbourhood (Kakao). undefined when Kakao can't say.
   */
  async nameOfPoint(p: LatLngT): Promise<string | undefined> {
    const key = this.config.get<string>('KAKAO_REST_API_KEY');
    if (!key) return undefined;
    const get = async <T>(path: string, q: Record<string, string>): Promise<T | undefined> => {
      try {
        const res = await fetch(`https://dapi.kakao.com${path}?${new URLSearchParams(q)}`, {
          headers: { Authorization: `KakaoAK ${key}` },
          signal: AbortSignal.timeout(3000),
        });
        return res.ok ? ((await res.json()) as T) : undefined;
      } catch {
        return undefined;
      }
    };
    const xy = { x: String(p.lng), y: String(p.lat) };
    const st = await get<{ documents: { place_name: string }[] }>('/v2/local/search/category.json', {
      ...xy, category_group_code: 'SW8', radius: String(PICKED_STATION_M), sort: 'distance',
    });
    if (st?.documents[0]) return st.documents[0].place_name.split(' ')[0];
    const addr = await get<{ documents: { road_address?: { building_name?: string } | null; address?: { region_3depth_name?: string } | null }[] }>(
      '/v2/local/geo/coord2address.json', xy,
    );
    const d = addr?.documents[0];
    return d?.road_address?.building_name || d?.address?.region_3depth_name || undefined;
  }

  private async stationNear(center: LatLngT): Promise<{ lat: number; lng: number; name: string } | null> {
    const cacheKey = `${center.lat.toFixed(3)},${center.lng.toFixed(3)}`;
    if (this.stations.has(cacheKey)) return this.stations.get(cacheKey)!;
    const key = this.config.get<string>('KAKAO_REST_API_KEY');
    let found: { lat: number; lng: number; name: string } | null = null;
    if (key) {
      const q = new URLSearchParams({
        category_group_code: 'SW8', x: String(center.lng), y: String(center.lat), radius: String(STATION_RADIUS_M), sort: 'distance',
      });
      try {
        const res = await fetch(`https://dapi.kakao.com/v2/local/search/category.json?${q}`, {
          headers: { Authorization: `KakaoAK ${key}` },
          signal: AbortSignal.timeout(4000),
        });
        const doc = res.ok ? ((await res.json()) as { documents: { place_name: string; x: string; y: string }[] }).documents[0] : undefined;
        // "성수역 2호선" → "성수역"
        if (doc) found = { lat: Number(doc.y), lng: Number(doc.x), name: doc.place_name.split(' ')[0] };
      } catch {
        found = null; // no network / quota: start from the centre, try again next time
        return null;
      }
    }
    this.stations.set(cacheKey, found);
    return found;
  }

  /** Rows for given shops wherever they are ("꼭 넣을 가게" outside the searched area). */
  private async candidatesById(ids: string[]): Promise<Row[]> {
    const r = await this.db.pool.query<Row>(`${CANDIDATE_SELECT} AND s.id = ANY($1::bigint[])`, [ids]);
    return r.rows.map(tidy);
  }

  private async candidates(origin: LatLngT, regionId: string | undefined, stopCount: number, bounds?: Box): Promise<Row[]> {
    const select = CANDIDATE_SELECT;
    if (regionId) {
      const r = await this.db.pool.query<Row>(
        `${select} AND EXISTS (SELECT 1 FROM regions g WHERE g.id = $1 AND ST_Intersects(g.polygon, s.geom))`,
        [regionId],
      );
      return r.rows.map(tidy);
    }
    if (bounds) {
      // Only what the map shows: "지도 가운데서 코스 짜기" shouldn't walk off the screen.
      const r = await this.db.pool.query<Row>(
        `${select} AND ST_Intersects(s.geom, ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography)`,
        [bounds.swLng, bounds.swLat, bounds.neLng, bounds.neLat],
      );
      return r.rows.map(tidy);
    }
    for (const radius of SEARCH_RADIUS_M) {
      const r = await this.db.pool.query<Row>(
        `${select} AND ST_DWithin(s.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)`,
        [origin.lng, origin.lat, radius],
      );
      if (r.rows.length >= stopCount * 3 || radius === SEARCH_RADIUS_M[SEARCH_RADIUS_M.length - 1]) return r.rows.map(tidy);
    }
    return [];
  }

  /**
   * value 0-1 = 60% style fit + 20% popularity + 20% confidence, nudged by budget, wanted items and the user's own
   * history (saved / liked shops up, and with no styles chosen, a lean towards the styles of shops they liked).
   */
  private score(
    r: Row, styles: { id: string; weight: number }[], budget: string, items: string[], personal: Personal | null = null, brands: BrandRef[] = [],
  ): Scored {
    const known = r.scores && Object.keys(r.scores).length ? r.scores : null;
    const fit = known ?? CATEGORY_PRIOR[r.category] ?? {};
    const taste = personal && personal.taste.signals >= MIN_SIGNALS ? personal.taste : null;
    const tf = taste ? tasteFit(taste, fit) : null; // -1..1
    let fitScore: number;
    if (styles.length) {
      const total = styles.reduce((a, s) => a + s.weight, 0);
      fitScore = styles.reduce((a, s) => a + s.weight * ((fit[s.id] ?? 0) / 10), 0) / total;
      if (!known) fitScore *= 0.8; // a guess from the category is worth less than a real score
      if (tf !== null) fitScore = (1 - TASTE_SHARE_WITH_STYLES) * fitScore + TASTE_SHARE_WITH_STYLES * ((tf + 1) / 2);
    } else if (tf !== null) {
      fitScore = (1 - TASTE_SHARE_ALONE) * (CATEGORY_APPEAL[r.category] ?? 0.3) + TASTE_SHARE_ALONE * ((tf + 1) / 2);
    } else {
      fitScore = CATEGORY_APPEAL[r.category] ?? 0.3;
    }
    const popularity = r.matched_posts == null ? 0.2 : Math.min(1, Math.log1p(r.matched_posts) / Math.log(31));
    const confidence = r.confidence ?? (r.on_kakao ? 0.45 : 0.25);
    let value = 0.6 * fitScore + 0.2 * popularity + 0.2 * confidence;
    // Budget: known price range that matches helps, a clear mismatch hurts. Unknown stays neutral.
    if (budget !== 'any' && r.price_range && r.price_range !== 'unknown') value += r.price_range === budget ? 0.08 : -0.1;
    // Items ("데님 위주"): share of wanted items the shop is known to sell.
    if (items.length && r.items?.length) value += 0.12 * (items.filter((i) => r.items!.includes(i)).length / items.length);
    if (personal?.liked.has(r.id)) value += 0.1;
    // Brands ("아더에러 파는 데"): carrying what was asked for counts about as much as a strong style match.
    const brandHit = brands.filter((b) => r.brand_keys?.includes(b.key)).map((b) => b.name);
    if (brands.length) value += brandHit.length ? 0.25 + 0.15 * (brandHit.length / brands.length) : 0;
    if (taste) {
      if (budget === 'any' && taste.price && r.price_range === taste.price) value += PRICE_MATCH_BONUS;
      // Something new each time: their own recent course shops step back, unmet shops that fit step up.
      if (taste.recent.has(r.id) && !personal!.liked.has(r.id)) value *= RECENT_FACTOR;
      else if (tf !== null && tf > 0.25 && !taste.known.has(r.id)) value += NEW_MATCH_BONUS;
    }
    return { ...r, fit, value: Math.max(0, Math.min(1, value)), brandHit: brandHit.length ? brandHit : undefined };
  }

  /** One line on how the taste profile shaped this course (shown under the course title). */
  private tasteNote(personal: Personal | null, stylesChosen: boolean): string | undefined {
    const taste = personal?.taste;
    if (!taste || taste.signals < MIN_SIGNALS) return undefined;
    const { likes, avoids } = tasteSummary(taste);
    const parts: string[] = [];
    if (likes.length) parts.push(`${likes.slice(0, 2).map(([s]) => STYLE_LABEL[s] ?? s).join('·')} 쪽으로${stylesChosen ? ' 조금 더' : ''}`);
    if (avoids.length) parts.push(`${topic(STYLE_LABEL[avoids[0][0]] ?? avoids[0][0])} 덜`);
    if (taste.recent.size) parts.push('최근 코스의 가게는 줄이고 새 가게를 섞었어요');
    return parts.length ? `취향 반영: ${parts.join(' · ')}` : undefined;
  }

  private reason(s: Scored, chosen: string[]): string {
    const best = chosen
      .map((id) => ({ id, score: s.scores?.[id] ?? 0 }))
      .filter((x) => x.score >= 5)
      .sort((a, b) => b.score - a.score)[0];
    const parts: string[] = [];
    if (s.brandHit?.length) parts.push(`${s.brandHit.join('·')} ${s.category === 'brand' ? '매장' : '취급'}`);
    if (best) parts.push(`${STYLE_LABEL[best.id]} ${best.score}점`);
    parts.push(s.reason_material || s.summary || CATEGORY_LABEL[s.category] || '옷가게');
    return parts.join(' · ');
  }
}

/**
 * "내 위치" is kept only to a ~200 m cell (0.002° lat × 0.0025° lng) before planning: the course, its walking path
 * and its share link would otherwise show exactly where someone stood, often their home.
 */
/** What localizeMany fetched up front for a list of courses. */
interface ShopText { id: string; category: string; summary: string | null; reason_material: string | null; scores: Record<string, number> | null }
interface Prefetch {
  rows: Map<string, ShopText>;
  hours: Map<string, { hours: HoursDay[] | null; source: 'owner' | 'blog' | null }>;
  news: Map<string, string>;
  brandsEn: Map<string, string>;
}

// Undo keeps this many earlier versions per course (all variants together).
const UNDO_KEEP = 30;

/** What an edit can change: the shops in order and the breaks. Same key = nothing to undo. */
export function routeKey(v: CourseVariant | undefined): string {
  if (!v) return '';
  return JSON.stringify([v.stops.map((s) => s.shop.id), (v.breaks ?? []).map((b) => `${b.kind}:${b.name}:${b.afterOrder}`)]);
}

/** A brand store's brand (the key oneStorePerBrand compares); undefined for shops that aren't one brand's store. */
function storeBrandKey(s: Scored): string | undefined {
  return s.category === 'brand' ? s.brand_keys?.[0] : undefined;
}

/** "18시까지" from the base course still makes sense for a group course starting at `startAt` (or now). */
function endStillAhead(startAt: string | undefined, endBy: string): boolean {
  try {
    minutesUntil(clockAt(startAt), endBy);
    return true;
  } catch {
    return false;
  }
}

function coarseGps(input: CourseRequestInput): CourseRequestInput {
  const g = input.origin?.gps;
  if (!g) return input;
  const snap = (x: number, cell: number) => Number((Math.round(x / cell) * cell).toFixed(4));
  return { ...input, origin: { ...input.origin, gps: { ...g, lat: snap(g.lat, 0.002), lng: snap(g.lng, 0.0025) } } };
}
