// Anonymous browser id for "내 가게" (saved / visited shops) until login exists (PLAN.md stage 7).
// Kept in localStorage; if storage is blocked (private mode), a per-tab id is used and the data won't persist.
const KEY = 'route01.anon';
let memory: string | null = null;

export function anonId(): string {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    memory ??= crypto.randomUUID();
    return memory;
  }
}

/** True when the id survives a reload (localStorage works). */
export function anonIdPersists(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export function forgetAnonId(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
  memory = null;
}
