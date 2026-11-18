// Dialogs that run a state machine: Start execution (input with saved inputs
// and templates, optional name, version or alias) and Stop execution.
import { useEffect, useState } from "react";
import type { AppError } from "../../api/core";
import { executionNameProblem, sfnApi, type SavedInput, type Versions } from "../../api/sfn";
import { DialogHelp } from "../../components/HelpDialog";
import { ValueEditor } from "../../components/ValueEditor";
import type { HelpTopicId } from "../../help";
import type { Shell } from "../../shell/shell";

/** StartExecution's input limit. */
const MAX_INPUT = 256 * 1024;

export const INPUT_TEMPLATES: [string, string][] = [
  ["Empty object", "{}"],
  ["Order", JSON.stringify({ orderId: "1001", customer: { id: "c-42", email: "customer@example.com" }, items: [{ sku: "A-1", quantity: 2 }], total: 39.9 }, null, 2)],
  ["List of items (for a Map state)", JSON.stringify({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] }, null, 2)],
  [
    "S3 object created (EventBridge)",
    JSON.stringify(
      { version: "0", id: "1", "detail-type": "Object Created", source: "aws.s3", time: "2026-01-01T00:00:00Z", region: "eu-west-2", resources: ["arn:aws:s3:::my-bucket"], detail: { bucket: { name: "my-bucket" }, object: { key: "uploads/file.txt", size: 1024 } } },
      null,
      2,
    ),
  ],
  ["EventBridge schedule", JSON.stringify({ version: "0", id: "1", "detail-type": "Scheduled Event", source: "aws.scheduler", time: "2026-01-01T00:00:00Z", resources: [], detail: {} }, null, 2)],
];

function Frame({ title, help, children, buttons, onClose, wide }: { title: string; help: HelpTopicId; children: React.ReactNode; buttons: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`dialog param-dialog ${wide ? "dialog-wide" : ""}`} role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">
          <DialogHelp topic={help} />
          {title}
        </div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-buttons">
          <div className="spacer" />
          {buttons}
        </div>
      </div>
    </div>
  );
}

function inputProblem(input: string): string | null {
  if (!input.trim()) return null;
  if (new TextEncoder().encode(input).length > MAX_INPUT) return "The input is over 256 KB, the most Step Functions accepts";
  try {
    JSON.parse(input);
    return null;
  } catch (e) {
    return `Not valid JSON: ${(e as Error).message}`;
  }
}

export interface StartPreset {
  input: string;
  /** Version number or alias name the execution ran, if any. */
  qualifier: string | null;
  /** Where the preset came from, for the title ("Re-run order-42"). */
  from: string | null;
}

interface StartProps {
  shell: Shell;
  machine: { name: string; arn: string; kind: string };
  /** "profile|region|machine" for saved inputs. */
  inputsKey: string;
  preset: StartPreset | null;
  onClose: () => void;
  /** Standard machines open the new execution; Express ones can't be looked up. */
  onStarted: (name: string, express: boolean) => void;
}

