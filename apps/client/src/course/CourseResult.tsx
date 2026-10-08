import { ArrowArcLeft, ArrowDown, ArrowsClockwise, ArrowUp, ArrowUpRight, BookmarkSimple, Clock, Coffee, DotsSixVertical, DotsThree, ForkKnife, Info, MagnifyingGlass, Storefront, MapTrifold, LinkSimple, Plus, PersonSimpleWalk, ShareNetwork, Sparkle, Warning, X } from '@phosphor-icons/react';
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

const PRICE_LABEL: Record<string, string> = { low: '저렴', mid: '중간', high: '고가' };

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
      <button type="button" className="is-icon" aria-label={`${name} 더 보기`} title="더 보기" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
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
            <Info size={16} aria-hidden /> 가게 정보
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onFind();
            }}
          >
            <MagnifyingGlass size={16} aria-hidden /> 이름으로 찾아 바꾸기
          </button>
          {placeUrl && (
            <a role="menuitem" href={placeUrl} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
              <MapTrifold size={16} aria-hidden /> 카카오맵에서 보기 <ArrowUpRight size={12} aria-hidden />
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

const BREAK_LABEL: Record<string, string> = { cafe: '카페', food: '맛집' };

const DRAG_THRESHOLD_PX = 6;

/** How a version differs from the recommended one: distance and how many shops changed. */
function variantDiff(base: Variant, v: Variant): string {
  const dm = v.totalDistanceM - base.totalDistanceM;
  const baseIds = new Set(base.stops.map((s) => s.shop.id));
  const changed = v.stops.filter((s) => !baseIds.has(s.shop.id)).length;
  const dist = Math.abs(dm) < 50 ? '거리는 비슷하고' : `${Math.abs(dm) >= 1000 ? `${(Math.abs(dm) / 1000).toFixed(1)}km` : `${Math.round(Math.abs(dm) / 10) * 10}m`} ${dm < 0 ? '짧고' : '길고'}`;
  return `추천 코스보다 ${dist}, 가게 ${changed}곳이 달라요`;
}

const ASK_EXAMPLES = ['좀 더 가깝게', '2번 다른 데로', '신발 가게 하나 추가'];

export function CourseResult({ course, styleLabels, variantIndex, activeOrder, onVariant, onHoverStop, onFitAll, onAnother, onGender, onOpenShop, onCourseId, regions, onContinue, onOpenCourse, echo, busy, editor }: Props) {
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
    const cards = [...listRef.current.children] as HTMLElement[];
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
    : '둘러보기 좋은 가게';
  const title = `${course.request.regionName ?? '이 근처'}에서 ${styleText} ${v.stops.length}곳 걷기`;

  return (
    <section aria-labelledby="course-title">
      <p className="eyebrow mb-2">
        <span>Route {String(variantIndex + 1).padStart(2, '0')} · {course.request.regionName ?? 'Near you'}</span>
        {course.startName && <span className="ko">{course.startName}에서 출발</span>}
      </p>
      <h2 className="course-title" id="course-title">
        {course.request.regionName ?? '이 근처'}에서 {styleText}
        <br />
        {v.stops.length}곳 걷기
      </h2>

      {course.link && (
        <div className="course-link">
          <button type="button" className="btn-text p-0" style={{ minHeight: 32 }} onClick={() => onOpenCourse(course.link!.prevCourseId)}>
            <ArrowArcLeft size={14} aria-hidden /> {course.link.prevName} 코스에서 이어 왔어요
          </button>
          <TransitCard route={course.link.transit} title={`${course.link.fromShop} → ${course.startName ?? '출발점'}`} />
        </div>
      )}
      {course.request.tasteNote && (
        <p className="taste-note">
          <Sparkle size={14} aria-hidden /> {course.request.tasteNote}
        </p>
      )}

      {course.shared && (
        <div className="region-note mt-3">
          <LinkSimple size={14} aria-hidden /> 공유받은 코스예요. 고치면 내 코스로 따로 저장돼요.
        </div>
      )}

      {echo && (
        <div className="prompt-echo">
          <Sparkle size={14} aria-hidden />
          <div>
            <div className="prompt-said">“{echo.text}”</div>
            <div>
              <strong>이렇게 이해했어요</strong> · {echo.summary}
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

      <div className="btn-pair">
        <button type="button" className="btn-line" disabled={working} onClick={onAnother} aria-label="같은 조건으로 다른 코스" title="같은 조건으로 다른 코스">
          <ArrowsClockwise size={16} aria-hidden /> 다른 코스
        </button>
        <button
          type="button"
          className="btn-line"
          aria-pressed={saver.saved}
          disabled={working || saver.busy}
          onClick={() => saver.toggle()}
        >
          <BookmarkSimple size={16} weight={saver.saved ? 'fill' : 'regular'} aria-hidden /> {saver.saved ? '저장됨' : '저장'}
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
          <ShareNetwork size={16} aria-hidden /> {sharer.busy ? '만드는 중…' : '공유'}
        </button>
      </div>
      {shareNote && (
        <p className="hint mb-0" role="status">
          {shareNote}
        </p>
      )}

      {course.variants.length > 1 && (
        <div className="tabs" role="tablist" aria-label="코스 버전">
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
          <span>{editor.thinking ? '고치는 중…' : (editor.error ?? editor.message)}</span>
          {editor.canUndo && !working && (
            <button type="button" className="btn-text" onClick={editor.undo}>
              <ArrowArcLeft size={14} aria-hidden /> 되돌리기
            </button>
          )}
        </div>
      )}
      {/* The user's own time choice cut the stop count: offer to drop the limit in one tap. */}
      {!course.request.maxStops && v.stops.length < course.request.stopCount && (
        <button type="button" className="btn-line" disabled={busy} onClick={onFitAll}>
          시간 제한 없이 {course.request.stopCount}곳 모두 넣기
        </button>
      )}

      <section className="assistant" aria-labelledby="assistant-label">
        <h3 className="eyebrow" id="assistant-label">
          <span>Edit</span>
          <span className="ko">말로 고치기</span>
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
            코스를 어떻게 고칠까요
          </label>
          <input
            id="assistant-input"
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            placeholder="예) 3번 빼고 신발 가게로 · 팔라스 넣어줘"
            maxLength={300}
            enterKeyHint="send"
            autoComplete="off"
          />
          <button type="submit" className="prompt-go" aria-label="이렇게 고치기" disabled={working || !ask.trim()}>
            <Sparkle size={18} />
          </button>
        </form>
        {suggestions.length > 0 && (
          <div className="ask-panel">
            <div className="ask-panel-head">
              <span id="ask-suggest-label">이 가게를 바로 넣기</span>
              <span className="ask-panel-tip">
                문장으로 고치려면 <kbd>Enter</kbd>
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
                          {h.distanceM != null && ` · 코스에서 ${distance(h.distanceM)}`}
                          {far && <em> · 멀어요</em>}
                        </span>
                      </span>
                      <span className="ask-hit-action" aria-hidden>
                        <Plus size={14} /> 넣기
                      </span>
                      <span className="visually-hidden">, 코스에 넣기</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        </div>
        <div className="prompt-examples">
          {ASK_EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="btn-text" disabled={working} onClick={() => editor.say(ex)}>
              {ex}
            </button>
          ))}
        </div>
      </section>

      <section className="gender-pick" aria-labelledby="gender-pick-label">
        <h3 className="eyebrow" id="gender-pick-label">
          <span>For</span>
          <span className="ko">누구 옷</span>
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
        <p className="hint">바꾸면 그에 맞게 코스를 다시 짜요. 지금 코스에서 맞는 가게는 남겨요.</p>
      </section>

      <section className="break-pick" aria-labelledby="break-label">
        <h3 className="eyebrow" id="break-label">
          <span>Break</span>
          <span className="ko">쉬어 가기</span>
        </h3>
        <div className="break-buttons" role="group" aria-label="쉬어 가는 곳 넣기">
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
                {on ? `${BREAK_LABEL[kind]} 빼기` : `${BREAK_LABEL[kind]} 넣기`}
              </button>
            );
          })}
        </div>
        <p className="hint mt-1">가는 길에서 가장 덜 돌아가는 곳을 카카오맵 검색 결과에서 골라, 실제 위치에 맞는 순서에 넣어요 (체인보다 동네 가게 먼저). 평점 기준은 아니에요.</p>
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
              도보 {Math.max(1, Math.round(s.legFromPrev.durationMin))}분 · {s.legFromPrev.distanceM}m
            </div>
            <article className={`course-card${activeOrder === s.order ? ' is-active' : ''}`} tabIndex={0}>
              <div className="num-col">
              <span className="course-num" aria-hidden>
                {String(s.order).padStart(2, '0')}
              </span>
              {last > 1 && (
                // Drag to reorder (mouse and touch). The ↑↓ buttons below do the same for keyboards and screen readers.
                <span
                  className="drag-handle"
                  aria-hidden
                  title="끌어서 순서 바꾸기"
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
                      <span className="visually-hidden">{s.order}번째, </span>
                      {s.shop.name}
                    </button>
                  </h3>
                  <span className="card-icons">
                    <VisitButton shopId={s.shop.id} state={states.get(s.shop.id)} courseId={course.id} />
                    <SaveButton shopId={s.shop.id} state={states.get(s.shop.id)} courseId={course.id} />
                  </span>
                </div>
                <p className="course-reason">{s.reason}</p>
                <div className="course-meta">
                  <span>{CATEGORY_BY_ID[s.shop.category]?.label ?? s.shop.category}</span>
                  {s.shop.priceRange && PRICE_LABEL[s.shop.priceRange] && <span>{PRICE_LABEL[s.shop.priceRange]}</span>}
                  {s.shop.littleKnown && <span className="tag">정보가 적은 가게</span>}
                  {s.shop.hoursToday ? (
                    <span className="tag is-hours">
                      <Clock size={12} aria-hidden /> {s.shop.hoursToday}
                    </span>
                  ) : (
                    <span className="hours-unknown">영업시간 확인 필요</span>
                  )}
                  <RatePrompt shopId={s.shop.id} state={states.get(s.shop.id)} courseId={course.id} />
                </div>
                <div className="card-actions">
                  <span className="edit-group" role="group" aria-label={`${s.order}번 고치기`}>
                    <button type="button" disabled={working} onClick={() => editor.apply({ op: 'replace', order: s.order })}>
                      <ArrowsClockwise size={14} aria-hidden /> 다른 가게로
                    </button>
                    <button type="button" className="is-icon" aria-label="빼기" title="빼기" disabled={working || last <= 1} onClick={() => editor.apply({ op: 'remove', order: s.order })}>
                      <X size={14} />
                    </button>
                    <button
                      type="button"
                      className="is-icon"
                      aria-label="앞으로"
                      title="앞으로"
                      disabled={working || s.order === 1}
                      onClick={() => editor.apply({ op: 'move', order: s.order, toOrder: s.order - 1 })}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="is-icon"
                      aria-label="뒤로"
                      title="뒤로"
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
                  label={`${s.order}번 ${s.shop.name} 대신 넣을 가게`}
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
                    <PersonSimpleWalk size={14} aria-hidden /> {BREAK_LABEL[b.kind] ?? '쉬는 곳'}까지 {b.detourM > 0 ? `+${b.detourM}m 더 걸어요` : '같은 건물·바로 옆'}
                  </div>
                  <div className={`break-card is-${b.kind}`}>
                    {b.kind === 'food' ? <ForkKnife size={20} aria-hidden /> : <Coffee size={20} aria-hidden />}
                    <div>
                      <strong>{b.name}</strong>
                      <div className="hint mt-0">
                        {BREAK_LABEL[b.kind]} · {b.minutes}분{b.category ? ` · ${b.category}` : ''}
                      </div>
                    </div>
                    <span className="break-tools">
                      <button type="button" className="btn-text" disabled={working} onClick={() => editor.setBreak(b.kind as 'cafe' | 'food', true, true)}>
                        <ArrowsClockwise size={12} aria-hidden /> 다른 곳으로
                      </button>
                      {b.placeUrl && (
                        <a href={b.placeUrl} target="_blank" rel="noreferrer" className="btn-text">
                          카카오맵 <ArrowUpRight size={12} aria-hidden />
                        </a>
                      )}
                    </span>
                  </div>
                </div>
              ))}
          </li>
        ))}
      </ol>


      <section className="section" aria-labelledby="getting-there-label">
        <h3 className="eyebrow" id="getting-there-label">
          <span>Getting there</span>
          <span className="ko">출발점까지</span>
        </h3>
        <RouteFromHere key={course.id} to={course.origin} toName={course.startName ?? '출발점'} />
      </section>

      <section className="section" aria-labelledby="continue-label">
        <h3 className="eyebrow" id="continue-label">
          <span>Next</span>
          <span className="ko">다른 지역으로 이어 가기</span>
        </h3>
        {!continuing ? (
          <button type="button" className="btn-line" disabled={working} onClick={() => setContinuing(true)}>
            마지막 가게에서 다음 지역으로
          </button>
        ) : (
          <>
            <p className="hint mt-0">고른 지역의 코스를 같은 조건으로 짜고, 여기 마지막 가게에서 가는 대중교통도 알려 드려요.</p>
            <div className="chip-row" role="group" aria-label="이어 갈 지역">
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
