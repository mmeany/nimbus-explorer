// Edit or create a state machine: the definition (with a live graph and
// AWS's validation), execution role, logging and tracing, and optionally
// publish the result as a new version. Editing sends only changed fields, and
// a machine that changed since the editor opened is not overwritten without
// asking. Creating adds the name, the type and templates to start from.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppError } from "../../api/core";
import { executionNameProblem, logGroupArn, sfnApi, type MachineDetails, type UpdateRequest, type Validation } from "../../api/sfn";
import { DialogHelp } from "../../components/HelpDialog";
import { ValueEditor } from "../../components/ValueEditor";
import type { Shell } from "../../shell/shell";
import { parseMachine, type ParsedMachine } from "./graph/asl";
import { StateGraph } from "./graph/StateGraph";
import { RolePicker } from "../../components/RolePicker";

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

const pass = (comment: string, states: Record<string, unknown>, startAt: string) => JSON.stringify({ Comment: comment, StartAt: startAt, States: states }, null, 2);

/** Starting points for a new machine. */
export const MACHINE_TEMPLATES: [string, string][] = [
  ["Hello world (Pass)", pass("A single Pass state", { Hello: { Type: "Pass", Result: { message: "Hello" }, End: true } }, "Hello")],
  [
    "Call a Lambda function, with retry and catch",
    pass(
      "Invokes a function; retries throttling, sends other errors to a handler",
      {
        Invoke: {
          Type: "Task",
          Resource: "arn:aws:states:::lambda:invoke",
          Parameters: { FunctionName: "my-function", "Payload.$": "$" },
          OutputPath: "$.Payload",
          Retry: [{ ErrorEquals: ["Lambda.TooManyRequestsException", "Lambda.ServiceException"], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2 }],
          Catch: [{ ErrorEquals: ["States.ALL"], Next: "Failed", ResultPath: "$.error" }],
          End: true,
        },
        Failed: { Type: "Fail", Error: "InvokeFailed", Cause: "The function failed" },
      },
      "Invoke",
    ),
  ],
  [
    "Choice and Wait",
    pass(
      "Waits until an item is ready, then continues",
      {
        Check: { Type: "Choice", Choices: [{ Variable: "$.ready", BooleanEquals: true, Next: "Done" }], Default: "Wait" },
        Wait: { Type: "Wait", Seconds: 10, Next: "Check" },
        Done: { Type: "Succeed" },
      },
      "Check",
    ),
  ],
  [
    "Parallel branches",
    pass(
      "Runs two branches at once and collects both results",
      {
        Both: {
          Type: "Parallel",
          Branches: [
            { StartAt: "Left", States: { Left: { Type: "Pass", Result: "left", End: true } } },
            { StartAt: "Right", States: { Right: { Type: "Pass", Result: "right", End: true } } },
          ],
          End: true,
        },
      },
      "Both",
    ),
  ],
  [
    "Map over items",
    pass(
      "Processes each item of $.items, five at a time",
      { Each: { Type: "Map", ItemsPath: "$.items", MaxConcurrency: 5, ItemProcessor: { ProcessorConfig: { Mode: "INLINE" }, StartAt: "Process", States: { Process: { Type: "Pass", End: true } } }, End: true } },
      "Each",
    ),
  ],
];

interface Props {
  shell: Shell;
  /** The machine to edit; null creates a new one. */
  machine: MachineDetails | null;
  /** Creating: the region it goes in, and names already taken there. */
  create?: { region: string; taken: string[] };
  onClose: () => void;
  /** `name` is the machine created (when creating). */
  onDone: (msg: string, name?: string) => void;
}

