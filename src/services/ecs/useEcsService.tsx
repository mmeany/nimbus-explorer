// ECS controller: clusters list, cluster / service / task views, and the
// tree (clusters, with each expanded cluster's services).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type AppError } from "../../api/s3";
import { ecsApi, shortArn, type ClusterInfo, type ServiceInfo, type TaskInfo } from "../../api/ecs";
import { CommandButton, CommandSeparator } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { FilterBox } from "../../components/FilterBox";
import { EcsClusterIcon, EcsIcon, EcsServiceIcon, EcsTaskIcon, EditIcon, PlayIcon, RedriveIcon, RefreshIcon, StopIcon, SyncIcon } from "../../components/Icons";
import { TreeNote, TreeRow } from "../../components/TreeRow";
import type { ServiceUi, Shell } from "../../shell/shell";
import { TREE_LIMIT } from "../../state/paged";
import { ClusterView, ServiceView, TaskView } from "./EcsViews";
import { RevisionDialog, RunTaskDialog } from "./EcsDialogs";
import { FamilyList, FamilyView } from "./TaskDefs";
import { ContainerLogs, ExecPanel } from "./ContainerLogs";

const CLUSTER_COLUMNS: Column[] = [
  { id: "name", label: "Cluster", width: 260 },
  { id: "status", label: "Status", width: 90 },
  { id: "services", label: "Services", width: 75, align: "right" },
  { id: "running", label: "Running tasks", width: 100, align: "right" },
  { id: "pending", label: "Pending", width: 70, align: "right" },
  { id: "instances", label: "Instances", width: 75, align: "right" },
  { id: "providers", label: "Capacity providers", width: 220 },
  { id: "insights", label: "Container Insights", width: 130 },
];

