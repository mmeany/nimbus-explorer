// Invoke tab: a JSON test event (saved per function, or from a template),
// version / alias, synchronous or asynchronous, and the result: response,
// error, duration / billed time / memory, and the end of the log.
import { useEffect, useState } from "react";
import type { AppError } from "../../api/core";
import { lambdaApi, type FunctionDetails, type InvokeResult, type TestEvent } from "../../api/lambda";
import { ValueEditor } from "../../components/ValueEditor";
import { ValueView } from "../../components/ValueView";
import type { Shell } from "../../shell/shell";

const TEMPLATES: [string, string][] = [
  ["Empty object", "{}"],
  [
    "API Gateway (HTTP API)",
    JSON.stringify(
      {
        version: "2.0",
        routeKey: "POST /orders",
        rawPath: "/orders",
        headers: { "content-type": "application/json" },
        requestContext: { http: { method: "POST", path: "/orders" } },
        body: '{"id": 1}',
        isBase64Encoded: false,
      },
      null,
      2,
    ),
  ],
  [
    "SQS message",
    JSON.stringify(
      { Records: [{ messageId: "1", receiptHandle: "x", body: '{"id": 1}', attributes: { ApproximateReceiveCount: "1" }, messageAttributes: {}, eventSource: "aws:sqs", eventSourceARN: "arn:aws:sqs:eu-west-2:123456789012:queue" }] },
      null,
      2,
    ),
  ],
  [
    "S3 object created",
    JSON.stringify(
      { Records: [{ eventSource: "aws:s3", eventName: "ObjectCreated:Put", s3: { bucket: { name: "my-bucket", arn: "arn:aws:s3:::my-bucket" }, object: { key: "uploads/file.txt", size: 1024 } } }] },
      null,
      2,
    ),
  ],
  ["EventBridge schedule", JSON.stringify({ version: "0", id: "1", "detail-type": "Scheduled Event", source: "aws.events", time: "2026-01-01T00:00:00Z", resources: [], detail: {} }, null, 2)],
];

