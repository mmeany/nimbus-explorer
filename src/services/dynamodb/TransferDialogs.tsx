// Export (current results or the whole table) and import with a preview.
import { useEffect, useState } from "react";
import type { AppError } from "../../api/core";
import { ddbApi, newJobId, tableKeyAttrs, type ExportFormat, type ImportPreview, type TableInfo } from "../../api/dynamo";
import { api } from "../../api/s3";
import type { Shell } from "../../shell/shell";
import type { DdbItem } from "../../util/ddbJson";

const FORMATS: { id: ExportFormat; label: string; ext: string; hint: string }[] = [
  { id: "dynamoJsonl", label: "DynamoDB JSON lines", ext: "jsonl", hint: "Exact types; can be imported again" },
  { id: "plainJsonl", label: "JSON lines", ext: "jsonl", hint: "Plain JSON; sets, binary and big numbers use $SS / $B / $N markers" },
  { id: "csv", label: "CSV", ext: "csv", hint: "Columns from the keys and the first page; other attributes in an _other column" },
];

function ProgressBar({ done, total }: { done: number; total: number | null }) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : null;
  return (
    <div className="ddb-progress">
      <div className="ddb-progress-track">
        <div className={`ddb-progress-fill ${pct === null ? "indeterminate" : ""}`} style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <span className="hint">
        {done.toLocaleString()}
        {total ? ` of about ${total.toLocaleString()}` : ""} items
      </span>
    </div>
  );
}

function useProgress(job: number | null) {
  const [p, setP] = useState<{ done: number; total: number | null } | null>(null);
  useEffect(() => {
    if (job === null) return;
    return ddbApi.onProgress((ev) => ev.job === job && setP({ done: ev.done, total: ev.total }));
  }, [job]);
  return p;
}

