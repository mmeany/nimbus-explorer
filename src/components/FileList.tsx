import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

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
}

type Sort = { col: string; dir: 1 | -1 };

/** Row height in px; must match .fl-row in styles.css. */
const ROW_H = 22;
/** Extra rows rendered above/below the viewport. */
const OVERSCAN = 12;

/** Details-view list with sortable columns and Explorer-style selection. */
export function FileList({ columns, rows, selected, onSelectionChange, onOpen, onContextMenu, onOrderChange, emptyText, initialSort }: Props) {
  const [sort, setSort] = useState<Sort>(initialSort ?? { col: columns[0].id, dir: 1 });
  const anchor = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Virtualisation: only rows near the viewport are in the DOM.
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
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

  const template = columns.map((c) => `${c.width}px`).join(" ") + " 1fr";
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(sorted.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const visible = sorted.slice(first, last);

  return (
    <div className="file-list" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="fl-header" style={{ gridTemplateColumns: template }}>
        {columns.map((c) => (
          <button
            key={c.id}
            className={`fl-head-cell ${c.align === "right" ? "right" : ""}`}
            onClick={() => headerClick(c.id)}
          >
            {c.label}
            {sort.col === c.id && <span className="sort-arrow">{sort.dir === 1 ? "▲" : "▼"}</span>}
          </button>
        ))}
        <span className="fl-head-cell filler" />
      </div>
      <div
        className="fl-body"
        ref={bodyRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
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
        <div className="fl-canvas" style={{ height: sorted.length * ROW_H, position: "relative" }}>
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
