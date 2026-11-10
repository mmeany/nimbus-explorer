import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { ContextMenu } from "./ContextMenu";
import { takeReveal } from "../state/reveal";
import { reportSelection } from "../state/selection";

export interface Column {
  id: string;
  label: string;
  width: number;
  align?: "left" | "right";
}

export interface Row {
  key: string;
  icon: ReactNode;
  /** Folders/buckets sort before files regardless of sort column. */
  isContainer: boolean;
  /** Shown faded (e.g. cut to the clipboard). */
  dimmed?: boolean;
  cells: Record<string, { text: string; sort: string | number }>;
}

interface Props {
  columns: Column[];
  rows: Row[];
  selected: Set<string>;
  onSelectionChange: (keys: Set<string>) => void;
  onOpen: (key: string) => void;
  /** Right-click on a row (key) or on empty space (null). */
  onContextMenu?: (key: string | null, x: number, y: number) => void;
  /** Reports row keys in display (sorted) order, e.g. for preview next/previous. */
  onOrderChange?: (keys: string[]) => void;
  emptyText: string;
  /** Starting sort (default: first column, ascending). */
  initialSort?: { col: string; dir: 1 | -1 };
  /** Remembers column widths the user sets (localStorage `fl-cols|<storageKey>`). */
  storageKey?: string;
}

type Sort = { col: string; dir: 1 | -1 };

/** Row height in px; must match .fl-row in styles.css. */
const ROW_H = 22;
/** Extra rows rendered above/below the viewport. */
const OVERSCAN = 12;
/** Narrowest a column can be dragged. */
const MIN_COL_W = 40;
/** Widest a column can be dragged or fitted. */
const MAX_COL_W = 2000;

type Widths = Record<string, number>;

const widthsKey = (k: string) => `fl-cols|${k}`;

