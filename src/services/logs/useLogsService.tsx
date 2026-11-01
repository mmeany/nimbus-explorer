// CloudWatch Logs controller: log groups (paged by token, prefix filter with
// history), and a group view with its events (shared LogViewer) and streams.
// Everything here is read only.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type AppError } from "../../api/s3";
import { logsApi, retentionLabel, type LogGroup, type LogStream } from "../../api/logs";
import { CommandButton } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { FilterBox } from "../../components/FilterBox";
import { LogGroupIcon, LogStreamIcon, LogsIcon, RefreshIcon } from "../../components/Icons";
import { PageBar } from "../../components/PageBar";
import { TreeNote, TreeRow } from "../../components/TreeRow";
import { formatDate, formatSize } from "../../format";
import type { ServiceUi, Shell } from "../../shell/shell";
import { TREE_LIMIT, useTokenPages } from "../../state/paged";
import { LogViewer } from "./LogViewer";

const GROUP_COLUMNS: Column[] = [
  { id: "name", label: "Log group", width: 380 },
  { id: "retention", label: "Retention", width: 110 },
  { id: "size", label: "Stored", width: 90, align: "right" },
  { id: "class", label: "Class", width: 120 },
  { id: "filters", label: "Metric filters", width: 95, align: "right" },
  { id: "created", label: "Created", width: 165 },
];

const STREAM_COLUMNS: Column[] = [
  { id: "name", label: "Log stream", width: 420 },
  { id: "last", label: "Last event", width: 170 },
  { id: "first", label: "First event", width: 170 },
  { id: "created", label: "Created", width: 170 },
];

