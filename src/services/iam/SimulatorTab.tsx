// Policy simulator tab on users, groups and roles (SimulatePrincipalPolicy;
// changes nothing). Inputs survive switching tabs (kept per principal for the
// session); results show the matched statements inside their policies.
import { useEffect, useRef, useState } from "react";
import type { AppError } from "../../api/core";
import { CONTEXT_TYPES, decisionText, iamSimApi, parseActions, splitList, statementRange, type ContextIn, type Matched, type SimResult } from "../../api/iam";
import { ErrorPanel } from "../../components/ErrorPanel";

interface Inputs {
  actions: string;
  resources: string;
  context: { key: string; type: string; values: string }[];
  extraOn: boolean;
  extra: string;
}

const EMPTY: Inputs = { actions: "", resources: "", context: [], extraOn: false, extra: '{\n  "Version": "2012-10-17",\n  "Statement": [\n    { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*" }\n  ]\n}' };

/** Inputs and the last results per principal ARN, for this session only. */
const memory = new Map<string, { inputs: Inputs; results: SimResult[] | null }>();

const LIST_TYPES = new Set(CONTEXT_TYPES.filter((t) => t.endsWith("List")));

function DecisionBadge({ d }: { d: string }) {
  const cls = d === "allowed" ? "sim-allowed" : d === "explicitDeny" ? "sim-explicit" : "sim-implicit";
  return <span className={`qbadge ${cls}`}>{decisionText(d)}</span>;
}

function MatchedStatement({ m }: { m: Matched }) {
  const ref = useRef<HTMLElement | null>(null);
  const parts = m.document ? statementRange(m.document, m.start, m.end) : null;
  useEffect(() => ref.current?.scrollIntoView({ block: "nearest" }), [parts?.[0]]);
  return (
    <div className="sim-match">
      <div className="hint">
        In <b>{m.policy ?? m.sourceId}</b>
        {m.sourceType ? ` (${m.sourceType})` : ""}
        {m.start ? `, line ${m.start[0]}` : ""}
      </div>
      {m.document ? (
        <pre className="sim-doc mono">
          {parts ? (
            <>
              {parts[0]}
              <mark ref={ref}>{parts[1]}</mark>
              {parts[2]}
            </>
          ) : (
            m.document
          )}
        </pre>
      ) : (
        <p className="hint">The policy's document couldn't be found (source {m.sourceId}).</p>
      )}
    </div>
  );
}

function effect(v: boolean | null, allows: string, denies: string): string {
  return v === null ? "" : v ? allows : denies;
}

