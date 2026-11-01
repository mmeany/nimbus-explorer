// RDS controller: clusters (with their member instances) and standalone
// instances in the tree; the list with a remembered name filter; the database
// view for one cluster or instance.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type AppError } from "../../api/s3";
import { engineLabel, rdsApi, type DbCluster, type DbInstance } from "../../api/rds";
import { CommandButton, CommandSeparator } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { FilterBox } from "../../components/FilterBox";
import { DbClusterIcon, DbInstanceIcon, DeleteIcon, EditIcon, PlayIcon, RdsIcon, RedriveIcon, RefreshIcon, StopIcon, SyncIcon } from "../../components/Icons";
import { TreeNote, TreeRow } from "../../components/TreeRow";
import type { ServiceUi, Shell } from "../../shell/shell";
import { DeleteDbDialog, FailoverDialog, ModifyDbDialog } from "./DbDialogs";
import { DbView, type Db, type ExtraTab } from "./DbView";
import { ConnectTab } from "./ConnectTab";
import { EventsLogs } from "./EventsLogs";
import { SqlTab } from "./SqlTab";
import { RestoreDialog, SnapshotList, type RestoreTarget } from "./Snapshots";

const COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 240 },
  { id: "role", label: "Role", width: 130 },
  { id: "engine", label: "Engine", width: 190 },
  { id: "size", label: "Size", width: 150 },
  { id: "status", label: "Status", width: 110 },
  { id: "endpoint", label: "Endpoint", width: 340 },
];

type Listing = { key: string; clusters: DbCluster[] | null; instances: DbInstance[] | null; error: AppError | null };

/** Row key: "c:<id>" for clusters, "i:<id>" for instances. */
const keyOf = (kind: "cluster" | "instance", id: string) => `${kind === "cluster" ? "c" : "i"}:${id}`;
const parseKey = (k: string) => ({ kind: (k.startsWith("c:") ? "cluster" : "instance") as "cluster" | "instance", id: k.slice(2) });

