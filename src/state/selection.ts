// The single selected row of the main view's list, as FileList reports it, so
// "Add bookmark" (star / Ctrl+D) can remember the item along with the place.
// Keys are FileList row keys, the same ones `state/reveal.ts` selects again.

export interface ListSelection {
  key: string;
  /** The row's name (first column). */
  label: string;
}

let current: { owner: object; sel: ListSelection | null } | null = null;

export function reportSelection(owner: object, sel: ListSelection | null) {
  if (sel) current = { owner, sel };
  else if (current?.owner === owner) current = null;
}

export function currentSelection(): ListSelection | null {
  return current?.sel ?? null;
}

export function clearSelection() {
  current = null;
}
