// Events tab: what happened to a replication group (and its nodes) or a
// serverless cache, newest first, for a chosen period of up to 14 days.
import { useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { ecApi, type EcEvent, type SnapshotKind } from "../../api/elasticache";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { PageBar } from "../../components/PageBar";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";
import { usePaging } from "../../state/paged";

const PERIODS: [number, string][] = [
  [60, "Last hour"],
  [6 * 60, "Last 6 hours"],
  [24 * 60, "Last day"],
  [3 * 24 * 60, "Last 3 days"],
  [7 * 24 * 60, "Last 7 days"],
  [14 * 24 * 60, "Last 14 days"],
];
const STORAGE = "elasticache.events.minutes";

const COLUMNS: Column[] = [
  { id: "date", label: "Time", width: 170 },
  { id: "source", label: "Source", width: 220 },
  { id: "type", label: "Type", width: 130 },
  { id: "message", label: "Message", width: 520 },
];

function savedMinutes(): number {
  try {
    const n = Number(localStorage.getItem(STORAGE));
    return PERIODS.some(([m]) => m === n) ? n : 24 * 60;
  } catch {
    return 24 * 60;
  }
}

export function EventsTab({ shell, kind, id, reloadToken }: { shell: Shell; kind: SnapshotKind; id: string; reloadToken: number }) {
  const [minutes, setMinutes] = useState(savedMinutes);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [data, setData] = useState<{ key: string; events: EcEvent[] | null; error: AppError | null } | null>(null);
  const key = `${kind}|${id}|${minutes}|${reloadToken}|${tick}`;
  useEffect(() => {
    let stale = false;
    setData((d) => (d?.key === key ? d : { key, events: d?.events ?? null, error: null }));
    ecApi
      .events(kind, id, minutes)
      .then((events) => !stale && setData({ key, events, error: null }))
      .catch((e) => !stale && setData({ key, events: null, error: e as AppError }));
    return () => {
      stale = true;
    };
  }, [key, kind, id, minutes]);

  const events = data?.events ?? null;
  const loading = data?.key !== key || (!events && !data?.error);
  const paging = usePaging(`${kind}|${id}|${minutes}`, events?.length ?? 0, "elasticache.events.pageSize", true);
  const page = useMemo(() => paging.slice(events ?? []), [paging, events]);
  const rows: Row[] = useMemo(
    () =>
      page.map((e, i) => ({
        key: `${e.date}|${e.source}|${paging.page * paging.pageSize + i}`,
        icon: null,
        isContainer: false,
        cells: {
          date: { text: formatDate(e.date), sort: e.date ?? "" },
          source: { text: e.source, sort: e.source },
          type: { text: e.sourceType.replace(/-/g, " "), sort: e.sourceType },
          message: { text: e.message, sort: e.message },
        },
      })),
    [page, paging.page, paging.pageSize],
  );

  function choose(m: number) {
    setMinutes(m);
    try {
      localStorage.setItem(STORAGE, String(m));
    } catch {
      /* remembered for this session only */
    }
  }

  return (
    <div className="lambda-details">
      <div className="row">
        <label>
          Period:{" "}
          <select value={minutes} onChange={(e) => choose(Number(e.target.value))}>
            {PERIODS.map(([m, label]) => (
              <option key={m} value={m}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button className="btn small" onClick={() => setTick((x) => x + 1)}>
          Refresh
        </button>
        <span className="hint">{loading ? "Loading…" : events ? `${events.length.toLocaleString()} event${events.length === 1 ? "" : "s"}${kind === "group" ? ", the group's and its nodes'" : ""}` : ""}</span>
      </div>
      {data?.error ? (
        <ErrorPanel error={data.error} profile={shell.profile} onRetry={() => setTick((x) => x + 1)} />
      ) : (
        <div className="ec-snap-list">
          <FileList storageKey="elasticache.events" columns={COLUMNS} rows={rows} selected={selected} onSelectionChange={setSelected} onOpen={() => undefined} initialSort={{ col: "date", dir: -1 }} emptyText={loading ? "Loading…" : "No events in this period."} />
          {events && events.length > paging.pageSize && <PageBar {...paging.bar} loading={false} />}
        </div>
      )}
      <p className="hint">AWS keeps ElastiCache events for 14 days.</p>
    </div>
  );
}
