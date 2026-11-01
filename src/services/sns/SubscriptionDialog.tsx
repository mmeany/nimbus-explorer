// Create a subscription, or edit an existing one's attributes (filter policy,
// raw delivery, dead-letter queue, delivery policy, Firehose role).
import { useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { PROTOCOLS, endpointProblem, snsWriteApi, topicNameFromArn, type SubscriptionInfo } from "../../api/sns";
import { sqsApi, type QueueRef } from "../../api/sqs";
import { ValueEditor, jsonProblem } from "../../components/ValueEditor";

export interface SubForm {
  topicArn: string;
  protocol: string;
  endpoint: string;
  allowQueue: boolean;
  raw: boolean;
  filterPolicy: string;
  filterScope: "MessageAttributes" | "MessageBody";
  dlqArn: string;
  deliveryPolicy: string;
  roleArn: string;
}

const RAW_PROTOCOLS = ["sqs", "http", "https", "firehose"];

function pretty(s: string | undefined): string {
  if (!s) return "";
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function compact(s: string): string {
  const t = s.trim();
  if (!t) return "";
  try {
    return JSON.stringify(JSON.parse(t));
  } catch {
    return t;
  }
}

export function formFromAttributes(sub: SubscriptionInfo, a: Record<string, string>): SubForm {
  let dlqArn = "";
  try {
    dlqArn = a.RedrivePolicy ? (JSON.parse(a.RedrivePolicy).deadLetterTargetArn ?? "") : "";
  } catch {
    /* leave empty */
  }
  return {
    topicArn: sub.topicArn,
    protocol: sub.protocol,
    endpoint: sub.endpoint,
    allowQueue: false,
    raw: a.RawMessageDelivery === "true",
    filterPolicy: pretty(a.FilterPolicy),
    filterScope: a.FilterPolicyScope === "MessageBody" ? "MessageBody" : "MessageAttributes",
    dlqArn,
    deliveryPolicy: pretty(a.DeliveryPolicy),
    roleArn: a.SubscriptionRoleArn ?? "",
  };
}

/** The attributes the form describes, for its protocol. */
export function subAttributes(f: SubForm, creating: boolean): Record<string, string> {
  const out: Record<string, string> = {
    FilterPolicy: compact(f.filterPolicy),
    RedrivePolicy: f.dlqArn.trim() ? JSON.stringify({ deadLetterTargetArn: f.dlqArn.trim() }) : "",
  };
  // The scope only means something with a policy; keep it when editing so a change sticks.
  if (out.FilterPolicy || !creating) out.FilterPolicyScope = f.filterScope;
  if (RAW_PROTOCOLS.includes(f.protocol)) out.RawMessageDelivery = String(f.raw);
  if (f.protocol === "http" || f.protocol === "https") out.DeliveryPolicy = compact(f.deliveryPolicy);
  if (f.protocol === "firehose") out.SubscriptionRoleArn = f.roleArn.trim();
  if (creating) for (const k of Object.keys(out)) if (out[k] === "" || (k === "RawMessageDelivery" && out[k] === "false")) delete out[k];
  return out;
}

export function subFormProblem(f: SubForm, creating: boolean): string | null {
  if (creating) {
    if (!f.topicArn) return "Choose a topic";
    const p = endpointProblem(f.protocol, f.endpoint);
    if (p) return p;
    if (f.topicArn.endsWith(".fifo") && f.protocol !== "sqs") return "FIFO topics can only deliver to SQS queues";
    if (f.topicArn.endsWith(".fifo") && !f.endpoint.trim().endsWith(".fifo")) return "FIFO topics can only deliver to FIFO queues";
  }
  if (f.filterPolicy.trim()) {
    const p = jsonProblem(f.filterPolicy) ?? (/^\s*\{/.test(f.filterPolicy) ? null : "must be a JSON object");
    if (p) return `Filter policy: ${p}`;
  }
  if (f.dlqArn.trim() && !/^arn:[^:]+:sqs:/.test(f.dlqArn.trim())) return "The dead-letter queue is an SQS queue ARN";
  if ((f.protocol === "http" || f.protocol === "https") && f.deliveryPolicy.trim()) {
    const p = jsonProblem(f.deliveryPolicy) ?? (/^\s*\{/.test(f.deliveryPolicy) ? null : "must be a JSON object");
    if (p) return `Delivery policy: ${p}`;
  }
  if (f.protocol === "firehose" && !f.roleArn.trim().startsWith("arn:")) return "Firehose subscriptions need an IAM role ARN that can write to the stream";
  return null;
}

type Props = {
  onClose: () => void;
  /** warning: something that didn't stick (the rest did). */
  onSaved: (message: string, warning?: string) => void;
} & (
  | { mode: "create"; topics: { name: string; arn: string }[]; topicArn: string | null }
  | { mode: "edit"; sub: SubscriptionInfo }
);

export function SubscriptionDialog(props: Props) {
  const creating = props.mode === "create";
  const [initial, setInitial] = useState<SubForm | null>(null);
  const [attrs, setAttrs] = useState<Record<string, string> | null>(null);
  const [f, setF] = useState<SubForm | null>(null);
  const [queues, setQueues] = useState<QueueRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<SubForm>) => setF((x) => (x ? { ...x, ...patch } : x));

  useEffect(() => {
    let stale = false;
    if (props.mode === "create") {
      const form: SubForm = {
        topicArn: props.topicArn ?? "",
        protocol: "sqs",
        endpoint: "",
        allowQueue: true,
        raw: false,
        filterPolicy: "",
        filterScope: "MessageAttributes",
        dlqArn: "",
        deliveryPolicy: "",
        roleArn: "",
      };
      setInitial(form);
      setF(form);
    } else {
      snsWriteApi
        .subscriptionAttributes(props.sub.arn)
        .then((a) => {
          if (stale) return;
          const form = formFromAttributes(props.sub, a);
          setAttrs(a);
          setInitial(form);
          setF(form);
        })
        .catch((e) => !stale && setError((e as AppError).message ?? String(e)));
    }
    // Queue ARNs to pick from (endpoint and dead-letter queue); optional.
    sqsApi
      .listRefs("")
      .then((q) => !stale && setQueues(q))
      .catch(() => {});
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const problem = useMemo(() => (f ? subFormProblem(f, creating) : null), [f, creating]);
  const fifoTopic = !!f?.topicArn.endsWith(".fifo");
  const queueArns = queues.map((q) => q.arn);

  async function save() {
    if (!f || !initial || problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        const arn = await snsWriteApi.subscribe(f.topicArn, f.protocol, f.endpoint.trim(), subAttributes(f, true));
        const topic = topicNameFromArn(f.topicArn);
        const pending = !arn.startsWith("arn:");
        const msg = pending
          ? `Subscribed ${f.endpoint.trim()} to ${topic}; it's pending until the endpoint confirms.`
          : `Subscribed ${f.endpoint.trim()} to ${topic}.`;
        if (f.protocol === "sqs" && f.allowQueue) {
          try {
            await snsWriteApi.allowTopicOnQueue(f.endpoint.trim(), f.topicArn);
          } catch (e) {
            props.onSaved(msg, `The queue policy wasn't updated, so messages may not arrive: ${(e as AppError).message ?? String(e)}`);
            return;
          }
        }
        props.onSaved(msg);
      } else {
        const sub = (props as { sub: SubscriptionInfo }).sub;
        const after = subAttributes(f, false);
        const before = subAttributes(initial, false);
        const changes: Record<string, string> = {};
        for (const [k, v] of Object.entries(after)) if ((before[k] ?? "") !== v) changes[k] = v;
        if (Object.keys(changes).length) await snsWriteApi.setSubscriptionAttributes(sub.arn, changes);
        props.onSaved(`Saved the subscription for ${sub.endpoint}.`);
      }
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const proto = PROTOCOLS.find((p) => p.id === f?.protocol);
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="dialog param-dialog queue-settings"
        role="dialog"
        aria-modal
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && props.onClose()}
      >
        <div className="dialog-title">{creating ? "New subscription" : `Edit subscription · ${topicNameFromArn(props.sub.topicArn)}`}</div>
        <div className="dialog-body">
          {!f ? (
            <div className="hint">{error ? "" : "Loading…"}</div>
          ) : (
            <>
              <div className="pe-grid">
                <label className="form-label" htmlFor="sd-topic">
                  Topic
                </label>
                {props.mode === "create" && !props.topicArn ? (
                  <select id="sd-topic" className="text-input" value={f.topicArn} onChange={(e) => set({ topicArn: e.target.value })}>
                    <option value="">Choose a topic…</option>
                    {props.topics.map((t) => (
                      <option key={t.arn} value={t.arn}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="mono">{topicNameFromArn(f.topicArn)}</span>
                )}

                <label className="form-label" htmlFor="sd-proto">
                  Protocol
                </label>
                {creating ? (
                  <select id="sd-proto" className="text-input" value={f.protocol} onChange={(e) => set({ protocol: e.target.value, endpoint: "" })}>
                    {PROTOCOLS.map((p) => (
                      <option key={p.id} value={p.id} disabled={fifoTopic && p.id !== "sqs"}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span>{proto?.label ?? f.protocol}</span>
                )}

                <label className="form-label" htmlFor="sd-endpoint">
                  Endpoint
                </label>
                {creating ? (
                  <>
                    <input
                      id="sd-endpoint"
                      className="text-input mono"
                      autoFocus
                      spellCheck={false}
                      value={f.endpoint}
                      placeholder={proto?.placeholder}
                      list={f.protocol === "sqs" ? "sd-queues" : undefined}
                      onChange={(e) => set({ endpoint: e.target.value })}
                    />
                    <datalist id="sd-queues">
                      {queueArns
                        .filter((a) => !fifoTopic || a.endsWith(".fifo"))
                        .map((a) => (
                          <option key={a} value={a} />
                        ))}
                    </datalist>
                  </>
                ) : (
                  <span className="mono selectable">{f.endpoint}</span>
                )}
              </div>

              {creating && f.protocol === "sqs" && (
                <label className="check-row">
                  <input type="checkbox" checked={f.allowQueue} onChange={(e) => set({ allowQueue: e.target.checked })} /> Allow this topic to send to the
                  queue (adds a statement to the queue's access policy if needed)
                </label>
              )}
              {creating && ["email", "email-json", "http", "https"].includes(f.protocol) && (
                <p className="hint">The endpoint gets a confirmation message; the subscription is pending until someone confirms it.</p>
              )}

              {RAW_PROTOCOLS.includes(f.protocol) && (
                <label className="check-row">
                  <input type="checkbox" checked={f.raw} onChange={(e) => set({ raw: e.target.checked })} /> Raw message delivery (send the message
                  body as is, without the SNS JSON envelope)
                </label>
              )}

              {f.protocol === "firehose" && (
                <div className="pe-grid">
                  <label className="form-label" htmlFor="sd-role">
                    Subscription role
                  </label>
                  <input
                    id="sd-role"
                    className="text-input mono"
                    spellCheck={false}
                    value={f.roleArn}
                    placeholder="arn:aws:iam::account:role/name"
                    onChange={(e) => set({ roleArn: e.target.value })}
                  />
                </div>
              )}

              <div className="props-section">Filter policy (optional JSON)</div>
              <fieldset className="radio-group inline">
                <legend>Applies to</legend>
                <label>
                  <input type="radio" checked={f.filterScope === "MessageAttributes"} onChange={() => set({ filterScope: "MessageAttributes" })} /> Message
                  attributes
                </label>
                <label>
                  <input type="radio" checked={f.filterScope === "MessageBody"} onChange={() => set({ filterScope: "MessageBody" })} /> Message body (JSON)
                </label>
              </fieldset>
              <ValueEditor value={f.filterPolicy} onChange={(v) => set({ filterPolicy: v })} rows={5} placeholder='{"eventType": ["order_placed"], "amount": [{"numeric": [">", 100]}]}' />

              <div className="props-section">Dead-letter queue (optional)</div>
              <input
                className="text-input mono"
                spellCheck={false}
                value={f.dlqArn}
                list="sd-dlqs"
                placeholder="arn:aws:sqs:region:account:queue (messages SNS can't deliver go here)"
                onChange={(e) => set({ dlqArn: e.target.value })}
              />
              <datalist id="sd-dlqs">
                {queueArns
                  .filter((a) => a.endsWith(".fifo") === fifoTopic)
                  .map((a) => (
                    <option key={a} value={a} />
                  ))}
              </datalist>

              {(f.protocol === "http" || f.protocol === "https") && (
                <>
                  <div className="props-section">Delivery policy (optional JSON; retries)</div>
                  <ValueEditor
                    value={f.deliveryPolicy}
                    onChange={(v) => set({ deliveryPolicy: v })}
                    rows={4}
                    placeholder='{"healthyRetryPolicy": {"numRetries": 3, "minDelayTarget": 20, "maxDelayTarget": 20}}'
                  />
                </>
              )}

              {attrs && (
                <details className="qv-raw">
                  <summary>All attributes</summary>
                  <table className="props-table">
                    <tbody>
                      {Object.entries(attrs).map(([k, v]) => (
                        <tr key={k}>
                          <th>{k}</th>
                          <td className="mono selectable">{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </>
          )}

          {problem && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" disabled={!f || !!problem || busy} onClick={() => void save()}>
            {busy ? "Saving…" : creating ? "Subscribe" : "Save"}
          </button>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
