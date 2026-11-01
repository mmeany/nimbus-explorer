// One queue: live counts, configuration, dead-letter links, tags.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AppError } from "../../api/core";
import { formatSeconds, queueNameFromArn, queueNameFromUrl, sqsApi, type QueueInfo } from "../../api/sqs";
import { ErrorPanel } from "../../components/ErrorPanel";
import { formatDate, formatSize } from "../../format";
import type { Shell } from "../../shell/shell";

/** How often the counts refresh while the queue is shown. */
export const COUNT_REFRESH_MS = 5000;

interface Props {
  url: string;
  shell: Shell;
  /** Changes to force a reload (Refresh, after writes). */
  reloadToken: number;
  /** Extra sections (e.g. messages) rendered below the counts. */
  children?: ReactNode;
  onLoaded?: (q: QueueInfo) => void;
}

export function QueueView({ url, shell, reloadToken, children, onLoaded }: Props) {
  const [queue, setQueue] = useState<QueueInfo | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [tags, setTags] = useState<Record<string, string> | null>(null);
  const [sources, setSources] = useState<string[] | null>(null);
  const [auto, setAuto] = useState(true);
  const [updated, setUpdated] = useState<Date | null>(null);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const load = useCallback(async () => {
    try {
      const q = await sqsApi.queueDetails(url);
      setQueue(q);
      setError(null);
      setUpdated(new Date());
      onLoadedRef.current?.(q);
      return q;
    } catch (e) {
      setError(e as AppError);
      return null;
    }
  }, [url]);

  // Full load: details, tags, DLQ sources.
  useEffect(() => {
    let live = true;
    setTags(null);
    setSources(null);
    void load().then((q) => {
      if (!live || !q) return;
      sqsApi.listTags(url).then((t) => live && setTags(t)).catch(() => live && setTags({}));
      if (q.isDlq) sqsApi.dlqSources(url).then((s) => live && setSources(s)).catch(() => live && setSources([]));
    });
    return () => {
      live = false;
    };
  }, [url, reloadToken, load]);

  // Counts refresh every few seconds while visible.
  useEffect(() => {
    if (!auto) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, COUNT_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [auto, load]);

  if (error && !queue) return <ErrorPanel error={error} profile={shell.profile} onRetry={() => void load()} />;
  if (!queue) return <div className="empty-note">Loading…</div>;

  const a = queue.attributes;
  const go = (name: string) => shell.navigate({ service: "sqs", queue: name });
  const dlqName = queueNameFromArn(queue.dlqArn);
  const encryption = a.KmsMasterKeyId
    ? `KMS: ${a.KmsMasterKeyId}`
    : a.SqsManagedSseEnabled === "true"
      ? "SQS-managed (SSE-SQS)"
      : "None";

  const config: [string, ReactNode][] = [
    ["Type", queue.fifo ? "FIFO" : "Standard"],
    ["Visibility timeout", formatSeconds(a.VisibilityTimeout)],
    ["Message retention", formatSeconds(a.MessageRetentionPeriod)],
    ["Delivery delay", formatSeconds(a.DelaySeconds)],
    ["Maximum message size", a.MaximumMessageSize ? formatSize(Number(a.MaximumMessageSize)) : ""],
    ["Receive wait time", formatSeconds(a.ReceiveMessageWaitTimeSeconds)],
    ["Encryption", encryption],
    ...(queue.fifo
      ? ([
          ["Content-based deduplication", a.ContentBasedDeduplication === "true" ? "On" : "Off"],
          ["Deduplication scope", a.DeduplicationScope ?? ""],
          ["Throughput limit", a.FifoThroughputLimit ?? ""],
        ] as [string, ReactNode][])
      : []),
    ["Created", formatDate(queue.created)],
    ["Last changed", formatDate(queue.modified)],
  ];

  return (
    <div className="queue-view">
      <div className="qv-head">
        <span className="qv-name">{queue.name}</span>
        {queue.fifo && <span className="qbadge fifo">FIFO</span>}
        {queue.isDlq && <span className="qbadge dlq">Dead-letter queue</span>}
        <div className="spacer" />
        <button className="link-btn" onClick={() => void shell.copyText(queue.url)}>
          Copy URL
        </button>
        {queue.arn && (
          <button className="link-btn" onClick={() => void shell.copyText(queue.arn!)}>
            Copy ARN
          </button>
        )}
      </div>

      <div className="sync-totals qv-counts">
        <Count label="Available" value={queue.visible} hint="ApproximateNumberOfMessages" />
        <Count label="In flight" value={queue.inFlight} hint="Received but not yet deleted (invisible)" />
        <Count label="Delayed" value={queue.delayed} hint="Not yet available because of a delay" />
      </div>
      <div className="row qv-refresh">
        <label className="check-row">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Refresh counts every {COUNT_REFRESH_MS / 1000} s
        </label>
        <span className="hint">{updated ? `Updated ${updated.toLocaleTimeString()}` : ""}</span>
        {error && <span className="field-error">Last refresh failed: {error.message}</span>}
      </div>

      {children}

      <div className="props-section">Configuration</div>
      <table className="props-table">
        <tbody>
          {config
            .filter(([, v]) => v !== "" && v !== null)
            .map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          <tr>
            <th>URL</th>
            <td className="mono selectable">{queue.url}</td>
          </tr>
          {queue.arn && (
            <tr>
              <th>ARN</th>
              <td className="mono selectable">{queue.arn}</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="props-section">Dead-letter handling</div>
      {dlqName ? (
        <p>
          Messages received more than {queue.maxReceiveCount ?? "?"} time{queue.maxReceiveCount === 1 ? "" : "s"} move to{" "}
          <button className="link-btn" onClick={() => go(dlqName)}>
            {dlqName}
          </button>
          .
        </p>
      ) : (
        <p className="hint">No dead-letter queue configured.</p>
      )}
      {queue.isDlq && (
        <p>
          Dead-letter queue for:{" "}
          {sources === null
            ? "…"
            : sources.length === 0
              ? "(none found)"
              : sources.map((u, i) => (
                  <span key={u}>
                    {i > 0 && ", "}
                    <button className="link-btn" onClick={() => go(queueNameFromUrl(u))}>
                      {queueNameFromUrl(u)}
                    </button>
                  </span>
                ))}
        </p>
      )}

      <div className="props-section">Tags</div>
      {tags === null ? (
        <p className="hint">Loading…</p>
      ) : Object.keys(tags).length === 0 ? (
        <p className="hint">No tags.</p>
      ) : (
        <table className="props-table">
          <tbody>
            {Object.entries(tags).map(([k, v]) => (
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

function Count({ label, value, hint }: { label: string; value: number | null; hint: string }) {
  return (
    <div className="sync-total" title={hint}>
      <div className="st-num">{value === null ? "—" : value.toLocaleString()}</div>
      <div className="st-label">{label}</div>
    </div>
  );
}
