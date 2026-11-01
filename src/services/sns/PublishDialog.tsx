// Publish one message (subject, body or a message per protocol, attributes,
// FIFO ids) or every message in a JSON array / JSON-lines file.
import { useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { api } from "../../api/s3";
import { snsPublishApi, type PublishReport, type TopicInfo } from "../../api/sns";
import type { MsgAttribute } from "../../api/sqs";
import { ValueEditor } from "../../components/ValueEditor";
import type { Shell } from "../../shell/shell";
import { attributeProblem } from "../sqs/SendMessageDialog";

interface Props {
  topic: TopicInfo;
  shell: Shell;
  onClose: () => void;
  onSent: () => void;
}

const ATTR_TYPES = ["String", "String.Array", "Number", "Binary"];
const MAX_BYTES = 262144;
/** Protocol keys a per-protocol message can have (besides "default"). */
const STRUCTURE_KEYS = ["sqs", "lambda", "http", "https", "email", "email-json", "sms", "firehose"];

/** SQS rules plus String.Array (a JSON array). */
export function snsAttributeProblem(a: MsgAttribute[]): string | null {
  for (const x of a) {
    if (x.dataType !== "String.Array") continue;
    try {
      if (!Array.isArray(JSON.parse(x.value))) throw new Error();
    } catch {
      return `Attribute "${x.name.trim()}" must be a JSON array, e.g. ["a", "b"]`;
    }
  }
  return attributeProblem(a.map((x) => (x.dataType === "String.Array" ? { ...x, dataType: "String" } : x)));
}

/** The body PublishBatch / Publish gets for a per-protocol message. */
export function structuredBody(defaultMsg: string, perProtocol: { key: string; text: string }[]): string {
  const o: Record<string, string> = { default: defaultMsg };
  for (const p of perProtocol) if (p.key) o[p.key] = p.text;
  return JSON.stringify(o);
}

export function PublishDialog({ topic, shell, onClose, onSent }: Props) {
  const [tab, setTab] = useState<"one" | "file">("one");
  const fifo = topic.fifo;
  const contentDedup = topic.contentBasedDedup;
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [structured, setStructured] = useState(false);
  const [perProtocol, setPerProtocol] = useState<{ key: string; text: string }[]>([]);
  const [attrs, setAttrs] = useState<MsgAttribute[]>([]);
  const [groupId, setGroupId] = useState("");
  const [dedupId, setDedupId] = useState("");
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [envelope, setEnvelope] = useState(false);
  const [preview, setPreview] = useState<{ count: number; samples: string[] } | null>(null);
  const [report, setReport] = useState<PublishReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const message = structured ? structuredBody(body, perProtocol) : body;
  const size = useMemo(
    () => new TextEncoder().encode(message).length + attrs.reduce((n, a) => n + a.name.length + a.dataType.length + a.value.length, 0),
    [message, attrs],
  );
  const subjectProblem = subject && (subject.length > 100 || /[\r\n\t]/.test(subject)) ? "The subject must be under 100 characters, on one line" : null;

  let problem: string | null;
  if (tab === "one") {
    const keys = perProtocol.map((p) => p.key);
    problem = !body
      ? structured
        ? "Enter the default message"
        : "Enter a message"
      : size > MAX_BYTES
        ? `The message is ${size.toLocaleString()} bytes; SNS allows ${MAX_BYTES.toLocaleString()}`
        : (subjectProblem ??
          (structured && keys.some((k) => !k) ? "Choose a protocol for each message" : null) ??
          (structured && new Set(keys).size !== keys.length ? "Each protocol can have one message" : null) ??
          snsAttributeProblem(attrs) ??
          (fifo && !groupId.trim() ? "FIFO topics need a message group ID" : null) ??
          (fifo && !contentDedup && !dedupId.trim() ? "Enter a deduplication ID (content-based deduplication is off)" : null));
  } else {
    problem = !preview ? "Choose a file" : (subjectProblem ?? (fifo && !groupId.trim() && !envelope ? "FIFO topics need a message group ID" : null));
  }

  async function publishOne() {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const r = await snsPublishApi.publish(topic.arn, {
        body: message,
        subject: subject.trim() || null,
        messageStructure: structured ? "json" : null,
        attributes: attrs.map((a) => ({ ...a, name: a.name.trim(), value: a.dataType === "String" ? a.value : a.value.trim() })),
        groupId: fifo ? groupId.trim() : null,
        dedupId: fifo && dedupId.trim() ? dedupId.trim() : null,
      });
      setLastSent(r.messageId + (r.sequenceNumber ? ` (sequence ${r.sequenceNumber})` : ""));
      if (fifo && !contentDedup) setDedupId("");
      onSent();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function chooseFile() {
    const p = await api.pickOpenFile("Messages to publish", "JSON / JSON lines", ["json", "jsonl", "ndjson", "txt"]);
    if (!p) return;
    setPath(p);
    await loadPreview(p, envelope);
  }

  async function loadPreview(p: string, env: boolean) {
    setPreview(null);
    setReport(null);
    setError(null);
    try {
      setPreview(await snsPublishApi.previewFile(p, env));
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    }
  }

  async function publishFile() {
    if (!path || !preview || problem) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await snsPublishApi.publishFile(topic.arn, path, envelope, fifo && groupId.trim() ? groupId.trim() : null, subject.trim() || null));
      onSent();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog param-dialog send-dialog"
        role="dialog"
        aria-modal
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="dialog-title">
          Publish to <span className="mono">{topic.name}</span>
        </div>
        <div className="dialog-body">
          <div className="segmented small">
            <button className={tab === "one" ? "active" : ""} onClick={() => setTab("one")}>
              One message
            </button>
            <button className={tab === "file" ? "active" : ""} onClick={() => setTab("file")}>
              From a file
            </button>
          </div>

          <div className="pe-grid">
            <label className="form-label" htmlFor="pd-subject">
              Subject
            </label>
            <input
              id="pd-subject"
              className="text-input"
              value={subject}
              placeholder={tab === "file" ? "Optional; for messages without one" : "Optional; used by email subscriptions"}
              onChange={(e) => setSubject(e.target.value)}
            />
            {fifo && (
              <>
                <label className="form-label" htmlFor="pd-group">
                  Message group ID
                </label>
                <input
                  id="pd-group"
                  className="text-input mono"
                  value={groupId}
                  placeholder={tab === "file" ? "For messages without one" : "e.g. customer-42"}
                  onChange={(e) => setGroupId(e.target.value)}
                />
                {tab === "one" && (
                  <>
                    <label className="form-label" htmlFor="pd-dedup">
                      Deduplication ID
                    </label>
                    <input
                      id="pd-dedup"
                      className="text-input mono"
                      value={dedupId}
                      placeholder={contentDedup ? "Optional: content-based deduplication is on" : "Required"}
                      onChange={(e) => setDedupId(e.target.value)}
                    />
                  </>
                )}
              </>
            )}
          </div>

          {tab === "one" ? (
            <>
              <label className="check-row">
                <input type="checkbox" checked={structured} onChange={(e) => setStructured(e.target.checked)} /> Different message per protocol
                (message structure: JSON)
              </label>
              <div className="row pe-value-head">
                <span className="form-label">{structured ? "Default message (for protocols not listed below)" : "Message"}</span>
                <div className="spacer" />
                <span className={`hint ${size > MAX_BYTES ? "danger-text" : ""}`}>
                  {size.toLocaleString()} / {MAX_BYTES.toLocaleString()} bytes
                </span>
              </div>
              <ValueEditor value={body} onChange={setBody} rows={structured ? 5 : 10} placeholder='Text or JSON, e.g. {"orderId": 42}' />

              {structured && (
                <>
                  {perProtocol.map((p, i) => (
                    <div key={i} className="pd-protocol">
                      <div className="row">
                        <select
                          className="text-input"
                          value={p.key}
                          onChange={(e) => setPerProtocol(perProtocol.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                        >
                          <option value="">Protocol…</option>
                          {STRUCTURE_KEYS.map((k) => (
                            <option key={k} value={k}>
                              {k}
                            </option>
                          ))}
                        </select>
                        <div className="spacer" />
                        <button className="link-btn" onClick={() => setPerProtocol(perProtocol.filter((_, j) => j !== i))}>
                          Remove
                        </button>
                      </div>
                      <ValueEditor
                        value={p.text}
                        onChange={(v) => setPerProtocol(perProtocol.map((x, j) => (j === i ? { ...x, text: v } : x)))}
                        rows={3}
                        placeholder={p.key === "sms" ? "Short text for SMS" : "Message for this protocol"}
                      />
                    </div>
                  ))}
                  <div className="row">
                    <button
                      className="link-btn"
                      disabled={perProtocol.length >= STRUCTURE_KEYS.length}
                      onClick={() => setPerProtocol([...perProtocol, { key: STRUCTURE_KEYS.find((k) => !perProtocol.some((p) => p.key === k)) ?? "", text: "" }])}
                    >
                      + Add a message for a protocol
                    </button>
                  </div>
                </>
              )}

              <div className="props-section">Message attributes (subscription filter policies match these)</div>
              {attrs.length > 0 && (
                <table className="tag-table">
                  <tbody>
                    {attrs.map((a, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            className="text-input"
                            placeholder="Name"
                            value={a.name}
                            onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                          />
                        </td>
                        <td style={{ width: 120 }}>
                          <select
                            className="text-input"
                            value={a.dataType}
                            onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, dataType: e.target.value } : x)))}
                          >
                            {ATTR_TYPES.map((t) => (
                              <option key={t}>{t}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            className="text-input"
                            placeholder={a.dataType === "Binary" ? "Base64" : a.dataType === "String.Array" ? '["a", "b"]' : "Value"}
                            value={a.value}
                            onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                          />
                        </td>
                        <td>
                          <button className="link-btn" onClick={() => setAttrs(attrs.filter((_, j) => j !== i))}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="row">
                <button className="link-btn" disabled={attrs.length >= 10} onClick={() => setAttrs([...attrs, { name: "", dataType: "String", value: "" }])}>
                  + Add attribute
                </button>
              </div>
              {lastSent && <div className="ok-note">Published. Message ID {lastSent}</div>}
            </>
          ) : (
            <>
              <div className="row">
                <button className="btn" onClick={() => void chooseFile()}>
                  Choose file…
                </button>
                <span className="mono io-path">{path ?? "A JSON array or JSON lines (one message per line)"}</span>
              </div>
              <fieldset className="radio-group">
                <legend>Each item is</legend>
                <label>
                  <input
                    type="radio"
                    checked={!envelope}
                    onChange={() => {
                      setEnvelope(false);
                      if (path) void loadPreview(path, false);
                    }}
                  />{" "}
                  The message (objects are published as JSON text)
                </label>
                <label>
                  <input
                    type="radio"
                    checked={envelope}
                    onChange={() => {
                      setEnvelope(true);
                      if (path) void loadPreview(path, true);
                    }}
                  />{" "}
                  {'An envelope: {"body": …, "subject", "messageStructure", "attributes": [{"name", "dataType", "value"}], "groupId", "dedupId"}'}
                </label>
              </fieldset>
              {preview && (
                <>
                  <div className="hint">
                    {preview.count.toLocaleString()} message{preview.count === 1 ? "" : "s"}, published 10 per request. First {preview.samples.length}:
                  </div>
                  <pre className="value-text send-samples">{preview.samples.join("\n")}</pre>
                </>
              )}
              {report && (
                <div className={report.failed.length ? "warn-note" : "ok-note"}>
                  Published {report.sent.toLocaleString()}
                  {report.failed.length > 0 && (
                    <>
                      ; {report.failed.length} failed:
                      <ul className="name-list">
                        {report.failed.slice(0, 20).map((f) => (
                          <li key={f.index}>
                            #{f.index + 1}: {f.message}
                          </li>
                        ))}
                        {report.failed.length > 20 && <li>…and {report.failed.length - 20} more</li>}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </>
          )}
          {problem && (tab === "file" ? !!path : !!body || attrs.length > 0 || !!subject) && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          {shell.readOnly && <span className="hint">Read-only mode</span>}
          <div className="spacer" />
          {tab === "one" ? (
            <button className="btn primary" disabled={!!problem || busy || shell.readOnly} onClick={() => void publishOne()}>
              {busy ? "Publishing…" : lastSent ? "Publish again" : "Publish"}
            </button>
          ) : (
            <button className="btn primary" disabled={!!problem || busy || shell.readOnly || !!report} onClick={() => void publishFile()}>
              {busy ? "Publishing…" : preview ? `Publish ${preview.count.toLocaleString()}` : "Publish"}
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
