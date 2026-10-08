import { useApolloClient } from '@apollo/client';
import { useEffect, useRef, useState } from 'react';
import { graphql } from '../gql';
import type { ShopsInBoundsQuery } from '../gql/graphql';
import { CATEGORY_BY_ID } from './categories';
import { Storefront } from '@phosphor-icons/react';
import { MapLegend } from './MapLegend';
import { type Kakao, loadKakaoMaps } from './kakao';

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
  /** "지도에서 출발점 고르기": the next tap on the map sets the start. */
  pickMode: boolean;
  pickedPoint: { lat: number; lng: number } | null;
  onPickPoint: (p: { lat: number; lng: number }) => void;
  /** A shop picked from 내 가게: the map moves to it. */
  focusShop: { lat: number; lng: number } | null;
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
// Same breakpoint as the bottom-sheet layout in styles/theme.scss (media-breakpoint-down(md)).
const isPhone = () => window.matchMedia('(max-width: 767.98px)').matches;

export function ShopMap({
  categories, regions, focusRegionId, focusShop, pickMode, pickedPoint, onPickPoint, course, hoverOrder, onSelect, onViewport, onCenter, onBounds,
  locateOnStart,
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
  // Latest props for the map's idle listener, which is registered once.
  const latest = useRef({ categories, onSelect, onViewport, onCenter, onBounds, course, focusRegionId, pickMode, onPickPoint, nearby });
  latest.current = { categories, onSelect, onViewport, onCenter, onBounds, course, focusRegionId, pickMode, onPickPoint, nearby };
  const me = useRef<Kakao>(null);
  const pin = useRef<Kakao>(null);

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
      el.title = aroundCourse ? `${shop.name} · 눌러서 코스에 넣기` : shop.name;
      el.setAttribute('aria-label', aroundCourse ? `${shop.name}, 코스에 넣을 수 있는 주변 가게` : shop.name);
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
    loadKakaoMaps()
      .then((k) => {
        if (cancelled || !container.current) return;
        kakao.current = k;
        map.current = new k.maps.Map(container.current, {
          center: new k.maps.LatLng(SEONGSU.lat, SEONGSU.lng),
          level: 4,
        });
        // Phones pinch to zoom; the +/- control only takes space there.
        if (!isPhone()) {
          map.current.addControl(new k.maps.ZoomControl(), k.maps.ControlPosition.RIGHT);
        }
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
              if (cancelled || !inSeoul(lat, lng) || latest.current.course) return;
              const here = new k.maps.LatLng(lat, lng);
              const dot = document.createElement('div');
              dot.className = 'me-dot';
              dot.setAttribute('aria-label', '내 위치');
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
      stopEls.current.set(s.order, el);
      courseLayer.current.push(new k.maps.CustomOverlay({ map: map.current, position: pos, content: el, xAnchor: 0, yAnchor: 0.5, zIndex: 3 }));
    }
    for (const br of course.breaks ?? []) {
      const pos = new k.maps.LatLng(br.lat, br.lng);
      bounds.extend(pos);
      const el = document.createElement('div');
      el.className = `break-marker is-${br.kind}`;
      breakEls.current.push({ el, lat: br.lat, lng: br.lng });
      el.textContent = `${br.kind === 'food' ? '맛집' : '카페'} · ${br.name}`;
      courseLayer.current.push(new k.maps.CustomOverlay({ map: map.current, position: pos, content: el, yAnchor: 0.5, zIndex: 2 }));
    }
    // Follow the streets when the legs carry a walking path; otherwise this is the straight line through the stops.
    const line = course.stops.some((st) => (st.legFromPrev?.path.length ?? 0) > 2)
      ? course.stops.flatMap((st) => (st.legFromPrev?.path ?? [st.shop]).map((q) => new k.maps.LatLng(q.lat, q.lng)))
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
    el.textContent = '출발';
    pin.current = new k.maps.CustomOverlay({
      map: map.current,
      position: new k.maps.LatLng(pickedPoint.lat, pickedPoint.lng),
      content: el,
      yAnchor: 1,
      zIndex: 5,
    });
  }, [ready, pickedPoint, course]);

  // Hovering a course card highlights its marker.
  useEffect(() => {
    for (const [order, el] of stopEls.current) el.classList.toggle('is-active', order === hoverOrder);
  }, [hoverOrder]);

  return (
    <>
      <div ref={container} className={`map-canvas${pickMode ? ' is-picking' : ''}`} />
      {pickMode && (
        <div className="pick-banner" role="status">
          지도를 눌러 출발점을 정하세요
        </div>
      )}
      {/* One stack of map controls: "주변 가게" (with a course) above the legend. */}
      <div className="map-controls">
        {course && !pickMode && (
          <button type="button" className={`map-toggle${nearby ? ' is-on' : ''}`} aria-pressed={nearby} onClick={() => setNearby(!nearby)}>
            <Storefront size={16} aria-hidden />
            <span>주변 가게</span>
            <span className="map-switch" aria-hidden />
          </button>
        )}
        <MapLegend mode={course ? 'course' : 'shops'} nearby={!!course && nearby} />
      </div>
      {error && <div className="map-error alert alert-danger small mb-0">{error}</div>}
    </>
  );
}
