// EC2 controller: an overview of the resource kinds, then one list per kind
// and a view per resource. Instances load in full and page on screen; state
// chips and the remembered filter narrow the list (and the tree).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type AppError } from "../../api/s3";
import { DEFAULT_STATES, ec2Api, INSTANCE_STATES, instanceLabel, matchesInstanceFilter, type Instance, type InstanceDetails, type InstanceState } from "../../api/ec2";
import { CommandButton } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { FilterBox } from "../../components/FilterBox";
import { HelpTopic } from "../../components/HelpDialog";
import { Ec2Icon, InstanceIcon, RefreshIcon } from "../../components/Icons";
import { PageBar } from "../../components/PageBar";
import { TreeNote, TreeRow } from "../../components/TreeRow";
import { formatDate } from "../../format";
import { EC2_KIND_LABEL, EC2_ROOT, type Ec2Kind, type Place } from "../../shell/places";
import type { ServiceUi, Shell } from "../../shell/shell";
import { TREE_LIMIT, usePaging } from "../../state/paged";
import { ConsoleTab, StatusTab, UserDataTab } from "./InstanceExtras";
import { InstanceView, type InstanceTab } from "./InstanceView";

/** Kinds built so far, in tree / overview order. */
const KINDS: Ec2Kind[] = ["instances"];

const KIND_ICON: Partial<Record<Ec2Kind, ReactNode>> = { instances: <InstanceIcon state="running" /> };

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

  function instanceMenu(key: string | null, x: number, y: number) {
    const i = key ? byId.get(key) : undefined;
    const items: MenuItem[] = [];
    if (i) {
      items.push(
        { label: "Open", bold: true, shortcut: "Enter", onClick: () => go({ kind: "instances", id: i.id }) },
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
    { id: "status", label: "Status checks", help: "ec2.instance.status", render: (i) => <StatusTab shell={shell} i={i} /> },
    { id: "console", label: "Console", help: "ec2.instance.console", render: (i) => <ConsoleTab shell={shell} i={i} /> },
    { id: "userdata", label: "User data", help: "ec2.instance.userdata", render: (i) => <UserDataTab key={i.id} shell={shell} i={i} /> },
  ];

  let content: ReactNode = null;
  let status = "";
  if (active && !kind) {
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
        <InstanceView key={id} shell={shell} id={id} reloadToken={reloadToken} onLoaded={(i) => setViewInstance(i)} tabs={instanceTabs} />
      </div>
    );
    const v = viewInstance?.id === id ? viewInstance : null;
    status = `${v ? instanceLabel(v) : id}${v?.state ? ` · ${v.state}` : ""} · ${region}`;
  }

  const commands = active ? <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} /> : null;
  return { tree, content, commands, status, busy: active && loading, refresh, dialogs: null };
}

/** Sorts dotted IPv4 addresses numerically ("" last). */
function ipSort(ip: string | null): string {
  if (!ip) return "~";
  return ip
    .split(".")
    .map((p) => p.padStart(3, "0"))
    .join(".");
}
