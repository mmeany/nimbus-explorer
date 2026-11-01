// The "SQL" tab for Aurora clusters with the Data API on: run one statement at
// a time with credentials from a Secrets Manager secret; results grid with
// paging, history and CSV / JSON export. Read-only runs are rolled back.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppError } from "../../api/core";
import { engineFamily, rdsApi, type DbCluster, type SqlResult } from "../../api/rds";
import { api } from "../../api/s3";
import { smApi } from "../../api/secrets";
import { PageBar } from "../../components/PageBar";
import type { Shell } from "../../shell/shell";
import { secretName } from "./ConnectTab";

const LIST_DATABASES = {
  postgres: "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname",
  mysql: "SHOW DATABASES",
};
const STARTER = {
  postgres: "SELECT table_schema, table_name\nFROM information_schema.tables\nWHERE table_schema NOT IN ('pg_catalog', 'information_schema')\nORDER BY 1, 2",
  mysql: "SELECT table_schema, table_name\nFROM information_schema.tables\nWHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')\nORDER BY 1, 2",
};

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export function SqlTab({ shell, cluster }: { shell: Shell; cluster: DbCluster }) {
  const family = engineFamily(cluster.engine) === "mysql" ? "mysql" : "postgres";
  const historyKey = `rdssql|${shell.profile ?? ""}|${cluster.id}`;
  const [secret, setSecret] = useState(cluster.masterSecretArn ?? "");
  const [secrets, setSecrets] = useState<{ name: string; arn: string }[]>([]);
  const [database, setDatabase] = useState(cluster.databaseName ?? (family === "postgres" ? "postgres" : ""));
  const [databases, setDatabases] = useState<string[]>([]);
  const [readOnlyRun, setReadOnlyRun] = useState(true);
  const [sql, setSql] = useState(STARTER[family]);
  const [history, setHistory] = useState<string[]>([]);
  const [result, setResult] = useState<{ sql: string; data: SqlResult } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [selRow, setSelRow] = useState<number | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const readOnly = shell.readOnly || readOnlyRun;

  useEffect(() => {
    api
      .getSettings()
      .then((s) => setHistory(s.filterHistory?.[historyKey] ?? []))
      .catch(() => setHistory([]));
  }, [historyKey]);

  // Secret suggestions: names only (values are never read here).
  useEffect(() => {
    let stale = false;
    smApi
      .list("")
      .then((list) => !stale && setSecrets(list.filter((s) => s.arn && !s.deletedDate).map((s) => ({ name: s.name, arn: s.arn! }))))
      .catch(() => !stale && setSecrets([]));
    return () => {
      stale = true;
    };
  }, [shell.connectionId]);

  async function execute(text: string, readOnlyFlag: boolean) {
    return rdsApi.executeSql({ clusterArn: cluster.arn, secretArn: secret.trim(), database: database.trim() || null, sql: text, family, readOnly: readOnlyFlag });
  }

  async function run(selectionOnly: boolean) {
    const ta = editor.current;
    const text = selectionOnly && ta && ta.selectionEnd > ta.selectionStart ? sql.slice(ta.selectionStart, ta.selectionEnd) : sql;
    if (!text.trim() || running) return;
    setRunning(true);
    setError(null);
    try {
      const data = await execute(text, readOnly);
      setResult({ sql: text.trim(), data });
      setPage(0);
      setSelRow(null);
      try {
        setHistory(await api.rememberFilter(historyKey, text.trim()));
      } catch {
        /* history is a convenience */
      }
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setRunning(false);
    }
  }

  async function listDatabases() {
    setError(null);
    try {
      const r = await execute(LIST_DATABASES[family], true);
      setDatabases(r.rows.map((row) => cellText(row[0])));
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    }
  }

  async function exportAs(format: "csv" | "json") {
    if (!result) return;
    try {
      const dest = await api.pickSaveFile(`${cluster.id}-result.${format}`);
      if (!dest) return;
      await rdsApi.saveResult(dest, result.data.columns, result.data.rows, format);
      shell.showFlash(`Saved ${result.data.rows.length.toLocaleString()} rows to ${dest}`);
    } catch (e) {
      shell.showError(e as AppError);
    }
  }

  const rows = result?.data.rows ?? [];
  const pageRows = useMemo(() => rows.slice(page * pageSize, (page + 1) * pageSize), [rows, page, pageSize]);
  const lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  const knownSecret = secrets.find((s) => s.arn === secret);

  return (
    <div className="sql-tab">
      <div className="pe-grid sql-conn">
        <label className="form-label" htmlFor="sql-secret">
          Credentials
        </label>
        <div className="row">
          <input
            id="sql-secret"
            className="text-input mono sql-secret"
            list="sql-secrets"
            value={secret}
            placeholder="Secrets Manager secret ARN"
            spellCheck={false}
            onChange={(e) => setSecret(e.target.value)}
          />
          <datalist id="sql-secrets">
            {secrets.map((s) => (
              <option key={s.arn} value={s.arn}>
                {s.name}
              </option>
            ))}
          </datalist>
          <span className="hint">
            {secret === cluster.masterSecretArn && secret
              ? "master user (managed by RDS)"
              : knownSecret
                ? knownSecret.name
                : secret
                  ? secretName(secret)
                  : "choose a secret with username and password"}
          </span>
        </div>
        <label className="form-label" htmlFor="sql-db">
          Database
        </label>
        <div className="row">
          <input id="sql-db" className="text-input mono sql-db" list="sql-dbs" value={database} spellCheck={false} onChange={(e) => setDatabase(e.target.value)} />
          <datalist id="sql-dbs">
            {databases.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          <button className="btn" disabled={!secret.trim()} onClick={() => void listDatabases()}>
            List databases
          </button>
          <label className="check-row inline">
            <input type="checkbox" checked={readOnly} disabled={shell.readOnly} onChange={(e) => setReadOnlyRun(e.target.checked)} /> Read only (rolled back)
          </label>
        </div>
      </div>
      <textarea
        ref={editor}
        className="text-input mono value-textarea sql-text"
        rows={7}
        value={sql}
        spellCheck={false}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            const ta = e.currentTarget;
            void run(ta.selectionEnd > ta.selectionStart);
          }
        }}
      />
      <div className="row qf-row">
        <button className="btn primary" disabled={running || !sql.trim() || !secret.trim()} title="Ctrl+Enter runs the selection, or everything" onClick={() => void run(false)}>
          {running ? "Running…" : "Run"}
        </button>
        <button className="btn" disabled={running || !secret.trim()} onClick={() => void run(true)}>
          Run selection
        </button>
        <select
          className="text-input pql-history"
          value=""
          aria-label="History"
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__clear") void api.forgetFilter(historyKey, null).then(setHistory);
            else if (v) setSql(v);
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
        <div className="spacer" />
        <button className="btn" disabled={!result || !rows.length} onClick={() => void exportAs("csv")}>
          Export CSV
        </button>
        <button className="btn" disabled={!result || !rows.length} onClick={() => void exportAs("json")}>
          Export JSON
        </button>
      </div>
      {shell.readOnly ? (
        <div className="hint">Read-only mode: statements run in a transaction that's rolled back{family === "mysql" ? ", and only statements that read are accepted" : ""}.</div>
      ) : readOnlyRun ? (
        <div className="hint">
          Runs in a transaction that's rolled back{family === "postgres" ? " (and set read only, so writes fail)" : "; only SELECT, SHOW, DESCRIBE, EXPLAIN and WITH are accepted"}. Clear Read only to change data.
        </div>
      ) : (
        <div className="warn-note">Changes are committed as soon as the statement runs.</div>
      )}
      {error && <div className="field-error">{error}</div>}
      {result && (
        <>
          <div className="row qf-stats hint">
            {result.data.columns.length
              ? `${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"}`
              : `${result.data.updated.toLocaleString()} row${result.data.updated === 1 ? "" : "s"} affected`}
            {` · ${result.data.elapsedMs.toLocaleString()} ms`}
            {result.data.readOnly ? " · rolled back" : ""}
            {rows.length >= 1000 ? " · the Data API returns at most 1 MB per statement; add LIMIT / OFFSET to see more" : ""}
          </div>
          {result.data.columns.length > 0 && (
            <>
              <div className="sql-grid">
                <table className="sync-table">
                  <thead>
                    <tr>
                      <th className="right rownum">#</th>
                      {result.data.columns.map((c, i) => (
                        <th key={i} title={c.typeName ?? undefined}>
                          {c.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r, i) => {
                      const n = page * pageSize + i;
                      return (
                        <tr key={n} className={selRow === n ? "selected" : ""} onClick={() => setSelRow(n)}>
                          <td className="right muted rownum">{n + 1}</td>
                          {r.map((v, j) => (
                            <td key={j} className={v === null ? "muted" : typeof v === "number" ? "right" : ""} title={cellText(v).length > 60 ? cellText(v) : undefined}>
                              {v === null ? "NULL" : cellText(v)}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="row">
                {rows.length > pageSize && (
                  <PageBar
                    page={page}
                    hasNext={page < lastPage}
                    lastPage={lastPage}
                    pageSize={pageSize}
                    rows={pageRows.length}
                    loading={false}
                    onPage={setPage}
                    onPageSize={(s) => {
                      setPageSize(s);
                      setPage(0);
                    }}
                  />
                )}
                <div className="spacer" />
                {selRow !== null && rows[selRow] && (
                  <button
                    className="link-btn"
                    onClick={() =>
                      void shell.copyText(JSON.stringify(Object.fromEntries(result.data.columns.map((c, j) => [c.name, rows[selRow][j]])), null, 2))
                    }
                  >
                    Copy row {selRow + 1} as JSON
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
