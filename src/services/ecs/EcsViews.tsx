// ECS views: a cluster (services and tasks), a service (details, deployments
// and events, tasks) and a task (containers and details).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppError } from "../../api/core";
import { ecsApi, ecsTone, launchLabel, shortArn, type ClusterInfo, type ServiceInfo, type TaskInfo } from "../../api/ecs";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { EcsServiceIcon, EcsTaskIcon } from "../../components/Icons";
import { PageBar } from "../../components/PageBar";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";
import { usePagedDetails, usePaging } from "../../state/paged";

export function Pill({ status, prefix = "" }: { status: string | null; prefix?: string }) {
  return <span className={`status-pill ${ecsTone(status)}`}>{prefix}{(status ?? "unknown").toLowerCase().replace(/_/g, " ")}</span>;
}

export function PropRows({ rows }: { rows: [string, ReactNode][] }) {
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

function TagList({ tags }: { tags: [string, string][] }) {
  return tags.length ? <PropRows rows={tags.map(([k, v]) => [k, v] as [string, ReactNode])} /> : <p className="hint">No tags.</p>;
}

/** Loads something keyed by `deps`, with a manual retry and an optional poll. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[], pollMs: (d: T | null) => number | null = () => null) {
  const [state, setState] = useState<{ key: string; data: T | null; error: AppError | null }>({ key: "", data: null, error: null });
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(deps);
  useEffect(() => {
    let stale = false;
    setState((s) => (s.key === key ? s : { key, data: null, error: null }));
    load()
      .then((data) => !stale && setState({ key, data, error: null }))
      .catch((e) => !stale && setState((s) => ({ key, data: s.key === key ? s.data : null, error: e as AppError })));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  const current = state.key === key ? state : { data: null, error: null };
  const every = pollMs(current.data);
  useEffect(() => {
    if (!every) return;
    const t = window.setTimeout(() => setTick((x) => x + 1), every);
    return () => window.clearTimeout(t);
  }, [every, current.data]);
  return { data: current.data, error: current.error, retry: () => setTick((x) => x + 1) };
}

// ---------------------------------------------------------------------------
// Task list (a cluster's or a service's)

const TASK_COLUMNS: Column[] = [
  { id: "id", label: "Task", width: 260 },
  { id: "def", label: "Task definition", width: 170 },
  { id: "status", label: "Status", width: 100 },
  { id: "health", label: "Health", width: 85 },
  { id: "group", label: "Started by", width: 160 },
  { id: "started", label: "Started", width: 160 },
  { id: "ip", label: "Private IP", width: 110 },
  { id: "launch", label: "Runs on", width: 90 },
  { id: "reason", label: "Stopped reason", width: 320 },
];

export function TaskList({ shell, cluster, service, reloadToken, onOpen, actions }: { shell: Shell; cluster: string; service: string | null; reloadToken: number; onOpen: (id: string) => void; actions?: (t: TaskInfo) => MenuItem[] }) {
  const [stopped, setStopped] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data, error, retry } = useLoad(() => ecsApi.listTasks(cluster, service, stopped), [cluster, service, stopped, reloadToken], (d) => (d?.some((t) => t.lastStatus !== t.desiredStatus) ? 10_000 : null));
  const all = data ?? [];
  const paging = usePaging(`${cluster}|${service ?? ""}|${stopped}`, all.length, "ecs.tasks.pageSize", true);
  const page = useMemo(() => paging.slice(all), [paging, all]);
  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all]);
  const rows: Row[] = useMemo(
    () =>
      page.map((t) => ({
        key: t.id,
        icon: <EcsTaskIcon stopped={t.lastStatus === "STOPPED"} />,
        isContainer: false,
        dimmed: t.lastStatus === "STOPPED",
        cells: {
          id: { text: t.id, sort: t.id },
          def: { text: t.taskDefinition, sort: t.taskDefinition },
          status: { text: (t.lastStatus ?? "").toLowerCase() + (t.desiredStatus && t.desiredStatus !== t.lastStatus ? ` → ${t.desiredStatus.toLowerCase()}` : ""), sort: t.lastStatus ?? "" },
          health: { text: t.health && t.health !== "UNKNOWN" ? t.health.toLowerCase() : "", sort: t.health ?? "" },
          group: { text: t.group?.replace(/^service:/, "service ") ?? "", sort: t.group ?? "" },
          started: { text: formatDate(t.started ?? t.created), sort: t.started ?? t.created ?? "" },
          ip: { text: t.privateIp ?? "", sort: t.privateIp ?? "" },
          launch: { text: launchLabel(t.launchType, [], t.capacityProvider), sort: t.launchType ?? "" },
          reason: { text: t.stoppedReason ?? "", sort: t.stoppedReason ?? "" },
        },
      })),
    [page],
  );
  function menu(key: string | null, x: number, y: number) {
    const t = key ? byId.get(key) : undefined;
    const items: MenuItem[] = [];
    if (t) items.push({ label: "Open", bold: true, shortcut: "Enter", onClick: () => onOpen(t.id) }, { label: "Copy task id", onClick: () => void shell.copyText(t.id) }, { label: "Copy ARN", onClick: () => void shell.copyText(t.arn) }, ...(actions ? ["separator" as const, ...actions(t)] : []), "separator");
    items.push({ label: "Refresh", onClick: retry });
    shell.openMenu(x, y, items);
  }
  return (
    <div className="ecs-list">
      <div className="row ecs-bar">
        <div className="segmented small">
          <button className={!stopped ? "active" : ""} onClick={() => setStopped(false)}>
            Running
          </button>
          <button className={stopped ? "active" : ""} onClick={() => setStopped(true)}>
            Stopped
          </button>
        </div>
        <span className="hint">{stopped ? "ECS keeps stopped tasks for about an hour." : "Running, pending and starting tasks; newest first."}</span>
      </div>
      {error ? (
        <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />
      ) : (
        <>
          <FileList
            columns={stopped ? TASK_COLUMNS : TASK_COLUMNS.filter((c) => c.id !== "reason")}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={onOpen}
            onContextMenu={menu}
            emptyText={!data ? "Loading…" : stopped ? "No recently stopped tasks." : "No running tasks."}
            initialSort={{ col: "started", dir: -1 }}
          />
          {all.length > paging.pageSize && <PageBar {...paging.bar} loading={false} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cluster view

const SERVICE_COLUMNS: Column[] = [
  { id: "name", label: "Service", width: 240 },
  { id: "status", label: "Status", width: 90 },
  { id: "tasks", label: "Running / desired", width: 120, align: "right" },
  { id: "pending", label: "Pending", width: 70, align: "right" },
  { id: "deploy", label: "Deployment", width: 120 },
  { id: "def", label: "Task definition", width: 180 },
  { id: "launch", label: "Runs on", width: 120 },
  { id: "created", label: "Created", width: 160 },
];

export function ClusterView({
  shell,
  cluster,
  info,
  reloadToken,
  tab,
  onTab,
  onOpenService,
  onOpenTask,
  serviceMenu,
  onSelectService,
  taskActions,
}: {
  shell: Shell;
  cluster: string;
  info: ClusterInfo | null;
  reloadToken: number;
  tab: "services" | "tasks";
  onTab: (t: "services" | "tasks") => void;
  onOpenService: (name: string) => void;
  onOpenTask: (id: string) => void;
  serviceMenu: (s: ServiceInfo | null, name: string, x: number, y: number) => void;
  onSelectService: (name: string | null) => void;
  taskActions?: (t: TaskInfo) => MenuItem[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data: arns, error, retry } = useLoad(() => ecsApi.listServiceArns(cluster), [cluster, reloadToken]);
  const names = useMemo(() => (arns ?? []).map(shortArn), [arns]);
  const paging = usePaging(`${cluster}`, names.length, "ecs.services.pageSize", tab === "services");
  const pageNames = useMemo(() => paging.slice(names), [paging, names]);
  const paged = usePagedDetails<ServiceInfo>(`${cluster}|${reloadToken}`, pageNames, (n) => ecsApi.services(cluster, n), (s) => s.name, tab === "services" && !!arns);
  useEffect(() => onSelectService(selected.size === 1 ? [...selected][0] : null), [selected, onSelectService]);
  const rows: Row[] = useMemo(
    () =>
      pageNames.map((n): Row => {
        const s = paged.details.get(n);
        const wait = { text: "…", sort: "" };
        if (!s) return { key: n, icon: <EcsServiceIcon />, isContainer: false, cells: { name: { text: n, sort: n }, status: wait, tasks: wait, pending: wait, deploy: wait, def: wait, launch: wait, created: wait } };
        const primary = s.deployments.find((d) => d.status === "PRIMARY");
        return {
          key: n,
          icon: <EcsServiceIcon />,
          isContainer: false,
          dimmed: s.status !== "ACTIVE",
          cells: {
            name: { text: n, sort: n },
            status: { text: (s.status ?? "").toLowerCase(), sort: s.status ?? "" },
            tasks: { text: `${s.running} / ${s.desired}`, sort: s.running },
            pending: { text: s.pending ? String(s.pending) : "", sort: s.pending },
            deploy: { text: s.deployments.length > 1 ? "in progress" : (primary?.rolloutState ?? "").toLowerCase().replace("_", " "), sort: s.deployments.length },
            def: { text: s.taskDefinition, sort: s.taskDefinition },
            launch: { text: launchLabel(s.launchType, s.strategy), sort: s.launchType ?? "" },
            created: { text: formatDate(s.created), sort: s.created ?? "" },
          },
        };
      }),
    [pageNames, paged.details],
  );
  return (
    <div className="service-pane ecs-view">
      <div className="qv-head">
        <span className="qv-name">{cluster}</span>
        {info && <Pill status={info.status} />}
        {info && (
          <span className="hint">
            {info.activeServices} service{info.activeServices === 1 ? "" : "s"} · {info.runningTasks} running task{info.runningTasks === 1 ? "" : "s"}
            {info.pendingTasks ? ` · ${info.pendingTasks} pending` : ""}
            {info.containerInstances ? ` · ${info.containerInstances} container instance${info.containerInstances === 1 ? "" : "s"}` : ""}
            {info.capacityProviders.length ? ` · ${info.capacityProviders.join(", ")}` : ""}
            {info.containerInsights && info.containerInsights !== "disabled" ? ` · Container Insights ${info.containerInsights}` : ""}
          </span>
        )}
        <div className="spacer" />
        {info && (
          <button className="link-btn" onClick={() => void shell.copyText(info.arn)}>
            Copy ARN
          </button>
        )}
      </div>
      <div className="segmented small db-tabs">
        <button className={tab === "services" ? "active" : ""} onClick={() => onTab("services")}>
          Services
        </button>
        <button className={tab === "tasks" ? "active" : ""} onClick={() => onTab("tasks")}>
          Tasks
        </button>
      </div>
      {tab === "tasks" ? (
        <TaskList shell={shell} cluster={cluster} service={null} reloadToken={reloadToken} onOpen={onOpenTask} actions={taskActions} />
      ) : error ? (
        <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />
      ) : (
        <div className="ecs-list">
          {paged.error && <div className="warn-note list-note">Couldn't load service details: {paged.error.message}</div>}
          <FileList
            columns={SERVICE_COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={onOpenService}
            onContextMenu={(k, x, y) => k && serviceMenu(paged.details.get(k) ?? null, k, x, y)}
            emptyText={!arns ? "Loading…" : "No services in this cluster."}
          />
          {names.length > paging.pageSize && <PageBar {...paging.bar} loading={paged.loading} />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Service view

export function ServiceView({
  shell,
  cluster,
  name,
  reloadToken,
  onLoaded,
  onOpenTask,
  extraTabs = [],
  taskActions,
}: {
  shell: Shell;
  cluster: string;
  name: string;
  reloadToken: number;
  onLoaded: (s: ServiceInfo | null) => void;
  onOpenTask: (id: string) => void;
  extraTabs?: { id: string; label: string; render: (s: ServiceInfo) => ReactNode }[];
  taskActions?: (t: TaskInfo) => MenuItem[];
}) {
  const [tab, setTab] = useState("details");
  // While a deployment is under way, check again every 10 s.
  const { data: s, error, retry } = useLoad(() => ecsApi.service(cluster, name), [cluster, name, reloadToken], (d) => (d && (d.deployments.length > 1 || d.pending > 0 || d.running !== d.desired) ? 10_000 : null));
  useEffect(() => onLoaded(s), [s, onLoaded]);
  if (error && !s) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!s) return <div className="empty-note">Loading…</div>;
  const primary = s.deployments.find((d) => d.status === "PRIMARY");
  const current = extraTabs.find((t) => t.id === tab);
  return (
    <div className="queue-view db-view">
      <div className="qv-head">
        <span className="qv-name">{s.name}</span>
        <Pill status={s.status} />
        {s.deployments.length > 1 ? <Pill status="IN_PROGRESS" prefix="deployment " /> : primary?.rolloutState === "FAILED" ? <Pill status="FAILED" prefix="deployment " /> : null}
        <span className="qbadge">{launchLabel(s.launchType, s.strategy) || "Service"}</span>
        <div className="spacer" />
        <button className="link-btn" onClick={() => void shell.copyText(s.arn)}>
          Copy ARN
        </button>
      </div>
      <div className="ecs-counts">
        <div>
          <span className="hint">Desired</span>
          <b>{s.desired}</b>
        </div>
        <div>
          <span className="hint">Running</span>
          <b>{s.running}</b>
        </div>
        <div>
          <span className="hint">Pending</span>
          <b>{s.pending}</b>
        </div>
        <div>
          <span className="hint">Task definition</span>
          <b className="mono">{s.taskDefinition}</b>
        </div>
      </div>
      {primary?.rolloutState === "FAILED" && primary.rolloutReason && <div className="warn-note">{primary.rolloutReason}</div>}
      <div className="segmented small db-tabs">
        {[{ id: "details", label: "Details" }, { id: "deployments", label: "Deployments and events" }, { id: "tasks", label: "Tasks" }, ...extraTabs].map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {current ? (
        current.render(s)
      ) : tab === "tasks" ? (
        <div className="ecs-tab-list">
          <TaskList shell={shell} cluster={cluster} service={s.name} reloadToken={reloadToken} onOpen={onOpenTask} actions={taskActions} />
        </div>
      ) : tab === "deployments" ? (
        <Deployments s={s} />
      ) : (
        <ServiceDetails s={s} />
      )}
    </div>
  );
}

function ServiceDetails({ s }: { s: ServiceInfo }) {
  const yes = (b: boolean | null) => (b === null ? null : b ? "Yes" : "No");
  return (
    <div className="lambda-details">
      <PropRows
        rows={[
          ["Task definition", <span className="mono">{s.taskDefinition}</span>],
          ["Runs on", launchLabel(s.launchType, s.strategy)],
          ["Capacity strategy", s.strategy.length ? s.strategy.map((x) => `${x.capacityProvider} (weight ${x.weight}${x.base ? `, base ${x.base}` : ""})`).join(", ") : null],
          ["Platform version", s.platformVersion],
          ["Scheduling", s.scheduling === "DAEMON" ? "Daemon (one task per instance)" : s.scheduling ? "Replica" : null],
          ["Deployment", s.minHealthyPercent !== null || s.maxPercent !== null ? `Keeps at least ${s.minHealthyPercent ?? "?"}% healthy, up to ${s.maxPercent ?? "?"}% running` : null],
          ["Circuit breaker", s.circuitBreaker === null ? null : s.circuitBreaker ? `On${s.circuitBreakerRollback ? ", rolls back failed deployments" : ""}` : "Off"],
          ["Health check grace", s.healthCheckGraceSecs ? `${s.healthCheckGraceSecs} s` : null],
          ["ECS Exec", yes(s.execEnabled)],
          ["Service role", s.role ? <span className="mono">{s.role}</span> : null],
          ["Created", formatDate(s.created)],
        ]}
      />
      {s.loadBalancers.length > 0 && (
        <>
          <div className="props-section">Load balancing</div>
          <table className="sync-table">
            <thead>
              <tr>
                <th>Target group / load balancer</th>
                <th>Container</th>
                <th className="right">Port</th>
              </tr>
            </thead>
            <tbody>
              {s.loadBalancers.map((l, i) => (
                <tr key={i} title={l.targetGroupArn ?? ""}>
                  <td className="mono">{l.targetGroupArn ? (l.targetGroupArn.split(":").pop() ?? "").replace(/^targetgroup\//, "").replace(/\/[0-9a-f]+$/, "") : l.loadBalancerName}</td>
                  <td>{l.containerName}</td>
                  <td className="right">{l.containerPort ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {s.subnets.length > 0 && (
        <>
          <div className="props-section">Network</div>
          <PropRows
            rows={[
              ["Subnets", s.subnets.join(", ")],
              ["Security groups", s.securityGroups.join(", ")],
              ["Public IP", yes(s.publicIp)],
            ]}
          />
        </>
      )}
      {s.registries.length > 0 && (
        <>
          <div className="props-section">Service discovery</div>
          {s.registries.map((r) => (
            <p key={r} className="mono selectable">
              {r}
            </p>
          ))}
        </>
      )}
      <div className="props-section">Tags</div>
      <TagList tags={s.tags} />
      <p className="mono selectable hint">{s.arn}</p>
    </div>
  );
}

function Deployments({ s }: { s: ServiceInfo }) {
  return (
    <div className="lambda-details">
      <div className="props-section">Deployments</div>
      <div className="sync-table-wrap">
        <table className="sync-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Task definition</th>
              <th className="right">Desired</th>
              <th className="right">Running</th>
              <th className="right">Pending</th>
              <th className="right">Failed</th>
              <th>Rollout</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {s.deployments.map((d) => (
              <tr key={d.id} title={d.rolloutReason ?? ""}>
                <td>{d.status === "PRIMARY" ? "Primary (new)" : d.status === "ACTIVE" ? "Active (being replaced)" : (d.status ?? "")}</td>
                <td className="mono">{d.taskDefinition}</td>
                <td className="right">{d.desired}</td>
                <td className="right">{d.running}</td>
                <td className="right">{d.pending}</td>
                <td className="right">{d.failed || ""}</td>
                <td>{(d.rolloutState ?? "").toLowerCase().replace("_", " ")}</td>
                <td>{formatDate(d.updated)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="props-section">Events (newest first)</div>
      {s.events.length === 0 ? (
        <p className="hint">No events.</p>
      ) : (
        <div className="event-list">
          <table className="sync-table">
            <tbody>
              {s.events.map((e) => (
                <tr key={e.id}>
                  <td style={{ width: 170 }}>{formatDate(e.created)}</td>
                  <td className="event-msg">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task view

export function TaskView({
  shell,
  cluster,
  id,
  reloadToken,
  onLoaded,
  onOpenService,
  extraTabs = [],
}: {
  shell: Shell;
  cluster: string;
  id: string;
  reloadToken: number;
  onLoaded: (t: TaskInfo | null) => void;
  onOpenService: (name: string) => void;
  extraTabs?: { id: string; label: string; render: (t: TaskInfo) => ReactNode }[];
}) {
  const [tab, setTab] = useState("details");
  const { data: t, error, retry } = useLoad(() => ecsApi.task(cluster, id), [cluster, id, reloadToken], (d) => (d && d.lastStatus !== d.desiredStatus ? 5000 : null));
  useEffect(() => onLoaded(t), [t, onLoaded]);
  if (error && !t) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!t) return <div className="empty-note">Loading…</div>;
  const service = t.group?.startsWith("service:") ? t.group.slice(8) : null;
  const current = extraTabs.find((x) => x.id === tab);
  return (
    <div className="queue-view db-view">
      <div className="qv-head">
        <span className="qv-name mono">{t.id}</span>
        <Pill status={t.lastStatus} />
        {t.desiredStatus && t.desiredStatus !== t.lastStatus && <span className="hint">→ {t.desiredStatus.toLowerCase()}</span>}
        {t.health && t.health !== "UNKNOWN" && <Pill status={t.health} />}
        <span className="qbadge">{launchLabel(t.launchType, [], t.capacityProvider) || "Task"}</span>
        <div className="spacer" />
        <button className="link-btn" onClick={() => void shell.copyText(t.arn)}>
          Copy ARN
        </button>
      </div>
      {t.stoppedReason && <div className="warn-note">Stopped: {t.stoppedReason}</div>}
      {extraTabs.length > 0 && (
        <div className="segmented small db-tabs">
          {[{ id: "details", label: "Details" }, ...extraTabs].map((x) => (
            <button key={x.id} className={tab === x.id ? "active" : ""} onClick={() => setTab(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
      )}
      {current ? (
        current.render(t)
      ) : (
        <div className="lambda-details">
          <PropRows
            rows={[
              ["Task definition", <span className="mono">{t.taskDefinition}</span>],
              [
                "Started by",
                service ? (
                  <>
                    service{" "}
                    <button className="link-btn" onClick={() => onOpenService(service)}>
                      {service}
                    </button>
                  </>
                ) : (
                  t.group
                ),
              ],
              ["CPU / memory", t.cpu || t.memory ? `${t.cpu ?? "?"} CPU units · ${t.memory ?? "?"} MB` : null],
              ["Private IP", t.privateIp],
              ["Availability zone", t.availabilityZone],
              ["Platform version", t.platformVersion],
              ["Created", formatDate(t.created)],
              ["Started", formatDate(t.started)],
              ["Stopped", formatDate(t.stopped)],
              ["Stop code", t.stopCode],
              ["ECS Exec", t.execEnabled ? "Enabled" : "Off"],
            ]}
          />
          <div className="props-section">Containers</div>
          <div className="sync-table-wrap">
            <table className="sync-table">
              <thead>
                <tr>
                  <th>Container</th>
                  <th>Status</th>
                  <th>Health</th>
                  <th>Image</th>
                  <th className="right">Exit code</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {t.containers.map((c) => (
                  <tr key={c.name}>
                    <td className="mono keep">{c.name}</td>
                    <td>{(c.lastStatus ?? "").toLowerCase()}</td>
                    <td>{c.health && c.health !== "UNKNOWN" ? c.health.toLowerCase() : ""}</td>
                    <td className="mono">{c.image}</td>
                    <td className="right">{c.exitCode ?? ""}</td>
                    <td className="muted">{c.reason ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="props-section">Tags</div>
          <TagList tags={t.tags} />
          <p className="mono selectable hint">{t.arn}</p>
        </div>
      )}
    </div>
  );
}
