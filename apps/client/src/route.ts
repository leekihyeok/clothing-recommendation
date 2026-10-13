/**
 * What's on screen, in the address, so a reload (or back / forward) comes back to it:
 *   ?c=<course>&v=<version tab>&walk=1   a course, the version being looked at, 걷기 모드 on it
 *   ?shop=<shop>                         a shop page (over whatever is under it)
 *   ?me=<tab>&p=<page>                   마이페이지, its tab and page
 * What only lasts a moment (an open menu, a hovered card, a drag) stays out. Other parameters (?g= for a group link)
 * are left as they are. Share links are built fresh (useShareCourse, CopyLink), so none of this leaks into them.
 */
import { SHARE_PARAM, SHOP_PARAM } from './course/useSavedCourses';

export const ME_TABS = ['courses', 'saved', 'news', 'visited', 'reviews', 'recent'] as const;
export type MeTab = (typeof ME_TABS)[number];

export interface Route {
  course: string | null;
  /** version tab of the course (0 = 추천) */
  variant: number;
  walk: boolean;
  shop: string | null;
  /** 마이페이지 tab, null when it isn't open */
  me: MeTab | null;
  /** page of that tab's list (1 = first) */
  page: number;
}

const int = (s: string | null, min: number) => {
  const n = Number(s);
  return Number.isInteger(n) && n >= min ? n : min;
};

export function readRoute(search = window.location.search): Route {
  const q = new URLSearchParams(search);
  const course = q.get(SHARE_PARAM);
  const me = q.get('me');
  return {
    course,
    variant: course ? int(q.get('v'), 0) : 0,
    walk: !!course && q.get('walk') === '1',
    shop: q.get(SHOP_PARAM),
    me: (ME_TABS as readonly string[]).includes(me ?? '') ? (me as MeTab) : null,
    page: me ? int(q.get('p'), 1) : 1,
  };
}

/**
 * Which screen a route is, for history: a new screen is a new entry (back returns to the one before), while a tab,
 * a page or a version tab on the same screen only edits the current entry.
 */
function screen(r: Route): string {
  if (r.shop) return `shop:${r.shop}`;
  if (r.me) return 'me';
  if (r.course) return r.walk ? `walk:${r.course}` : `course:${r.course}`;
  return 'form';
}

/** Rank of a screen: opening a deeper one pushes, going back up (closing it) replaces. */
const depth = (r: Route) => (r.shop ? 3 : r.me ? 2 : r.walk ? 2 : r.course ? 1 : 0);

/** Puts the route in the address. Nothing happens when it's already there. */
export function writeRoute(next: Route) {
  const url = new URL(window.location.href);
  const was = readRoute(url.search);
  const set = (k: string, v: string | null) => (v ? url.searchParams.set(k, v) : url.searchParams.delete(k));
  set(SHARE_PARAM, next.course);
  set('v', next.course && next.variant > 0 ? String(next.variant) : null);
  set('walk', next.course && next.walk ? '1' : null);
  set(SHOP_PARAM, next.shop);
  set('me', next.me);
  set('p', next.me && next.page > 1 ? String(next.page) : null);
  if (url.search === window.location.search) return;
  // A course replacing another ("다른 코스", an edit that copies a shared one) edits the entry: back doesn't step through
  // every version of it.
  const opened = screen(next) !== screen(was) && (depth(next) > depth(was) || (!!next.course && !was.course));
  if (opened) window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}
