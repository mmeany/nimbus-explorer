// The "Events & logs" tab of a database: recent RDS events, and the database's
// log files (per instance; a cluster picks one of its instances) with a tail
// view and a full download.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppError } from "../../api/core";
import { rdsApi, type LogFile, type LogTail, type RdsEvent } from "../../api/rds";
import { api } from "../../api/s3";
import { ErrorPanel } from "../../components/ErrorPanel";
import { PageBar } from "../../components/PageBar";
import { usePaging } from "../../state/paged";
import { formatDate, formatSize } from "../../format";
import type { Shell } from "../../shell/shell";
import type { Db } from "./DbView";

const PERIODS: [number, string][] = [
  [60, "Last hour"],
  [60 * 24, "Last day"],
  [60 * 24 * 7, "Last 7 days"],
  [60 * 24 * 14, "Last 14 days"],
];
const LINES = [100, 500, 2000, 10000];

export function EventsLogs({ shell, db, reloadToken }: { shell: Shell; db: Db; reloadToken: number }) {
  const [view, setView] = useState<"events" | "logs">("events");
  return (
    <div className="events-tab">
      <div className="segmented small">
        <button className={view === "events" ? "active" : ""} onClick={() => setView("events")}>
          Events
        </button>
        <button className={view === "logs" ? "active" : ""} onClick={() => setView("logs")}>
          Log files
        </button>
      </div>
      {view === "events" ? <Events shell={shell} db={db} reloadToken={reloadToken} /> : <Logs shell={shell} db={db} reloadToken={reloadToken} />}
    </div>
  );
}

