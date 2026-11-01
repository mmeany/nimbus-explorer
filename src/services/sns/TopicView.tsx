// One topic: subscription counts, configuration, subscriptions, tags.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AppError } from "../../api/core";
import { snsApi, type SubscriptionInfo, type TopicInfo } from "../../api/sns";
import { ErrorPanel } from "../../components/ErrorPanel";
import type { Shell } from "../../shell/shell";

interface Props {
  arn: string;
  shell: Shell;
  reloadToken: number;
  onLoaded?: (t: TopicInfo) => void;
  /** Rendered above the configuration (publish / watch panels). */
  children?: ReactNode;
  /** Actions per subscription row (supplied by the controller). */
  subscriptionActions?: (s: SubscriptionInfo) => ReactNode;
  /** Buttons above the subscriptions table. */
  subscriptionToolbar?: ReactNode;
}

export function TopicView({ arn, shell, reloadToken, onLoaded, children, subscriptionActions, subscriptionToolbar }: Props) {
  const [topic, setTopic] = useState<TopicInfo | null>(null);
  const [subs, setSubs] = useState<SubscriptionInfo[] | null>(null);
  const [tags, setTags] = useState<[string, string][] | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  const load = useCallback(async () => {
    try {
      const t = await snsApi.topicDetails(arn);
      setTopic(t);
      setError(null);
      onLoaded?.(t);
    } catch (e) {
      setError(e as AppError);
    }
    snsApi.listSubscriptions(arn).then(setSubs).catch(() => setSubs([]));
    snsApi.listTags(arn).then(setTags).catch(() => setTags([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arn]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  if (error && !topic) return <ErrorPanel error={error} profile={shell.profile} onRetry={() => void load()} />;
  if (!topic) return <div className="empty-note">Loading…</div>;
  const a = topic.attributes;

  const config: [string, string][] = [
    ["Type", topic.fifo ? "FIFO" : "Standard"],
    ["Display name", topic.displayName ?? ""],
    ["Encryption", topic.kmsKey ? `KMS: ${topic.kmsKey}` : "None"],
    ...(topic.fifo ? ([["Content-based deduplication", topic.contentBasedDedup ? "On" : "Off"]] as [string, string][]) : []),
    ["Owner", a.Owner ?? ""],
    ["Delivery policy", a.EffectiveDeliveryPolicy ? "Set (see All attributes)" : ""],
    ["Tracing", a.TracingConfig ?? ""],
  ];

  return (
    <div className="queue-view">
      <div className="qv-head">
        <span className="qv-name">{topic.name}</span>
        {topic.fifo && <span className="qbadge fifo">FIFO</span>}
        <div className="spacer" />
        <button className="link-btn" onClick={() => void shell.copyText(topic.arn)}>
          Copy ARN
        </button>
      </div>
      <div className="sync-totals qv-counts">
        <div className="sync-total">
          <div className="st-num">{topic.confirmed ?? "—"}</div>
          <div className="st-label">Confirmed subscriptions</div>
        </div>
        <div className="sync-total">
          <div className="st-num">{topic.pending ?? "—"}</div>
          <div className="st-label">Pending confirmation</div>
        </div>
        <div className="sync-total">
          <div className="st-num">{topic.deleted ?? "—"}</div>
          <div className="st-label">Deleted (being removed)</div>
        </div>
      </div>

      {children}

      <div className="props-section">Subscriptions</div>
      {subscriptionToolbar}
      {subs === null ? (
        <p className="hint">Loading…</p>
      ) : subs.length === 0 ? (
        <p className="hint">No subscriptions.</p>
      ) : (
        <table className="sync-table">
          <thead>
            <tr>
              <th>Protocol</th>
              <th>Endpoint</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {subs.map((s) => (
              <tr key={s.arn + s.endpoint}>
                <td>{s.protocol}</td>
                <td className="mono selectable">{s.endpoint}</td>
                <td>{s.pending ? "Pending confirmation" : "Confirmed"}</td>
                <td>{subscriptionActions?.(s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="props-section">Configuration</div>
      <table className="props-table">
        <tbody>
          {config
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          <tr>
            <th>ARN</th>
            <td className="mono selectable">{topic.arn}</td>
          </tr>
        </tbody>
      </table>

      <div className="props-section">Tags</div>
      {tags === null ? (
        <p className="hint">Loading…</p>
      ) : tags.length === 0 ? (
        <p className="hint">No tags.</p>
      ) : (
        <table className="props-table">
          <tbody>
            {tags.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <details className="qv-raw">
        <summary>All attributes</summary>
        <table className="props-table">
          <tbody>
            {Object.entries(a).map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td className="mono selectable">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
