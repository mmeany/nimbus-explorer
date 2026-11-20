// Policy validation with IAM Access Analyzer (ValidatePolicy): findings by
// severity, each marked at its place in the document. Used under every policy
// document the app shows and in the Validate policy dialog for pasted JSON.
import { useEffect, useRef, useState } from "react";
import type { AppError } from "../../api/core";
import { groupFindings, highlightSegments, iamValidateApi, POLICY_KIND_LABEL, RESOURCE_TYPES, SEVERITY_LABEL, type Finding, type PolicyKind } from "../../api/iam";
import { ErrorPanel } from "../../components/ErrorPanel";
import { DialogHelp, HelpTopic } from "../../components/HelpDialog";

const SEV_CLASS: Record<string, string> = { ERROR: "pv-error", SECURITY_WARNING: "pv-security", WARNING: "pv-warning", SUGGESTION: "pv-suggestion" };

function errorText(e: AppError): AppError {
  // Endpoints without Access Analyzer (emulators) answer with a bare status.
  if (!e.message || /^\s*$|\(400\)|UnknownOperation|not (yet )?implemented/i.test(e.message))
    return { ...e, message: "This endpoint couldn't validate the policy: it may not support IAM Access Analyzer's ValidatePolicy (emulators usually don't)." };
  return e;
}

/** Findings plus the document with their locations marked. */
export function Findings({ document, findings }: { document: string; findings: Finding[] }) {
  // Start on the most severe finding (the first one listed).
  const [selected, setSelected] = useState<number | null>(() => groupFindings(findings)[0]?.items[0]?.index ?? null);
  const markRef = useRef<HTMLElement | null>(null);
  useEffect(() => markRef.current?.scrollIntoView({ block: "nearest" }), [selected]);
  if (!findings.length) return <p className="hint">No findings: Access Analyzer found no errors, warnings or suggestions.</p>;
  const segments = highlightSegments(document, findings, selected);
  let firstSelected = true;
  return (
    <div className="pv">
      {groupFindings(findings).map((g) => (
        <div key={g.severity}>
          <div className={`props-section ${SEV_CLASS[g.severity] ?? ""}`}>
            {SEVERITY_LABEL[g.severity] ?? g.severity} ({g.items.length})
          </div>
          {g.items.map(({ f, index }) => (
            <div key={index} className={`pv-finding${index === selected ? " selected" : ""}`} onClick={() => setSelected(index)}>
              <div>
                <span className={`qbadge ${SEV_CLASS[f.severity] ?? ""}`}>{f.issueCode}</span> {f.details}
              </div>
              {f.locations.length > 0 && <div className="hint mono">{f.locations.map((l) => `${l.path || "(document)"} · line ${l.line}`).join("; ")}</div>}
              {f.learnMore && <div className="hint mono selectable">{f.learnMore}</div>}
            </div>
          ))}
        </div>
      ))}
      <pre className="sim-doc mono">
        {segments.map((s, i) => {
          if (!s.severity) return <span key={i}>{s.text}</span>;
          const isFirst = s.selected && firstSelected;
          if (s.selected) firstSelected = false;
          return (
            <mark key={i} ref={isFirst ? markRef : undefined} className={`${SEV_CLASS[s.severity] ?? ""}${s.selected ? " selected" : ""}`}>
              {s.text}
            </mark>
          );
        })}
      </pre>
    </div>
  );
}

/** A Validate button under a document; runs on demand (it's an AWS call). */
export function ValidateButton({ document, kind }: { document: string; kind: PolicyKind }) {
  const [state, setState] = useState<{ busy: boolean; findings: Finding[] | null; error: AppError | null; doc: string }>({ busy: false, findings: null, error: null, doc: "" });
  async function run() {
    setState({ busy: true, findings: null, error: null, doc: document });
    try {
      setState({ busy: false, findings: await iamValidateApi.validate(document, kind), error: null, doc: document });
    } catch (e) {
      setState({ busy: false, findings: null, error: errorText(e as AppError), doc: document });
    }
  }
  const stale = state.doc !== document;
  return (
    <div className="pv-block">
      <div className="row">
        <button className="btn small" disabled={state.busy} onClick={() => void run()} title="Check the document with IAM Access Analyzer (in the selected region)">
          {state.busy ? "Validating…" : "Validate"}
        </button>
        {state.findings && !stale && (
          <>
            <span className="hint">
              {state.findings.length ? `${state.findings.length} finding${state.findings.length === 1 ? "" : "s"}` : "No findings"} ({POLICY_KIND_LABEL[kind].toLowerCase()})
            </span>
            <button className="link-btn" onClick={() => setState({ busy: false, findings: null, error: null, doc: "" })}>
              Hide
            </button>
          </>
        )}
      </div>
      {state.error && !stale && <ErrorPanel error={state.error} profile={null} onRetry={() => void run()} />}
      {state.findings && !stale && (
        <>
          <HelpTopic id="iam.validate" />
          <Findings document={document} findings={state.findings} />
        </>
      )}
    </div>
  );
}

const SAMPLE = '{\n  "Version": "2012-10-17",\n  "Statement": [\n    {\n      "Effect": "Allow",\n      "Action": "s3:GetObject",\n      "Resource": "*"\n    }\n  ]\n}';

/** The Validate policy dialog for pasted JSON. */
export function ValidatePolicyDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState(SAMPLE);
  const [kind, setKind] = useState<PolicyKind>("identity");
  const [resourceType, setResourceType] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ doc: string; findings: Finding[] } | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  let problem: string | null = null;
  try {
    JSON.parse(text);
  } catch (e) {
    problem = `Not valid JSON: ${(e as Error).message}`;
  }
  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult({ doc: text, findings: await iamValidateApi.validate(text, kind, kind === "resource" && resourceType ? resourceType : null) });
    } catch (e) {
      setResult(null);
      setError(errorText(e as AppError));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog pv-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">
          <DialogHelp topic="iam.validateDialog" />
          Validate policy
        </div>
        <div className="dialog-body">
          <div className="row">
            <label className="form-label" htmlFor="pv-kind">
              Type
            </label>
            <select id="pv-kind" className="text-input" value={kind} onChange={(e) => setKind(e.target.value as PolicyKind)}>
              {(Object.keys(POLICY_KIND_LABEL) as PolicyKind[]).map((k) => (
                <option key={k} value={k}>
                  {POLICY_KIND_LABEL[k]}
                </option>
              ))}
            </select>
            {kind === "resource" && (
              <select className="text-input" value={resourceType} onChange={(e) => setResourceType(e.target.value)} title="Extra checks for these resource types">
                <option value="">(any resource type)</option>
                {RESOURCE_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            )}
          </div>
          <textarea className="text-input mono pv-input" rows={14} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
          {problem && <div className="field-error">{problem}</div>}
          {error && <ErrorPanel error={error} profile={null} onRetry={() => void run()} />}
          {result && (result.doc === text ? <Findings key={result.doc + kind} document={result.doc} findings={result.findings} /> : <p className="hint">The policy changed: validate again.</p>)}
        </div>
        <div className="dialog-buttons">
          <span className="hint">Uses IAM Access Analyzer in the selected region; nothing is saved.</span>
          <div className="spacer" />
          <button className="btn primary" disabled={busy || !!problem} onClick={() => void run()}>
            {busy ? "Validating…" : "Validate"}
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
