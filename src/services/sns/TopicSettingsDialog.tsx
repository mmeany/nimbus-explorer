// Create a topic, or edit an existing topic's attributes, data protection
// policy and tags.
import { useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { snsApi, snsWriteApi, topicNameProblem, type TopicInfo } from "../../api/sns";
import { ValueEditor, jsonProblem } from "../../components/ValueEditor";
import { TagRows, tagProblem, type TagRow } from "../sqs/QueueSettingsDialog";

export interface TopicForm {
  name: string;
  fifo: boolean;
  displayName: string;
  encrypted: boolean;
  kmsKey: string;
  contentDedup: boolean;
  deliveryPolicy: string;
  policy: string;
  dataProtection: string;
}

export const DEFAULT_TOPIC_FORM: TopicForm = {
  name: "",
  fifo: false,
  displayName: "",
  encrypted: false,
  kmsKey: "alias/aws/sns",
  contentDedup: false,
  deliveryPolicy: "",
  policy: "",
  dataProtection: "",
};

function pretty(s: string | undefined | null): string {
  if (!s) return "";
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

/** Minified JSON for comparing / sending ("" stays ""). */
function compact(s: string): string {
  const t = s.trim();
  if (!t) return "";
  try {
    return JSON.stringify(JSON.parse(t));
  } catch {
    return t;
  }
}

export function formFromTopic(t: TopicInfo, dataProtection: string | null): TopicForm {
  const a = t.attributes;
  return {
    name: t.name,
    fifo: t.fifo,
    displayName: a.DisplayName ?? "",
    encrypted: !!a.KmsMasterKeyId,
    kmsKey: a.KmsMasterKeyId || DEFAULT_TOPIC_FORM.kmsKey,
    contentDedup: a.ContentBasedDeduplication === "true",
    // EffectiveDeliveryPolicy is the default; DeliveryPolicy is only what was set.
    deliveryPolicy: pretty(a.DeliveryPolicy),
    policy: pretty(a.Policy),
    dataProtection: pretty(dataProtection),
  };
}

/** The attributes the form describes (data protection is separate). */
export function topicAttributes(f: TopicForm, creating: boolean): Record<string, string> {
  const out: Record<string, string> = {
    DisplayName: f.displayName,
    KmsMasterKeyId: f.encrypted ? f.kmsKey.trim() : "",
    DeliveryPolicy: compact(f.deliveryPolicy),
    Policy: compact(f.policy),
  };
  if (f.fifo) {
    if (creating) out.FifoTopic = "true";
    out.ContentBasedDeduplication = String(f.contentDedup);
  }
  if (creating) for (const k of Object.keys(out)) if (out[k] === "" || (k === "ContentBasedDeduplication" && out[k] === "false")) delete out[k];
  return out;
}

function jsonObjectProblem(label: string, v: string): string | null {
  if (!v.trim()) return null;
  const p = jsonProblem(v) ?? (/^\s*\{/.test(v) ? null : "must be a JSON object");
  return p ? `${label}: ${p}` : null;
}

export function topicFormProblem(f: TopicForm, creating: boolean, before: TopicForm | null): string | null {
  if (creating) {
    const n = f.name.trim();
    if (!n) return "Enter a topic name";
    const p = topicNameProblem(n, f.fifo);
    if (p) return p;
  }
  if (f.displayName.length > 100) return "Display names can be at most 100 characters";
  if (f.encrypted && !f.kmsKey.trim()) return "Enter a KMS key";
  if (!creating && before?.policy && !f.policy.trim()) return "A topic always has an access policy; edit it rather than clearing it";
  if (!creating && before?.dataProtection && !f.dataProtection.trim())
    return "SNS can't remove a data protection policy; edit its statements instead";
  return (
    jsonObjectProblem("Delivery policy", f.deliveryPolicy) ??
    jsonObjectProblem("Access policy", f.policy) ??
    jsonObjectProblem("Data protection policy", f.dataProtection)
  );
}

interface Props {
  /** null = create. */
  topic: TopicInfo | null;
  onClose: () => void;
  /** warning: something that didn't stick (the rest did). */
  onSaved: (name: string, warning?: string) => void;
}

export function TopicSettingsDialog({ topic, onClose, onSaved }: Props) {
  const creating = !topic;
  const [initial, setInitial] = useState<TopicForm | null>(creating ? DEFAULT_TOPIC_FORM : null);
  const [f, setF] = useState<TopicForm>(DEFAULT_TOPIC_FORM);
  const [dppSupported, setDppSupported] = useState(true);
  const [tags, setTags] = useState<TagRow[] | null>(creating ? [] : null);
  const [origTags, setOrigTags] = useState<TagRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<TopicForm>) => setF((x) => ({ ...x, ...patch }));

  useEffect(() => {
    if (!topic) return;
    let stale = false;
    snsWriteApi
      .getDataProtectionPolicy(topic.arn)
      .catch(() => {
        if (!stale) setDppSupported(false);
        return null;
      })
      .then((dpp) => {
        if (stale) return;
        const form = formFromTopic(topic, dpp);
        setInitial(form);
        setF(form);
      });
    snsApi
      .listTags(topic.arn)
      .then((t) => {
        if (stale) return;
        const rows = t.map(([key, value]) => ({ key, value }));
        setTags(rows);
        setOrigTags(rows);
      })
      .catch(() => !stale && setTags([]));
    return () => {
      stale = true;
    };
  }, [topic]);

  const loading = !initial || tags === null;
  const problem = useMemo(
    () => (loading ? null : (topicFormProblem(f, creating, initial) ?? tagProblem(tags ?? []))),
    [f, creating, initial, tags, loading],
  );

  async function save() {
    if (loading || problem || busy) return;
    setBusy(true);
    setError(null);
    const tagPairs: [string, string][] = (tags ?? []).map((t) => [t.key.trim(), t.value]);
    try {
      if (creating) {
        const name = f.name.trim();
        const arn = await snsWriteApi.createTopic(name, topicAttributes(f, true), tagPairs);
        if (f.dataProtection.trim()) {
          try {
            await snsWriteApi.putDataProtectionPolicy(arn, compact(f.dataProtection));
          } catch (e) {
            // The topic exists now; say what didn't stick rather than failing the whole create.
            onSaved(name, `The data protection policy wasn't saved: ${(e as AppError).message ?? String(e)}`);
            return;
          }
        }
        onSaved(name);
      } else {
        const after = topicAttributes(f, false);
        const before = topicAttributes(initial!, false);
        const changes: Record<string, string> = {};
        for (const [k, v] of Object.entries(after)) if ((before[k] ?? "") !== v) changes[k] = v;
        if (Object.keys(changes).length) await snsWriteApi.setTopicAttributes(topic!.arn, changes);
        if (dppSupported && compact(f.dataProtection) !== compact(initial!.dataProtection)) {
          await snsWriteApi.putDataProtectionPolicy(topic!.arn, compact(f.dataProtection));
        }
        if (JSON.stringify(tags) !== JSON.stringify(origTags)) await snsWriteApi.setTags(topic!.arn, tagPairs);
        onSaved(topic!.name);
      }
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog param-dialog queue-settings"
        role="dialog"
        aria-modal
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="dialog-title">{creating ? "New topic" : `Edit topic · ${topic!.name}`}</div>
        <div className="dialog-body">
          {loading ? (
            <div className="hint">Loading…</div>
          ) : (
            <>
              {creating && (
                <>
                  <fieldset className="radio-group inline">
                    <legend>Type</legend>
                    <label>
                      <input type="radio" checked={!f.fifo} onChange={() => set({ fifo: false, name: f.name.replace(/\.fifo$/, "") })} /> Standard
                    </label>
                    <label>
                      <input
                        type="radio"
                        checked={f.fifo}
                        onChange={() => set({ fifo: true, name: f.name && !f.name.endsWith(".fifo") ? f.name + ".fifo" : f.name })}
                      />{" "}
                      FIFO (ordered, deduplicated; SQS FIFO subscribers only)
                    </label>
                  </fieldset>
                  <label className="form-label" htmlFor="ts-name">
                    Name
                  </label>
                  <input
                    id="ts-name"
                    className="text-input mono"
                    autoFocus
                    value={f.name}
                    spellCheck={false}
                    placeholder={f.fifo ? "orders.fifo" : "orders"}
                    onChange={(e) => set({ name: e.target.value })}
                    onBlur={() => f.fifo && f.name.trim() && !f.name.trim().endsWith(".fifo") && set({ name: f.name.trim() + ".fifo" })}
                  />
                </>
              )}

              <div className="pe-grid">
                <label className="form-label" htmlFor="ts-display">
                  Display name
                </label>
                <div className="row">
                  <input id="ts-display" className="text-input" value={f.displayName} onChange={(e) => set({ displayName: e.target.value })} />
                  <span className="hint">optional; the sender name for SMS and email</span>
                </div>
              </div>

              <div className="props-section">Encryption</div>
              <label className="check-row">
                <input type="checkbox" checked={f.encrypted} onChange={(e) => set({ encrypted: e.target.checked })} /> Encrypt messages at rest with a KMS
                key
              </label>
              {f.encrypted && (
                <div className="pe-grid">
                  <label className="form-label" htmlFor="ts-kms">
                    KMS key
                  </label>
                  <input id="ts-kms" className="text-input mono" value={f.kmsKey} spellCheck={false} onChange={(e) => set({ kmsKey: e.target.value })} />
                </div>
              )}

              {f.fifo && (
                <>
                  <div className="props-section">FIFO</div>
                  <label className="check-row">
                    <input type="checkbox" checked={f.contentDedup} onChange={(e) => set({ contentDedup: e.target.checked })} /> Content-based
                    deduplication (no deduplication ID needed when publishing)
                  </label>
                </>
              )}

              <div className="props-section">Delivery policy (optional JSON; retries for HTTP/S endpoints)</div>
              <ValueEditor
                value={f.deliveryPolicy}
                onChange={(v) => set({ deliveryPolicy: v })}
                rows={4}
                placeholder='{"http": {"defaultHealthyRetryPolicy": {"numRetries": 3, "minDelayTarget": 20, "maxDelayTarget": 20}}}'
              />

              <div className="props-section">Access policy (JSON{creating ? "; optional, SNS creates a default one" : ""})</div>
              <ValueEditor value={f.policy} onChange={(v) => set({ policy: v })} rows={creating ? 4 : 8} placeholder='{"Version": "2008-10-17", "Statement": [...]}' />

              <div className="props-section">Data protection policy (optional JSON)</div>
              {dppSupported ? (
                <ValueEditor
                  value={f.dataProtection}
                  onChange={(v) => set({ dataProtection: v })}
                  rows={4}
                  placeholder='{"Name": "policy", "Version": "2021-06-01", "Statement": [...]}'
                />
              ) : (
                <div className="hint">This endpoint doesn't support data protection policies.</div>
              )}

              <div className="props-section">Tags</div>
              <TagRows tags={tags ?? []} onChange={setTags} />
            </>
          )}

          {problem && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" disabled={loading || !!problem || busy} onClick={() => void save()}>
            {busy ? "Saving…" : creating ? "Create topic" : "Save"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
