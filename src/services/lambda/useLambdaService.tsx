// Lambda controller: function list (all loaded, paged on screen, name-prefix
// filter with history) and the function view.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type AppError } from "../../api/s3";
import { lambdaApi, runtimeLabel, type FunctionDetails, type FunctionSummary } from "../../api/lambda";
import { CommandButton, CommandSeparator } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { FilterBox } from "../../components/FilterBox";
import { DeleteIcon, EditIcon, FunctionIcon, LambdaIcon, RefreshIcon } from "../../components/Icons";
import { PageBar } from "../../components/PageBar";
import { TreeNote, TreeRow } from "../../components/TreeRow";
import { formatDate, formatSize } from "../../format";
import type { ServiceUi, Shell } from "../../shell/shell";
import { TREE_LIMIT, usePaging } from "../../state/paged";
import { FunctionView, type FunctionTab } from "./FunctionView";
import { InvokeTab } from "./InvokeTab";
import { FunctionSettingsDialog } from "./LambdaDialogs";
import { LogViewer } from "../logs/LogViewer";

const COLUMNS: Column[] = [
  { id: "name", label: "Function", width: 280 },
  { id: "runtime", label: "Runtime", width: 140 },
  { id: "memory", label: "Memory", width: 80, align: "right" },
  { id: "timeout", label: "Timeout", width: 70, align: "right" },
  { id: "arch", label: "Architecture", width: 95 },
  { id: "size", label: "Code size", width: 85, align: "right" },
  { id: "modified", label: "Last modified", width: 165 },
  { id: "description", label: "Description", width: 300 },
];

