// DynamoDB controller: table list (with a remembered name filter) and the
// table view (tabs).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ddbApi, itemKey, keyLabel, keyString, type TableInfo } from "../../api/dynamo";
import { api, type AppError } from "../../api/s3";
import { CommandButton, CommandSeparator } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { PageBar } from "../../components/PageBar";
import { TREE_LIMIT, usePagedDetails, usePaging } from "../../state/paged";
import { FilterBox } from "../../components/FilterBox";
import { DeleteIcon, DynamoIcon, NewItemIcon, RefreshIcon, TableIcon } from "../../components/Icons";
import { TreeNote, TreeRow } from "../../components/TreeRow";
import { formatDate, formatSize } from "../../format";
import type { ServiceUi, Shell } from "../../shell/shell";
import { cellText, type DdbItem } from "../../util/ddbJson";
import { ItemEditorDialog, type EditorMode } from "./ItemEditorDialog";
import { ItemsTab, type ItemsContext } from "./ItemsTab";
import { PartiqlTab } from "./PartiqlTab";
import { ExportDialog, ImportDialog } from "./TransferDialogs";
import { BackupsTab } from "./BackupsTab";
import { AddIndexDialog, CreateTableDialog, TableSettingsDialog } from "./TableDialogs";
import { TableDetails } from "./TableDetails";

const COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 240 },
  { id: "status", label: "Status", width: 85 },
  { id: "pk", label: "Partition key", width: 150 },
  { id: "sk", label: "Sort key", width: 140 },
  { id: "indexes", label: "Indexes", width: 70, align: "right" },
  { id: "items", label: "Items", width: 90, align: "right" },
  { id: "size", label: "Size", width: 85, align: "right" },
  { id: "billing", label: "Capacity", width: 110 },
  { id: "created", label: "Created", width: 165 },
];

export type TableTab = "items" | "partiql" | "details" | "backups";

