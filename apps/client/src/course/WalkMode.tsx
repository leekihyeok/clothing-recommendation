import { useMutation } from '@apollo/client';
import { ArrowUpRight, Check, CheckCircle, Coffee, DownloadSimple, Flag, ForkKnife, NavigationArrow, ShareNetwork, ShoppingBag, SkipForward, ThumbsDown, ThumbsUp, X } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { graphql } from '../gql';
import { useRecordShop } from '../me/useMyShops';
import type { PlannedCourse } from './usePlanner';
import { drawRecap, shareOrSave } from './recapImage';
import { CourseRating } from './CourseRating';
import { t } from '../i18n';

const WalkEventDoc = graphql(`
  mutation WalkEvent($courseId: ID!, $action: String!, $arrived: Int, $stops: Int) {
    walkEvent(courseId: $courseId, action: $action, arrived: $arrived, stops: $stops)
  }
`);

type Variant = PlannedCourse['variants'][number];
type LatLng = { lat: number; lng: number };

/** One place on the walk: a shop (recorded as a visit), a café or meal break, or the finish. */
interface Item {
  key: string;
  kind: 'shop' | 'cafe' | 'food' | 'end';
  name: string;
  lat: number;
  lng: number;
  shopId?: string;
  order?: number;
  arriveAt?: string | null;
  hours?: string | null;
  warning?: string | null;
}

/** What the map needs while walking: where I am and where I'm going next. */
export interface WalkState {
  me: (LatLng & { accuracy: number }) | null;
  next: (LatLng & { order?: number; name: string }) | null;
}

// Close enough to ask "도착했어요?". GPS in shopping streets is off by 10-30 m, so the accuracy widens it a little.
const ARRIVE_M = 40;
const MAX_ACCURACY_BONUS_M = 30;
// Same walking model as the API (straight line × 1.3, 70 m a minute).
const DETOUR = 1.3;
const WALK_M_PER_MIN = 70;

function metres(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

const distLabel = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m / 10) * 10}m`);

function items(course: PlannedCourse, v: Variant): Item[] {
  const out: Item[] = [];
  for (const s of v.stops) {
    out.push({
      key: `shop:${s.shop.id}`, kind: 'shop', name: s.shop.name, lat: s.shop.lat, lng: s.shop.lng, shopId: s.shop.id, order: s.order,
      arriveAt: s.arriveAt, hours: s.shop.hoursToday, warning: s.shop.hoursWarning,
    });
    for (const b of (v.breaks ?? []).filter((x) => x.afterOrder === s.order)) {
      out.push({ key: `${b.kind}:${b.name}`, kind: b.kind === 'food' ? 'food' : 'cafe', name: b.name, lat: b.lat, lng: b.lng });
    }
  }
  if (course.end && v.endLeg) out.push({ key: 'end', kind: 'end', name: course.endName ?? t('끝나는 곳', 'Finish'), lat: course.end.lat, lng: course.end.lng });
  return out;
}

/** Progress survives a reload or a phone call (this device only). */
interface Progress {
  done: Record<string, 'arrived' | 'skipped'>;
  /** How a visited shop was (for the recap card). */
  rated?: Record<string, 'like' | 'purchase' | 'dislike'>;
  startedAt: number;
  /** When the last place was passed: the walk's length on the recap. */
  finishedAt?: number;
  finished?: boolean;
}
const storeKey = (courseId: string, variant: string) => `route01.walk.${courseId}.${variant}`;
function loadProgress(key: string): Progress {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as Progress;
  } catch {
    /* storage blocked: start fresh */
  }
  return { done: {}, startedAt: Date.now() };
}
function saveProgress(key: string, p: Progress) {
  try {
    localStorage.setItem(key, JSON.stringify(p));
  } catch {
    /* fine without it */
  }
}

/** Kakao Map walking directions from where I am to the place (official link format). */
const kakaoTo = (it: Item) => `https://map.kakao.com/link/to/${encodeURIComponent(it.name)},${it.lat},${it.lng}`;