export function useLogsService(shell: Shell): ServiceUi {
  const { connection, connectionId, profile, place } = shell;
  const active = place.service === "logs";
  const group = place.service === "logs" ? place.group : null;
  const region = connection?.serviceRegion ?? "";
  const scope = `${connectionId}|${region}`;
  const historyKey = `logs|${profile ?? ""}|${region}`;
  const go = useCallback((g: string | null) => shell.navigate({ service: "logs", group: g }), [shell]);

  const [open, setOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<"events" | "streams">("events");
  /** Streams the events view is narrowed to, tied to its group. */
  const [narrow, setNarrow] = useState<{ group: string; streams: string[] } | null>(null);
  const [details, setDetails] = useState<{ name: string; group: LogGroup | null; error: AppError | null } | null>(null);

  useEffect(() => {
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

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);

  // Log groups, a page at a time (DescribeLogGroups has a prefix filter but no counts).
  const listKey = `${scope}|${filter}|${reloadToken}`;
  const fetchGroups = useCallback(
    (token: string | null, size: number) => logsApi.listGroups(filter, token, size).then((r) => ({ items: r.groups, nextToken: r.nextToken })),
    // listKey covers scope / filter / reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listKey],
  );
  const groups = useTokenPages<LogGroup>(listKey, "logs.groups.pageSize", !!connection && (open || active), fetchGroups);

  // The open group's details.
  useEffect(() => {
    if (!active || !group || !connection) return;
    let live = true;
    setDetails((d) => (d?.name === group ? d : { name: group, group: null, error: null }));
    logsApi
      .describeGroup(group)
      .then((g) => live && setDetails({ name: group, group: g, error: null }))
      .catch((e) => live && setDetails({ name: group, group: null, error: e as AppError }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, group, scope, reloadToken]);

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

  const groupRows: Row[] = useMemo(
    () =>
      (groups.items ?? []).map((g) => ({
        key: g.name,
        icon: <LogGroupIcon />,
        isContainer: false,
        cells: {
          name: { text: g.name, sort: g.name },
          retention: { text: retentionLabel(g.retentionDays), sort: g.retentionDays || 1e9 },
          size: { text: g.storedBytes !== null ? formatSize(g.storedBytes) : "", sort: g.storedBytes ?? -1 },
          class: { text: g.class === "INFREQUENT_ACCESS" ? "Infrequent access" : g.class ? "Standard" : "", sort: g.class ?? "" },
          filters: { text: g.metricFilters ? String(g.metricFilters) : "", sort: g.metricFilters ?? 0 },
          created: { text: formatDate(g.created), sort: g.created ?? "" },
        },
      })),
    [groups.items],
  );

  function groupMenu(key: string | null, x: number, y: number) {
    const items: MenuItem[] = [];
    const g = key ? groups.items?.find((x) => x.name === key) : undefined;
    if (key) {
      items.push(
        { label: "Open", bold: true, shortcut: "Enter", onClick: () => go(key) },
        "separator",
        { label: "Copy name", onClick: () => void shell.copyText(key) },
        ...(g?.arn ? [{ label: "Copy ARN", onClick: () => void shell.copyText(g.arn!) } as MenuItem] : []),
        "separator",
      );
    }
    items.push({ label: "Refresh", shortcut: "F5", onClick: refresh });
    shell.openMenu(x, y, items);
  }

  // ---------------------------------------------------------------------------
  // Tree: the groups on the current page.

  const treeGroups = groups.items;
  const tree = connection ? (
    <TreeRow
      depth={1}
      label={filter ? "CloudWatch Logs (filtered)" : "CloudWatch Logs"}
      icon={<LogsIcon />}
      selected={active && !group}
      expanded={open}
      title={`CloudWatch Logs · ${region}`}
      onClick={() => go(null)}
      onToggle={() => setOpen((v) => !v)}
    >
      {groups.error ? (
        <TreeNote depth={2}>Couldn't list log groups</TreeNote>
      ) : !treeGroups ? (
        <TreeNote depth={2}>Loading…</TreeNote>
      ) : treeGroups.length === 0 ? (
        <TreeNote depth={2}>{filter ? "No matching log groups" : "No log groups"}</TreeNote>
      ) : (
        <>
          {treeGroups.slice(0, TREE_LIMIT).map((g) => (
            <TreeRow
              key={g.name}
              depth={2}
              label={g.name}
              icon={<LogGroupIcon />}
              selected={active && group === g.name}
              title={g.name}
              onClick={() => go(g.name)}
              onContextMenu={(x, y) => groupMenu(g.name, x, y)}
            />
          ))}
          {(treeGroups.length > TREE_LIMIT || groups.bar.hasNext) && <TreeNote depth={2}>More in the list</TreeNote>}
        </>
      )}
    </TreeRow>
  ) : null;

  // ---------------------------------------------------------------------------
  // Content

  let content: ReactNode = null;
  let status = "";
  if (active && !group) {
    content = (
      <div className="service-pane">
        <FilterBox
          label="Filter:"
          applied={filter}
          history={history}
          placeholder="Log group name prefix, e.g. /aws/lambda/ (Enter to apply)"
          onApply={(v) => void applyFilter(v)}
          onClear={() => setFilter("")}
          onForget={(v) => void forget(v)}
          onClearHistory={() => void forget(null)}
        />
        {groups.error ? (
          <ErrorPanel error={groups.error} profile={profile} onRetry={refresh} />
        ) : (
          <>
            <FileList
              columns={GROUP_COLUMNS}
              rows={groupRows}
              selected={selected}
              onSelectionChange={setSelected}
              onOpen={(k) => go(k)}
              onContextMenu={groupMenu}
              emptyText={!groups.items ? "Loading…" : filter ? `No log groups begin with "${filter}".` : "No log groups in this region."}
            />
            {(groups.bar.page > 0 || groups.bar.hasNext) && <PageBar {...groups.bar} />}
          </>
        )}
      </div>
    );
    if (groups.items) {
      status = `${groups.items.length.toLocaleString()} log group${groups.items.length === 1 ? "" : "s"} on this page${filter ? ` beginning with "${filter}"` : ""} · ${region}`;
    }
  } else if (active && group) {
    const d = details?.name === group ? details : null;
    const g = d?.group ?? null;
    const streams = narrow?.group === group ? narrow.streams : [];
    content = d?.error ? (
      <ErrorPanel error={d.error} profile={profile} onRetry={refresh} />
    ) : (
      <div className="service-pane log-group-view">
        <div className="qv-head">
          <span className="qv-name">{group}</span>
          {g && (
            <span className="hint">
              Retention {retentionLabel(g.retentionDays).toLowerCase()}
              {g.storedBytes !== null ? ` · ${formatSize(g.storedBytes)} stored` : ""}
              {g.class === "INFREQUENT_ACCESS" ? " · Infrequent access" : ""}
              {g.kmsKey ? " · KMS encrypted" : ""}
              {g.created ? ` · created ${formatDate(g.created)}` : ""}
            </span>
          )}
          <div className="spacer" />
          {g?.arn && (
            <button className="link-btn" onClick={() => void shell.copyText(g.arn!)}>
              Copy ARN
            </button>
          )}
        </div>
        <div className="segmented small db-tabs">
          <button className={tab === "events" ? "active" : ""} onClick={() => setTab("events")}>
            Events
          </button>
          <button className={tab === "streams" ? "active" : ""} onClick={() => setTab("streams")}>
            Streams
          </button>
        </div>
        {tab === "events" ? (
          <LogViewer key={group} shell={shell} group={group} streams={streams} onClearStreams={streams.length ? () => setNarrow(null) : undefined} reloadToken={reloadToken} />
        ) : (
          <StreamList
            key={group}
            shell={shell}
            group={group}
            listKey={`${scope}|${group}|${reloadToken}`}
            onShow={(names) => {
              setNarrow({ group, streams: names });
              setTab("events");
            }}
          />
        )}
      </div>
    );
    status = `${group}${streams.length === 1 ? ` › ${streams[0]}` : streams.length ? ` › ${streams.length} streams` : ""} · ${region}`;
  }

  const commands = active ? <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} /> : null;

  return { tree, content, commands, status, busy: active && !group && groups.loading && !groups.error, refresh, dialogs: null };
}

function StreamList({ shell, group, listKey, onShow }: { shell: Shell; group: string; listKey: string; onShow: (streams: string[]) => void }) {
  const [prefixText, setPrefixText] = useState("");
  const [prefix, setPrefix] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const key = `${listKey}|${prefix}`;
  const fetchStreams = useCallback(
    (token: string | null, size: number) => logsApi.listStreams(group, prefix, token, size).then((r) => ({ items: r.streams, nextToken: r.nextToken })),
    // key covers group / prefix / reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const page = useTokenPages<LogStream>(key, "logs.streams.pageSize", true, fetchStreams);
  const rows: Row[] = useMemo(
    () =>
      (page.items ?? []).map((s) => ({
        key: s.name,
        icon: <LogStreamIcon />,
        isContainer: false,
        cells: {
          name: { text: s.name, sort: s.name },
          last: { text: formatDate(s.lastEvent), sort: s.lastEvent ?? "" },
          first: { text: formatDate(s.firstEvent), sort: s.firstEvent ?? "" },
          created: { text: formatDate(s.created), sort: s.created ?? "" },
        },
      })),
    [page.items],
  );
  const chosen = [...selected].slice(0, 100);

  function menu(k: string | null, x: number, y: number) {
    if (!k) return;
    const sel = selected.has(k) ? [...selected] : [k];
    shell.openMenu(x, y, [
      { label: sel.length === 1 ? "Show events" : `Show events of ${Math.min(sel.length, 100)} streams`, bold: true, shortcut: "Enter", onClick: () => onShow(sel.slice(0, 100)) },
      "separator",
      { label: "Copy name", onClick: () => void shell.copyText(k) },
    ]);
  }

  return (
    <div className="log-viewer">
      <div className="row log-bar">
        <input
          className="text-input mono log-pattern"
          placeholder="Stream name prefix (Enter to apply)"
          value={prefixText}
          spellCheck={false}
          onChange={(e) => setPrefixText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setPrefix(prefixText.trim())}
        />
        <button className="btn" onClick={() => setPrefix(prefixText.trim())}>
          Filter
        </button>
        {prefix && (
          <button
            className="btn"
            onClick={() => {
              setPrefix("");
              setPrefixText("");
            }}
          >
            Clear
          </button>
        )}
        <button className="btn" disabled={!chosen.length} onClick={() => onShow(chosen)}>
          Show events{chosen.length > 1 ? ` (${chosen.length})` : ""}
        </button>
        <span className="hint">{prefix ? "Sorted by name." : "Most recent activity first."}</span>
      </div>
      {page.error ? (
        <ErrorPanel error={page.error} profile={shell.profile} onRetry={() => setSelected(new Set())} />
      ) : (
        <>
          <FileList
            columns={STREAM_COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={(k) => onShow([k])}
            onContextMenu={menu}
            emptyText={!page.items ? "Loading…" : prefix ? `No streams begin with "${prefix}".` : "No streams in this log group."}
            initialSort={prefix ? undefined : { col: "last", dir: -1 }}
          />
          {(page.bar.page > 0 || page.bar.hasNext) && <PageBar {...page.bar} />}
        </>
      )}
    </div>
  );
}
