import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULTS, ITEMS, STYLES, STYLE_IDS } from '@cr/shared';
import { DbService } from '../infra/db.service';
import { ModelClient } from '../infra/model.client';
import { TransitService } from '../infra/transit.service';
import { WalkService } from '../infra/walk.service';
import { MeService, type Personal } from '../me/me.service';
import { CATEGORY_PRIOR, MIN_SIGNALS, tasteFit, tasteSummary } from '../me/taste';
import { type HoursDay, openAt, seoulNow } from '../owners/owners.service';
import { cleanName } from '../shops/names';
import { searchShops } from '../shops/search';
import { DISPLAY_NAME_SQL } from '../shops/shops.resolver';
import { BreakStop, Course, CourseEditInput, CourseEditResult, CourseLink, CourseRequestInput, CourseStop, CourseVariant } from './course.model';

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

const INPUT_MODES = new Set(['buttons', 'here', 'point', 'text', 'photo', 'preset', 'again']);
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
const STATION_RADIUS_M = 1200;

interface Box { swLat: number; swLng: number; neLat: number; neLng: number }
const usableBox = (b?: Box | null): Box | undefined =>
  b && b.neLat > b.swLat && b.neLng > b.swLng && b.neLat - b.swLat <= MAX_BOUNDS_DEG && b.neLng - b.swLng <= MAX_BOUNDS_DEG * 1.3 ? b : undefined;
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

/**
 * Shortest open walk from the origin through all points (order only, the set is fixed). Up to 8 stops every order is
 * tried (8! = 40,320); longer courses start nearest-first and are improved with 2-opt.
 */
