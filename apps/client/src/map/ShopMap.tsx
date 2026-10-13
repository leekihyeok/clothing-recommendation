import { useApolloClient } from '@apollo/client';
import { useEffect, useRef, useState } from 'react';
import { graphql } from '../gql';
import type { ShopsInBoundsQuery } from '../gql/graphql';
import { CATEGORY_BY_ID } from './categories';
import { Minus, Plus, Storefront } from '@phosphor-icons/react';
import { attachTouchFallback, needsTouchFallback } from './touchFallback';
import { MapLegend } from './MapLegend';
import { type Kakao, loadKakaoMaps } from './kakao';
import type { WalkState } from '../course/WalkMode';
import { getLang, t } from '../i18n';

const ShopsInBoundsDoc = graphql(`
  query ShopsInBounds($bounds: BoundsInput!, $categories: [String!], $regionId: ID, $level: Int) {
    shopsInBounds(bounds: $bounds, categories: $categories, regionId: $regionId, level: $level) {
      total
      shops { id name kind category lat lng roadAddress inMarket placeUrl prominence labeled }
    }
  }
`);

export type MapShop = ShopsInBoundsQuery['shopsInBounds']['shops'][number];

export interface MapRegion {
  id: string;
  name: string;
  polygon: { lat: number; lng: number }[];
}

export interface MapCourse {
  origin: { lat: number; lng: number };
  startName?: string | null;
  stops: {
    order: number;
    shop: { id: string; name: string; lat: number; lng: number };
    /** The walk from the previous stop: the street path when T map is on, else just the two ends. */
    legFromPrev?: { path: { lat: number; lng: number }[] };
  }[];
  /** Breaks (café, meal: Kakao places), drawn as boxes so they read apart from the numbered shops. */
  breaks?: { kind: string; name: string; lat: number; lng: number; afterOrder: number }[] | null;
  /** Where the walk ends when it isn't the last shop (a station, back to the start), and the walk there. */
  end?: { lat: number; lng: number } | null;
  endName?: string | null;
  endLeg?: { path: { lat: number; lng: number }[] } | null;
}

export interface ViewportInfo {
  shown: number;
  total: number;
}

export interface MapBounds {
  swLat: number;
  swLng: number;
  neLat: number;
  neLng: number;
}

interface Props {
  categories: string[];
  regions: MapRegion[];
  focusRegionId: string | null;
  /** "지도에서 고르기": the next tap on the map sets the start or the finish. */
  pickMode: 'start' | 'end' | null;
  /** A course number on the map was tapped: show that stop's card. */
  onStopClick?: (order: number) => void;
  /** A number held and dropped on another: swap those two stops. Unset (walking, an edit running) turns dragging off. */
  onStopSwap?: (from: number, to: number) => void;
  /** Stop picking without choosing (the banner's 취소, or Esc). */
  onCancelPick?: () => void;
  pickedPoint: { lat: number; lng: number } | null;
  /** The finish picked on the map, shown before a course is planned. */
  pickedEnd: { lat: number; lng: number } | null;
  /** Walk mode: my live position and the next place. */
  walk: WalkState | null;
  onPickPoint: (p: { lat: number; lng: number }) => void;
  /** A shop picked from 내 가게: the map moves to it. */
  focusShop: { lat: number; lng: number } | null;
  /** The shop whose page is open: marked on the map, and the map moves to it when it's out of view. */
  shopPin?: { lat: number; lng: number; name: string } | null;
  course: MapCourse | null;
  hoverOrder: number | null;
  onSelect: (shop: MapShop | null) => void;
  onViewport: (info: ViewportInfo) => void;
  onCenter: (center: { lat: number; lng: number }) => void;
  /** What the map shows now: "지도 가운데서 코스 짜기" stays inside it. */
  onBounds: (bounds: MapBounds) => void;
  /** On first load, centre on the user (when they allow it and are in Seoul). Off when a link opens a course. */
  locateOnStart: boolean;
}