export function ExportDialog({ table, results, shell, onClose }: { table: TableInfo; results: DdbItem[]; shell: Shell; onClose: () => void }) {
  const [scope, setScope] = useState<"results" | "table">(results.length ? "results" : "table");
  const [format, setFormat] = useState<ExportFormat>("dynamoJsonl");
  const [job, setJob] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = useProgress(job);

  async function run() {
    const fmt = FORMATS.find((f) => f.id === format)!;
    const dest = await api.pickSaveAs("Export items", `${table.name}${scope === "results" ? "-results" : ""}.${fmt.ext}`);
    if (!dest) return;
    setError(null);
    try {
      if (scope === "results") {
        const n = await ddbApi.exportItems(results, tableKeyAttrs(table), format, dest);
        shell.showFlash(`Exported ${n.toLocaleString()} items to ${dest}`);
        onClose();
      } else {
        const id = newJobId();
        setJob(id);
        const [n, cancelled] = await ddbApi.exportTable(table.name, tableKeyAttrs(table), format, dest, id, table.itemCount);
        shell.showFlash(cancelled ? `Export cancelled after ${n.toLocaleString()} items (kept in ${dest}).` : `Exported ${n.toLocaleString()} items to ${dest}`);
        onClose();
      }
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setJob(null);
    }
  }

  const running = job !== null;
  return (
    <div className="modal-backdrop">
      <div className="dialog param-dialog io-dialog" role="dialog" aria-modal onKeyDown={(e) => e.key === "Escape" && !running && onClose()}>
        <div className="dialog-title">
          Export · <span className="mono">{table.name}</span>
        </div>
        <div className="dialog-body">
          <fieldset className="radio-group">
            <legend>What</legend>
            <label>
              <input type="radio" disabled={!results.length || running} checked={scope === "results"} onChange={() => setScope("results")} /> The {results.length.toLocaleString()} item
              {results.length === 1 ? "" : "s"} in the current results
            </label>
            <label>
              <input type="radio" disabled={running} checked={scope === "table"} onChange={() => setScope("table")} /> The whole table (about {table.itemCount?.toLocaleString() ?? "?"} items;
              reads every item, which uses read capacity)
            </label>
          </fieldset>
          <fieldset className="radio-group">
            <legend>Format</legend>
            {FORMATS.map((f) => (
              <label key={f.id}>
                <input type="radio" disabled={running} checked={format === f.id} onChange={() => setFormat(f.id)} /> {f.label} <span className="hint">· {f.hint}</span>
              </label>
            ))}
          </fieldset>
          {running && <ProgressBar done={progress?.done ?? 0} total={progress?.total ?? table.itemCount} />}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          {running ? (
            <button className="btn" onClick={() => void ddbApi.cancelJob(job!)}>
              Cancel export
            </button>
          ) : (
            <>
              <button className="btn primary" onClick={() => void run()}>
                Export…
              </button>
              <button className="btn" onClick={onClose}>
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function ImportDialog({ table, shell, onClose, onImported }: { table: TableInfo; shell: Shell; onClose: () => void; onImported: () => void }) {
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [job, setJob] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = useProgress(job);
  const keys = [table.partitionKey, table.sortKey].filter((k): k is NonNullable<typeof k> => !!k);

  async function choose() {
    const p = await api.pickOpenFile("Import items", "JSON / JSON lines", ["json", "jsonl", "ndjson"]);
    if (!p) return;
    setPath(p);
    setPreview(null);
    setError(null);
    setBusy(true);
    try {
      setPreview(
        await ddbApi.planImport(
          table.name,
          keys.map((k) => k.name),
          keys.map((k) => k.attrType),
          p,
        ),
      );
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!preview) return;
    const id = newJobId();
    setJob(id);
    setError(null);
    try {
      const r = await ddbApi.runImport(preview.planId, overwrite, id);
      const msg = `Imported ${r.written.toLocaleString()} item${r.written === 1 ? "" : "s"}${r.skippedExisting ? `; skipped ${r.skippedExisting.toLocaleString()} that already existed` : ""}`;
      if (r.failed.length) shell.showError({ kind: "other", message: `${msg}; ${r.failed.length} failed.`, detail: r.failed.slice(0, 50).map(([i, m]) => `#${i + 1}: ${m}`).join("\n") });
      else shell.showFlash(msg + ".");
      onImported();
      onClose();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setJob(null);
    }
  }

  const valid = preview ? preview.count - preview.problemCount : 0;
  const willWrite = preview ? (overwrite ? valid : valid - (preview.existing ?? 0)) : 0;
  const running = job !== null;

  return (
    <div className="modal-backdrop">
      <div className="dialog param-dialog io-dialog import-dialog" role="dialog" aria-modal onKeyDown={(e) => e.key === "Escape" && !running && onClose()}>
        <div className="dialog-title">
          Import into <span className="mono">{table.name}</span>
        </div>
        <div className="dialog-body">
          <div className="row">
            <button className="btn" disabled={running || busy} onClick={() => void choose()}>
              Choose file…
            </button>
            <span className="mono io-path">{path ?? "JSON array or JSON lines; DynamoDB JSON or plain JSON (detected)"}</span>
          </div>
          {busy && <div className="hint">Reading the file and checking which items exist…</div>}
          {preview && (
            <div className="sync-results">
              <div className="sync-totals">
                <div className="sync-total">
                  <div className="st-num">{preview.count.toLocaleString()}</div>
                  <div className="st-label">items ({preview.dynamoJson ? "DynamoDB JSON" : "plain JSON"})</div>
                </div>
                <div className={`sync-total ${preview.existing ? "warn" : ""}`}>
                  <div className="st-num">{preview.existing === null ? "?" : preview.existing.toLocaleString()}</div>
                  <div className="st-label">already in the table</div>
                </div>
                <div className={`sync-total ${preview.problemCount ? "danger" : ""}`}>
                  <div className="st-num">{preview.problemCount.toLocaleString()}</div>
                  <div className="st-label">can't be imported</div>
                </div>
              </div>
              {preview.duplicatesInFile > 0 && <div className="hint">{preview.duplicatesInFile} item(s) repeat a key from earlier in the file; the last one wins.</div>}
              {preview.problems.length > 0 && (
                <ul className="name-list">
                  {preview.problems.slice(0, 10).map(([i, m]) => (
                    <li key={i}>
                      Item {i + 1}: {m}
                    </li>
                  ))}
                  {preview.problemCount > 10 && <li>…and {preview.problemCount - 10} more</li>}
                </ul>
              )}
              <div className="props-section">First items</div>
              <pre className="value-text send-samples">{preview.samples.map((s) => JSON.stringify(s)).join("\n")}</pre>
              <label className="check-row">
                <input type="checkbox" checked={overwrite} disabled={running} onChange={(e) => setOverwrite(e.target.checked)} /> Overwrite items that already exist
                {!overwrite && <span className="hint"> (otherwise they're skipped)</span>}
              </label>
            </div>
          )}
          {running && <ProgressBar done={progress?.done ?? 0} total={progress?.total ?? valid} />}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          {shell.readOnly && <span className="hint">Read-only mode: preview only</span>}
          <div className="spacer" />
          {running ? (
            <button className="btn" onClick={() => void ddbApi.cancelJob(job!)}>
              Stop
            </button>
          ) : (
            <>
              <button className="btn primary" disabled={!preview || willWrite <= 0 || shell.readOnly} onClick={() => void run()}>
                Import {preview ? willWrite.toLocaleString() : ""}
              </button>
              <button className="btn" onClick={onClose}>
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