export function shortestOrder(origin: LatLngT, pts: (LatLngT & { id: string })[]): string[] {
  const n = pts.length;
  if (n <= 2) {
    if (n === 2 && streetM(origin, pts[1]) + streetM(pts[1], pts[0]) < streetM(origin, pts[0]) + streetM(pts[0], pts[1])) {
      return [pts[1].id, pts[0].id];
    }
    return pts.map((p) => p.id);
  }
  const d = (a: LatLngT, b: LatLngT) => streetM(a, b);
  const length = (order: number[]) => order.reduce((acc, k, i) => acc + d(i === 0 ? origin : pts[order[i - 1]], pts[k]), 0);
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

/** Shops the user marked 별로였어요 or reported closed never come back; visited ones only when asked to skip them. */
/**
 * A shop whose owner says it's closed now and still closed an hour from now isn't worth walking to. Courses start
 * now; shops without hours (most) stay, marked "영업시간 확인 필요" on their card.
 */
function openSoon(r: Row): boolean {
  if (!r.hours) return true;
  const now = seoulNow();
  const later = (now.minutes + 60) % 1440;
  const laterDay = now.minutes + 60 >= 1440 ? (now.day + 1) % 7 : now.day;
  return openAt(r.hours, now.day, now.minutes) !== false || openAt(r.hours, laterDay, later) !== false;
}

/** "오늘 11:00–21:00" / "오늘 쉬는 날" for a course card, from owner hours. */
function hoursToday(hours: HoursDay[] | null): string | undefined {
  const today = hours?.[seoulNow().day];
  if (!today) return undefined;
  return today.closed ? '오늘 쉬는 날' : today.open && today.close ? `오늘 ${today.open}–${today.close}` : undefined;
}

// One candidate row per shop, with its scores, sources and owner hours.
const CANDIDATE_SELECT = `
      SELECT s.id::text, ${DISPLAY_NAME_SQL} AS name, s.kind, s.category, s.gender, ST_Y(s.geom::geometry) AS lat, ST_X(s.geom::geometry) AS lng,
             s.road_address, s.summary, s.reason_material, s.price_range, s.items, s.confidence, s.matched_posts, s.evidence_at,
             EXISTS (SELECT 1 FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao') AS on_kakao,
             (SELECT r.payload->>'place_url' FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao' LIMIT 1) AS place_url,
             (SELECT jsonb_object_agg(style_id, score) FROM shop_style_scores x WHERE x.shop_id = s.id) AS scores,
             (SELECT array_agg(DISTINCT r.category_name) FROM raw_sources r WHERE r.shop_id = s.id) AS source_categories,
             (SELECT oi.hours FROM shop_owner_info oi WHERE oi.shop_id = s.id) AS hours
      FROM shops s
      WHERE s.status = 'candidate' AND s.category IS NOT NULL AND s.category <> 'excluded'`;

function keep(r: Row, personal: Personal | null, skipVisited: boolean): boolean {
  if (!openSoon(r)) return false;
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
  /** Owner-entered weekly hours (owners/), Mon..Sun; null for most shops. */
  hours: HoursDay[] | null;
}

interface Scored extends Row {
  value: number;
  fit: Record<string, number>;
  /** A stop kept from the stored course (shop left the pool since): its stored reason line. */
  keptReason?: string;
}

interface ModelCourse {
  variant: string;
  stop_ids: string[];
  legs: { distance_m: number; duration_min: number }[];
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
    },
    origin: q.origin,
    startName: q.startName,
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
  ) {}

  /**
   * Swaps the straight-line legs for real walking routes (T map) where available and recomputes the totals.
   * Optimisation itself keeps using straight-line × 1.3; only the course shown gets the real streets.
   */
  async withStreets(origin: LatLngT, v: CourseVariant): Promise<CourseVariant> {
    if (!this.walk.enabled || !v.stops.length) return v;
    const legs = await this.walk.legs([origin, ...v.stops.map((s) => ({ lat: s.shop.lat, lng: s.shop.lng }))]);
    if (legs.every((l) => !l)) return v;
    const stops = v.stops.map((s, i) => (legs[i] ? { ...s, legFromPrev: legs[i]! } : s));
    const distance = stops.reduce((a, s) => a + s.legFromPrev.distanceM, 0);
    const walkMin = Math.round(stops.reduce((a, s) => a + s.legFromPrev.durationMin, 0) * 10) / 10;
    const dwell = stops.reduce((a, s) => a + dwellMin(s.shop.kind), 0);
    return { ...v, stops, totalDistanceM: distance, walkMin, totalMin: Math.round((walkMin + dwell) * 10) / 10 };
  }

  /** Nearest subway station per region (looked up once per process). */
  private readonly stations = new Map<string, { lat: number; lng: number; name: string } | null>();

  async plan(input: CourseRequestInput, userId: string | null = null): Promise<Course> {
    const t0 = Date.now();
    const defaulted: string[] = [];
    const styles = (input.styles ?? []).filter((s) => STYLE_IDS.includes(s.id) && s.weight > 0);
    if (!input.styles?.length) defaulted.push('styles');
    const maxStops = input.maxStops === true;
    let stopCount: number;
    if (maxStops) stopCount = MAX_STOPS;
    else if (input.stopCount != null) stopCount = Math.min(MAX_STOPS, Math.max(MIN_STOPS, Math.round(input.stopCount)));
    else stopCount = (defaulted.push('stopCount'), DEFAULTS.stopCount);
    // A stop count the user chose wins over the default time: plan all of them and let the time follow.
    // Only a time the user chose themselves limits the count.
    const timeChosen = input.timeBudgetMin != null && input.timeBudgetMin >= 30 && input.timeBudgetMin <= 720;
    const countChosen = !maxStops && input.stopCount != null;
    let timeBudgetMin: number;
    if (timeChosen) timeBudgetMin = Math.round(input.timeBudgetMin!);
    else {
      defaulted.push('timeBudgetMin');
      timeBudgetMin = countChosen ? NO_TIME_LIMIT_MIN : DEFAULTS.timeBudgetMin;
    }

    const budget = ['low', 'mid', 'high'].includes(input.budget ?? '') ? input.budget! : 'any';
    const itemIds = new Set(ITEMS.map((i) => i.id));
    const items = (input.items ?? []).filter((i) => itemIds.has(i));

    const resolved = await this.resolveOrigin(input);
    const { regionId, regionName } = resolved;
    let { origin, startName } = resolved;
    const bounds = regionId ? undefined : usableBox(input.origin.bounds);
    const personal = userId ? await this.me.personal(userId) : null;
    const skipVisited = input.skipVisited === true;
    const asked = [...new Set((input.mustShopIds ?? []).filter((id) => /^\d+$/.test(id)))].slice(0, Math.min(MAX_MUST, stopCount));
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
    const rows = pool.filter((r) => mustIds.includes(r.id) || (keep(r, personal, skipVisited) && genderFit(r, gender) > 0));
    if (!rows.length) {
      throw new BadRequestException(
        bounds ? '지금 지도 화면 안에는 추천할 가게가 없어요. 지도를 옮기거나 조금 넓혀 주세요' : '이 근처에서 추천할 가게를 찾지 못했어요. 다른 지역을 골라 주세요',
      );
    }

    // "같은 조건으로 다른 코스": shops the user was just shown drop back (not out, so small areas still fill a course).
    const seen = new Set((input.seenShopIds ?? []).slice(0, 200));
    const fresh = rows.map((r) => {
      const s = this.score(r, styles, budget, items, personal);
      return mustIds.includes(r.id) ? s : { ...s, value: s.value * genderFit(r, gender) };
    });
    const kept = this.keyShops(input.keepShopIds ?? [], fresh, personal, mustIds.length ? stopCount - mustIds.length : stopCount);
    const must = new Set([...mustIds, ...kept]);
    const seenFactor = kept.length ? SEEN_FACTOR_KEEPING : SEEN_FACTOR;
    const ranked = onePerName(
      fresh.map((s) => (seen.has(s.id) && !must.has(s.id) ? { ...s, value: s.value * seenFactor } : s)),
      must,
    ).sort((a, b) => b.value - a.value);
    const limit = Math.max(MAX_CANDIDATES, Math.min(80, Math.ceil(stopCount * 3.5)));
    const scored = [...ranked.filter((s) => must.has(s.id)), ...ranked.filter((s) => !must.has(s.id)).slice(0, limit)];
    const byId = new Map(scored.map((s) => [s.id, s]));

    // A region starts at the station nearest the shops this course will most likely use, not the area's centre
    // (동대문·동묘 for vintage → 동묘앞역, not 동대문역).
    if (regionId) {
      const top = scored.slice(0, STATION_NEAR_TOP);
      const w = top.reduce((a, s) => a + s.value, 0) || 1;
      const centre = { lat: top.reduce((a, s) => a + s.lat * s.value, 0) / w, lng: top.reduce((a, s) => a + s.lng * s.value, 0) / w };
      const station = await this.stationNear(centre);
      if (station) ({ origin, startName } = { origin: { lat: station.lat, lng: station.lng }, startName: station.name });
    }

    const res = await this.optimize(origin, scored, stopCount, timeBudgetMin, countChosen, must);

    const styleIds = styles.map((x) => x.id);
    const variants: CourseVariant[] = res.map((c) => {
      const stops = this.stops(origin, c.stop_ids.map((id) => byId.get(id)!), styleIds, c.legs);
      return {
        variant: c.variant, label: VARIANT_LABEL[c.variant] ?? c.variant, stops,
        totalDistanceM: c.total_distance_m, walkMin: c.walk_min, totalMin: c.total_min,
        // "as many as fit" asked for the maximum on purpose, so fewer stops is the answer, not a warning.
        note: [maxStops ? `시간 안에 ${stops.length}곳을 넣었어요` : c.note, this.mustNote(c.stop_ids, mustIds, kept, byId), farNote].filter(Boolean).join(' · ') || undefined,
      };
    });

    const routed = await Promise.all(
      variants.map(async (v) => {
        const streets = await this.withStreets(origin, v);
        if (!input.withCafe && !input.withFood) return streets;
        const n = streets.stops.length;
        const kinds: BreakKind[] = [...(input.withFood ? (['food'] as const) : []), ...(input.withCafe ? (['cafe'] as const) : [])];
        const slots = breakSlots(n, kinds);
        const food = input.withFood ? await this.findBreak(streets, 'food', slots.food!) : undefined;
        const cafe = input.withCafe ? await this.findBreak(streets, 'cafe', slots.cafe!, food?.afterOrder ?? 1) : undefined;
        const missing = [input.withFood && !food ? '맛집' : '', input.withCafe && !cafe ? '카페' : ''].filter(Boolean);
        const withStops = withBreaks(streets, [food, cafe].filter((b): b is BreakStop => !!b));
        return missing.length ? { ...withStops, note: [withStops.note, `코스 가까이에서 들를 ${missing.join('·')}을 찾지 못했어요`].filter(Boolean).join(' · ') } : withStops;
      }),
    );
    variants.splice(0, variants.length, ...routed);

    const request = {
      withCafe: input.withCafe === true || undefined,
      withFood: input.withFood === true || undefined,
      gender,
      styles: styleIds, stopCount, maxStops, timeBudgetMin, budget, items, regionName, regionId, defaultedFields: defaulted,
      tasteNote: this.tasteNote(personal, styleIds.length > 0),
    };
    // "다른 지역으로 이어 가기": how to get from the previous course's last shop to this one's start.
    const link = input.continueFrom ? await this.linkFrom(input.continueFrom, origin, startName) : undefined;
    const saved = await this.db.pool.query<{ id: string }>(
      `INSERT INTO courses (request, result, user_id, input_mode, plan_ms) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        JSON.stringify({ ...request, origin, skipVisited, startName, bounds, link }), JSON.stringify(variants), userId,
        INPUT_MODES.has(input.inputMode ?? '') ? input.inputMode : 'buttons', Date.now() - t0,
      ],
    );
    return { id: saved.rows[0].id, request, origin, startName, variants, shared: false, createdAt: new Date(), link };
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
    const base = sameStops ? withoutBreaks(stored) : await this.withStreets(ctx.req.origin, ctx.current);
    const current = (stored.breaks ?? []).find((b) => b.kind === kind);
    const others = (stored.breaks ?? []).filter((b) => b.kind !== kind).map((b) => ({ ...b, afterOrder: bestSlot(base, b) }));
    // Asking again while one is in: another place, never the one shown now or any turned down before.
    const skip = new Set([...avoid, ...(on && current ? [current.name] : [])].slice(0, 50));
    const list = [...others];
    let message = `${BREAKS[kind].label}를 뺐어요`;
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
        return { courseId: ctx.courseId, variant: withBreaks(base, kept), message: `코스 가까이에서 ${what}을 찾지 못했어요` };
      }
      list.push(found);
      message = current ? `${current.name} 대신 ${toward(found.name)} 바꿨어요` : `${found.afterOrder}번 다음, 가는 길에 있는 ${object(found.name)} 넣었어요`;
    }
    const variant = withBreaks(base, list);
    await this.saveEdit(ctx, variant, [{ op: 'break', kind, on, source: 'button' }]);
    return { courseId: ctx.courseId, variant, message };
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
    const variant = keepBreaks(await this.withStreets(ctx.req.origin, this.rebuild(ctx, ids)), ctx.result[ctx.variantIndex].breaks);
    await this.saveEdit(ctx, variant, [{ ...edit, source: 'button' }]);
    return { courseId: ctx.courseId, variant, message };
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
        stops: ctx.current.stops.map((st) => ({
          order: st.order, name: st.shop.name, category: st.shop.category, summary: st.shop.summary ?? null, price_range: st.shop.priceRange ?? null,
        })),
      },
      30000,
    );
    if (!intent.ops.length) return { courseId, variant: ctx.current, message: intent.reply || '어떻게 고칠지 잘 모르겠어요. 다르게 말해 주세요' };
    const own = await this.editable(courseId, userId);
    if (own !== courseId) ctx = { ...ctx, courseId: own };

    const original = [...ctx.ids];
    const pinned = intent.ops.map((o) => ({ op: o, shopId: o.order ? original[o.order - 1] : undefined }));
    let ids = [...original];
    const done: string[] = [];
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
        // The only shop of that name may be in another neighbourhood: say so, the walk gets long.
        if ((hit.distanceM ?? 0) > FAR_PICK_M) farNote = ` (코스에서 ${((hit.distanceM ?? 0) / 1000).toFixed(1)}km 떨어진 곳이라 걷는 길이 길어져요)`;
      }
      const edit: CourseEditInput = {
        op: op.op, order, toOrder: op.to_order ?? undefined, shopId: pickedId,
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
    const variant = keepBreaks(await this.withStreets(ctx.req.origin, this.rebuild(ctx, ids)), ctx.result[ctx.variantIndex].breaks);
    await this.saveEdit(ctx, variant, [{ op: 'text', text: trimmed, ops: intent.ops, source: 'assistant' }]);
    return { courseId: ctx.courseId, variant, message: done.join(' · ') || intent.reply };
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
    const shown = ctx.ids.join() === stored.join() ? ctx.current : keepBreaks(await this.withStreets(ctx.req.origin, ctx.current), ctx.result[variantIndex].breaks);
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
    // A course made before logging in (or by this browser) becomes the account's.
    await this.db.pool.query('UPDATE courses SET user_id = $1 WHERE id = $2 AND user_id IS NULL', [userId, own]);
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
   * (the page keeps ?c=<id> in the URL), is first copied for whoever edits it.
   */
  private async editable(courseId: string, userId: string | null): Promise<string> {
    const r = await this.db.pool.query<{ id: string }>(
      `INSERT INTO courses (request, result, input_mode, user_id, shared_from)
       SELECT request, result, input_mode, $2, id FROM courses
       WHERE id = $1 AND (frozen OR (user_id IS NOT NULL AND user_id IS DISTINCT FROM $2::uuid)) RETURNING id`,
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
    const rows = (await this.candidates(req.origin, req.regionId, Math.max(current.stops.length, 4) * 2, req.bounds)).filter((r) =>
      keep(r, personal, req.skipVisited === true) && genderFit(r, req.gender) > 0,
    );
    const scored = rows.map((r) => {
      const s = this.score(r, styles, req.budget ?? 'any', req.items ?? [], personal);
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
        const res = await this.optimize(ctx.req.origin, pool, ids.length, NO_TIME_LIMIT_MIN, true);
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
    const s = this.score(row, ctx.styleIds.map((id) => ({ id, weight: 1 })), ctx.req.budget ?? 'any', ctx.req.items ?? []);
    ctx.byId.set(s.id, s);
    ctx.pool.push(s);
    return s;
  }

  /**
   * After the set of shops changes (replace / add / remove) the walk is re-ordered to be as short as possible from the
   * start. A "move" is the user's own order and is left alone.
   */
  private reordered(ctx: EditContext, ids: string[], message: string): { ids: string[]; message: string } {
    const best = shortestOrder(ctx.req.origin, ids.map((id) => ({ id, ...this.pos(ctx, id) })));
    const changed = best.some((id, i) => id !== ids[i]);
    return { ids: best, message: changed ? `${message} · 걷는 순서도 다시 맞췄어요` : message };
  }

  async saveEdit(ctx: EditContext, variant: CourseVariant, edits: object[]): Promise<void> {
    const result = [...ctx.result];
    result[ctx.variantIndex] = variant;
    const log = edits.map((e) => ({ ...e, variant: ctx.variantIndex, at: new Date().toISOString() }));
    await this.db.pool.query(`UPDATE courses SET result = $2, edits = edits || $3::jsonb WHERE id = $1`, [
      ctx.courseId,
      JSON.stringify(result),
      JSON.stringify(log),
    ]);
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
    const distance = legs.reduce((a, l) => a + l.distance_m, 0);
    const walk = distance / WALK_M_PER_MIN;
    const dwell = shops.reduce((a, s) => a + dwellMin(s.kind), 0);
    return {
      variant: ctx.current.variant,
      label: ctx.current.label,
      stops: this.stops(origin, shops, ctx.styleIds, legs),
      totalDistanceM: distance,
      walkMin: Math.round(walk * 10) / 10,
      totalMin: Math.round((walk + dwell) * 10) / 10,
    };
  }

  /** Best shop for a slot (null = anywhere): value minus the extra walk it adds, honouring "신발 가게로"-type wishes. */
  private bestFor(ctx: EditContext, ids: string[], slot: number | null, edit: CourseEditInput): Scored | null {
    const taken = new Set([...ids, ...(edit.avoid ?? [])]);
    const posList = ids.map((x) => this.pos(ctx, x));
    let best: { s: Scored; score: number } | null = null;
    for (const c of ctx.pool) {
      if (taken.has(c.id) || !this.wants(c, edit)) continue;
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
      road_address: sh.roadAddress ?? null, summary: sh.summary ?? null, reason_material: null, hours: null,
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
    return [...liked, ...best].slice(0, Math.max(quota, Math.min(liked.length, present.length - 1)));
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

  private async optimize(origin: LatLngT, pool: Scored[], stopCount: number, timeBudgetMin: number, exact: boolean, must: Set<string> = new Set()) {
    const res = await this.model.post<{ courses: ModelCourse[] }>('/optimize', {
      origin,
      candidates: pool.map((s) => ({
        id: s.id, lat: s.lat, lng: s.lng, value: Number(s.value.toFixed(4)), dwell_min: dwellMin(s.kind), ...(must.has(s.id) ? { must: true } : {}),
      })),
      stop_count: stopCount,
      time_budget_min: timeBudgetMin,
      exact_count: exact,
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
          hoursToday: hoursToday(s.hours),
        },
        reason: s.keptReason ?? this.reason(s, styleIds),
        legFromPrev: { distanceM: legs[i].distance_m, durationMin: legs[i].duration_min, path: [prev, here] },
      };
      prev = here;
      return stop;
    });
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
  private score(r: Row, styles: { id: string; weight: number }[], budget: string, items: string[], personal: Personal | null = null): Scored {
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
    if (taste) {
      if (budget === 'any' && taste.price && r.price_range === taste.price) value += PRICE_MATCH_BONUS;
      // Something new each time: their own recent course shops step back, unmet shops that fit step up.
      if (taste.recent.has(r.id) && !personal!.liked.has(r.id)) value *= RECENT_FACTOR;
      else if (tf !== null && tf > 0.25 && !taste.known.has(r.id)) value += NEW_MATCH_BONUS;
    }
    return { ...r, fit, value: Math.max(0, Math.min(1, value)) };
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
    if (best) parts.push(`${STYLE_LABEL[best.id]} ${best.score}점`);
    parts.push(s.reason_material || s.summary || CATEGORY_LABEL[s.category] || '옷가게');
    return parts.join(' · ');
  }
}
