// Send one message (body, attributes, delay, FIFO ids) or a batch from a file.
import { useState } from "react";
import type { AppError } from "../../api/core";
import { api } from "../../api/s3";
import { sqsApi, type BatchReport, type MsgAttribute, type QueueInfo } from "../../api/sqs";
import { ValueEditor } from "../../components/ValueEditor";
import type { Shell } from "../../shell/shell";

interface Props {
  queue: QueueInfo;
  shell: Shell;
  onClose: () => void;
  onSent: () => void;
}

const ATTR_TYPES = ["String", "Number", "Binary"];

export function attributeProblem(a: MsgAttribute[]): string | null {
  const names = new Set<string>();
  for (const x of a) {
    const n = x.name.trim();
    if (!n) return "Every attribute needs a name";
    if (n.length > 256 || !/^[A-Za-z0-9_.-]+$/.test(n)) return `Attribute "${n}": use letters, digits, _ - . (up to 256)`;
    if (/^(aws\.|amazon\.)/i.test(n) || n.startsWith(".") || n.endsWith(".") || n.includes("..")) return `Attribute "${n}" isn't an allowed name`;
    if (names.has(n)) return `Duplicate attribute "${n}"`;
    names.add(n);
    if (!x.value) return `Attribute "${n}" needs a value`;
    if (x.dataType === "Number" && !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(x.value.trim())) return `Attribute "${n}" must be a number`;
    if (x.dataType === "Binary" && !/^[A-Za-z0-9+/]+={0,2}$/.test(x.value.trim())) return `Attribute "${n}" must be base64`;
  }
  return a.length > 10 ? "At most 10 attributes" : null;
}

