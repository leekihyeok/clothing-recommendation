import { Coffee, ForkKnife, MagnifyingGlass, Minus, Plus, PushPin, X } from '@phosphor-icons/react';
import { useState } from 'react';
import { ShopSearch } from './ShopSearch';
import { estimateMin, type Gender, MAX_STOPS, MIN_STOPS, type LatLng, type Planner } from './usePlanner';
import { EndBySelect, FinishSection, WhenSection } from './WhenFinish';
import { BrandPicker } from './BrandPicker';
import { count, t } from '../i18n';

// Getters, so the labels follow the language wherever the list is used (CourseResult and Group too).
export const GENDER_OPTIONS: { id: Gender; readonly label: string }[] = [
  { id: 'any', get label() { return t('상관없음', 'Any'); } },
  { id: 'men', get label() { return t('남성복', 'Menswear'); } },
  { id: 'women', get label() { return t('여성복', 'Womenswear'); } },
];

const TIME_LABEL = (): Record<number, string> => ({ 60: t('1시간', '1 hour'), 120: t('2시간', '2 hours'), 240: t('반나절', 'Half a day') });
const minutes = (m: number) => t(`${m}분`, `${m} min`);
const timeLabel = (m: number) => TIME_LABEL()[m] ?? minutes(m);

function duration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round((min % 60) / 10) * 10;
  return h ? `${t(`${h}시간`, `${h} h`)}${m ? ` ${minutes(m)}` : ''}` : minutes(m);
}

