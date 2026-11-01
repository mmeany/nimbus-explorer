// Scan / Query form, results grid (one page at a time with Load more) and the
// selected item as a tree.
import { useMemo, useState, type ReactNode } from "react";
import type { AppError } from "../../api/core";
import { ddbApi, type KeyDef, type ReadRequest, type TableInfo } from "../../api/dynamo";
import { ResultsGrid } from "../../components/ResultsGrid";
import { ValueView } from "../../components/ValueView";
import type { Shell } from "../../shell/shell";
import {
  condition,
  FILTER_OPS,
  fromPlain,
  itemToPlain,
  Placeholders,
  typedValue,
  type DdbItem,
  type FilterOp,
  type SortOp,
} from "../../util/ddbJson";

export const PAGE_SIZE = 100;

export interface FilterRow {
  attr: string;
  op: FilterOp;
  type: string;
  a: string;
  b: string;
}

export interface QueryForm {
  query: boolean;
  /** "" = the table itself. */
  index: string;
  pk: string;
  skOp: SortOp;
  skA: string;
  skB: string;
  rawFilter: boolean;
  filters: FilterRow[];
  rawExpression: string;
  rawNames: string;
  rawValues: string;
  projection: string;
  forward: boolean;
  consistent: boolean;
}

export const EMPTY_FORM: QueryForm = {
  query: false,
  index: "",
  pk: "",
  skOp: "",
  skA: "",
  skB: "",
  rawFilter: false,
  filters: [],
  rawExpression: "",
  rawNames: "",
  rawValues: "",
  projection: "",
  forward: true,
  consistent: false,
};

/** Keys of the table or the chosen index. */
export function keysFor(t: TableInfo, index: string): { pk: KeyDef | null; sk: KeyDef | null } {
  const i = t.indexes.find((x) => x.name === index);
  return i ? { pk: i.partitionKey, sk: i.sortKey } : { pk: t.partitionKey, sk: t.sortKey };
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`${what}: ${(e as Error).message}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} must be a JSON object`);
  return v as Record<string, unknown>;
}

/** Turns the form into a ReadRequest (throws with a readable message). */
export function buildRequest(t: TableInfo, f: QueryForm): ReadRequest {
  const p = new Placeholders();
  const { pk, sk } = keysFor(t, f.index);
  let keyCondition: string | null = null;
  if (f.query) {
    if (!pk) throw new Error("This table has no partition key");
    if (!f.pk.trim() && pk.attrType !== "S") throw new Error(`Enter a value for ${pk.name}`);
    keyCondition = condition(p, pk.name, "=", typedValue(f.pk, pk.attrType), null);
    if (f.skOp && sk) {
      const a = typedValue(f.skA, sk.attrType);
      const b = f.skOp === "between" ? typedValue(f.skB, sk.attrType) : null;
      keyCondition += " AND " + condition(p, sk.name, f.skOp, a, b);
    }
  }
  let filter: string | null = null;
  if (f.rawFilter) {
    filter = f.rawExpression.trim() || null;
    for (const [k, v] of Object.entries(parseJsonObject(f.rawNames, "Names"))) {
      if (!k.startsWith("#")) throw new Error(`Name placeholder "${k}" must start with #`);
      p.names[k] = String(v);
    }
    for (const [k, v] of Object.entries(parseJsonObject(f.rawValues, "Values"))) {
      if (!k.startsWith(":")) throw new Error(`Value placeholder "${k}" must start with :`);
      p.values[k] = fromPlain(v, k);
    }
  } else if (f.filters.length) {
    filter = f.filters
      .map((r) => {
        if (!r.attr.trim()) throw new Error("Every filter row needs an attribute name");
        const op = FILTER_OPS.find((o) => o.id === r.op)!;
        const a = op.values >= 1 ? typedValue(r.a, r.type) : null;
        const b = op.values === 2 ? typedValue(r.b, r.type) : null;
        return condition(p, r.attr.trim(), r.op, a, b);
      })
      .join(" AND ");
  }
  const projection = f.projection.trim()
    ? f.projection
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => p.name(s))
        .join(", ")
    : null;
  return {
    table: t.name,
    index: f.index || null,
    query: f.query,
    keyCondition,
    filter,
    projection,
    names: p.names,
    values: p.values,
    forward: f.forward,
    limit: PAGE_SIZE,
    consistent: f.consistent && !f.index,
  };
}