export function SendMessageDialog({ queue, shell, onClose, onSent }: Props) {
  const [tab, setTab] = useState<"one" | "file">("one");
  const fifo = queue.fifo;
  const contentDedup = queue.attributes.ContentBasedDeduplication === "true";
  // Single message
  const [body, setBody] = useState("");
  const [attrs, setAttrs] = useState<MsgAttribute[]>([]);
  const [delay, setDelay] = useState("");
  const [groupId, setGroupId] = useState("");
  const [dedupId, setDedupId] = useState("");
  const [lastSent, setLastSent] = useState<string | null>(null);
  // From file
  const [path, setPath] = useState<string | null>(null);
  const [envelope, setEnvelope] = useState(false);
  const [preview, setPreview] = useState<{ count: number; samples: string[] } | null>(null);
  const [report, setReport] = useState<BatchReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxSize = Number(queue.attributes.MaximumMessageSize ?? 262144);
  const size = new TextEncoder().encode(body).length;
  const problem =
    tab === "one"
      ? !body
        ? "Enter a message body"
        : size > maxSize
          ? `The body is ${size.toLocaleString()} bytes; this queue allows ${maxSize.toLocaleString()}`
          : attributeProblem(attrs) ??
            (delay && (!/^\d+$/.test(delay) || Number(delay) > 900) ? "Delay must be 0 to 900 seconds" : null) ??
            (fifo && !groupId.trim() ? "FIFO queues need a message group ID" : null) ??
            (fifo && !contentDedup && !dedupId.trim() ? "Enter a deduplication ID (content-based deduplication is off)" : null)
      : !preview
        ? "Choose a file"
        : fifo && !groupId.trim() && !envelope
          ? "FIFO queues need a message group ID"
          : null;

  async function sendOne() {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const r = await sqsApi.send(queue.url, {
        body,
        attributes: attrs.map((a) => ({ ...a, name: a.name.trim(), value: a.dataType === "String" ? a.value : a.value.trim() })),
        delaySeconds: !fifo && delay ? Number(delay) : null,
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
    const p = await api.pickOpenFile("Messages to send", "JSON / JSON lines", ["json", "jsonl", "ndjson", "txt"]);
    if (!p) return;
    setPath(p);
    await loadPreview(p, envelope);
  }

  async function loadPreview(p: string, env: boolean) {
    setPreview(null);
    setReport(null);
    setError(null);
    try {
      setPreview(await sqsApi.previewFile(p, env));
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    }
  }

  async function sendFile() {
    if (!path || !preview || problem) return;
    setBusy(true);
    setError(null);
    try {
      const r = await sqsApi.sendFile(queue.url, path, envelope, fifo && groupId.trim() ? groupId.trim() : null);
      setReport(r);
      onSent();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog send-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">
          Send to <span className="mono">{queue.name}</span>
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

          {fifo && (
            <div className="pe-grid">
              <label className="form-label" htmlFor="sm-group">
                Message group ID
              </label>
              <input id="sm-group" className="text-input mono" value={groupId} placeholder={tab === "file" ? "For messages without one" : "e.g. customer-42"} onChange={(e) => setGroupId(e.target.value)} />
              {tab === "one" && (
                <>
                  <label className="form-label" htmlFor="sm-dedup">
                    Deduplication ID
                  </label>
                  <input
                    id="sm-dedup"
                    className="text-input mono"
                    value={dedupId}
                    placeholder={contentDedup ? "Optional: content-based deduplication is on" : "Required"}
                    onChange={(e) => setDedupId(e.target.value)}
                  />
                </>
              )}
            </div>
          )}

          {tab === "one" ? (
            <>
              <div className="row pe-value-head">
                <span className="form-label">Body</span>
                <div className="spacer" />
                <span className={`hint ${size > maxSize ? "danger-text" : ""}`}>
                  {size.toLocaleString()} / {maxSize.toLocaleString()} bytes
                </span>
              </div>
              <ValueEditor value={body} onChange={setBody} rows={10} placeholder='Text or JSON, e.g. {"orderId": 42}' />

              <div className="props-section">Message attributes</div>
              {attrs.length > 0 && (
                <table className="tag-table">
                  <tbody>
                    {attrs.map((a, i) => (
                      <tr key={i}>
                        <td>
                          <input className="text-input" placeholder="Name" value={a.name} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                        </td>
                        <td style={{ width: 110 }}>
                          <select className="text-input" value={a.dataType} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, dataType: e.target.value } : x)))}>
                            {ATTR_TYPES.map((t) => (
                              <option key={t}>{t}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            className="text-input"
                            placeholder={a.dataType === "Binary" ? "Base64" : "Value"}
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

              {!fifo && (
                <div className="pe-grid">
                  <label className="form-label" htmlFor="sm-delay">
                    Delay
                  </label>
                  <div className="row">
                    <input id="sm-delay" className="text-input num-input" value={delay} placeholder={queue.attributes.DelaySeconds ?? "0"} onChange={(e) => setDelay(e.target.value.trim())} />
                    <span className="hint">seconds (0 to 900); blank uses the queue's delay</span>
                  </div>
                </div>
              )}
              {lastSent && <div className="ok-note">Sent. Message ID {lastSent}</div>}
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
                  The message body (objects are sent as JSON text)
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
                  {'An envelope: {"body": …, "attributes": [{"name", "dataType", "value"}], "groupId", "dedupId", "delaySeconds"}'}
                </label>
              </fieldset>
              {preview && (
                <>
                  <div className="hint">
                    {preview.count.toLocaleString()} message{preview.count === 1 ? "" : "s"}, sent 10 per request. First {preview.samples.length}:
                  </div>
                  <pre className="value-text send-samples">{preview.samples.join("\n")}</pre>
                </>
              )}
              {report && (
                <div className={report.failed.length ? "warn-note" : "ok-note"}>
                  Sent {report.sent.toLocaleString()}
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
          {problem && (tab === "file" ? !!path : !!body || attrs.length > 0) && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          {shell.readOnly && <span className="hint">Read-only mode</span>}
          <div className="spacer" />
          {tab === "one" ? (
            <button className="btn primary" disabled={!!problem || busy || shell.readOnly} onClick={() => void sendOne()}>
              {busy ? "Sending…" : lastSent ? "Send again" : "Send"}
            </button>
          ) : (
            <button className="btn primary" disabled={!!problem || busy || shell.readOnly || !!report} onClick={() => void sendFile()}>
              {busy ? "Sending…" : preview ? `Send ${preview.count.toLocaleString()}` : "Send"}
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
