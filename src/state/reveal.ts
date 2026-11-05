// "Select this row when it shows up": set when the History dialog goes to a
// location, consumed by the first FileList that has a row with that key.
// Module-level, so no service needs to know about it. It expires after a
// while, so a row that never appears (deleted, on another page) is forgotten.

let pending: { key: string; until: number } | null = null;

export function requestReveal(key: string | null) {
  pending = key ? { key, until: Date.now() + 15_000 } : null;
}

/** The key to select if one of `keys` matches, clearing the request. */
export function takeReveal(has: (key: string) => boolean): string | null {
  if (!pending) return null;
  if (Date.now() > pending.until) {
    pending = null;
    return null;
  }
  if (!has(pending.key)) return null;
  const k = pending.key;
  pending = null;
  return k;
}