/** Style, stop count and time chips. The plan buttons live in the panel footer (App). */
export function CourseForm({ planner, near, onPickEnd, pickingEnd }: {
  planner: Planner;
  near?: LatLng | null;
  /** "끝나는 곳 · 지도에서 고르기": the next tap on the map sets the finish. */
  onPickEnd: () => void;
  pickingEnd: boolean;
}) {
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
          <span className="ko">{t('스타일', 'Pick a look')} {styles.length > 0 && <span className="tabular">· {styles.length}</span>}</span>
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
        {styles.length === 0 && <p className="hint">{t('고르지 않으면 편집숍·빈티지처럼 둘러보기 좋은 가게 위주로 짜요.', 'Skip this and we’ll go for shops that are fun to browse, like select shops and vintage.')}</p>}
      </section>

      <BrandPicker planner={planner} />

      <section className="section" aria-labelledby="gender-label">
        <h2 className="eyebrow" id="gender-label">
          <span>For</span>
          <span className="ko">{t('누구 옷', 'Whose clothes')}</span>
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
            {planner.gender === 'men'
              ? t('여성복·아동복만 파는 가게는 빼요.', 'Shops selling only women’s or kids’ clothes are left out.')
              : t('남성복·아동복만 파는 가게는 빼요.', 'Shops selling only men’s or kids’ clothes are left out.')}{' '}
            {t('아직 정보가 없는 가게는 빼지 않고 조금 뒤로 미뤄요.', 'Shops we don’t know about yet stay in, just a little further down.')}
          </p>
        )}
      </section>

      <WhenSection planner={planner} />

      <div className="d-flex flex-column gap-4 section">
        <section aria-labelledby="count-label">
          <h2 className="eyebrow" id="count-label">
            <span>Stops</span>
            <span className="ko">{t('몇 곳', 'How many')}</span>
          </h2>
          <div className="stepper-row">
            <div className={`stepper${maxStops ? ' is-off' : stopCount === null ? ' is-default' : ''}`} role="group" aria-label={t('들를 가게 수', 'Number of shops')}>
              <button
                type="button"
                aria-label={t('한 곳 줄이기', 'One fewer')}
                disabled={maxStops || shown <= MIN_STOPS}
                onClick={() => setStopCount(shown - 1)}
              >
                <Minus size={18} />
              </button>
              <output className="tabular" aria-live="polite">
                {shown}
                <small>{t('곳', shown === 1 ? ' shop' : ' shops')}</small>
              </output>
              <button
                type="button"
                aria-label={t('한 곳 늘리기', 'One more')}
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
              {t('시간 안에 최대한 많이', 'As many as time allows')}
            </button>
          </div>
          <p className="hint tabular">
            {maxStops
              ? t(
                  `${timeBudget ? timeLabel(timeBudget) : '2시간'} 안에 들어가는 만큼 넣어요.`,
                  `As many as fit in ${timeBudget ? timeLabel(timeBudget).toLowerCase() : '2 hours'}.`,
                )
              : t(
                  `${shown}곳이면 둘러보는 시간까지 약 ${duration(estimateMin(shown))} 걸려요.`,
                  `${count(shown, '곳', 'shop')} take about ${duration(estimateMin(shown))}, browsing included.`,
                )}
          </p>
        </section>
        <section aria-labelledby="time-label">
          <h2 className="eyebrow" id="time-label">
            <span>Time</span>
            <span className="ko">{t('시간', 'How long')}</span>
          </h2>
          <div className="chip-row">
            {catalog?.timeBudgetOptionsMin.map((m) => {
              const chosen = timeBudget === m;
              const dflt = timeBudget === null && !planner.endBy && defaults?.timeBudgetMin === m;
              return (
                <button
                  key={m}
                  type="button"
                  className={`chip${chosen ? ' is-selected' : dflt ? ' is-default' : ''}`}
                  aria-pressed={chosen}
                  onClick={() => setTimeBudget(chosen ? null : m)}
                >
                  {timeLabel(m)}
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
          <EndBySelect planner={planner} />
          {planner.endBy && (
            <p className="hint">
              {t(
                `출발부터 ${planner.endBy}까지 들어가는 만큼 짜요 (끝나는 곳까지 걷는 길 포함).`,
                `We fit in what we can from the start until ${planner.endBy}, walk to the finish included.`,
              )}
            </p>
          )}
          {timeBudget === null && !planner.endBy && stopCount !== null && !maxStops && (
            <p className="hint">
              {t(`시간을 고르지 않으면 ${stopCount}곳을 모두 도는 데 맞춰요.`, `With no time set, the course takes as long as ${count(stopCount, '곳', 'shop')} need.`)}
            </p>
          )}
          {timeBudget !== null && !maxStops && estimateMin(shown) > timeBudget + 10 && (
            <p className="hint" role="status">
              {t(
                `${timeLabel(timeBudget)}이면 ${Math.max(1, Math.floor(timeBudget / 20))}곳 안팎이에요. 시간을 늘리거나 선택을 풀면 ${shown}곳을 다 넣어요.`,
                `${timeLabel(timeBudget)} fits about ${count(Math.max(1, Math.floor(timeBudget / 20)), '곳', 'shop')}. Add time or clear it to fit all ${shown}.`,
              )}
            </p>
          )}
        </section>
      </div>

      <FinishSection planner={planner} onPickOnMap={onPickEnd} picking={pickingEnd} />

      <section className="section" aria-labelledby="break-form-label">
        <h2 className="eyebrow" id="break-form-label">
          <span>Break</span>
          <span className="ko">{t('쉬어 가기', 'Take a break')}</span>
        </h2>
        <div className="chip-row">
          <button type="button" className={`chip${withFood ? ' is-selected' : ''}`} aria-pressed={withFood} onClick={() => setWithFood(!withFood)}>
            <ForkKnife size={16} aria-hidden /> {t('맛집 들르기', 'Stop for food')}
          </button>
          <button type="button" className={`chip${withCafe ? ' is-selected' : ''}`} aria-pressed={withCafe} onClick={() => setWithCafe(!withCafe)}>
            <Coffee size={16} aria-hidden /> {t('카페 들르기', 'Stop for coffee')}
          </button>
        </div>
        <p className="hint">
          {t(
            '가는 길에서 크게 벗어나지 않는 곳으로, 코스 순서에 맞춰 넣어요. 코스를 짠 뒤에도 넣고 뺄 수 있어요.',
            'We pick places close to your route and slot them in along the way. You can add or remove them later, too.',
          )}
        </p>
      </section>

      <section className="section" aria-labelledby="must-label">
        <h2 className="eyebrow" id="must-label">
          <span>Must</span>
          <span className="ko">{t('꼭 넣을 가게', 'Must-visit shops')} {planner.mustShops.length > 0 && <span className="tabular">· {planner.mustShops.length}</span>}</span>
        </h2>
        {planner.mustShops.length > 0 && (
          <ul className="must-list">
            {planner.mustShops.map((m) => (
              <li key={m.id} className="must-chip">
                <PushPin size={14} weight="fill" aria-hidden /> {m.name}
                <button type="button" onClick={() => planner.removeMustShop(m.id)} aria-label={t(`${m.name} 빼기`, `Remove ${m.name}`)}>
                  <X size={14} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {finding ? (
          <div className="mt-2">
            <ShopSearch
              label={t('가게 이름으로 찾기', 'Find by shop name')}
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
              <MagnifyingGlass size={16} aria-hidden /> {t('가게 이름으로 찾아 넣기', 'Add a shop by name')}
            </button>
          </div>
        )}
        <p className="hint">
          {t(
            '고른 조건에 더해, 이 가게들은 시간 안에 들어가면 꼭 넣어요. 글로 “○○는 무조건 넣어줘”라고 써도 돼요.',
            'On top of your choices, these shops go in whenever they fit the time. You can also type “make sure ○○ is in”.',
          )}
        </p>
      </section>

      <details className="section more" open={budget !== 'any' || items.length > 0 || skipVisited || undefined}>
        <summary>
          {t('더 보기 · 예산, 품목', 'More · budget, items')}
          {(budget !== 'any' || items.length > 0) && <span className="tabular"> ({(budget !== 'any' ? 1 : 0) + items.length})</span>}
        </summary>
        <div className="pt-3">
          <h2 className="eyebrow">
            <span>Budget</span>
            <span className="ko">{t('예산', 'How much')}</span>
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
            <span className="ko">{t('찾는 품목', 'Looking for')}</span>
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
            <span className="ko">{t('내 가게', 'Your shops')}</span>
          </h2>
          <div className="chip-row">
            <button type="button" className={`chip${skipVisited ? ' is-selected' : ''}`} aria-pressed={skipVisited} onClick={() => setSkipVisited(!skipVisited)}>
              {t('가 본 곳 빼기', 'Skip places I’ve been')}
            </button>
          </div>
          <p className="hint">{t('찜하거나 좋았던 가게는 조금 더 앞에, 별로였던 가게는 빼고 짜요.', 'Shops you saved or liked come a bit earlier; ones you didn’t like are left out.')}</p>
        </div>
      </details>
    </>
  );
}