function loadWidths(storageKey?: string): Widths {
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

function saveWidths(storageKey: string | undefined, w: Widths) {
  if (!storageKey) return;
  try {
    if (Object.keys(w).length === 0) localStorage.removeItem(widthsKey(storageKey));
    else localStorage.setItem(widthsKey(storageKey), JSON.stringify(w));
  } catch {
    // Not remembered; the widths still apply until the list unmounts.
  }
}

const clampW = (w: number) => Math.round(Math.min(MAX_COL_W, Math.max(MIN_COL_W, w)));

/** Details-view list with sortable columns and Explorer-style selection. */
export function FileList({ columns, rows, selected, onSelectionChange, onOpen, onContextMenu, onOrderChange, emptyText, initialSort, storageKey }: Props) {
  const [sort, setSort] = useState<Sort>(initialSort ?? { col: columns[0].id, dir: 1 });
  const anchor = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Virtualisation: only rows near the viewport are in the DOM.
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  // Vertical scrollbar width, so the header can scroll as far as the body.
  const [scrollbarW, setScrollbarW] = useState(0);
  const headerRef = useRef<HTMLDivElement>(null);
  // Header scrolls horizontally with the body (its own scrollbar hidden).
  const headWrapRef = useRef<HTMLDivElement>(null);
  // Column widths the user set (by column id); others use Column.width.
  const [custom, setCustom] = useState<Widths>(() => loadWidths(storageKey));
  const [loadedKey, setLoadedKey] = useState(storageKey);
  if (loadedKey !== storageKey) {
    setLoadedKey(storageKey);
    setCustom(loadWidths(storageKey));
  }
  const [headMenu, setHeadMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewH(el.clientHeight);
      setScrollbarW(el.offsetWidth - el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      if (a.isContainer !== b.isContainer) return a.isContainer ? -1 : 1;
      const av = a.cells[sort.col]?.sort ?? "";
      const bv = b.cells[sort.col]?.sort ?? "";
      const c =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
      return c * sort.dir;
    });
    return out;
  }, [rows, sort]);

  useEffect(() => onOrderChange?.(sorted.map((r) => r.key)), [sorted, onOrderChange]);

  // Drop the shift-anchor when the row set changes.
  useEffect(() => {
    anchor.current = null;
  }, [rows]);

  // A row asked for by the History dialog ("go to location"): select it once it's listed.
  useEffect(() => {
    if (rows.length === 0) return;
    const key = takeReveal((k) => rows.some((r) => r.key === k));
    if (key === null) return;
    anchor.current = key;
    onSelectionChange(new Set([key]));
    const i = sorted.findIndex((r) => r.key === key);
    const el = bodyRef.current;
    if (el && i >= 0) el.scrollTop = Math.max(0, i * ROW_H - el.clientHeight / 3);
    // Only when the rows change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // Tell "Add bookmark" which single row of the main view is selected.
  const owner = useRef({});
  useEffect(() => {
    if (!bodyRef.current?.closest(".pane-main")) return;
    const key = selected.size === 1 ? [...selected][0] : null;
    const row = key !== null ? rows.find((r) => r.key === key) : undefined;
    const first = columns[0]?.id;
    reportSelection(owner.current, row ? { key: row.key, label: (first && row.cells[first]?.text) || row.key } : null);
  }, [selected, rows, columns]);
  useEffect(() => {
    const me = owner.current;
    return () => reportSelection(me, null);
  }, []);

  /** Scrolls so row `index` is fully visible. */
  function ensureVisible(index: number) {
    const el = bodyRef.current;
    if (!el) return;
    const top = index * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  }

  function clickRow(e: MouseEvent, key: string) {
    if (e.shiftKey && anchor.current) {
      const keys = sorted.map((r) => r.key);
      const a = keys.indexOf(anchor.current);
      const b = keys.indexOf(key);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const range = new Set(keys.slice(lo, hi + 1));
      if (e.ctrlKey) selected.forEach((k) => range.add(k));
      onSelectionChange(range);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      anchor.current = key;
      onSelectionChange(next);
      return;
    }
    anchor.current = key;
    onSelectionChange(new Set([key]));
  }

  function onKeyDown(e: KeyboardEvent) {
    if (sorted.length === 0) return;
    const keys = sorted.map((r) => r.key);
    const current = anchor.current && keys.includes(anchor.current) ? keys.indexOf(anchor.current) : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(keys.length - 1, Math.max(0, current + (e.key === "ArrowDown" ? 1 : -1)));
      anchor.current = keys[next];
      onSelectionChange(new Set([keys[next]]));
      ensureVisible(next);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const i = e.key === "Home" ? 0 : keys.length - 1;
      anchor.current = keys[i];
      onSelectionChange(new Set([keys[i]]));
      ensureVisible(i);
    } else if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSelectionChange(new Set(keys));
    } else if (e.key === "Enter" && !e.altKey && selected.size === 1) {
      e.preventDefault();
      onOpen([...selected][0]);
    }
  }

  function headerClick(col: string) {
    setSort((s) => (s.col === col ? { col, dir: (s.dir * -1) as 1 | -1 } : { col, dir: 1 }));
  }

  const widths = columns.map((c) => custom[c.id] ?? c.width);
  const template = widths.map((w) => `${w}px`).join(" ") + " minmax(0, 1fr)";
  // Rows have a 2px margin each side (.fl-row).
  const contentW = widths.reduce((a, b) => a + b, 0) + 4;

  function setWidth(id: string, w: number, save: boolean) {
    setCustom((c) => {
      const next = { ...c, [id]: clampW(w) };
      if (save) saveWidths(storageKey, next);
      return next;
    });
  }

  /** Drag on a header cell's right edge. */
  function startResize(e: PointerEvent<HTMLSpanElement>, id: string, startW: number) {
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
      if (w !== startW) setWidth(id, w, true);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  /** Double-click on a header cell's edge: as wide as its widest visible cell. */
  function fitColumn(index: number) {
    const nth = `:scope > :nth-child(${index + 1})`;
    let w = 0;
    const head = headerRef.current?.querySelector<HTMLElement>(nth);
    if (head) w = head.scrollWidth;
    bodyRef.current?.querySelectorAll<HTMLElement>(".fl-row").forEach((row) => {
      const cell = row.querySelector<HTMLElement>(nth);
      if (cell) w = Math.max(w, cell.scrollWidth);
    });
    if (w > 0) setWidth(columns[index].id, w + 2, true);
  }

  function resetWidths() {
    setCustom({});
    saveWidths(storageKey, {});
  }
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(sorted.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const visible = sorted.slice(first, last);

  return (
    <div className="file-list" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="fl-header-wrap" ref={headWrapRef}>
      <div
        className="fl-header"
        ref={headerRef}
        style={{ gridTemplateColumns: template, minWidth: contentW + scrollbarW }}
        onContextMenu={(e) => {
          e.preventDefault();
          setHeadMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {columns.map((c, i) => (
          <button
            key={c.id}
            className={`fl-head-cell ${c.align === "right" ? "right" : ""}`}
            onClick={() => headerClick(c.id)}
          >
            {c.label}
            {sort.col === c.id && <span className="sort-arrow">{sort.dir === 1 ? "▲" : "▼"}</span>}
            <span
              className="fl-resizer"
              title="Drag to resize, double-click to fit"
              onPointerDown={(e) => startResize(e, c.id, widths[i])}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                fitColumn(i);
              }}
            />
          </button>
        ))}
        <span className="fl-head-cell filler" />
      </div>
      </div>
      {headMenu && (
        <ContextMenu
          x={headMenu.x}
          y={headMenu.y}
          items={[{ label: "Reset column widths", onClick: resetWidths, disabled: Object.keys(custom).length === 0 }]}
          onClose={() => setHeadMenu(null)}
        />
      )}
      <div
        className="fl-body"
        ref={bodyRef}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          if (headWrapRef.current) headWrapRef.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const row = (e.target as HTMLElement).closest<HTMLElement>(".fl-row");
          const key = row?.dataset.key ?? null;
          if (key === null) onSelectionChange(new Set());
          else if (!selected.has(key)) {
            anchor.current = key;
            onSelectionChange(new Set([key]));
          }
          onContextMenu?.(key, e.clientX, e.clientY);
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("fl-canvas")) {
            onSelectionChange(new Set());
          }
        }}
      >
        {sorted.length === 0 && <div className="empty-note">{emptyText}</div>}
        <div className="fl-canvas" style={{ height: sorted.length * ROW_H, minWidth: contentW, position: "relative" }}>
        {visible.map((r, i) => (
          <div
            key={r.key}
            data-key={r.key}
            className={`fl-row ${selected.has(r.key) ? "selected" : ""} ${r.dimmed ? "dimmed" : ""}`}
            style={{ gridTemplateColumns: template, position: "absolute", top: (first + i) * ROW_H, left: 0, right: 0 }}
            onClick={(e) => clickRow(e, r.key)}
            onDoubleClick={() => onOpen(r.key)}
          >
            {columns.map((c, i) => (
              <span key={c.id} className={`fl-cell ${c.align === "right" ? "right" : ""}`}>
                {i === 0 && <span className="fl-icon">{r.icon}</span>}
                {r.cells[c.id]?.text ?? ""}
              </span>
            ))}
          </div>
        ))}
        </div>
      </div>
    </div>
  );
}
