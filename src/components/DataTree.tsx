import { memo, useCallback, useMemo, useState } from "react";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface Props {
  value: unknown;
  /** Label for the root node. */
  rootName?: string;
  /** Labels for the root array's items (e.g. CSV "Row 1"); default is the index. */
  rootItemLabel?: (index: number) => string;
  /** Levels expanded initially. */
  initialDepth?: number;
}

/** Children shown per node before a "Show more" row (keeps huge arrays responsive). */
const CHUNK = 200;
/** Above this many nodes, "Expand all" is disabled. */
const EXPAND_ALL_LIMIT = 20_000;

const isContainer = (v: unknown): v is Json[] | Record<string, Json> => typeof v === "object" && v !== null;

function countNodes(v: unknown, limit: number): number {
  let n = 0;
  const stack: unknown[] = [v];
  while (stack.length && n <= limit) {
    const x = stack.pop();
    n++;
    if (Array.isArray(x)) stack.push(...x);
    else if (isContainer(x)) stack.push(...Object.values(x));
  }
  return n;
}

const childPath = (parent: string, key: string, isArray: boolean) =>
  isArray ? `${parent}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;

interface Ctx {
  isOpen: (path: string, depth: number) => boolean;
  toggle: (path: string, depth: number) => void;
  shown: (path: string) => number;
  showMore: (path: string) => void;
  rootItemLabel?: (index: number) => string;
}

/** Collapsible tree for JSON-like data (JSON, YAML, CSV records). */
export function DataTree({ value, rootName = "root", rootItemLabel, initialDepth = 2 }: Props) {
  const [depthLimit, setDepthLimit] = useState(initialDepth);
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [limits, setLimits] = useState<Map<string, number>>(new Map());
  const total = useMemo(() => countNodes(value, EXPAND_ALL_LIMIT), [value]);

  const isOpen = useCallback(
    (path: string, depth: number) => overrides.get(path) ?? depth < depthLimit,
    [overrides, depthLimit],
  );
  const toggle = useCallback(
    (path: string, depth: number) =>
      setOverrides((m) => new Map(m).set(path, !(m.get(path) ?? depth < depthLimit))),
    [depthLimit],
  );
  const shown = useCallback((path: string) => limits.get(path) ?? CHUNK, [limits]);
  const showMore = useCallback(
    (path: string) => setLimits((m) => new Map(m).set(path, (m.get(path) ?? CHUNK) + CHUNK * 5)),
    [],
  );

  const setLevel = (d: number) => {
    setDepthLimit(d);
    setOverrides(new Map());
  };

  const ctx: Ctx = { isOpen, toggle, shown, showMore, rootItemLabel };

  return (
    <div className="data-tree">
      <div className="dt-toolbar">
        <button className="link-btn" onClick={() => setLevel(Infinity)} disabled={total > EXPAND_ALL_LIMIT}
          title={total > EXPAND_ALL_LIMIT ? "Too large to expand everything at once; expand branches individually" : "Expand everything"}>
          Expand all
        </button>
        <button className="link-btn" onClick={() => setLevel(1)}>
          Collapse all
        </button>
        <span className="dt-sep">Expand to level:</span>
        {[1, 2, 3, 4].map((d) => (
          <button key={d} className="link-btn" onClick={() => setLevel(d + 1)}>
            {d}
          </button>
        ))}
        <div className="spacer" />
        <span className="muted-note">
          {total > EXPAND_ALL_LIMIT ? `more than ${EXPAND_ALL_LIMIT.toLocaleString()}` : total.toLocaleString()} nodes
        </span>
      </div>
      <div className="dt-body">
        <Node name={rootName} value={value as Json} path="$" depth={0} ctx={ctx} isRoot />
      </div>
    </div>
  );
}

interface NodeProps {
  name: string;
  value: Json;
  path: string;
  depth: number;
  ctx: Ctx;
  isRoot?: boolean;
  isIndex?: boolean;
}

const Node = memo(function Node({ name, value, path, depth, ctx, isRoot, isIndex }: NodeProps) {
  const container = isContainer(value);
  const open = container && ctx.isOpen(path, depth);
  const pad = { paddingLeft: depth * 16 + 4 };

  const label = (
    <span className={`dt-key ${isIndex ? "index" : ""} ${isRoot ? "root" : ""}`}>
      {name}
      {!isRoot && <span className="dt-colon">:</span>}
    </span>
  );

  if (!container) {
    return (
      <div className="dt-row" style={pad} title={path}>
        <span className="twisty" />
        {label} <Scalar value={value} />
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: [string, Json][] = isArray
    ? (value as Json[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, Json>);
  const summary = isArray
    ? `[ ${entries.length.toLocaleString()} item${entries.length === 1 ? "" : "s"} ]`
    : `{ ${entries.length.toLocaleString()} key${entries.length === 1 ? "" : "s"} }`;
  const limit = ctx.shown(path);

  return (
    <>
      <div className="dt-row container" style={pad} title={path} onClick={() => entries.length && ctx.toggle(path, depth)}>
        <span className="twisty">{entries.length ? (open ? "▾" : "▸") : ""}</span>
        {label} <span className="dt-summary">{summary}</span>
      </div>
      {open &&
        entries.slice(0, limit).map(([k, v]) => (
          <Node
            key={k}
            name={isArray && isRoot && ctx.rootItemLabel ? ctx.rootItemLabel(Number(k)) : k}
            value={v}
            path={childPath(path, k, isArray)}
            depth={depth + 1}
            ctx={ctx}
            isIndex={isArray}
          />
        ))}
      {open && entries.length > limit && (
        <div className="dt-row" style={{ paddingLeft: (depth + 1) * 16 + 22 }}>
          <button className="link-btn" onClick={() => ctx.showMore(path)}>
            Show more ({(entries.length - limit).toLocaleString()} remaining)
          </button>
        </div>
      )}
    </>
  );
});

function Scalar({ value }: { value: Json }) {
  if (value === null) return <span className="dt-null">null</span>;
  switch (typeof value) {
    case "string":
      return <span className="dt-string">"{value}"</span>;
    case "number":
      return <span className="dt-number">{String(value)}</span>;
    case "boolean":
      return <span className="dt-bool">{String(value)}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}