export function StartExecutionDialog({ shell, machine, inputsKey, preset, onClose, onStarted }: StartProps) {
  const [input, setInput] = useState(preset?.input ?? "{}");
  const [name, setName] = useState("");
  const [qualifier, setQualifier] = useState(preset?.qualifier ?? "");
  const [saved, setSaved] = useState<SavedInput[]>([]);
  const [chosen, setChosen] = useState("");
  const [versions, setVersions] = useState<Versions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const express = machine.kind === "EXPRESS";

  useEffect(() => {
    sfnApi
      .inputs(inputsKey)
      .then(setSaved)
      .catch(() => setSaved([]));
    sfnApi
      .versions(machine.arn)
      .then(setVersions)
      .catch(() => setVersions(null));
  }, [inputsKey, machine.arn]);

  const problem = inputProblem(input) ?? executionNameProblem(name.trim());
  const canStart = !shell.readOnly && !problem && !busy;

  async function start() {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      const r = await sfnApi.start({ machineArn: machine.arn, qualifier: qualifier || null, name: name.trim() || null, input: input.trim() ? input : "{}" });
      onStarted(r.name, express);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  async function saveAs() {
    const n = await shell.askName("Save input", "Name", chosen || "my-input", "Save", (v) => (!v.trim() ? "Enter a name" : v.length > 100 ? "At most 100 characters" : null));
    if (!n) return;
    try {
      setSaved(await sfnApi.saveInput(inputsKey, n.trim(), input.trim() ? input : "{}"));
      setChosen(n.trim());
      shell.showFlash(`Saved input ${n.trim()}.`);
    } catch (e) {
      shell.showError(e);
    }
  }

  async function remove() {
    if (!chosen) return;
    const ok = await shell.ask("Delete saved input", <p>Delete the saved input "{chosen}"? (Only the copy on this computer; nothing in AWS changes.)</p>, [
      { label: "Delete", value: "yes", danger: true },
      { label: "Cancel", value: "no" },
    ], "no");
    if (ok !== "yes") return;
    try {
      setSaved(await sfnApi.deleteInput(inputsKey, chosen));
      setChosen("");
    } catch (e) {
      shell.showError(e);
    }
  }

  return (
    <Frame
      title={preset?.from ? `Re-run ${preset.from}` : `Start execution of ${machine.name}`}
      help="sfn.start"
      wide
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary" disabled={!canStart} title="Ctrl+Enter" onClick={() => void start()}>
            {busy ? "Starting…" : "Start execution"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.preventDefault(), void start())}>
        <div className="row invoke-bar">
          <select
            className="text-input"
            aria-label="Saved inputs"
            value={chosen}
            onChange={(e) => {
              const s = saved.find((x) => x.name === e.target.value);
              setChosen(e.target.value);
              if (s) setInput(s.input);
            }}
          >
            <option value="">{saved.length ? `Saved inputs (${saved.length})` : "No saved inputs"}</option>
            {saved.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="btn" disabled={!!inputProblem(input)} onClick={() => void saveAs()}>
            Save as…
          </button>
          <button className="btn" disabled={!chosen} onClick={() => void remove()}>
            Delete
          </button>
          <select
            className="text-input"
            aria-label="Template"
            value=""
            onChange={(e) => {
              const t = INPUT_TEMPLATES.find(([n]) => n === e.target.value);
              if (t) {
                setInput(t[1]);
                setChosen("");
              }
            }}
          >
            <option value="">Start from a template…</option>
            {INPUT_TEMPLATES.map(([n]) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <ValueEditor value={input} onChange={setInput} rows={14} placeholder="{}" />
        <div className="pe-grid">
          <label className="form-label" htmlFor="sx-name">
            Name
          </label>
          <input id="sx-name" className="text-input mono" placeholder="(AWS picks a unique name)" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="form-label" htmlFor="sx-q">
            Run
          </label>
          <select id="sx-q" className="text-input" value={qualifier} onChange={(e) => setQualifier(e.target.value)}>
            <option value="">The latest definition</option>
            {versions?.aliases.map((a) => (
              <option key={`a:${a.name}`} value={a.name}>
                Alias {a.name} ({a.routing.map((r) => `version ${r.version} ${r.weight}%`).join(", ")})
              </option>
            ))}
            {versions?.versions.map((v) => (
              <option key={`v:${v.version}`} value={v.version}>
                Version {v.version}
              </option>
            ))}
            {qualifier && versions && !versions.aliases.some((a) => a.name === qualifier) && !versions.versions.some((v) => v.version === qualifier) && <option value={qualifier}>{qualifier} (no longer listed)</option>}
          </select>
        </div>
      </div>
      {express && <p className="hint">This is an Express machine: AWS keeps no execution history to look up, so its run shows only in the machine's log group (when logging is on).</p>}
      {!express && <p className="hint">Names must be unique among this machine's executions of the last 90 days.</p>}
      {shell.readOnly && <div className="hint">Read-only mode: starting executions is disabled.</div>}
      {problem && <div className="field-error">{problem}</div>}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}

export function StopExecutionDialog({ name, onClose, onStop }: { name: string; onClose: () => void; onStop: (error: string | null, cause: string | null) => Promise<void> }) {
  const [error, setError] = useState("");
  const [cause, setCause] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const problem = error.length > 256 ? "The error is at most 256 characters" : cause.length > 32768 ? "The cause is at most 32,768 characters" : null;
  async function stop() {
    if (problem || busy) return;
    setBusy(true);
    setFailed(null);
    try {
      await onStop(error.trim() || null, cause.trim() || null);
    } catch (e) {
      setFailed((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }
  return (
    <Frame
      title={`Stop ${name}`}
      help="sfn.stop"
      onClose={onClose}
      buttons={
        <>
          <button className="btn danger" disabled={!!problem || busy} onClick={() => void stop()}>
            {busy ? "Stopping…" : "Stop execution"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p>
        The execution stops where it is and ends as <b>aborted</b>. Work a running Task already started (a Lambda call, a job) isn't undone. A Standard execution can be redriven from the state where it stopped.
      </p>
      <div className="pe-grid">
        <label className="form-label" htmlFor="sx-err">
          Error (optional)
        </label>
        <input id="sx-err" className="text-input mono" placeholder="e.g. Manual.Stop" value={error} onChange={(e) => setError(e.target.value)} autoFocus />
        <label className="form-label" htmlFor="sx-cause">
          Cause (optional)
        </label>
        <textarea id="sx-cause" className="text-input" rows={3} value={cause} onChange={(e) => setCause(e.target.value)} />
      </div>
      {problem && <div className="field-error">{problem}</div>}
      {failed && <div className="field-error">{failed}</div>}
    </Frame>
  );
}
