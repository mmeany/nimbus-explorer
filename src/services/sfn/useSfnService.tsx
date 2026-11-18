// Step Functions controller: state machine list (names in full, details for
// the visible page, name-prefix filter with history), the machine view and
// the execution view.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type AppError } from "../../api/s3";
import { sfnApi, type ExecutionDetails, type ExecutionSummary, type MachineDetails, type MachineRef } from "../../api/sfn";
import { CommandButton } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { FilterBox } from "../../components/FilterBox";
import { RefreshIcon, StateMachineIcon, StepFunctionsIcon } from "../../components/Icons";
import { PageBar } from "../../components/PageBar";
import { TreeNote, TreeRow } from "../../components/TreeRow";
import { formatDate } from "../../format";
import { SFN_ROOT, type Place } from "../../shell/places";
import type { ServiceUi, Shell } from "../../shell/shell";
import { TREE_LIMIT, usePagedDetails, usePaging } from "../../state/paged";
import { ExecutionView } from "./ExecutionView";
import { MachineView } from "./MachineView";

const COLUMNS: Column[] = [
  { id: "name", label: "State machine", width: 280 },
  { id: "kind", label: "Type", width: 80 },
  { id: "status", label: "Status", width: 80 },
  { id: "logging", label: "Logging", width: 80 },
  { id: "tracing", label: "Tracing", width: 70 },
  { id: "created", label: "Created", width: 165 },
  { id: "description", label: "Description", width: 320 },
];

const machinePlace = (machine: string | null, execution: string | null = null): Place => ({ ...SFN_ROOT, machine, execution });

