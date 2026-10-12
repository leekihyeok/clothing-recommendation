import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The language a request asked for (client header x-route-lang: ko | en), available anywhere while it's handled —
 * course notes, reasons, hours and shop texts are written in it without passing it through every call.
 * Stored courses keep their Korean text; responses are localised on the way out (CourseService.localize).
 */
export type Lang = 'ko' | 'en';

export const langStore = new AsyncLocalStorage<Lang>();

export const lang = (): Lang => langStore.getStore() ?? 'ko';

/** The string in the request's language. */
export const L = (ko: string, en: string): string => (lang() === 'en' ? en : ko);

/** Express middleware: run the rest of the request in its language. */
export function langMiddleware(req: { headers: Record<string, string | string[] | undefined> }, _res: unknown, next: () => void) {
  langStore.run(req.headers['x-route-lang'] === 'en' ? 'en' : 'ko', next);
}
