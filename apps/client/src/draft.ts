/**
 * What was being typed or picked on the planning form, kept for this tab only (sessionStorage), so a reload doesn't
 * wipe it. Not in the address: there's too much of it, and a sentence someone typed doesn't belong in a URL they might
 * copy. Storage can be blocked (private mode, previews): then the form simply starts empty, as before.
 */
export function readDraft<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(`route01.draft.${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeDraft(key: string, value: unknown) {
  try {
    sessionStorage.setItem(`route01.draft.${key}`, JSON.stringify(value));
  } catch {
    /* fine without it */
  }
}
