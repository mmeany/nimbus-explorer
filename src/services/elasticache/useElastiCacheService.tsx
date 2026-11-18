// ElastiCache controller: replication groups and serverless caches (both
// listed in full, paged on screen, with the remembered name filter), the
// tree (groups expand to shards and nodes), and the cache views.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type AppError } from "../../api/s3";
import { ecApi, endpointText, engineLabel, groupTarget, limitsText, serverlessTarget, type Group, type GroupDetails, type Serverless } from "../../api/elasticache";
import { CommandButton } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { FilterBox } from "../../components/FilterBox";
import { CacheGroupIcon, CacheNodeIcon, CacheShardIcon, ElastiCacheIcon, RefreshIcon, ServerlessCacheIcon, SnapshotIcon } from "../../components/Icons";
import { PageBar } from "../../components/PageBar";
import { TreeNote, TreeRow } from "../../components/TreeRow";
import { EC_ROOT, type Place } from "../../shell/places";
import type { ServiceUi, Shell } from "../../shell/shell";
import { TREE_LIMIT, usePaging } from "../../state/paged";
import { GroupView, ServerlessView, type GroupTab, type ServerlessTab } from "./CacheViews";
import { ConnectTab } from "./ConnectTab";
import { EventsTab } from "./EventsTab";
import { SnapshotList } from "./Snapshots";

const COLUMNS: Column[] = [
  { id: "name", label: "Cache", width: 240 },
  { id: "type", label: "Type", width: 130 },
  { id: "engine", label: "Engine", width: 90 },
  { id: "size", label: "Node type / limits", width: 190 },
  { id: "shards", label: "Shards", width: 60, align: "right" },
  { id: "nodes", label: "Nodes", width: 60, align: "right" },
  { id: "status", label: "Status", width: 100 },
  { id: "security", label: "Encryption", width: 130 },
  { id: "endpoint", label: "Endpoint", width: 260 },
  { id: "description", label: "Description", width: 260 },
];

type Item = { kind: "group"; g: Group } | { kind: "serverless"; s: Serverless };
const itemName = (i: Item) => (i.kind === "group" ? i.g.id : i.s.name);
const itemKey = (i: Item) => `${i.kind === "group" ? "g" : "s"}:${itemName(i)}`;
const placeOf = (i: Item): Place => ({ ...EC_ROOT, kind: i.kind, id: itemName(i) });

