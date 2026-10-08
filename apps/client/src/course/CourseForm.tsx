import { Coffee, ForkKnife, MagnifyingGlass, Minus, Plus, PushPin, X } from '@phosphor-icons/react';
import { useState } from 'react';
import { ShopSearch } from './ShopSearch';
import { estimateMin, type Gender, MAX_STOPS, MIN_STOPS, type LatLng, type Planner } from './usePlanner';

export const GENDER_OPTIONS: { id: Gender; label: string }[] = [
  { id: 'any', label: '상관없음' },
  { id: 'men', label: '남성복' },
  { id: 'women', label: '여성복' },
];

const TIME_LABEL: Record<number, string> = { 60: '1시간', 120: '2시간', 240: '반나절' };

function duration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round((min % 60) / 10) * 10;
  return h ? `${h}시간${m ? ` ${m}분` : ''}` : `${m}분`;
}

/** Style, stop count and time chips. The plan buttons live in the panel footer (App). */
export function CourseForm({ planner, near }: { planner: Planner; near?: LatLng | null }) {
  const { catalog, styles, toggleStyle, stopCount, setStopCount, maxStops, setMaxStops, timeBudget, setTimeBudget } = planner;
  const { budget, setBudget, items, toggleItem, skipVisited, setSkipVisited, withCafe, setWithCafe, withFood, setWithFood } = planner;
  const customTime = timeBudget !== null && !catalog?.timeBudgetOptionsMin.includes(timeBudget) ? timeBudget : null;
  const defaults = catalog?.defaults;
  const shown = stopCount ?? defaults?.stopCount ?? 4;
  const [finding, setFinding] = useState(false);

  return (
    <>
      <section className="section" aria-labelledby="style-label">
        <h2 className="eyebrow" id="style-label">
          <span>Style</span>
          <span className="ko">스타일 {styles.length > 0 && <span className="tabular">· {styles.length}</span>}</span>
        </h2>
        <div className="chip-row">
          {catalog?.styles.map((s) => {
            const on = styles.includes(s.id);
            return (
              <button key={s.id} type="button" className={`chip${on ? ' is-selected' : ''}`} aria-pressed={on} onClick={() => toggleStyle(s.id)}>
                {s.label}
              </button>
            );
          })}
        </div>
        {styles.length === 0 && <p className="hint">고르지 않으면 편집숍·빈티지처럼 둘러보기 좋은 가게 위주로 짜요.</p>}
      </section>

      <section className="section" aria-labelledby="gender-label">
        <h2 className="eyebrow" id="gender-label">
          <span>For</span>
          <span className="ko">누구 옷</span>
        </h2>
        <div className="chip-row" role="group" aria-labelledby="gender-label">
          {GENDER_OPTIONS.map((g) => {
            const on = planner.gender === g.id;
            return (
              <button
                key={g.id}
                type="button"
                className={`chip${on ? (g.id === 'any' ? ' is-default' : ' is-selected') : ''}`}
                aria-pressed={on}
                onClick={() => planner.setGender(g.id)}
              >
                {g.label}
              </button>
            );
          })}
        </div>
        {planner.gender !== 'any' && (
          <p className="hint">
            {planner.gender === 'men' ? '여성복·아동복만 파는 가게는 빼요.' : '남성복·아동복만 파는 가게는 빼요.'} 아직 정보가 없는 가게는 빼지 않고 조금 뒤로 미뤄요.
          </p>
        )}
      </section>

      <div className="d-flex flex-column gap-4 section">
        <section aria-labelledby="count-label">
          <h2 className="eyebrow" id="count-label">
            <span>Stops</span>
            <span className="ko">몇 곳</span>
          </h2>
          <div className="stepper-row">
            <div className={`stepper${maxStops ? ' is-off' : stopCount === null ? ' is-default' : ''}`} role="group" aria-label="들를 가게 수">
              <button
                type="button"
                aria-label="한 곳 줄이기"
                disabled={maxStops || shown <= MIN_STOPS}
                onClick={() => setStopCount(shown - 1)}
              >
                <Minus size={18} />
              </button>
              <output className="tabular" aria-live="polite">
                {shown}
                <small>곳</small>
              </output>
              <button
                type="button"
                aria-label="한 곳 늘리기"
                disabled={maxStops || shown >= MAX_STOPS}
                onClick={() => setStopCount(shown + 1)}
              >
                <Plus size={18} />
              </button>
            </div>
            <button
              type="button"
              className={`chip${maxStops ? ' is-selected' : ''}`}
              aria-pressed={maxStops}
              onClick={() => setMaxStops(!maxStops)}
            >
              시간 안에 최대한 많이
            </button>
          </div>
          <p className="hint tabular">
            {maxStops
              ? `${timeBudget ? TIME_LABEL[timeBudget] ?? `${timeBudget}분` : '2시간'} 안에 들어가는 만큼 넣어요.`
              : `${shown}곳이면 둘러보는 시간까지 약 ${duration(estimateMin(shown))} 걸려요.`}
          </p>
        </section>
        <section aria-labelledby="time-label">
          <h2 className="eyebrow" id="time-label">
            <span>Time</span>
            <span className="ko">시간</span>
          </h2>
          <div className="chip-row">
            {catalog?.timeBudgetOptionsMin.map((m) => {
              const chosen = timeBudget === m;
              const dflt = timeBudget === null && defaults?.timeBudgetMin === m;
              return (
                <button
                  key={m}
                  type="button"
                  className={`chip${chosen ? ' is-selected' : dflt ? ' is-default' : ''}`}
                  aria-pressed={chosen}
                  onClick={() => setTimeBudget(chosen ? null : m)}
                >
                  {TIME_LABEL[m] ?? `${m}분`}
                </button>
              );
            })}
            {/* A time read from text ("3시간") that isn't one of the buttons. */}
            {customTime !== null && (
              <button type="button" className="chip is-selected" aria-pressed onClick={() => setTimeBudget(null)}>
                {duration(customTime)}
              </button>
            )}
          </div>
          {timeBudget === null && stopCount !== null && !maxStops && (
            <p className="hint">시간을 고르지 않으면 {stopCount}곳을 모두 도는 데 맞춰요.</p>
          )}
          {timeBudget !== null && !maxStops && estimateMin(shown) > timeBudget + 10 && (
            <p className="hint" role="status">
              {TIME_LABEL[timeBudget] ?? `${timeBudget}분`}이면 {Math.max(1, Math.floor(timeBudget / 20))}곳 안팎이에요. 시간을 늘리거나 선택을 풀면 {shown}곳을 다 넣어요.
            </p>
          )}
        </section>
      </div>

      <section className="section" aria-labelledby="break-form-label">
        <h2 className="eyebrow" id="break-form-label">
          <span>Break</span>
          <span className="ko">쉬어 가기</span>
        </h2>
        <div className="chip-row">
          <button type="button" className={`chip${withFood ? ' is-selected' : ''}`} aria-pressed={withFood} onClick={() => setWithFood(!withFood)}>
            <ForkKnife size={16} aria-hidden /> 맛집 들르기
          </button>
          <button type="button" className={`chip${withCafe ? ' is-selected' : ''}`} aria-pressed={withCafe} onClick={() => setWithCafe(!withCafe)}>
            <Coffee size={16} aria-hidden /> 카페 들르기
          </button>
        </div>
        <p className="hint">가는 길에서 크게 벗어나지 않는 곳으로, 코스 순서에 맞춰 넣어요. 코스를 짠 뒤에도 넣고 뺄 수 있어요.</p>
      </section>

      <section className="section" aria-labelledby="must-label">
        <h2 className="eyebrow" id="must-label">
          <span>Must</span>
          <span className="ko">꼭 넣을 가게 {planner.mustShops.length > 0 && <span className="tabular">· {planner.mustShops.length}</span>}</span>
        </h2>
        {planner.mustShops.length > 0 && (
          <ul className="must-list">
            {planner.mustShops.map((m) => (
              <li key={m.id} className="must-chip">
                <PushPin size={14} weight="fill" aria-hidden /> {m.name}
                <button type="button" onClick={() => planner.removeMustShop(m.id)} aria-label={`${m.name} 빼기`}>
                  <X size={14} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {finding ? (
          <div className="mt-2">
            <ShopSearch
              label="가게 이름으로 찾기"
              near={near}
              exclude={planner.mustShops.map((m) => m.id)}
              onPick={(h) => {
                planner.addMustShop({ id: h.id, name: h.name });
                setFinding(false);
              }}
              onClose={() => setFinding(false)}
            />
          </div>
        ) : (
          <div className="chip-row">
            <button type="button" className="chip" onClick={() => setFinding(true)} disabled={planner.mustShops.length >= 8}>
              <MagnifyingGlass size={16} aria-hidden /> 가게 이름으로 찾아 넣기
            </button>
          </div>
        )}
        <p className="hint">고른 조건에 더해, 이 가게들은 시간 안에 들어가면 꼭 넣어요. 글로 “○○는 무조건 넣어줘”라고 써도 돼요.</p>
      </section>

      <details className="section more" open={budget !== 'any' || items.length > 0 || skipVisited || undefined}>
        <summary>
          더 보기 · 예산, 품목
          {(budget !== 'any' || items.length > 0) && <span className="tabular"> ({(budget !== 'any' ? 1 : 0) + items.length})</span>}
        </summary>
        <div className="pt-3">
          <h2 className="eyebrow">
            <span>Budget</span>
            <span className="ko">예산</span>
          </h2>
          <div className="chip-row mb-3">
            {catalog?.budgets.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`chip${budget === b.id ? (b.id === 'any' ? ' is-default' : ' is-selected') : ''}`}
                aria-pressed={budget === b.id}
                onClick={() => setBudget(b.id)}
              >
                {b.label}
              </button>
            ))}
          </div>
          <h2 className="eyebrow">
            <span>Items</span>
            <span className="ko">찾는 품목</span>
          </h2>
          <div className="chip-row mb-3">
            {catalog?.items.map((i) => {
              const on = items.includes(i.id);
              return (
                <button key={i.id} type="button" className={`chip${on ? ' is-selected' : ''}`} aria-pressed={on} onClick={() => toggleItem(i.id)}>
                  {i.label}
                </button>
              );
            })}
          </div>
          <h2 className="eyebrow">
            <span>Mine</span>
            <span className="ko">내 가게</span>
          </h2>
          <div className="chip-row">
            <button type="button" className={`chip${skipVisited ? ' is-selected' : ''}`} aria-pressed={skipVisited} onClick={() => setSkipVisited(!skipVisited)}>
              가 본 곳 빼기
            </button>
          </div>
          <p className="hint">찜하거나 좋았던 가게는 조금 더 앞에, 별로였던 가게는 빼고 짜요.</p>
        </div>
      </details>
    </>
  );
}
