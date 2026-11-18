// One execution: status, input / output, error, and its event history.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { arnTail, eventDetails, executionArn, sfnApi, type ExecutionDetails, type HistoryEvent } from "../../api/sfn";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { HelpTopic } from "../../components/HelpDialog";
import { PageBar } from "../../components/PageBar";
import { ValueView } from "../../components/ValueView";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";
import { useTokenPages } from "../../state/paged";
import { duration, Pill, PropsTable } from "./MachineView";

const EVENT_COLUMNS: Column[] = [
  { id: "id", label: "ID", width: 60, align: "right" },
  { id: "type", label: "Type", width: 220 },
  { id: "state", label: "State", width: 220 },
  { id: "time", label: "Time", width: 170 },
  { id: "elapsed", label: "Since start", width: 100, align: "right" },
];

/** The state an event belongs to, when its details name one. */
function stateName(e: HistoryEvent): string {
  const d = eventDetails(e);
  return d && typeof d.name === "string" ? d.name : "";
}

/** "TaskStateEntered" → "Task state entered". */
const typeLabel = (t: string) => t.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_, c: string) => ` ${c.toLowerCase()}`);

interface Props {
  shell: Shell;
  machineArn: string | null;
  name: string;
  reloadToken: number;
  onLoaded: (e: ExecutionDetails | null) => void;
}

export function ExecutionView({ shell, machineArn, name, reloadToken, onLoaded }: Props) {
  const arn = machineArn ? executionArn(machineArn, name) : null;
  const [data, setData] = useState<{ arn: string; e: ExecutionDetails | null; error: AppError | null } | null>(null);
  const [tick, setTick] = useState(0);
  const [tab, setTab] = useState<"overview" | "history">("overview");

  useEffect(() => {
    if (!arn) return;
    let stale = false;
    setData((d) => (d?.arn === arn ? d : { arn, e: null, error: null }));
    sfnApi
      .execution(arn)
      .then((e) => {
        if (stale) return;
        setData({ arn, e, error: null });
        onLoaded(e);
      })
      .catch((err) => {
        if (stale) return;
        setData({ arn, e: null, error: err as AppError });
        onLoaded(null);
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arn, reloadToken, tick]);

  // While it runs, check again every 5 s.
  const e = data?.arn === arn ? data.e : null;
  const running = e?.status === "RUNNING";
  useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => setTick((x) => x + 1), 5000);
    return () => window.clearTimeout(t);
  }, [running, e]);

  if (!arn) return <div className="empty-note">Loading…</div>;
  if (data?.arn === arn && data.error) return <ErrorPanel error={data.error} profile={shell.profile} onRetry={() => setTick((x) => x + 1)} />;
  if (!e) return <div className="empty-note">Loading…</div>;

  return (
    <div className={`queue-view db-view${tab === "history" ? " fill" : ""}`}>
      <div className="qv-head">
        <span className="qv-name">{e.name}</span>
        <Pill status={e.status} />
        {e.aliasArn ? <span className="qbadge">alias {arnTail(e.aliasArn)}</span> : e.versionArn ? <span className="qbadge">version {arnTail(e.versionArn)}</span> : null}
        <div className="spacer" />
        <button className="link-btn" onClick={() => void shell.copyText(e.arn)}>
          Copy ARN
        </button>
      </div>
      <HelpTopic id="sfn.execution" />
      <div className="segmented small db-tabs">
        <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>
          Overview
        </button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
          Event history
        </button>
      </div>
      {tab === "overview" ? <Overview e={e} /> : <History shell={shell} arn={e.arn} start={e.start} refreshKey={`${reloadToken}|${running ? tick : "done"}`} />}
    </div>
  );
}

