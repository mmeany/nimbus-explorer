// One state machine: header and tabs (Definition, Executions, Configuration,
// Versions and aliases, Logs).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppError } from "../../api/core";
import { arnTail, definitionStates, EXECUTION_STATUSES, sfnApi, statusTone, type ExecutionSummary, type MachineDetails } from "../../api/sfn";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { HelpTopic } from "../../components/HelpDialog";
import { ExecutionIcon } from "../../components/Icons";
import { PageBar } from "../../components/PageBar";
import { ValueView } from "../../components/ValueView";
import { formatDate } from "../../format";
import type { HelpTopicId } from "../../help";
import type { Shell } from "../../shell/shell";
import { useTokenPages } from "../../state/paged";
import { LogViewer } from "../logs/LogViewer";
import { GraphView } from "./graph/GraphView";
import { exportExecutions } from "./exports";
import { VersionsTab } from "./VersionsTab";
import { RoleLink } from "../../components/RoleLink";

type Tab = "graph" | "definition" | "executions" | "config" | "versions" | "logs";

const TAB_HELP: Record<Tab, HelpTopicId> = {
  graph: "sfn.graph",
  definition: "sfn.machine",
  executions: "sfn.executions",
  config: "sfn.configuration",
  versions: "sfn.versions",
  logs: "sfn.logs",
};

export function Pill({ status }: { status: string | null | undefined }) {
  return <span className={`status-pill ${statusTone(status)}`}>{(status ?? "unknown").toLowerCase().replace(/_/g, " ")}</span>;
}

