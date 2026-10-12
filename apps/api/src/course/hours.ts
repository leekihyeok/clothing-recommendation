import { BadRequestException } from '@nestjs/common';
import type { HoursDay } from '../owners/owners.service';
import { L } from '../infra/lang';

/**
 * When a course happens, and whether a shop is open then. Hours are the owner's (shop_owner_info) or, failing that,
 * read from blog posts by pipeline.hours (shops.hours, ignored when the post is older than BLOG_HOURS_MAX_AGE).
 * Both are Mon..Sun, {"closed", "open", "close"}; a day with neither closed nor times is unknown.
 */

/** Start of a course: Seoul weekday (0 = Monday), minutes since midnight, and whether the user picked it. */
export interface Clock {
  day: number;
  minutes: number;
  /** YYYY-MM-DD in Seoul */
  date: string;
  /** false = "now" (the user didn't pick a time) */
  chosen: boolean;
}

// The same rules as services/model/app/optimize.py (MAX_WAIT_MIN, MIN_BROWSE_MIN).
export const MAX_WAIT_MIN = 30;
export const MIN_BROWSE_MIN = 15;
// A course can be planned for up to two weeks ahead.
const MAX_AHEAD_DAYS = 14;
const DAY = ['월', '화', '수', '목', '금', '토', '일'];
const DAY_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const hhmm = (m: number) => {
  const x = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};

function seoulParts(d: Date): { date: string; day: number; minutes: number } {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')),
    minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  };
}

/**
 * "2026-10-17T14:00" (Seoul time, from the form or the text) → a Clock. Empty → now. A time a few minutes past counts as
 * now; further in the past, or more than two weeks ahead, is refused.
 */
export function clockAt(startAt?: string | null, now = new Date()): Clock {
  if (!startAt) return { ...seoulParts(now), chosen: false };
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(startAt.trim());
  if (!m) throw new BadRequestException('출발 시각 형식이 맞지 않아요');
  const at = new Date(`${m[1]}T${m[2]}:${m[3]}:00+09:00`);
  if (Number.isNaN(at.getTime())) throw new BadRequestException('출발 시각을 알아보지 못했어요');
  const ahead = (at.getTime() - now.getTime()) / 60_000;
  if (ahead < -15) throw new BadRequestException('출발 시각이 이미 지났어요');
  if (ahead > MAX_AHEAD_DAYS * 1440) throw new BadRequestException(`출발은 ${MAX_AHEAD_DAYS}일 안으로 골라 주세요`);
  if (ahead < 5) return { ...seoulParts(now), chosen: false };
  return { ...seoulParts(at), chosen: true };
}

/** "6시까지"-style finish time ("18:00") → minutes after the start; refused when it isn't after the start. */
export function minutesUntil(clock: Clock, endBy: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(endBy)) throw new BadRequestException('끝나는 시각 형식이 맞지 않아요');
  const left = toMin(endBy) - clock.minutes;
  if (left < 30) throw new BadRequestException(`끝나는 시각(${endBy})이 출발(${hhmm(clock.minutes)})보다 30분 이상 뒤여야 해요`);
  return left;
}

/** Opening spans on the course's day, in minutes from that midnight: yesterday's after-midnight tail, then today. */
function spans(hours: HoursDay[], day: number): [number, number][] | null {
  const today = hours[day];
  const yesterday = hours[(day + 6) % 7];
  const out: [number, number][] = [];
  if (yesterday && !yesterday.closed && yesterday.open && yesterday.close && toMin(yesterday.close) <= toMin(yesterday.open)) {
    out.push([-Infinity, toMin(yesterday.close)]);
  }
  // Today unknown: no constraint, even if last night's hours ran past midnight (that tail alone made the whole day
  // look closed).
  if (!today || (!today.closed && (!today.open || !today.close))) return null;
  if (!today.closed) {
    const o = toMin(today.open!);
    const c = toMin(today.close!);
    out.push([o, c > o ? c : c + 1440]);
  }
  return out;
}

/**
 * When the shop can be visited, in minutes after the course starts: { from, until } for the optimiser, null when the
 * hours don't say (no constraint), 'closed' when it isn't open at any point the course could reach it.
 */
export function windowFor(hours: HoursDay[] | null | undefined, clock: Clock, budgetMin: number): { from: number; until: number } | null | 'closed' {
  if (!hours || hours.length !== 7) return null;
  const s = spans(hours, clock.day);
  if (!s) return null;
  for (const [lo, hi] of s) {
    const from = Math.max(0, lo - clock.minutes);
    const until = hi - clock.minutes;
    if (until - from >= MIN_BROWSE_MIN && until >= MIN_BROWSE_MIN && from <= budgetMin) return { from, until };
  }
  return 'closed';
}

/** "오늘 11:00–21:00" / "토 쉬는 날" for the card: the course's day, from whichever hours there are. */
export function dayHours(hours: HoursDay[] | null | undefined, clock: Clock, today: Clock): string | undefined {
  const d = hours?.[clock.day];
  if (!d) return undefined;
  const when = clock.date === today.date ? L('오늘', 'Today') : L(DAY[clock.day], DAY_EN[clock.day]);
  if (d.closed) return L(`${when} 쉬는 날`, `Closed ${when === 'Today' ? 'today' : `on ${when}`}`);
  return d.open && d.close ? `${when} ${d.open}–${d.close}` : undefined;
}

/** A shop the walk reaches while it's closed (after an edit, or a course opened later): what to tell the user. */
export function closedOnArrival(hours: HoursDay[] | null | undefined, clock: Clock, arriveMin: number): string | undefined {
  const w = windowFor(hours, { ...clock, minutes: clock.minutes + arriveMin }, Infinity);
  if (w === null) return undefined;
  const at = hhmm(clock.minutes + arriveMin);
  if (w === 'closed') {
    const d = hours?.[clock.day];
    return d?.closed ? L('이날은 쉬는 날이에요', 'Closed that day') : L(`도착(${at}) 때는 문을 닫아요`, `Closed when you arrive (${at})`);
  }
  if (w.from > MAX_WAIT_MIN) {
    const opens = hhmm(clock.minutes + arriveMin + w.from);
    return L(`도착(${at}) 때는 아직 안 열어요 (${opens} 오픈)`, `Not open yet when you arrive (${at}) · opens ${opens}`);
  }
  return undefined;
}

/** The clock of a stored course for edits: its chosen start while that's still ahead, otherwise now. */
export function storedClock(startAt?: string): Clock {
  try {
    return clockAt(startAt);
  } catch {
    return clockAt();
  }
}
