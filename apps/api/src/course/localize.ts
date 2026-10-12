import { STYLES } from '@cr/shared';
import { messageEn } from '../infra/messages';
import type { CourseWeather } from './course.model';

/**
 * English for what course planning writes in Korean (notes, edit messages, weather lines). Courses are stored with
 * their Korean text; an English request gets them through these on the way out (CourseService.localize). Each pattern
 * mirrors a template in course.service.ts — a new Korean template there needs its line here, or it stays Korean.
 */

const STYLE_EN = Object.fromEntries(STYLES.map((s) => [s.label, s.labelEn ?? s.label]));
export const VARIANT_LABEL_EN: Record<string, string> = { recommended: 'Recommended', nearby: 'Closer together', taste: 'Best match' };
export const CATEGORY_EN: Record<string, string> = {
  select_shop: 'Select shop', vintage: 'Vintage & thrift shop', brand: 'Brand store', spa: 'Fast-fashion store', general: 'Clothing store', complex: 'Department store / mall',
};
const BREAK_EN: Record<string, string> = { 카페: 'café', 맛집: 'place to eat' };

// Korean particles left on a name by the templates (을/를, 은/는, 으로/로, 을(를)).
const NAME = '(.+?)(?:을\\(를\\)|을|를|은|는|으로|로)?';
const n = (s: string) => s.replace(/(을\(를\)|을|를|은|는|으로|로)$/, '');
const list = (s: string) => s.split('·').map(n).join(', ');

const RULES: [RegExp, (...m: string[]) => string][] = [
  [/^시간 안에 (\d+)곳을 넣었어요$/, (_, k) => `Fit ${k} shops in the time`],
  [/^시간 안에 (\d+)곳까지 돌 수 있어요$/, (_, k) => `Only ${k} shops fit in the time`],
  [/^조건에 맞는 가게가 없어요$/, () => 'No shops match these conditions'],
  [new RegExp(`^${NAME} 그대로 두고 나머지를 바꿨어요$`), (_, x) => `Kept ${list(x)}, changed the rest`],
  [new RegExp(`^${NAME} 시간 안에 넣지 못했어요$`), (_, x) => `Couldn't fit ${list(x)} in the time`],
  [new RegExp(`^${NAME} 출발점에서 멀어서 넣지 않았어요$`), (_, x) => `${list(x)}: too far from the start, left out`],
  [/^(\d{2}:\d{2}) 출발에 맞춰 그때 닫는 가게 (\d+)곳은 뺐어요$/, (_, at, k) => `Left out ${k} shops closed at ${at}`],
  [new RegExp(`^이 근처에서 ${NAME} 다루는 가게를 찾지 못했어요$`), (_, x) => `No shop around here carries ${list(x)}`],
  [/^고정한 가게가 (\d+)곳이라 \d+곳으로 짰어요$/, (_, k) => `Planned ${k} stops to fit all ${k} pinned shops`],
  [/^코스 가까이에서 들를 (.+?)(?:을|를) 찾지 못했어요$/, (_, x) => `Couldn't find a ${x.split('·').map((k) => BREAK_EN[k] ?? k).join(' or ')} near the route`],
  [/^코스 가까이에서 다른 (.+?)(?:을|를) 찾지 못했어요$/, (_, x) => `Couldn't find another ${BREAK_EN[x] ?? x} near the route`],
  [new RegExp(`^${NAME} 뺐어요$`), (_, x) => (BREAK_EN[n(x)] ? `Took out the ${BREAK_EN[n(x)]}` : `Took out ${n(x)}`)],
  [new RegExp(`^(\\d+)번 다음, 가는 길에 있는 ${NAME} 넣었어요$`), (_, k, x) => `Added ${n(x)} after #${k}, on the way`],
  [new RegExp(`^${NAME} 넣었어요$`), (_, x) => `Added ${n(x)}`],
  [new RegExp(`^${NAME} (\\d+)번으로 옮겼어요$`), (_, x, k) => `Moved ${n(x)} to #${k}`],
  [/^(.+?) 대신 (.+?)(?:으로|로) 바꿨어요$/, (_, a, b) => `Swapped ${a} for ${b}`],
  [/^(.+?) 대신 (.+)$/, (_, a, b) => `Swapped ${a} for ${b}`],
  [/^더 가까운 가게 위주로 다시 짰어요$/, () => 'Replanned with closer shops'],
  [/^취향에 더 맞는 가게 위주로 다시 짰어요$/, () => 'Replanned with shops that match better'],
  [/^걷는 순서도 다시 맞췄어요$/, () => 'walking order updated'],
  [new RegExp(`^${NAME} 이미 코스에 있어요$`), (_, x) => `${n(x)} is already in the route`],
  [/^‘(.+)’ 가게를 찾지 못했어요.*$/, (_, x) => `Couldn't find a shop called “${x}”. Check the name or use “Find a shop by name”`],
  [/^근처에서 (.+) 가게를 더 찾지 못했어요$/, (_, x) => `No more ${x} shops nearby`],
  [/^근처에서 바꿀 만한 가게를 더 찾지 못했어요$/, () => 'No other shop nearby to swap in'],
  [/^\(코스에서 ([\d.]+)km 떨어진 곳이라 걷는 길이 길어져요\)$/, (_, km) => `(${km} km from the route, so the walk gets longer)`],
  [/^되돌렸어요$/, () => 'Undone'],
];

