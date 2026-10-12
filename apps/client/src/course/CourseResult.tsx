import { ArrowArcLeft, ArrowClockwise, ArrowDown, ArrowUp, ArrowUpRight, ArrowsClockwise, BookmarkSimple, CalendarBlank, Clock, CloudRain, CloudSun, Coffee, DotsSixVertical, DotsThree, Flag, ForkKnife, Info, LinkSimple, MagnifyingGlass, MapTrifold, Megaphone, PersonSimpleWalk, Plus, PushPin, ShareNetwork, Snowflake, Sparkle, Storefront, Sun, Tag, ThermometerCold, ThermometerHot, Warning, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { CATEGORY_BY_ID } from '../map/categories';
import { ClosedReport, RatePrompt, SaveButton, VisitButton } from '../me/ShopActions';
import { useShopStates } from '../me/useMyShops';
import type { Echo } from './PromptBox';
import { distance, ShopSearch, useShopHits } from './ShopSearch';
import type { CourseEditor } from './useCourseEdit';
import { RouteFromHere, TransitCard } from './Transit';
import { useCourseSave, useShareCourse } from './useSavedCourses';
import { GENDER_OPTIONS } from './CourseForm';
import type { Gender, PlannedCourse } from './usePlanner';
import { startLabel } from './WhenFinish';
import { GroupInvite } from './Group';
import { count, getLang, t } from '../i18n';

const PRICE_LABEL = (): Record<string, string> => ({ low: t('저렴', 'Budget'), mid: t('중간', 'Mid-range'), high: t('고가', 'High-end') });

interface Props {
  course: PlannedCourse;
  styleLabels: Record<string, string>;
  variantIndex: number;
  activeOrder: number | null;
  onVariant: (index: number) => void;
  onHoverStop: (order: number | null) => void;
  onFitAll: () => void;
  onAnother: () => void;
  /** "누구 옷" changed: plan the course again for it. */
  onGender: (g: Gender) => void;
  /** The shop's name opens its detail page. */
  onOpenShop: (id: string) => void;
  /** Saving someone else's or a shared course saved my own copy: switch to its id. */
  onCourseId: (id: string) => void;
  /** "다른 지역으로 이어 가기": plan the next area, starting where this course ends. */
  regions: { id: string; name: string }[];
  onContinue: (regionId: string) => void;
  onOpenCourse: (id: string) => void;
  echo: Echo | null;
  busy: boolean;
  editor: CourseEditor;
  /** "걷기 시작": walk mode for this version of the course. */
  onWalk: () => void;
  /** Plan the same course again with the weather off (false) or back on (true). */
  onWeather: (on: boolean) => void;
}

type Variant = PlannedCourse['variants'][number];

/**
 * The card's less frequent actions behind "⋯": shop details, Kakao Map, report closed. Esc or a tap outside closes
 * it; the first item takes focus so the keyboard can go straight on.
 */
function CardMenu({ shopId, name, placeUrl, state, courseId, onOpenShop, onFind }: {
  shopId: string;
  name: string;
  placeUrl: string | null;
  state: Parameters<typeof ClosedReport>[0]['state'];
  courseId: string;
  onOpenShop: (id: string) => void;
  /** "이름으로 찾아 바꾸기": open the shop search for this stop. */
  onFind: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="card-menu" ref={box}>
      <button type="button" className="is-icon" aria-label={t(`${name} 더 보기`, `More for ${name}`)} title={t('더 보기', 'More')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <DotsThree size={18} weight="bold" />
      </button>
      {open && (
        <div className="card-menu-list" role="menu">
          <button
            ref={first}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenShop(shopId);
            }}
          >
            <Info size={16} aria-hidden /> {t('가게 정보', 'Shop info')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onFind();
            }}
          >
            <MagnifyingGlass size={16} aria-hidden /> {t('이름으로 찾아 바꾸기', 'Swap by name')}
          </button>
          {placeUrl && (
            <a role="menuitem" href={placeUrl} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
              <MapTrifold size={16} aria-hidden /> {t('카카오맵에서 보기', 'View in Kakao Map')} <ArrowUpRight size={12} aria-hidden />
            </a>
          )}
          <ClosedReport shopId={shopId} state={state} courseId={courseId} />
        </div>
      )}
    </div>
  );
}

/**
 * The shop name in what was typed, if it looks like one: "팔라스 넣어줘" → "팔라스", "EQL도" → "EQL". Anything with a
 * stop number or longer than a few words is an instruction for the assistant, not a name.
 */
function nameIn(text: string): string {
  const t = text.trim();
  if (!t || /\d/.test(t)) return '';
  const q = t
    .replace(/\s*(?:(?:도|를|을)\s*)?(?:꼭\s*)?(?:넣어\s*(?:줘|주세요)?|추가(?:\s*해\s*(?:줘|주세요))?|들르고\s*싶어|가고\s*싶어)\s*[.!?~]*$/, '')
    .trim();
  return q.length <= 20 && q.split(/\s+/).length <= 3 ? q : '';
}

