// EC2 controller: an overview of the resource kinds, then one list per kind
// and a view per resource. Instances load in full and page on screen; state
// chips and the remembered filter narrow the list (and the tree).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type AppError } from "../../api/s3";
import { allowedActions, DEFAULT_STATES, ec2Api, INSTANCE_STATES, instanceLabel, matchesInstanceFilter, type Instance, type InstanceDetails, type InstanceState } from "../../api/ec2";
import { CommandButton } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { FilterBox } from "../../components/FilterBox";
import { HelpTopic } from "../../components/HelpDialog";
import { DeleteIcon, Ec2Icon, EditIcon, ImageIcon, InstanceIcon, SnapshotIcon, LockIcon, PlayIcon, RedriveIcon, RefreshIcon, StopIcon } from "../../components/Icons";
import { PageBar } from "../../components/PageBar";
import { TreeNote, TreeRow } from "../../components/TreeRow";
import { formatDate } from "../../format";
import { EC2_KIND_LABEL, EC2_ROOT, type Ec2Kind, type Place } from "../../shell/places";
import type { ServiceUi, Shell } from "../../shell/shell";
import { TREE_LIMIT, usePaging } from "../../state/paged";
import { ConnectTab } from "./ConnectTab";
import { ChangeTypeDialog, ProtectionDialog, StopDialog } from "./InstanceDialogs";
import { CreateImageDialog, SnapshotDialog, TagEditorDialog } from "./TagDialogs";
import { ConsoleTab, StatusTab, UserDataTab } from "./InstanceExtras";
import { InstanceView, type InstanceTab } from "./InstanceView";
import { ResourceList } from "./ResourceList";
import { imageConfig, ImageView, snapshotConfig, SnapshotView, STORAGE_ICONS, volumeConfig, VolumeView, type ImageScope } from "./StorageViews";
import { store, stored } from "./common";

/** Kinds built so far, in tree / overview order. */
const KINDS: Ec2Kind[] = ["instances", "images", "volumes", "snapshots"];

const KIND_ICON: Partial<Record<Ec2Kind, ReactNode>> = { instances: <InstanceIcon state="running" />, ...STORAGE_ICONS };

const ABOUT: Record<Ec2Kind, string> = {
  instances: "Virtual machines: state, type, addresses, storage, networking",
  images: "Machine images (AMIs) you own or that are shared with you",
  volumes: "EBS volumes and what they're attached to",
  snapshots: "EBS snapshots you own",
  securityGroups: "Firewall rules for instances and other resources",
  vpcs: "Virtual private clouds",
  subnets: "Subnets of the VPCs",
  interfaces: "Network interfaces of instances, load balancers and other services",
  addresses: "Elastic IP addresses",
  keyPairs: "SSH key pairs (names and fingerprints)",
  launchTemplates: "Saved launch settings and their versions",
  loadBalancers: "Application, network and gateway load balancers",
  targetGroups: "Load balancer targets and their health",
  autoScaling: "Auto Scaling groups, their instances and activities",
  unused: "Unattached volumes, idle Elastic IPs, unused groups and images",
};

const INSTANCE_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 220 },
  { id: "id", label: "Instance ID", width: 170 },
  { id: "state", label: "State", width: 95 },
  { id: "type", label: "Type", width: 105 },
  { id: "az", label: "Zone", width: 105 },
  { id: "privateIp", label: "Private IP", width: 115 },
  { id: "publicIp", label: "Public IP", width: 115 },
  { id: "launched", label: "Launched", width: 165 },
  { id: "platform", label: "Platform", width: 130 },
  { id: "key", label: "Key pair", width: 130 },
];

const OVERVIEW_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 200 },
  { id: "count", label: "Count", width: 80, align: "right" },
  { id: "about", label: "Description", width: 460 },
];

const STATES_KEY = "ec2.instances.states";

function storedStates(): Set<InstanceState> {
  try {
    const v = localStorage.getItem(STATES_KEY);
    if (v !== null) return new Set(v.split(",").filter((s): s is InstanceState => (INSTANCE_STATES as readonly string[]).includes(s)));
  } catch {
    /* fall through */
  }
  return new Set(DEFAULT_STATES);
}

