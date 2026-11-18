// One Distributed Map run: status, item and child-execution counts,
// settings, and its child executions (each one opens as an execution).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { EXECUTION_STATUSES, executionPlaceName, sfnApi, type ExecutionSummary, type MapRunChange, type MapRunCounts, type MapRunDetails } from "../../api/sfn";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { DialogHelp, HelpTopic } from "../../components/HelpDialog";
import { ExecutionIcon } from "../../components/Icons";
import { PageBar } from "../../components/PageBar";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";
import { useTokenPages } from "../../state/paged";
import { duration, Pill, PropsTable } from "./MachineView";

const COUNT_COLUMNS: [keyof MapRunCounts, string][] = [
  ["pending", "Pending"],
  ["running", "Running"],
  ["succeeded", "Succeeded"],
  ["failed", "Failed"],
  ["timedOut", "Timed out"],
  ["aborted", "Aborted"],
  ["total", "Total"],
  ["resultsWritten", "Results written"],
];

const CHILD_COLUMNS: Column[] = [
  { id: "name", label: "Child execution", width: 300 },
  { id: "status", label: "Status", width: 110 },
  { id: "start", label: "Started", width: 165 },
  { id: "stop", label: "Stopped", width: 165 },
  { id: "duration", label: "Duration", width: 100, align: "right" },
];

interface Props {
  shell: Shell;
  arn: string | null;
  reloadToken: number;
  onLoaded: (m: MapRunDetails | null) => void;
  /** Opens a child execution (its place name, "label:uuid"). */
  onOpenChild: (placeName: string) => void;
  onOpenParent: (executionArn: string) => void;
  childMenu: (e: ExecutionSummary, placeName: string, x: number, y: number) => void;
}