// A suggested shop farther than this from the course is marked "멀어요": the walk gets long.
const FAR_SUGGEST_M = 1500;

const BREAK_LABEL = (): Record<string, string> => ({ cafe: t('카페', 'Café'), food: t('맛집', 'Food spot') });

const DRAG_THRESHOLD_PX = 6;

/** How a version differs from the recommended one: distance and how many shops changed. */
function variantDiff(base: Variant, v: Variant): string {
  const dm = v.totalDistanceM - base.totalDistanceM;
  const baseIds = new Set(base.stops.map((s) => s.shop.id));
  const changed = v.stops.filter((s) => !baseIds.has(s.shop.id)).length;
  const d = Math.abs(dm) >= 1000 ? `${(Math.abs(dm) / 1000).toFixed(1)}km` : `${Math.round(Math.abs(dm) / 10) * 10}m`;
  if (getLang() === 'en') {
    const dist = Math.abs(dm) < 50 ? 'About as long as the recommended route' : `${d} ${dm < 0 ? 'shorter' : 'longer'} than the recommended route`;
    return `${dist}, ${count(changed, '곳', 'different shop')}`;
  }
  const dist = Math.abs(dm) < 50 ? '거리는 비슷하고' : `${d} ${dm < 0 ? '짧고' : '길고'}`;
  return `추천 코스보다 ${dist}, 가게 ${changed}곳이 달라요`;
}

const ASK_EXAMPLES = () => (getLang() === 'en' ? ['A bit closer together', 'Swap stop 2', 'Add a shoe shop'] : ['좀 더 가깝게', '2번 다른 데로', '신발 가게 하나 추가']);

const WEATHER_ICON: Record<string, typeof Sun> = { rain: CloudRain, snow: Snowflake, hot: ThermometerHot, cold: ThermometerCold, fine: CloudSun };

/**
 * The course's weather (its hours, from the forecast) and what it did to the course. Bad weather and applied: the
 * reason and "날씨 무시하고 다시 짜기"; turned off: "날씨 반영하기".
 */
function WeatherLine({ w, ignored, busy, onToggle }: { w: NonNullable<PlannedCourse['weather']>; ignored: boolean; busy: boolean; onToggle: (on: boolean) => void }) {
  const Icon = WEATHER_ICON[w.condition] ?? Sun;
  const bad = w.condition !== 'fine';
  return (
    <div className={`weather-line${bad ? ' is-bad' : ''}`}>
      <p className="weather-sum tabular">
        <Icon size={16} weight={bad ? 'fill' : 'regular'} aria-hidden />
        <span>
          <span className="visually-hidden">{t('코스 시간 날씨: ', 'Weather during the route: ')}</span>
          {w.summary}
        </span>
      </p>
      {w.applied && w.note && <p className="weather-note">{w.note}</p>}
      {bad && (
        <button type="button" className="btn-text" disabled={busy} onClick={() => onToggle(ignored)}>
          {ignored ? t('날씨 반영해서 다시 짜기', 'Replan with the weather') : t('날씨 무시하고 다시 짜기', 'Replan ignoring the weather')}
        </button>
      )}
    </div>
  );
}

/** "살로몬은" / "아더에러는": 은/는 by the last syllable (Latin or digits read as no final consonant). */
function topic(word: string): string {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  return `${word}${c >= 0 && c <= 11171 && c % 28 ? '은' : '는'}`;
}

// Same limit as MAX_MUST in apps/api/src/course/course.service.ts.
const MAX_PINS = 8;

/**
 * The card's pin: a pinned shop stays when the course is planned again ("다른 코스", 누구 옷, 시간 제한 없이).
 * Filled pin + the "고정" tag on the card say it, not colour alone.
 */
function PinButton({ name, pinned, full, disabled, onToggle }: { name: string; pinned: boolean; full: boolean; disabled: boolean; onToggle: () => void }) {
  const label = pinned ? t(`${name} 고정 풀기`, `Unpin ${name}`) : full ? t(`고정은 ${MAX_PINS}곳까지예요`, `You can pin up to ${MAX_PINS} shops`) : t(`${name} 고정 · 다른 코스에서도 남기기`, `Pin ${name} · keep it in other routes`);
  return (
    <button
      type="button"
      className={`save-btn pin-btn${pinned ? ' is-on' : ''}`}
      aria-pressed={pinned}
      aria-label={label}
      title={label}
      disabled={disabled || (!pinned && full)}
      onClick={onToggle}
    >
      <PushPin size={20} weight={pinned ? 'fill' : 'regular'} />
    </button>
  );
}

