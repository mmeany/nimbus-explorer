// Move messages out of a (dead-letter) queue: SQS redrive tasks with
// progress and cancel, or a receive → send → delete fallback.
import { useCallback, useEffect, useState } from "react";
import type { AppError } from "../../api/core";
import { queueNameFromArn, queueNameFromUrl, sqsApi, type MoveTask, type QueueInfo } from "../../api/sqs";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";

/** A queue to pick (from the name list; no attributes needed). */
export interface QueueChoice {
  name: string;
  url: string;
  arn: string | null;
  fifo: boolean;
}

interface Props {
  queue: QueueInfo;
  /** All queues in the region (destinations). */
  queues: QueueChoice[];
  shell: Shell;
  onClose: () => void;
  onChanged: () => void;
}

const POLL_MS = 3000;
const ACTIVE = new Set(["RUNNING", "CANCELLING"]);

export function RedriveDialog({ queue, queues, shell, onClose, onChanged }: Props) {
  const [sources, setSources] = useState<string[] | null>(null);
  const [dest, setDest] = useState<string>(queue.isDlq ? "" : "pick"); // "" = source queues
  const [destName, setDestName] = useState("");
  const [rate, setRate] = useState("");
  const [tasks, setTasks] = useState<MoveTask[] | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Task API failed: offer the manual move. */
  const [offerManual, setOfferManual] = useState(false);
  const [manualResult, setManualResult] = useState<string | null>(null);

  useEffect(() => {
    if (queue.isDlq) sqsApi.dlqSources(queue.url).then(setSources).catch(() => setSources([]));
  }, [queue]);

  const loadTasks = useCallback(async () => {
    if (!queue.arn) return;
    try {
      setTasks(await sqsApi.listRedrives(queue.arn));
      setTasksError(null);
    } catch (e) {
      setTasksError((e as AppError).message ?? String(e));
    }
  }, [queue.arn]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const running = tasks?.some((t) => ACTIVE.has(t.status)) ?? false;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => void loadTasks().then(onChanged), POLL_MS);
    return () => window.clearInterval(t);
  }, [running, loadTasks, onChanged]);

  const candidates = queues.filter((q) => q.name !== queue.name && q.fifo === queue.fifo);
  const destQueue = dest === "pick" ? candidates.find((q) => q.name === destName) : undefined;
  // For the manual move with "source queues": only when there is exactly one.
  const manualTarget = dest === "pick" ? destQueue : sources?.length === 1 ? queues.find((q) => q.url === sources[0]) : undefined;
  const available = (queue.visible ?? 0) + (queue.delayed ?? 0);
  const rateOk = !rate || (/^\d+$/.test(rate) && Number(rate) >= 1 && Number(rate) <= 500);
  const problem = !queue.arn
    ? "This queue's ARN is unknown"
    : dest === "pick" && !destQueue
      ? "Choose a destination queue"
      : !rateOk
        ? "Rate must be 1 to 500 messages per second"
        : null;

  async function start() {
    if (problem || !queue.arn) return;
    setBusy(true);
    setError(null);
    setOfferManual(false);
    try {
      await sqsApi.startRedrive(queue.arn, dest === "pick" ? destQueue!.arn : null, rate ? Number(rate) : null);
      shell.showFlash(`Redrive started from ${queue.name}.`);
      await loadTasks();
      onChanged();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setOfferManual(true);
    } finally {
      setBusy(false);
    }
  }

  async function manual() {
    if (!manualTarget) return;
    setBusy(true);
    setError(null);
    try {
      const r = await sqsApi.moveMessages(queue.url, manualTarget.url, manualTarget.fifo, Math.max(available, 10));
      setManualResult(`Moved ${r.sent.toLocaleString()} message${r.sent === 1 ? "" : "s"} to ${manualTarget.name}` + (r.failed.length ? `; ${r.failed.length} couldn't be sent and stayed.` : "."));
      onChanged();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(t: MoveTask) {
    if (!t.taskHandle) return;
    try {
      const moved = await sqsApi.cancelRedrive(t.taskHandle);
      shell.showFlash(`Cancelling; ${moved.toLocaleString()} message${moved === 1 ? "" : "s"} had moved.`);
      await loadTasks();
    } catch (e) {
      shell.showError(e);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog redrive-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">
          {queue.isDlq ? "Redrive" : "Move messages"} · <span className="mono">{queue.name}</span>
        </div>
        <div className="dialog-body">
          <p>
            About {available.toLocaleString()} message{available === 1 ? "" : "s"} available to move.
          </p>
          <fieldset className="radio-group">
            <legend>Move to</legend>
            {queue.isDlq && (
              <label>
                <input type="radio" checked={dest === ""} onChange={() => setDest("")} /> Their source queues
                {sources && sources.length > 0 && <span className="hint"> ({sources.map(queueNameFromUrl).join(", ")})</span>}
              </label>
            )}
            <label>
              <input type="radio" checked={dest === "pick"} onChange={() => setDest("pick")} /> Another queue:
              <select className="text-input" value={destName} disabled={dest !== "pick"} onChange={(e) => setDestName(e.target.value)}>
                <option value="">Choose…</option>
                {candidates.map((q) => (
                  <option key={q.name} value={q.name}>
                    {q.name}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          <div className="row">
            <span className="form-label">Rate</span>
            <input className="text-input num-input" value={rate} placeholder="auto" onChange={(e) => setRate(e.target.value.trim())} />
            <span className="hint">messages per second (blank = as fast as SQS allows)</span>
          </div>

          {problem && !(dest === "pick" && destName === "") && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
          {offerManual && (
            <div className="warn-note">
              SQS redrive couldn't start (emulators often don't support it).{" "}
              {manualTarget ? (
                <>
                  You can move the messages by receiving each one, sending it to <b>{manualTarget.name}</b> and deleting it after it was sent.{" "}
                  <button className="link-btn" disabled={busy || shell.readOnly} onClick={() => void manual()}>
                    Move this way
                  </button>
                </>
              ) : (
                "Choose a specific destination queue to move them by receiving and re-sending instead."
              )}
            </div>
          )}
          {manualResult && <div className="ok-note">{manualResult}</div>}

          <div className="props-section">Recent redrives</div>
          {tasksError ? (
            <div className="hint">Couldn't list redrive tasks: {tasksError}</div>
          ) : !tasks ? (
            <div className="hint">Loading…</div>
          ) : tasks.length === 0 ? (
            <div className="hint">None.</div>
          ) : (
            <table className="sync-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Status</th>
                  <th>To</th>
                  <th className="right">Moved</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tasks.map((t, i) => (
                  <tr key={t.taskHandle ?? i}>
                    <td>{formatDate(t.started)}</td>
                    <td className={t.status === "FAILED" ? "danger-text" : ""} title={t.failureReason ?? ""}>
                      {t.status}
                      {t.failureReason ? ` (${t.failureReason})` : ""}
                    </td>
                    <td>{t.destinationArn ? queueNameFromArn(t.destinationArn) : "source queues"}</td>
                    <td className="right">
                      {t.moved.toLocaleString()}
                      {t.toMove !== null ? ` / ${t.toMove.toLocaleString()}` : ""}
                    </td>
                    <td>
                      {t.status === "RUNNING" && t.taskHandle && (
                        <button className="link-btn" onClick={() => void cancel(t)}>
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="dialog-buttons">
          {shell.readOnly && <span className="hint">Read-only mode</span>}
          <div className="spacer" />
          <button className="btn primary" disabled={!!problem || busy || running || shell.readOnly || available === 0} onClick={() => void start()}>
            {running ? "Redrive running…" : busy ? "Starting…" : "Start redrive"}
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