export function useRdsService(shell: Shell): ServiceUi {
  const { connection, connectionId, profile, place, readOnly } = shell;
  const active = place.service === "rds";
  const view = place.service === "rds" && place.kind && place.id ? { kind: place.kind, id: place.id } : null;
  const region = connection?.serviceRegion ?? "";
  const scope = `${connectionId}|${region}`;
  const historyKey = `rds|${profile ?? ""}|${region}`;
  const go = useCallback(
    (kind: "cluster" | "instance" | null, id: string | null) => shell.navigate({ service: "rds", kind, id }),
    [shell],
  );

  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewDb, setViewDb] = useState<Db | null>(null);
  const [rootView, setRootView] = useState<"databases" | "snapshots">("databases");
  const [restore, setRestore] = useState<RestoreTarget | null>(null);
  const [dialog, setDialog] = useState<{ kind: "modify" | "delete" | "failover"; db: Db } | null>(null);

  useEffect(() => {
    setListing(null);
    setFilter("");
    setSelected(new Set());
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
  }, [active]);

  const listKey = `${scope}|${reloadToken}`;
  useEffect(() => {
    if (!connection || !(open || active) || listing?.key === listKey) return;
    let stale = false;
    setLoading(true);
    rdsApi
      .list()
      .then((r) => !stale && setListing({ key: listKey, clusters: r.clusters, instances: r.instances, error: null }))
      .catch((e) => !stale && setListing({ key: listKey, clusters: null, instances: null, error: e as AppError }))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
      // A load cut short (deps changed after it finished) mustn't leave the busy flag on.
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, open, active, listKey]);

  // Opening a member instance expands its cluster in the tree.
  useEffect(() => {
    if (view?.kind === "instance") {
      const cid = listing?.instances?.find((i) => i.id === view.id)?.clusterId;
      if (cid) setExpanded((s) => new Set(s).add(cid));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.kind, view?.id, listing]);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);

  const match = useCallback((id: string) => !filter || id.startsWith(filter), [filter]);
  const clusters = useMemo(() => listing?.clusters ?? null, [listing]);
  const instances = useMemo(() => listing?.instances ?? null, [listing]);
  const standalone = useMemo(() => (instances ?? []).filter((i) => !i.clusterId), [instances]);
  const shownClusters = useMemo(
    () => (clusters ?? []).filter((c) => match(c.id) || c.members.some((m) => match(m.id))),
    [clusters, match],
  );
  const shownStandalone = useMemo(() => standalone.filter((i) => match(i.id)), [standalone, match]);

  async function applyFilter(v: string) {
    setFilter(v);
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

  // ---------------------------------------------------------------------------
  // Actions

  /** The database the commands act on: the one open, or the single selected row. */
  function targetDb(): Db | null {
    if (view) return viewDb && viewDb.kind === view.kind && viewDb.db.id === view.id ? viewDb : null;
    if (selected.size !== 1) return null;
    return dbForKey([...selected][0]);
  }
  function dbForKey(key: string): Db | null {
    const { kind, id } = parseKey(key);
    if (kind === "cluster") {
      const c = clusters?.find((x) => x.id === id);
      return c ? { kind, db: c } : null;
    }
    const i = instances?.find((x) => x.id === id);
    return i ? { kind, db: i } : null;
  }

  const isAurora = (d: Db) => d.db.engine.startsWith("aurora");
  const can = {
    start: (d: Db) => d.db.status === "stopped",
    stop: (d: Db) => d.db.status === "available" && !(d.kind === "instance" && d.db.clusterId),
    reboot: (d: Db) => d.db.status === "available" && (d.kind === "instance" || !isAurora(d)),
    failover: (d: Db) => d.kind === "cluster" && isAurora(d) && d.db.status === "available" && d.db.members.length > 1,
    modify: (d: Db) => d.db.status !== "deleting",
    delete: (d: Db) => d.db.status !== "deleting",
  };

  const denied = () => shell.showFlash("Read-only mode: changes are disabled.");
  const done = (msg: string) => {
    setDialog(null);
    shell.showFlash(msg);
    refresh();
  };

  async function runStart(d: Db) {
    if (readOnly) return denied();
    try {
      await rdsApi.start(d.kind, d.db.id);
      done(`Starting ${d.db.id}. It takes a few minutes to become available.`);
    } catch (e) {
      shell.showError(e);
    }
  }

  async function runStop(d: Db) {
    if (readOnly) return denied();
    const ok = await shell.ask(
      `Stop ${d.db.id}`,
      <>
        <p>
          <span className="mono">{d.db.id}</span> stops accepting connections. You keep paying for storage and backups, not for compute.
        </p>
        <p className="muted-note">AWS starts a stopped database again automatically after 7 days.</p>
      </>,
      [
        { label: "Stop", value: "stop", danger: true },
        { label: "Cancel", value: "cancel", primary: true },
      ],
      "cancel",
    );
    if (ok !== "stop") return;
    try {
      await rdsApi.stop(d.kind, d.db.id);
      done(`Stopping ${d.db.id}.`);
    } catch (e) {
      shell.showError(e);
    }
  }

  async function runReboot(d: Db) {
    if (readOnly) return denied();
    const failover = d.kind === "instance" && d.db.multiAz;
    const choice = await shell.ask(
      `Reboot ${d.db.id}`,
      <p>
        The database restarts; connections drop for a short while.
        {failover ? " With failover, the standby in the other zone takes over (useful to test failover)." : ""}
      </p>,
      [
        { label: "Reboot", value: "reboot", primary: true },
        ...(failover ? [{ label: "Reboot with failover", value: "failover" }] : []),
        { label: "Cancel", value: "cancel" },
      ],
      "cancel",
    );
    if (choice === "cancel") return;
    try {
      await rdsApi.reboot(d.kind, d.db.id, choice === "failover");
      done(`Rebooting ${d.db.id}.`);
    } catch (e) {
      shell.showError(e);
    }
  }

  const openDialog = (kind: "modify" | "delete" | "failover", d: Db) => (readOnly ? denied() : setDialog({ kind, db: d }));

  // Explorer shortcuts: Del deletes, Ctrl+E modifies the open or selected database.
  const keyOps = useRef({ active, modal: false, targetDb, can, openDialog });
  keyOps.current = { active, modal: !!dialog || !!restore, targetDb, can, openDialog };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const o = keyOps.current;
      if (!o.active || o.modal) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, .modal-backdrop")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const d = o.targetDb();
      if (!d) return;
      if (e.key === "Delete" && !ctrl && o.can.delete(d)) {
        e.preventDefault();
        o.openDialog("delete", d);
      } else if (ctrl && !e.shiftKey && e.key === "e" && o.can.modify(d)) {
        e.preventDefault();
        o.openDialog("modify", d);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------------------------------------------------------------------------
  // Rows

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const instRow = (i: DbInstance, role: string): Row => ({
      key: keyOf("instance", i.id),
      icon: <DbInstanceIcon stopped={i.status === "stopped"} />,
      isContainer: false,
      dimmed: i.status === "stopped",
      cells: {
        name: { text: i.clusterId ? `└ ${i.id}` : i.id, sort: 0 },
        role: { text: role, sort: role },
        engine: { text: `${engineLabel(i.engine)} ${i.engineVersion ?? ""}`, sort: i.engine },
        size: { text: [i.class, i.clusterId ? null : i.allocatedStorageGb ? `${i.allocatedStorageGb} GB` : null].filter(Boolean).join(" · "), sort: i.class ?? "" },
        status: { text: i.status ?? "", sort: i.status ?? "" },
        endpoint: { text: i.endpoint ? `${i.endpoint}:${i.port ?? ""}` : "", sort: i.endpoint ?? "" },
      },
    });
    for (const c of shownClusters) {
      out.push({
        key: keyOf("cluster", c.id),
        icon: <DbClusterIcon />,
        // Not a "container" row: those sort first, which would split clusters from their members.
        isContainer: false,
        dimmed: c.status === "stopped",
        cells: {
          name: { text: c.id, sort: 0 },
          role: { text: c.engine.startsWith("aurora") ? "Aurora cluster" : "Multi-AZ cluster", sort: "cluster" },
          engine: { text: `${engineLabel(c.engine)} ${c.engineVersion ?? ""}`, sort: c.engine },
          size: {
            text:
              c.serverlessMinAcu !== null
                ? `Serverless ${c.serverlessMinAcu}–${c.serverlessMaxAcu} ACU`
                : `${c.members.length} instance${c.members.length === 1 ? "" : "s"}`,
            sort: c.members.length,
          },
          status: { text: c.status ?? "", sort: c.status ?? "" },
          endpoint: { text: c.endpoint ? `${c.endpoint}:${c.port ?? ""}` : "", sort: c.endpoint ?? "" },
        },
      });
      for (const m of c.members) {
        const i = instances?.find((x) => x.id === m.id);
        if (i) out.push(instRow(i, m.writer ? "Writer" : "Reader"));
      }
    }
    for (const i of shownStandalone) out.push(instRow(i, i.readReplicaOf ? "Read replica" : "Instance"));
    // Name order: clusters and standalone instances by name, members right under their cluster.
    const group = (r: Row) => {
      const { kind, id } = parseKey(r.key);
      return kind === "cluster" ? id : (instances?.find((x) => x.id === id)?.clusterId ?? id);
    };
    const order = [...out].sort((a, b) => {
      const ga = group(a);
      const gb = group(b);
      if (ga !== gb) return ga < gb ? -1 : 1;
      if (a.key.startsWith("c:") !== b.key.startsWith("c:")) return a.key.startsWith("c:") ? -1 : 1;
      return a.key < b.key ? -1 : 1;
    });
    order.forEach((r, n) => (r.cells.name.sort = n));
    return order;
  }, [shownClusters, shownStandalone, instances]);

  function openContextMenu(key: string | null, x: number, y: number) {
    const items: MenuItem[] = [];
    if (key) {
      const { kind, id } = parseKey(key);
      const arn = kind === "cluster" ? clusters?.find((c) => c.id === id)?.arn : instances?.find((i) => i.id === id)?.arn;
      const d = dbForKey(key);
      items.push({ label: "Open", bold: true, shortcut: "Enter", onClick: () => go(kind, id) }, "separator");
      if (d) {
        items.push(
          { label: "Start", disabled: readOnly || !can.start(d), onClick: () => void runStart(d) },
          { label: "Stop…", disabled: readOnly || !can.stop(d), onClick: () => void runStop(d) },
          { label: "Reboot…", disabled: readOnly || !can.reboot(d), onClick: () => void runReboot(d) },
          ...(d.kind === "cluster" && isAurora(d) ? [{ label: "Fail over…", disabled: readOnly || !can.failover(d), onClick: () => openDialog("failover", d) } as MenuItem] : []),
          { label: "Modify…", shortcut: "Ctrl+E", disabled: readOnly || !can.modify(d), onClick: () => openDialog("modify", d) },
          { label: "Delete…", shortcut: "Del", disabled: readOnly || !can.delete(d), onClick: () => openDialog("delete", d) },
          "separator",
        );
      }
      items.push(
        { label: "Copy name", onClick: () => void shell.copyText(id) },
        ...(arn ? [{ label: "Copy ARN", onClick: () => void shell.copyText(arn) } as MenuItem] : []),
        "separator",
      );
    }
    items.push({ label: "Refresh", shortcut: "F5", onClick: refresh });
    shell.openMenu(x, y, items);
  }

  // ---------------------------------------------------------------------------
  // Tree

  const instanceNode = (i: DbInstance, depth: number) => (
    <TreeRow
      key={i.id}
      depth={depth}
      label={i.id}
      icon={<DbInstanceIcon stopped={i.status === "stopped"} />}
      muted={i.status === "stopped"}
      title={`${engineLabel(i.engine)} · ${i.status ?? ""}`}
      selected={view?.kind === "instance" && view.id === i.id}
      onClick={() => go("instance", i.id)}
      onContextMenu={(x, y) => openContextMenu(keyOf("instance", i.id), x, y)}
    />
  );

  const tree = connection ? (
    <TreeRow
      depth={1}
      label={filter ? "RDS (filtered)" : "RDS"}
      icon={<RdsIcon />}
      selected={active && !view}
      expanded={open}
      title={`RDS · ${region}`}
      onClick={() => go(null, null)}
      onToggle={() => setOpen((v) => !v)}
    >
      {listing?.error ? (
        <TreeNote depth={2}>Couldn't list databases</TreeNote>
      ) : !clusters ? (
        <TreeNote depth={2}>Loading…</TreeNote>
      ) : shownClusters.length + shownStandalone.length === 0 ? (
        <TreeNote depth={2}>{filter ? "No matching databases" : "No databases"}</TreeNote>
      ) : (
        <>
          {shownClusters.map((c) => (
            <TreeRow
              key={`c:${c.id}`}
              depth={2}
              label={c.id}
              icon={<DbClusterIcon />}
              title={`${engineLabel(c.engine)} cluster · ${c.status ?? ""}`}
              selected={view?.kind === "cluster" && view.id === c.id}
              expanded={c.members.length ? expanded.has(c.id) : undefined}
              onClick={() => go("cluster", c.id)}
              onToggle={() =>
                setExpanded((s) => {
                  const n = new Set(s);
                  if (n.has(c.id)) n.delete(c.id);
                  else n.add(c.id);
                  return n;
                })
              }
              onContextMenu={(x, y) => openContextMenu(keyOf("cluster", c.id), x, y)}
            >
              {c.members.map((m) => {
                const i = instances?.find((x) => x.id === m.id);
                return i ? instanceNode(i, 3) : null;
              })}
            </TreeRow>
          ))}
          {shownStandalone.map((i) => instanceNode(i, 2))}
        </>
      )}
    </TreeRow>
  ) : null;

  // ---------------------------------------------------------------------------
  // Content

  let content: ReactNode = null;
  let status = "";
  const viewToggle = (
    <div className="filter-bar sns-bar">
      <div className="segmented small">
        <button className={rootView === "databases" ? "active" : ""} onClick={() => setRootView("databases")}>
          Databases
        </button>
        <button className={rootView === "snapshots" ? "active" : ""} onClick={() => setRootView("snapshots")}>
          Snapshots
        </button>
      </div>
    </div>
  );
  const tabs: ExtraTab[] = [
    {
      id: "connect",
      label: "Connect",
      render: (d) => <ConnectTab shell={shell} db={d} />,
    },
    {
      id: "sql",
      label: "SQL",
      available: (d) => d.kind === "cluster" && d.db.dataApi,
      render: (d) => (d.kind === "cluster" ? <SqlTab key={d.db.id} shell={shell} cluster={d.db} /> : null),
    },
    {
      id: "snapshots",
      label: "Snapshots",
      render: (d) => <SnapshotList shell={shell} db={d} reloadToken={reloadToken} onRestore={setRestore} onOpenDb={go} />,
    },
    {
      id: "events",
      label: "Events & logs",
      render: (d) => <EventsLogs shell={shell} db={d} reloadToken={reloadToken} />,
    },
  ];

  if (active && !view && rootView === "snapshots") {
    content = (
      <div className="service-pane">
        {viewToggle}
        <SnapshotList shell={shell} db={null} reloadToken={reloadToken} onRestore={setRestore} onOpenDb={go} />
      </div>
    );
    status = `Snapshots · ${region}`;
  } else if (active && !view) {
    content = (
      <div className="service-pane">
        {viewToggle}
        <FilterBox
          label="Filter:"
          applied={filter}
          history={history}
          placeholder="Database name prefix (Enter to apply)"
          onApply={(v) => void applyFilter(v)}
          onClear={() => setFilter("")}
          onForget={(v) => void forget(v)}
          onClearHistory={() => void forget(null)}
        />
        {listing?.error ? (
          <ErrorPanel error={listing.error} profile={profile} onRetry={refresh} />
        ) : (
          <FileList
            columns={COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={(k) => {
              const { kind, id } = parseKey(k);
              go(kind, id);
            }}
            onContextMenu={openContextMenu}
            emptyText={!clusters ? "Loading…" : filter ? `No databases begin with "${filter}".` : "No RDS databases in this region."}
          />
        )}
      </div>
    );
    if (clusters && instances) {
      const nc = shownClusters.length;
      const ni = shownStandalone.length;
      status = `${nc} cluster${nc === 1 ? "" : "s"}, ${ni} standalone instance${ni === 1 ? "" : "s"}${filter ? ` beginning with "${filter}"` : ""} · ${region}`;
    }
  } else if (active && view) {
    content = (
      <div className="service-pane scroll-pane">
        <DbView
          key={`${view.kind}:${view.id}`}
          kind={view.kind}
          id={view.id}
          shell={shell}
          reloadToken={reloadToken}
          onLoaded={setViewDb}
          onOpenInstance={(id) => go("instance", id)}
          onOpenCluster={(id) => go("cluster", id)}
          tabs={tabs}
        />
      </div>
    );
    status = `${view.id}${viewDb && viewDb.db.id === view.id ? ` · ${viewDb.db.status ?? ""}` : ""} · ${region}`;
  }

  const t = active ? targetDb() : null;
  const off = (ok: (d: Db) => boolean) => readOnly || !t || !ok(t);
  const commands = active ? (
    <>
      <CommandButton icon={<PlayIcon />} label="Start" title="Start the database" disabled={off(can.start)} onClick={() => t && void runStart(t)} />
      <CommandButton icon={<StopIcon />} label="Stop" title="Stop the database (AWS restarts it after 7 days)" disabled={off(can.stop)} onClick={() => t && void runStop(t)} />
      <CommandButton icon={<SyncIcon />} label="Reboot" title="Reboot (Multi-AZ instances can fail over)" disabled={off(can.reboot)} onClick={() => t && void runReboot(t)} />
      {t && t.kind === "cluster" && isAurora(t) && (
        <CommandButton icon={<RedriveIcon />} label="Fail over" title="Make a reader the writer" disabled={off(can.failover)} onClick={() => t && openDialog("failover", t)} />
      )}
      <CommandSeparator />
      <CommandButton icon={<EditIcon />} label="Modify" title="Instance class, backup retention, deletion protection (Ctrl+E)" disabled={off(can.modify)} onClick={() => t && openDialog("modify", t)} />
      <CommandButton icon={<DeleteIcon />} label="Delete" title="Delete the database, with a final snapshot (Del)" disabled={off(can.delete)} onClick={() => t && openDialog("delete", t)} />
      <CommandSeparator />
      <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} />
    </>
  ) : null;

  const dialogs = restore ? (
    <RestoreDialog
      target={restore}
      onClose={() => setRestore(null)}
      onDone={(kind, id) => {
        setRestore(null);
        shell.showFlash(`Restoring into ${id}; it takes a while to become available.`);
        refresh();
        go(kind, id);
      }}
    />
  ) : dialog?.kind === "modify" ? (
      <ModifyDbDialog db={dialog.db} onClose={() => setDialog(null)} onDone={done} />
    ) : dialog?.kind === "delete" ? (
      <DeleteDbDialog db={dialog.db} onClose={() => setDialog(null)} onDone={(m) => (done(m), view && dialog.db.db.id === view.id && go(null, null))} />
    ) : dialog?.kind === "failover" && dialog.db.kind === "cluster" ? (
      <FailoverDialog db={dialog.db} onClose={() => setDialog(null)} onDone={done} />
    ) : null;

  return { tree, content, commands, status, busy: active && loading, refresh, dialogs };
}