function Overview({ e }: { e: ExecutionDetails }) {
  return (
    <div className="lambda-details">
      {(e.error || e.cause) && (
        <div className="warn-note">
          {e.error && <div className="mono">{e.error}</div>}
          {e.cause && <div className="selectable">{e.cause}</div>}
        </div>
      )}
      <PropsTable
        rows={[
          ["ARN", e.arn],
          ["Started", formatDate(e.start)],
          ["Stopped", formatDate(e.stop)],
          ["Duration", duration(e.start, e.stop) + (e.stop ? "" : " so far")],
          ["Version", e.versionArn ? arnTail(e.versionArn) : null],
          ["Alias", e.aliasArn ? arnTail(e.aliasArn) : null],
          ["Redrives", e.redriveCount ? String(e.redriveCount) : null],
          ["Redrive", e.redriveStatus ? `${e.redriveStatus.toLowerCase().replace(/_/g, " ")}${e.redriveStatusReason ? `: ${e.redriveStatusReason}` : ""}` : null],
          ["Map run", e.mapRunArn],
          ["X-Ray trace", e.traceHeader],
        ]}
      />
      <div className="props-section">Input</div>
      {e.input === null ? <p className="hint">AWS didn't return the input (it may be too large).</p> : <ValueView value={e.input} />}
      <div className="props-section">Output</div>
      {e.status === "RUNNING" ? (
        <p className="hint">Still running.</p>
      ) : e.output === null ? (
        <p className="hint">{e.status === "SUCCEEDED" ? "AWS didn't return the output (it may be too large)." : "No output."}</p>
      ) : (
        <ValueView value={e.output} />
      )}
    </div>
  );
}

function History({ shell, arn, start, refreshKey }: { shell: Shell; arn: string; start: string | null; refreshKey: string }) {
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fetch = useCallback(async (token: string | null, pageSize: number) => {
    const r = await sfnApi.history(arn, token, pageSize);
    return { items: r.events, nextToken: r.nextToken };
  }, [arn]);
  const page = useTokenPages<HistoryEvent>(`${arn}|${refreshKey}|${retry}`, "sfn.history.pageSize", true, fetch);
  const byKey = useMemo(() => new Map((page.items ?? []).map((ev) => [String(ev.id), ev])), [page.items]);
  const rows: Row[] = useMemo(
    () =>
      (page.items ?? []).map((ev) => ({
        key: String(ev.id),
        icon: null,
        isContainer: false,
        cells: {
          id: { text: String(ev.id), sort: ev.id },
          type: { text: typeLabel(ev.type), sort: ev.type },
          state: { text: stateName(ev), sort: stateName(ev) },
          time: { text: formatDate(ev.timestamp), sort: ev.timestamp },
          elapsed: { text: duration(start, ev.timestamp), sort: start ? Date.parse(ev.timestamp) - Date.parse(start) : 0 },
        },
      })),
    [page.items, start],
  );
  const chosen = selected.size === 1 ? byKey.get([...selected][0]) : undefined;
  const details = chosen ? eventDetails(chosen) : null;
  if (page.error) return <ErrorPanel error={page.error} profile={shell.profile} onRetry={() => setRetry((x) => x + 1)} />;
  return (
    <div className="sfn-history">
      <div className="ecs-list">
        <FileList
          storageKey="sfn.history"
          columns={EVENT_COLUMNS}
          rows={rows}
          selected={selected}
          onSelectionChange={setSelected}
          onOpen={(k) => setSelected(new Set([k]))}
          initialSort={{ col: "id", dir: 1 }}
          emptyText={page.loading ? "Loading…" : "No events."}
        />
        {(page.bar.page > 0 || page.bar.hasNext) && <PageBar {...page.bar} />}
      </div>
      <div className="sfn-event">
        {!chosen ? (
          <p className="hint">Select an event to see its details.</p>
        ) : !details ? (
          <p className="hint">{typeLabel(chosen.type)}: no details.</p>
        ) : (
          <EventDetails details={details} />
        )}
      </div>
    </div>
  );
}

/** Event details, with JSON strings (input, output, parameters) shown as values. */
function EventDetails({ details }: { details: Record<string, unknown> }) {
  const entries = Object.entries(details);
  const plain = entries.filter(([, v]) => typeof v !== "string" || !looksJson(v));
  const json = entries.filter(([, v]) => typeof v === "string" && looksJson(v)) as [string, string][];
  return (
    <div className="lambda-details">
      {plain.length > 0 && <PropsTable rows={plain.map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])} />}
      {json.map(([k, v]) => (
        <div key={k}>
          <div className="props-section">{k}</div>
          <ValueView value={v} />
        </div>
      ))}
    </div>
  );
}

function looksJson(s: string): boolean {
  const t = s.trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}