export function useLambdaService(shell: Shell): ServiceUi {
  const { connection, connectionId, profile, place } = shell;
  const active = place.service === "lambda";
  const fnName = place.service === "lambda" ? place.fn : null;
  const region = connection?.serviceRegion ?? "";
  const scope = `${connectionId}|${region}`;
  const historyKey = `lambda|${profile ?? ""}|${region}`;
  const go = useCallback((fn: string | null) => shell.navigate({ service: "lambda", fn }), [shell]);

  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<{ key: string; fns: FunctionSummary[] | null; error: AppError | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewFn, setViewFn] = useState<FunctionDetails | null>(null);
  const [settingsOf, setSettingsOf] = useState<FunctionDetails | null>(null);

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

  // Every function (ListFunctions returns each one's configuration, 50 per call).
  const listKey = `${scope}|${reloadToken}`;
  useEffect(() => {
    if (!connection || !(open || active) || listing?.key === listKey) return;
    let stale = false;
    setLoading(true);
    lambdaApi
      .list()
      .then((fns) => !stale && setListing({ key: listKey, fns, error: null }))
      .catch((e) => !stale && setListing({ key: listKey, fns: null, error: e as AppError }))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, open, active, listKey]);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);
  const all = listing?.key === listKey ? listing.fns : (listing?.fns ?? null);
  const fns = useMemo(() => (all && filter ? all.filter((f) => f.name.startsWith(filter)) : all), [all, filter]);
  const byName = useMemo(() => new Map((all ?? []).map((f) => [f.name, f])), [all]);
  const paging = usePaging(`${scope}|${filter}`, fns?.length ?? 0, "lambda.pageSize", active && !fnName);
  const pageFns = useMemo(() => paging.slice(fns ?? []), [paging, fns]);

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
      pageFns.map((f) => ({
        key: f.name,
        icon: <FunctionIcon image={f.packageType === "Image"} />,
        isContainer: false,
        dimmed: f.state === "Inactive",
        cells: {
          name: { text: f.name, sort: f.name },
          runtime: { text: runtimeLabel(f.runtime, f.packageType), sort: f.runtime ?? f.packageType ?? "" },
          memory: { text: f.memoryMb !== null ? `${f.memoryMb.toLocaleString()} MB` : "", sort: f.memoryMb ?? -1 },
          timeout: { text: f.timeoutSecs !== null ? `${f.timeoutSecs} s` : "", sort: f.timeoutSecs ?? -1 },
          arch: { text: f.architecture ?? "", sort: f.architecture ?? "" },
          size: { text: f.codeSize ? formatSize(f.codeSize) : "", sort: f.codeSize },
          modified: { text: formatDate(f.lastModified), sort: f.lastModified ?? "" },
          description: { text: f.description ?? "", sort: f.description ?? "" },
        },
      })),
    [pageFns],
  );

  const denied = () => shell.showFlash("Read-only mode: changes are disabled.");
  /** The open function, or the single selected row. */
  const target = fnName ?? (selected.size === 1 ? [...selected][0] : null);

  async function editSettings(name: string) {
    if (shell.readOnly) return denied();
    try {
      // Fresh details (and revision), so the edit starts from what's there now.
      setSettingsOf(await lambdaApi.get(name));
    } catch (e) {
      shell.showError(e);
    }
  }

  async function deleteFn(name: string) {
    if (shell.readOnly) return denied();
    const ok = await shell.confirmTyped(
      "Delete function",
      <>
        <p>
          <span className="mono">{name}</span>, with all its versions and aliases, will be deleted. This can't be undone.
        </p>
        <p className="hint">Its log group stays (delete it in CloudWatch Logs if you don't need it). Triggers that point at it stop working.</p>
      </>,
      name,
      "Delete function",
    );
    if (!ok) return;
    shell.setWorking(`Deleting ${name}…`);
    try {
      await lambdaApi.deleteFunction(name);
      shell.showFlash(`Deleted ${name}.`);
      if (fnName === name) go(null);
      setSelected(new Set());
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
      refresh();
    }
  }

  const keyOps = useRef({ active, modal: false, target, editSettings, deleteFn });
  keyOps.current = { active, modal: !!settingsOf, target, editSettings, deleteFn };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const o = keyOps.current;
      if (!o.active || o.modal || !o.target) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, .modal-backdrop")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === "Delete" && !ctrl) {
        e.preventDefault();
        void o.deleteFn(o.target);
      } else if (ctrl && !e.shiftKey && e.key === "e") {
        e.preventDefault();
        void o.editSettings(o.target);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function openLogs(group: string) {
    shell.navigate({ service: "logs", group });
  }

  function menu(key: string | null, x: number, y: number) {
    const items: MenuItem[] = [];
    const f = key ? byName.get(key) : undefined;
    if (f) {
      items.push(
        { label: "Open", bold: true, shortcut: "Enter", onClick: () => go(f.name) },
        { label: "Open log group", onClick: () => openLogs(`/aws/lambda/${f.name}`) },
        "separator",
        { label: "Settings…", shortcut: "Ctrl+E", disabled: shell.readOnly, onClick: () => void editSettings(f.name) },
        { label: "Delete…", shortcut: "Del", disabled: shell.readOnly, onClick: () => void deleteFn(f.name) },
        "separator",
        { label: "Copy name", onClick: () => void shell.copyText(f.name) },
        { label: "Copy ARN", onClick: () => void shell.copyText(f.arn) },
        "separator",
      );
    }
    items.push({ label: "Refresh", shortcut: "F5", onClick: refresh });
    shell.openMenu(x, y, items);
  }

  const tree = connection ? (
    <TreeRow
      depth={1}
      label={filter ? "Lambda (filtered)" : "Lambda"}
      icon={<LambdaIcon />}
      selected={active && !fnName}
      expanded={open}
      title={`Lambda · ${region}`}
      onClick={() => go(null)}
      onToggle={() => setOpen((v) => !v)}
    >
      {listing?.error ? (
        <TreeNote depth={2}>Couldn't list functions</TreeNote>
      ) : !fns ? (
        <TreeNote depth={2}>Loading…</TreeNote>
      ) : fns.length === 0 ? (
        <TreeNote depth={2}>{filter ? "No matching functions" : "No functions"}</TreeNote>
      ) : (
        <>
          {fns.slice(0, TREE_LIMIT).map((f) => (
            <TreeRow
              key={f.name}
              depth={2}
              label={f.name}
              icon={<FunctionIcon image={f.packageType === "Image"} />}
              selected={active && fnName === f.name}
              onClick={() => go(f.name)}
              onContextMenu={(x, y) => menu(f.name, x, y)}
            />
          ))}
          {fns.length > TREE_LIMIT && <TreeNote depth={2}>{`${(fns.length - TREE_LIMIT).toLocaleString()} more in the list`}</TreeNote>}
        </>
      )}
    </TreeRow>
  ) : null;

  const tabs: FunctionTab[] = [
    {
      id: "invoke",
      label: "Invoke",
      render: (f, goTab) => <InvokeTab key={f.name} f={f} shell={shell} eventsKey={`${profile ?? ""}|${region}|${f.name}`} onShowLogs={() => goTab("logs")} />,
    },
    {
      id: "logs",
      label: "Logs",
      render: (f) => (
        <div className="lambda-logs">
          <LogViewer key={f.logGroup} shell={shell} group={f.logGroup} defaultMinutes={60} reloadToken={reloadToken} />
        </div>
      ),
    },
  ];

  let content: ReactNode = null;
  let status = "";
  if (active && !fnName) {
    content = (
      <div className="service-pane">
        <FilterBox
          label="Filter:"
          applied={filter}
          history={history}
          placeholder="Function name prefix (Enter to apply)"
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
              columns={COLUMNS}
              rows={rows}
              selected={selected}
              onSelectionChange={setSelected}
              onOpen={(k) => go(k)}
              onContextMenu={menu}
              emptyText={!fns ? "Loading…" : filter ? `No functions begin with "${filter}".` : "No functions in this region."}
            />
            {fns && fns.length > paging.pageSize && <PageBar {...paging.bar} loading={false} />}
          </>
        )}
      </div>
    );
    if (fns) status = `${fns.length.toLocaleString()} function${fns.length === 1 ? "" : "s"}${filter ? ` beginning with "${filter}"` : ""} · ${region}`;
  } else if (active && fnName) {
    content = (
      <div className="service-pane scroll-pane">
        <FunctionView key={fnName} name={fnName} shell={shell} reloadToken={reloadToken} onLoaded={setViewFn} onOpenLogs={openLogs} tabs={tabs} />
      </div>
    );
    status = `${fnName}${viewFn?.name === fnName && viewFn.state && viewFn.state !== "Active" ? ` · ${viewFn.state}` : ""} · ${region}`;
  }

  const ro = shell.readOnly;
  const commands = active ? (
    <>
      <CommandButton icon={<EditIcon />} label="Settings" title="Memory, timeout, environment variables, concurrency (Ctrl+E)" disabled={ro || !target} onClick={() => target && void editSettings(target)} />
      <CommandButton icon={<DeleteIcon />} label="Delete" title="Delete the function (Del)" disabled={ro || !target} onClick={() => target && void deleteFn(target)} />
      <CommandSeparator />
      <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} />
    </>
  ) : null;

  const dialogs = settingsOf ? (
    <FunctionSettingsDialog
      key={settingsOf.name}
      f={settingsOf}
      onClose={() => setSettingsOf(null)}
      onDone={(msg) => {
        setSettingsOf(null);
        shell.showFlash(msg);
        refresh();
      }}
    />
  ) : null;

  return { tree, content, commands, status, busy: active && loading, refresh, dialogs };
}