export function useSfnService(shell: Shell): ServiceUi {
  const { connection, connectionId, profile, place } = shell;
  const active = place.service === "sfn";
  const machine = place.service === "sfn" ? place.machine : null;
  const execution = place.service === "sfn" ? place.execution : null;
  const region = connection?.serviceRegion ?? "";
  const scope = `${connectionId}|${region}`;
  const historyKey = `sfn|${profile ?? ""}|${region}`;
  const go = useCallback((m: string | null, e: string | null = null) => shell.navigate(machinePlace(m, e)), [shell]);

  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<{ key: string; machines: MachineRef[] | null; error: AppError | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewMachine, setViewMachine] = useState<MachineDetails | null>(null);
  const [viewExecution, setViewExecution] = useState<ExecutionDetails | null>(null);

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

  // Every machine's name, type and ARN (cheap); details per page below.
  const listKey = `${scope}|${reloadToken}`;
  useEffect(() => {
    if (!connection || !(open || active) || listing?.key === listKey) return;
    let stale = false;
    setLoading(true);
    sfnApi
      .list()
      .then((machines) => !stale && setListing({ key: listKey, machines, error: null }))
      .catch((e) => !stale && setListing({ key: listKey, machines: null, error: e as AppError }))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, open, active, listKey]);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);
  const all = listing?.key === listKey ? listing.machines : (listing?.machines ?? null);
  const machines = useMemo(() => (all && filter ? all.filter((m) => m.name.startsWith(filter)) : all), [all, filter]);
  const byName = useMemo(() => new Map((all ?? []).map((m) => [m.name, m])), [all]);
  const listView = active && !machine && place.service === "sfn" && !place.view;
  const paging = usePaging(`${scope}|${filter}`, machines?.length ?? 0, "sfn.pageSize", listView);
  const pageRefs = useMemo(() => paging.slice(machines ?? []), [paging, machines]);
  const pageArns = useMemo(() => pageRefs.map((m) => m.arn), [pageRefs]);
  const paged = usePagedDetails<MachineDetails>(`${listKey}|${filter}`, pageArns, sfnApi.detailsMany, (d) => d.arn, listView && !!all);

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
      pageRefs.map((m): Row => {
        const d = paged.details.get(m.arn);
        const wait = { text: d?.error ? "?" : "…", sort: "" };
        const kind = { text: m.kind === "EXPRESS" ? "Express" : "Standard", sort: m.kind };
        const name = { text: m.name, sort: m.name };
        const created = { text: formatDate(m.created), sort: m.created ?? "" };
        const icon = <StateMachineIcon express={m.kind === "EXPRESS"} />;
        if (!d || d.error) return { key: m.name, icon, isContainer: false, cells: { name, kind, created, status: wait, logging: wait, tracing: wait, description: { text: d?.error ?? "", sort: "" } } };
        return {
          key: m.name,
          icon,
          isContainer: false,
          dimmed: d.status === "DELETING",
          cells: {
            name,
            kind,
            created,
            status: { text: (d.status ?? "").toLowerCase(), sort: d.status ?? "" },
            logging: { text: (d.logging?.level ?? "OFF").toLowerCase(), sort: d.logging?.level ?? "OFF" },
            tracing: { text: d.tracing ? "on" : "off", sort: d.tracing ? 1 : 0 },
            description: { text: d.description ?? "", sort: d.description ?? "" },
          },
        };
      }),
    [pageRefs, paged.details],
  );

  function openLogs(group: string) {
    shell.navigate({ service: "logs", group });
  }

  function menu(key: string | null, x: number, y: number) {
    const items: MenuItem[] = [];
    const m = key ? byName.get(key) : undefined;
    if (m) {
      const logGroup = paged.details.get(m.arn)?.logging?.logGroup;
      items.push({ label: "Open", bold: true, shortcut: "Enter", onClick: () => go(m.name) });
      if (logGroup) items.push({ label: "Open log group", onClick: () => openLogs(logGroup) });
      items.push(
        "separator",
        { label: "Copy name", onClick: () => void shell.copyText(m.name) },
        { label: "Copy ARN", onClick: () => void shell.copyText(m.arn) },
        { label: "Add bookmark…", onClick: () => shell.addBookmark(machinePlace(m.name), null, null) },
        "separator",
      );
    }
    items.push({ label: "Refresh", shortcut: "F5", onClick: refresh });
    shell.openMenu(x, y, items);
  }

  function executionMenu(e: ExecutionSummary, x: number, y: number) {
    if (!machine) return;
    shell.openMenu(x, y, [
      { label: "Open", bold: true, shortcut: "Enter", onClick: () => go(machine, e.name) },
      "separator",
      { label: "Copy name", onClick: () => void shell.copyText(e.name) },
      { label: "Copy ARN", onClick: () => void shell.copyText(e.arn) },
      { label: "Add bookmark…", onClick: () => shell.addBookmark(machinePlace(machine, e.name), null, null) },
    ]);
  }

  const tree = connection ? (
    <TreeRow
      depth={1}
      label={filter ? "Step Functions (filtered)" : "Step Functions"}
      icon={<StepFunctionsIcon />}
      selected={listView}
      expanded={open}
      title={`Step Functions · ${region}`}
      onClick={() => go(null)}
      onToggle={() => setOpen((v) => !v)}
    >
      {listing?.error ? (
        <TreeNote depth={2}>Couldn't list state machines</TreeNote>
      ) : !machines ? (
        <TreeNote depth={2}>Loading…</TreeNote>
      ) : machines.length === 0 ? (
        <TreeNote depth={2}>{filter ? "No matching state machines" : "No state machines"}</TreeNote>
      ) : (
        <>
          {machines.slice(0, TREE_LIMIT).map((m) => (
            <TreeRow
              key={m.name}
              depth={2}
              label={m.name}
              icon={<StateMachineIcon express={m.kind === "EXPRESS"} />}
              selected={active && machine === m.name && !execution}
              onClick={() => go(m.name)}
              onContextMenu={(x, y) => menu(m.name, x, y)}
            />
          ))}
          {machines.length > TREE_LIMIT && <TreeNote depth={2}>{`${(machines.length - TREE_LIMIT).toLocaleString()} more in the list`}</TreeNote>}
        </>
      )}
    </TreeRow>
  ) : null;

  // The ARN of the machine on screen, from the list (it's null until the list has loaded).
  const machineRef = machine ? byName.get(machine) : undefined;
  const missing = !!machine && !!all && !machineRef;

  let content: ReactNode = null;
  let status = "";
  if (listView) {
    content = (
      <div className="service-pane">
        <FilterBox
          label="Filter:"
          applied={filter}
          history={history}
          placeholder="State machine name prefix (Enter to apply)"
          onApply={(v) => void applyFilter(v)}
          onClear={() => setFilter("")}
          onForget={(v) => void forget(v)}
          onClearHistory={() => void forget(null)}
        />
        {listing?.error ? (
          <ErrorPanel error={listing.error} profile={profile} onRetry={refresh} />
        ) : (
          <>
            {paged.error && <div className="warn-note list-note">Couldn't load details: {paged.error.message}</div>}
            <FileList
              storageKey="sfn.machines"
              columns={COLUMNS}
              rows={rows}
              selected={selected}
              onSelectionChange={setSelected}
              onOpen={(k) => go(k)}
              onContextMenu={menu}
              emptyText={!machines ? "Loading…" : filter ? `No state machines begin with "${filter}".` : "No state machines in this region."}
            />
            {machines && machines.length > paging.pageSize && <PageBar {...paging.bar} loading={paged.loading} />}
          </>
        )}
      </div>
    );
    if (machines) status = `${machines.length.toLocaleString()} state machine${machines.length === 1 ? "" : "s"}${filter ? ` beginning with "${filter}"` : ""} · ${region}`;
  } else if (active && machine && missing) {
    content = (
      <div className="service-pane scroll-pane">
        <div className="empty-note">
          There's no state machine called <span className="mono">{machine}</span> in {region}.
        </div>
      </div>
    );
  } else if (active && machine && execution) {
    content = (
      <div className="service-pane scroll-pane">
        <ExecutionView key={`${machine}|${execution}`} shell={shell} machineArn={machineRef?.arn ?? null} name={execution} reloadToken={reloadToken} onLoaded={setViewExecution} />
      </div>
    );
    status = `${machine} › ${execution}${viewExecution?.name === execution ? ` · ${viewExecution.status.toLowerCase().replace(/_/g, " ")}` : ""} · ${region}`;
  } else if (active && machine) {
    content = (
      <div className="service-pane scroll-pane">
        <MachineView
          key={machine}
          shell={shell}
          arn={machineRef?.arn ?? null}
          reloadToken={reloadToken}
          onLoaded={setViewMachine}
          onOpenExecution={(e) => go(machine, e)}
          executionMenu={executionMenu}
        />
      </div>
    );
    status = `${machine}${viewMachine?.name === machine ? ` · ${viewMachine.kind === "EXPRESS" ? "Express" : "Standard"}` : ""} · ${region}`;
  }

  const commands = active ? <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} /> : null;

  return { tree, content, commands, status, busy: active && loading, refresh, dialogs: null };
}
