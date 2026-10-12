import { useSyncExternalStore } from 'react';

/**
 * Korean and English. Strings live next to the code as pairs — t('스타일', 'Style') — so a screen reads as it did and
 * a missing translation is visible where it's used. The language goes to the API on every request (x-route-lang),
 * which answers course notes, reasons and shop texts in it.
 *
 * Components re-render on a switch because App subscribes (useLang) and nothing below it is memoised; plain
 * functions can call t() too.
 */
export type Lang = 'ko' | 'en';

const KEY = 'route01.lang';

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'ko' || saved === 'en') return saved;
  } catch {
    /* no storage */
  }
  return navigator.language?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

let current: Lang = initial();
document.documentElement.lang = current;
const listeners = new Set<() => void>();

export const getLang = (): Lang => current;

export function setLang(lang: Lang) {
  if (lang === current) return;
  current = lang;
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* fine without it */
  }
  listeners.forEach((f) => f());
}

export function useLang(): Lang {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => current,
  );
}

/** The string in the current language. */
export function t(ko: string, en: string): string {
  return current === 'en' ? en : ko;
}

/** "3곳" / "3 shops": numbers with their unit, singular in English when one. */
export function count(n: number, ko: string, enOne: string, enMany = `${enOne}s`): string {
  return current === 'en' ? `${n} ${n === 1 ? enOne : enMany}` : `${n}${ko}`;
}
