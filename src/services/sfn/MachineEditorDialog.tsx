// Edit a state machine: the definition (with a live graph and AWS's
// validation), execution role, logging and tracing, and optionally publish
// the result as a new version. Only changed fields are sent; a machine that
// changed since the editor opened is not overwritten without asking.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppError } from "../../api/core";
import { logGroupArn, sfnApi, type MachineDetails, type UpdateRequest, type Validation } from "../../api/sfn";
import { DialogHelp } from "../../components/HelpDialog";
import { ValueEditor } from "../../components/ValueEditor";
import type { Shell } from "../../shell/shell";
import { parseMachine, type ParsedMachine } from "./graph/asl";
import { StateGraph } from "./graph/StateGraph";

const MAX_DEFINITION = 1024 * 1024;
const LEVELS = ["OFF", "ALL", "ERROR", "FATAL"] as const;

function definitionProblem(text: string): string | null {
  if (!text.trim()) return "The definition can't be empty";
  if (new TextEncoder().encode(text).length > MAX_DEFINITION) return "The definition is over 1 MB, the most Step Functions accepts";
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return "The definition is a JSON object";
    return null;
  } catch (e) {
    return `Not valid JSON: ${(e as Error).message}`;
  }
}

interface Props {
  shell: Shell;
  machine: MachineDetails;
  onClose: () => void;
  onDone: (msg: string) => void;
}