interface Props {
  table: TableInfo;
  shell: Shell;
  /** Extra toolbar actions / item actions supplied by the controller (3.3+). */
  renderActions?: (ctx: ItemsContext) => ReactNode;
  onOpenItem?: (item: DdbItem, ctx: ItemsContext) => void;
  onContextMenu?: (index: number | null, x: number, y: number, ctx: ItemsContext) => void;
  onDeleteKey?: (ctx: ItemsContext) => void;
}

/** What the controller can see and do with the current results. */
export interface ItemsContext {
  items: DdbItem[];
  selected: number[];
  /** Re-run the current read from the first page. */
  rerun: () => void;
  /** Replace / remove items locally after a write. */
  setItems: (f: (items: DdbItem[]) => DdbItem[]) => void;
  request: ReadRequest | null;
}

export function ItemsTab({ table, shell, renderActions, onOpenItem, onContextMenu, onDeleteKey }: Props) {
  const [f, setF] = useState<QueryForm>(() => ({ ...EMPTY_FORM, query: false }));
  const [items, setItems] = useState<DdbItem[] | null>(null);
  const [request, setRequest] = useState<ReadRequest | null>(null);
  const [lastKey, setLastKey] = useState<DdbItem | null>(null);
  const [stats, setStats] = useState({ pages: 0, scanned: 0, consumed: 0 });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [focused, setFocused] = useState<number | null>(null);
  const [showDdb, setShowDdb] = useState(false);
  const [total, setTotal] = useState<number | "counting" | null>(null);
  const set = (patch: Partial<QueryForm>) => setF((x) => ({ ...x, ...patch }));

  const { pk, sk } = keysFor(table, f.index);
  const keyAttrs = useMemo(() => {
    const out = [table.partitionKey?.name, table.sortKey?.name, pk?.name, sk?.name].filter((x): x is string => !!x);
    return [...new Set(out)];
  }, [table, pk, sk]);

  async function run(more: boolean) {
    let req: ReadRequest;
    try {
      req = more && request ? { ...request, startKey: lastKey } : buildRequest(table, f);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setError(null);
    setRunning(true);
    try {
      const page = await ddbApi.readPage(req);
      setRequest({ ...req, startKey: null });
      setLastKey(page.lastKey);
      if (more) {
        setItems((xs) => [...(xs ?? []), ...page.items]);
        setStats((s) => ({ pages: s.pages + 1, scanned: s.scanned + page.scannedCount, consumed: s.consumed + (page.consumedCapacity ?? 0) }));
      } else {
        setItems(page.items);
        setSelected(new Set());
        setFocused(page.items.length ? 0 : null);
        setTotal(null);
        setStats({ pages: 1, scanned: page.scannedCount, consumed: page.consumedCapacity ?? 0 });
      }
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setRunning(false);
    }
  }

  async function countAll() {
    if (!request) return;
    setTotal("counting");
    try {
      setTotal(await ddbApi.count(request));
    } catch (e) {
      setTotal(null);
      shell.showError(e);
    }
  }

  const ctx: ItemsContext = {
    items: items ?? [],
    selected: [...selected].sort((a, b) => a - b),
    rerun: () => void run(false),
    setItems: (fn) => setItems((xs) => fn(xs ?? [])),
    request,
  };

  const cur = items && focused !== null ? items[focused] : null;
  const indexOptions = table.indexes;

  return (
    <div className="items-tab">
      <div className="qf">
        <div className="row qf-row">
          <div className="segmented small">
            <button className={!f.query ? "active" : ""} onClick={() => set({ query: false })}>
              Scan
            </button>
            <button className={f.query ? "active" : ""} onClick={() => set({ query: true })}>
              Query
            </button>
          </div>
          <select className="text-input" value={f.index} onChange={(e) => set({ index: e.target.value, skOp: "" })} title="Table or index">
            <option value="">Table: {table.name}</option>
            {indexOptions.map((i) => (
              <option key={i.name} value={i.name}>
                {i.kind}: {i.name}
              </option>
            ))}
          </select>
          {f.query && (
            <select className="text-input" value={f.forward ? "asc" : "desc"} onChange={(e) => set({ forward: e.target.value === "asc" })} title="Sort key order">
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          )}
          <label className="check-row" title={f.index ? "Not available on global secondary indexes" : "Strongly consistent read (uses twice the read capacity)"}>
            <input type="checkbox" checked={f.consistent && !f.index} disabled={!!f.index} onChange={(e) => set({ consistent: e.target.checked })} /> Consistent
          </label>
        </div>

        {f.query && pk && (
          <div className="row qf-row">
            <span className="qf-label mono">{pk.name}</span>
            <span className="hint">=</span>
            <input className="text-input qf-val" value={f.pk} placeholder={`${pk.attrType === "N" ? "number" : pk.attrType === "B" ? "base64" : "value"}`} onChange={(e) => set({ pk: e.target.value })} onKeyDown={(e) => e.key === "Enter" && void run(false)} />
            {sk && (
              <>
                <span className="qf-label mono">{sk.name}</span>
                <select className="text-input" value={f.skOp} onChange={(e) => set({ skOp: e.target.value as SortOp })}>
                  <option value="">(any)</option>
                  {(["=", "<", "<=", ">", ">=", "between", "begins_with"] as SortOp[]).map((o) => (
                    <option key={o} value={o}>
                      {o === "begins_with" ? "begins with" : o}
                    </option>
                  ))}
                </select>
                {f.skOp && <input className="text-input qf-val" value={f.skA} onChange={(e) => set({ skA: e.target.value })} onKeyDown={(e) => e.key === "Enter" && void run(false)} />}
                {f.skOp === "between" && (
                  <>
                    <span className="hint">and</span>
                    <input className="text-input qf-val" value={f.skB} onChange={(e) => set({ skB: e.target.value })} />
                  </>
                )}
              </>
            )}
          </div>
        )}

        <div className="row qf-row">
          <span className="form-label">Filter</span>
          <label className="check-row">
            <input type="checkbox" checked={f.rawFilter} onChange={(e) => set({ rawFilter: e.target.checked })} /> Expression
          </label>
          {!f.rawFilter && (
            <button className="link-btn" onClick={() => set({ filters: [...f.filters, { attr: "", op: "=", type: "S", a: "", b: "" }] })}>
              + Add condition
            </button>
          )}
          <div className="spacer" />
          <span className="form-label">Attributes</span>
          <input className="text-input qf-proj mono" value={f.projection} placeholder="all (or e.g. id, name, address.city)" onChange={(e) => set({ projection: e.target.value })} />
        </div>
        {f.rawFilter ? (
          <div className="qf-raw">
            <input className="text-input mono" value={f.rawExpression} placeholder="#s = :open AND total > :min" onChange={(e) => set({ rawExpression: e.target.value })} />
            <div className="row">
              <input className="text-input mono" value={f.rawNames} placeholder='Names: {"#s": "status"}' onChange={(e) => set({ rawNames: e.target.value })} />
              <input className="text-input mono" value={f.rawValues} placeholder='Values (plain JSON): {":open": "open", ":min": 10}' onChange={(e) => set({ rawValues: e.target.value })} />
            </div>
          </div>
        ) : (
          f.filters.map((r, i) => {
            const op = FILTER_OPS.find((o) => o.id === r.op)!;
            const upd = (patch: Partial<FilterRow>) => set({ filters: f.filters.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div className="row qf-row" key={i}>
                <input className="text-input qf-attr mono" value={r.attr} placeholder="attribute (a.b for nested)" onChange={(e) => upd({ attr: e.target.value })} />
                <select className="text-input" value={r.op} onChange={(e) => upd({ op: e.target.value as FilterOp })}>
                  {FILTER_OPS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {op.values >= 1 && (
                  <>
                    <select className="text-input" value={r.type} onChange={(e) => upd({ type: e.target.value })} title="Value type">
                      <option value="S">String</option>
                      <option value="N">Number</option>
                      <option value="BOOL">Boolean</option>
                      <option value="NULL">Null</option>
                    </select>
                    {r.type !== "NULL" && <input className="text-input qf-val" value={r.a} onChange={(e) => upd({ a: e.target.value })} />}
                  </>
                )}
                {op.values === 2 && (
                  <>
                    <span className="hint">and</span>
                    <input className="text-input qf-val" value={r.b} onChange={(e) => upd({ b: e.target.value })} />
                  </>
                )}
                <button className="link-btn" onClick={() => set({ filters: f.filters.filter((_, j) => j !== i) })}>
                  Remove
                </button>
              </div>
            );
          })
        )}
        <div className="row qf-row">
          <button className="btn primary" disabled={running} onClick={() => void run(false)}>
            {running && !items ? "Running…" : f.query ? "Run query" : "Run scan"}
          </button>
          <button className="btn" disabled={running || !lastKey} onClick={() => void run(true)}>
            Load more
          </button>
          <button className="btn" disabled={running || !request || total === "counting"} onClick={() => void countAll()} title="Count every matching item (reads the whole range)">
            Count all
          </button>
          <button
            className="link-btn"
            onClick={() => {
              setF({ ...EMPTY_FORM, query: f.query });
              setError(null);
            }}
          >
            Reset
          </button>
          <div className="spacer" />
          {renderActions?.(ctx)}
        </div>
        {error && <div className="field-error">{error}</div>}
      </div>

      {items && (
        <div className="row qf-stats hint">
          {items.length.toLocaleString()} item{items.length === 1 ? "" : "s"} · {stats.scanned.toLocaleString()} read in {stats.pages} page
          {stats.pages === 1 ? "" : "s"} · {stats.consumed.toLocaleString(undefined, { maximumFractionDigits: 1 })} capacity units
          {lastKey ? " · more available" : " · end of results"}
          {total === "counting" ? " · counting…" : total !== null ? ` · ${total.toLocaleString()} match in total` : ""}
          {selected.size > 1 ? ` · ${selected.size} selected` : ""}
        </div>
      )}

      <div className="items-split">
        <div className="items-grid-pane">
          {items ? (
            items.length ? (
              <ResultsGrid
                items={items}
                keyAttrs={keyAttrs}
                selected={selected}
                onSelectionChange={(s, i) => {
                  setSelected(s);
                  if (i !== null) setFocused(i);
                }}
                onOpen={(i) => onOpenItem?.(items[i], ctx)}
                onContextMenu={(i, x, y) => onContextMenu?.(i, x, y, ctx)}
                onDeleteKey={() => selected.size && onDeleteKey?.(ctx)}
              />
            ) : (
              <div className="empty-note">No items {lastKey ? "on this page (filters run after reading); try Load more" : "matched"}.</div>
            )
          ) : (
            <div className="empty-note">Run a scan or query to see items. Results come {PAGE_SIZE} at a time.</div>
          )}
        </div>
        {cur && (
          <div className="item-pane">
            <div className="row">
              <span className="form-label">Item</span>
              <div className="spacer" />
              <label className="check-row">
                <input type="checkbox" checked={showDdb} onChange={(e) => setShowDdb(e.target.checked)} /> DynamoDB JSON
              </label>
              <button className="link-btn" onClick={() => void shell.copyText(JSON.stringify(showDdb ? cur : itemToPlain(cur), null, 2))}>
                Copy
              </button>
            </div>
            <ValueView key={`${focused}-${showDdb}`} value={JSON.stringify(showDdb ? cur : itemToPlain(cur), null, 2)} />
          </div>
        )}
      </div>
    </div>
  );
}
