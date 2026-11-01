// Wide results grid for DynamoDB items: dynamic columns (keys first, then
// attributes in order of first appearance), horizontal scroll, sortable,
// Explorer-style selection.
import { useMemo, useRef, useState, type MouseEvent } from "react";
import { cellText, ddbType, type DdbItem } from "../util/ddbJson";

interface Props {
  items: DdbItem[];
  /** Key attributes, shown first and highlighted. */
  keyAttrs: string[];
  selected: Set<number>;
  onSelectionChange: (s: Set<number>, focused: number | null) => void;
  onOpen?: (index: number) => void;
  onContextMenu?: (index: number | null, x: number, y: number) => void;
  /** Del pressed with a selection. */
  onDeleteKey?: () => void;
  /** Most attribute columns shown (the item view shows everything). */
  maxColumns?: number;
}

type Sort = { col: string; dir: 1 | -1 } | null;

function sortValue(item: DdbItem, col: string): string | number {
  const v = item[col];
  if (!v) return "";
  return ddbType(v) === "N" ? Number(Object.values(v)[0]) : cellText(v);
}

export function ResultsGrid({ items, keyAttrs, selected, onSelectionChange, onOpen, onContextMenu, onDeleteKey, maxColumns = 60 }: Props) {
  const [sort, setSort] = useState<Sort>(null);
  const anchor = useRef<number | null>(null);

  const columns = useMemo(() => {
    const seen = new Set<string>(keyAttrs);
    const rest: string[] = [];
    for (const it of items) {
      for (const k of Object.keys(it)) {
        if (!seen.has(k)) {
          seen.add(k);
          rest.push(k);
        }
      }
    }
    const keys = keyAttrs.filter((k) => items.some((i) => k in i) || items.length === 0);
    return { list: [...keys, ...rest.slice(0, maxColumns)], hidden: Math.max(0, rest.length - maxColumns) };
  }, [items, keyAttrs, maxColumns]);

  // Display order: indices into `items`.
  const order = useMemo(() => {
    const idx = items.map((_, i) => i);
    if (!sort) return idx;
    return idx.sort((a, b) => {
      const x = sortValue(items[a], sort.col);
      const y = sortValue(items[b], sort.col);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [items, sort]);

  function click(e: MouseEvent, i: number) {
    if (e.shiftKey && anchor.current !== null) {
      const a = order.indexOf(anchor.current);
      const b = order.indexOf(i);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      onSelectionChange(new Set(order.slice(lo, hi + 1)), i);
    } else if (e.ctrlKey || e.metaKey) {
      const s = new Set(selected);
      if (s.has(i)) s.delete(i);
      else s.add(i);
      anchor.current = i;
      onSelectionChange(s, i);
    } else {
      anchor.current = i;
      onSelectionChange(new Set([i]), i);
    }
  }

  return (
    <div
      className="results-grid"
      tabIndex={0}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("tr[data-row]")) return;
        e.preventDefault();
        onContextMenu?.(null, e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "a") {
          e.preventDefault();
          onSelectionChange(new Set(order), null);
        } else if (e.key === "Delete" && selected.size) {
          e.preventDefault();
          onDeleteKey?.();
        } else if (e.key === "Enter" && selected.size === 1) {
          e.preventDefault();
          onOpen?.([...selected][0]);
        }
      }}
    >
      <table>
        <thead>
          <tr>
            <th className="rg-num">#</th>
            {columns.list.map((c) => (
              <th
                key={c}
                className={keyAttrs.includes(c) ? "rg-key" : ""}
                onClick={() => setSort((s) => (s?.col === c ? (s.dir === 1 ? { col: c, dir: -1 } : null) : { col: c, dir: 1 }))}
                title={keyAttrs.includes(c) ? `${c} (key)` : c}
              >
                {c}
                {sort?.col === c ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
              </th>
            ))}
            {columns.hidden > 0 && <th className="hint">+{columns.hidden} more</th>}
          </tr>
        </thead>
        <tbody>
          {order.map((i, row) => {
            const it = items[i];
            return (
              <tr
                key={i}
                data-row
                className={selected.has(i) ? "selected" : ""}
                onClick={(e) => click(e, i)}
                onDoubleClick={() => onOpen?.(i)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!selected.has(i)) onSelectionChange(new Set([i]), i);
                  onContextMenu?.(i, e.clientX, e.clientY);
                }}
              >
                <td className="rg-num">{row + 1}</td>
                {columns.list.map((c) => {
                  const v = it[c];
                  const t = ddbType(v);
                  return (
                    <td key={c} className={`rg-t-${t}${keyAttrs.includes(c) ? " rg-key" : ""}`} title={v ? `${t}: ${cellText(v)}` : "(not set)"}>
                      {cellText(v)}
                    </td>
                  );
                })}
                {columns.hidden > 0 && <td />}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
