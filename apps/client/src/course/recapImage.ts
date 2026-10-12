/**
 * The walk's recap as an Instagram-story-sized picture (1080 × 1920), drawn on a canvas in the page — no server, no
 * map tiles (their terms don't allow reuse): the route line on paper, numbered stops (filled = visited), the numbers
 * and the shops. Same look as the app: ink on paper, the route in signal orange, square marks.
 */

import { count, t } from '../i18n';

export interface RecapStop {
  name: string;
  lat: number;
  lng: number;
  /** walk path from the previous stop (street geometry when there is one) */
  path: { lat: number; lng: number }[];
  state: 'arrived' | 'skipped' | 'none';
  liked?: boolean;
  bought?: boolean;
}

export interface Recap {
  title: string; // "성수에서 빈티지"
  date: string; // "2026.10.17 SAT"
  start: { lat: number; lng: number };
  stops: RecapStop[];
  end?: { lat: number; lng: number; path: { lat: number; lng: number }[] } | null;
  km: number;
  minutes: number;
}

const W = 1080;
const H = 1920;
const INK = '#0c0a09';
const INK2 = '#57534e';
const INK3 = '#a8a29e';
const PAPER = '#fafaf9';
const LINE = '#e7e5e4';
const SIGNAL = '#e8470f';
const SANS = 'Pretendard, "Pretendard Variable", -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const SERIF = '"Instrument Serif", "Times New Roman", serif';

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

