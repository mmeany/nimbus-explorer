import { useState } from "react";
import { api, toAppError, type AppError, type SyncDirection, type SyncRunResult, type SyncSummary } from "../api/s3";
import { formatSize } from "../format";
import { DownloadIcon, UploadIcon } from "./Icons";

interface Props {
  bucket: string;
  prefix: string;
  /** Read-only mode: only downloads (which change local files, not S3) are allowed. */
  readOnly: boolean;
  /** Called after a run starts, with its result (to show transfers / refresh). */
  onRan: (result: SyncRunResult, summary: SyncSummary) => void;
  onClose: () => void;
}

interface Remembered {
  localDir: string;
  direction: SyncDirection;
  deleteExtras: boolean;
  sizeOnly: boolean;
  excludes: string;
}

const storeKey = (bucket: string, prefix: string) => `s3x.sync.${bucket}/${prefix}`;
function load(bucket: string, prefix: string): Partial<Remembered> {
  try {
    return JSON.parse(localStorage.getItem(storeKey(bucket, prefix)) ?? "{}");
  } catch {
    return {};
  }
}
function save(bucket: string, prefix: string, v: Remembered) {
  try {
    localStorage.setItem(storeKey(bucket, prefix), JSON.stringify(v));
  } catch {
    /* not remembered */
  }
}

const KIND_LABEL = { upload: "Upload", download: "Download", deleteRemote: "Delete (S3)", deleteLocal: "Delete (local)" };