export function InvokeTab({ f, shell, eventsKey, onShowLogs }: { f: FunctionDetails; shell: Shell; eventsKey: string; onShowLogs: () => void }) {
  const [payload, setPayload] = useState("{}");
  const [events, setEvents] = useState<TestEvent[]>([]);
  const [chosen, setChosen] = useState("");
  const [qualifier, setQualifier] = useState("");
  const [aliases, setAliases] = useState<string[]>([]);
  const [async, setAsync] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InvokeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    lambdaApi
      .testEvents(eventsKey)
      .then(setEvents)
      .catch(() => setEvents([]));
    lambdaApi
      .versions(f.name)
      .then((v) => setAliases([...v.aliases.map((a) => a.name), ...v.versions.filter((x) => x.version !== "$LATEST").map((x) => x.version)]))
      .catch(() => setAliases([]));
  }, [eventsKey, f.name]);

  let problem: string | null = null;
  if (payload.trim()) {
    try {
      JSON.parse(payload);
    } catch (e) {
      problem = `Not valid JSON: ${(e as Error).message}`;
    }
  }

  async function run() {
    if (shell.readOnly || problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await lambdaApi.invoke({ name: f.name, qualifier: qualifier.trim() || null, payload, asynchronous: async }));
    } catch (e) {
      setResult(null);
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveAs() {
    const name = await shell.askName("Save test event", "Name", chosen || "my-event", "Save", (v) => (!v.trim() ? "Enter a name" : v.length > 100 ? "At most 100 characters" : null));
    if (!name) return;
    try {
      setEvents(await lambdaApi.saveTestEvent(eventsKey, name.trim(), payload));
      setChosen(name.trim());
      shell.showFlash(`Saved test event ${name.trim()}.`);
    } catch (e) {
      shell.showError(e);
    }
  }

  async function remove() {
    if (!chosen) return;
    const ok = await shell.ask("Delete test event", <p>Delete the saved event "{chosen}"? (Only the saved copy here; nothing in AWS changes.)</p>, [
      { label: "Delete", value: "yes", danger: true },
      { label: "Cancel", value: "no" },
    ], "no");
    if (ok !== "yes") return;
    try {
      setEvents(await lambdaApi.deleteTestEvent(eventsKey, chosen));
      setChosen("");
    } catch (e) {
      shell.showError(e);
    }
  }

  const r = result?.report;
  const ms = (n: number | null | undefined) => (n === null || n === undefined ? "" : `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} ms`);

  return (
    <div className="invoke-tab">
      <div className="row invoke-bar">
        <select
          className="text-input"
          aria-label="Saved test events"
          value={chosen}
          onChange={(e) => {
            const ev = events.find((x) => x.name === e.target.value);
            setChosen(e.target.value);
            if (ev) setPayload(ev.payload);
          }}
        >
          <option value="">{events.length ? `Saved events (${events.length})` : "No saved events"}</option>
          {events.map((e) => (
            <option key={e.name} value={e.name}>
              {e.name}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!!problem} onClick={() => void saveAs()}>
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
            const t = TEMPLATES.find(([n]) => n === e.target.value);
            if (t) {
              setPayload(t[1]);
              setChosen("");
            }
          }}
        >
          <option value="">Start from a template…</option>
          {TEMPLATES.map(([n]) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.preventDefault(), void run())}>
        <ValueEditor value={payload} onChange={setPayload} rows={12} placeholder="{}" />
      </div>
      <div className="row invoke-bar">
        <label className="form-label" htmlFor="inv-q">
          Version or alias
        </label>
        <input id="inv-q" className="text-input mono inv-qualifier" list="inv-quals" placeholder="$LATEST" value={qualifier} onChange={(e) => setQualifier(e.target.value)} />
        <datalist id="inv-quals">
          {aliases.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
        <label className="check-row inline" title="Lambda queues the event and returns at once; retries and destinations apply">
          <input type="checkbox" checked={async} onChange={(e) => setAsync(e.target.checked)} /> Asynchronous
        </label>
        <div className="spacer" />
        <button className="btn primary" disabled={shell.readOnly || !!problem || busy} title="Ctrl+Enter" onClick={() => void run()}>
          {busy ? "Invoking…" : "Invoke"}
        </button>
      </div>
      {shell.readOnly && <div className="hint">Read-only mode: invoking is disabled, because a function can change things.</div>}
      {problem && <div className="field-error">{problem}</div>}
      {error && <div className="field-error">{error}</div>}
      {result && (
        <div className="invoke-result">
          {async ? (
            <div className="ok-note">
              Queued (status {result.statusCode}). The result goes to the function's log and any destinations.{" "}
              <button className="link-btn" onClick={onShowLogs}>
                Show logs
              </button>
            </div>
          ) : (
            <>
              <div className={result.functionError ? "warn-note" : "ok-note"}>
                {result.functionError ? `The function returned an error (${result.functionError}).` : `Succeeded (status ${result.statusCode}).`}
                {result.executedVersion ? ` Version ${result.executedVersion}.` : ""}
              </div>
              {r && (
                <div className="stat-tiles invoke-stats">
                  <div>
                    <span className="hint">Duration</span>
                    <b>{ms(r.durationMs)}</b>
                  </div>
                  <div>
                    <span className="hint">Billed</span>
                    <b>{ms(r.billedMs)}</b>
                  </div>
                  <div>
                    <span className="hint">Memory used</span>
                    <b>{r.maxMemoryUsedMb !== null ? `${r.maxMemoryUsedMb} of ${r.memoryMb ?? "?"} MB` : ""}</b>
                  </div>
                  {r.initMs !== null && (
                    <div>
                      <span className="hint">Cold start (init)</span>
                      <b>{ms(r.initMs)}</b>
                    </div>
                  )}
                </div>
              )}
              <div className="props-section">
                Response
                <button className="link-btn" onClick={() => void shell.copyText(result.payload)}>
                  Copy
                </button>
              </div>
              {result.payload ? <ValueView value={result.payload} /> : <p className="hint">(empty)</p>}
              {result.logTail && (
                <>
                  <div className="props-section">
                    Log (last 4 KB)
                    <button className="link-btn" onClick={onShowLogs}>
                      Show all logs
                    </button>
                  </div>
                  <pre className="log-text selectable">{result.logTail}</pre>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
