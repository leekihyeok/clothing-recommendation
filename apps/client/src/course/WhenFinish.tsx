import { ArrowCounterClockwise, CalendarBlank, Flag, MapPin, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { Planner } from './usePlanner';
import { getLang, t } from '../i18n';

// Sunday first, as getUTCDay() counts.
const DAY = () => (getLang() === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['일', '월', '화', '수', '목', '금', '토']);
const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const month = (m: number) => t(`${m}월`, MONTH_EN[m - 1]);
// Shops open late morning and close in the evening; the time list covers that.
const FIRST_SLOT = 10 * 60;
const LAST_SLOT = 21 * 60;

/** Now in Seoul as { date: "2026-10-12", minutes since midnight }. */
function seoulNow(): { date: string; minutes: number } {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (date: string) => new Date(`${date}T12:00:00+09:00`).getUTCDay();
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
/** "10/17(토)" / "Sat 10/17" */
const dayDate = (d: string) => {
  const md = `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return getLang() === 'en' ? `${DAY()[weekday(d)]} ${md}` : `${md}(${DAY()[weekday(d)]})`;
};

/** "오늘 14:00", "내일 11:30", "10/17(토) 14:00" for the result header and the hint. */
export function startLabel(startAt: string): string {
  const { date } = seoulNow();
  const [d, time] = startAt.split('T');
  const day = d === date ? t('오늘', 'Today') : d === addDays(date, 1) ? t('내일', 'Tomorrow') : dayDate(d);
  return `${day} ${time}`;
}

/** Half-hour slots for a day: today only those still ahead. */
function slots(date: string): string[] {
  const now = seoulNow();
  const out: string[] = [];
  for (let m = FIRST_SLOT; m <= LAST_SLOT; m += 30) if (date !== now.date || m > now.minutes + 10) out.push(hhmm(m));
  return out;
}

// A course can be planned up to two weeks ahead (apps/api/src/course/hours.ts MAX_AHEAD_DAYS).
const AHEAD_DAYS = 13;

/**
 * "다른 날": a small calendar of the weeks that can be picked (today … two weeks on), Monday first, in the app's
 * square ink style instead of the browser's date picker. Arrow keys move between days; Esc or a tap outside closes it.
 */
function DayCalendar({ today, chosen, onPick, onClose }: { today: string; chosen: string | null; onPick: (date: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const last = addDays(today, AHEAD_DAYS);
  const start = addDays(today, -((weekday(today) + 6) % 7)); // the Monday of this week
  const cells: string[] = [];
  for (let d = start; d <= last || cells.length % 7; d = addDays(d, 1)) cells.push(d);
  const can = (d: string) => d >= today && d <= last && slots(d).length > 0;
  const [focus, setFocus] = useState(() => (chosen && can(chosen) ? chosen : (cells.find(can) ?? today)));

  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>(`[data-date="${focus}"]`)?.focus();
  }, [focus]);
  useEffect(() => {
    const away = (e: PointerEvent) => !box.current?.parentElement?.contains(e.target as Node) && onClose();
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [onClose]);

  function key(e: React.KeyboardEvent) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (!step) return;
    e.preventDefault();
    // Skip over days that can't be picked (past ones, today once it's too late).
    for (let d = addDays(focus, step), i = 0; i < 21; d = addDays(d, step), i++) {
      if (d < cells[0] || d > cells[cells.length - 1]) return;
      if (can(d)) return setFocus(d);
    }
  }

  const months = [...new Set(cells.filter(can).map((d) => Number(d.slice(5, 7))))];
  return (
    <div className="day-cal" ref={box} role="dialog" aria-label={t('날짜 고르기', 'Pick a date')} onKeyDown={key}>
      <div className="day-cal-head">
        <strong className="tabular">{months.map(month).join(' – ')}</strong>
        <span>{t('2주 안에서 골라 주세요', 'Pick a day within 2 weeks')}</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t('달력 닫기', 'Close calendar')}>
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="day-cal-grid" role="grid">
        {(getLang() === 'en' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['월', '화', '수', '목', '금', '토', '일']).map((w, i) => (
          <span key={w} className={`day-cal-dow${i >= 5 ? ' is-weekend' : ''}`} role="columnheader">
            {w}
          </span>
        ))}
        {cells.map((d) => {
          const ok = can(d);
          const day = Number(d.slice(8, 10));
          const firstOfMonth = day === 1;
          return (
            <button
              key={d}
              type="button"
              role="gridcell"
              data-date={d}
              className={`day-cal-day${d === chosen ? ' is-selected' : ''}${d === today ? ' is-today' : ''}${weekday(d) % 6 === 0 ? ' is-weekend' : ''}`}
              disabled={!ok}
              tabIndex={d === focus ? 0 : -1}
              aria-selected={d === chosen}
              aria-label={t(
                `${Number(d.slice(5, 7))}월 ${day}일 ${DAY()[weekday(d)]}요일${d === today ? ', 오늘' : ''}`,
                `${DAY()[weekday(d)]}, ${month(Number(d.slice(5, 7)))} ${day}${d === today ? ', today' : ''}`,
              )}
              onClick={() => onPick(d)}
            >
              {firstOfMonth && <small>{month(Number(d.slice(5, 7)))}</small>}
              <span className="tabular">{day}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** "언제": now, or a day (today, tomorrow, the coming weekend, any date within two weeks) and a time. */
export function WhenSection({ planner }: { planner: Planner }) {
  const now = seoulNow();
  const today = now.date;
  const chosen = planner.startAt?.split('T')[0] ?? null;
  const time = planner.startAt?.split('T')[1] ?? null;
  const tomorrow = addDays(today, 1);
  // The coming weekend; on a Saturday or Sunday (it's 오늘·내일 already) the one after, as "다음 토 · 다음 일".
  let sat = addDays(today, (6 - weekday(today) + 7) % 7);
  const nextWeek = sat <= tomorrow;
  if (nextWeek) sat = addDays(sat, 7);
  const near = [
    { date: today, label: t('오늘', 'Today') },
    { date: tomorrow, label: t('내일', 'Tomorrow') },
  ];
  const weekend = [sat, addDays(sat, 1)].map((d) => ({
    date: d,
    label: `${nextWeek ? t('다음', 'Next') : t('이번', 'This')} ${DAY()[weekday(d)]}`,
  }));
  const days = [...near, ...weekend];
  const [calendar, setCalendar] = useState(false);
  const otherBtn = useRef<HTMLButtonElement>(null);
  const pick = (date: string) => {
    const options = slots(date);
    // Keep the time already chosen when it still works on the new day; else the first slot after noon (or the next one today).
    const keep = time && options.includes(time) ? time : (options.find((t) => toMin(t) >= 13 * 60) ?? options[0]);
    planner.setStartAt(keep ? `${date}T${keep}` : null);
  };
  const options = chosen ? slots(chosen) : [];
  const other = chosen && !days.some((d) => d.date === chosen);

  return (
    <section className="section" aria-labelledby="when-label">
      <h2 className="eyebrow" id="when-label">
        <span>When</span>
        <span className="ko">{t('언제', 'When to go')}</span>
      </h2>
      <div className="when-grid" role="group" aria-labelledby="when-label">
        <button type="button" className={`chip${!planner.startAt ? ' is-default' : ''}`} aria-pressed={!planner.startAt} onClick={() => planner.setStartAt(null)}>
          {t('지금 출발', 'Leave now')}
        </button>
        {days.map((d) => {
          // Today with no slot left (late evening) can't be picked.
          const off = !slots(d.date).length;
          return (
            <button
              key={d.date}
              type="button"
              className={`chip${chosen === d.date ? ' is-selected' : ''}`}
              aria-pressed={chosen === d.date}
              disabled={off}
              title={off ? t('오늘은 고를 수 있는 시각이 지났어요', 'No start times left today') : undefined}
              onClick={() => pick(d.date)}
            >
              {d.label}
            </button>
          );
        })}
        <button
          ref={otherBtn}
          type="button"
          className={`chip${other || calendar ? ' is-selected' : ''}`}
          aria-pressed={!!other}
          aria-haspopup="dialog"
          aria-expanded={calendar}
          onClick={() => setCalendar(!calendar)}
        >
          <CalendarBlank size={16} aria-hidden />
          {other ? dayDate(chosen!) : t('다른 날', 'Other day')}
        </button>
        {calendar && (
          <DayCalendar
            today={today}
            chosen={chosen}
            onPick={(d) => {
              pick(d);
              setCalendar(false);
              otherBtn.current?.focus();
            }}
            onClose={() => {
              setCalendar(false);
              otherBtn.current?.focus();
            }}
          />
        )}
      </div>
      {chosen && (
        <div className="time-pick">
          <label htmlFor="start-time">{t('출발 시각', 'Start time')}</label>
          <select id="start-time" className="field-select" value={time ?? ''} onChange={(e) => planner.setStartAt(`${chosen}T${e.target.value}`)}>
            {options.map((hm) => (
              <option key={hm} value={hm}>
                {hm}
              </option>
            ))}
          </select>
        </div>
      )}
      <p className="hint">
        {planner.startAt
          ? t(
              `${startLabel(planner.startAt)}에 여는 가게로 짜고, 가게마다 도착 시각을 알려 드려요. 영업시간을 아는 가게(사장님·블로그 글 기준)만 걸러요.`,
              `We plan with shops open from ${startLabel(planner.startAt)} and show when you’ll reach each one. Only shops with known hours (from owners or blog posts) are checked.`,
            )
          : t('지금 문 연 가게로 짜요. 나중에 갈 거면 날짜와 시각을 골라 주세요.', 'We plan with shops open right now. Going later? Pick a day and time.')}
      </p>
    </section>
  );
}

/** "몇 시까지": a finish time instead of a length. */
export function EndBySelect({ planner }: { planner: Planner }) {
  const start = planner.startAt ? toMin(planner.startAt.split('T')[1]) : seoulNow().minutes;
  const options: string[] = [];
  for (let m = Math.ceil((start + 60) / 30) * 30; m <= 22 * 60; m += 30) options.push(hhmm(m));
  if (planner.endBy && !options.includes(planner.endBy)) options.unshift(planner.endBy); // read from text
  return (
    <div className="time-pick">
      <label htmlFor="end-by">{t('끝낼 시각', 'Finish by')}</label>
      <select id="end-by" className="field-select" value={planner.endBy ?? ''} onChange={(e) => planner.setEndBy(e.target.value || null)}>
        <option value="">{t('정하지 않음', 'No limit')}</option>
        {options.map((hm) => (
          <option key={hm} value={hm}>
            {t(`${hm}까지`, `By ${hm}`)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** "끝나는 곳": the last shop, back to the start, or a place picked on the map (or named in the text). */
export function FinishSection({ planner, onPickOnMap, picking }: { planner: Planner; onPickOnMap: () => void; picking: boolean }) {
  const { end, setEnd } = planner;
  return (
    <section className="section" aria-labelledby="finish-label">
      <h2 className="eyebrow" id="finish-label">
        <span>Finish</span>
        <span className="ko">{t('끝나는 곳', 'Where to end')}</span>
      </h2>
      <div className="chip-row" role="group" aria-labelledby="finish-label">
        <button type="button" className={`chip${end.kind === 'last' ? ' is-default' : ''}`} aria-pressed={end.kind === 'last'} onClick={() => setEnd({ kind: 'last' })}>
          {t('마지막 가게', 'Last shop')}
        </button>
        <button type="button" className={`chip${end.kind === 'back' ? ' is-selected' : ''}`} aria-pressed={end.kind === 'back'} onClick={() => setEnd({ kind: 'back' })}>
          <ArrowCounterClockwise size={16} aria-hidden /> {t('출발점으로 돌아오기', 'Back to the start')}
        </button>
        {end.kind === 'point' ? (
          <span className="chip is-selected chip-removable">
            <Flag size={16} aria-hidden /> {end.name}
            <button type="button" onClick={() => setEnd({ kind: 'last' })} aria-label={t(`끝나는 곳 ${end.name} 지우기`, `Clear finish ${end.name}`)}>
              <X size={14} aria-hidden />
            </button>
          </span>
        ) : (
          <button type="button" className={`chip${picking ? ' is-selected' : ''}`} aria-pressed={picking} onClick={onPickOnMap}>
            <MapPin size={16} aria-hidden /> {picking ? t('지도를 눌러 주세요', 'Tap the map') : t('지도에서 고르기', 'Pick on the map')}
          </button>
        )}
      </div>
      <p className="hint">
        {end.kind === 'last'
          ? t(
              '약속 장소나 역에서 끝내고 싶으면 골라 주세요. 글로 “합정역에서 끝나게”라고 써도 돼요.',
              'Want to end at a meeting spot or a station? Pick it here, or type “finish at Hapjeong Station”.',
            )
          : end.kind === 'back'
            ? t('출발한 곳으로 돌아오는 길까지 시간에 넣어 짜요.', 'The walk back to where you started counts toward the time.')
            : t(
                `${end.name}까지 걸어가는 길까지 시간에 넣고, 그쪽으로 이어지게 짜요.`,
                `The walk to ${end.name} counts toward the time, and the course heads that way.`,
              )}
      </p>
    </section>
  );
}
