// Delete a secret: scheduled (7–30 day recovery window) or immediately.
import { useState } from "react";
import type { AppError } from "../../api/core";
import { smApi, type SecretInfo } from "../../api/secrets";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";

export function DeleteSecretDialog({ secret, shell, onClose, onDeleted }: { secret: SecretInfo; shell: Shell; onClose: () => void; onDeleted: () => void }) {
  const [days, setDays] = useState(30);
  const [force, setForce] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !force || typed === secret.name;

  async function run() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const when = await smApi.delete(secret.arn ?? secret.name, force ? null : days, force);
      shell.showFlash(force ? `Deleted ${secret.name}.` : `${secret.name} will be deleted on ${when ? formatDate(when) : `in ${days} days`}; restore it before then if needed.`);
      onDeleted();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">Delete secret</div>
        <div className="dialog-body">
          <p>
            <span className="mono">{secret.name}</span>
          </p>
          <fieldset className="radio-group">
            <label>
              <input type="radio" checked={!force} onChange={() => setForce(false)} /> Schedule deletion, restorable for{" "}
              <select className="text-input" value={days} disabled={force} onChange={(e) => setDays(Number(e.target.value))}>
                {[7, 10, 14, 21, 30].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input type="radio" checked={force} onChange={() => setForce(true)} /> <span className="danger-text">Delete immediately, with no recovery</span>
            </label>
          </fieldset>
          {force && (
            <>
              <label className="form-label">
                Type <span className="mono">{secret.name}</span> to confirm
              </label>
              <input className="text-input mono" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
            </>
          )}
          <p className="hint">Applications using this secret will fail to read it {force ? "straight away" : "from now on (it can't be read while scheduled for deletion)"}.</p>
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn danger" disabled={!ready || busy} onClick={() => void run()}>
            {busy ? "Deleting…" : force ? "Delete now" : "Schedule deletion"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
