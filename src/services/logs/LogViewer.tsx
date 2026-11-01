// Shared CloudWatch Logs viewer: newest events first for a time range, with
// a filter pattern, optional stream restriction, "Load older", follow live
// (polls every 3 s), the selected event's full message, and download.
// Used by the CloudWatch Logs service, Lambda and ECS.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppError } from "../../api/core";
import { logsApi, type EventsRequest, type LogEvent } from "../../api/logs";
import { api } from "../../api/s3";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { ValueView } from "../../components/ValueView";
import type { Shell } from "../../shell/shell";

const RANGES: [number, string][] = [
  [5, "Last 5 minutes"],
  [15, "Last 15 minutes"],
  [60, "Last hour"],
  [180, "Last 3 hours"],
  [720, "Last 12 hours"],
  [1440, "Last day"],
  [4320, "Last 3 days"],
  [10080, "Last week"],
  [43200, "Last 30 days"],
];
/** Events per search / "Load older". */
const BATCH = 1000;
/** Most events kept while following (oldest dropped). */
const KEEP = 20_000;
const FOLLOW_MS = 3000;

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** Local "YYYY-MM-DD HH:MM:SS.mmm". */
export function formatEventTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function toLocalInput(ms: number): string {
  return formatEventTime(ms).slice(0, 16).replace(" ", "T");
}

interface Props {
  shell: Shell;
  group: string;
  /** Only these streams (at most 100); empty = every stream. */
  streams?: string[];
  /** Only streams whose names begin with this (when `streams` is empty). */
  streamPrefix?: string | null;
  /** Shown next to the stream restriction, with a Clear button when given. */
  onClearStreams?: () => void;
  /** Starting range in minutes (default an hour). */
  defaultMinutes?: number;
  /** Changes to this re-run the search (the service's Refresh). */
  reloadToken?: number;
}

