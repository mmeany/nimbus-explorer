// Rotation: schedule, Lambda, window; enable / disable; rotate now.
import { useState } from "react";
import type { AppError } from "../../api/core";
import { scheduleProblem, smApi, type SecretInfo } from "../../api/secrets";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";

/** "every 30 days" (from AutomaticallyAfterDays) → "rate(30 days)". */
function initialSchedule(s: SecretInfo): string {
  const m = /^every (\d+) days$/.exec(s.rotationSchedule ?? "");
  if (m) return `rate(${m[1]} days)`;
  return s.rotationSchedule ?? "rate(30 days)";
}

export function RotationDialog({ secret, shell, onClose, onChanged }: { secret: SecretInfo; shell: Shell; onClose: () => void; onChanged: () => void }) {
  const id = secret.arn ?? secret.name;
  const ro = shell.readOnly;
  const [lambda, setLambda] = useState(secret.rotationLambdaArn ?? "");
  const [schedule, setSchedule] = useState(initialSchedule(secret));
  const [windowHours, setWindowHours] = useState("");
  const [rotateNow, setRotateNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = scheduleProblem(schedule) ?? (windowHours && !/^\d+$/.test(windowHours) ? "The window must be a whole number of hours" : null);

  async function run(f: () => Promise<void>, msg: string) {
    setBusy(true);
    setError(null);
    try {
      await f();
      shell.showFlash(msg);
      onChanged();
      onClose();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rotateNowClick() {
    const ok = await shell.ask(
      "Rotate now",
      <>Rotate <span className="mono">{secret.name}</span> now? The rotation function creates a new value; applications should read the secret again.</>,
      [
        { label: "Rotate", value: "go", primary: true },
        { label: "Cancel", value: "cancel" },
      ],
      "cancel",
    );
    if (ok === "go") await run(() => smApi.rotateNow(id), "Rotation started.");
  }

  async function disable() {
    const ok = await shell.ask(
      "Turn off rotation",
      <>Stop rotating <span className="mono">{secret.name}</span> automatically? Its current value stays.</>,
      [
        { label: "Turn off", value: "go", danger: true },
        { label: "Cancel", value: "cancel" },
      ],
      "cancel",
    );
    if (ok === "go") await run(() => smApi.cancelRotation(id), "Rotation turned off.");
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog secret-editor" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">
          Rotation · <span className="mono">{secret.name}</span>
        </div>
        <div className="dialog-body">
          <table className="props-table">
            <tbody>
              <tr>
                <th>Status</th>
                <td>{secret.rotationEnabled ? "On" : "Off"}</td>
              </tr>
              {secret.lastRotated && (
                <tr>
                  <th>Last rotated</th>
                  <td>{formatDate(secret.lastRotated)}</td>
                </tr>
              )}
              {secret.nextRotation && (
                <tr>
                  <th>Next rotation</th>
                  <td>{formatDate(secret.nextRotation)}</td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="pe-grid">
            <span className="form-label">Rotation function</span>
            <input
              className="text-input mono"
              value={lambda}
              placeholder="Lambda ARN (blank keeps the current one / managed rotation)"
              spellCheck={false}
              onChange={(e) => setLambda(e.target.value)}
            />
            <span className="form-label">Schedule</span>
            <div className="row">
              <input className="text-input mono" value={schedule} spellCheck={false} onChange={(e) => setSchedule(e.target.value)} />
              {[7, 30, 90].map((d) => (
                <button key={d} className="link-btn" onClick={() => setSchedule(`rate(${d} days)`)}>
                  {d}d
                </button>
              ))}
            </div>
            <span className="form-label">Window</span>
            <div className="row">
              <input className="text-input num-input" value={windowHours} placeholder="auto" onChange={(e) => setWindowHours(e.target.value.trim())} />
              <span className="hint">hours (with cron schedules: how long after the start rotation may run)</span>
            </div>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={rotateNow} onChange={(e) => setRotateNow(e.target.checked)} /> Also rotate immediately
          </label>
          <div className="hint">Examples: rate(30 days), rate(6 hours), cron(0 4 1 * ? *) for 04:00 UTC on the 1st of each month.</div>
          {problem && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <button className="btn" disabled={ro || busy || !secret.rotationEnabled} onClick={() => void rotateNowClick()}>
            Rotate now…
          </button>
          <button className="btn" disabled={ro || busy || !secret.rotationEnabled} onClick={() => void disable()}>
            Turn off…
          </button>
          <div className="spacer" />
          <button
            className="btn primary"
            disabled={ro || busy || !!problem}
            onClick={() =>
              void run(
                () => smApi.configureRotation(id, lambda.trim() || null, schedule.trim(), windowHours ? `${windowHours}h` : null, rotateNow),
                secret.rotationEnabled ? "Rotation updated." : "Rotation turned on.",
              )
            }
          >
            {secret.rotationEnabled ? "Save" : "Turn on"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