/** One Korean line (or " · "-joined lines) in English where a rule knows it; unknown parts stay as they are. */
export function noteEn(text: string | undefined | null): string | undefined {
  if (!text) return text ?? undefined;
  return text
    .split(' · ')
    .map((part) => {
      const p = part.trim();
      // "… (코스에서 2.1km …)" trails some messages.
      const tail = /^(.*?)( \(코스에서 [\d.]+km 떨어진 곳이라 걷는 길이 길어져요\))$/.exec(p);
      if (tail) return `${noteEn(tail[1])} ${noteEn(tail[2].trim())}`;
      for (const [re, f] of RULES) {
        const m = re.exec(p);
        if (m) return f(...m);
      }
      // Error messages that come back inside an assistant reply ("3번 가게가 코스에 없어요").
      return messageEn(p);
    })
    .join(' · ');
}

/** "취향 반영: 빈티지·구제 쪽으로 · 캐주얼은 덜 · 최근 코스의 가게는 줄이고 …" → English. */
export function tasteNoteEn(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const body = text.replace(/^취향 반영:\s*/, '');
  const parts = body.split(' · ').map((p) => {
    const toward = /^(.+?) 쪽으로( 조금 더)?$/.exec(p);
    if (toward) return `${toward[2] ? 'a bit more ' : 'leaning '}${toward[1].split('·').map((s) => STYLE_EN[s] ?? s).join(' & ')}`;
    const less = /^(.+?)(?:은|는) 덜$/.exec(p);
    if (less) return `less ${STYLE_EN[less[1]] ?? less[1]}`;
    if (p.startsWith('최근 코스의 가게는 줄이고')) return 'fewer shops from your recent routes, some new ones';
    return p;
  });
  return `From your taste: ${parts.join(' · ')}`;
}

const WEATHER_WHY_EN: Record<string, string> = { rain: 'Rain is expected', snow: 'Snow is expected', hot: "It's a hot day", cold: "It's a cold day" };

/** The weather line and its note in English (the stored ones are Korean). */
export function weatherEn(w: CourseWeather | undefined): CourseWeather | undefined {
  if (!w) return w;
  const s = w.summary
    .replace(/^비 (\d+)%/, 'Rain $1%')
    .replace(/^눈 (\d+)%/, 'Snow $1%')
    .replace(/^체감 (-?\d+)°/, 'Feels like $1°')
    .replace(/^맑거나 흐림/, 'Clear or cloudy');
  const why = WEATHER_WHY_EN[w.condition];
  const indoor = !w.note || w.note.includes('실내를 한 곳');
  const note = !w.applied || !why
    ? undefined
    : indoor
      ? `${why}, so an indoor place (department store, mall) is in and the walks between shops are short`
      : `${why}, so the walks between shops are short (no indoor shop nearby fits your styles)`;
  return { ...w, summary: s, note };
}

/** A course card's reason in English: brands it carries, the best chosen style's score, then the shop's own line. */
export function reasonEn(parts: { brands: string[]; style?: { label: string; score: number }; text?: string; category: string }): string {
  const out: string[] = [];
  if (parts.brands.length) out.push(`Carries ${parts.brands.join(', ')}`);
  if (parts.style) out.push(`${parts.style.label} ${parts.style.score}/10`);
  out.push(parts.text || CATEGORY_EN[parts.category] || 'Clothing store');
  return out.join(' · ');
}
