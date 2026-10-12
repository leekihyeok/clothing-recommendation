import type { Pool } from 'pg';
import { lang } from './lang';

// Texts change rarely (pipeline.translate adds new ones); a small in-process cache saves a query per request.
const cache = new Map<string, string | null>();
const MAX_CACHE = 20_000;

/**
 * English for Korean texts AI wrote (pipeline.translate → translations), when the request asked for English.
 * Korean requests, and texts not translated yet, come back as they are.
 */
export async function inLang(pool: Pool, texts: (string | null | undefined)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (lang() !== 'en') return out;
  const want = [...new Set(texts.filter((x): x is string => !!x))];
  const missing = want.filter((x) => !cache.has(x));
  if (missing.length) {
    const r = await pool.query<{ ko: string; en: string }>('SELECT ko, en FROM translations WHERE ko = ANY($1)', [missing]);
    const found = new Map(r.rows.map((x) => [x.ko, x.en]));
    if (cache.size > MAX_CACHE) cache.clear();
    // Not translated yet: remember for a while only (they get translated in the background).
    for (const m of missing) cache.set(m, found.get(m) ?? null);
    setTimeout(() => missing.filter((m) => cache.get(m) === null).forEach((m) => cache.delete(m)), 10 * 60_000).unref?.();
  }
  for (const w of want) {
    const en = cache.get(w);
    if (en) out.set(w, en);
  }
  return out;
}

/** One text in the request's language. */
export async function oneInLang(pool: Pool, text: string | null | undefined): Promise<string | undefined> {
  if (!text) return undefined;
  return (await inLang(pool, [text])).get(text) ?? text;
}