interface Props {
  course: PlannedCourse;
  variant: Variant;
  /** "성수에서 빈티지": the recap card's title. */
  title: string;
  onExit: () => void;
  onOpenShop: (id: string) => void;
  onState: (s: WalkState | null) => void;
}

/**
 * 걷기 모드: the course one place at a time on the phone — the next place, how far it is from here, Kakao Map directions,
 * and "도착했어요" (offered by itself when the phone is close). Arriving at a shop records a visit (so the course
 * counts as walked) and asks how it was; the finish shows what the walk came to. The position stays on the device.
 */
export function WalkMode({ course, variant, title, onExit, onOpenShop, onState }: Props) {
  const list = useMemo(() => items(course, variant), [course, variant]);
  const key = storeKey(course.id, variant.variant);
  const [progress, setProgress] = useState<Progress>(() => loadProgress(key));
  // An edit while walking can give the course a new id (a shared course is copied): the progress moves along.
  const savedKey = useRef(key);
  useEffect(() => {
    if (savedKey.current === key) return;
    savedKey.current = key;
    saveProgress(key, progress);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [me, setMe] = useState<WalkState['me']>(null);
  const [geo, setGeo] = useState<'waiting' | 'ok' | 'denied' | 'unavailable'>('waiting');
  // The shop just arrived at: "어땠어요?" until answered or skipped.
  const [rating, setRating] = useState<Item | null>(null);
  const { record } = useRecordShop();
  const [walkEvent] = useMutation(WalkEventDoc);
  const started = useRef(false);

  const next = list.find((it) => !progress.done[it.key]) ?? null;
  const shops = list.filter((it) => it.kind === 'shop');
  const arrived = shops.filter((it) => progress.done[it.key] === 'arrived').length;
  const handled = list.filter((it) => progress.done[it.key]).length;

  function update(p: Progress) {
    setProgress(p);
    saveProgress(key, p);
  }

  // Started once per course version (a reload doesn't count again).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!Object.keys(progress.done).length) walkEvent({ variables: { courseId: course.id, action: 'start', stops: shops.length } }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the position while walking. Nothing of it leaves the device.
  useEffect(() => {
    if (!navigator.geolocation) {
      setGeo('unavailable');
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setGeo('ok');
        setMe({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
      },
      (err) => setGeo(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // Keep the screen on while walking (where the browser allows it); taken again when the page comes back.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const take = async () => {
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        if (wl && document.visibilityState === 'visible') lock = await wl.request('screen');
      } catch {
        lock = null;
      }
    };
    take();
    const again = () => document.visibilityState === 'visible' && take();
    document.addEventListener('visibilitychange', again);
    return () => {
      document.removeEventListener('visibilitychange', again);
      lock?.release().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    onState({ me, next: next ? { lat: next.lat, lng: next.lng, order: next.order, name: next.name } : null });
  }, [me, next?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onState(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const away = me && next ? metres(me, next) : null;
  const close = away !== null && me !== null && away <= ARRIVE_M + Math.min(me.accuracy, MAX_ACCURACY_BONUS_M);

  function mark(it: Item, how: 'arrived' | 'skipped') {
    const done = { ...progress.done, [it.key]: how };
    const finished = list.every((x) => done[x.key]);
    update({ ...progress, done, finished, finishedAt: finished ? Date.now() : undefined });
    if (how === 'arrived' && it.shopId) {
      record(it.shopId, 'visit', course.id);
      setRating(it);
    } else setRating(null);
    if (finished) {
      const n = shops.filter((x) => done[x.key] === 'arrived').length;
      walkEvent({ variables: { courseId: course.id, action: 'finish', arrived: n, stops: shops.length } }).catch(() => undefined);
    }
  }

  function rate(action: 'like' | 'purchase' | 'dislike') {
    if (rating) update({ ...progress, rated: { ...progress.rated, [rating.key]: action } });
    if (rating?.shopId) {
      record(rating.shopId, action, course.id);
      // Bought something: it was good too.
      if (action === 'purchase') record(rating.shopId, 'like', course.id);
    }
    setRating(null);
  }

  function restart() {
    update({ done: {}, startedAt: Date.now() });
    setRating(null);
  }

  const minutes = Math.max(1, Math.round(((progress.finishedAt ?? Date.now()) - progress.startedAt) / 60_000));
  const bought = shops.filter((it) => progress.rated?.[it.key] === 'purchase').length;

  // The recap picture, made when the walk is done (and again after "되돌리기" changes it).
  const [recap, setRecap] = useState<{ url: string; canvas: HTMLCanvasElement } | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);
  useEffect(() => {
    if (next) return;
    let gone = false;
    let url = '';
    const stops = variant.stops.map((s) => {
      const k = `shop:${s.shop.id}`;
      return {
        name: s.shop.name, lat: s.shop.lat, lng: s.shop.lng, path: s.legFromPrev.path,
        state: (progress.done[k] ?? 'none') as 'arrived' | 'skipped' | 'none',
        liked: progress.rated?.[k] === 'like', bought: progress.rated?.[k] === 'purchase',
      };
    });
    const day = new Date(progress.startedAt);
    const date = `${day.getFullYear()}.${String(day.getMonth() + 1).padStart(2, '0')}.${String(day.getDate()).padStart(2, '0')} ${['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][day.getDay()]}`;
    drawRecap({
      title, date, start: course.origin, stops,
      end: course.end && variant.endLeg ? { ...course.end, path: variant.endLeg.path } : null,
      km: variant.totalDistanceM / 1000, minutes,
    }).then((canvas) => {
      if (gone) return;
      canvas.toBlob((b) => {
        if (gone || !b) return;
        url = URL.createObjectURL(b);
        setRecap({ url, canvas });
      }, 'image/png');
    });
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [next?.key, progress]); // eslint-disable-line react-hooks/exhaustive-deps
  const icon = (it: Item, size = 18) =>
    it.kind === 'cafe' ? <Coffee size={size} aria-hidden /> : it.kind === 'food' ? <ForkKnife size={size} aria-hidden /> : it.kind === 'end' ? <Flag size={size} aria-hidden /> : null;

  return (
    <section className="walk" aria-labelledby="walk-title">
      <div className="walk-head">
        <p className="eyebrow mb-0">
          <span>Walking</span>
          <span className="ko">{t('걷기 모드', 'Walk mode')}</span>
        </p>
        <button type="button" className="btn-text" onClick={onExit}>
          <X size={14} aria-hidden /> {t('코스로 돌아가기', 'Back to route')}
        </button>
      </div>
      <ol className="walk-progress" aria-label={t(`${list.length}곳 중 ${handled}곳 지남`, `${handled} of ${list.length} stops passed`)}>
        {list.map((it) => (
          <li key={it.key} className={progress.done[it.key] === 'arrived' ? 'is-done' : progress.done[it.key] ? 'is-skipped' : it === next ? 'is-next' : ''} />
        ))}
      </ol>

      {rating && (
        <div className="walk-rate" role="group" aria-labelledby="walk-rate-label">
          <p id="walk-rate-label">
            <CheckCircle size={18} weight="fill" aria-hidden /> {t('', 'You visited ')}<strong>{rating.name}</strong>{t(' 다녀왔어요. 어땠어요?', '. How was it?')}
          </p>
          <div className="walk-rate-buttons">
            <button type="button" className="action-btn" onClick={() => rate('like')}>
              <ThumbsUp size={18} aria-hidden /> {t('좋았어요', 'Liked it')}
            </button>
            <button type="button" className="action-btn" onClick={() => rate('purchase')}>
              <ShoppingBag size={18} aria-hidden /> {t('샀어요', 'Bought something')}
            </button>
            <button type="button" className="action-btn" onClick={() => rate('dislike')}>
              <ThumbsDown size={18} aria-hidden /> {t('별로였어요', 'Not for me')}
            </button>
          </div>
          <button type="button" className="btn-text" onClick={() => setRating(null)}>
            {t('나중에 할게요', 'Maybe later')}
          </button>
        </div>
      )}

      {next ? (
        <div className={`walk-next${close ? ' is-close' : ''}`}>
          <p className="walk-label tabular">
            {next.kind === 'shop' ? `Next ${String(next.order).padStart(2, '0')}` : next.kind === 'end' ? 'Finish' : next.kind === 'cafe' ? t('Break · 카페', 'Break · Café') : t('Break · 맛집', 'Break · Food')}
          </p>
          <h2 id="walk-title" className="walk-name">
            {icon(next, 22)}
            {next.shopId ? (
              <button type="button" className="shop-link" onClick={() => onOpenShop(next.shopId!)}>
                {next.name}
              </button>
            ) : (
              next.name
            )}
          </h2>
          {/* Read out when the next place changes, not on every position update (the distance below isn't live). */}
          <p className="visually-hidden" aria-live="polite">
            {t(`다음 장소: ${next.name}`, `Next: ${next.name}`)}
          </p>
          <p className="walk-dist tabular">
            {away !== null
              ? close
                ? t('거의 다 왔어요', 'Almost there')
                : t(`${distLabel(away * DETOUR)} · 걸어서 약 ${Math.max(1, Math.round((away * DETOUR) / WALK_M_PER_MIN))}분`, `${distLabel(away * DETOUR)} · about ${Math.max(1, Math.round((away * DETOUR) / WALK_M_PER_MIN))} min on foot`)
              : geo === 'waiting'
                ? t('위치 확인 중…', 'Finding you…')
                : geo === 'denied'
                  ? t('위치 권한을 켜면 남은 거리를 알려 드려요', 'Turn on location to see how far it is')
                  : t('지금은 위치를 알 수 없어요', 'Can’t find your location right now')}
          </p>
          {(next.arriveAt || next.hours || next.warning) && (
            <p className="walk-meta">
              {next.arriveAt && <span>{t(`예정 ${next.arriveAt} 도착`, `Due ${next.arriveAt}`)}</span>}
              {next.hours && <span>{next.hours}</span>}
              {next.warning && <span className="is-warning">{next.warning}</span>}
            </p>
          )}
          <button type="button" className="btn-ink" onClick={() => mark(next, 'arrived')}>
            <span className="d-inline-flex align-items-center gap-2">
              <Check size={18} aria-hidden /> {next.kind === 'end' ? t('도착했어요 · 코스 끝', 'I’m here · end of route') : t('도착했어요', 'I’m here')}
            </span>
          </button>
          <div className="btn-pair">
            <a className="btn-line" href={kakaoTo(next)} target="_blank" rel="noreferrer">
              <NavigationArrow size={16} aria-hidden /> {t('길찾기', 'Directions')} <ArrowUpRight size={12} aria-hidden />
            </a>
            <button type="button" className="btn-line" onClick={() => mark(next, 'skipped')}>
              <SkipForward size={16} aria-hidden /> {next.kind === 'shop' ? t('이번엔 건너뛰기', 'Skip this one') : t('안 들르기', 'Skip')}
            </button>
          </div>
          {close && <p className="hint mb-0" role="status">{t(`${next.name} 근처예요. 도착했으면 눌러 주세요.`, `You’re near ${next.name}. Tap when you’re there.`)}</p>}
        </div>
      ) : (
        <div className="walk-done">
          <p className="walk-label">Done</p>
          <h2 id="walk-title" className="walk-name">
            {t('코스를 다 돌았어요', 'You walked the whole route')}
          </h2>
          <ul className="course-stats">
            <li>
              <strong className="tabular">{arrived}</strong>/{shops.length}{t('곳 들름', ' visited')}
            </li>
            {bought > 0 && (
              <li>
                <strong className="tabular">{bought}</strong>{t('곳 샀어요', bought === 1 ? ' shop bought from' : ' shops bought from')}
              </li>
            )}
            <li>
              <strong className="tabular">{(variant.totalDistanceM / 1000).toFixed(1)}</strong>km
            </li>
            <li>
              <strong className="tabular">{minutes}</strong>min
            </li>
          </ul>
          <CourseRating courseId={course.id} />
          {recap && (
            <figure className="recap">
              <img src={recap.url} alt={t(`오늘 걸은 코스 요약: ${title}, ${arrived}곳 들름, ${(variant.totalDistanceM / 1000).toFixed(1)}km`, `Today’s walk: ${title}, ${arrived} visited, ${(variant.totalDistanceM / 1000).toFixed(1)} km`)} />
              <figcaption className="btn-pair">
                <button
                  type="button"
                  className="btn-line"
                  onClick={async () => {
                    setShareNote(null);
                    const how = await shareOrSave(recap.canvas, `route01-${course.id.slice(0, 8)}.png`);
                    if (how === 'saved') setShareNote(t('이미지를 저장했어요. 인스타 스토리나 카톡에 올려 보세요', 'Picture saved. Post it to your Instagram story or send it to friends'));
                  }}
                >
                  {'share' in navigator ? <ShareNetwork size={16} aria-hidden /> : <DownloadSimple size={16} aria-hidden />}
                  {'share' in navigator ? t('요약 카드 공유', 'Share recap card') : t('요약 카드 저장', 'Save recap card')}
                </button>
              </figcaption>
              {shareNote && (
                <p className="hint mb-0" role="status">
                  {shareNote}
                </p>
              )}
            </figure>
          )}
          <p className="hint">{t('다녀온 가게와 남긴 평가는 마이페이지 ‘다녀온 곳’에 있고, 다음 코스 추천에 반영돼요.', 'The shops you visited and how you rated them are under ‘Visited’ in My page, and shape your next routes.')}</p>
          <div className="btn-pair">
            <button type="button" className="btn-line" onClick={restart}>
              {t('처음부터 다시', 'Start over')}
            </button>
            <button type="button" className="btn-line" onClick={onExit}>
              {t('코스로 돌아가기', 'Back to route')}
            </button>
          </div>
        </div>
      )}

      <ol className="walk-list">
        {list.map((it) => {
          const state = progress.done[it.key];
          return (
            <li key={it.key} className={state ? `is-${state}` : it === next ? 'is-next' : ''}>
              <span className="walk-list-mark" aria-hidden>
                {state === 'arrived' ? <Check size={14} weight="bold" /> : it.order ? String(it.order).padStart(2, '0') : icon(it, 14)}
              </span>
              <span className="walk-list-name">{it.name}</span>
              <span className="walk-list-state">
                {state === 'arrived' ? t('다녀옴', 'Visited') : state === 'skipped' ? t('건너뜀', 'Skipped') : it === next ? t('다음', 'Next') : (it.arriveAt ?? '')}
              </span>
              {state && (
                <button
                  type="button"
                  className="btn-text"
                  aria-label={t(`${it.name} 다시 가기로`, `Put ${it.name} back on the walk`)}
                  onClick={() => {
                    const done = { ...progress.done };
                    delete done[it.key];
                    update({ ...progress, done, finished: false });
                  }}
                >
                  {t('되돌리기', 'Undo')}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      <p className="hint">{t('위치는 이 휴대폰에서만 쓰고 서버에 보내지 않아요. 걷는 동안 화면이 꺼지지 않게 해 둘게요.', 'Your location stays on this phone and is never sent to our server. The screen stays on while you walk.')}</p>
    </section>
  );
}
