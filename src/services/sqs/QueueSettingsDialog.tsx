// Create a queue, or edit an existing queue's attributes and tags.
import type { QueueChoice } from "./RedriveDialog";
import { useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { formatSeconds, queueNameFromArn, sqsApi, type QueueInfo } from "../../api/sqs";
import { ValueEditor, jsonProblem } from "../../components/ValueEditor";
import { formatSize } from "../../format";

export interface QueueForm {
  name: string;
  fifo: boolean;
  visibility: string;
  retention: string;
  delay: string;
  maxSize: string;
  wait: string;
  dlqEnabled: boolean;
  dlqName: string;
  maxReceive: string;
  encryption: "none" | "sqs" | "kms";
  kmsKey: string;
  kmsReuse: string;
  contentDedup: boolean;
  /** FIFO high throughput: dedup per message group + limit per group id. */
  highThroughput: boolean;
  policy: string;
}

export const DEFAULT_FORM: QueueForm = {
  name: "",
  fifo: false,
  visibility: "30",
  retention: "345600",
  delay: "0",
  maxSize: "262144",
  wait: "0",
  dlqEnabled: false,
  dlqName: "",
  maxReceive: "3",
  encryption: "sqs",
  kmsKey: "alias/aws/sqs",
  kmsReuse: "300",
  contentDedup: false,
  highThroughput: false,
  policy: "",
};

/** Form values for an existing queue. */
export function formFromQueue(q: QueueInfo): QueueForm {
  const a = q.attributes;
  return {
    name: q.name,
    fifo: q.fifo,
    visibility: a.VisibilityTimeout ?? DEFAULT_FORM.visibility,
    retention: a.MessageRetentionPeriod ?? DEFAULT_FORM.retention,
    delay: a.DelaySeconds ?? DEFAULT_FORM.delay,
    maxSize: a.MaximumMessageSize ?? DEFAULT_FORM.maxSize,
    wait: a.ReceiveMessageWaitTimeSeconds ?? DEFAULT_FORM.wait,
    dlqEnabled: !!q.dlqArn,
    dlqName: queueNameFromArn(q.dlqArn) ?? "",
    maxReceive: String(q.maxReceiveCount ?? DEFAULT_FORM.maxReceive),
    encryption: a.KmsMasterKeyId ? "kms" : a.SqsManagedSseEnabled === "true" ? "sqs" : "none",
    kmsKey: a.KmsMasterKeyId ?? DEFAULT_FORM.kmsKey,
    kmsReuse: a.KmsDataKeyReusePeriodSeconds ?? DEFAULT_FORM.kmsReuse,
    contentDedup: a.ContentBasedDeduplication === "true",
    highThroughput: a.DeduplicationScope === "messageGroup" && a.FifoThroughputLimit === "perMessageGroupId",
    policy: a.Policy ? prettyJson(a.Policy) : "",
  };
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

/** Every attribute the form describes (dlqArn resolves the DLQ name). */
export function formAttributes(f: QueueForm, dlqArn: string | null, creating: boolean): Record<string, string> {
  const out: Record<string, string> = {
    VisibilityTimeout: f.visibility.trim(),
    MessageRetentionPeriod: f.retention.trim(),
    DelaySeconds: f.delay.trim(),
    MaximumMessageSize: f.maxSize.trim(),
    ReceiveMessageWaitTimeSeconds: f.wait.trim(),
    RedrivePolicy: f.dlqEnabled && dlqArn ? JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: Number(f.maxReceive) }) : "",
    Policy: f.policy.trim() ? JSON.stringify(JSON.parse(f.policy)) : "",
  };
  if (f.encryption === "kms") {
    out.KmsMasterKeyId = f.kmsKey.trim();
    out.KmsDataKeyReusePeriodSeconds = f.kmsReuse.trim();
  } else {
    out.SqsManagedSseEnabled = f.encryption === "sqs" ? "true" : "false";
    out.KmsMasterKeyId = "";
  }
  if (f.fifo) {
    if (creating) out.FifoQueue = "true";
    out.ContentBasedDeduplication = String(f.contentDedup);
    out.DeduplicationScope = f.highThroughput ? "messageGroup" : "queue";
    out.FifoThroughputLimit = f.highThroughput ? "perMessageGroupId" : "perQueue";
  }
  if (creating) {
    // Empty values mean "not set" when creating.
    for (const k of Object.keys(out)) if (out[k] === "") delete out[k];
  }
  return out;
}