export function MachineEditorDialog({ shell, machine, create, onClose, onDone }: Props) {
  const creating = !machine;
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState("STANDARD");
  const m: MachineDetails = machine ?? {
    name: newName.trim(),
    arn: "",
    kind: newKind,
    status: null,
    description: null,
    created: null,
    roleArn: null,
    revisionId: null,
    definition: MACHINE_TEMPLATES[0][1],
    logging: null,
    tracing: false,
    encryption: null,
    tags: [],
    error: null,
  };
  const original = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(m.definition), null, 2);
    } catch {
      return m.definition;
    }
    // The template a new machine starts from doesn't change while it's open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine?.definition]);
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

  // A new machine has no ARN yet: take the partition and account from the role, the region from the connection.
  const roleParts = role.trim().split(":");
  const arnForLogs = creating ? `arn:${roleParts[1] || "aws"}:states:${create?.region ?? ""}:${roleParts[4] ?? ""}:stateMachine:${m.name}` : m.arn;
  const loggingChanged = level !== (m.logging?.level ?? "OFF") || includeData !== (m.logging?.includeExecutionData ?? false) || (level !== "OFF" && logGroupArn(arnForLogs, logGroup) !== (m.logging?.logGroupArn ?? ""));
  const request: UpdateRequest = {
    arn: m.arn,
    expectedRevision: m.revisionId,
    overwrite: false,
    definition: definition !== original ? definition : null,
    roleArn: role.trim() !== (m.roleArn ?? "") ? role.trim() : null,
    logging: loggingChanged ? { level, includeExecutionData: includeData, logGroupArn: level === "OFF" ? null : logGroupArn(arnForLogs, logGroup) } : null,
    tracing: tracing !== m.tracing ? tracing : null,
    publish,
    versionDescription: publish && versionDescription.trim() ? versionDescription.trim() : null,
  };
  const changed = !!(request.definition || request.roleArn || request.logging || request.tracing !== null);
  const nameProblem = !creating
    ? null
    : !m.name
      ? "Enter a name"
      : (executionNameProblem(m.name)?.replace("Execution names", "State machine names") ?? (create?.taken.includes(m.name) ? `There's already a state machine called ${m.name}` : null));
  const settingsProblem =
    creating && !role.trim()
      ? "A state machine needs an execution role (its IAM role ARN, on the Role tab)"
      : request.roleArn !== null && !/^arn:[^:]+:iam::\d*:role\/.+/.test(request.roleArn)
      ? "The execution role is an IAM role ARN (arn:aws:iam::<account>:role/<name>)"
      : level !== "OFF" && !logGroup.trim()
        ? "Logging needs a log group (its name or ARN)"
        : versionDescription.length > 256
          ? "The version description is at most 256 characters"
          : null;
  // Our own checks (a transition to a missing state, no StartAt) are always invalid ASL, so they block saving.
  const aslProblem = parsed?.warnings.length ? "Fix the problems listed under the definition first" : null;
  const problem = nameProblem ?? defProblem ?? aslProblem ?? settingsProblem ?? (!creating && !changed && !publish ? "Nothing changed yet" : null);
  const awsErrors = diagnostics.filter((d) => d.severity === "ERROR").length;

  async function save(overwrite = false) {
    if (problem || busy || shell.readOnly) return;
    setBusy(true);
    setError(null);
    if (creating) {
      try {
        await sfnApi.create({
          name: m.name,
          kind: m.kind,
          definition,
          roleArn: role.trim(),
          logging: level === "OFF" ? null : { level, includeExecutionData: includeData, logGroupArn: logGroupArn(arnForLogs, logGroup) },
          tracing,
          publish,
          versionDescription: request.versionDescription,
        });
        onDone(`Created ${m.name}${publish ? " and published version 1" : ""}.`, m.name);
      } catch (e) {
        setError((e as AppError).message ?? String(e));
        setBusy(false);
      }
      return;
    }
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
          <DialogHelp topic={creating ? "sfn.create" : "sfn.edit"} />
          {creating ? "New state machine" : `Edit ${m.name}`}
        </div>
        <div className="dialog-body sfn-editor-body">
          {creating && (
            <div className="row sfn-create-bar">
              <label className="form-label" htmlFor="sc-name">
                Name
              </label>
              <input id="sc-name" className="text-input mono" value={newName} autoFocus onChange={(e) => setNewName(e.target.value)} placeholder="order-processing" />
              <label className="form-label" htmlFor="sc-kind">
                Type
              </label>
              <select id="sc-kind" className="text-input" value={newKind} onChange={(e) => setNewKind(e.target.value)} title="Can't be changed later">
                <option value="STANDARD">Standard (up to a year; history kept 90 days)</option>
                <option value="EXPRESS">Express (up to 5 minutes; high volume; logs only)</option>
              </select>
              <select
                className="text-input"
                aria-label="Template"
                value=""
                onChange={(e) => {
                  const t = MACHINE_TEMPLATES.find(([n]) => n === e.target.value);
                  if (t) setDefinition(t[1]);
                }}
              >
                <option value="">Start from a template…</option>
                {MACHINE_TEMPLATES.map(([n]) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          )}
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
              <RolePicker id="se-role" value={role} onChange={setRole} service="states.amazonaws.com" />
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
            {busy ? (creating ? "Creating…" : "Saving…") : creating ? (publish ? "Create and publish" : "Create") : publish ? "Save and publish" : "Save"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