export function SimulatorTab({ kind, name, arn }: { kind: "users" | "groups" | "roles"; name: string; arn: string }) {
  const saved = memory.get(arn);
  const [inputs, setInputsState] = useState<Inputs>(saved?.inputs ?? EMPTY);
  const [results, setResultsState] = useState<SimResult[] | null>(saved?.results ?? null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const setInputs = (f: (i: Inputs) => Inputs) =>
    setInputsState((i) => {
      const n = f(i);
      memory.set(arn, { inputs: n, results });
      return n;
    });
  const setResults = (r: SimResult[] | null) => {
    setResultsState(r);
    memory.set(arn, { inputs, results: r });
  };

  const parsed = parseActions(inputs.actions);
  const resources = splitList(inputs.resources);
  let problem = parsed.error;
  if (!problem && parsed.actions.length === 0) problem = "Enter at least one action.";
  if (!problem && parsed.actions.length > 100) problem = "At most 100 actions at a time.";
  if (!problem && resources.length > 100) problem = "At most 100 resources at a time.";
  if (!problem && inputs.extraOn) {
    try {
      JSON.parse(inputs.extra);
    } catch (e) {
      problem = `The extra policy isn't valid JSON: ${(e as Error).message}`;
    }
  }
  const context: ContextIn[] = inputs.context
    .filter((c) => c.key.trim())
    .map((c) => ({ key: c.key.trim(), type: c.type, values: LIST_TYPES.has(c.type as never) ? splitList(c.values) : [c.values.trim()] }));
  if (!problem) {
    const bad = context.find((c) => !c.key.includes(":") || !c.values.filter(Boolean).length);
    if (bad) problem = `Context key ${bad.key}: ${bad.key.includes(":") ? "needs a value" : "should look like aws:SourceIp"}.`;
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await iamSimApi.simulate({ kind, name, arn, actions: parsed.actions, resources, context, extraPolicy: inputs.extraOn ? inputs.extra : null });
      setResults(r);
      setSelected(0);
    } catch (e) {
      setError(e as AppError);
    } finally {
      setBusy(false);
    }
  }

  const missing = [...new Set((results ?? []).flatMap((r) => r.missingContext))].filter((k) => !inputs.context.some((c) => c.key.trim() === k));
  const sel = results?.[selected];
  const counts = results && { allowed: results.filter((r) => r.decision === "allowed").length, total: results.length };

  return (
    <div className="sim">
      <p className="hint">Asks AWS what this {kind === "users" ? "user" : kind === "groups" ? "user group" : "role"} may do, from its identity policies{kind === "users" ? " and its groups'" : ""}, permissions boundary and the organisation's SCPs. Nothing is changed.</p>
      <div className="sim-inputs">
        <label className="sim-field">
          <span>Actions (exact names, separated by commas or new lines)</span>
          <textarea className="text-input mono" rows={3} spellCheck={false} placeholder="s3:GetObject, s3:PutObject" value={inputs.actions} onChange={(e) => setInputs((i) => ({ ...i, actions: e.target.value }))} />
        </label>
        <label className="sim-field">
          <span>Resource ARNs (optional, one per line; empty = any resource)</span>
          <textarea className="text-input mono" rows={2} spellCheck={false} placeholder="arn:aws:s3:::my-bucket/*" value={inputs.resources} onChange={(e) => setInputs((i) => ({ ...i, resources: e.target.value }))} />
        </label>
        <div className="sim-field">
          <span>Context keys (optional: values for the policies' conditions)</span>
          {inputs.context.map((c, n) => (
            <div className="row" key={n}>
              <input className="text-input mono" placeholder="aws:SourceIp" value={c.key} onChange={(e) => setInputs((i) => ({ ...i, context: i.context.map((x, j) => (j === n ? { ...x, key: e.target.value } : x)) }))} />
              <select className="text-input" value={c.type} onChange={(e) => setInputs((i) => ({ ...i, context: i.context.map((x, j) => (j === n ? { ...x, type: e.target.value } : x)) }))}>
                {CONTEXT_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <input
                className="text-input mono grow"
                placeholder={LIST_TYPES.has(c.type as never) ? "values, comma separated" : "value"}
                value={c.values}
                onChange={(e) => setInputs((i) => ({ ...i, context: i.context.map((x, j) => (j === n ? { ...x, values: e.target.value } : x)) }))}
              />
              <button className="link-btn" onClick={() => setInputs((i) => ({ ...i, context: i.context.filter((_, j) => j !== n) }))}>
                Remove
              </button>
            </div>
          ))}
          <div className="row">
            <button className="link-btn" onClick={() => setInputs((i) => ({ ...i, context: [...i.context, { key: "", type: "string", values: "" }] }))}>
              Add context key
            </button>
            {missing.length > 0 && (
              <button className="link-btn" onClick={() => setInputs((i) => ({ ...i, context: [...i.context, ...missing.map((k) => ({ key: k, type: "string", values: "" }))] }))}>
                Add the {missing.length} missing key{missing.length === 1 ? "" : "s"} from the results
              </button>
            )}
          </div>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={inputs.extraOn} onChange={(e) => setInputs((i) => ({ ...i, extraOn: e.target.checked }))} /> Also test an extra identity policy (as if it were attached)
        </label>
        {inputs.extraOn && <textarea className="text-input mono" rows={8} spellCheck={false} value={inputs.extra} onChange={(e) => setInputs((i) => ({ ...i, extra: e.target.value }))} />}
        <div className="row">
          <button className="btn primary" disabled={busy || !!problem} onClick={() => void run()}>
            {busy ? "Simulating…" : "Simulate"}
          </button>
          {problem && parsed.actions.length > 0 && <span className="field-error">{problem}</span>}
        </div>
      </div>
      {error && <ErrorPanel error={error} profile={null} onRetry={() => void run()} />}
      {results && (
        <>
          <div className="props-section">
            Results: {counts!.allowed} of {counts!.total} allowed
          </div>
          <table className="sync-table">
            <thead>
              <tr>
                <th>Decision</th>
                <th>Action</th>
                <th>Resource</th>
                <th>Statements</th>
                <th>Boundary</th>
                <th>Organisation</th>
                <th>Missing context</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} className={i === selected ? "selected" : ""} onClick={() => setSelected(i)} style={{ cursor: "pointer" }}>
                  <td>
                    <DecisionBadge d={r.decision} />
                  </td>
                  <td className="mono">{r.action}</td>
                  <td className="mono">{r.resource}</td>
                  <td>{r.matched.length || ""}</td>
                  <td>{effect(r.boundaryAllowed, "Allows", "Denies")}</td>
                  <td>{effect(r.organizationsAllowed, "Allows", "Denies (SCP)")}</td>
                  <td className="mono">{r.missingContext.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {sel && (
            <div className="sim-detail">
              <div className="props-section">
                {sel.action} on <span className="mono">{sel.resource}</span>: <DecisionBadge d={sel.decision} />
              </div>
              <p className="hint">
                {sel.decision === "allowed"
                  ? "An Allow statement matched, and nothing denies it."
                  : sel.decision === "explicitDeny"
                    ? "A Deny statement matched: it wins over any Allow."
                    : "No statement allows it (or a boundary or SCP doesn't): access is denied by default."}
                {sel.boundaryAllowed === false ? " The permissions boundary doesn't allow it." : ""}
                {sel.organizationsAllowed === false ? " A service control policy denies it." : ""}
              </p>
              {sel.missingContext.length > 0 && <p className="hint">Conditions use context keys with no value given: {sel.missingContext.join(", ")}. Add them above for an exact answer.</p>}
              {sel.details.length > 0 && (
                <p className="hint">
                  By policy type: {sel.details.map(([k, v]) => `${k} ${decisionText(v).toLowerCase()}`).join("; ")}
                </p>
              )}
              {sel.matched.length === 0 ? <p className="hint">No statement matched.</p> : sel.matched.map((m, i) => <MatchedStatement key={`${selected}-${i}`} m={m} />)}
            </div>
          )}
          <p className="hint">Resource-based policies (bucket policies, key policies…) aren't included. Results from emulators may not be evaluated.</p>
        </>
      )}
    </div>
  );
}