export function CourseResult({ course, styleLabels, variantIndex, activeOrder, onVariant, onHoverStop, onFitAll, onAnother, onGender, onOpenShop, onCourseId, regions, onContinue, onOpenCourse, echo, busy, editor, onWalk, onWeather }: Props) {
  const v = course.variants[variantIndex] ?? course.variants[0];
  const [ask, setAsk] = useState('');
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);
  // "이름으로 찾아 바꾸기" on a card: which stop the shop search is open for, null when closed.
  const [finder, setFinder] = useState<number | null>(null);
  const middle = v.stops.length
    ? { lat: v.stops.reduce((a, s) => a + s.shop.lat, 0) / v.stops.length, lng: v.stops.reduce((a, s) => a + s.shop.lng, 0) / v.stops.length }
    : course.origin;
  const inCourse = v.stops.map((s) => s.shop.id);
  // One box for both: a shop's name brings up matching shops to put in at once; a sentence goes to the assistant.
  const named = useShopHits(nameIn(ask), middle, true);
  const suggestions = named.hits.filter((h) => !inCourse.includes(h.id)).slice(0, 4);
  async function pick(shopId: string, order: number | null) {
    setFinder(null);
    await editor.apply(order ? { op: 'replace', order, shopId } : { op: 'add', shopId });
  }
  // Dragging a card: which stop, where it would land, how far it moved. Starts only after a few pixels (no accidental drags).
  const listRef = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<{ from: number; over: number; startY: number; dy: number; moved: boolean } | null>(null);

  function startDrag(e: React.PointerEvent, order: number) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: order, over: order, startY: e.clientY, dy: 0, moved: false });
  }
  function moveDrag(e: React.PointerEvent) {
    if (!drag || !listRef.current) return;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    // The stop whose card middle is nearest the pointer is where the dragged one lands.
    const cards = ([...listRef.current.children] as HTMLElement[]).filter((el) => !el.classList.contains('course-end'));
    let over = drag.from;
    let best = Infinity;
    cards.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const d = Math.abs(e.clientY - (r.top + r.height / 2));
      if (d < best) [best, over] = [d, i + 1];
    });
    setDrag({ ...drag, dy, over, moved: true });
  }
  function endDrag() {
    if (drag?.moved && drag.over !== drag.from) editor.apply({ op: 'move', order: drag.from, toOrder: drag.over });
    setDrag(null);
  }
  const sharer = useShareCourse();
  const saver = useCourseSave(course.id, onCourseId);
  const working = busy || editor.busy;
  const last = v.stops.length;
  const states = useShopStates(v.stops.map((s) => s.shop.id));
  const styleText = course.request.styles.length
    ? course.request.styles.map((s) => styleLabels[s] ?? s).join(' · ')
    : t('둘러보기 좋은 가게', 'Browsing');
  const regionText = course.request.regionName ?? t('이 근처', 'this area');
  const title = t(`${regionText}에서 ${styleText} ${v.stops.length}곳 걷기`, `${styleText} in ${regionText} · ${count(v.stops.length, '곳', 'shop')}`);
  const pins = new Set(course.request.mustShops.map((m) => m.id));
  const pinnedHere = v.stops.filter((s) => pins.has(s.shop.id)).length;

  return (
    <section aria-labelledby="course-title">
      <p className="eyebrow mb-2">
        <span>Route {String(variantIndex + 1).padStart(2, '0')} · {course.request.regionName ?? 'Near you'}</span>
        {course.startName && <span className="ko">{t(`${course.startName}에서 출발`, `From ${course.startName}`)}</span>}
      </p>
      <h2 className="course-title" id="course-title">
        {t(`${regionText}에서 ${styleText}`, `${styleText} in ${regionText}`)}
        <br />
        {t(`${v.stops.length}곳 걷기`, `${count(v.stops.length, '곳', 'shop')} on foot`)}
      </h2>

      {course.link && (
        <div className="course-link">
          <button type="button" className="btn-text p-0" style={{ minHeight: 32 }} onClick={() => onOpenCourse(course.link!.prevCourseId)}>
            <ArrowArcLeft size={14} aria-hidden /> {t(`${course.link.prevName} 코스에서 이어 왔어요`, `Continued from the ${course.link.prevName} route`)}
          </button>
          <TransitCard route={course.link.transit} title={`${course.link.fromShop} → ${course.startName ?? t('출발점', 'Start')}`} />
        </div>
      )}
      {course.request.groupNames && course.request.groupNames.length > 1 && (
        <p className="taste-note">
          <Sparkle size={14} aria-hidden /> {t(`${course.request.groupNames.join(' + ')} 취향을 섞어 짠 코스`, `A route mixing the tastes of ${course.request.groupNames.join(' + ')}`)}
        </p>
      )}
      {course.request.tasteNote && (
        <p className="taste-note">
          <Sparkle size={14} aria-hidden /> {course.request.tasteNote}
        </p>
      )}

      {course.shared && (
        <div className="region-note mt-3">
          <LinkSimple size={14} aria-hidden /> {t('공유받은 코스예요. 고치면 내 코스로 따로 저장돼요.', 'Someone shared this route with you. Edit it and it’s saved as your own copy.')}
        </div>
      )}

      {echo && (
        <div className="prompt-echo">
          <Sparkle size={14} aria-hidden />
          <div>
            <div className="prompt-said">“{echo.text}”</div>
            <div>
              <strong>{t('이렇게 이해했어요', 'Here’s what I understood')}</strong> · {echo.summary}
            </div>
            {echo.notes.map((n) => (
              <div key={n} className="prompt-note">
                <Warning size={12} aria-hidden /> {n}
              </div>
            ))}
          </div>
        </div>
      )}

      <ul className="course-stats">
        <li>
          <strong className="tabular">{(v.totalDistanceM / 1000).toFixed(1)}</strong>km
        </li>
        <li>
          <strong className="tabular">{Math.round(v.walkMin)}</strong>min walk
        </li>
        <li>
          <strong className="tabular">{Math.round(v.totalMin)}</strong>min total
        </li>
      </ul>
      {course.weather && <WeatherLine w={course.weather} ignored={course.request.ignoreWeather} busy={working} onToggle={onWeather} />}
      {(course.request.startAt || course.request.endBy || course.endName) && (
        <p className="course-schedule tabular">
          <CalendarBlank size={14} aria-hidden />
          {[
            course.request.startAt ? t(`${startLabel(course.request.startAt)} 출발`, `Leaving ${startLabel(course.request.startAt)}`) : t('지금 출발', 'Leaving now'),
            v.finishAt ? t(`${v.finishAt} 끝 (예정)`, `Ends around ${v.finishAt}`) : course.request.endBy ? t(`${course.request.endBy}까지`, `Until ${course.request.endBy}`) : null,
            course.endName ? `${course.request.roundTrip ? t('출발점으로 돌아와요', 'Back to the start') : t(`${course.endName}에서 끝`, `Ends at ${course.endName}`)}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}

      <button type="button" className="btn-ink walk-start" disabled={working || !v.stops.length} onClick={onWalk}>
        <span className="d-inline-flex align-items-center gap-2">
          <PersonSimpleWalk size={18} aria-hidden /> {t('걷기 시작', 'Start walking')}
        </span>
        <span className="walk-start-sub">{t('다음 가게까지 안내', 'Guides you shop to shop')}</span>
      </button>

      <div className="btn-pair">
        <button type="button" className="btn-line" disabled={working} onClick={onAnother} aria-label={t('같은 조건으로 다른 코스', 'Another route, same settings')} title={t('같은 조건으로 다른 코스', 'Another route, same settings')}>
          <ArrowsClockwise size={16} aria-hidden /> {t('다른 코스', 'Another route')}
        </button>
        <button
          type="button"
          className="btn-line"
          aria-pressed={saver.saved}
          disabled={working || saver.busy}
          onClick={() => saver.toggle()}
        >
          <BookmarkSimple size={16} weight={saver.saved ? 'fill' : 'regular'} aria-hidden /> {saver.saved ? t('저장됨', 'Saved') : t('저장', 'Save')}
        </button>
        <button
          type="button"
          className="btn-line"
          disabled={working || sharer.busy}
          onClick={async () => {
            setShareNote(null);
            setShareNote(await sharer.share(course, variantIndex, title));
          }}
        >
          <ShareNetwork size={16} aria-hidden /> {sharer.busy ? t('만드는 중…', 'Making link…') : t('공유', 'Share')}
        </button>
      </div>
      {shareNote && (
        <p className="hint mb-0" role="status">
          {shareNote}
        </p>
      )}
      <p className={`pin-note${pinnedHere ? ' is-on' : ''}`}>
        <PushPin size={14} weight={pinnedHere ? 'fill' : 'regular'} aria-hidden />
        {pinnedHere
          ? t(`고정한 가게 ${pinnedHere}곳은 ‘다른 코스’에서도 그대로 둬요`, `${pinnedHere === 1 ? '1 pinned shop stays' : `${pinnedHere} pinned shops stay`} in ‘Another route’`)
          : t('카드의 핀을 누르면 ‘다른 코스’에서도 그 가게를 남겨요', 'Tap a card’s pin to keep that shop in ‘Another route’')}
      </p>
      {course.request.brands.length > 0 && (
        <p className="pin-note is-on">
          <Tag size={14} weight="fill" aria-hidden />
          {getLang() === 'en'
            ? `Always includes ${course.request.brands.map((b) => b.name).join(' · ')}, in ‘Another route’ too`
            : `브랜드 ${topic(course.request.brands.map((b) => b.name).join('·'))} ‘다른 코스’에서도 매번 넣어요`}
        </p>
      )}

      {course.variants.length > 1 && (
        <div className="tabs" role="tablist" aria-label={t('코스 버전', 'Route versions')}>
          {course.variants.map((x, i) => (
            <button key={x.variant} type="button" role="tab" aria-selected={i === variantIndex} onClick={() => onVariant(i)}>
              {x.label}
            </button>
          ))}
        </div>
      )}
      {v.note && <p className="course-note">{v.note}</p>}
      {variantIndex > 0 && <p className="variant-diff">{variantDiff(course.variants[0], v)}</p>}
      {(editor.thinking || editor.message || editor.error || editor.canUndo) && (
        <div className="edit-status" role="status" aria-live="polite">
          <span>{editor.thinking ? t('고치는 중…', 'Editing…') : (editor.error ?? editor.message)}</span>
          {editor.error && editor.retry && !working && (
            <button type="button" className="btn-text" onClick={() => editor.retry?.()}>
              <ArrowClockwise size={14} aria-hidden /> {t('다시 시도', 'Try again')}
            </button>
          )}
          {editor.canUndo && !working && (
            <button type="button" className="btn-text" onClick={editor.undo}>
              <ArrowArcLeft size={14} aria-hidden /> {t('되돌리기', 'Undo')}
            </button>
          )}
        </div>
      )}
      {/* The user's own time choice cut the stop count: offer to drop the limit in one tap. */}
      {!course.request.maxStops && v.stops.length < course.request.stopCount && (
        <button type="button" className="btn-line" disabled={busy} onClick={onFitAll}>
          {t(`시간 제한 없이 ${course.request.stopCount}곳 모두 넣기`, `Fit all ${course.request.stopCount} shops, no time limit`)}
        </button>
      )}

      <section className="assistant" aria-labelledby="assistant-label">
        <h3 className="eyebrow" id="assistant-label">
          <span>Edit</span>
          <span className="ko">{t('말로 고치기', 'Change it in your words')}</span>
        </h3>
        <div className={`ask-combo${suggestions.length > 0 ? ' is-open' : ''}`}>
        <form
          className="prompt-box"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ask.trim() || working) return;
            editor.say(ask.trim()).then(() => setAsk(''));
          }}
        >
          <label htmlFor="assistant-input" className="visually-hidden">
            {t('코스를 어떻게 고칠까요', 'How should I change the route?')}
          </label>
          <input
            id="assistant-input"
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            placeholder={t('예) 3번 빼고 신발 가게로 · 팔라스 넣어줘', 'e.g. Swap 3 for a shoe shop · add Palace')}
            maxLength={300}
            enterKeyHint="send"
            autoComplete="off"
          />
          <button type="submit" className="prompt-go" aria-label={t('이렇게 고치기', 'Apply this change')} disabled={working || !ask.trim()}>
            <Sparkle size={18} />
          </button>
        </form>
        {suggestions.length > 0 && (
          <div className="ask-panel">
            <div className="ask-panel-head">
              <span id="ask-suggest-label">{t('이 가게를 바로 넣기', 'Add this shop now')}</span>
              <span className="ask-panel-tip">
                {getLang() === 'en' ? <>Press <kbd>Enter</kbd> to send it as a request</> : <>문장으로 고치려면 <kbd>Enter</kbd></>}
              </span>
            </div>
            <ul aria-labelledby="ask-suggest-label">
              {suggestions.map((h) => {
                const far = (h.distanceM ?? 0) > FAR_SUGGEST_M;
                return (
                  <li key={h.id}>
                    <button
                      type="button"
                      className="ask-hit"
                      disabled={working}
                      onClick={() => {
                        setAsk('');
                        pick(h.id, null);
                      }}
                    >
                      <Storefront size={18} aria-hidden className="ask-hit-icon" />
                      <span className="ask-hit-text">
                        <strong>{h.name}</strong>
                        <span>
                          {CATEGORY_BY_ID[h.category]?.label ?? h.category}
                          {h.distanceM != null && t(` · 코스에서 ${distance(h.distanceM)}`, ` · ${distance(h.distanceM)} from the route`)}
                          {far && <em> · {t('멀어요', 'far')}</em>}
                        </span>
                      </span>
                      <span className="ask-hit-action" aria-hidden>
                        <Plus size={14} /> {t('넣기', 'Add')}
                      </span>
                      <span className="visually-hidden">{t(', 코스에 넣기', ', add to route')}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        </div>
        <div className="prompt-examples">
          {ASK_EXAMPLES().map((ex) => (
            <button key={ex} type="button" className="btn-text" disabled={working} onClick={() => editor.say(ex)}>
              {ex}
            </button>
          ))}
        </div>
      </section>

      <section className="gender-pick" aria-labelledby="gender-pick-label">
        <h3 className="eyebrow" id="gender-pick-label">
          <span>For</span>
          <span className="ko">{t('누구 옷', 'Who it’s for')}</span>
        </h3>
        <div className="gender-buttons" role="group" aria-labelledby="gender-pick-label">
          {GENDER_OPTIONS.map((g) => {
            const on = (course.request.gender ?? 'any') === g.id;
            return (
              <button
                key={g.id}
                type="button"
                className={`action-btn${on ? ' is-on' : ''}`}
                aria-pressed={on}
                disabled={working || on}
                onClick={() => onGender(g.id)}
              >
                {g.label}
              </button>
            );
          })}
        </div>
        <p className="hint">{t('바꾸면 그에 맞게 코스를 다시 짜요. 지금 코스에서 맞는 가게는 남겨요.', 'Change it and the route is replanned to match. Shops that still fit stay.')}</p>
      </section>

      <section className="break-pick" aria-labelledby="break-label">
        <h3 className="eyebrow" id="break-label">
          <span>Break</span>
          <span className="ko">{t('쉬어 가기', 'Take a break')}</span>
        </h3>
        <div className="break-buttons" role="group" aria-label={t('쉬어 가는 곳 넣기', 'Add a break')}>
          {(['cafe', 'food'] as const).map((kind) => {
            const on = (v.breaks ?? []).some((b) => b.kind === kind);
            return (
              <button
                key={kind}
                type="button"
                className={`action-btn${on ? ' is-on' : ''}`}
                aria-pressed={on}
                disabled={working}
                onClick={() => editor.setBreak(kind, !on)}
              >
                {kind === 'food' ? <ForkKnife size={18} aria-hidden /> : <Coffee size={18} aria-hidden />}
                {on ? t(`${BREAK_LABEL()[kind]} 빼기`, `Remove ${BREAK_LABEL()[kind].toLowerCase()}`) : t(`${BREAK_LABEL()[kind]} 넣기`, `Add a ${BREAK_LABEL()[kind].toLowerCase()}`)}
              </button>
            );
          })}
        </div>
        <p className="hint mt-1">{t('가는 길에서 가장 덜 돌아가는 곳을 카카오맵 검색 결과에서 골라, 실제 위치에 맞는 순서에 넣어요 (체인보다 동네 가게 먼저). 평점 기준은 아니에요.', 'We pick the spot from Kakao Map that takes you least out of your way and put it where it falls on the route (local places before chains). It’s not based on ratings.')}</p>
      </section>

      <ol className="course-list" role="tabpanel" ref={listRef}>
        {v.stops.map((s) => (
          <li
            key={s.shop.id}
            className={drag?.moved ? (drag.from === s.order ? 'is-dragging' : drag.over === s.order ? `is-drop-${drag.over < drag.from ? 'above' : 'below'}` : '') : ''}
            style={drag?.moved && drag.from === s.order ? { transform: `translateY(${drag.dy}px)` } : undefined}
            onMouseEnter={() => onHoverStop(s.order)}
            onMouseLeave={() => onHoverStop(null)}
            onFocus={() => onHoverStop(s.order)}
            onBlur={() => onHoverStop(null)}
          >
            <div className="course-leg tabular">
              <PersonSimpleWalk size={14} aria-hidden />
              {t(`도보 ${Math.max(1, Math.round(s.legFromPrev.durationMin))}분 · ${s.legFromPrev.distanceM}m`, `${Math.max(1, Math.round(s.legFromPrev.durationMin))} min walk · ${s.legFromPrev.distanceM}m`)}
              {s.arriveAt && <span className="leg-arrive">{t(`${s.arriveAt} 도착`, `Arrive ${s.arriveAt}`)}</span>}
            </div>
            <article className={`course-card${activeOrder === s.order ? ' is-active' : ''}${pins.has(s.shop.id) ? ' is-pinned' : ''}`} tabIndex={0} data-stop-order={s.order}>
              <div className="num-col">
              <span className="course-num" aria-hidden>
                {String(s.order).padStart(2, '0')}
              </span>
              {last > 1 && (
                // Drag to reorder (mouse and touch). The ↑↓ buttons below do the same for keyboards and screen readers.
                <span
                  className="drag-handle"
                  aria-hidden
                  title={t('끌어서 순서 바꾸기', 'Drag to reorder')}
                  onPointerDown={(e) => !working && startDrag(e, s.order)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={() => setDrag(null)}
                >
                  <DotsSixVertical size={18} />
                </span>
              )}
              </div>
              <div>
                <div className="card-head">
                  <h3>
                    <button type="button" className="shop-link" onClick={() => onOpenShop(s.shop.id)}>
                      <span className="visually-hidden">{t(`${s.order}번째, `, `Stop ${s.order}, `)}</span>
                      {s.shop.name}
                    </button>
                  </h3>
                  <span className="card-icons">
                    <PinButton
                      name={s.shop.name}
                      pinned={pins.has(s.shop.id)}
                      full={pins.size >= MAX_PINS}
                      disabled={working || editor.pinBusy}
                      onToggle={() => editor.pin(s.shop.id, !pins.has(s.shop.id))}
                    />
                    <VisitButton shopId={s.shop.id} state={states.get(s.shop.id)} courseId={course.id} />
                    <SaveButton shopId={s.shop.id} state={states.get(s.shop.id)} courseId={course.id} />
                  </span>
                </div>
                <p className="course-reason">{s.reason}</p>
                <div className="course-meta">
                  {pins.has(s.shop.id) && (
                    <span className="tag is-pinned">
                      <PushPin size={12} weight="fill" aria-hidden /> {t('고정', 'Pinned')}
                    </span>
                  )}
                  {s.shop.newsTag && (
                    <span className="tag is-news">
                      <Megaphone size={12} weight="fill" aria-hidden /> {s.shop.newsTag}
                    </span>
                  )}
                  {(s.brands ?? []).map((b) => (
                    <span key={b} className="tag is-brand">
                      <Tag size={12} weight="fill" aria-hidden /> {b}
                    </span>
                  ))}
                  <span>{CATEGORY_BY_ID[s.shop.category]?.label ?? s.shop.category}</span>
                  {s.shop.priceRange && PRICE_LABEL()[s.shop.priceRange] && <span>{PRICE_LABEL()[s.shop.priceRange]}</span>}
                  {s.shop.littleKnown && <span className="tag">{t('정보가 적은 가게', 'Little info yet')}</span>}
                  {s.shop.hoursWarning ? (
                    <span className="tag is-warning">
                      <Warning size={12} aria-hidden /> {s.shop.hoursWarning}
                    </span>
                  ) : s.shop.hoursToday ? (
                    <span className="tag is-hours" title={s.shop.hoursSource === 'blog' ? t('블로그 글에 적힌 영업시간이에요. 바뀌었을 수 있어요', 'Hours from a blog post. They may have changed') : t('사장님이 올린 영업시간', 'Hours posted by the owner')}>
                      <Clock size={12} aria-hidden /> {s.shop.hoursToday}
                      {s.shop.hoursSource === 'blog' && <span className="hours-src">{t(' · 블로그', ' · blog')}</span>}
                    </span>
                  ) : (
                    <span className="hours-unknown">{t('영업시간 확인 필요', 'Check opening hours')}</span>
                  )}
                  <RatePrompt shopId={s.shop.id} state={states.get(s.shop.id)} courseId={course.id} />
                </div>
                <div className="card-actions">
                  <span className="edit-group" role="group" aria-label={t(`${s.order}번 고치기`, `Edit stop ${s.order}`)}>
                    <button type="button" disabled={working} onClick={() => editor.apply({ op: 'replace', order: s.order })}>
                      <ArrowsClockwise size={14} aria-hidden /> {t('다른 가게로', 'Swap shop')}
                    </button>
                    <button type="button" className="is-icon" aria-label={t('빼기', 'Remove')} title={t('빼기', 'Remove')} disabled={working || last <= 1} onClick={() => editor.apply({ op: 'remove', order: s.order })}>
                      <X size={14} />
                    </button>
                    <button
                      type="button"
                      className="is-icon"
                      aria-label={t('앞으로', 'Move up')}
                      title={t('앞으로', 'Move up')}
                      disabled={working || s.order === 1}
                      onClick={() => editor.apply({ op: 'move', order: s.order, toOrder: s.order - 1 })}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="is-icon"
                      aria-label={t('뒤로', 'Move down')}
                      title={t('뒤로', 'Move down')}
                      disabled={working || s.order === last}
                      onClick={() => editor.apply({ op: 'move', order: s.order, toOrder: s.order + 1 })}
                    >
                      <ArrowDown size={14} />
                    </button>
                  </span>
                  <CardMenu
                    shopId={s.shop.id}
                    name={s.shop.name}
                    placeUrl={s.shop.placeUrl ?? null}
                    state={states.get(s.shop.id)}
                    courseId={course.id}
                    onOpenShop={onOpenShop}
                    onFind={() => setFinder(s.order)}
                  />
                </div>
              </div>
            </article>
            {finder === s.order && (
              <div className="course-add">
                <ShopSearch
                  label={t(`${s.order}번 ${s.shop.name} 대신 넣을 가게`, `A shop to put in place of ${s.shop.name} (stop ${s.order})`)}
                  near={{ lat: s.shop.lat, lng: s.shop.lng }}
                  exclude={inCourse}
                  onPick={(h) => pick(h.id, s.order)}
                  onClose={() => setFinder(null)}
                />
              </div>
            )}
            {(v.breaks ?? [])
              .filter((b) => b.afterOrder === s.order)
              .map((b) => (
                <div key={b.kind} className="break-stop">
                  <div className="course-leg tabular">
                    <PersonSimpleWalk size={14} aria-hidden />{' '}
                    {t(
                      `${BREAK_LABEL()[b.kind] ?? '쉬는 곳'}까지 ${b.detourM > 0 ? `+${b.detourM}m 더 걸어요` : '같은 건물·바로 옆'}`,
                      `To the ${(BREAK_LABEL()[b.kind] ?? 'break').toLowerCase()}: ${b.detourM > 0 ? `+${b.detourM}m extra walk` : 'same building or next door'}`,
                    )}
                  </div>
                  <div className={`break-card is-${b.kind}`}>
                    {b.kind === 'food' ? <ForkKnife size={20} aria-hidden /> : <Coffee size={20} aria-hidden />}
                    <div>
                      <strong>{b.name}</strong>
                      <div className="hint mt-0">
                        {BREAK_LABEL()[b.kind]} · {b.minutes}{t('분', ' min')}{b.category ? ` · ${b.category}` : ''}
                      </div>
                    </div>
                    <span className="break-tools">
                      <button type="button" className="btn-text" disabled={working} onClick={() => editor.setBreak(b.kind as 'cafe' | 'food', true, true)}>
                        <ArrowsClockwise size={12} aria-hidden /> {t('다른 곳으로', 'Somewhere else')}
                      </button>
                      {b.placeUrl && (
                        <a href={b.placeUrl} target="_blank" rel="noreferrer" className="btn-text">
                          {t('카카오맵', 'Kakao Map')} <ArrowUpRight size={12} aria-hidden />
                        </a>
                      )}
                    </span>
                  </div>
                </div>
              ))}
          </li>
        ))}
        {v.endLeg && course.end && (
          <li className="course-end">
            <div className="course-leg tabular">
              <PersonSimpleWalk size={14} aria-hidden />
              {t(`도보 ${Math.max(1, Math.round(v.endLeg.durationMin))}분 · ${v.endLeg.distanceM}m`, `${Math.max(1, Math.round(v.endLeg.durationMin))} min walk · ${v.endLeg.distanceM}m`)}
              {v.finishAt && <span className="leg-arrive">{t(`${v.finishAt} 도착`, `Arrive ${v.finishAt}`)}</span>}
            </div>
            <div className="end-card">
              <Flag size={20} aria-hidden />
              <div>
                <strong>{course.request.roundTrip ? t(`${course.endName ?? '출발점'}으로 돌아오기`, `Back to ${course.endName ?? 'the start'}`) : course.endName ?? t('끝나는 곳', 'Finish')}</strong>
                <div className="hint mt-0">{t('코스가 끝나는 곳', 'Where the route ends')}</div>
              </div>
            </div>
          </li>
        )}
      </ol>


      <GroupInvite
        courseId={course.id}
        title={title}
        groupId={course.request.groupId}
        groupNames={course.request.groupNames}
        styleLabels={styleLabels}
        onOpenCourse={onOpenCourse}
      />

      <section className="section" aria-labelledby="getting-there-label">
        <h3 className="eyebrow" id="getting-there-label">
          <span>Getting there</span>
          <span className="ko">{t('출발점까지', 'To the start')}</span>
        </h3>
        <RouteFromHere key={course.id} to={course.origin} toName={course.startName ?? t('출발점', 'the start')} />
      </section>

      <section className="section" aria-labelledby="continue-label">
        <h3 className="eyebrow" id="continue-label">
          <span>Next</span>
          <span className="ko">{t('다른 지역으로 이어 가기', 'Continue to another area')}</span>
        </h3>
        {!continuing ? (
          <button type="button" className="btn-line" disabled={working} onClick={() => setContinuing(true)}>
            {t('마지막 가게에서 다음 지역으로', 'From the last shop to a new area')}
          </button>
        ) : (
          <>
            <p className="hint mt-0">{t('고른 지역의 코스를 같은 조건으로 짜고, 여기 마지막 가게에서 가는 대중교통도 알려 드려요.', 'We’ll plan a route there with the same settings, and show you public transit from the last shop here.')}</p>
            <div className="chip-row" role="group" aria-label={t('이어 갈 지역', 'Area to continue to')}>
              {regions
                .filter((r) => r.name !== course.request.regionName)
                .slice(0, 12)
                .map((r) => (
                  <button key={r.id} type="button" className="chip" disabled={working} onClick={() => onContinue(r.id)}>
                    {r.name}
                  </button>
                ))}
            </div>
          </>
        )}
      </section>
    </section>
  );
}