export function useEcsService(shell: Shell): ServiceUi {
  const { connection, connectionId, profile, place } = shell;
  const active = place.service === "ecs";
  const cluster = place.service === "ecs" ? place.cluster : null;
  const view = place.service === "ecs" ? place.view : null;
  const id = place.service === "ecs" ? place.id : null;
  const region = connection?.serviceRegion ?? "";
  const scope = `${connectionId}|${region}`;
  const historyKey = `ecs|${profile ?? ""}|${region}`;
  const go = useCallback((c: string | null, v: "service" | "task" | null = null, i: string | null = null) => shell.navigate({ service: "ecs", cluster: c, view: v, id: i }), [shell]);
  const goTaskDefs = useCallback((family: string | null) => shell.navigate({ service: "ecs", cluster: null, view: "taskdefs", id: family }), [shell]);
  const taskDefs = view === "taskdefs";

  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [listing, setListing] = useState<{ key: string; clusters: ClusterInfo[] | null; error: AppError | null } | null>(null);
  const [treeServices, setTreeServices] = useState<Map<string, string[] | "error">>(new Map());
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [filter, setFilter] = useState("");
  const [tdFilter, setTdFilter] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clusterTab, setClusterTab] = useState<"services" | "tasks">("services");
  const [selService, setSelService] = useState<string | null>(null);
  const [viewService, setViewService] = useState<ServiceInfo | null>(null);
  const [viewTask, setViewTask] = useState<TaskInfo | null>(null);
  const [revisionFor, setRevisionFor] = useState<{ cluster: string; service: ServiceInfo } | null>(null);
  const [runIn, setRunIn] = useState<string | null>(null);

  useEffect(() => {
    setListing(null);
    setFilter("");
    setSelected(new Set());
    setExpanded(new Set());
    setTreeServices(new Map());
  }, [scope]);
  useEffect(() => {
    if (!profile) return;
    api
      .getSettings()
      .then((s) => setHistory(s.filterHistory?.[historyKey] ?? []))
      .catch(() => setHistory([]));
  }, [historyKey, profile]);
  useEffect(() => {
    if (active) setOpen(true);
    if (cluster) setExpanded((s) => (s.has(cluster) ? s : new Set(s).add(cluster)));
  }, [active, cluster]);

  const refresh = useCallback(() => {
    setReloadToken((t) => t + 1);
    setTreeServices(new Map());
  }, []);

  const listKey = `${scope}|${reloadToken}`;
  useEffect(() => {
    if (!connection || !(open || active) || listing?.key === listKey) return;
    let stale = false;
    setLoading(true);
    ecsApi
      .listClusters()
      .then((clusters) => !stale && setListing({ key: listKey, clusters, error: null }))
      .catch((e) => !stale && setListing({ key: listKey, clusters: null, error: e as AppError }))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, open, active, listKey]);

  // Services of expanded clusters, for the tree.
  useEffect(() => {
    if (!connection) return;
    for (const c of expanded) {
      if (treeServices.has(c)) continue;
      setTreeServices((m) => new Map(m).set(c, []));
      ecsApi
        .listServiceArns(c)
        .then((arns) => setTreeServices((m) => new Map(m).set(c, arns.map(shortArn))))
        .catch(() => setTreeServices((m) => new Map(m).set(c, "error")));
    }
  }, [expanded, treeServices, connection]);

  const all = listing?.clusters ?? null;
  const clusters = useMemo(() => (all && filter ? all.filter((k) => k.name.startsWith(filter)) : all), [all, filter]);
  const byName = useMemo(() => new Map((all ?? []).map((k) => [k.name, k])), [all]);

  async function applyFilter(v: string) {
    if (taskDefs) setTdFilter(v);
    else setFilter(v);
    try {
      setHistory(await api.rememberFilter(historyKey, v));
    } catch {
      /* convenience only */
    }
  }
  async function forget(v: string | null) {
    try {
      setHistory(await api.forgetFilter(historyKey, v));
    } catch {
      /* ignore */
    }
  }

  const rows: Row[] = useMemo(
    () =>
      (clusters ?? []).map((k) => ({
        key: k.name,
        icon: <EcsClusterIcon />,
        isContainer: false,
        dimmed: k.status !== "ACTIVE",
        cells: {
          name: { text: k.name, sort: k.name },
          status: { text: (k.status ?? "").toLowerCase(), sort: k.status ?? "" },
          services: { text: String(k.activeServices), sort: k.activeServices },
          running: { text: String(k.runningTasks), sort: k.runningTasks },
          pending: { text: k.pendingTasks ? String(k.pendingTasks) : "", sort: k.pendingTasks },
          instances: { text: k.containerInstances ? String(k.containerInstances) : "", sort: k.containerInstances },
          providers: { text: k.capacityProviders.join(", "), sort: k.capacityProviders.join(",") },
          insights: { text: k.containerInsights && k.containerInsights !== "disabled" ? k.containerInsights : "Off", sort: k.containerInsights ?? "" },
        },
      })),
    [clusters],
  );

  function clusterMenu(key: string | null, x: number, y: number) {
    const items: MenuItem[] = [];
    const k = key ? byName.get(key) : undefined;
    if (k) items.push({ label: "Open", bold: true, shortcut: "Enter", onClick: () => go(k.name) }, "separator", { label: "Copy name", onClick: () => void shell.copyText(k.name) }, { label: "Copy ARN", onClick: () => void shell.copyText(k.arn) }, "separator");
    items.push({ label: "Refresh", shortcut: "F5", onClick: refresh });
    shell.openMenu(x, y, items);
  }

  // ---------------------------------------------------------------------------
  // Actions (all refused in read-only mode, in the UI and the backend)

  const ro = shell.readOnly;
  const denied = () => shell.showFlash("Read-only mode: changes are disabled.");
  const svcInfo = async (c: string, name: string) => (viewService?.name === name ? viewService : await ecsApi.service(c, name));

  async function scale(c: string, name: string) {
    if (ro) return denied();
    try {
      const s = await svcInfo(c, name);
      const v = await shell.askName(`Scale ${name}`, "Desired number of tasks", String(s.desired), "Scale", (x) => (!/^\d+$/.test(x.trim()) || Number(x) > 5000 ? "A whole number from 0 to 5,000" : null));
      if (v === null || Number(v) === s.desired) return;
      await ecsApi.updateService(c, name, { desired: Number(v), forceNewDeployment: false });
      shell.showFlash(Number(v) === 0 ? `Scaling ${name} to 0: its tasks stop (the service stays, ready to scale up again).` : `Scaling ${name} to ${v} task${Number(v) === 1 ? "" : "s"}.`);
      refresh();
    } catch (e) {
      shell.showError(e);
    }
  }
  async function redeploy(c: string, name: string) {
    if (ro) return denied();
    const ok = await shell.ask(
      "Force new deployment",
      <p>
        Start fresh tasks for <span className="mono">{name}</span> with the same task definition, then stop the old ones. Use it to pick up a new image pushed to the same
        tag, or new secret values.
      </p>,
      [
        { label: "Redeploy", value: "yes", primary: true },
        { label: "Cancel", value: "no" },
      ],
      "no",
    );
    if (ok !== "yes") return;
    try {
      await ecsApi.updateService(c, name, { forceNewDeployment: true });
      shell.showFlash(`Redeploying ${name}.`);
      refresh();
    } catch (e) {
      shell.showError(e);
    }
  }
  async function changeRevision(c: string, name: string) {
    if (ro) return denied();
    try {
      setRevisionFor({ cluster: c, service: await svcInfo(c, name) });
    } catch (e) {
      shell.showError(e);
    }
  }
  async function stopTask(c: string, t: { id: string; group: string | null }) {
    if (ro) return denied();
    const service = t.group?.startsWith("service:") ? t.group.slice(8) : null;
    const reason = await shell.askName(
      "Stop task",
      service ? `Reason (optional). Service ${service} will start a replacement.` : "Reason (optional; shown as the stopped reason)",
      "",
      "Stop task",
      (x) => (x.length > 255 ? "At most 255 characters" : null),
    );
    if (reason === null) return;
    try {
      await ecsApi.stopTask(c, t.id, reason);
      shell.showFlash(`Stopping task ${t.id.slice(0, 12)}…`);
      refresh();
    } catch (e) {
      shell.showError(e);
    }
  }
  const taskActions = (c: string) => (t: TaskInfo): MenuItem[] => (t.lastStatus === "STOPPED" ? [] : [{ label: "Stop task…", disabled: ro, onClick: () => void stopTask(c, t) }]);

  function serviceMenu(c: string, s: ServiceInfo | null, name: string, x: number, y: number) {
    const items: MenuItem[] = [{ label: "Open", bold: true, shortcut: "Enter", onClick: () => go(c, "service", name) }, "separator"];
    items.push(
      { label: "Scale…", disabled: ro, onClick: () => void scale(c, name) },
      { label: "Force new deployment…", disabled: ro, onClick: () => void redeploy(c, name) },
      { label: "Change task definition…", disabled: ro, onClick: () => void changeRevision(c, name) },
      "separator",
      { label: "Copy name", onClick: () => void shell.copyText(name) },
    );
    if (s) items.push({ label: "Copy ARN", onClick: () => void shell.copyText(s.arn) });
    items.push("separator", { label: "Refresh", shortcut: "F5", onClick: refresh });
    shell.openMenu(x, y, items);
  }

  // ---------------------------------------------------------------------------
  // Tree

  const tree = connection ? (
    <TreeRow
      depth={1}
      label={filter ? "ECS (filtered)" : "ECS"}
      icon={<EcsIcon />}
      selected={active && !cluster && !taskDefs}
      expanded={open}
      title={`ECS · ${region}`}
      onClick={() => go(null)}
      onToggle={() => setOpen((v) => !v)}
    >
      {listing?.error ? (
        <TreeNote depth={2}>Couldn't list clusters</TreeNote>
      ) : !clusters ? (
        <TreeNote depth={2}>Loading…</TreeNote>
      ) : clusters.length === 0 ? (
        <TreeNote depth={2}>{filter ? "No matching clusters" : "No clusters"}</TreeNote>
      ) : (
        clusters.map((k) => {
          const svcs = treeServices.get(k.name);
          const isOpen = expanded.has(k.name);
          return (
            <TreeRow
              key={k.name}
              depth={2}
              label={k.name}
              icon={<EcsClusterIcon />}
              selected={active && cluster === k.name && !view}
              expanded={k.activeServices > 0 ? isOpen : undefined}
              onClick={() => go(k.name)}
              onToggle={() =>
                setExpanded((s) => {
                  const n = new Set(s);
                  if (n.has(k.name)) n.delete(k.name);
                  else n.add(k.name);
                  return n;
                })
              }
              onContextMenu={(x, y) => clusterMenu(k.name, x, y)}
            >
              {isOpen &&
                (svcs === "error" ? (
                  <TreeNote depth={3}>Couldn't list services</TreeNote>
                ) : !svcs || (svcs.length === 0 && k.activeServices > 0) ? (
                  <TreeNote depth={3}>Loading…</TreeNote>
                ) : (
                  <>
                    {svcs.slice(0, TREE_LIMIT).map((s) => (
                      <TreeRow
                        key={s}
                        depth={3}
                        label={s}
                        icon={<EcsServiceIcon />}
                        selected={active && cluster === k.name && view === "service" && id === s}
                        onClick={() => go(k.name, "service", s)}
                        onContextMenu={(x, y) => serviceMenu(k.name, null, s, x, y)}
                      />
                    ))}
                    {svcs.length > TREE_LIMIT && <TreeNote depth={3}>{`${(svcs.length - TREE_LIMIT).toLocaleString()} more in the list`}</TreeNote>}
                  </>
                ))}
            </TreeRow>
          );
        })
      )}
      <TreeRow depth={2} label="Task definitions" icon={<EcsTaskIcon />} selected={active && taskDefs && !id} onClick={() => goTaskDefs(null)} />
    </TreeRow>
  ) : null;

  // ---------------------------------------------------------------------------
  // Content

  let content: ReactNode = null;
  let status = "";
  const rootToggle = (
    <div className="filter-bar sns-bar">
      <div className="segmented small">
        <button className={!taskDefs ? "active" : ""} onClick={() => go(null)}>
          Clusters
        </button>
        <button className={taskDefs ? "active" : ""} onClick={() => goTaskDefs(null)}>
          Task definitions
        </button>
      </div>
    </div>
  );
  if (active && taskDefs && !id) {
    content = (
      <div className="service-pane">
        {rootToggle}
        <FilterBox
          label="Filter:"
          applied={tdFilter}
          history={history}
          placeholder="Family name prefix (Enter to apply)"
          onApply={(v) => void applyFilter(v)}
          onClear={() => setTdFilter("")}
          onForget={(v) => void forget(v)}
          onClearHistory={() => void forget(null)}
        />
        <FamilyList shell={shell} filter={tdFilter} reloadToken={reloadToken} onOpen={(f) => goTaskDefs(f)} />
      </div>
    );
    status = `Task definitions · ${region}`;
  } else if (active && taskDefs && id) {
    content = (
      <div className="service-pane scroll-pane">
        <FamilyView key={id} shell={shell} family={id} reloadToken={reloadToken} onChanged={() => undefined} />
      </div>
    );
    status = `Task definition ${id} · ${region}`;
  } else if (active && !cluster) {
    content = (
      <div className="service-pane">
        {rootToggle}
        <FilterBox
          label="Filter:"
          applied={filter}
          history={history}
          placeholder="Cluster name prefix (Enter to apply)"
          onApply={(v) => void applyFilter(v)}
          onClear={() => setFilter("")}
          onForget={(v) => void forget(v)}
          onClearHistory={() => void forget(null)}
        />
        {listing?.error ? (
          <ErrorPanel error={listing.error} profile={profile} onRetry={refresh} />
        ) : (
          <FileList
            columns={CLUSTER_COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={(k) => go(k)}
            onContextMenu={clusterMenu}
            emptyText={!clusters ? "Loading…" : filter ? `No clusters begin with "${filter}".` : "No clusters in this region."}
          />
        )}
      </div>
    );
    if (clusters) status = `${clusters.length} cluster${clusters.length === 1 ? "" : "s"}${filter ? ` beginning with "${filter}"` : ""} · ${region}`;
  } else if (active && cluster && !view) {
    content = (
      <ClusterView
        key={cluster}
        shell={shell}
        cluster={cluster}
        info={byName.get(cluster) ?? null}
        reloadToken={reloadToken}
        tab={clusterTab}
        onTab={setClusterTab}
        onOpenService={(n) => go(cluster, "service", n)}
        onOpenTask={(t) => go(cluster, "task", t)}
        serviceMenu={(s, n, x, y) => serviceMenu(cluster, s, n, x, y)}
        onSelectService={setSelService}
        taskActions={taskActions(cluster)}
      />
    );
    status = `${cluster} · ${region}`;
  } else if (active && cluster && view === "service" && id) {
    content = (
      <div className="service-pane scroll-pane">
        <ServiceView key={`${cluster}/${id}`} shell={shell} cluster={cluster} name={id} reloadToken={reloadToken} onLoaded={setViewService}
          onOpenTask={(t) => go(cluster, "task", t)}
          taskActions={taskActions(cluster)}
          extraTabs={[{ id: "logs", label: "Logs", render: (s) => <ContainerLogs key={s.taskDefinition} shell={shell} taskDefinition={s.taskDefinition} taskId={null} reloadToken={reloadToken} /> }]}
        />
      </div>
    );
    status = `${cluster} › ${id}${viewService?.name === id ? ` · ${viewService.running} of ${viewService.desired} running` : ""} · ${region}`;
  } else if (active && cluster && view === "task" && id) {
    content = (
      <div className="service-pane scroll-pane">
        <TaskView
          key={`${cluster}/${id}`}
          shell={shell}
          cluster={cluster}
          id={id}
          reloadToken={reloadToken}
          onLoaded={setViewTask}
          onOpenService={(s) => go(cluster, "service", s)}
          extraTabs={[
            { id: "logs", label: "Logs", render: (t) => <ContainerLogs key={t.id} shell={shell} taskDefinition={t.taskDefinition} taskId={t.id} reloadToken={reloadToken} /> },
            {
              id: "exec",
              label: "Shell (ECS Exec)",
              render: (t) => (
                <ExecPanel shell={shell} cluster={cluster} taskId={t.id} containers={t.containers.map((c) => c.name)} enabled={t.execEnabled} service={t.group?.startsWith("service:") ? t.group.slice(8) : null} />
              ),
            },
          ]}
        />
      </div>
    );
    status = `${cluster} › task ${id}${viewTask?.id === id && viewTask.lastStatus ? ` · ${viewTask.lastStatus.toLowerCase()}` : ""} · ${region}`;
  }
  // The service the service commands act on: the open one, or the one selected in a cluster's list.
  const svcTarget = cluster && view === "service" && id ? id : cluster && !view && clusterTab === "services" ? selService : null;
  const refreshBtn = <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} />;
  const commands = !active ? null : cluster && view === "task" && id ? (
    <>
      <CommandButton icon={<StopIcon />} label="Stop task" title="Stop this task" disabled={ro || !viewTask || viewTask.id !== id || viewTask.lastStatus === "STOPPED" || viewTask.desiredStatus === "STOPPED"} onClick={() => viewTask && void stopTask(cluster, viewTask)} />
      <CommandSeparator />
      {refreshBtn}
    </>
  ) : cluster ? (
    <>
      {!view && <CommandButton icon={<PlayIcon />} label="Run task" title="Start a one-off task in this cluster" disabled={ro} onClick={() => (ro ? denied() : setRunIn(cluster))} />}
      <CommandButton icon={<EditIcon />} label="Scale" title="Change the desired number of tasks" disabled={ro || !svcTarget} onClick={() => svcTarget && void scale(cluster, svcTarget)} />
      <CommandButton icon={<SyncIcon />} label="Redeploy" title="Force a new deployment (fresh tasks, same task definition)" disabled={ro || !svcTarget} onClick={() => svcTarget && void redeploy(cluster, svcTarget)} />
      <CommandButton icon={<RedriveIcon />} label="Change revision" title="Deploy another task definition revision (or roll back)" disabled={ro || !svcTarget} onClick={() => svcTarget && void changeRevision(cluster, svcTarget)} />
      <CommandSeparator />
      {refreshBtn}
    </>
  ) : (
    refreshBtn
  );

  const dialogs = (
    <>
      {revisionFor && (
        <RevisionDialog
          cluster={revisionFor.cluster}
          service={revisionFor.service}
          onClose={() => setRevisionFor(null)}
          onDone={(msg) => {
            setRevisionFor(null);
            shell.showFlash(msg);
            refresh();
          }}
        />
      )}
      {runIn && (
        <RunTaskDialog
          cluster={runIn}
          info={byName.get(runIn) ?? null}
          onClose={() => setRunIn(null)}
          onDone={(ids) => {
            const c = runIn;
            setRunIn(null);
            shell.showFlash(`Started ${ids.length} task${ids.length === 1 ? "" : "s"}.`);
            refresh();
            if (ids.length === 1) go(c, "task", ids[0]);
            else setClusterTab("tasks");
          }}
        />
      )}
    </>
  );

  return { tree, content, commands, status, busy: active && !cluster && loading, refresh, dialogs };
}
