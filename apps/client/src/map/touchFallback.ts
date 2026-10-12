import type { Kakao } from './kakao';

/**
 * Kakao Maps picks mouse or touch handling from the user agent when it loads. A touch screen with a desktop user agent
 * (iPad Safari by default, touch laptops, a browser's device mode switched on without a reload) gets mouse handling
 * only, and the map can't be dragged or pinched. On those devices this adds the two gestures itself: one finger pans,
 * two fingers zoom. A tap without movement is left alone, so markers stay clickable.
 */
export function needsTouchFallback(): boolean {
  const mobileUa = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return !mobileUa && (navigator.maxTouchPoints ?? 0) > 0;
}

const MOVE_PX = 8; // less than this is a tap

export function attachTouchFallback(el: HTMLElement, map: Kakao, k: Kakao): () => void {
  let last: { x: number; y: number } | null = null;
  let moved = false;
  let pinch: { dist: number; level: number } | null = null;
  const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  const start = (e: TouchEvent) => {
    if (e.touches.length === 1) {
      last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      moved = false;
      pinch = null;
    } else if (e.touches.length === 2) {
      pinch = { dist: dist(e.touches), level: map.getLevel() };
      last = null;
    }
  };
  const move = (e: TouchEvent) => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      // Twice as far apart = one level closer.
      const level = Math.min(14, Math.max(1, pinch.level - Math.round(Math.log2(dist(e.touches) / pinch.dist))));
      if (level !== map.getLevel()) map.setLevel(level);
      return;
    }
    if (!last || e.touches.length !== 1) return;
    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;
    if (!moved && Math.hypot(x - last.x, y - last.y) < MOVE_PX) return;
    moved = true;
    e.preventDefault();
    const proj = map.getProjection();
    const c = proj.containerPointFromCoords(map.getCenter());
    map.setCenter(proj.coordsFromContainerPoint(new k.maps.Point(c.x - (x - last.x), c.y - (y - last.y))));
    last = { x, y };
  };
  const end = (e: TouchEvent) => {
    if (e.touches.length === 0) {
      last = null;
      pinch = null;
    }
  };
  el.style.touchAction = 'none'; // the browser doesn't scroll or zoom the page under the map
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchmove', move, { passive: false });
  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', end, { passive: true });
  return () => {
    el.removeEventListener('touchstart', start);
    el.removeEventListener('touchmove', move);
    el.removeEventListener('touchend', end);
    el.removeEventListener('touchcancel', end);
  };
}