/** Sync a local folder with the current S3 folder, with a dry run first. */
export function SyncDialog({ bucket, prefix, readOnly, onRan, onClose }: Props) {
  const saved = load(bucket, prefix);
  const [direction, setDirection] = useState<SyncDirection>(readOnly ? "download" : (saved.direction ?? "upload"));
  const [localDir, setLocalDir] = useState(saved.localDir ?? "");
  const [deleteExtras, setDeleteExtras] = useState(saved.deleteExtras ?? false);
  const [sizeOnly, setSizeOnly] = useState(saved.sizeOnly ?? false);
  const [excludes, setExcludes] = useState(saved.excludes ?? "");
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const s3 = `s3://${bucket}/${prefix}`;

  async function browse() {
    try {
      const dir = await api.pickFolder(direction === "upload" ? "Folder to upload from" : "Folder to download into");
      if (dir) {
        setLocalDir(dir);
        setSummary(null);
      }
    } catch (e) {
      setError(toAppError(e));
    }
  }

  async function dryRun() {
    if (!localDir) return;
    save(bucket, prefix, { localDir, direction, deleteExtras, sizeOnly, excludes });
    setBusy("Comparing…");
    setError(null);
    setSummary(null);
    setConfirmDelete(false);
    try {
      setSummary(
        await api.planSync({
          direction,
          localDir,
          bucket,
          prefix,
          deleteExtras,
          sizeOnly,
          excludes: excludes
            .split(/[,\n]/)
            .map((x) => x.trim())
            .filter(Boolean),
        }),
      );
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setBusy(null);
    }
  }

  async function run() {
    if (!summary) return;
    if (summary.deletes.count > 0 && !confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy("Starting…");
    setError(null);
    try {
      const result = await api.runSync(summary.planId);
      onRan(result, summary);
    } catch (e) {
      setError(toAppError(e));
      setBusy(null);
    }
  }

  const changed = () => setSummary(null);

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div
        className="dialog sync-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="sync-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}
      >
        <div className="dialog-title" id="sync-title">
          Sync with {s3}
        </div>
        <div className="dialog-body">
          {prefix === "" && (
            <div className="warn-note">
              This syncs the whole bucket, which may be a lot of files. To sync part of it, right-click a folder in the
              tree or the file list and choose "Sync this folder…".
            </div>
          )}
          <fieldset className="radio-group">
            <legend>Direction</legend>
            <label>
              <input type="radio" checked={direction === "upload"} disabled={readOnly} onChange={() => (setDirection("upload"), changed())} />{" "}
              <UploadIcon size={14} /> Upload: local folder → {s3}
              {readOnly && <span className="muted-note"> (disabled in read-only mode)</span>}
            </label>
            <label>
              <input type="radio" checked={direction === "download"} onChange={() => (setDirection("download"), changed())} />{" "}
              <DownloadIcon size={14} /> Download: {s3} → local folder
            </label>
          </fieldset>

          <label className="form-label" htmlFor="sync-local">
            Local folder
          </label>
          <div className="row">
            <input
              id="sync-local"
              className="text-input grow mono"
              value={localDir}
              placeholder="Choose a folder…"
              onChange={(e) => (setLocalDir(e.target.value), changed())}
            />
            <button className="btn" onClick={browse}>
              Browse…
            </button>
          </div>

          <div className="sync-options">
            <label className="check">
              <input type="checkbox" checked={sizeOnly} onChange={(e) => (setSizeOnly(e.target.checked), changed())} />{" "}
              Compare by size only (ignore dates)
            </label>
            <label className={`check ${deleteExtras ? "danger-text" : ""}`}>
              <input type="checkbox" checked={deleteExtras} onChange={(e) => (setDeleteExtras(e.target.checked), changed())} />{" "}
              Delete files in the {direction === "upload" ? "S3 folder" : "local folder"} that aren't in the{" "}
              {direction === "upload" ? "local folder" : "S3 folder"} (mirror)
            </label>
          </div>
          <label className="form-label" htmlFor="sync-excludes">
            Exclude
          </label>
          <input
            id="sync-excludes"
            className="text-input mono"
            value={excludes}
            placeholder="e.g. *.tmp, .git/*, Thumbs.db"
            onChange={(e) => (setExcludes(e.target.value), changed())}
          />
          <div className="hint">Comma-separated. * matches anything (including /), ? matches one character.</div>

          {error && <div className="field-error sync-error">{error.message}</div>}
          {summary && <SyncResults summary={summary} />}
          {confirmDelete && summary && (
            <div className="warn-note">
              ⚠ This will permanently delete {summary.deletes.count.toLocaleString()} file
              {summary.deletes.count === 1 ? "" : "s"} ({formatSize(summary.deletes.bytes)}) from the{" "}
              {summary.direction === "upload" ? "S3 folder" : "local folder (not to the Recycle Bin)"}. Click{" "}
              <strong>Run sync</strong> again to confirm.
            </div>
          )}
        </div>
        <div className="dialog-buttons">
          {busy && <span className="busy">{busy}</span>}
          <div className="spacer" />
          <button className="btn" onClick={dryRun} disabled={!localDir || !!busy} title="Compare and list what would change, without changing anything">
            Dry run
          </button>
          <button
            className={`btn primary ${confirmDelete ? "danger" : ""}`}
            onClick={summary ? run : dryRun}
            disabled={!localDir || !!busy || (summary !== null && summary.totalActions === 0)}
            title={summary ? "Run exactly the changes listed above" : "Preview the changes first; you'll confirm before anything runs"}
          >
            {summary ? (confirmDelete ? "Run sync (confirm)" : "Run sync") : "Preview sync…"}
          </button>
          <button className="btn" onClick={onClose} disabled={!!busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function SyncResults({ summary: s }: { summary: SyncSummary }) {
  const nothing = s.totalActions === 0;
  return (
    <div className="sync-results">
      <div className="sync-totals">
        {s.direction === "upload" ? (
          <Total label="To upload" t={s.uploads} />
        ) : (
          <Total label="To download" t={s.downloads} />
        )}
        <Total label="To delete" t={s.deletes} danger={s.deletes.count > 0} />
        <div className="sync-total">
          <div className="st-num">{s.unchanged.toLocaleString()}</div>
          <div className="st-label">Up to date</div>
        </div>
        {s.totalWarnings > 0 && (
          <div className="sync-total warn">
            <div className="st-num">{s.totalWarnings.toLocaleString()}</div>
            <div className="st-label">Skipped</div>
          </div>
        )}
      </div>
      {nothing ? (
        <div className="hint sync-nothing">Everything is already in sync. Nothing to do.</div>
      ) : (
        <>
          <div className={`sync-caption ${s.truncated ? "summary" : ""}`}>
            {s.truncated
              ? `Summary: showing the first ${s.actions.length} of ${s.totalActions.toLocaleString()} changes. The totals above include all of them.`
              : `${s.totalActions.toLocaleString()} change${s.totalActions === 1 ? "" : "s"}:`}
          </div>
          <div className="sync-table-wrap">
            <table className="sync-table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Path</th>
                  <th className="right">Size</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {s.actions.map((a, i) => (
                  <tr key={i} className={`k-${a.kind}`}>
                    <td>{KIND_LABEL[a.kind]}</td>
                    <td className="mono">{a.path}</td>
                    <td className="right">{formatSize(a.size)}</td>
                    <td className="muted">{a.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {s.totalWarnings > 0 && (
        <details className="sync-warnings">
          <summary>
            {s.totalWarnings.toLocaleString()} file{s.totalWarnings === 1 ? "" : "s"} skipped
            {s.totalWarnings > s.warnings.length ? ` (showing the first ${s.warnings.length})` : ""}
          </summary>
          <ul className="name-list">
            {s.warnings.map((w, i) => (
              <li key={i}>
                <span className="mono">{w.path}</span>: {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Total({ label, t, danger }: { label: string; t: { count: number; bytes: number }; danger?: boolean }) {
  return (
    <div className={`sync-total ${danger ? "danger" : ""}`}>
      <div className="st-num">{t.count.toLocaleString()}</div>
      <div className="st-label">
        {label}
        {t.count > 0 ? ` · ${formatSize(t.bytes)}` : ""}
      </div>
    </div>
  );
}