/** Attributes whose value differs from `before`. */
export function changedAttributes(after: Record<string, string>, before: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(after)) if ((before[k] ?? "") !== v) out[k] = v;
  return out;
}

const RANGES: [keyof QueueForm, string, number, number][] = [
  ["visibility", "Visibility timeout", 0, 43200],
  ["retention", "Message retention", 60, 1209600],
  ["delay", "Delivery delay", 0, 900],
  ["maxSize", "Maximum message size", 1024, 1048576],
  ["wait", "Receive wait time", 0, 20],
];

export function formProblem(f: QueueForm, creating: boolean): string | null {
  if (creating) {
    const n = f.name.trim();
    if (!n) return "Enter a queue name";
    if (n.length > 80) return "Queue names can be at most 80 characters";
    if (f.fifo && !n.endsWith(".fifo")) return "FIFO queue names must end in .fifo";
    if (!f.fifo && n.endsWith(".fifo")) return "Only FIFO queues can end in .fifo";
    if (!/^[A-Za-z0-9_-]+$/.test(f.fifo ? n.slice(0, -5) : n)) return "Use letters, digits, - and _ only";
  }
  for (const [k, label, min, max] of RANGES) {
    const v = String(f[k]).trim();
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) return `${label} must be a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}`;
  }
  if (f.dlqEnabled) {
    if (!f.dlqName) return "Choose a dead-letter queue";
    if (!/^\d+$/.test(f.maxReceive) || Number(f.maxReceive) < 1 || Number(f.maxReceive) > 1000) return "Maximum receives must be 1 to 1,000";
  }
  if (f.encryption === "kms") {
    if (!f.kmsKey.trim()) return "Enter a KMS key";
    if (!/^\d+$/.test(f.kmsReuse) || Number(f.kmsReuse) < 60 || Number(f.kmsReuse) > 86400) return "Key reuse period must be 60 to 86,400 seconds";
  }
  if (f.policy.trim()) {
    const p = jsonProblem(f.policy) ?? (/^\s*\{/.test(f.policy) ? null : "The access policy must be a JSON object");
    if (p) return `Access policy: ${p}`;
  }
  return null;
}

interface Props {
  /** null = create. */
  queue: QueueInfo | null;
  /** All queues in the region (for choosing a dead-letter queue). */
  queues: QueueChoice[];
  onClose: () => void;
  onSaved: (name: string) => void;
}

export type TagRow = { key: string; value: string };