type Listing<T> = { key: string; items: T[] | null; error: AppError | null };

type Dialog =
  | { kind: "stop"; instances: Instance[] }
  | { kind: "type"; instance: Instance }
  | { kind: "protection"; instance: InstanceDetails }
  | { kind: "tags"; resource: string; label: string; tags: [string, string][] }
  | { kind: "image"; instance: Instance }
  | { kind: "snapshot"; instance: Instance | null; volumeId: string | null }
  | null;

export function useEc2Service(shell: Shell): ServiceUi {
  const { connection, connectionId, profile, place } = shell;
  const active = place.service === "ec2";
  const kind = place.service === "ec2" ? place.kind : null;
  const id = place.service === "ec2" ? place.id : null;
  const region = connection?.serviceRegion ?? "";
  const scope = `${connectionId}|${region}`;
  const go = useCallback((p: Partial<Place & { service: "ec2" }>) => shell.navigate({ ...EC2_ROOT, ...p }), [shell]);

  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reloadToken, setReloadToken] = useState(0);
  const [filters, setFilters] = useState<Partial<Record<Ec2Kind, string>>>({});
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [states, setStatesState] = useState<Set<InstanceState>>(storedStates);
  const [viewInstance, setViewInstance] = useState<InstanceDetails | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [listStatus, setListStatus] = useState("");
  const [imageScope, setImageScopeState] = useState<ImageScope>(() => stored("ec2.images.scope", ["mine", "shared"] as const, "mine"));
  const setImageScope = (s: ImageScope) => {
    setImageScopeState(s);
    store("ec2.images.scope", s);
  };
  const historyKey = `ec2|${profile ?? ""}|${region}|${kind ?? ""}`;
  const filter = kind ? (filters[kind] ?? "") : "";

  useEffect(() => {
    setFilters({});
    setSelected(new Set());
    setExpanded(new Set());
  }, [scope]);
  useEffect(() => setSelected(new Set()), [kind]);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  useEffect(() => {
    if (kind) setExpanded((s) => (s.has(kind) ? s : new Set([...s, kind])));
  }, [kind]);
  useEffect(() => {
    if (!profile || !kind) return;
    api
      .getSettings()
      .then((s) => setHistory(s.filterHistory?.[historyKey] ?? []))
      .catch(() => setHistory([]));
  }, [historyKey, profile, kind]);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);
  const listKey = `${scope}|${reloadToken}`;
  const enabled = !!connection && (open || active);

  // Instances, listed in full.
  const [instances, setInstances] = useState<Listing<Instance> | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled || instances?.key === listKey) return;
    let stale = false;
    setLoading(true);
    ec2Api
      .instances()
      .then((items) => !stale && setInstances({ key: listKey, items, error: null }))
      .catch((e) => !stale && setInstances({ key: listKey, items: null, error: e as AppError }))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, listKey]);

  const setStates = (s: Set<InstanceState>) => {
    setStatesState(s);
    try {
      localStorage.setItem(STATES_KEY, [...s].join(","));
    } catch {
      /* convenience only */
    }
  };

  const instFilter = filters.instances ?? "";
  const allInstances = instances?.items ?? null;
  const shownInstances = useMemo(
    () => (allInstances ? allInstances.filter((i) => states.has((i.state ?? "") as InstanceState) && matchesInstanceFilter(i, instFilter)) : null),
    [allInstances, states, instFilter],
  );
  const byId = useMemo(() => new Map((allInstances ?? []).map((i) => [i.id, i])), [allInstances]);
  const listView = active && kind === "instances" && !id;
  const paging = usePaging(`${listKey}|${instFilter}|${[...states].sort().join(",")}`, shownInstances?.length ?? 0, "ec2.instances.pageSize", listView);

  async function applyFilter(v: string) {
    if (!kind) return;
    setFilters((f) => ({ ...f, [kind]: v }));
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

  const instanceRows: Row[] = useMemo(
    () =>
      paging.slice(shownInstances ?? []).map((i) => ({
        key: i.id,
        icon: <InstanceIcon state={i.state} />,
        isContainer: false,
        dimmed: i.state === "terminated" || i.state === "shutting-down",
        cells: {
          name: { text: i.name ?? "", sort: (i.name ?? "").toLowerCase() || `~${i.id}` },
          id: { text: i.id, sort: i.id },
          state: { text: i.state ?? "", sort: i.state ?? "" },
          type: { text: i.instanceType ?? "", sort: i.instanceType ?? "" },
          az: { text: i.az ?? "", sort: i.az ?? "" },
          privateIp: { text: i.privateIp ?? "", sort: ipSort(i.privateIp) },
          publicIp: { text: i.publicIp ?? "", sort: ipSort(i.publicIp) },
          launched: { text: formatDate(i.launched), sort: i.launched ?? "" },
          platform: { text: i.platform ?? "", sort: i.platform ?? "" },
          key: { text: i.keyName ?? "", sort: i.keyName ?? "" },
        },
      })),
    [paging, shownInstances],
  );

  // ---------------------------------------------------------------------------
  // Instance actions: on the open instance, or the selected rows of the list.

  const inView = active && kind === "instances" && !!id;
  function targets(): Instance[] {
    if (inView) return viewInstance?.id === id ? [viewInstance] : [];
    if (!listView) return [];
    return [...selected].map((k) => byId.get(k)).filter((i): i is Instance => !!i);
  }
  const denied = () => shell.showFlash("Read-only mode: changes are disabled.");
  const done = (msg: string) => {
    setDialog(null);
    shell.showFlash(msg);
    refresh();
  };
  const listText = (list: Instance[]) =>
    list.length === 1 ? (
      <span className="mono">{instanceLabel(list[0])}</span>
    ) : (
      <>
        {list.length} instances: <span className="mono">{list.map((i) => i.name ?? i.id).join(", ")}</span>
      </>
    );

  async function simple(verb: "start" | "reboot", list: Instance[]) {
    if (shell.readOnly) return denied();
    if (!list.length) return;
    const title = verb === "start" ? "Start" : "Reboot";
    const ok = await shell.ask(
      `${title} instance${list.length === 1 ? "" : "s"}`,
      <>
        <p>
          {title} {listText(list)}?
        </p>
        <p className="hint">
          {verb === "start"
            ? "Charges for running time begin again. An auto-assigned public IP address will be a new one."
            : "The operating system restarts; the instance keeps its addresses and disks. Unsaved work in programs is lost."}
        </p>
      </>,
      [
        { label: title, value: "yes", danger: verb === "reboot" },
        { label: "Cancel", value: "no" },
      ],
      "no",
    );
    if (ok !== "yes") return;
    shell.setWorking(verb === "start" ? "Starting…" : "Rebooting…");
    try {
      const ids = list.map((i) => i.id);
      if (verb === "start") await ec2Api.start(ids);
      else await ec2Api.reboot(ids);
      done(`${verb === "start" ? "Starting" : "Rebooting"} ${list.length === 1 ? instanceLabel(list[0]) : `${list.length} instances`}.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
    }
  }

  async function terminate(list: Instance[]) {
    if (shell.readOnly) return denied();
    if (!list.length) return;
    const confirmText = list.length === 1 ? list[0].id : `terminate ${list.length} instances`;
    const keepVolumes = list.some((i) => i.blockDevices.some((b) => b.deleteOnTermination === false));
    const ok = await shell.confirmTyped(
      `Terminate instance${list.length === 1 ? "" : "s"}`,
      <>
        <p>Terminate {listText(list)}? This can't be undone: the instance is deleted.</p>
        <p className="hint">
          Volumes marked "deleted with instance" (usually the root volume) are deleted too{keepVolumes ? "; the others stay and keep costing until you delete them" : ""}. Instance store data is lost. An Auto Scaling group will launch a
          replacement.
        </p>
      </>,
      confirmText,
      "Terminate",
    );
    if (!ok) return;
    shell.setWorking("Terminating…");
    try {
      await ec2Api.terminate(list.map((i) => i.id));
      done(`Terminating ${list.length === 1 ? instanceLabel(list[0]) : `${list.length} instances`}.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
    }
  }

  const openDialog = (d: Dialog) => (shell.readOnly ? denied() : setDialog(d));
  const can = (list: Instance[]) => {
    const a = allowedActions(list.map((i) => i.state));
    return { ...a, type: list.length === 1 && list[0].state === "stopped", protection: list.length === 1 && inView && list[0].state !== "terminated" };
  };

  // Explorer shortcuts: Del terminates, Ctrl+E changes the type.
  const keyOps = useRef({ active: false, modal: false, targets, can, terminate, openDialog });
  keyOps.current = { active: active && kind === "instances", modal: !!dialog, targets, can, terminate, openDialog };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const o = keyOps.current;
      if (!o.active || o.modal) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, .modal-backdrop")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const list = o.targets();
      if (!list.length) return;
      const c = o.can(list);
      if (e.key === "Delete" && !ctrl && c.terminate) {
        e.preventDefault();
        void o.terminate(list);
      } else if (ctrl && !e.shiftKey && e.key === "e" && c.type) {
        e.preventDefault();
        o.openDialog({ kind: "type", instance: list[0] });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function actionItems(list: Instance[]): MenuItem[] {
    const c = can(list);
    const ro = shell.readOnly;
    return [
      { label: "Start", disabled: ro || !c.start, onClick: () => void simple("start", list) },
      { label: "Stop…", disabled: ro || !c.stop, onClick: () => openDialog({ kind: "stop", instances: list }) },
      { label: "Reboot", disabled: ro || !c.reboot, onClick: () => void simple("reboot", list) },
      { label: "Change instance type…", shortcut: "Ctrl+E", disabled: ro || !c.type, onClick: () => openDialog({ kind: "type", instance: list[0] }) },
      { label: "Terminate…", shortcut: "Del", disabled: ro || !c.terminate, onClick: () => void terminate(list) },
      "separator",
      { label: "Create image…", disabled: ro || list.length !== 1 || !c.terminate, onClick: () => openDialog({ kind: "image", instance: list[0] }) },
      { label: "Snapshot volumes…", disabled: ro || list.length !== 1 || !c.terminate || !list[0].blockDevices.some((b) => b.volumeId), onClick: () => openDialog({ kind: "snapshot", instance: list[0], volumeId: null }) },
      { label: "Edit tags…", disabled: ro || list.length !== 1 || list[0].state === "terminated", onClick: () => openDialog({ kind: "tags", resource: list[0].id, label: instanceLabel(list[0]), tags: list[0].tags }) },
    ];
  }

  function instanceMenu(key: string | null, x: number, y: number) {
    const i = key ? byId.get(key) : undefined;
    const items: MenuItem[] = [];
    if (i) {
      // Right-clicking a selected row acts on the whole selection.
      const list = selected.has(i.id) && selected.size > 1 ? [...selected].map((k) => byId.get(k)).filter((x): x is Instance => !!x) : [i];
      items.push(
        { label: "Open", bold: true, shortcut: "Enter", onClick: () => go({ kind: "instances", id: i.id }) },
        "separator",
        ...actionItems(list),
        "separator",
        { label: "Copy instance ID", onClick: () => void shell.copyText(i.id) },
        { label: "Copy private IP", disabled: !i.privateIp, onClick: () => i.privateIp && void shell.copyText(i.privateIp) },
        { label: "Copy public IP", disabled: !i.publicIp, onClick: () => i.publicIp && void shell.copyText(i.publicIp) },
        { label: "Add bookmark…", onClick: () => shell.addBookmark({ ...EC2_ROOT, kind: "instances", id: i.id }, null, i.name ? instanceLabel(i) : null) },
        "separator",
      );
    } else {
      items.push({ label: "Add bookmark…", onClick: () => shell.addBookmark({ ...EC2_ROOT, kind: "instances" }, null, null) }, "separator");
    }
    items.push({ label: "Refresh", shortcut: "F5", onClick: refresh });
    shell.openMenu(x, y, items);
  }

  function kindMenu(k: Ec2Kind, x: number, y: number) {
    shell.openMenu(x, y, [
      { label: "Open", bold: true, onClick: () => go({ kind: k }) },
      { label: "Add bookmark…", onClick: () => shell.addBookmark({ ...EC2_ROOT, kind: k }, null, null) },
      "separator",
      { label: "Refresh", shortcut: "F5", onClick: refresh },
    ]);
  }

  function toggle(k: string) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  }

  const instancesTree = (
    <TreeRow
      key="instances"
      depth={2}
      label={instFilter ? "Instances (filtered)" : "Instances"}
      icon={KIND_ICON.instances}
      selected={active && kind === "instances" && !id}
      expanded={expanded.has("instances")}
      onClick={() => go({ kind: "instances" })}
      onToggle={() => toggle("instances")}
      onContextMenu={(x, y) => kindMenu("instances", x, y)}
    >
      {instances?.error ? (
        <TreeNote depth={3}>Couldn't list instances</TreeNote>
      ) : !shownInstances ? (
        <TreeNote depth={3}>Loading…</TreeNote>
      ) : shownInstances.length === 0 ? (
        <TreeNote depth={3}>{instFilter || states.size < INSTANCE_STATES.length ? "No matching instances" : "No instances"}</TreeNote>
      ) : (
        <>
          {shownInstances.slice(0, TREE_LIMIT).map((i) => (
            <TreeRow
              key={i.id}
              depth={3}
              label={i.name ?? i.id}
              title={`${instanceLabel(i)} · ${i.state ?? ""}`}
              icon={<InstanceIcon state={i.state} />}
              muted={i.state === "terminated"}
              selected={active && kind === "instances" && id === i.id}
              onClick={() => go({ kind: "instances", id: i.id })}
              onContextMenu={(x, y) => instanceMenu(i.id, x, y)}
            />
          ))}
          {shownInstances.length > TREE_LIMIT && <TreeNote depth={3}>{`${(shownInstances.length - TREE_LIMIT).toLocaleString()} more in the list`}</TreeNote>}
        </>
      )}
    </TreeRow>
  );

  const tree = connection ? (
    <TreeRow depth={1} label="EC2" icon={<Ec2Icon />} selected={active && !kind} expanded={open} title={`EC2 · ${region}`} onClick={() => go({})} onToggle={() => setOpen((v) => !v)}>
      {KINDS.map((k) =>
        k === "instances" ? (
          instancesTree
        ) : (
          <TreeRow key={k} depth={2} label={filters[k] ? `${EC2_KIND_LABEL[k]} (filtered)` : EC2_KIND_LABEL[k]} icon={KIND_ICON[k]} selected={active && kind === k && !id} onClick={() => go({ kind: k })} onContextMenu={(x, y) => kindMenu(k, x, y)} />
        ),
      )}
    </TreeRow>
  ) : null;

  const instanceTabs: InstanceTab[] = [
    { id: "connect", label: "Connect", help: "ec2.instance.connect", render: (i) => <ConnectTab shell={shell} i={i} /> },
    { id: "status", label: "Status checks", help: "ec2.instance.status", render: (i) => <StatusTab shell={shell} i={i} /> },
    { id: "console", label: "Console", help: "ec2.instance.console", render: (i) => <ConsoleTab shell={shell} i={i} /> },
    { id: "userdata", label: "User data", help: "ec2.instance.userdata", render: (i) => <UserDataTab key={i.id} shell={shell} i={i} /> },
  ];

  const imageControls = (
    <div className="segmented small" title="Images you own, or images other accounts share with yours">
      <button className={imageScope === "mine" ? "active" : ""} onClick={() => setImageScope("mine")}>
        Mine
      </button>
      <button className={imageScope === "shared" ? "active" : ""} onClick={() => setImageScope("shared")}>
        Shared with me
      </button>
    </div>
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const images = useMemo(() => imageConfig(imageScope, imageControls), [imageScope]);
  const volumes = useMemo(() => volumeConfig(byId), [byId]);
  const snapshots = useMemo(() => snapshotConfig(), []);
  const editTags = (resource: string, label: string, tags: [string, string][]) => openDialog({ kind: "tags", resource, label, tags });

  let content: ReactNode = null;
  let status = "";
  if (active && !id && (kind === "images" || kind === "volumes" || kind === "snapshots")) {
    content =
      kind === "images" ? (
        <ResourceList key={kind} shell={shell} config={images} reloadToken={reloadToken} onStatus={setListStatus} />
      ) : kind === "volumes" ? (
        <ResourceList key={kind} shell={shell} config={volumes} reloadToken={reloadToken} onStatus={setListStatus} />
      ) : (
        <ResourceList key={kind} shell={shell} config={snapshots} reloadToken={reloadToken} onStatus={setListStatus} />
      );
    status = listStatus;
  } else if (active && id && kind === "images") {
    content = (
      <div className="service-pane scroll-pane">
        <ImageView key={id} shell={shell} id={id} reloadToken={reloadToken} instances={allInstances} onEditTags={(i) => editTags(i.id, i.name ?? i.id, i.tags)} />
      </div>
    );
    status = `Image ${id} · ${region}`;
  } else if (active && id && kind === "volumes") {
    content = (
      <div className="service-pane scroll-pane">
        <VolumeView key={id} shell={shell} id={id} reloadToken={reloadToken} instances={byId} onEditTags={(v) => editTags(v.id, v.name ?? v.id, v.tags)} onSnapshot={(v) => openDialog({ kind: "snapshot", instance: null, volumeId: v.id })} />
      </div>
    );
    status = `Volume ${id} · ${region}`;
  } else if (active && id && kind === "snapshots") {
    content = (
      <div className="service-pane scroll-pane">
        <SnapshotView key={id} shell={shell} id={id} reloadToken={reloadToken} onEditTags={(s) => editTags(s.id, s.name ?? s.id, s.tags)} />
      </div>
    );
    status = `Snapshot ${id} · ${region}`;
  } else if (active && !kind) {
    const rows: Row[] = KINDS.map((k, n) => ({
      key: k,
      icon: KIND_ICON[k],
      isContainer: true,
      cells: {
        name: { text: EC2_KIND_LABEL[k], sort: n },
        count: { text: k === "instances" ? (allInstances ? allInstances.filter((i) => i.state !== "terminated").length.toLocaleString() : instances?.error ? "?" : "…") : "", sort: n },
        about: { text: ABOUT[k], sort: k },
      },
    }));
    content = (
      <div className="service-pane">
        <HelpTopic id="ec2.overview" />
        <FileList storageKey="ec2.overview" columns={OVERVIEW_COLUMNS} rows={rows} selected={selected} onSelectionChange={setSelected} onOpen={(k) => go({ kind: k as Ec2Kind })} onContextMenu={(k, x, y) => k && kindMenu(k as Ec2Kind, x, y)} emptyText="" />
      </div>
    );
    status = `EC2 · ${region}`;
  } else if (listView) {
    const total = allInstances?.length ?? 0;
    content = (
      <div className="service-pane">
        <HelpTopic id="ec2.instances" />
        <FilterBox
          label="Filter:"
          applied={filter}
          history={history}
          placeholder="Name, instance ID prefix, or tag as key=value (Enter to apply)"
          onApply={(v) => void applyFilter(v)}
          onClear={() => setFilters((f) => ({ ...f, instances: "" }))}
          onForget={(v) => void forget(v)}
          onClearHistory={() => void forget(null)}
        >
          <div className="segmented small ec2-states" title="Show instances in these states">
            {INSTANCE_STATES.map((s) => (
              <button
                key={s}
                className={states.has(s) ? "active" : ""}
                onClick={() => {
                  const n = new Set(states);
                  if (n.has(s)) n.delete(s);
                  else n.add(s);
                  setStates(n);
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </FilterBox>
        {instances?.error ? (
          <ErrorPanel error={instances.error} profile={profile} onRetry={refresh} />
        ) : (
          <>
            <FileList
              storageKey="ec2.instances"
              columns={INSTANCE_COLUMNS}
              rows={instanceRows}
              selected={selected}
              onSelectionChange={setSelected}
              onOpen={(k) => go({ kind: "instances", id: k })}
              onContextMenu={instanceMenu}
              emptyText={!shownInstances ? "Loading…" : total === 0 ? "No instances in this region." : states.size === 0 ? "No states are ticked." : "No instances match the filter and states."}
            />
            {shownInstances && shownInstances.length > paging.pageSize && <PageBar {...paging.bar} loading={false} />}
          </>
        )}
      </div>
    );
    if (shownInstances) status = `${shownInstances.length.toLocaleString()} of ${total.toLocaleString()} instance${total === 1 ? "" : "s"} · ${region}`;
  } else if (active && kind === "instances" && id) {
    content = (
      <div className="service-pane scroll-pane">
        <InstanceView key={id} shell={shell} id={id} reloadToken={reloadToken} onLoaded={(i) => setViewInstance(i)}
          tabs={instanceTabs}
          onEditTags={(i) => openDialog({ kind: "tags", resource: i.id, label: instanceLabel(i), tags: i.tags })}
          onSnapshotVolume={(v) => openDialog({ kind: "snapshot", instance: null, volumeId: v })}
        />
      </div>
    );
    const v = viewInstance?.id === id ? viewInstance : null;
    status = `${v ? instanceLabel(v) : id}${v?.state ? ` · ${v.state}` : ""} · ${region}`;
  }

  const t = active && kind === "instances" ? targets() : [];
  const c = can(t);
  const off = (ok: boolean) => !connection || shell.readOnly || !ok;
  const commands = active ? (
    <>
      <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} />
      {kind === "instances" && (
        <>
          <CommandButton icon={<PlayIcon />} label="Start" title="Start the stopped instances" disabled={off(c.start)} onClick={() => void simple("start", t)} />
          <CommandButton icon={<StopIcon />} label="Stop" title="Stop (or hibernate) the instances" disabled={off(c.stop)} onClick={() => openDialog({ kind: "stop", instances: t })} />
          <CommandButton icon={<RedriveIcon />} label="Reboot" title="Restart the operating system" disabled={off(c.reboot)} onClick={() => void simple("reboot", t)} />
          <CommandButton icon={<EditIcon />} label="Change type" title="Change a stopped instance's type (Ctrl+E)" disabled={off(c.type)} onClick={() => openDialog({ kind: "type", instance: t[0] })} />
          {inView && (
            <CommandButton
              icon={<LockIcon />}
              label="Protection"
              title="Termination and stop protection"
              disabled={off(c.protection)}
              onClick={() => viewInstance && openDialog({ kind: "protection", instance: viewInstance })}
            />
          )}
          <CommandButton icon={<DeleteIcon />} label="Terminate" title="Terminate the instances (Del)" disabled={off(c.terminate)} onClick={() => void terminate(t)} />
          <CommandButton icon={<ImageIcon />} label="Create image" title="Create an AMI from the instance" disabled={off(t.length === 1 && c.terminate)} onClick={() => openDialog({ kind: "image", instance: t[0] })} />
          <CommandButton
            icon={<SnapshotIcon />}
            label="Snapshot"
            title="Snapshot all the instance's EBS volumes at once"
            disabled={off(t.length === 1 && c.terminate && t[0].blockDevices.some((b) => b.volumeId))}
            onClick={() => openDialog({ kind: "snapshot", instance: t[0], volumeId: null })}
          />
        </>
      )}
    </>
  ) : null;
  const dialogs =
    dialog?.kind === "stop" ? (
      <StopDialog instances={dialog.instances} onClose={() => setDialog(null)} onDone={done} />
    ) : dialog?.kind === "type" ? (
      <ChangeTypeDialog instance={dialog.instance} onClose={() => setDialog(null)} onDone={done} />
    ) : dialog?.kind === "protection" ? (
      <ProtectionDialog shell={shell} instance={dialog.instance} onClose={() => setDialog(null)} onDone={done} />
    ) : dialog?.kind === "tags" ? (
      <TagEditorDialog resource={dialog.resource} label={dialog.label} tags={dialog.tags} onClose={() => setDialog(null)} onDone={done} />
    ) : dialog?.kind === "image" ? (
      <CreateImageDialog instance={dialog.instance} onClose={() => setDialog(null)} onDone={done} />
    ) : dialog?.kind === "snapshot" ? (
      <SnapshotDialog instance={dialog.instance} volumeId={dialog.volumeId} onClose={() => setDialog(null)} onDone={done} />
    ) : null;
  return { tree, content, commands, status, busy: active && loading, refresh, dialogs };
}

/** Sorts dotted IPv4 addresses numerically ("" last). */
function ipSort(ip: string | null): string {
  if (!ip) return "~";
  return ip
    .split(".")
    .map((p) => p.padStart(3, "0"))
    .join(".");
}