export function useElastiCacheService(shell: Shell): ServiceUi {
  const { connection, connectionId, profile, place } = shell;
  const active = place.service === "elasticache";
  const kind = place.service === "elasticache" ? place.kind : null;
  const id = place.service === "elasticache" ? place.id : null;
  const region = connection?.serviceRegion ?? "";
  const scope = `${connectionId}|${region}`;
  const historyKey = `elasticache|${profile ?? ""}|${region}`;

  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [listing, setListing] = useState<{ key: string; items: Item[] | null; error: AppError | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewGroup, setViewGroup] = useState<GroupDetails | null>(null);
  const [viewServerless, setViewServerless] = useState<Serverless | null>(null);

  useEffect(() => {
    setListing(null);
    setFilter("");
    setSelected(new Set());
    setExpanded(new Set());
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

  // Groups and serverless caches, each listed in full.
  const listKey = `${scope}|${reloadToken}`;
  useEffect(() => {
    if (!connection || !(open || active) || listing?.key === listKey) return;
    let stale = false;
    setLoading(true);
    Promise.all([ecApi.listGroups(), ecApi.listServerless()])
      .then(([groups, serverless]) => {
        if (stale) return;
        const items: Item[] = [...groups.map((g): Item => ({ kind: "group", g })), ...serverless.map((s): Item => ({ kind: "serverless", s }))];
        items.sort((a, b) => itemName(a).localeCompare(itemName(b)));
        setListing({ key: listKey, items, error: null });
      })
      .catch((e) => !stale && setListing({ key: listKey, items: null, error: e as AppError }))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, open, active, listKey]);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);
  const all = listing?.key === listKey ? listing.items : (listing?.items ?? null);
  const items = useMemo(() => (all && filter ? all.filter((i) => itemName(i).startsWith(filter)) : all), [all, filter]);
  const byKey = useMemo(() => new Map((all ?? []).map((i) => [itemKey(i), i])), [all]);
  const listView = active && !kind;
  const paging = usePaging(`${scope}|${filter}`, items?.length ?? 0, "elasticache.pageSize", listView);
  const pageItems = useMemo(() => paging.slice(items ?? []), [paging, items]);

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

  const rows: Row[] = useMemo(
    () =>
      pageItems.map((i): Row => {
        const name = itemName(i);
        if (i.kind === "group") {
          const g = i.g;
          const ep = g.clusterMode ? g.configurationEndpoint : g.shards[0]?.primaryEndpoint;
          return {
            key: itemKey(i),
            icon: <CacheGroupIcon cluster={g.clusterMode} />,
            isContainer: false,
            dimmed: g.status === "deleting",
            cells: {
              name: { text: name, sort: name },
              type: { text: g.clusterMode ? "Cluster mode on" : "Cluster mode off", sort: g.clusterMode ? 1 : 0 },
              engine: { text: engineLabel(g.engine), sort: g.engine ?? "" },
              size: { text: g.nodeType ?? "", sort: g.nodeType ?? "" },
              shards: { text: String(g.shards.length), sort: g.shards.length },
              nodes: { text: String(g.memberCount), sort: g.memberCount },
              status: { text: g.status ?? "", sort: g.status ?? "" },
              security: { text: [g.transitEncryption ? "in transit" : "", g.atRestEncryption ? "at rest" : ""].filter(Boolean).join(", ") || "none", sort: (g.transitEncryption ? 2 : 0) + (g.atRestEncryption ? 1 : 0) },
              endpoint: { text: endpointText(ep), sort: endpointText(ep) },
              description: { text: g.description ?? "", sort: g.description ?? "" },
            },
          };
        }
        const s = i.s;
        return {
          key: itemKey(i),
          icon: <ServerlessCacheIcon />,
          isContainer: false,
          dimmed: s.status === "deleting",
          cells: {
            name: { text: name, sort: name },
            type: { text: "Serverless", sort: 2 },
            engine: { text: engineLabel(s.engine), sort: s.engine ?? "" },
            size: { text: limitsText(s.limits) || "no limits", sort: "" },
            shards: { text: "", sort: -1 },
            nodes: { text: "", sort: -1 },
            status: { text: s.status ?? "", sort: s.status ?? "" },
            security: { text: "in transit, at rest", sort: 3 },
            endpoint: { text: endpointText(s.endpoint), sort: endpointText(s.endpoint) },
            description: { text: s.description ?? "", sort: s.description ?? "" },
          },
        };
      }),
    [pageItems],
  );

  const go = useCallback((p: Place) => shell.navigate(p), [shell]);

  function menu(key: string | null, x: number, y: number) {
    const i = key ? byKey.get(key) : undefined;
    const items: MenuItem[] = [];
    if (i) {
      const arn = i.kind === "group" ? i.g.arn : i.s.arn;
      const ep = i.kind === "group" ? endpointText(i.g.clusterMode ? i.g.configurationEndpoint : i.g.shards[0]?.primaryEndpoint) : endpointText(i.s.endpoint);
      items.push(
        { label: "Open", bold: true, shortcut: "Enter", onClick: () => go(placeOf(i)) },
        "separator",
        { label: "Copy name", onClick: () => void shell.copyText(itemName(i)) },
        { label: "Copy endpoint", disabled: !ep, onClick: () => void shell.copyText(ep) },
        { label: "Copy ARN", disabled: !arn, onClick: () => arn && void shell.copyText(arn) },
        { label: "Add bookmark…", onClick: () => shell.addBookmark(placeOf(i), null, null) },
        "separator",
      );
    }
    items.push({ label: "Refresh", shortcut: "F5", onClick: refresh });
    shell.openMenu(x, y, items);
  }

  function toggle(k: string) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  }

  function groupTree(g: Group, i: Item) {
    const k = itemKey(i);
    const isOpen = expanded.has(k);
    const sel = active && kind === "group" && id === g.id;
    const node = (m: Group["shards"][number]["members"][number], depth: number) => (
      <TreeRow key={m.clusterId} depth={depth} label={m.clusterId} icon={<CacheNodeIcon primary={m.role === "primary"} />} title={[m.role, m.az, endpointText(m.endpoint)].filter(Boolean).join(" · ")} onClick={() => go(placeOf(i))} />
    );
    return (
      <TreeRow key={k} depth={2} label={g.id} icon={<CacheGroupIcon cluster={g.clusterMode} />} selected={sel} expanded={isOpen} muted={g.status === "deleting"} onClick={() => go(placeOf(i))} onToggle={() => toggle(k)} onContextMenu={(x, y) => menu(k, x, y)}>
        {g.clusterMode
          ? g.shards.map((s) => {
              const sk = `${k}|${s.id}`;
              return (
                <TreeRow key={sk} depth={3} label={`Shard ${s.id}`} icon={<CacheShardIcon />} title={s.slots ? `slots ${s.slots}` : undefined} expanded={expanded.has(sk)} onToggle={() => toggle(sk)} onClick={() => toggle(sk)}>
                  {s.members.map((m) => node(m, 4))}
                </TreeRow>
              );
            })
          : g.shards.flatMap((s) => s.members.map((m) => node(m, 3)))}
      </TreeRow>
    );
  }

  const tree = connection ? (
    <TreeRow depth={1} label={filter ? "ElastiCache (filtered)" : "ElastiCache"} icon={<ElastiCacheIcon />} selected={listView} expanded={open} title={`ElastiCache · ${region}`} onClick={() => go(EC_ROOT)} onToggle={() => setOpen((v) => !v)}>
      <TreeRow depth={2} label="Snapshots" icon={<SnapshotIcon />} selected={active && kind === "snapshots"} onClick={() => go({ ...EC_ROOT, kind: "snapshots" })} />
      {listing?.error ? (
        <TreeNote depth={2}>Couldn't list caches</TreeNote>
      ) : !items ? (
        <TreeNote depth={2}>Loading…</TreeNote>
      ) : items.length === 0 ? (
        <TreeNote depth={2}>{filter ? "No matching caches" : "No caches"}</TreeNote>
      ) : (
        <>
          {items.slice(0, TREE_LIMIT).map((i) =>
            i.kind === "group" ? (
              groupTree(i.g, i)
            ) : (
              <TreeRow key={itemKey(i)} depth={2} label={i.s.name} icon={<ServerlessCacheIcon />} selected={active && kind === "serverless" && id === i.s.name} onClick={() => go(placeOf(i))} onContextMenu={(x, y) => menu(itemKey(i), x, y)} />
            ),
          )}
          {items.length > TREE_LIMIT && <TreeNote depth={2}>{`${(items.length - TREE_LIMIT).toLocaleString()} more in the list`}</TreeNote>}
        </>
      )}
    </TreeRow>
  ) : null;

  const groupTabs: GroupTab[] = [
    { id: "connect", label: "Connect", help: "elasticache.connect", render: (g) => <ConnectTab shell={shell} t={groupTarget(g)} /> },
    { id: "snapshots", label: "Snapshots", help: "elasticache.snapshots", render: (g) => <SnapshotList shell={shell} cache={{ kind: "group", id: g.id }} reloadToken={reloadToken} /> },
    { id: "events", label: "Events", help: "elasticache.events", render: (g) => <EventsTab shell={shell} kind="group" id={g.id} reloadToken={reloadToken} /> },
  ];
  const serverlessTabs: ServerlessTab[] = [
    { id: "connect", label: "Connect", help: "elasticache.connect", render: (s) => <ConnectTab shell={shell} t={serverlessTarget(s)} /> },
    { id: "snapshots", label: "Snapshots", help: "elasticache.snapshots", render: (s) => <SnapshotList shell={shell} cache={{ kind: "serverless", id: s.name }} reloadToken={reloadToken} /> },
    { id: "events", label: "Events", help: "elasticache.events", render: (s) => <EventsTab shell={shell} kind="serverless" id={s.name} reloadToken={reloadToken} /> },
  ];

  let content: ReactNode = null;
  let status = "";
  if (listView) {
    const groups = (items ?? []).filter((i) => i.kind === "group").length;
    content = (
      <div className="service-pane">
        <FilterBox
          label="Filter:"
          applied={filter}
          history={history}
          placeholder="Cache name prefix (Enter to apply)"
          onApply={(v) => void applyFilter(v)}
          onClear={() => setFilter("")}
          onForget={(v) => void forget(v)}
          onClearHistory={() => void forget(null)}
        />
        {listing?.error ? (
          <ErrorPanel error={listing.error} profile={profile} onRetry={refresh} />
        ) : (
          <>
            <FileList
              storageKey="elasticache.caches"
              columns={COLUMNS}
              rows={rows}
              selected={selected}
              onSelectionChange={setSelected}
              onOpen={(k) => {
                const i = byKey.get(k);
                if (i) go(placeOf(i));
              }}
              onContextMenu={menu}
              emptyText={!items ? "Loading…" : filter ? `No caches begin with "${filter}".` : "No Valkey or Redis OSS caches in this region."}
            />
            {items && items.length > paging.pageSize && <PageBar {...paging.bar} loading={false} />}
          </>
        )}
      </div>
    );
    if (items) status = `${groups.toLocaleString()} replication group${groups === 1 ? "" : "s"}, ${(items.length - groups).toLocaleString()} serverless${filter ? ` beginning with "${filter}"` : ""} · ${region}`;
  } else if (active && kind === "snapshots") {
    content = <SnapshotList shell={shell} cache={null} reloadToken={reloadToken} />;
    status = `Snapshots · ${region}`;
  } else if (active && kind === "group" && id) {
    content = (
      <div className="service-pane scroll-pane">
        <GroupView key={id} shell={shell} id={id} reloadToken={reloadToken} onLoaded={setViewGroup} tabs={groupTabs} />
      </div>
    );
    status = `${id}${viewGroup?.id === id ? ` · ${viewGroup.status ?? ""} · ${viewGroup.memberCount} node${viewGroup.memberCount === 1 ? "" : "s"}` : ""} · ${region}`;
  } else if (active && kind === "serverless" && id) {
    content = (
      <div className="service-pane scroll-pane">
        <ServerlessView key={id} shell={shell} name={id} reloadToken={reloadToken} onLoaded={setViewServerless} tabs={serverlessTabs} />
      </div>
    );
    status = `${id}${viewServerless?.name === id ? ` · ${viewServerless.status ?? ""} · serverless` : ""} · ${region}`;
  }

  const commands = active ? <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} /> : null;
  return { tree, content, commands, status, busy: active && loading, refresh, dialogs: null };
}