export function QueueSettingsDialog({ queue, queues, onClose, onSaved }: Props) {
  const creating = !queue;
  const initial = useMemo(() => (queue ? formFromQueue(queue) : DEFAULT_FORM), [queue]);
  const [f, setF] = useState<QueueForm>(initial);
  const [tags, setTags] = useState<TagRow[] | null>(creating ? [] : null);
  const [origTags, setOrigTags] = useState<TagRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<QueueForm>) => setF((x) => ({ ...x, ...patch }));

  useEffect(() => {
    if (!queue) return;
    sqsApi
      .listTags(queue.url)
      .then((t) => {
        const rows = Object.entries(t).map(([key, value]) => ({ key, value }));
        setTags(rows);
        setOrigTags(rows);
      })
      .catch(() => setTags([]));
  }, [queue]);

  // DLQ candidates: same type, not this queue.
  const candidates = queues.filter((q) => q.fifo === f.fifo && q.name !== f.name.trim());
  const dlqArn = candidates.find((q) => q.name === f.dlqName)?.arn ?? (queue && f.dlqName === initial.dlqName ? queue.dlqArn : null);

  const problem = formProblem(f, creating) ?? tagProblem(tags ?? []);
  const tagMap = Object.fromEntries((tags ?? []).map((t) => [t.key.trim(), t.value]));

  async function save() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        await sqsApi.createQueue(f.name.trim(), formAttributes(f, dlqArn, true), tagMap);
        onSaved(f.name.trim());
      } else {
        const changes = changedAttributes(formAttributes(f, dlqArn, false), formAttributes(initial, queue!.dlqArn, false));
        await sqsApi.setAttributes(queue!.url, changes);
        if (JSON.stringify(tags) !== JSON.stringify(origTags)) await sqsApi.setTags(queue!.url, tagMap);
        onSaved(queue!.name);
      }
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const secondsField = (k: keyof QueueForm, label: string, hint?: string) => (
    <>
      <label className="form-label" htmlFor={`qs-${k}`}>
        {label}
      </label>
      <div className="row">
        <input id={`qs-${k}`} className="text-input num-input" value={String(f[k])} onChange={(e) => set({ [k]: e.target.value } as Partial<QueueForm>)} />
        <span className="hint">seconds{/^\d+$/.test(String(f[k])) && Number(f[k]) >= 60 ? ` (${formatSeconds(String(f[k]))})` : ""}{hint ? ` · ${hint}` : ""}</span>
      </div>
    </>
  );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog queue-settings" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">{creating ? "New queue" : `Edit queue · ${queue!.name}`}</div>
        <div className="dialog-body">
          {creating && (
            <>
              <fieldset className="radio-group inline">
                <legend>Type</legend>
                <label>
                  <input type="radio" checked={!f.fifo} onChange={() => set({ fifo: false, name: f.name.replace(/\.fifo$/, ""), dlqName: "" })} /> Standard
                </label>
                <label>
                  <input type="radio" checked={f.fifo} onChange={() => set({ fifo: true, name: f.name && !f.name.endsWith(".fifo") ? f.name + ".fifo" : f.name, dlqName: "" })} /> FIFO
                  (ordered, exactly-once)
                </label>
              </fieldset>
              <label className="form-label" htmlFor="qs-name">
                Name
              </label>
              <input id="qs-name" className="text-input mono" autoFocus value={f.name} spellCheck={false} placeholder={f.fifo ? "orders.fifo" : "orders"} onChange={(e) => set({ name: e.target.value })}
                onBlur={() => f.fifo && f.name.trim() && !f.name.trim().endsWith(".fifo") && set({ name: f.name.trim() + ".fifo" })}
              />
            </>
          )}

          <div className="pe-grid">
            {secondsField("visibility", "Visibility timeout", "0 to 12 hours")}
            {secondsField("retention", "Message retention", "1 minute to 14 days")}
            {secondsField("delay", "Delivery delay", "0 to 15 minutes")}
            <label className="form-label" htmlFor="qs-maxSize">
              Maximum message size
            </label>
            <div className="row">
              <input id="qs-maxSize" className="text-input num-input" value={f.maxSize} onChange={(e) => set({ maxSize: e.target.value })} />
              <span className="hint">bytes{/^\d+$/.test(f.maxSize) ? ` (${formatSize(Number(f.maxSize))})` : ""} · 1 KB to 1 MB</span>
            </div>
            {secondsField("wait", "Receive wait time", "0 to 20; above 0 = long polling")}
          </div>

          <div className="props-section">Dead-letter queue</div>
          <label className="check-row">
            <input type="checkbox" checked={f.dlqEnabled} onChange={(e) => set({ dlqEnabled: e.target.checked })} /> Move messages that keep failing to another queue
          </label>
          {f.dlqEnabled && (
            <div className="pe-grid">
              <label className="form-label" htmlFor="qs-dlq">
                Queue
              </label>
              <select id="qs-dlq" className="text-input" value={f.dlqName} onChange={(e) => set({ dlqName: e.target.value })}>
                <option value="">Choose a {f.fifo ? "FIFO " : ""}queue…</option>
                {candidates.map((q) => (
                  <option key={q.name} value={q.name}>
                    {q.name}
                  </option>
                ))}
                {f.dlqName && !candidates.some((q) => q.name === f.dlqName) && <option value={f.dlqName}>{f.dlqName}</option>}
              </select>
              <label className="form-label" htmlFor="qs-mr">
                Maximum receives
              </label>
              <div className="row">
                <input id="qs-mr" className="text-input num-input" value={f.maxReceive} onChange={(e) => set({ maxReceive: e.target.value })} />
                <span className="hint">receives before a message moves</span>
              </div>
            </div>
          )}

          <div className="props-section">Encryption</div>
          <fieldset className="radio-group inline">
            <label>
              <input type="radio" checked={f.encryption === "none"} onChange={() => set({ encryption: "none" })} /> None
            </label>
            <label>
              <input type="radio" checked={f.encryption === "sqs"} onChange={() => set({ encryption: "sqs" })} /> SQS-managed (SSE-SQS)
            </label>
            <label>
              <input type="radio" checked={f.encryption === "kms"} onChange={() => set({ encryption: "kms" })} /> KMS key (SSE-KMS)
            </label>
          </fieldset>
          {f.encryption === "kms" && (
            <div className="pe-grid">
              <label className="form-label" htmlFor="qs-kms">
                KMS key
              </label>
              <input id="qs-kms" className="text-input mono" value={f.kmsKey} spellCheck={false} onChange={(e) => set({ kmsKey: e.target.value })} />
              {secondsField("kmsReuse", "Key reuse period", "1 minute to 24 hours")}
            </div>
          )}

          {f.fifo && (
            <>
              <div className="props-section">FIFO</div>
              <label className="check-row">
                <input type="checkbox" checked={f.contentDedup} onChange={(e) => set({ contentDedup: e.target.checked })} /> Content-based deduplication (no
                deduplication ID needed when sending)
              </label>
              <label className="check-row">
                <input type="checkbox" checked={f.highThroughput} onChange={(e) => set({ highThroughput: e.target.checked })} /> High throughput (deduplication
                and limits per message group)
              </label>
            </>
          )}

          <div className="props-section">Access policy (optional JSON)</div>
          <ValueEditor value={f.policy} onChange={(v) => set({ policy: v })} rows={4} placeholder='{"Version": "2012-10-17", "Statement": [...]}' />

          <div className="props-section">Tags</div>
          {tags === null ? (
            <div className="hint">Loading…</div>
          ) : (
            <TagRows tags={tags} onChange={setTags} />
          )}

          {problem && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" disabled={!!problem || busy} onClick={() => void save()}>
            {busy ? "Saving…" : creating ? "Create queue" : "Save"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function tagProblem(tags: TagRow[]): string | null {
  const keys = new Set<string>();
  for (const t of tags) {
    const k = t.key.trim();
    if (!k) return "Every tag needs a key";
    if (k.length > 128 || t.value.length > 256) return `Tag "${k}" is too long (key 128, value 256)`;
    if (/^aws:/i.test(k)) return 'Tag keys can\'t begin with "aws:"';
    if (keys.has(k)) return `Duplicate tag key "${k}"`;
    keys.add(k);
  }
  return tags.length > 50 ? "At most 50 tags" : null;
}

/** Simple key/value rows editor. */
export function TagRows({ tags, onChange, disabled }: { tags: TagRow[]; onChange: (t: TagRow[]) => void; disabled?: boolean }) {
  return (
    <>
      <table className="tag-table">
        <tbody>
          {tags.map((t, i) => (
            <tr key={i}>
              <td>
                <input className="text-input" placeholder="Key" value={t.key} disabled={disabled} onChange={(e) => onChange(tags.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
              </td>
              <td>
                <input className="text-input" placeholder="Value" value={t.value} disabled={disabled} onChange={(e) => onChange(tags.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              </td>
              <td>
                <button className="link-btn" disabled={disabled} onClick={() => onChange(tags.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button className="link-btn" disabled={disabled || tags.length >= 50} onClick={() => onChange([...tags, { key: "", value: "" }])}>
          + Add tag
        </button>
      </div>
    </>
  );
}