export function MapRunView({ shell, arn, reloadToken, onLoaded, onOpenChild, onOpenParent, childMenu }: Props) {
  const [data, setData] = useState<{ arn: string; m: MapRunDetails | null; error: AppError | null } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!arn) return;
    let stale = false;
    setData((d) => (d?.arn === arn ? d : { arn, m: null, error: null }));
    sfnApi
      .mapRun(arn)
      .then((m) => {
        if (stale) return;
        setData({ arn, m, error: null });
        onLoaded(m);
      })
      .catch((e) => {
        if (stale) return;
        setData({ arn, m: null, error: e as AppError });
        onLoaded(null);
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arn, reloadToken, tick]);

  // While it runs, check again every 5 s.
  const m = data?.arn === arn ? data.m : null;
  const running = m?.status === "RUNNING";
  useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => setTick((x) => x + 1), 5000);
    return () => window.clearTimeout(t);
  }, [running, m]);

  if (!arn) return <div className="empty-note">Loading…</div>;
  if (data?.arn === arn && data.error) return <ErrorPanel error={data.error} profile={shell.profile} onRetry={() => setTick((x) => x + 1)} />;
  if (!m) return <div className="empty-note">Loading…</div>;
  const failureLimit = [m.toleratedFailurePercentage ? `${m.toleratedFailurePercentage}% of items` : "", m.toleratedFailureCount ? `${m.toleratedFailureCount.toLocaleString()} items` : ""].filter(Boolean).join(" or ");

  return (
    <div className="queue-view db-view fill">
      <div className="qv-head">
        <span className="qv-name">Map run {m.label}</span>
        <Pill status={m.status} />
        <div className="spacer" />
        <button className="link-btn" onClick={() => onOpenParent(m.executionArn)}>
          Open parent execution
        </button>
        <button className="link-btn" onClick={() => void shell.copyText(m.arn)}>
          Copy ARN
        </button>
      </div>
      <HelpTopic id="sfn.maprun" />
      <div className="lambda-details">
        <table className="sync-table sfn-counts">
          <thead>
            <tr>
              <th />
              {COUNT_COLUMNS.map(([k, label]) => (
                <th key={k} className="right">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["Items", m.items],
                ["Child executions", m.executions],
              ] as [string, MapRunCounts][]
            ).map(([label, c]) => (
              <tr key={label}>
                <th>{label}</th>
                {COUNT_COLUMNS.map(([k]) => (
                  <td key={k} className={`right${k === "failed" && c.failed ? " danger-text" : ""}`}>
                    {(c[k] ?? 0).toLocaleString()}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <PropsTable
          rows={[
            ["Started", formatDate(m.start)],
            ["Stopped", formatDate(m.stop)],
            ["Duration", duration(m.start, m.stop) + (m.stop ? "" : " so far")],
            ["Max concurrency", m.maxConcurrency ? m.maxConcurrency.toLocaleString() : "No limit (up to 10,000)"],
            ["Tolerated failures", failureLimit || "None (the first failure fails the run)"],
            ["Redrives", m.redriveCount ? `${m.redriveCount} (last ${formatDate(m.redriveDate)})` : null],
            ["Not redrivable", m.items.failuresNotRedrivable ? m.items.failuresNotRedrivable.toLocaleString() : null],
          ]}
        />
      </div>
      <ChildExecutions shell={shell} run={m} refreshKey={`${reloadToken}|${running ? tick : "done"}`} onOpen={onOpenChild} onMenu={childMenu} />
    </div>
  );
}

function ChildExecutions({ shell, run, refreshKey, onOpen, onMenu }: { shell: Shell; run: MapRunDetails; refreshKey: string; onOpen: (placeName: string) => void; onMenu: (e: ExecutionSummary, placeName: string, x: number, y: number) => void }) {
  const [status, setStatus] = useState("");
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fetch = useCallback((token: string | null, pageSize: number) => sfnApi.executions(run.arn, status || null, token, pageSize), [run.arn, status]);
  const page = useTokenPages<ExecutionSummary>(`${run.arn}|${status}|${refreshKey}|${retry}`, "sfn.children.pageSize", true, fetch);
  const byKey = useMemo(() => new Map((page.items ?? []).map((e) => [executionPlaceName(e.arn), e])), [page.items]);
  const rows: Row[] = useMemo(
    () =>
      (page.items ?? []).map((e) => ({
        key: executionPlaceName(e.arn),
        icon: <ExecutionIcon />,
        isContainer: false,
        cells: {
          name: { text: e.name, sort: e.name },
          status: { text: e.status.toLowerCase().replace(/_/g, " "), sort: e.status },
          start: { text: formatDate(e.start), sort: e.start ?? "" },
          stop: { text: formatDate(e.stop), sort: e.stop ?? "" },
          duration: { text: duration(e.start, e.stop), sort: e.start && e.stop ? Date.parse(e.stop) - Date.parse(e.start) : -1 },
        },
      })),
    [page.items],
  );
  return (
    <>
      <div className="row">
        <span className="props-section">Child executions</span>
        <div className="spacer" />
        <label>
          Status:{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            {EXECUTION_STATUSES.filter((s) => s !== "PENDING_REDRIVE").map((s) => (
              <option key={s} value={s}>
                {s.toLowerCase().replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
      </div>
      {run.executions.total === 0 && run.items.total > 0 && <p className="hint">This run uses Express child workflows, which AWS doesn't list; look in the child workflow's log group.</p>}
      {page.error ? (
        <ErrorPanel error={page.error} profile={shell.profile} onRetry={() => setRetry((x) => x + 1)} />
      ) : (
        <div className="ecs-list">
          <FileList
            storageKey="sfn.children"
            columns={CHILD_COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={onOpen}
            onContextMenu={(k, x, y) => {
              const e = k ? byKey.get(k) : undefined;
              if (e && k) onMenu(e, k, x, y);
            }}
            initialSort={{ col: "start", dir: -1 }}
            emptyText={page.loading ? "Loading…" : status ? "No child executions with this status." : "No child executions."}
          />
          {(page.bar.page > 0 || page.bar.hasNext) && <PageBar {...page.bar} />}
        </div>
      )}
    </>
  );
}

/** Changes a running map run's concurrency and failure tolerance; sends only what changed. */
export function MapRunSettingsDialog({ run, onClose, onDone }: { run: MapRunDetails; onClose: () => void; onDone: (msg: string) => void }) {
  const [concurrency, setConcurrency] = useState(String(run.maxConcurrency));
  const [pct, setPct] = useState(String(run.toleratedFailurePercentage));
  const [count, setCount] = useState(String(run.toleratedFailureCount));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = Number(concurrency);
  const p = Number(pct);
  const n = Number(count);
  const problem =
    concurrency.trim() === "" || !Number.isInteger(c) || c < 0 || c > 10000
      ? "Maximum concurrency is a whole number from 0 (no limit) to 10,000"
      : pct.trim() === "" || !Number.isFinite(p) || p < 0 || p > 100
        ? "The tolerated failure percentage is 0 to 100"
        : count.trim() === "" || !Number.isInteger(n) || n < 0
          ? "The tolerated failure count is a whole number, 0 or more"
          : null;
  const change: MapRunChange = {};
  if (!problem) {
    if (c !== run.maxConcurrency) change.maxConcurrency = c;
    if (p !== run.toleratedFailurePercentage) change.toleratedFailurePercentage = p;
    if (n !== run.toleratedFailureCount) change.toleratedFailureCount = n;
  }
  const unchanged = !problem && Object.keys(change).length === 0;

  async function save() {
    if (problem || unchanged || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sfnApi.updateMapRun(run.arn, change);
      onDone(`Updated map run ${run.label}.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">
          <DialogHelp topic="sfn.maprun.settings" />
          Map run {run.label} settings
        </div>
        <div className="dialog-body">
          <p className="hint">Changes apply to the items still to run. They last for this run only; the Map state's definition doesn't change.</p>
          <div className="pe-grid">
            <label className="form-label" htmlFor="mr-c">
              Max concurrency
            </label>
            <input id="mr-c" className="text-input" inputMode="numeric" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} autoFocus />
            <label className="form-label" htmlFor="mr-p">
              Tolerated failures (%)
            </label>
            <input id="mr-p" className="text-input" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} />
            <label className="form-label" htmlFor="mr-n">
              Tolerated failures (items)
            </label>
            <input id="mr-n" className="text-input" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
          </div>
          <p className="hint">0 concurrency means no limit (up to 10,000 at once). The run fails once failures pass either tolerance; 0 for both fails it on the first failure.</p>
          {problem && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" disabled={!!problem || unchanged || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