export async function drawRecap(r: Recap): Promise<HTMLCanvasElement> {
  await document.fonts?.ready;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  const M = 96;

  // Wordmark and date.
  ctx.fillStyle = INK;
  ctx.font = `700 56px ${SANS}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('ROUTE', M, 170);
  const wm = ctx.measureText('ROUTE').width;
  ctx.font = `600 26px ${SANS}`;
  ctx.fillText('01', M + wm + 8, 140);
  ctx.textAlign = 'right';
  ctx.fillStyle = INK2;
  ctx.font = `600 28px ${SANS}`;
  ctx.fillText(r.date, W - M, 168);
  ctx.textAlign = 'left';

  ctx.fillStyle = INK;
  ctx.font = `700 76px ${SANS}`;
  ctx.fillText(fit(ctx, r.title, W - 2 * M), M, 300);
  ctx.font = `500 34px ${SANS}`;
  ctx.fillStyle = INK2;
  const arrived = r.stops.filter((s) => s.state === 'arrived').length;
  ctx.fillText(t(`${r.stops.length}곳 코스 중 ${arrived}곳을 걸었어요`, `Walked ${arrived} of ${count(r.stops.length, '곳', 'shop')}`), M, 360);

  // The route, scaled into a box (north up, same scale both ways).
  const box = { x: M, y: 420, w: W - 2 * M, h: 760 };
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  const pts = [r.start, ...r.stops.flatMap((s) => [...s.path, s]), ...(r.end ? [...r.end.path, r.end] : [])];
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const spanX = Math.max((Math.max(...lngs) - Math.min(...lngs)) * kx, 1e-4);
  const spanY = Math.max(Math.max(...lats) - Math.min(...lats), 1e-4);
  const pad = 80;
  const scale = Math.min((box.w - 2 * pad) / spanX, (box.h - 2 * pad) / spanY);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const midLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  const at = (p: { lat: number; lng: number }) => ({ x: cx + (p.lng - midLng) * kx * scale, y: cy - (p.lat - midLat) * scale });

  ctx.strokeStyle = SIGNAL;
  ctx.lineWidth = 10;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  const line = [r.start, ...r.stops.flatMap((s) => (s.path.length > 2 ? s.path : [s])), ...(r.end ? (r.end.path.length > 2 ? r.end.path : [r.end]) : [])];
  line.forEach((p, i) => {
    const q = at(p);
    if (i === 0) ctx.moveTo(q.x, q.y);
    else ctx.lineTo(q.x, q.y);
  });
  ctx.stroke();

  // START, then numbered squares: visited filled ink, skipped outlined.
  const s0 = at(r.start);
  ctx.fillStyle = INK;
  ctx.fillRect(s0.x - 12, s0.y - 12, 24, 24);
  ctx.font = `700 22px ${SANS}`;
  ctx.fillText('START', s0.x + 22, s0.y + 8);
  r.stops.forEach((s, i) => {
    const q = at(s);
    const size = 52;
    ctx.fillStyle = s.state === 'arrived' ? INK : '#fff';
    ctx.strokeStyle = s.state === 'arrived' ? '#fff' : INK3;
    ctx.lineWidth = 4;
    ctx.fillRect(q.x - size / 2, q.y - size / 2, size, size);
    ctx.strokeRect(q.x - size / 2, q.y - size / 2, size, size);
    ctx.fillStyle = s.state === 'arrived' ? '#fff' : INK3;
    ctx.font = `400 40px ${SERIF}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), q.x, q.y + 14);
    ctx.textAlign = 'left';
  });

  // Numbers.
  const statsY = 1290;
  const stat = (x: number, value: string, label: string) => {
    ctx.fillStyle = INK;
    ctx.font = `400 120px ${SERIF}`;
    ctx.fillText(value, x, statsY);
    ctx.font = `600 24px ${SANS}`;
    ctx.fillStyle = INK2;
    ctx.fillText(label, x, statsY + 44);
  };
  const bought = r.stops.filter((s) => s.bought).length;
  stat(M, r.km.toFixed(1), 'KM');
  stat(M + 250, String(arrived), t('곳 들름', 'VISITED'));
  stat(M + 500, String(bought), t('곳에서 샀어요', 'BOUGHT AT'));
  stat(M + 790, String(Math.round(r.minutes)), 'MIN');

  // The shops.
  let y = 1440;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(M, y - 30);
  ctx.lineTo(W - M, y - 30);
  ctx.stroke();
  const shown = r.stops.slice(0, 7);
  for (const [i, s] of shown.entries()) {
    ctx.fillStyle = s.state === 'arrived' ? INK : INK3;
    ctx.font = `400 40px ${SERIF}`;
    ctx.fillText(String(i + 1).padStart(2, '0'), M, y + 18);
    ctx.font = `${s.state === 'arrived' ? 700 : 500} 34px ${SANS}`;
    const tag = s.bought ? t('샀어요', 'Bought') : s.liked ? t('좋았어요', 'Liked') : s.state === 'skipped' ? t('건너뜀', 'Skipped') : '';
    ctx.fillText(fit(ctx, s.name, W - 2 * M - 120 - (tag ? 140 : 0)), M + 90, y + 14);
    if (tag) {
      ctx.textAlign = 'right';
      ctx.font = `600 26px ${SANS}`;
      ctx.fillStyle = s.bought ? SIGNAL : INK2;
      ctx.fillText(tag, W - M, y + 12);
      ctx.textAlign = 'left';
    }
    y += 62;
  }
  if (r.stops.length > shown.length) {
    ctx.fillStyle = INK2;
    ctx.font = `500 28px ${SANS}`;
    ctx.fillText(t(`외 ${r.stops.length - shown.length}곳`, `+${count(r.stops.length - shown.length, '곳', 'more shop', 'more shops')}`), M + 90, y + 8);
  }

  ctx.fillStyle = INK3;
  ctx.font = `500 26px ${SANS}`;
  ctx.fillText(t('취향대로 걷는 서울 옷가게 코스 · ROUTE 01', 'Seoul clothing-shop walks, made to your taste · ROUTE 01'), M, H - 80);
  return c;
}

/** Phone: the share sheet with the picture (Instagram, KakaoTalk …). Elsewhere: save the file. */
export async function shareOrSave(canvas: HTMLCanvasElement, fileName: string): Promise<'shared' | 'saved' | 'cancelled'> {
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
  if (!blob) return 'cancelled';
  const file = new File([blob], fileName, { type: 'image/png' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: 'ROUTE 01' });
      return 'shared';
    } catch {
      return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return 'saved';
}
