// Watch a topic live: a temporary SQS queue subscribed to it, polled while
// this panel is open; unsubscribed and deleted on Stop or when leaving.
import { useEffect, useRef, useState } from "react";
import type { AppError } from "../../api/core";
import { snsWatchApi, type TopicInfo, type WatchInfo, type WatchedMessage } from "../../api/sns";
import { ValueView } from "../../components/ValueView";
import type { Shell } from "../../shell/shell";

/** Most messages kept in the list (oldest dropped). */
const KEEP = 500;

type Row = WatchedMessage & { key: number; receivedAt: number };

function preview(s: string): string {
  const one = s.replace(/\s+/g, " ");
  return one.length > 200 ? one.slice(0, 200) + "…" : one;
}

export function WatchPanel({ topic, shell }: { topic: TopicInfo; shell: Shell }) {
  const [watch, setWatch] = useState<WatchInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [raw, setRaw] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leftovers, setLeftovers] = useState(0);
  const nextKey = useRef(0);
  const watchRef = useRef<WatchInfo | null>(null);

  // Tear down when leaving the topic (or the panel goes away for any reason).
  useEffect(
    () => () => {
      const w = watchRef.current;
      watchRef.current = null;
      if (w) void snsWatchApi.stop(w.id).catch(() => {});
    },
    [],
  );

  // Queues left behind by an earlier session (e.g. the app was killed).
  useEffect(() => {
    if (shell.readOnly) return;
    snsWatchApi
      .leftovers()
      .then((l) => setLeftovers(l.length))
      .catch(() => {});
  }, [shell.readOnly]);

  // Poll loop while watching.
  useEffect(() => {
    if (!watch) return;
    let cancelled = false;
    (async () => {
      while (!cancelled && watchRef.current?.id === watch.id) {
        try {
          const got = await snsWatchApi.poll(watch.id, 10);
          if (cancelled) break;
          setError(null);
          if (got.length) {
            const now = Date.now();
            const add: Row[] = got.map((m) => ({ ...m, key: nextKey.current++, receivedAt: now }));
            setRows((r) => [...add.reverse(), ...r].slice(0, KEEP));
          }
        } catch (e) {
          if (cancelled) break;
          setError((e as AppError).message ?? String(e));
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [watch]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const w = await snsWatchApi.start(topic.arn, raw);
      watchRef.current = w;
      setWatch(w);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    const w = watchRef.current;
    if (!w) return;
    watchRef.current = null;
    setStopping(true);
    try {
      await snsWatchApi.stop(w.id);
    } catch (e) {
      shell.showError({ kind: "other", message: `Couldn't remove the watch queue ${w.id} completely: ${(e as AppError).message ?? String(e)}` });
    } finally {
      setWatch(null);
      setStopping(false);
    }
  }

  async function clean() {
    try {
      const n = await snsWatchApi.cleanLeftovers();
      shell.showFlash(`Removed ${n} leftover watch queue${n === 1 ? "" : "s"}.`);
      setLeftovers(0);
    } catch (e) {
      shell.showError(e);
    }
  }

  const cur = rows.find((r) => r.key === current) ?? null;
  return (
    <div className="messages-panel">
      <div className="props-section">Watch messages</div>
      <div className="row mp-controls">
        {watch ? (
          <button className="btn" disabled={stopping} onClick={() => void stop()}>
            {stopping ? "Stopping…" : "Stop watching"}
          </button>
        ) : (
          <>
            <button className="btn" disabled={starting || shell.readOnly} onClick={() => void start()}>
              {starting ? "Starting…" : "Start watching"}
            </button>
            <label className="check-row">
              <input type="checkbox" checked={raw} disabled={starting} onChange={(e) => setRaw(e.target.checked)} /> Raw delivery (no SNS envelope)
            </label>
          </>
        )}
        <button className="btn" disabled={!rows.length} onClick={() => (setRows([]), setCurrent(null))}>
          Clear
        </button>
        <span className="hint">
          {watch ? (
            <>
              <span className="live-dot" /> Watching through <span className="mono">{watch.id}</span>; it's removed when you stop or leave this topic.
            </>
          ) : shell.readOnly ? (
            "Read-only mode: watching creates a temporary queue and subscription, so it's off."
          ) : (
            "Creates a temporary SQS queue subscribed to this topic and shows what's published from now on."
          )}
        </span>
      </div>
      {leftovers > 0 && !watch && (
        <div className="warn-note row">
          {leftovers} watch queue{leftovers === 1 ? " was" : "s were"} left behind by an earlier session.
          <button className="link-btn" onClick={() => void clean()}>
            Remove {leftovers === 1 ? "it" : "them"}
          </button>
        </div>
      )}
      {error && <div className="field-error">{error}</div>}

      {rows.length > 0 && (
        <>
          <div className="sync-table-wrap mp-table-wrap">
            <table className="sync-table mp-table">
              <thead>
                <tr>
                  <th>Published</th>
                  <th>Subject</th>
                  <th className="right">Attributes</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.key} className={m.key === current ? "selected" : ""} onClick={() => setCurrent(m.key)}>
                    <td>{new Date(m.timestamp ?? m.receivedAt).toLocaleTimeString()}</td>
                    <td>{m.subject ?? ""}</td>
                    <td className="right">{m.attributes.length || ""}</td>
                    <td className="mono mp-body">{preview(m.body)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cur && (
            <div className="mp-detail">
              <div className="row">
                <span className="form-label">Message {cur.messageId}</span>
                <div className="spacer" />
                <button className="link-btn" onClick={() => void shell.copyText(cur.body)}>
                  Copy message
                </button>
              </div>
              <ValueView value={cur.body} />
              {cur.attributes.length > 0 && (
                <>
                  <div className="props-section">Message attributes</div>
                  <table className="props-table">
                    <tbody>
                      {cur.attributes.map(([name, type, value]) => (
                        <tr key={name}>
                          <th>{name}</th>
                          <td className="mono selectable">
                            {value} <span className="hint">({type})</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              {cur.envelope && (
                <details className="qv-raw">
                  <summary>SNS envelope</summary>
                  <ValueView value={cur.envelope} />
                </details>
              )}
            </div>
          )}
        </>
      )}
      {watch && rows.length === 0 && <p className="hint">Waiting for messages… publish one to see it here.</p>}
    </div>
  );
}