export function useDynamoService(shell: Shell): ServiceUi {
  const { connection, connectionId, profile, place, readOnly } = shell;
  const active = place.service === "dynamodb";
  const tableName = place.service === "dynamodb" ? place.table : null;
  const region = connection?.serviceRegion ?? "";
  const scope = `${connectionId}|${region}`;
  const historyKey = `dynamodb|${profile ?? ""}|${region}`;
  const go = useCallback((table: string | null) => shell.navigate({ service: "dynamodb", table }), [shell]);

  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<{ key: string; names: string[] | null; error: AppError | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<TableTab>("items");
  /** Full description of the open table (with TTL / PITR). */
  const [view, setView] = useState<{ name: string; table: TableInfo | null; error: AppError | null } | null>(null);

  useEffect(() => {
    setListing(null);
    setFilter("");
    setSelected(new Set());
    setView(null);
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

  // Table list: ListTables has no server-side filter, so the filter is applied here.
  const listKey = `${scope}|${reloadToken}`;
  useEffect(() => {
    if (!connection || !(open || active) || listing?.key === listKey) return;
    let stale = false;
    setLoading(true);
    ddbApi
      .listTableNames()
      .then((names) => !stale && setListing({ key: listKey, names, error: null }))
      .catch((e) => !stale && setListing({ key: listKey, names: null, error: e as AppError }))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
      // A load cut short (deps changed after it finished) mustn't leave the busy flag on.
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, open, active, listKey]);

  // The open table's full description.
  useEffect(() => {
    if (!active || !tableName || !connection) return;
    let live = true;
    setView((v) => (v?.name === tableName ? v : { name: tableName, table: null, error: null }));
    ddbApi
      .describeTable(tableName)
      .then((table) => live && setView({ name: tableName, table, error: null }))
      .catch((e) => live && setView({ name: tableName, table: null, error: e as AppError }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tableName, scope, reloadToken]);

  // Every table name loads (100 per call); descriptions only for the visible page.
  const all = listing?.names ?? null;
  const tables = useMemo(() => (all && filter ? all.filter((n) => n.startsWith(filter)) : all), [all, filter]);
  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);
  const listView = active && !tableName;
  const paging = usePaging(`${scope}|${filter}`, tables?.length ?? 0, "ddb.pageSize", listView);
  const pageNames = useMemo(() => paging.slice(tables ?? []), [paging, tables]);
  const paged = usePagedDetails<TableInfo>(listKey, pageNames, ddbApi.detailsMany, (t) => t.name, listView && !!all);

  // ---------------------------------------------------------------------------
  // Items: create / edit / duplicate / delete

  const [editor, setEditor] = useState<{ mode: EditorMode; item: DdbItem | null; table: TableInfo } | null>(null);
  const ctxRef = useRef<ItemsContext | null>(null);
  const [tableDialog, setTableDialog] = useState<{ kind: "create" } | { kind: "settings" | "index"; table: TableInfo } | null>(null);

  async function deleteTable(name: string) {
    if (readOnly) return denied();
    let t = (view?.name === name ? view.table : null) ?? paged.details.get(name) ?? null;
    if (!t) {
      try {
        t = await ddbApi.describeTable(name);
      } catch (e) {
        return shell.showError(e);
      }
    }
    if (t?.deletionProtection) return shell.showFlash("Deletion protection is on: turn it off in the table's settings first.");
    const ok = await shell.confirmTyped(
      "Delete table",
      <>
        <p>
          <span className="mono">{name}</span>, its {t?.itemCount !== null && t?.itemCount !== undefined ? `~${t.itemCount.toLocaleString()} items` : "items"} and indexes will be deleted. This can't be undone.
        </p>
        <p className="hint">On-demand backups are kept; consider creating one first (Backups tab).</p>
      </>,
      name,
      "Delete table",
    );
    if (!ok) return;
    shell.setWorking(`Deleting ${name}…`);
    try {
      await ddbApi.deleteTable(name);
      shell.showFlash(`Deleting ${name}; it disappears once DynamoDB finishes.`);
      if (tableName === name) go(null);
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
      refresh();
    }
  }

  async function deleteIndex(t: TableInfo, index: string) {
    if (readOnly) return denied();
    const ok = await shell.ask(
      "Delete index",
      <>
        Delete the global secondary index <span className="mono">{index}</span> from <span className="mono">{t.name}</span>? Queries using it will fail.
      </>,
      [
        { label: "Delete", value: "delete", danger: true },
        { label: "Cancel", value: "cancel" },
      ],
      "cancel",
    );
    if (ok !== "delete") return;
    try {
      await ddbApi.deleteGsi(t.name, index);
      shell.showFlash(`Deleting index ${index}.`);
      refresh();
    } catch (e) {
      shell.showError(e);
    }
  }

  const [io, setIo] = useState<{ kind: "export" | "import"; table: TableInfo; results: DdbItem[] } | null>(null);
  const denied = () => shell.showFlash("Read-only mode: changes are disabled.");

  async function openEditor(t: TableInfo, mode: EditorMode, item: DdbItem | null) {
    if (readOnly && mode !== "edit") return denied();
    if (!item) return setEditor({ mode, item: null, table: t });
    try {
      // Edit the item as it is now, not as it was when the page loaded.
      const fresh = await ddbApi.getItem(t.name, itemKey(t, item));
      if (!fresh) {
        shell.showFlash("That item no longer exists.");
        ctxRef.current?.setItems((xs) => xs.filter((x) => keyString(t, x) !== keyString(t, item)));
        return;
      }
      setEditor({ mode, item: fresh, table: t });
    } catch (e) {
      shell.showError(e);
    }
  }

  async function deleteItems(t: TableInfo, list: DdbItem[]) {
    if (readOnly) return denied();
    if (!list.length) return;
    const label = (it: DdbItem) => [t.partitionKey?.name, t.sortKey?.name].filter(Boolean).map((k) => cellText(it[k!])).join(" / ");
    const ok = await shell.ask(
      list.length === 1 ? "Delete item" : `Delete ${list.length} items`,
      <>
        <ul className="name-list mono">
          {list.slice(0, 10).map((it, i) => (
            <li key={i}>{label(it)}</li>
          ))}
          {list.length > 10 && <li>…and {list.length - 10} more</li>}
        </ul>
        <p>This can't be undone.</p>
      </>,
      [
        { label: "Delete", value: "delete", danger: true },
        { label: "Cancel", value: "cancel" },
      ],
      "cancel",
    );
    if (ok !== "delete") return;
    shell.setWorking(`Deleting ${list.length} item${list.length === 1 ? "" : "s"}…`);
    try {
      const r = await ddbApi.deleteItems(
        t.name,
        list.map((it) => itemKey(t, it)),
      );
      const failed = new Set(r.failed.map(([i]) => keyString(t, list[i])));
      const gone = new Set(list.map((it) => keyString(t, it)).filter((k) => !failed.has(k)));
      ctxRef.current?.setItems((xs) => xs.filter((x) => !gone.has(keyString(t, x))));
      if (r.failed.length) {
        shell.showError({
          kind: "other",
          message: `Deleted ${r.done}; ${r.failed.length} failed.`,
          detail: r.failed.map(([i, m]) => `${label(list[i])}: ${m}`).join("\n"),
        });
      } else shell.showFlash(`Deleted ${r.done} item${r.done === 1 ? "" : "s"}.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
    }
  }

  function itemMenu(t: TableInfo, index: number | null, x: number, y: number, ctx: ItemsContext) {
    ctxRef.current = ctx;
    const sel = ctx.selected.map((i) => ctx.items[i]);
    const it = index !== null ? ctx.items[index] : null;
    const items: MenuItem[] = [];
    if (it) {
      items.push(
        { label: readOnly ? "View / edit…" : "Edit…", bold: true, shortcut: "Enter", onClick: () => void openEditor(t, "edit", it) },
        { label: "Duplicate…", disabled: readOnly, onClick: () => void openEditor(t, "duplicate", it) },
        "separator",
        { label: "Copy as JSON", onClick: () => void shell.copyText(JSON.stringify(it, null, 2)) },
        "separator",
        { label: sel.length > 1 ? `Delete ${sel.length} items…` : "Delete…", shortcut: "Del", disabled: readOnly, onClick: () => void deleteItems(t, sel.length ? sel : [it]) },
        "separator",
      );
    }
    items.push({ label: "New item…", disabled: readOnly, onClick: () => void openEditor(t, "create", null) });
    shell.openMenu(x, y, items);
  }

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
      pageNames.map((name): Row => {
        const t = paged.details.get(name);
        if (!t) {
          const wait = { text: "…", sort: "" };
          return { key: name, icon: <TableIcon />, isContainer: false, cells: { name: { text: name, sort: name }, status: wait, pk: wait, sk: wait, indexes: wait, items: wait, size: wait, billing: wait, created: wait } };
        }
        return {
        key: t.name,
        icon: <TableIcon />,
        isContainer: false,
        cells: {
          name: { text: t.name, sort: t.name },
          status: { text: t.error ? "?" : (t.status ?? ""), sort: t.status ?? "" },
          pk: { text: keyLabel(t.partitionKey), sort: t.partitionKey?.name ?? "" },
          sk: { text: keyLabel(t.sortKey), sort: t.sortKey?.name ?? "" },
          indexes: { text: t.indexes.length ? String(t.indexes.length) : "", sort: t.indexes.length },
          items: { text: t.itemCount?.toLocaleString() ?? "", sort: t.itemCount ?? -1 },
          size: { text: t.sizeBytes !== null ? formatSize(t.sizeBytes) : "", sort: t.sizeBytes ?? -1 },
          billing: { text: t.billingMode === "PROVISIONED" ? "Provisioned" : t.billingMode ? "On-demand" : "", sort: t.billingMode ?? "" },
          created: { text: formatDate(t.created), sort: t.created ?? "" },
        },
        };
      }),
    [pageNames, paged.details],
  );

  function openContextMenu(key: string | null, x: number, y: number) {
    const items: MenuItem[] = [];
    const t = key && all?.includes(key) ? (paged.details.get(key) ?? { name: key, arn: null }) : undefined;
    if (t) {
      items.push(
        { label: "Open", bold: true, shortcut: "Enter", onClick: () => go(t.name) },
        {
          label: "Show details",
          onClick: () => {
            setTab("details");
            go(t.name);
          },
        },
        "separator",
        { label: "Copy name", onClick: () => void shell.copyText(t.name) },
        ...(t.arn ? [{ label: "Copy ARN", onClick: () => void shell.copyText(t.arn!) } as MenuItem] : []),
        "separator",
        { label: "Delete table…", shortcut: "Del", disabled: readOnly, onClick: () => void deleteTable(t.name) },
        "separator",
      );
    } else {
      items.push({ label: "New table…", disabled: readOnly, onClick: () => setTableDialog({ kind: "create" }) }, "separator");
    }
    items.push({ label: "Refresh", shortcut: "F5", onClick: refresh });
    shell.openMenu(x, y, items);
  }

  // ---------------------------------------------------------------------------
  // Tree

  const tree = connection ? (
    <TreeRow
      depth={1}
      label={filter ? "DynamoDB (filtered)" : "DynamoDB"}
      icon={<DynamoIcon />}
      selected={active && !tableName}
      expanded={open}
      title={`DynamoDB · ${region}`}
      onClick={() => go(null)}
      onToggle={() => setOpen((v) => !v)}
    >
      {listing?.error ? (
        <TreeNote depth={2}>Couldn't list tables</TreeNote>
      ) : !tables ? (
        <TreeNote depth={2}>Loading…</TreeNote>
      ) : tables.length === 0 ? (
        <TreeNote depth={2}>{filter ? "No matching tables" : "No tables"}</TreeNote>
      ) : (
        <>
          {tables.slice(0, TREE_LIMIT).map((name) => (
            <TreeRow
              key={name}
              depth={2}
              label={name}
              icon={<TableIcon />}
              selected={active && tableName === name}
              onClick={() => go(name)}
              onContextMenu={(x, y) => openContextMenu(name, x, y)}
            />
          ))}
          {tables.length > TREE_LIMIT && <TreeNote depth={2}>{`${(tables.length - TREE_LIMIT).toLocaleString()} more in the list`}</TreeNote>}
        </>
      )}
    </TreeRow>
  ) : null;

  // ---------------------------------------------------------------------------
  // Content

  let content: ReactNode = null;
  let status = "";
  if (active && !tableName) {
    content = (
      <div className="service-pane">
        <FilterBox
          label="Filter:"
          applied={filter}
          history={history}
          placeholder="Table name prefix (Enter to apply)"
          onApply={(v) => void applyFilter(v)}
          onClear={() => setFilter("")}
          onForget={(v) => void forget(v)}
          onClearHistory={() => void forget(null)}
        />
        {listing?.error ? (
          <ErrorPanel error={listing.error} profile={profile} onRetry={refresh} />
        ) : (
          <>
            {paged.error && <div className="warn-note list-note">Couldn't load table details: {paged.error.message}</div>}
            <FileList
              columns={COLUMNS}
              rows={rows}
              selected={selected}
              onSelectionChange={setSelected}
              onOpen={(k) => go(k)}
              onContextMenu={openContextMenu}
              emptyText={!tables ? "Loading…" : filter ? `No tables begin with "${filter}".` : "No tables in this region."}
            />
            {tables && tables.length > paging.pageSize && <PageBar {...paging.bar} loading={paged.loading} />}
          </>
        )}
      </div>
    );
    if (tables) {
      status = `${tables.length.toLocaleString()} table${tables.length === 1 ? "" : "s"}${filter ? ` beginning with "${filter}"` : ""} · ${region}`;
    }
  } else if (active && tableName) {
    const t = view?.name === tableName ? view.table : null;
    content = view?.error ? (
      <ErrorPanel error={view.error} profile={profile} onRetry={refresh} />
    ) : !t ? (
      <div className="empty-note">Loading…</div>
    ) : (
      <div className="service-pane">
        <div className="table-tabs">
          <span className="tt-name">{t.name}</span>
          <div className="segmented small">
            <button className={tab === "items" ? "active" : ""} onClick={() => setTab("items")}>
              Items
            </button>
            <button className={tab === "partiql" ? "active" : ""} onClick={() => setTab("partiql")}>
              PartiQL
            </button>
            <button className={tab === "details" ? "active" : ""} onClick={() => setTab("details")}>
              Details
            </button>
            <button className={tab === "backups" ? "active" : ""} onClick={() => setTab("backups")}>
              Backups
            </button>
          </div>
        </div>
        {/* Both stay mounted so results survive switching tabs. */}
        <div className="tt-body" style={{ display: tab === "items" ? "flex" : "none" }}>
          <ItemsTab
            key={t.name}
            table={t}
            shell={shell}
            onOpenItem={(it, ctx) => {
              ctxRef.current = ctx;
              void openEditor(t, "edit", it);
            }}
            onContextMenu={(i, x, y, ctx) => itemMenu(t, i, x, y, ctx)}
            onDeleteKey={(ctx) => {
              ctxRef.current = ctx;
              void deleteItems(t, ctx.selected.map((i) => ctx.items[i]));
            }}
            renderActions={(ctx) => {
              ctxRef.current = ctx;
              const sel = ctx.selected.map((i) => ctx.items[i]);
              return (
                <>
                  <button className="btn" disabled={readOnly} onClick={() => void openEditor(t, "create", null)}>
                    New item
                  </button>
                  <button className="btn" disabled={sel.length !== 1} onClick={() => void openEditor(t, "edit", sel[0])}>
                    {readOnly ? "View" : "Edit"}
                  </button>
                  <button className="btn" disabled={readOnly || sel.length !== 1} onClick={() => void openEditor(t, "duplicate", sel[0])}>
                    Duplicate
                  </button>
                  <button className="btn" disabled={readOnly || !sel.length} onClick={() => void deleteItems(t, sel)}>
                    Delete{sel.length > 1 ? ` (${sel.length})` : ""}
                  </button>
                  <button className="btn" onClick={() => setIo({ kind: "export", table: t, results: sel.length > 1 ? sel : ctx.items })} title="Export the results (or the selection) or the whole table">
                    Export…
                  </button>
                  <button className="btn" disabled={readOnly} onClick={() => setIo({ kind: "import", table: t, results: [] })}>
                    Import…
                  </button>
                </>
              );
            }}
          />
        </div>
        <div className="tt-body" style={{ display: tab === "partiql" ? "flex" : "none" }}>
          <PartiqlTab key={t.name} table={t} shell={shell} />
        </div>
        <div className="scroll-pane tt-body" style={{ display: tab === "details" ? "block" : "none" }}>
          <TableDetails
            table={t}
            shell={shell}
            onSettings={() => setTableDialog({ kind: "settings", table: t })}
            onAddIndex={() => setTableDialog({ kind: "index", table: t })}
            onDeleteIndex={(ix) => void deleteIndex(t, ix)}
          />
        </div>
        {tab === "backups" && (
          <div className="scroll-pane tt-body">
            <BackupsTab
              key={t.name}
              table={t}
              shell={shell}
              onRestored={() => {
                refresh();
              }}
            />
          </div>
        )}
      </div>
    );
    status = `${tableName} · ${region}`;
  }

  const targetTable = tableName ?? (selected.size === 1 ? [...selected][0] : null);
  const commands = active ? (
    <>
      <CommandButton icon={<NewItemIcon />} label="New table" title="Create a table" disabled={readOnly || !connection} onClick={() => setTableDialog({ kind: "create" })} />
      <CommandButton icon={<DeleteIcon />} label="Delete table" title="Delete the table (typed confirmation)" disabled={readOnly || !targetTable} onClick={() => targetTable && void deleteTable(targetTable)} />
      <CommandSeparator />
      <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} />
    </>
  ) : null;

  const tableDialogEl =
    tableDialog?.kind === "create" ? (
      <CreateTableDialog
        shell={shell}
        onClose={() => setTableDialog(null)}
        onCreated={(name) => {
          setTableDialog(null);
          shell.showFlash(`Creating ${name}; it's ready when its status is ACTIVE.`);
          refresh();
          go(name);
        }}
      />
    ) : tableDialog?.kind === "settings" ? (
      <TableSettingsDialog
        table={tableDialog.table}
        shell={shell}
        onClose={() => setTableDialog(null)}
        onSaved={() => {
          setTableDialog(null);
          shell.showFlash("Settings saved. Some changes take a few minutes to apply.");
          refresh();
        }}
      />
    ) : tableDialog?.kind === "index" ? (
      <AddIndexDialog
        table={tableDialog.table}
        shell={shell}
        onClose={() => setTableDialog(null)}
        onAdded={() => {
          setTableDialog(null);
          shell.showFlash("Index is being created.");
          refresh();
        }}
      />
    ) : null;

  const ioDialog =
    io?.kind === "export" ? (
      <ExportDialog table={io.table} results={io.results} shell={shell} onClose={() => setIo(null)} />
    ) : io?.kind === "import" ? (
      <ImportDialog table={io.table} shell={shell} onClose={() => setIo(null)} onImported={() => ctxRef.current?.rerun()} />
    ) : null;

  const editorDialog = editor ? (
    <ItemEditorDialog
      table={editor.table}
      mode={editor.mode}
      item={editor.item}
      shell={shell}
      onClose={() => setEditor(null)}
      onSaved={(item, replaced) => {
        const t = editor.table;
        const k = keyString(t, item);
        ctxRef.current?.setItems((xs) => {
          let out = replaced ? xs.filter((x) => keyString(t, x) !== keyString(t, replaced)) : xs;
          const at = out.findIndex((x) => keyString(t, x) === k);
          out = at >= 0 ? out.map((x, i) => (i === at ? item : x)) : [item, ...out];
          return out;
        });
        shell.showFlash(editor.mode === "edit" && !replaced ? "Item saved." : "Item created.");
        setEditor(null);
      }}
    />
  ) : null;

  const dialogs = (
    <>
      {editorDialog}
      {ioDialog}
      {tableDialogEl}
    </>
  );

  return { tree, content, commands, status, busy: active && (loading || paged.loading), refresh, dialogs };
}