function Events({ shell, db, reloadToken }: { shell: Shell; db: Db; reloadToken: number }) {
  const [minutes, setMinutes] = useState(60 * 24);
  const [list, setList] = useState<RdsEvent[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [tick, setTick] = useState(0);
  const members = db.kind === "cluster" ? db.db.members.map((m) => m.id) : [];
  const memberKey = members.join(",");

  useEffect(() => {
    let stale = false;
    setList(null);
    setError(null);
    rdsApi
      .events(db.kind, db.db.id, memberKey ? memberKey.split(",") : [], minutes)
      .then((r) => !stale && setList(r))
      .catch((e) => !stale && setError(e as AppError));
    return () => {
      stale = true;
    };
  }, [db.kind, db.db.id, memberKey, minutes, reloadToken, tick]);

  // Paged on screen: a busy database can log thousands of events in 14 days.
  const paging = usePaging(`${db.kind}|${db.db.id}|${minutes}`, list?.length ?? 0, "rds.events.pageSize", true);
  const pageList = useMemo(() => paging.slice(list ?? []), [paging, list]);

  return (
    <>
      <div className="row snap-bar">
        <select className="text-input" aria-label="Period" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {PERIODS.map(([m, l]) => (
            <option key={m} value={m}>
              {l}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => setTick((t) => t + 1)}>
          Refresh
        </button>
        <span className="hint">RDS keeps events for 14 days{db.kind === "cluster" ? "; includes the cluster's instances" : ""}.</span>
      </div>
      {error ? (
        <ErrorPanel error={error} profile={shell.profile} onRetry={() => setTick((t) => t + 1)} />
      ) : !list ? (
        <p className="hint">Loading events…</p>
      ) : list.length === 0 ? (
        <p className="hint">No events in this period.</p>
      ) : (
        <div className="event-list">
          <table className="sync-table">
            <thead>
              <tr>
                <th style={{ width: 160 }}>Time</th>
                {db.kind === "cluster" && <th style={{ width: 160 }}>Source</th>}
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {pageList.map((e, i) => (
                <tr key={paging.page * paging.pageSize + i}>
                  <td>{formatDate(e.date)}</td>
                  {db.kind === "cluster" && <td className="mono">{e.source}</td>}
                  <td className="event-msg">
                    {e.message}
                    {e.categories.length > 0 && <span className="event-cat">{e.categories.join(", ")}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list && list.length > paging.pageSize && <PageBar {...paging.bar} loading={false} />}
    </>
  );
}

function Logs({ shell, db, reloadToken }: { shell: Shell; db: Db; reloadToken: number }) {
  const instances = useMemo(() => (db.kind === "cluster" ? db.db.members.map((m) => m.id) : [db.db.id]), [db]);
  const [instance, setInstance] = useState(instances[0] ?? "");
  const [files, setFiles] = useState<{ instance: string; list: LogFile[] } | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [lines, setLines] = useState(500);
  const [tail, setTail] = useState<{ key: string; data: LogTail } | null>(null);
  const [tailError, setTailError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!instances.includes(instance)) setInstance(instances[0] ?? "");
  }, [instances, instance]);

  useEffect(() => {
    if (!instance) return;
    let stale = false;
    setError(null);
    rdsApi
      .logFiles(instance)
      .then((list) => !stale && setFiles({ instance, list }))
      .catch((e) => !stale && setError(e as AppError));
    return () => {
      stale = true;
    };
  }, [instance, reloadToken, tick]);

  const tailKey = file ? `${instance}|${file}|${lines}|${tick}` : null;
  useEffect(() => {
    if (!file || !tailKey) return;
    let stale = false;
    setTailError(null);
    rdsApi
      .logTail(instance, file, lines)
      .then((data) => !stale && setTail({ key: tailKey, data }))
      .catch((e) => !stale && setTailError((e as AppError).message ?? String(e)));
    return () => {
      stale = true;
    };
  }, [instance, file, lines, tailKey]);

  // A tail is read from the bottom up: start at the newest line.
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [tail]);

  async function download(f: LogFile) {
    try {
      const dest = await api.pickSaveFile(`${instance}-${f.name.replace(/[\\/]/g, "_")}`);
      if (!dest) return;
      shell.setWorking(`Downloading ${f.name}…`);
      const bytes = await rdsApi.logDownload(instance, f.name, dest);
      shell.setWorking(null);
      shell.showFlash(`Saved ${f.name} (${formatSize(bytes)}) to ${dest}`);
    } catch (e) {
      shell.setWorking(null);
      shell.showError(e as AppError);
    }
  }

  if (instances.length === 0) return <p className="hint">This cluster has no instances, so there are no log files.</p>;
  const list = files && files.instance === instance ? files.list : null;
  const shown = tail && tail.key === tailKey ? tail.data : null;

  return (
    <>
      <div className="row snap-bar">
        {db.kind === "cluster" && (
          <select
            className="text-input"
            aria-label="Instance"
            value={instance}
            onChange={(e) => {
              setInstance(e.target.value);
              setFile(null);
            }}
          >
            {instances.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        )}
        <button className="btn" onClick={() => setTick((t) => t + 1)}>
          Refresh
        </button>
        {db.kind === "cluster" && <span className="hint">Log files belong to each instance.</span>}
      </div>
      {error ? (
        <ErrorPanel error={error} profile={shell.profile} onRetry={() => setTick((t) => t + 1)} />
      ) : !list ? (
        <p className="hint">Loading log files…</p>
      ) : list.length === 0 ? (
        <p className="hint">No log files. Turn on log exports or logging parameters to see them here.</p>
      ) : (
        <div className="log-split">
          <div className="log-files">
            <table className="sync-table">
              <thead>
                <tr>
                  <th>Log file</th>
                  <th style={{ width: 150 }}>Last written</th>
                  <th className="right" style={{ width: 70 }}>Size</th>
                  <th style={{ width: 80 }} />
                </tr>
              </thead>
              <tbody>
                {list.map((f) => (
                  <tr key={f.name} className={f.name === file ? "selected" : ""} onClick={() => setFile(f.name)}>
                    <td className="mono">{f.name}</td>
                    <td>{formatDate(f.lastWritten)}</td>
                    <td className="right">{formatSize(f.size)}</td>
                    <td>
                      <button
                        className="link-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          void download(f);
                        }}
                      >
                        Download
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {file && (
            <div className="log-view">
              <div className="row snap-bar">
                <span className="mono">{file}</span>
                <div className="spacer" />
                <label className="hint" htmlFor="log-lines">
                  Last
                </label>
                <select id="log-lines" className="text-input" value={lines} onChange={(e) => setLines(Number(e.target.value))}>
                  {LINES.map((n) => (
                    <option key={n} value={n}>
                      {n.toLocaleString()} lines
                    </option>
                  ))}
                </select>
                <button className="btn" disabled={!shown} onClick={() => shown && void shell.copyText(shown.text)}>
                  Copy
                </button>
              </div>
              {tailError ? (
                <div className="field-error">{tailError}</div>
              ) : !shown ? (
                <p className="hint">Loading…</p>
              ) : (
                <>
                  {shown.truncated && <p className="hint">Showing the end of the file. Download it to see all of it.</p>}
                  <pre ref={pre} className="log-text selectable">{shown.text || "(empty)"}</pre>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
