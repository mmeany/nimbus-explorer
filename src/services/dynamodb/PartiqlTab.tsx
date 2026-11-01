// PartiQL editor: statement + ? parameters, paged results, history per profile.
import { useEffect, useState } from "react";
import type { AppError } from "../../api/core";
import { ddbApi, isSelect, tableKeyAttrs, type TableInfo } from "../../api/dynamo";
import { api } from "../../api/s3";
import { ResultsGrid } from "../../components/ResultsGrid";
import { ValueView } from "../../components/ValueView";
import type { Shell } from "../../shell/shell";
import { fromPlain, itemToPlain, type DdbItem } from "../../util/ddbJson";

interface Props {
  table: TableInfo;
  shell: Shell;
}

const PAGE = 100;

export function PartiqlTab({ table, shell }: Props) {
  const historyKey = `partiql|${shell.profile ?? ""}`;
  const [statement, setStatement] = useState(`SELECT * FROM "${table.name}"`);
  const [params, setParams] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [items, setItems] = useState<DdbItem[] | null>(null);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [last, setLast] = useState<{ statement: string; params: unknown[] } | null>(null);
  const [consumed, setConsumed] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [focused, setFocused] = useState<number | null>(null);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => setHistory(s.filterHistory?.[historyKey] ?? []))
      .catch(() => setHistory([]));
  }, [historyKey]);

  const blocked = shell.readOnly && !isSelect(statement);

  async function run(more: boolean) {
    let stmt = statement.trim();
    let parameters: unknown[];
    if (more && last) {
      stmt = last.statement;
      parameters = last.params;
    } else {
      try {
        const p = params.trim() ? JSON.parse(params) : [];
        if (!Array.isArray(p)) throw new Error("Parameters must be a JSON array, e.g. [\"c1\", 42]");
        parameters = p.map((v, i) => fromPlain(v, `parameter ${i + 1}`));
      } catch (e) {
        setError((e as Error).message);
        return;
      }
    }
    if (!stmt) return;
    setRunning(true);
    setError(null);
    setMessage(null);
    try {
      const page = await ddbApi.execute(stmt, parameters as never, more ? nextToken : null, isSelect(stmt) ? PAGE : null);
      setNextToken(page.nextToken);
      if (more) {
        setItems((xs) => [...(xs ?? []), ...page.items]);
        setConsumed((c) => c + (page.consumedCapacity ?? 0));
      } else {
        setLast({ statement: stmt, params: parameters });
        setItems(isSelect(stmt) ? page.items : null);
        setSelected(new Set());
        setFocused(page.items.length ? 0 : null);
        setConsumed(page.consumedCapacity ?? 0);
        if (!isSelect(stmt)) setMessage("Statement ran.");
        try {
          setHistory(await api.rememberFilter(historyKey, stmt));
        } catch {
          /* history is a convenience */
        }
      }
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setRunning(false);
    }
  }

  const cur = items && focused !== null ? items[focused] : null;

  return (
    <div className="items-tab">
      <div className="qf">
        <textarea
          className="text-input mono value-textarea pql-text"
          rows={5}
          value={statement}
          spellCheck={false}
          onChange={(e) => setStatement(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              if (!blocked) void run(false);
            }
          }}
        />
        <div className="row qf-row">
          <span className="form-label">Parameters</span>
          <input className="text-input mono pql-params" value={params} placeholder='Values for ?, as a JSON array: ["c1", 42]' onChange={(e) => setParams(e.target.value)} />
          <select
            className="text-input pql-history"
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__clear") void api.forgetFilter(historyKey, null).then(setHistory);
              else if (v) setStatement(v);
            }}
          >
            <option value="">History ({history.length})</option>
            {history.map((h) => (
              <option key={h} value={h}>
                {h.replace(/\s+/g, " ").slice(0, 90)}
              </option>
            ))}
            {history.length > 0 && <option value="__clear">Clear history</option>}
          </select>
        </div>
        <div className="row qf-row">
          <button className="btn primary" disabled={running || blocked || !statement.trim()} onClick={() => void run(false)} title="Ctrl+Enter">
            {running ? "Running…" : "Run"}
          </button>
          <button className="btn" disabled={running || !nextToken} onClick={() => void run(true)}>
            Load more
          </button>
          {blocked && <span className="hint danger-text">Read-only mode: only SELECT statements run.</span>}
          <span className="hint">Use "double quotes" for table and attribute names and 'single quotes' for strings.</span>
        </div>
        {error && <div className="field-error">{error}</div>}
        {message && <div className="ok-note">{message}</div>}
      </div>
      {items && (
        <div className="row qf-stats hint">
          {items.length.toLocaleString()} item{items.length === 1 ? "" : "s"} · {consumed.toLocaleString(undefined, { maximumFractionDigits: 1 })} capacity units
          {nextToken ? " · more available" : " · end of results"}
        </div>
      )}
      <div className="items-split">
        <div className="items-grid-pane">
          {items ? (
            items.length ? (
              <ResultsGrid
                items={items}
                keyAttrs={tableKeyAttrs(table)}
                selected={selected}
                onSelectionChange={(s, i) => {
                  setSelected(s);
                  if (i !== null) setFocused(i);
                }}
              />
            ) : (
              <div className="empty-note">No items{nextToken ? " on this page; try Load more" : ""}.</div>
            )
          ) : (
            <div className="empty-note">Write a statement and press Run (Ctrl+Enter). SELECT results come {PAGE} at a time.</div>
          )}
        </div>
        {cur && (
          <div className="item-pane">
            <div className="row">
              <span className="form-label">Item</span>
              <div className="spacer" />
              <button className="link-btn" onClick={() => void shell.copyText(JSON.stringify(itemToPlain(cur), null, 2))}>
                Copy
              </button>
            </div>
            <ValueView key={focused} value={JSON.stringify(itemToPlain(cur), null, 2)} />
          </div>
        )}
      </div>
    </div>
  );
}