export function MachineEditorDialog({ shell, machine: m, onClose, onDone }: Props) {
  const original = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(m.definition), null, 2);
    } catch {
      return m.definition;
    }
  }, [m.definition]);
  const [tab, setTab] = useState<"definition" | "settings">("definition");
  const [definition, setDefinition] = useState(original);
  const [role, setRole] = useState(m.roleArn ?? "");
  const [level, setLevel] = useState<string>(m.logging?.level ?? "OFF");
  const [includeData, setIncludeData] = useState(m.logging?.includeExecutionData ?? false);
  const [logGroup, setLogGroup] = useState(m.logging?.logGroupArn ?? "");
  const [tracing, setTracing] = useState(m.tracing);
  const [publish, setPublish] = useState(false);
  const [versionDescription, setVersionDescription] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [validation, setValidation] = useState<{ text: string; v: Validation | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The graph keeps the last definition that parsed, so it doesn't vanish mid-edit.
  const defProblem = definitionProblem(definition);
  const lastGood = useRef<ParsedMachine | null>(parseMachine(original));
  const parsed = useMemo(() => (defProblem ? null : parseMachine(definition)), [definition, defProblem]);
  if (parsed) lastGood.current = parsed;
  const shown = parsed ?? lastGood.current;

  // Ask AWS once typing pauses (reading only, so allowed in read-only mode too).
  useEffect(() => {
    if (defProblem) return;
    const text = definition;
    const t = window.setTimeout(() => {
      sfnApi
        .validate(text, m.kind)
        .then((v) => setValidation({ text, v, error: null }))
        .catch((e) => setValidation({ text, v: null, error: (e as AppError).message ?? String(e) }));
    }, 700);
    return () => window.clearTimeout(t);
  }, [definition, defProblem, m.kind]);
  const current = validation?.text === definition ? validation : null;
  const diagnostics = current?.v?.diagnostics ?? [];
  const problems = useMemo(() => {
    const s = new Set<string>();
    for (const d of diagnostics) if (d.state) s.add(d.state);
    for (const w of parsed?.warnings ?? []) {
      const name = /^"([^"]+)" goes to/.exec(w)?.[1];
      if (name) s.add(name);
    }
    return s;
  }, [diagnostics, parsed]);

  const loggingChanged = level !== (m.logging?.level ?? "OFF") || includeData !== (m.logging?.includeExecutionData ?? false) || (level !== "OFF" && logGroupArn(m.arn, logGroup) !== (m.logging?.logGroupArn ?? ""));
  const request: UpdateRequest = {
    arn: m.arn,
    expectedRevision: m.revisionId,
    overwrite: false,
    definition: definition !== original ? definition : null,
    roleArn: role.trim() !== (m.roleArn ?? "") ? role.trim() : null,
    logging: loggingChanged ? { level, includeExecutionData: includeData, logGroupArn: level === "OFF" ? null : logGroupArn(m.arn, logGroup) } : null,
    tracing: tracing !== m.tracing ? tracing : null,
    publish,
    versionDescription: publish && versionDescription.trim() ? versionDescription.trim() : null,
  };
  const changed = !!(request.definition || request.roleArn || request.logging || request.tracing !== null);
  const settingsProblem =
    request.roleArn !== null && !/^arn:[^:]+:iam::\d*:role\/.+/.test(request.roleArn)
      ? "The execution role is an IAM role ARN (arn:aws:iam::<account>:role/<name>)"
      : level !== "OFF" && !logGroup.trim()
        ? "Logging needs a log group (its name or ARN)"
        : versionDescription.length > 256
          ? "The version description is at most 256 characters"
          : null;
  // Our own checks (a transition to a missing state, no StartAt) are always invalid ASL, so they block saving.
  const aslProblem = parsed?.warnings.length ? "Fix the problems listed under the definition first" : null;
  const problem = defProblem ?? aslProblem ?? settingsProblem ?? (!changed && !publish ? "Nothing changed yet" : null);
  const awsErrors = diagnostics.filter((d) => d.severity === "ERROR").length;

  async function save(overwrite = false) {
    if (problem || busy || shell.readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const r = await sfnApi.update({ ...request, overwrite });
      if (r.outcome === "changed") {
        setBusy(false);
        const answer = await shell.ask(
          "State machine changed",
          <p>
            <span className="mono">{m.name}</span> was changed after you opened the editor (in the console, by a deployment or in another window). Save over those changes, or cancel and reopen the editor to start from them?
          </p>,
          [
            { label: "Save over them", value: "yes", danger: true },
            { label: "Cancel", value: "no" },
          ],
          "no",
        );
        if (answer === "yes") await save(true);
        return;
      }
      const version = r.versionArn ? r.versionArn.slice(r.versionArn.lastIndexOf(":") + 1) : null;
      onDone(version ? `Saved ${m.name} and published version ${version}.` : `Saved ${m.name}.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog sfn-editor-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">
          <DialogHelp topic="sfn.edit" />
          Edit {m.name}
        </div>
        <div className="dialog-body sfn-editor-body">
          <div className="segmented small db-tabs">
            <button className={tab === "definition" ? "active" : ""} onClick={() => setTab("definition")}>
              Definition
            </button>
            <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
              Role, logging and tracing
            </button>
          </div>
          {tab === "definition" ? (
            <div className="sfn-editor-split">
              <div className="sfn-editor-left" onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.preventDefault(), void save())}>
                <ValueEditor value={definition} onChange={setDefinition} rows={24} />
                <div className="sfn-diagnostics">
                  {defProblem ? null : !current ? (
                    <span className="hint">Checking with Step Functions…</span>
                  ) : current.error ? (
                    <span className="hint">Couldn't check the definition: {current.error}</span>
                  ) : diagnostics.length === 0 && !parsed?.warnings.length ? (
                    <span className="ok-note">Step Functions found no problems.</span>
                  ) : null}
                  {[...(parsed?.warnings ?? []).map((w) => ({ key: `w|${w}`, severity: "ERROR", text: w, state: /^"([^"]+)" goes to/.exec(w)?.[1] ?? null })), ...diagnostics.map((d, i) => ({ key: `d|${i}`, severity: d.severity, text: `${d.code}: ${d.message}${d.location ? ` (${d.location})` : ""}`, state: d.state }))].map((d) => (
                    <div key={d.key} className={d.severity === "ERROR" ? "field-error" : "hint"}>
                      {d.state ? (
                        <button className="link-btn" onClick={() => setSelected(d.state)}>
                          {d.state}
                        </button>
                      ) : null}
                      {d.state ? " · " : ""}
                      {d.text}
                    </div>
                  ))}
                  {current?.v?.truncated && <div className="hint">AWS reported more problems than shown.</div>}
                </div>
              </div>
              <div className="sfn-editor-right">
                {shown ? <StateGraph graph={shown.graph} runs={null} selected={selected} onSelect={setSelected} problems={problems} /> : <div className="warn-note">Not a state machine definition yet.</div>}
                {parsed === null && shown && <div className="hint">The text isn't valid JSON: the graph shows the last version that was.</div>}
              </div>
            </div>
          ) : (
            <div className="pe-grid">
              <label className="form-label" htmlFor="se-role">
                Execution role
              </label>
              <input id="se-role" className="text-input mono" value={role} onChange={(e) => setRole(e.target.value)} placeholder="arn:aws:iam::123456789012:role/my-role" />
              <label className="form-label" htmlFor="se-level">
                Logging
              </label>
              <select id="se-level" className="text-input" value={level} onChange={(e) => setLevel(e.target.value)}>
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l === "OFF" ? "Off" : l === "ALL" ? "All events (every step)" : l === "ERROR" ? "Errors" : "Fatal errors only"}
                  </option>
                ))}
              </select>
              {level !== "OFF" && (
                <>
                  <label className="form-label" htmlFor="se-group">
                    Log group
                  </label>
                  <input id="se-group" className="text-input mono" value={logGroup} onChange={(e) => setLogGroup(e.target.value)} placeholder="/aws/vendedlogs/states/my-machine (name or ARN)" />
                  <span />
                  <label className="check-row">
                    <input type="checkbox" checked={includeData} onChange={(e) => setIncludeData(e.target.checked)} /> Include execution data (inputs and outputs in the log)
                  </label>
                </>
              )}
              <span className="form-label">Tracing</span>
              <label className="check-row">
                <input type="checkbox" checked={tracing} onChange={(e) => setTracing(e.target.checked)} /> X-Ray tracing
              </label>
            </div>
          )}
          {m.kind === "EXPRESS" && level === "OFF" && <p className="hint">Express machines keep no execution history; without logging, their runs can't be seen.</p>}
          {level !== "OFF" && <p className="hint">The execution role needs permission to deliver logs (logs:CreateLogDelivery and related actions), or saving fails.</p>}
          <div className="row sfn-publish">
            <label className="check-row inline">
              <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish as a new version
            </label>
            {publish && <input className="text-input" aria-label="Version description" placeholder="Version description (optional)" value={versionDescription} onChange={(e) => setVersionDescription(e.target.value)} />}
          </div>
          {shell.readOnly && <div className="hint">Read-only mode: saving is disabled.</div>}
          {problem && problem !== "Nothing changed yet" && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          {awsErrors > 0 && <span className="field-error">Step Functions reports {awsErrors} error{awsErrors === 1 ? "" : "s"}; saving will likely fail.</span>}
          <div className="spacer" />
          <button className="btn primary" disabled={!!problem || busy || shell.readOnly} title="Ctrl+Enter" onClick={() => void save()}>
            {busy ? "Saving…" : publish ? "Save and publish" : "Save"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
