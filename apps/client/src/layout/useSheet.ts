import { useRef, useState } from 'react';

/** Phone bottom sheet positions. Desktop ignores all of this (the panel is a fixed column there). */
export type Snap = 'peek' | 'half' | 'full';

const PHONE = '(max-width: 767.98px)'; // same breakpoint as styles/theme.scss media-breakpoint-down(md)
const HALF = 0.56; // of the viewport: the top of the map (and the course line) stays visible
const TOP_GAP = 48; // "full" leaves a strip of map so it's clear the sheet sits over a map

/**
 * Drag the handle (or the header) to resize the sheet; on release it snaps to the nearest of peek / half / full,
 * nudged by the flick direction. A tap toggles peek ↔ half.
 */
export function useSheet(panel: React.RefObject<HTMLElement | null>, peekPx: () => number) {
  const [snap, setSnap] = useState<Snap>('half');
  const [dragH, setDragH] = useState<number | null>(null);
  const drag = useRef<{ y: number; h: number; t: number; lastY: number; lastT: number } | null>(null);

  const heights = () => {
    const ih = window.innerHeight;
    return { peek: peekPx(), half: Math.round(ih * HALF), full: ih - TOP_GAP };
  };

  function onPointerDown(e: React.PointerEvent) {
    if (!window.matchMedia(PHONE).matches || !panel.current) return;
    const target = e.target as HTMLElement;
    // Only the handle and the header drag the sheet; the list below scrolls normally, header buttons still click.
    if (!target.closest('.sheet-handle, .panel-head') || target.closest('button:not(.sheet-handle), a, input')) return;
    panel.current.setPointerCapture?.(e.pointerId);
    const h = panel.current.getBoundingClientRect().height;
    drag.current = { y: e.clientY, h, t: performance.now(), lastY: e.clientY, lastT: performance.now() };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const { peek, full } = heights();
    setDragH(Math.max(peek, Math.min(full, d.h - (e.clientY - d.y))));
    d.lastY = e.clientY;
    d.lastT = performance.now();
  }

  function onPointerUp(e: React.PointerEvent) {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const moved = e.clientY - d.y;
    setDragH(null);
    if (Math.abs(moved) < 6) {
      setSnap((s) => (s === 'peek' ? 'half' : 'peek')); // a tap
      return;
    }
    const hs = heights();
    const h = d.h - moved;
    const velocity = (e.clientY - d.lastY) / Math.max(1, performance.now() - d.lastT); // px/ms, + = down
    // A quick flick goes one step in its direction; otherwise the nearest position wins.
    const order: Snap[] = ['peek', 'half', 'full'];
    let target = order.reduce((a, b) => (Math.abs(hs[a] - h) <= Math.abs(hs[b] - h) ? a : b));
    if (Math.abs(velocity) > 0.5) {
      const from = order.indexOf(snap);
      target = order[Math.max(0, Math.min(2, from + (velocity < 0 ? 1 : -1)))];
    }
    setSnap(target);
  }

  return {
    snap,
    setSnap,
    /** Inline height while the finger is down; otherwise the CSS for data-snap applies. */
    style: dragH !== null ? { height: `${dragH}px`, transition: 'none' } : undefined,
    dragging: dragH !== null,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
