import type { MouseEvent, ReactNode } from "react";

export const TREE_INDENT = 16;

interface Props {
  depth: number;
  label: string;
  icon: ReactNode;
  selected?: boolean;
  /** true/false = expandable (open/closed); undefined = leaf (no twisty). */
  expanded?: boolean;
  title?: string;
  /** data-* attributes (e.g. drop targets). */
  data?: Record<string, string>;
  muted?: boolean;
  onClick?: () => void;
  onToggle?: () => void;
  onContextMenu?: (x: number, y: number) => void;
  children?: ReactNode;
}

/** One row of the folder tree (any service), plus its children when expanded. */
export function TreeRow({ depth, label, icon, selected, expanded, title, data, muted, onClick, onToggle, onContextMenu, children }: Props) {
  const dataAttrs = Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]));
  return (
    <div role="none">
      <div
        className={`tree-row ${selected ? "selected" : ""} ${muted ? "muted" : ""}`}
        style={{ paddingLeft: 4 + depth * TREE_INDENT }}
        role="treeitem"
        aria-expanded={expanded}
        aria-selected={selected}
        title={title}
        {...dataAttrs}
        onClick={onClick}
        onDoubleClick={() => expanded !== undefined && onToggle?.()}
        onContextMenu={(e: MouseEvent) => {
          if (!onContextMenu) return;
          e.preventDefault();
          onContextMenu(e.clientX, e.clientY);
        }}
      >
        <span
          className={`twisty ${expanded !== undefined ? "clickable" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            if (expanded !== undefined) onToggle?.();
          }}
        >
          {expanded === undefined ? "" : expanded ? "▾" : "▸"}
        </span>
        {icon}
        <span className="tree-label">{label}</span>
      </div>
      {expanded && children && <div role="group">{children}</div>}
    </div>
  );
}

/** Italic informational row inside the tree ("Loading…"). */
export function TreeNote({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <div className="tree-row muted" style={{ paddingLeft: 4 + depth * TREE_INDENT + 18 }}>
      {children}
    </div>
  );
}