export function LogViewer({ shell, group, streams = [], streamPrefix = null, onClearStreams, defaultMinutes = 60, reloadToken = 0 }: Props) {
  const [minutes, setMinutes] = useState<number | "custom">(defaultMinutes);
  const [custom, setCustom] = useState(() => ({ from: toLocalInput(Date.now() - 3600_000), to: toLocalInput(Date.now()) }));
  const [patternText, setPatternText] = useState("");
  const [pattern, setPattern] = useState("");
  const [follow, setFollow] = useState(false);
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ key: string; events: LogEvent[]; olderEnd: number | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const single = streams.length === 1;
  const streamKey = streams.join("\n");

  const range = useMemo((): { start: number; end: number | null } | null => {
    if (minutes !== "custom") return { start: Date.now() - minutes * 60_000, end: null };
    const s = new Date(custom.from).getTime();
    const e = new Date(custom.to).getTime();
    return isNaN(s) || isNaN(e) || e < s ? null : { start: s, end: e };
    // tick: "Search" recomputes "last N minutes" from now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minutes, custom, tick, reloadToken]);

  const baseRequest = (startMs: number, endMs: number | null, maxEvents = BATCH): EventsRequest => ({
    group,
    streams,
    streamPrefix: streams.length ? null : streamPrefix,
    pattern: pattern.trim() || null,
    startMs,
    endMs,
    maxEvents,
  });
  const searchKey = `${group}|${streamKey}|${streamPrefix ?? ""}|${pattern}|${range?.start}|${range?.end}`;

  // New search whenever what's searched changes.
  useEffect(() => {
    if (!range) return;
    let stale = false;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    logsApi
      .latest(baseRequest(range.start, range.end))
      .then((r) => !stale && setResult({ key: searchKey, events: r.events, olderEnd: r.olderEnd }))
      .catch((e) => !stale && setError(e as AppError))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey]);

  const current = result?.key === searchKey ? result : null;

  // Follow: poll for events newer than the newest shown.
  const followRef = useRef({ current, searchKey });
  followRef.current = { current, searchKey };
  const canFollow = minutes !== "custom";
  useEffect(() => {
    if (!follow || !canFollow) return;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      const { current: cur, searchKey: key } = followRef.current;
      if (cur) {
        const newest = cur.events.length ? cur.events[cur.events.length - 1].time : (range?.start ?? Date.now());
        try {
          const r = await logsApi.latest(baseRequest(newest, null, BATCH));
          if (stopped) return;
          setResult((prev) => {
            if (!prev || prev.key !== key) return prev;
            const seen = new Set(prev.events.map((e) => e.id));
            const fresh = r.events.filter((e) => !seen.has(e.id));
            if (!fresh.length) return prev;
            const merged = [...prev.events, ...fresh];
            const dropped = Math.max(0, merged.length - KEEP);
            return { ...prev, events: merged.slice(dropped), olderEnd: dropped ? merged[dropped].time : prev.olderEnd };
          });
        } catch (e) {
          if (!stopped) setError(e as AppError);
        }
      }
      if (!stopped) timer = window.setTimeout(poll, FOLLOW_MS);
    };
    timer = window.setTimeout(poll, FOLLOW_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, canFollow, searchKey]);

  async function loadOlder() {
    if (!current || current.olderEnd === null || !range) return;
    setLoading(true);
    try {
      const r = await logsApi.latest(baseRequest(range.start, current.olderEnd));
      setResult((prev) => {
        if (!prev || prev.key !== searchKey) return prev;
        const seen = new Set(prev.events.map((e) => e.id));
        return { ...prev, events: [...r.events.filter((e) => !seen.has(e.id)), ...prev.events], olderEnd: r.olderEnd };
      });
    } catch (e) {
      setError(e as AppError);
    } finally {
      setLoading(false);
    }
  }

  async function download() {
    if (!range) return;
    const base = (single ? streams[0] : group).replace(/^\/+/, "").replace(/[\\/:*?"<>|]+/g, "_");
    try {
      const dest = await api.pickSaveFile(`${base}.log`);
      if (!dest) return;
      shell.setWorking(`Downloading ${group}…`);
      const n = await logsApi.download(baseRequest(range.start, range.end ?? Date.now(), 1), dest);
      shell.showFlash(`Saved ${n.toLocaleString()} event${n === 1 ? "" : "s"} to ${dest}`);
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
    }
  }

  const events = current?.events ?? [];
  const byId = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const columns: Column[] = useMemo(
    () => [
      { id: "time", label: "Time", width: 190 },
      ...(single ? [] : [{ id: "stream", label: "Stream", width: 230 }]),
      { id: "message", label: "Message", width: 900 },
    ],
    [single],
  );
  const rows: Row[] = useMemo(
    () =>
      events.map((e, i) => ({
        key: e.id,
        icon: null,
        isContainer: false,
        cells: {
          // Ties (same millisecond) keep their arrival order.
          time: { text: formatEventTime(e.time), sort: e.time * 1e5 + i },
          stream: { text: e.stream, sort: e.stream },
          message: { text: e.message.replace(/\s*\n\s*/g, " ⏎ "), sort: e.message },
        },
      })),
    [events],
  );
  const sel = selected.size === 1 ? byId.get([...selected][0]) : undefined;

  const rangeText = minutes === "custom" ? "in this range" : `in the ${RANGES.find(([m]) => m === minutes)?.[1].toLowerCase() ?? "range"}`;

  return (
    <div className="log-viewer">
      <div className="row log-bar">
        <select className="text-input" aria-label="Time range" value={minutes} onChange={(e) => setMinutes(e.target.value === "custom" ? "custom" : Number(e.target.value))}>
          {RANGES.map(([m, l]) => (
            <option key={m} value={m}>
              {l}
            </option>
          ))}
          <option value="custom">Custom range…</option>
        </select>
        {minutes === "custom" && (
          <>
            <input type="datetime-local" className="text-input" aria-label="From" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            <span className="hint">to</span>
            <input type="datetime-local" className="text-input" aria-label="To" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </>
        )}
        <input
          className="text-input mono log-pattern"
          placeholder='Filter pattern, e.g. ERROR, "timed out" or { $.level = "error" }'
          value={patternText}
          spellCheck={false}
          onChange={(e) => setPatternText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setPattern(patternText);
              setTick((t) => t + 1);
            }
          }}
        />
        <button
          className="btn"
          onClick={() => {
            setPattern(patternText);
            setTick((t) => t + 1);
          }}
        >
          Search
        </button>
        <label className="check-row inline" title={canFollow ? "Check for new events every 3 seconds" : "Follow works with the 'Last …' ranges"}>
          <input type="checkbox" checked={follow && canFollow} disabled={!canFollow} onChange={(e) => setFollow(e.target.checked)} /> Follow
          {follow && canFollow && <span className="live-dot" aria-hidden />}
        </label>
        <div className="spacer" />
        <button className="btn" disabled={!range} title="Save every matching event in the range, oldest first" onClick={() => void download()}>
          Download…
        </button>
      </div>
      {(streams.length > 0 || streamPrefix) && (
        <div className="row log-streams hint">
          {streams.length === 1 ? (
            <>
              Stream <span className="mono">{streams[0]}</span>
            </>
          ) : streams.length ? (
            `${streams.length} streams`
          ) : (
            <>
              Streams beginning with <span className="mono">{streamPrefix}</span>
            </>
          )}
          {onClearStreams && (
            <button className="link-btn" onClick={onClearStreams}>
              Show all streams
            </button>
          )}
        </div>
      )}
      {!range && <div className="field-error">The end of the range is before its start.</div>}
      {error ? (
        <ErrorPanel error={error} profile={shell.profile} onRetry={() => setTick((t) => t + 1)} />
      ) : (
        <div className="log-split">
          <FileList
            key={searchKey}
            columns={columns}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={() => {}}
            emptyText={!current ? "Searching…" : `No events ${rangeText}${pattern ? ` match "${pattern}"` : ""}.`}
            initialSort={{ col: "time", dir: -1 }}
          />
          <div className="row log-foot">
            <span className="hint">
              {current
                ? `${events.length.toLocaleString()} event${events.length === 1 ? "" : "s"}, newest first` +
                  (current.olderEnd !== null ? ` · older events before ${formatEventTime(current.olderEnd + 1)}` : events.length ? " · start of the range reached" : "")
                : "Searching…"}
            </span>
            <button className="btn small" disabled={loading || !current || current.olderEnd === null} onClick={() => void loadOlder()}>
              Load older
            </button>
            {loading && <span className="hint">Loading…</span>}
          </div>
          {sel && (
            <div className="log-detail">
              <div className="row">
                <span className="hint">
                  {formatEventTime(sel.time)}
                  {!single && (
                    <>
                      {" · "}
                      <span className="mono">{sel.stream}</span>
                    </>
                  )}
                </span>
                <div className="spacer" />
                <button className="link-btn" onClick={() => void shell.copyText(sel.message)}>
                  Copy
                </button>
              </div>
              <ValueView key={sel.id} value={sel.message} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