// Roughly Seoul: outside it the app has no shops, so the default view is kept.
const SEOUL_BBOX = { minLat: 37.41, maxLat: 37.72, minLng: 126.76, maxLng: 127.19 };
const inSeoul = (lat: number, lng: number) =>
  lat >= SEOUL_BBOX.minLat && lat <= SEOUL_BBOX.maxLat && lng >= SEOUL_BBOX.minLng && lng <= SEOUL_BBOX.maxLng;

const SEONGSU = { lat: 37.5446, lng: 127.056 };
// Dragging a course number: held this long without moving it lifts it; moved before that, the press is a map pan.
const LONG_PRESS_MS = 350;
const PRESS_SLOP_PX = 8;
// Dropped within this of another number's centre, the two swap.
const DROP_PX = 36;
// Same breakpoint as the bottom-sheet layout in styles/theme.scss (media-breakpoint-down(md)).
const isPhone = () => window.matchMedia('(max-width: 767.98px)').matches;

export function ShopMap({
  categories, regions, focusRegionId, focusShop, shopPin, pickMode, onCancelPick, onStopClick, onStopSwap, pickedPoint, pickedEnd, walk, onPickPoint, course, hoverOrder, onSelect, onViewport, onCenter,
  onBounds, locateOnStart,
}: Props) {
  const apollo = useApolloClient();
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<Kakao>(null);
  const shopLayer = useRef<Kakao[]>([]);
  const kakao = useRef<Kakao>(null);
  const requestSeq = useRef(0);
  const polygons = useRef(new Map<string, Kakao>());
  const courseLayer = useRef<Kakao[]>([]);
  const stopEls = useRef(new Map<number, HTMLElement>());
  // Break boxes (café, meal) with where they stand, moved aside when they would cover a stop's number or name.
  const breakEls = useRef<{ el: HTMLElement; lat: number; lng: number }[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "주변 가게 보기": with a course on screen, other shops nearby as faint pins — tap one to put it in the course.
  const [nearby, setNearby] = useState(false);
  // The pick pins carry a word, so they are redrawn when the language changes.
  const lang = getLang();
  // Latest props for the map's idle listener, which is registered once.
  const latest = useRef({ categories, onSelect, onViewport, onCenter, onBounds, course, focusRegionId, pickMode, onPickPoint, nearby, onStopClick, onStopSwap, shopPin });
  latest.current = { categories, onSelect, onViewport, onCenter, onBounds, course, focusRegionId, pickMode, onPickPoint, nearby, onStopClick, onStopSwap, shopPin };
  const me = useRef<Kakao>(null);
  const pin = useRef<Kakao>(null);
  const endPin = useRef<Kakao>(null);
  const liveMe = useRef<Kakao>(null);
  const walkFitted = useRef<string | null>(null);

  async function refresh() {
    const m = map.current;
    if (!m) return;
    const c = m.getCenter();
    latest.current.onCenter({ lat: c.getLat(), lng: c.getLng() });
    const bounds = m.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    latest.current.onBounds({ swLat: sw.getLat(), swLng: sw.getLng(), neLat: ne.getLat(), neLng: ne.getLng() });
    const shown = latest.current.course;
    if (shown && !latest.current.nearby) {
      clearShops(); // a course is on screen: keep the map to its stops
      return;
    }
    const seq = ++requestSeq.current;
    const { data } = await apollo.query({
      query: ShopsInBoundsDoc,
      variables: {
        bounds: { swLat: sw.getLat(), swLng: sw.getLng(), neLat: ne.getLat(), neLng: ne.getLng() },
        categories: latest.current.categories,
        // A chosen region shows only its own shops; the rest of the map stays quiet. Around a course: any shop nearby.
        regionId: shown ? null : latest.current.focusRegionId,
        // The API returns the most notable shops in view, more the closer you zoom.
        level: m.getLevel(),
      },
    });
    if (seq !== requestSeq.current) return; // a newer pan/zoom already asked again
    if (shown) {
      const inCourse = new Set(shown.stops.map((st) => st.shop.id));
      drawShops(data.shopsInBounds.shops.filter((x) => !inCourse.has(x.id)), true);
      return;
    }
    drawShops(data.shopsInBounds.shops);
    latest.current.onViewport({ shown: data.shopsInBounds.shops.length, total: data.shopsInBounds.total });
  }

  /**
   * Press and hold a course number, drag it onto another: the two stops swap. The number follows the pointer and the one
   * it would land on lights up. Cards keep ↑↓ and "1번으로" buttons for the same without a gesture.
   */
  function attachStopDrag(el: HTMLElement, order: number) {
    let timer = 0;
    let press: { x: number; y: number; id: number } | null = null;
    let dragging = false;
    let target: number | null = null;
    let zIndex = '';
    const mark = (next: number | null) => {
      if (next === target) return;
      if (target != null) stopEls.current.get(target)?.classList.remove('is-drop-target');
      if (next != null) stopEls.current.get(next)?.classList.add('is-drop-target');
      target = next;
    };
    const nearest = (x: number, y: number) => {
      let best: number | null = null;
      let bestD = DROP_PX;
      for (const [o, other] of stopEls.current) {
        if (o === order) continue;
        const r = (other.querySelector('.course-marker') ?? other).getBoundingClientRect();
        const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
        if (d < bestD) [bestD, best] = [d, o];
      }
      return best;
    };
    const finish = (drop: boolean) => {
      window.clearTimeout(timer);
      if (dragging) {
        map.current?.setDraggable(true);
        el.classList.remove('is-dragging');
        el.style.transform = '';
        if (el.parentElement) el.parentElement.style.zIndex = zIndex;
        const to = target;
        mark(null);
        if (drop && to != null) latest.current.onStopSwap?.(order, to);
        el.dataset.dragged = '1';
        window.setTimeout(() => delete el.dataset.dragged, 0);
      }
      dragging = false;
      press = null;
    };
    el.addEventListener('pointerdown', (e) => {
      if (!latest.current.onStopSwap || e.button !== 0) return;
      press = { x: e.clientX, y: e.clientY, id: e.pointerId };
      timer = window.setTimeout(() => {
        if (!press || !latest.current.onStopSwap) return;
        dragging = true;
        map.current?.setDraggable(false);
        try {
          el.setPointerCapture(press.id);
        } catch {
          // the pointer is already gone
        }
        el.classList.add('is-dragging');
        // Above every other overlay while it moves.
        if (el.parentElement) {
          zIndex = el.parentElement.style.zIndex;
          el.parentElement.style.zIndex = '100001';
        }
        navigator.vibrate?.(15);
      }, LONG_PRESS_MS);
    });
    el.addEventListener('pointermove', (e) => {
      if (!press) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (!dragging) {
        if (Math.hypot(dx, dy) > PRESS_SLOP_PX) finish(false); // moved before the hold: the map pans
        return;
      }
      e.preventDefault();
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      mark(nearest(e.clientX, e.clientY));
    });
    el.addEventListener('pointerup', () => finish(true));
    el.addEventListener('pointercancel', () => finish(false));
    // A long press would open the browser's menu or select the name.
    el.addEventListener('contextmenu', (e) => latest.current.onStopSwap && e.preventDefault());
    // The touch fallback (touch laptops, iPad) pans on touchmove; keep it out of a drag.
    el.addEventListener(
      'touchmove',
      (e) => {
        if (!dragging) return;
        e.stopPropagation();
        e.preventDefault();
      },
      { passive: false },
    );
  }

  function clearShops() {
    for (const o of shopLayer.current) o.setMap(null);
    shopLayer.current = [];
  }

  // Shops arrive most notable first. The top ones get a name label; later ones are plain dots drawn underneath.
  function drawShops(shops: MapShop[], aroundCourse = false) {
    const k = kakao.current;
    clearShops();
    shops.forEach((shop, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `shop-pin${shop.kind === 'complex' ? ' is-complex' : ''}${shop.labeled ? ' is-labeled' : ''}${aroundCourse ? ' is-nearby' : ''}`;
      el.title = aroundCourse ? t(`${shop.name} · 눌러서 코스에 넣기`, `${shop.name} · tap to add to the course`) : shop.name;
      el.setAttribute('aria-label', aroundCourse ? t(`${shop.name}, 코스에 넣을 수 있는 주변 가게`, `${shop.name}, nearby shop you can add to the course`) : shop.name);
      const dot = document.createElement('span');
      dot.className = 'shop-dot';
      dot.style.background = CATEGORY_BY_ID[shop.category]?.color ?? '#a8a29e';
      el.appendChild(dot);
      if (shop.labeled) {
        const label = document.createElement('span');
        label.className = 'shop-label';
        label.textContent = shop.name;
        el.appendChild(label);
      }
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        latest.current.onSelect(shop);
      });
      shopLayer.current.push(
        new k.maps.CustomOverlay({
          map: map.current,
          position: new k.maps.LatLng(shop.lat, shop.lng),
          content: el,
          clickable: true,
          xAnchor: 0,
          yAnchor: 0.5,
          zIndex: shops.length - i,
        }),
      );
    });
  }

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let detachTouch: (() => void) | undefined;
    loadKakaoMaps()
      .then((k) => {
        if (cancelled || !container.current) return;
        kakao.current = k;
        map.current = new k.maps.Map(container.current, {
          center: new k.maps.LatLng(SEONGSU.lat, SEONGSU.lng),
          level: 4,
        });
        // Zoom is our own +/- in the control stack (Kakao's control sat under "주변 가게" / the legend on narrow
        // screens). Touch screens that Kakao treats as desktop get drag and pinch from us.
        if (needsTouchFallback()) detachTouch = attachTouchFallback(container.current, map.current, k);
        k.maps.event.addListener(map.current, 'idle', () => {
          clearTimeout(timer);
          timer = setTimeout(() => refresh().catch((e) => setError(String(e))), 250);
        });
        k.maps.event.addListener(map.current, 'click', (e: Kakao) => {
          if (latest.current.pickMode) {
            latest.current.onPickPoint({ lat: e.latLng.getLat(), lng: e.latLng.getLng() });
            return;
          }
          latest.current.onSelect(null);
        });
        setReady(true);
        refresh().catch((e) => setError(String(e)));
        if (locateOnStart && navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const { latitude: lat, longitude: lng } = pos.coords;
              // A course or a shop from a link is what the map should show, not where I am.
              if (cancelled || !inSeoul(lat, lng) || latest.current.course || latest.current.shopPin) return;
              const here = new k.maps.LatLng(lat, lng);
              const dot = document.createElement('div');
              dot.className = 'me-dot';
              dot.setAttribute('aria-label', t('내 위치', 'You are here'));
              me.current = new k.maps.CustomOverlay({ map: map.current, position: here, content: dot, zIndex: 6 });
              map.current.setLevel(4);
              map.current.setCenter(here);
            },
            () => undefined, // refused or unavailable: keep the default view
            { timeout: 8000, maximumAge: 5 * 60_000 },
          );
        }
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      detachTouch?.();
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Category filter, chosen region or "주변 가게 보기" changed: reload what's on screen.
  useEffect(() => {
    if (map.current) refresh().catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories.join(','), focusRegionId, nearby]);

  // Region outlines: faint for all, strong for the focused one, which the map also zooms to.
  useEffect(() => {
    const k = kakao.current;
    if (!ready || !k) return;
    for (const p of polygons.current.values()) p.setMap(null);
    polygons.current.clear();
    if (course) return; // the course line alone; region outlines would cross it
    for (const r of regions) {
      const focused = r.id === focusRegionId;
      const polygon = new k.maps.Polygon({
        map: map.current,
        path: r.polygon.map((p) => new k.maps.LatLng(p.lat, p.lng)),
        strokeWeight: focused ? 2 : 1,
        strokeColor: '#0c0a09',
        strokeOpacity: focused ? 0.85 : 0.3,
        strokeStyle: focused ? 'solid' : 'shortdash',
        fillColor: '#0c0a09',
        fillOpacity: focused ? 0.05 : 0.015,
      });
      polygons.current.set(r.id, polygon);
    }
    const focus = regions.find((r) => r.id === focusRegionId);
    if (focus) {
      const bounds = new k.maps.LatLngBounds();
      for (const p of focus.polygon) bounds.extend(new k.maps.LatLng(p.lat, p.lng));
      // Keep the region clear of the panel: bottom sheet on phones, left column on desktop.
      if (isPhone()) map.current.setBounds(bounds, 24, 24, Math.round(window.innerHeight * 0.58), 24);
      else map.current.setBounds(bounds, 24, 24, 24, 440);
    }
  }, [ready, regions, focusRegionId, course]);

  // Course: start point, numbered stops, the walking line. Other shops are hidden meanwhile.
  useEffect(() => {
    const k = kakao.current;
    if (!ready || !k) return;
    for (const o of courseLayer.current) o.setMap(null);
    courseLayer.current = [];
    stopEls.current.clear();
    breakEls.current = [];
    if (!course) {
      refresh().catch((e) => setError(String(e)));
      return;
    }
    // Other shops hide behind a course, unless "주변 가게 보기" is on (then redrawn without the course's own shops).
    if (latest.current.nearby) refresh().catch((e) => setError(String(e)));
    else clearShops();
    const bounds = new k.maps.LatLngBounds();
    const path = [new k.maps.LatLng(course.origin.lat, course.origin.lng)];
    bounds.extend(path[0]);
    const start = document.createElement('div');
    start.className = 'course-start';
    start.textContent = course.startName ? `START · ${course.startName}` : 'START';
    courseLayer.current.push(new k.maps.CustomOverlay({ map: map.current, position: path[0], content: start, yAnchor: 0.5 }));
    for (const s of course.stops) {
      const pos = new k.maps.LatLng(s.shop.lat, s.shop.lng);
      path.push(pos);
      bounds.extend(pos);
      // The number, and the shop's name beside it so the route reads without opening the list.
      const el = document.createElement('div');
      el.className = 'course-stop';
      const num = document.createElement('span');
      num.className = 'course-marker';
      num.textContent = String(s.order);
      const name = document.createElement('span');
      name.className = 'course-label';
      name.textContent = s.shop.name;
      el.append(num, name);
      el.title = s.shop.name;
      // Tap (or Enter) on a number: the list scrolls to that stop's card.
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.setAttribute('aria-label', t(`${s.order}번 ${s.shop.name} 카드 보기`, `Show stop ${s.order}, ${s.shop.name}`));
      const open = (e: Event) => {
        e.stopPropagation();
        if (el.dataset.dragged) return; // the click that ends a drag
        latest.current.onStopClick?.(s.order);
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(e);
        }
      });
      stopEls.current.set(s.order, el);
      attachStopDrag(el, s.order);
      // clickable: the overlay takes the tap itself instead of passing it to the map underneath.
      courseLayer.current.push(new k.maps.CustomOverlay({ map: map.current, position: pos, content: el, xAnchor: 0, yAnchor: 0.5, zIndex: 3, clickable: true }));
    }
    for (const br of course.breaks ?? []) {
      const pos = new k.maps.LatLng(br.lat, br.lng);
      bounds.extend(pos);
      const el = document.createElement('div');
      el.className = `break-marker is-${br.kind}`;
      breakEls.current.push({ el, lat: br.lat, lng: br.lng });
      el.textContent = `${br.kind === 'food' ? t('맛집', 'Food') : t('카페', 'Café')} · ${br.name}`;
      courseLayer.current.push(new k.maps.CustomOverlay({ map: map.current, position: pos, content: el, yAnchor: 0.5, zIndex: 2 }));
    }
    if (course.end) {
      const pos = new k.maps.LatLng(course.end.lat, course.end.lng);
      path.push(pos);
      bounds.extend(pos);
      const fin = document.createElement('div');
      fin.className = 'course-start is-finish';
      fin.textContent = course.endName ? `FINISH · ${course.endName}` : 'FINISH';
      // Back to the start: the two labels would sit on each other, so the finish one goes below.
      const same = Math.abs(course.end.lat - course.origin.lat) < 1e-5 && Math.abs(course.end.lng - course.origin.lng) < 1e-5;
      courseLayer.current.push(new k.maps.CustomOverlay({ map: map.current, position: pos, content: fin, yAnchor: same ? -0.6 : 0.5 }));
    }
    // Follow the streets when the legs carry a walking path; otherwise this is the straight line through the stops.
    const streets = course.stops.some((st) => (st.legFromPrev?.path.length ?? 0) > 2);
    const line = streets
      ? [
          ...course.stops.flatMap((st) => (st.legFromPrev?.path ?? [st.shop]).map((q) => new k.maps.LatLng(q.lat, q.lng))),
          ...(course.end ? (course.endLeg?.path ?? [course.end]).map((q) => new k.maps.LatLng(q.lat, q.lng)) : []),
        ]
      : path;
    for (const q of line) bounds.extend(q);
    courseLayer.current.push(
      new k.maps.Polyline({ map: map.current, path: line, strokeWeight: 4, strokeColor: '#e8470f', strokeOpacity: 0.95, strokeStyle: 'solid' }),
    );
    for (const s of course.stops) bounds.extend(new k.maps.LatLng(s.shop.lat, s.shop.lng));
    // Leave room for the panel: left on desktop, bottom on phones.
    if (isPhone()) map.current.setBounds(bounds, 48, 32, Math.round(window.innerHeight * 0.58), 32);
    else map.current.setBounds(bounds, 60, 60, 60, 460);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, course]);

  // The open shop's pin; the map goes there when the shop isn't in view (a link opened elsewhere, a similar shop
  // across the river), and stays put when it already is.
  const pinRef = useRef<{ setMap: (m: unknown) => void } | null>(null);
  useEffect(() => {
    const k = kakao.current;
    pinRef.current?.setMap(null);
    pinRef.current = null;
    if (!ready || !k || !shopPin) return;
    const pos = new k.maps.LatLng(shopPin.lat, shopPin.lng);
    const el = document.createElement('div');
    el.className = 'open-shop-pin';
    el.textContent = shopPin.name;
    el.setAttribute('aria-hidden', 'true');
    pinRef.current = new k.maps.CustomOverlay({ map: map.current, position: pos, content: el, yAnchor: 1.15, zIndex: 100_000 }) // above every shop marker (theirs count down from the number of shops);
    // In view = on the part of the map the panel doesn't cover (left 460 px on desktop, the half sheet on phones).
    const box = container.current?.getBoundingClientRect();
    const pt = map.current.getProjection().containerPointFromCoords(pos);
    const phone = isPhone();
    const seen = !!box && map.current.getBounds().contain(pos) && (phone ? pt.y > 40 && pt.y < box.height * 0.4 : pt.x > 480 && pt.x < box.width - 40);
    if (!seen) {
      if (map.current.getLevel() > 4) map.current.setLevel(3);
      map.current.setCenter(pos);
      // Move the shop from the middle into the open part of the map.
      if (box) map.current.panBy(phone ? 0 : -230, phone ? Math.round(box.height * 0.29) : 0);
    }
  }, [ready, shopPin?.lat, shopPin?.lng, shopPin?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = kakao.current;
    if (!ready || !k || !focusShop) return;
    map.current.setLevel(3);
    map.current.panTo(new k.maps.LatLng(focusShop.lat, focusShop.lng));
  }, [ready, focusShop]);

  // Numbers on top of each other (shops a few doors apart at this zoom): fan later ones out so every number shows.
  // Measured in screen pixels after the map has fitted the course, and again on every zoom.
  useEffect(() => {
    const k = kakao.current;
    if (!ready || !k || !course) return;
    const spread = () => {
      const proj = map.current.getProjection();
      const shown: { x: number; y: number }[] = [];
      for (const s of course.stops) {
        const el = stopEls.current.get(s.order);
        if (!el) continue;
        const p = proj.containerPointFromCoords(new k.maps.LatLng(s.shop.lat, s.shop.lng));
        let dx = 0;
        let dy = 0;
        for (let tries = 0; tries < 6 && shown.some((q) => Math.hypot(q.x - (p.x + dx), q.y - (p.y + dy)) < 30); tries++) {
          dx += 18;
          dy -= 14;
        }
        el.style.translate = dx || dy ? `${dx}px ${dy}px` : '';
        shown.push({ x: p.x + dx, y: p.y + dy });
      }
      // Break boxes: screen rectangles of the stops (number + name label) are taken; a box that would overlap one
      // steps down, then up, until it is clear. Its position on the map stays the place's real spot.
      type Box = { l: number; t: number; r: number; b: number };
      const taken: Box[] = [];
      for (const s of course.stops) {
        const el = stopEls.current.get(s.order);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const c = container.current!.getBoundingClientRect();
        taken.push({ l: r.left - c.left, t: r.top - c.top, r: r.right - c.left, b: r.bottom - c.top });
      }
      const overlaps = (a: Box) => taken.some((q) => a.l < q.r && a.r > q.l && a.t < q.b && a.b > q.t);
      for (const br of breakEls.current) {
        br.el.style.translate = '';
        const p = proj.containerPointFromCoords(new k.maps.LatLng(br.lat, br.lng));
        const w = br.el.offsetWidth;
        const h = br.el.offsetHeight;
        const at = (dy: number): Box => ({ l: p.x - w / 2, t: p.y - h / 2 + dy, r: p.x + w / 2, b: p.y + h / 2 + dy });
        let dy = 0;
        for (const step of [0, 26, -26, 52, -52, 78, -78]) {
          dy = step;
          if (!overlaps(at(step))) break;
        }
        if (dy) br.el.style.translate = `0 ${dy}px`;
        taken.push(at(dy));
      }
    };
    const t = setTimeout(spread, 50);
    k.maps.event.addListener(map.current, 'zoom_changed', spread);
    return () => {
      clearTimeout(t);
      k.maps.event.removeListener(map.current, 'zoom_changed', spread);
    };
  }, [ready, course]);

  // The start point the user picked on the map (hidden while a course is shown; the course has its own START).
  useEffect(() => {
    const k = kakao.current;
    if (!ready || !k) return;
    pin.current?.setMap(null);
    pin.current = null;
    if (!pickedPoint || course) return;
    const el = document.createElement('div');
    el.className = 'pick-pin';
    el.textContent = t('출발', 'Start');
    pin.current = new k.maps.CustomOverlay({
      map: map.current,
      position: new k.maps.LatLng(pickedPoint.lat, pickedPoint.lng),
      content: el,
      yAnchor: 1,
      zIndex: 5,
    });
  }, [ready, pickedPoint, course, lang]);

  // The finish picked on the map, until a course is shown (the course has its own FINISH).
  useEffect(() => {
    const k = kakao.current;
    if (!ready || !k) return;
    endPin.current?.setMap(null);
    endPin.current = null;
    if (!pickedEnd || course) return;
    const el = document.createElement('div');
    el.className = 'pick-pin is-end';
    el.textContent = t('도착', 'Finish');
    endPin.current = new k.maps.CustomOverlay({
      map: map.current,
      position: new k.maps.LatLng(pickedEnd.lat, pickedEnd.lng),
      content: el,
      yAnchor: 1,
      zIndex: 5,
    });
  }, [ready, pickedEnd, course, lang]);

  // Walk mode: my position as a live dot, the next stop highlighted, and the map framing me and it whenever the next
  // place changes (not on every GPS fix — the map shouldn't jump while someone is looking at it).
  useEffect(() => {
    const k = kakao.current;
    if (!ready || !k) return;
    if (!walk?.me) {
      liveMe.current?.setMap(null);
      liveMe.current = null;
      if (!walk) walkFitted.current = null;
    } else {
      const here = new k.maps.LatLng(walk.me.lat, walk.me.lng);
      if (!liveMe.current) {
        const dot = document.createElement('div');
        dot.className = 'me-dot is-live';
        dot.setAttribute('aria-label', t('내 위치', 'You are here'));
        liveMe.current = new k.maps.CustomOverlay({ map: map.current, position: here, content: dot, zIndex: 7 });
        me.current?.setMap(null); // the start-up dot gives way to the live one
      } else liveMe.current.setPosition(here);
    }
    for (const [order, el] of stopEls.current) el.classList.toggle('is-next', !!walk?.next && walk.next.order === order);
    const target = walk?.next ? `${walk.next.lat},${walk.next.lng}` : null;
    if (walk?.me && walk.next && walkFitted.current !== target) {
      walkFitted.current = target;
      const b = new k.maps.LatLngBounds();
      b.extend(new k.maps.LatLng(walk.me.lat, walk.me.lng));
      b.extend(new k.maps.LatLng(walk.next.lat, walk.next.lng));
      if (isPhone()) map.current.setBounds(b, 64, 40, Math.round(window.innerHeight * 0.58), 40);
      else map.current.setBounds(b, 80, 80, 80, 480);
      // Standing next to the shop: don't zoom in past street level (closer, the map has no detail left to show).
      if (map.current.getLevel() < 3) map.current.setLevel(3);
    }
  }, [ready, walk]);

  // Hovering a course card highlights its marker.
  useEffect(() => {
    for (const [order, el] of stopEls.current) el.classList.toggle('is-active', order === hoverOrder);
  }, [hoverOrder]);

  return (
    <>
      <div ref={container} className={`map-canvas${pickMode ? ' is-picking' : ''}`} />
      {pickMode && (
        <div className="pick-banner">
          <span role="status">
            {pickMode === 'end' ? t('지도를 눌러 끝나는 곳을 정하세요', 'Tap the map to set where you finish') : t('지도를 눌러 출발점을 정하세요', 'Tap the map to set your start')}
          </span>
          {onCancelPick && (
            <button type="button" className="pick-cancel" onClick={onCancelPick}>
              {t('취소', 'Cancel')}
            </button>
          )}
        </div>
      )}
      {/* One stack of map controls: "주변 가게" (with a course) above the legend. */}
      <div className="map-controls">
        <div className="map-zoom" role="group" aria-label={t('지도 확대·축소', 'Map zoom')}>
          <button type="button" aria-label={t('확대', 'Zoom in')} onClick={() => map.current?.setLevel(Math.max(1, map.current.getLevel() - 1), { animate: true })}>
            <Plus size={18} aria-hidden />
          </button>
          <button type="button" aria-label={t('축소', 'Zoom out')} onClick={() => map.current?.setLevel(Math.min(14, map.current.getLevel() + 1), { animate: true })}>
            <Minus size={18} aria-hidden />
          </button>
        </div>
        {course && !pickMode && (
          <button type="button" className={`map-toggle${nearby ? ' is-on' : ''}`} aria-pressed={nearby} onClick={() => setNearby(!nearby)}>
            <Storefront size={16} aria-hidden />
            <span>{t('주변 가게', 'Nearby shops')}</span>
            <span className="map-switch" aria-hidden />
          </button>
        )}
        <MapLegend mode={course ? 'course' : 'shops'} nearby={!!course && nearby} />
      </div>
      {error && <div className="map-error alert alert-danger small mb-0">{error}</div>}
    </>
  );
}
