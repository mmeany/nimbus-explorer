// Export to JSON / .env and import with a preview.
import { useState } from "react";
import type { AppError } from "../../api/core";
import { api } from "../../api/s3";
import { ssmApi, type ExportFormat, type ImportPreview } from "../../api/ssm";
import type { Shell } from "../../shell/shell";

/** "/app/dev/" → "app-dev-parameters.json". */
function defaultFileName(folder: string, format: ExportFormat): string {
  const base = folder.split("/").filter(Boolean).join("-") || "all";
  return format === "env" ? `${base}.env` : `${base}-parameters.json`;
}

export function ParamExportDialog({ folder: initial, shell, onClose }: { folder: string; shell: Shell; onClose: () => void }) {
  const [folder, setFolder] = useState(initial);
  const [format, setFormat] = useState<ExportFormat>("json");
  const [secrets, setSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folderOk = folder.trim().startsWith("/");

  async function run() {
    const dest = await api.pickSaveAs("Export parameters", defaultFileName(folder.trim(), format));
    if (!dest) return;
    setBusy(true);
    setError(null);
    try {
      const r = await ssmApi.export(folder.trim(), format, secrets, dest);
      shell.showFlash(
        `Exported ${r.exported} parameter${r.exported === 1 ? "" : "s"} to ${r.path}` +
          (r.secretsOmitted ? ` (${r.secretsOmitted} SecureString value${r.secretsOmitted === 1 ? "" : "s"} left out)` : ""),
      );
      onClose();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog io-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">Export parameters</div>
        <div className="dialog-body">
          <label className="form-label" htmlFor="ex-folder">
            Folder (everything below it is included)
          </label>
          <input id="ex-folder" className="text-input mono" value={folder} spellCheck={false} onChange={(e) => setFolder(e.target.value)} />
          <fieldset className="radio-group">
            <legend>Format</legend>
            <label>
              <input type="radio" checked={format === "json"} onChange={() => setFormat("json")} /> JSON: names, types, values, descriptions, KMS keys,
              tiers and tags (can be imported again)
            </label>
            <label>
              <input type="radio" checked={format === "env"} onChange={() => setFormat("env")} /> .env: KEY="value" lines, keys from the names below
              the folder (/app/dev/db/host → DB_HOST)
            </label>
          </fieldset>
          <label className="check-row">
            <input type="checkbox" checked={secrets} onChange={(e) => setSecrets(e.target.checked)} /> Include decrypted SecureString values
          </label>
          {secrets ? (
            <div className="warn-note">
              The file will contain secrets in plain text. Store it somewhere safe and delete it when you're done.
            </div>
          ) : (
            <div className="hint">SecureStrings are listed without their values.</div>
          )}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" disabled={busy || !folderOk} onClick={() => void run()}>
            {busy ? "Exporting…" : "Export…"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const ACTION_LABEL = { create: "Create", overwrite: "Overwrite", unchanged: "Unchanged", skip: "Skip" };

export function ParamImportDialog({
  folder,
  shell,
  onClose,
  onImported,
}: {
  folder: string;
  shell: Shell;
  onClose: () => void;
  onImported: () => void;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [keepNames, setKeepNames] = useState(true);
  const [target, setTarget] = useState(folder);
  const [defaultType, setDefaultType] = useState("String");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEnv = !!path && !/\.json$/i.test(path);

  async function browse() {
    const p = await api.pickOpenFile("Import parameters", "Parameters (JSON, .env)", ["json", "env", "txt"]);
    if (p) {
      setPath(p);
      setPreview(null);
      setError(null);
    }
  }

  async function doPreview() {
    if (!path) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(
        await ssmApi.planImport({
          path,
          targetFolder: keepNames && !isEnv ? null : target.trim() || "/",
          defaultType,
        }),
      );
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await ssmApi.runImport(preview.planId, overwrite);
      const msg = `Imported: ${r.created} created, ${r.overwritten} overwritten`;
      if (r.failed.length) {
        shell.showError({ kind: "other", message: `${msg}, ${r.failed.length} failed.`, detail: r.failed.map((f) => `${f.name}: ${f.message}`).join("\n") });
      } else {
        shell.showFlash(msg + ".");
      }
      onImported();
      onClose();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const writes = preview ? preview.creates + (overwrite ? preview.overwrites : 0) : 0;
  const shown = preview?.rows.slice(0, 200) ?? [];

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog io-dialog import-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">Import parameters</div>
        <div className="dialog-body">
          <div className="row">
            <button className="btn" onClick={() => void browse()}>
              Choose file…
            </button>
            <span className="mono io-path">{path ?? "JSON export, a {\"name\": \"value\"} object, or a .env file"}</span>
          </div>
          {path && !isEnv && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={keepNames}
                onChange={(e) => {
                  setKeepNames(e.target.checked);
                  setPreview(null);
                }}
              />{" "}
              Keep the names in the file (an export from another folder can be moved by unticking)
            </label>
          )}
          {path && (isEnv || !keepNames) && (
            <>
              <label className="form-label" htmlFor="im-target">
                {isEnv ? "Folder for the keys" : "Target folder (replaces the export's folder; relative names go here)"}
              </label>
              <input
                id="im-target"
                className="text-input mono"
                value={target}
                spellCheck={false}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setPreview(null);
                }}
              />
            </>
          )}
          {path && (
            <div className="row">
              <span className="form-label">Type for entries without one</span>
              <select
                className="text-input"
                value={defaultType}
                onChange={(e) => {
                  setDefaultType(e.target.value);
                  setPreview(null);
                }}
              >
                <option>String</option>
                <option>SecureString</option>
              </select>
              <span className="hint">(.env and plain JSON)</span>
            </div>
          )}

          {preview && (
            <div className="sync-results">
              <div className="sync-totals">
                <div className="sync-total">
                  <div className="st-num">{preview.creates}</div>
                  <div className="st-label">to create</div>
                </div>
                <div className={`sync-total ${preview.overwrites ? "warn" : ""}`}>
                  <div className="st-num">{preview.overwrites}</div>
                  <div className="st-label">different (overwrite)</div>
                </div>
                <div className="sync-total">
                  <div className="st-num">{preview.unchanged}</div>
                  <div className="st-label">unchanged</div>
                </div>
                <div className="sync-total">
                  <div className="st-num">{preview.skips}</div>
                  <div className="st-label">skipped</div>
                </div>
              </div>
              {preview.rows.length > shown.length && (
                <div className="sync-caption summary">
                  Showing {shown.length} of {preview.rows.length}
                </div>
              )}
              <div className="sync-table-wrap">
                <table className="sync-table">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r, i) => (
                      <tr key={i} className={`im-${r.action}`}>
                        <td>{ACTION_LABEL[r.action]}</td>
                        <td className="mono">{r.name}</td>
                        <td>{r.paramType}</td>
                        <td className="muted">{r.note ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.overwrites > 0 && (
                <label className="check-row">
                  <input type="checkbox" checked={overwrite} disabled={shell.readOnly} onChange={(e) => setOverwrite(e.target.checked)} /> Also overwrite the{" "}
                  {preview.overwrites === 1 ? "1 parameter that differs" : `${preview.overwrites} parameters that differ`} (their current values stay as older versions)
                </label>
              )}
            </div>
          )}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          {shell.readOnly && <span className="hint">Read-only mode: preview only</span>}
          <div className="spacer" />
          <button className="btn" disabled={!path || busy} onClick={() => void doPreview()}>
            {busy && !preview ? "Reading…" : preview ? "Preview again" : "Preview"}
          </button>
          <button className="btn primary" disabled={!preview || busy || writes === 0 || shell.readOnly} onClick={() => void run()}>
            {preview ? `Import ${writes}` : "Import"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
