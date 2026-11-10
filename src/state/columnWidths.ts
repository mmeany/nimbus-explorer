// Column widths the user sets by dragging a header edge (FileList, ResultsGrid).
// Kept per list in localStorage under `fl-cols|<storageKey>`, by column id;
// columns without an entry use their default width.
import { useState, type PointerEvent } from "react";

/** Narrowest a column can be dragged. */
export const MIN_COL_W = 40;
/** Widest a column can be dragged or fitted. */
export const MAX_COL_W = 2000;

export type Widths = Record<string, number>;

const widthsKey = (k: string) => `fl-cols|${k}`;

export const clampWidth = (w: number) => Math.round(Math.min(MAX_COL_W, Math.max(MIN_COL_W, w)));

function load(storageKey?: string): Widths {
  if (!storageKey) return {};
  try {
    const v = JSON.parse(localStorage.getItem(widthsKey(storageKey)) ?? "{}");
    if (!v || typeof v !== "object") return {};
    const out: Widths = {};
    for (const [k, w] of Object.entries(v)) if (typeof w === "number" && w >= MIN_COL_W) out[k] = Math.min(w, MAX_COL_W);
    return out;
  } catch {
    return {};
  }
}

function save(storageKey: string | undefined, w: Widths) {
  if (!storageKey) return;
  try {
    if (Object.keys(w).length === 0) localStorage.removeItem(widthsKey(storageKey));
    else localStorage.setItem(widthsKey(storageKey), JSON.stringify(w));
  } catch {
    // Not remembered; the widths still apply until the list unmounts.
  }
}

/** Widths set by the user, plus the drag / fit / reset actions that change them. */
export function useColumnWidths(storageKey?: string) {
  const [custom, setCustom] = useState<Widths>(() => load(storageKey));
  const [loadedKey, setLoadedKey] = useState(storageKey);
  if (loadedKey !== storageKey) {
    setLoadedKey(storageKey);
    setCustom(load(storageKey));
  }

  /** Sets one column's width; `persist` saves it (false while dragging). */
  function setWidth(id: string, w: number, persist = true) {
    setCustom((c) => {
      const next = { ...c, [id]: clampWidth(w) };
      if (persist) save(storageKey, next);
      return next;
    });
  }

  /** Pointer-down on a resize handle: follows the pointer, saves on release. */
  function startResize(e: PointerEvent<HTMLElement>, id: string, startW: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const x0 = e.clientX;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add("col-resizing");
    let w = startW;
    const move = (ev: globalThis.PointerEvent) => {
      w = startW + ev.clientX - x0;
      setWidth(id, w, false);
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      document.body.classList.remove("col-resizing");
      if (w !== startW) setWidth(id, w);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  function reset() {
    setCustom({});
    save(storageKey, {});
  }

  return { custom, hasCustom: Object.keys(custom).length > 0, setWidth, startResize, reset };
}

/** Widest `scrollWidth` among `cells` (content width, ignoring the cell's own cap). */
export function widestCell(cells: Iterable<Element>): number {
  let w = 0;
  for (const c of cells) w = Math.max(w, (c as HTMLElement).scrollWidth);
  return w;
}