export function PropsTable({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <table className="props-table">
      <tbody>
        {rows
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td className="selectable">{v}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

/** "12 s", "3 min 4 s", "2 h 5 min" between two ISO dates (to now when `to` is null). */
export function duration(from: string | null, to: string | null): string {
  if (!from) return "";
  const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

interface Props {
  shell: Shell;
  /** From the list; null until it has loaded (or when the machine isn't there). */
  arn: string | null;
  reloadToken: number;
  onLoaded: (m: MachineDetails | null) => void;
  onOpenExecution: (name: string) => void;
  executionMenu: (e: ExecutionSummary, x: number, y: number) => void;
}

export function MachineView({ shell, arn, reloadToken, onLoaded, onOpenExecution, executionMenu }: Props) {
  const [data, setData] = useState<{ arn: string; m: MachineDetails | null; error: AppError | null } | null>(null);
  const [tick, setTick] = useState(0);
  const [tab, setTab] = useState<Tab>("graph");

  useEffect(() => {
    if (!arn) return;
    let stale = false;
    setData((d) => (d?.arn === arn ? d : { arn, m: null, error: null }));
    sfnApi
      .describe(arn)
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

  // Express machines can't list executions; start them on their definition.
  const m = data?.arn === arn ? data.m : null;
  const express = m?.kind === "EXPRESS";
  useEffect(() => {
    if (express && tab === "executions") setTab("logs");
  }, [express, tab]);

  if (!arn) return <div className="empty-note">Loading…</div>;
  if (data?.arn === arn && data.error) return <ErrorPanel error={data.error} profile={shell.profile} onRetry={() => setTick((x) => x + 1)} />;
  if (!m) return <div className="empty-note">Loading…</div>;
  const parsed = definitionStates(m.definition);
  const fill = tab === "graph" || tab === "executions" || tab === "logs";
  const tabs: { id: Tab; label: string }[] = [
    { id: "graph", label: "Graph" },
    { id: "definition", label: "Definition" },
    ...(express ? [] : [{ id: "executions" as Tab, label: "Executions" }]),
    { id: "config", label: "Configuration" },
    { id: "versions", label: "Versions and aliases" },
    { id: "logs", label: "Logs" },
  ];

  return (
    <div className={`queue-view db-view${fill ? " fill" : ""}`}>
      <div className="qv-head">
        <span className="qv-name">{m.name}</span>
        <Pill status={m.status} />
        <span className="qbadge">{m.kind === "EXPRESS" ? "Express" : "Standard"}</span>
        {parsed && <span className="qbadge">{parsed.queryLanguage}</span>}
        <div className="spacer" />
        <button className="link-btn" onClick={() => void shell.copyText(m.arn)}>
          Copy ARN
        </button>
      </div>
      {m.description && <div className="hint">{m.description}</div>}
      <HelpTopic id={TAB_HELP[tab]} />
      <div className="segmented small db-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "graph" ? (
        <GraphView shell={shell} definition={m.definition} runs={null} exportName={m.name} />
      ) : tab === "definition" ? (
        <DefinitionTab m={m} />
      ) : tab === "executions" ? (
        <ExecutionsTab shell={shell} arn={m.arn} name={m.name} reloadToken={reloadToken} onOpen={onOpenExecution} onMenu={executionMenu} />
      ) : tab === "config" ? (
        <ConfigTab m={m} shell={shell} />
      ) : tab === "versions" ? (
        <VersionsTab shell={shell} m={m} reloadToken={reloadToken} onChanged={() => setTick((x) => x + 1)} />
      ) : (
        <LogsTab shell={shell} m={m} reloadToken={reloadToken} />
      )}
    </div>
  );
}

function DefinitionTab({ m }: { m: MachineDetails }) {
  const parsed = useMemo(() => definitionStates(m.definition), [m.definition]);
  return (
    <div className="lambda-details">
      {!parsed ? (
        <div className="warn-note">The definition isn't valid JSON, so its states can't be listed.</div>
      ) : (
        <>
          <div className="props-section">States</div>
          <div className="sync-table-wrap sfn-states">
            <table className="sync-table">
              <thead>
                <tr>
                  <th>State</th>
                  <th>Type</th>
                  <th>Next</th>
                  <th>Resource</th>
                  <th>Comment</th>
                </tr>
              </thead>
              <tbody>
                {parsed.rows.map((r) => (
                  <tr key={`${r.path}|${r.name}`}>
                    <td>
                      {r.path && <div className="hint">{r.path}</div>}
                      <span className="mono">{r.name}</span>
                      {!r.path && r.name === parsed.start && <span className="qbadge">start</span>}
                    </td>
                    <td>{r.type}</td>
                    <td className="mono">{r.next}</td>
                    <td className="mono">{r.resource}</td>
                    <td>{r.comment}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="props-section">Definition</div>
      <ValueView value={m.definition} />
    </div>
  );
}

const EXEC_COLUMNS: Column[] = [
  { id: "name", label: "Execution", width: 300 },
  { id: "status", label: "Status", width: 110 },
  { id: "start", label: "Started", width: 165 },
  { id: "stop", label: "Stopped", width: 165 },
  { id: "duration", label: "Duration", width: 100, align: "right" },
  { id: "ran", label: "Version / alias", width: 120 },
  { id: "redrives", label: "Redrives", width: 70, align: "right" },
];

function ExecutionsTab({ shell, arn, name, reloadToken, onOpen, onMenu }: { shell: Shell; arn: string; name: string; reloadToken: number; onOpen: (name: string) => void; onMenu: (e: ExecutionSummary, x: number, y: number) => void }) {
  const [status, setStatus] = useState("");
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fetch = useCallback((token: string | null, pageSize: number) => sfnApi.executions(arn, status || null, token, pageSize), [arn, status]);
  const page = useTokenPages<ExecutionSummary>(`${arn}|${status}|${reloadToken}|${retry}`, "sfn.executions.pageSize", true, fetch);
  const byName = useMemo(() => new Map((page.items ?? []).map((e) => [e.name, e])), [page.items]);
  const rows: Row[] = useMemo(
    () =>
      (page.items ?? []).map((e) => ({
        key: e.name,
        icon: <ExecutionIcon />,
        isContainer: false,
        cells: {
          name: { text: e.name, sort: e.name },
          status: { text: e.status.toLowerCase().replace(/_/g, " "), sort: e.status },
          start: { text: formatDate(e.start), sort: e.start ?? "" },
          stop: { text: formatDate(e.stop), sort: e.stop ?? "" },
          duration: { text: duration(e.start, e.stop), sort: e.start && e.stop ? Date.parse(e.stop) - Date.parse(e.start) : -1 },
          ran: { text: e.aliasArn ? arnTail(e.aliasArn) : e.versionArn ? `version ${arnTail(e.versionArn)}` : "", sort: e.aliasArn ?? e.versionArn ?? "" },
          redrives: { text: e.redriveCount ? String(e.redriveCount) : "", sort: e.redriveCount ?? 0 },
        },
      })),
    [page.items],
  );
  return (
    <>
      <div className="row">
        <label>
          Status:{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            {EXECUTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.toLowerCase().replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <div className="spacer" />
        <button className="btn small" title="Save every execution (with this status filter) as JSON lines or CSV" onClick={() => void exportExecutions(shell, arn, status, name)}>
          Export…
        </button>
      </div>
      {page.error ? (
        <ErrorPanel error={page.error} profile={shell.profile} onRetry={() => setRetry((x) => x + 1)} />
      ) : (
        <div className="ecs-list">
          <FileList
            storageKey="sfn.executions"
            columns={EXEC_COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={onOpen}
            onContextMenu={(k, x, y) => {
              const e = k ? byName.get(k) : undefined;
              if (e) onMenu(e, x, y);
            }}
            initialSort={{ col: "start", dir: -1 }}
            emptyText={page.loading ? "Loading…" : status ? "No executions with this status." : "No executions yet."}
          />
          {(page.bar.page > 0 || page.bar.hasNext) && <PageBar {...page.bar} />}
        </div>
      )}
    </>
  );
}

function ConfigTab({ m, shell }: { m: MachineDetails; shell: Shell }) {
  const l = m.logging;
  return (
    <div className="lambda-details">
      <PropsTable
        rows={[
          ["ARN", m.arn],
          ["Type", m.kind === "EXPRESS" ? "Express" : "Standard"],
          ["Status", m.status],
          ["Created", formatDate(m.created)],
          ["Execution role", <RoleLink shell={shell} arn={m.roleArn} owner={m.arn} />],
          ["Revision", m.revisionId],
          ["Logging", l && l.level !== "OFF" ? `${l.level}${l.includeExecutionData ? ", with execution data" : ", without execution data"}` : "Off"],
          [
            "Log group",
            l?.logGroup ? (
              <>
                <span className="mono">{l.logGroup}</span>{" "}
                <button className="link-btn" onClick={() => shell.navigate({ service: "logs", group: l.logGroup })}>
                  Open in CloudWatch Logs
                </button>
              </>
            ) : null,
          ],
          ["X-Ray tracing", m.tracing ? "On" : "Off"],
          ["Encryption", m.encryption ? (m.encryption.kind === "CUSTOMER_MANAGED_KMS_KEY" ? `KMS key ${m.encryption.kmsKeyId ?? ""}` : "AWS owned key") : "AWS owned key"],
          ["Data key reuse", m.encryption?.reusePeriodSecs ? `${m.encryption.reusePeriodSecs} s` : null],
        ]}
      />
      <div className="props-section">Tags</div>
      {m.tags.length === 0 ? (
        <p className="hint">No tags.</p>
      ) : (
        <PropsTable rows={m.tags.map(([k, v]) => [k, v] as [string, ReactNode])} />
      )}
    </div>
  );
}

function LogsTab({ shell, m, reloadToken }: { shell: Shell; m: MachineDetails; reloadToken: number }) {
  const group = m.logging && m.logging.level !== "OFF" ? m.logging.logGroup : null;
  if (!group)
    return (
      <div className="lambda-details">
        <p className="hint">
          Logging is off for this machine, so there's nothing to show.
          {m.kind === "EXPRESS" ? " Express machines keep no execution history that AWS can list; their runs are visible only in their log group." : ""} Turn logging on (level ALL to see every step) in the machine's settings.
        </p>
      </div>
    );
  return (
    <div className="lambda-logs">
      {m.kind === "EXPRESS" && <p className="hint">Express machines keep no execution history that AWS can list. Their runs are in this log group.</p>}
      {m.logging?.level !== "ALL" && <p className="hint">The log level is {m.logging?.level}, so only some events are logged. Level ALL logs every step.</p>}
      <LogViewer key={group} shell={shell} group={group} defaultMinutes={60} reloadToken={reloadToken} />
    </div>
  );
}
