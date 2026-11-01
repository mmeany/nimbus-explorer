// Messages in a queue: Peek (stay visible) or Receive & hold (hidden while you
// look), then delete, release or export.
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/s3";
import { sqsApi, type InMessage, type QueueInfo } from "../../api/sqs";
import { ValueView } from "../../components/ValueView";
import type { Shell } from "../../shell/shell";

interface Props {
  queue: QueueInfo;
  shell: Shell;
  /** After deletes/releases, so counts refresh. */
  onChanged: () => void;
}

type Mode = "peek" | "hold";

function sentAt(m: InMessage): string {
  const t = Number(m.system.SentTimestamp);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "";
}

function preview(body: string): string {
  const one = body.replace(/\s+/g, " ").trim();
  return one.length > 160 ? one.slice(0, 160) + "…" : one;
}

export function MessagesPanel({ queue, shell, onChanged }: Props) {
  const { readOnly } = shell;
  const [mode, setMode] = useState<Mode>("peek");
  const [holdSecs, setHoldSecs] = useState("60");
  const [max, setMax] = useState(10);
  const [longPoll, setLongPoll] = useState(false);
  const [messages, setMessages] = useState<InMessage[] | null>(null);
  /** Hold mode: when the received messages become visible again. */
  const [heldUntil, setHeldUntil] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const held = heldUntil !== null && now < heldUntil;
  const heldRef = useRef<{ handles: string[]; until: number | null }>({ handles: [], until: null });
  heldRef.current = { handles: held && messages ? messages.map((m) => m.receiptHandle) : [], until: heldUntil };

  // Countdown while holding.
  useEffect(() => {
    if (heldUntil === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [heldUntil]);

  // Leaving the queue gives held messages back (best effort).
  useEffect(
    () => () => {
      const { handles, until } = heldRef.current;
      if (handles.length && until && Date.now() < until) void sqsApi.changeVisibility(queue.url, handles, 0).catch(() => {});
    },
    [queue.url],
  );

  const maxReceive = queue.maxReceiveCount;
  const holdOk = /^\d+$/.test(holdSecs) && Number(holdSecs) >= 1 && Number(holdSecs) <= 43200;

  async function getMessages() {
    // Releasing what we still hold first keeps things simple.
    if (held && messages?.length) await release(messages, true);
    setBusy("Getting messages…");
    try {
      const visibility = mode === "peek" ? 0 : Number(holdSecs);
      const got = await sqsApi.receive(queue.url, { max, visibilityTimeout: visibility, waitSeconds: longPoll ? 20 : 0 });
      setMessages(got);
      setChecked(new Set());
      setCurrent(got[0]?.messageId ?? null);
      setHeldUntil(mode === "hold" && got.length ? Date.now() + visibility * 1000 : null);
      setNow(Date.now());
      if (!got.length) shell.showFlash(longPoll ? "No messages arrived within 20 seconds." : "No messages available right now.");
      onChanged();
    } catch (e) {
      shell.showError(e);
    } finally {
      setBusy(null);
    }
  }

  const selectedMsgs = (messages ?? []).filter((m) => checked.has(m.messageId));
  const targets = selectedMsgs.length ? selectedMsgs : [];

  async function deleteMsgs(list: InMessage[]) {
    if (readOnly || !list.length) return;
    const ok = await shell.ask(
      list.length === 1 ? "Delete message" : `Delete ${list.length} messages`,
      <>Delete {list.length === 1 ? "this message" : `these ${list.length} messages`} from <span className="mono">{queue.name}</span>? This can't be undone.</>,
      [
        { label: "Delete", value: "delete", danger: true },
        { label: "Cancel", value: "cancel" },
      ],
      "cancel",
    );
    if (ok !== "delete") return;
    setBusy("Deleting…");
    try {
      const r = await sqsApi.deleteMessages(
        queue.url,
        list.map((m) => m.receiptHandle),
      );
      const failed = new Set(r.failed.map((f) => list[f.index]?.messageId));
      setMessages((ms) => (ms ?? []).filter((m) => !list.some((x) => x.messageId === m.messageId) || failed.has(m.messageId)));
      setChecked(new Set());
      if (r.failed.length) {
        shell.showError({
          kind: "other",
          message: `Deleted ${r.done}; ${r.failed.length} failed (a message received again elsewhere needs its newer receipt).`,
          detail: r.failed.map((f) => `${list[f.index]?.messageId}: ${f.message}`).join("\n"),
        });
      } else shell.showFlash(`Deleted ${r.done} message${r.done === 1 ? "" : "s"}.`);
      onChanged();
    } catch (e) {
      shell.showError(e);
    } finally {
      setBusy(null);
    }
  }

  async function release(list: InMessage[], quiet = false) {
    if (!list.length) return;
    setBusy("Releasing…");
    try {
      const r = await sqsApi.changeVisibility(
        queue.url,
        list.map((m) => m.receiptHandle),
        0,
      );
      setMessages((ms) => (ms ?? []).filter((m) => !list.some((x) => x.messageId === m.messageId)));
      setChecked(new Set());
      if (!quiet) shell.showFlash(`Released ${r.done} message${r.done === 1 ? "" : "s"}; they're visible to consumers again.`);
      onChanged();
    } catch (e) {
      if (!quiet) shell.showError(e);
    } finally {
      setBusy(null);
    }
  }

  async function exportMsgs(list: InMessage[]) {
    if (!list.length) return;
    const path = await api.pickSaveAs("Export messages", `${queue.name}-messages.jsonl`);
    if (!path) return;
    try {
      const n = await sqsApi.exportMessages(path, list);
      shell.showFlash(`Exported ${n} message${n === 1 ? "" : "s"} to ${path}`);
    } catch (e) {
      shell.showError(e);
    }
  }

  const cur = messages?.find((m) => m.messageId === current) ?? null;
  const allChecked = !!messages?.length && checked.size === messages.length;
  const remaining = heldUntil ? Math.max(0, Math.ceil((heldUntil - now) / 1000)) : 0;

  return (
    <div className="messages-panel">
      <div className="props-section">Messages</div>
      <div className="row mp-controls">
        <div className="segmented small">
          <button className={mode === "peek" ? "active" : ""} onClick={() => setMode("peek")} title="Look without hiding messages from consumers">
            Peek
          </button>
          <button className={mode === "hold" ? "active" : ""} onClick={() => setMode("hold")} title="Hide messages while you look, then delete or release them">
            Receive &amp; hold
          </button>
        </div>
        {mode === "hold" && (
          <>
            <span className="hint">for</span>
            <input className="text-input num-input" value={holdSecs} onChange={(e) => setHoldSecs(e.target.value.trim())} />
            <span className="hint">s</span>
          </>
        )}
        <select className="text-input" value={max} onChange={(e) => setMax(Number(e.target.value))} title="How many messages to get">
          {[10, 50, 100, 500].map((n) => (
            <option key={n} value={n}>
              Up to {n}
            </option>
          ))}
        </select>
        <label className="check-row" title="Wait up to 20 s for messages to arrive">
          <input type="checkbox" checked={longPoll} onChange={(e) => setLongPoll(e.target.checked)} /> Wait for messages
        </label>
        <button className="btn primary" disabled={!!busy || (mode === "hold" && !holdOk)} onClick={() => void getMessages()}>
          {busy === "Getting messages…" ? "Getting…" : "Get messages"}
        </button>
      </div>
      <div className={`hint mp-warning ${maxReceive && maxReceive <= 3 ? "danger-text" : ""}`}>
        {mode === "peek"
          ? "Peeking is still a receive: each look raises the message's receive count."
          : "Messages are hidden from consumers until you delete or release them, or the time runs out. Each receive raises the receive count."}
        {maxReceive ? ` This queue moves messages to its dead-letter queue after ${maxReceive} receive${maxReceive === 1 ? "" : "s"}.` : ""}
      </div>

      {messages && messages.length > 0 && (
        <>
          <div className="row mp-actions">
            <button className="btn" disabled={readOnly || !!busy || !targets.length} onClick={() => void deleteMsgs(targets)}>
              Delete selected{targets.length ? ` (${targets.length})` : ""}
            </button>
            {held && (
              <>
                <button className="btn" disabled={!!busy || !targets.length} onClick={() => void release(targets)}>
                  Release selected
                </button>
                <button className="btn" disabled={!!busy} onClick={() => void release(messages)}>
                  Release all
                </button>
              </>
            )}
            <button className="btn" disabled={!!busy} onClick={() => void exportMsgs(targets.length ? targets : messages)}>
              Export {targets.length ? "selected" : "all"}…
            </button>
            <div className="spacer" />
            {heldUntil !== null && (
              <span className={`hint ${held ? "" : "danger-text"}`}>{held ? `Hidden for ${remaining} s more` : "Hold expired: these messages are visible again"}</span>
            )}
            {busy && <span className="hint">{busy}</span>}
          </div>
          <div className="sync-table-wrap mp-table-wrap">
            <table className="sync-table mp-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={(e) => setChecked(e.target.checked ? new Set(messages.map((m) => m.messageId)) : new Set())}
                    />
                  </th>
                  <th>Sent</th>
                  <th className="right">Receives</th>
                  {queue.fifo && <th>Group</th>}
                  <th>Body</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.messageId} className={m.messageId === current ? "selected" : ""} onClick={() => setCurrent(m.messageId)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={checked.has(m.messageId)}
                        onChange={(e) => {
                          const n = new Set(checked);
                          if (e.target.checked) n.add(m.messageId);
                          else n.delete(m.messageId);
                          setChecked(n);
                        }}
                      />
                    </td>
                    <td>{sentAt(m)}</td>
                    <td className="right">{m.system.ApproximateReceiveCount ?? ""}</td>
                    {queue.fifo && <td className="mono">{m.system.MessageGroupId ?? ""}</td>}
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
                  Copy body
                </button>
              </div>
              <ValueView value={cur.body} />
              {cur.attributes.length > 0 && (
                <>
                  <div className="props-section">Message attributes</div>
                  <table className="props-table">
                    <tbody>
                      {cur.attributes.map((a) => (
                        <tr key={a.name}>
                          <th>{a.name}</th>
                          <td className="mono selectable">
                            {a.value} <span className="hint">({a.dataType})</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              <div className="props-section">System attributes</div>
              <table className="props-table">
                <tbody>
                  {Object.entries(cur.system).map(([k, v]) => (
                    <tr key={k}>
                      <th>{k}</th>
                      <td className="mono selectable">{/Timestamp$/.test(k) && /^\d+$/.test(v) ? `${new Date(Number(v)).toLocaleString()} (${v})` : v}</td>
                    </tr>
                  ))}
                  {cur.md5OfBody && (
                    <tr>
                      <th>MD5 of body</th>
                      <td className="mono selectable">{cur.md5OfBody}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {messages && messages.length === 0 && <p className="hint">No messages were returned.</p>}
    </div>
  );
}
