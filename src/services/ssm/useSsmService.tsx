// Parameter Store controller: "/"-separated names as folders, prefix filter
// with remembered history, parameter details.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type AppError } from "../../api/s3";
import { ssmApi, type ParamInfo, type ParamListing } from "../../api/ssm";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { PageBar } from "../../components/PageBar";
import { usePagedDetails, usePaging } from "../../state/paged";
import { FilterBox } from "../../components/FilterBox";
import { CommandButton, CommandSeparator } from "../../components/CommandButton";
import { DeleteIcon, DownloadIcon, EditIcon, FolderIcon, HistoryIcon, KeyIcon, NewItemIcon, ParamStoreIcon, RefreshIcon, SecretKeyIcon, UploadIcon } from "../../components/Icons";
import { TreeNote, TreeRow } from "../../components/TreeRow";
import { formatDate } from "../../format";
import type { ServiceUi, Shell } from "../../shell/shell";
import { ParamDetailsDialog } from "./ParamDetailsDialog";
import { ParamEditorDialog, paramNameProblem, type EditorTarget } from "./ParamEditorDialog";
import { ParamHistoryDialog } from "./ParamHistoryDialog";
import { ParamSettingsDialog } from "./ParamSettingsDialog";
import { ParamExportDialog, ParamImportDialog } from "./ParamTransferDialogs";

interface FolderNode {
  folders: string[] | null;
  failed: boolean;
}

const BROWSE_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 280 },
  { id: "type", label: "Type", width: 110 },
  { id: "value", label: "Value", width: 260 },
  { id: "version", label: "Version", width: 70, align: "right" },
  { id: "modified", label: "Last modified", width: 165 },
  { id: "tier", label: "Tier", width: 90 },
];

const FILTER_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 220 },
  { id: "path", label: "Path", width: 220 },
  ...BROWSE_COLUMNS.slice(1),
];

/** Last segment of a name or folder path ("/a/b/" → "b", "/a/key" → "key"). */
export function lastSegment(nameOrPath: string): string {
  const t = nameOrPath.endsWith("/") ? nameOrPath.slice(0, -1) : nameOrPath;
  return t.slice(t.lastIndexOf("/") + 1) || t;
}

/** Folder containing a parameter ("/a/b/key" → "/a/b/", "plain" → "/"). */
export function parentPath(name: string): string {
  const i = name.lastIndexOf("/");
  return i <= 0 ? "/" : name.slice(0, i + 1);
}

/** Every folder path on the way to `name` ("/a/b/k" → ["/", "/a/", "/a/b/"]). */
export function ancestorPaths(pathOrName: string): string[] {
  const out = ["/"];
  let acc = "/";
  const segs = pathOrName.split("/").filter(Boolean);
  const folderSegs = pathOrName.endsWith("/") ? segs : segs.slice(0, -1);
  for (const s of folderSegs) {
    acc += s + "/";
    out.push(acc);
  }
  return out;
}

export function useSsmService(shell: Shell): ServiceUi {
  const { connection, connectionId, profile, place, readOnly } = shell;
  const active = place.service === "ssm";
  const path = place.service === "ssm" ? place.path : "/";
  const region = connection?.serviceRegion ?? "";
  /** Everything resets when the connection or region changes. */
  const scope = `${connectionId}|${region}`;
  const historyKey = `ssm|${profile ?? ""}|${region}`;
  const go = useCallback((p: string) => shell.navigate({ service: "ssm", path: p }), [shell]);

  const [serviceOpen, setServiceOpen] = useState(false);
  const [nodes, setNodes] = useState<Map<string, FolderNode>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["/"]));
  const [listing, setListing] = useState<{ key: string; data: ParamListing | null; error: AppError | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<ParamInfo | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  /** Export / import dialogs, with the folder they start from. */
  const [io, setIo] = useState<{ kind: "export" | "import"; folder: string } | null>(null);
  /** In-app clipboard for Cut/Copy/Paste of parameters and folders. */
  const [clipboard, setClipboard] = useState<{ mode: "copy" | "cut"; items: string[] } | null>(null);
  const [settingsOf, setSettingsOf] = useState<{ param: ParamInfo; tab: "tags" | "tier" } | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // New connection or region: forget everything.
  useEffect(() => {
    setNodes(new Map());
    setExpanded(new Set(["/"]));
    setListing(null);
    setFilter("");
    setSelected(new Set());
  }, [scope]);

  // Remembered filters for this profile + region.
  useEffect(() => {
    if (!profile) return;
    api
      .getSettings()
      .then((s) => setHistory(s.filterHistory?.[historyKey] ?? []))
      .catch(() => setHistory([]));
  }, [historyKey, profile]);

  /** Loads a folder's sub-folders for the tree (no values). */
  const loadFolders = useCallback(
    async (p: string) => {
      const myScope = scope;
      setNodes((m) => new Map(m).set(p, { folders: m.get(p)?.folders ?? null, failed: false }));
      try {
        const res = await ssmApi.listPath(p, false);
        if (myScope === scope) setNodes((m) => new Map(m).set(p, { folders: res.folders, failed: false }));
      } catch {
        if (myScope === scope) setNodes((m) => new Map(m).set(p, { folders: [], failed: true }));
      }
    },
    [scope],
  );

  const toggle = (p: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  };

  // Load every expanded folder the tree doesn't know yet (after expanding,
  // navigating or invalidating).
  useEffect(() => {
    if (!serviceOpen || !connection) return;
    for (const p of expanded) if (!nodes.has(p)) void loadFolders(p);
  }, [serviceOpen, connection, expanded, nodes, loadFolders]);

  // Navigating expands the tree down to the folder (loading ancestors as needed).
  useEffect(() => {
    if (!active || !connection) return;
    setServiceOpen(true);
    const chain = ancestorPaths(path);
    setExpanded((s) => new Set([...s, ...chain]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, path, scope]);

  // The main listing: folder view, or the flat filtered view.
  const listKey = filter ? `prefix:${filter}` : `path:${path}`;
  useEffect(() => {
    if (!active || !connection) return;
    let stale = false;
    setLoading(true);
    setListing((l) => (l?.key === listKey ? l : null));
    (filter ? ssmApi.listPrefix(filter) : ssmApi.listPath(path, false))
      .then((data) => {
        if (stale) return;
        setListing({ key: listKey, data, error: null });
        if (!filter) setNodes((m) => new Map(m).set(path, { folders: data.folders, failed: false }));
      })
      .catch((e) => !stale && setListing({ key: listKey, data: null, error: e as AppError }))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
      // A load cut short (deps changed after it finished) mustn't leave the busy flag on.
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, listKey, scope, reloadToken]);

  useEffect(() => setSelected(new Set()), [listKey]);

  /** Reloads the list and every tree folder (writes can change any of them). */
  const refresh = useCallback(() => {
    setNodes(new Map());
    setReloadToken((t) => t + 1);
  }, []);

  // ---------------------------------------------------------------------------
  // Filter + history

  async function applyFilter(v: string) {
    setFilter(v);
    try {
      setHistory(await api.rememberFilter(historyKey, v));
    } catch {
      /* history is a convenience */
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
  // Rows

  const current = listing?.key === listKey ? listing : null;
  // Names and metadata load in full (folders need them); values only for the
  // visible page, and never for SecureString.
  const entries = useMemo(
    () => (current?.data ? [...current.data.folders.map((f) => ({ folder: f })), ...current.data.parameters.map((p) => ({ param: p }))] : []),
    [current],
  );
  const paging = usePaging(`${scope}|${listKey}`, entries.length, "ssm.pageSize", active);
  const pageEntries = useMemo(() => paging.slice(entries), [paging, entries]);
  const pageValueNames = useMemo(
    () => pageEntries.flatMap((e) => ("param" in e && e.param.paramType !== "SecureString" ? [e.param.name] : [])),
    [pageEntries],
  );
  const loadValues = useCallback(
    (names: string[]) => ssmApi.values(names).then((m) => names.map((name) => ({ name, value: m[name] ?? null }))),
    [],
  );
  const paged = usePagedDetails<{ name: string; value: string | null }>(`${scope}|${listKey}|${reloadToken}`, pageValueNames, loadValues, (v) => v.name, active && !!current?.data);
  const params = useMemo(
    () => (current?.data?.parameters ?? []).map((p) => (p.paramType === "SecureString" || !paged.details.has(p.name) ? p : { ...p, value: paged.details.get(p.name)!.value })),
    [current, paged.details],
  );
  const byName = useMemo(() => new Map(params.map((p) => [p.name, p])), [params]);

  const rows: Row[] = useMemo(() => {
    if (!current?.data) return [];
    const out: Row[] = [];
    for (const e of pageEntries) {
      if ("folder" in e) {
        const f = e.folder;
        out.push({ key: f, icon: <FolderIcon />, isContainer: true, cells: { name: { text: lastSegment(f), sort: lastSegment(f) } } });
        continue;
      }
      const p = byName.get(e.param.name) ?? e.param;
      const secure = p.paramType === "SecureString";
      const name = filter || path === "/" ? (filter ? lastSegment(p.name) : p.name) : lastSegment(p.name);
      const value = secure ? "••••••••" : (p.value ?? "…");
      out.push({
        key: p.name,
        icon: secure ? <SecretKeyIcon /> : <KeyIcon />,
        isContainer: false,
        cells: {
          name: { text: name, sort: name },
          path: { text: parentPath(p.name), sort: p.name },
          type: { text: p.paramType, sort: p.paramType },
          value: { text: value, sort: secure ? "" : (p.value ?? "") },
          version: { text: String(p.version), sort: p.version },
          modified: { text: formatDate(p.lastModified), sort: p.lastModified ?? "" },
          tier: { text: p.tier ?? "", sort: p.tier ?? "" },
        },
      });
    }
    return out;
  }, [current, pageEntries, byName, filter, path]);

  // ---------------------------------------------------------------------------
  // Create / edit / delete

  /** Folder new parameters start in: the current folder or the filter's folder part. */
  const newFolder = filter ? parentPath(filter.endsWith("/") ? filter + "x" : filter) : path;

  function newParam() {
    if (readOnly) return shell.showFlash("Read-only mode: changes are disabled.");
    setEditor({ mode: "create", folder: newFolder });
  }

  function editParam(name: string) {
    const p = byName.get(name);
    if (!p) return;
    if (readOnly) return shell.showFlash("Read-only mode: changes are disabled.");
    setEditor({ mode: "edit", param: p });
  }

  async function deleteItems(keys: string[]) {
    if (readOnly) return shell.showFlash("Read-only mode: changes are disabled.");
    const folders = keys.filter((k) => !byName.has(k));
    const names = new Set(keys.filter((k) => byName.has(k)));
    try {
      if (folders.length) {
        shell.setWorking("Counting parameters…");
        for (const f of folders) for (const p of (await ssmApi.listPrefix(f)).parameters) names.add(p.name);
      }
    } catch (e) {
      shell.showError(e);
      return;
    } finally {
      shell.setWorking(null);
    }
    const list = [...names].sort();
    if (!list.length) return shell.showFlash("Nothing to delete: the folder is empty.");
    const shown = list.slice(0, 10);
    const answer = await shell.ask(
      list.length === 1 ? "Delete parameter" : `Delete ${list.length} parameters`,
      <>
        {folders.length > 0 && (
          <p>
            Includes everything under {folders.map((f) => <span key={f} className="mono">{f} </span>)}
          </p>
        )}
        <ul className="name-list mono">
          {shown.map((n) => (
            <li key={n}>{n}</li>
          ))}
          {list.length > shown.length && <li>…and {list.length - shown.length} more</li>}
        </ul>
        <p>All versions and labels are deleted. This can't be undone.</p>
      </>,
      [
        { label: "Delete", value: "delete", danger: true },
        { label: "Cancel", value: "cancel" },
      ],
      "cancel",
    );
    if (answer !== "delete") return;
    shell.setWorking(`Deleting ${list.length} parameter${list.length === 1 ? "" : "s"}…`);
    try {
      const res = await ssmApi.delete(list);
      if (res.failed.length) {
        shell.showError({
          kind: "other",
          message: `Deleted ${res.deleted.length}; ${res.failed.length} failed.`,
          detail: res.failed.map((f) => `${f.name}: ${f.message}`).join("\n"),
        });
      } else {
        shell.showFlash(`Deleted ${res.deleted.length} parameter${res.deleted.length === 1 ? "" : "s"}.`);
      }
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
      setSelected(new Set());
      refresh();
    }
  }

  // ---------------------------------------------------------------------------
  // Copy / move / rename

  const isFolderKey = (k: string) => k.endsWith("/") && !byName.has(k);

  /** Plans, resolves collisions, confirms bigger operations, then runs. */
  async function transfer(items: string[], destFolder: string, move: boolean, renameTo: string | null = null) {
    if (readOnly) return shell.showFlash("Read-only mode: changes are disabled.");
    const verb = renameTo ? "Rename" : move ? "Move" : "Copy";
    let pairs;
    shell.setWorking("Working out what to copy…");
    try {
      pairs = await ssmApi.planCopy(items, destFolder, renameTo);
    } catch (e) {
      shell.showError(e);
      return;
    } finally {
      shell.setWorking(null);
    }
    if (!pairs.length) return shell.showFlash("Nothing to do: same location or empty folder.");
    const existing = pairs.filter((p) => p.exists);
    let overwrite = false;
    if (existing.length) {
      const answer = await shell.ask(
        existing.length === 1 ? "Parameter exists" : `${existing.length} parameters exist`,
        <>
          <ul className="name-list mono">
            {existing.slice(0, 10).map((p) => (
              <li key={p.to}>{p.to}</li>
            ))}
            {existing.length > 10 && <li>…and {existing.length - 10} more</li>}
          </ul>
          <p>Overwritten parameters keep their previous values as older versions.</p>
        </>,
        [
          { label: "Overwrite", value: "overwrite", danger: true },
          ...(existing.length < pairs.length ? [{ label: "Skip existing", value: "skip", primary: true }] : []),
          { label: "Cancel", value: "cancel" },
        ],
        "cancel",
      );
      if (answer === "cancel") return;
      overwrite = answer === "overwrite";
    } else if (pairs.length > 1) {
      const answer = await shell.ask(
        `${verb} ${pairs.length} parameters`,
        <>
          <ul className="name-list mono">
            {pairs.slice(0, 10).map((p) => (
              <li key={p.from}>
                {p.from} → {p.to}
              </li>
            ))}
            {pairs.length > 10 && <li>…and {pairs.length - 10} more</li>}
          </ul>
          {move && <p>The originals (with their history and labels) are deleted after each copy.</p>}
        </>,
        [
          { label: verb, value: "go", primary: true },
          { label: "Cancel", value: "cancel" },
        ],
        "cancel",
      );
      if (answer !== "go") return;
    }
    shell.setWorking(`${verb === "Copy" ? "Copying" : verb === "Move" ? "Moving" : "Renaming"} ${pairs.length} parameter${pairs.length === 1 ? "" : "s"}…`);
    try {
      const res = await ssmApi.copy(pairs, overwrite, move || !!renameTo);
      const parts = [`${res.copied.length} done`];
      if (res.skipped.length) parts.push(`${res.skipped.length} skipped`);
      if (res.failed.length) {
        shell.showError({
          kind: "other",
          message: `${verb}: ${parts.join(", ")}, ${res.failed.length} failed.`,
          detail: res.failed.map((f) => `${f.name}: ${f.message}`).join("\n"),
        });
      } else {
        shell.showFlash(`${verb}: ${parts.join(", ")}.`);
      }
      if (move && clipboard?.mode === "cut") setClipboard(null);
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
      setSelected(new Set());
      refresh();
    }
  }

  async function copyTo(items: string[], move: boolean) {
    if (readOnly || !items.length) return;
    const dest = await shell.askName(
      `${move ? "Move" : "Copy"} ${items.length === 1 ? lastSegment(items[0]) : `${items.length} items`} to`,
      "Destination folder",
      newFolder,
      move ? "Move" : "Copy",
      (v) => (v.trim().startsWith("/") ? null : "Folder paths begin with /"),
    );
    if (dest !== null) await transfer(items, dest.trim(), move);
  }

  async function rename(key: string) {
    if (readOnly) return shell.showFlash("Read-only mode: changes are disabled.");
    const folder = isFolderKey(key);
    const current = folder ? key.slice(0, -1) : key;
    const to = await shell.askName(
      folder ? "Rename folder" : "Rename parameter",
      folder ? "New folder path (everything inside moves)" : "New name (or path)",
      current,
      "Rename",
      (v) => {
        const t = v.trim().replace(/\/+$/, "");
        if (t === current) return "Enter a different name";
        return paramNameProblem(t);
      },
    );
    if (to === null) return;
    const t = to.trim().replace(/\/+$/, "");
    await transfer([key], "", true, folder ? t + "/" : t);
  }

  function toClipboard(mode: "copy" | "cut", items: string[]) {
    if (readOnly || !items.length) return;
    setClipboard({ mode, items });
    shell.showFlash(`${items.length} item${items.length === 1 ? "" : "s"} ${mode === "cut" ? "cut" : "copied"}; paste into a folder with Ctrl+V.`);
  }

  async function paste(dest: string = newFolder) {
    if (readOnly || !clipboard) return;
    await transfer(clipboard.items, dest, clipboard.mode === "cut");
  }

  /** Decrypts on demand and copies; the plaintext isn't kept anywhere. */
  async function copySecret(name: string) {
    try {
      await navigator.clipboard.writeText(await ssmApi.getValue(name, true));
      shell.showFlash("Decrypted value copied to the clipboard.");
    } catch (e) {
      shell.showError(e);
    }
  }

  // Keyboard shortcuts while the Parameter Store is shown.
  const modal = details || editor || historyOf || settingsOf || io;
  const opsRef = useRef({ newParam, editParam, deleteItems, rename, toClipboard, paste, selected, byName, active, modal });
  opsRef.current = { newParam, editParam, deleteItems, rename, toClipboard, paste, selected, byName, active, modal };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const o = opsRef.current;
      if (!o.active || o.modal) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, .modal-backdrop")) return;
      const sel = [...o.selected];
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === "Delete" && sel.length) {
        e.preventDefault();
        void o.deleteItems(sel);
      } else if (ctrl && e.shiftKey && (e.key === "N" || e.key === "n")) {
        e.preventDefault();
        o.newParam();
      } else if (e.key === "F2" && sel.length === 1) {
        e.preventDefault();
        void o.rename(sel[0]);
      } else if (ctrl && !e.shiftKey && (e.key === "c" || e.key === "x") && sel.length) {
        e.preventDefault();
        o.toClipboard(e.key === "c" ? "copy" : "cut", sel);
      } else if (ctrl && !e.shiftKey && e.key === "v") {
        e.preventDefault();
        void o.paste();
      } else if (ctrl && !e.shiftKey && e.key === "e" && sel.length === 1 && o.byName.has(sel[0])) {
        e.preventDefault();
        o.editParam(sel[0]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------------------------------------------------------------------------
  // Context menu

  /** Cut / Copy / Copy to / Move to for a set of items. */
  function folderTransferItems(items: string[]): MenuItem[] {
    return [
      { label: "Cut", shortcut: "Ctrl+X", disabled: readOnly, onClick: () => toClipboard("cut", items) },
      { label: "Copy", shortcut: "Ctrl+C", disabled: readOnly, onClick: () => toClipboard("copy", items) },
      { label: "Copy to…", disabled: readOnly, onClick: () => void copyTo(items, false) },
      { label: "Move to…", disabled: readOnly, onClick: () => void copyTo(items, true) },
    ];
  }

  function openContextMenu(key: string | null, x: number, y: number) {
    let items: MenuItem[];
    if (key === null) {
      items = [
        { label: "New parameter…", shortcut: "Ctrl+Shift+N", disabled: readOnly, onClick: newParam },
        { label: "Paste", shortcut: "Ctrl+V", disabled: readOnly || !clipboard, onClick: () => void paste() },
        "separator",
        { label: "Export this folder…", onClick: () => setIo({ kind: "export", folder: newFolder }) },
        { label: "Import into this folder…", disabled: readOnly, onClick: () => setIo({ kind: "import", folder: newFolder }) },
        "separator",
        { label: "Copy path", onClick: () => void shell.copyText(path) },
        "separator",
        { label: "Refresh", shortcut: "F5", onClick: refresh },
      ];
    } else if (key.endsWith("/") && !byName.has(key)) {
      items = [
        { label: "Open", bold: true, onClick: () => go(key) },
        { label: "Copy path", onClick: () => void shell.copyText(key) },
        { label: "Filter by this path", onClick: () => void applyFilter(key) },
        "separator",
        { label: "New parameter here…", disabled: readOnly, onClick: () => setEditor({ mode: "create", folder: key }) },
        { label: "Paste into this folder", disabled: readOnly || !clipboard, onClick: () => void paste(key) },
        "separator",
        ...folderTransferItems([key]),
        { label: "Rename folder…", shortcut: "F2", disabled: readOnly, onClick: () => void rename(key) },
        { label: "Export…", onClick: () => setIo({ kind: "export", folder: key }) },
        { label: "Delete folder…", disabled: readOnly, shortcut: "Del", onClick: () => void deleteItems([key]) },
      ];
    } else {
      const p = byName.get(key);
      const sel = selected.has(key) ? [...selected] : [key];
      items = [
        { label: "View details", bold: true, shortcut: "Enter", onClick: () => p && setDetails(p) },
        { label: "Edit…", shortcut: "Ctrl+E", disabled: readOnly, onClick: () => editParam(key) },
        { label: "History and labels…", onClick: () => setHistoryOf(key) },
        { label: "Tags…", onClick: () => p && setSettingsOf({ param: p, tab: "tags" }) },
        { label: "Tier and policies…", onClick: () => p && setSettingsOf({ param: p, tab: "tier" }) },
        "separator",
        { label: "Copy name", onClick: () => void shell.copyText(key) },
        ...(p && p.paramType !== "SecureString" && p.value !== null
          ? [{ label: "Copy value", onClick: () => void shell.copyText(p.value!) } as MenuItem]
          : []),
        ...(p?.paramType === "SecureString"
          ? [{ label: "Copy decrypted value", onClick: () => void copySecret(key) } as MenuItem]
          : []),
        "separator",
        ...folderTransferItems(sel),
        ...(sel.length === 1 ? [{ label: "Rename…", shortcut: "F2", disabled: readOnly, onClick: () => void rename(key) } as MenuItem] : []),
        { label: sel.length === 1 ? "Delete…" : `Delete ${sel.length} items…`, shortcut: "Del", disabled: readOnly, onClick: () => void deleteItems(sel) },
        ...(filter ? [{ label: "Open containing folder", onClick: () => (setFilter(""), go(parentPath(key))) } as MenuItem] : []),
        "separator",
        { label: "Refresh", shortcut: "F5", onClick: refresh },
      ];
    }
    shell.openMenu(x, y, items);
  }

  // ---------------------------------------------------------------------------
  // Tree

  /** In filter mode the tree shows only branches containing matches. */
  const filterFolders = useMemo(() => {
    if (!filter || !current?.data) return null;
    const set = new Set<string>(["/"]);
    for (const p of current.data.parameters) for (const a of ancestorPaths(p.name)) set.add(a);
    return set;
  }, [filter, current]);

  function childFolders(p: string): string[] | null {
    if (filterFolders) {
      return [...filterFolders].filter((f) => f !== p && f.startsWith(p) && f.slice(p.length).split("/").length === 2).sort();
    }
    return nodes.get(p)?.folders ?? null;
  }

  function renderFolder(p: string, depth: number): ReactNode {
    const kids = childFolders(p);
    const leaf = kids !== null && kids.length === 0;
    const isOpen = filterFolders ? true : expanded.has(p);
    return (
      <TreeRow
        key={p}
        depth={depth}
        label={lastSegment(p)}
        icon={<FolderIcon open={isOpen && !leaf} />}
        selected={active && !filter && path === p}
        expanded={leaf ? undefined : isOpen}
        title={p}
        onClick={() => {
          setFilter("");
          go(p);
        }}
        onToggle={() => !filterFolders && toggle(p)}
        onContextMenu={(x, y) =>
          shell.openMenu(x, y, [
            { label: "Open", bold: true, onClick: () => (setFilter(""), go(p)) },
            { label: "Copy path", onClick: () => void shell.copyText(p) },
            { label: "Filter by this path", onClick: () => void applyFilter(p) },
            "separator",
            { label: "New parameter here…", disabled: readOnly, onClick: () => setEditor({ mode: "create", folder: p }) },
            { label: "Paste into this folder", disabled: readOnly || !clipboard, onClick: () => void paste(p) },
            "separator",
            ...folderTransferItems([p]),
            { label: "Rename folder…", disabled: readOnly, onClick: () => void rename(p) },
            { label: "Export…", onClick: () => setIo({ kind: "export", folder: p }) },
            { label: "Import into this folder…", disabled: readOnly, onClick: () => setIo({ kind: "import", folder: p }) },
            { label: "Delete folder…", disabled: readOnly, onClick: () => void deleteItems([p]) },
          ])
        }
      >
        {kids === null ? (
          <TreeNote depth={depth + 1}>{nodes.get(p)?.failed ? "Couldn't list folders" : "Loading…"}</TreeNote>
        ) : (
          kids.map((k) => renderFolder(k, depth + 1))
        )}
      </TreeRow>
    );
  }

  const rootKids = childFolders("/");
  const tree = connection ? (
    <TreeRow
      depth={1}
      label={filter ? `Parameter Store (filtered)` : "Parameter Store"}
      icon={<ParamStoreIcon />}
      selected={active && path === "/" && !filter}
      expanded={serviceOpen}
      title={`Parameter Store · ${region}`}
      onClick={() => {
        setFilter("");
        go("/");
      }}
      onToggle={() => setServiceOpen((v) => !v)}
    >
      {rootKids === null ? (
        <TreeNote depth={2}>{nodes.get("/")?.failed ? "Couldn't list parameters" : "Loading…"}</TreeNote>
      ) : rootKids.length === 0 ? (
        <TreeNote depth={2}>{filter ? "No matching folders" : "No folders"}</TreeNote>
      ) : (
        rootKids.map((k) => renderFolder(k, 2))
      )}
    </TreeRow>
  ) : null;

  // ---------------------------------------------------------------------------
  // What the shell shows

  let content: ReactNode = null;
  if (active) {
    const filterBox = (
      <FilterBox
        label="Filter:"
        applied={filter}
        history={history}
        placeholder="Name prefix, e.g. /app/prod/ (Enter to apply)"
        onApply={(v) => void applyFilter(v)}
        onClear={() => setFilter("")}
        onForget={(v) => void forget(v)}
        onClearHistory={() => void forget(null)}
      />
    );
    content = (
      <div className="service-pane">
        {filterBox}
        {current?.error ? (
          <ErrorPanel error={current.error} profile={profile} onRetry={refresh} />
        ) : (
          <>
          {paged.error && <div className="warn-note list-note">Couldn't load values: {paged.error.message}</div>}
          <FileList
            key={listKey}
            columns={filter ? FILTER_COLUMNS : BROWSE_COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={(key) => {
              const p = byName.get(key);
              if (p) setDetails(p);
              else go(key);
            }}
            onContextMenu={openContextMenu}
            emptyText={loading || !current ? "Loading…" : filter ? `No parameters begin with "${filter}".` : "No parameters here."}
          />
          {entries.length > paging.pageSize && <PageBar {...paging.bar} loading={paged.loading} />}
          </>
        )}
      </div>
    );
  }

  let status = "";
  if (active && current?.data) {
    const nf = current.data.folders.length;
    const np = current.data.parameters.length;
    status = filter
      ? `${np.toLocaleString()} parameter${np === 1 ? "" : "s"} beginning with "${filter}"`
      : `${nf.toLocaleString()} folder${nf === 1 ? "" : "s"}, ${np.toLocaleString()} parameter${np === 1 ? "" : "s"}`;
    if (selected.size) status += ` · ${selected.size} selected`;
    status += ` · ${region}`;
  }

  const selParams = [...selected].filter((k) => byName.has(k));
  const commands = active ? (
    <>
      <CommandButton icon={<NewItemIcon />} label="New" title="New parameter (Ctrl+Shift+N)" disabled={readOnly || !connection} onClick={newParam} />
      <CommandButton
        icon={<EditIcon />}
        label="Edit"
        title="Edit the selected parameter (Ctrl+E)"
        disabled={readOnly || selParams.length !== 1 || selected.size !== 1}
        onClick={() => editParam(selParams[0])}
      />
      <CommandButton
        icon={<DeleteIcon />}
        label="Delete"
        title="Delete the selection (Del)"
        disabled={readOnly || selected.size === 0}
        onClick={() => void deleteItems([...selected])}
      />
      <CommandButton
        icon={<HistoryIcon />}
        label="History"
        title="Versions, labels and restore"
        disabled={selParams.length !== 1 || selected.size !== 1}
        onClick={() => setHistoryOf(selParams[0])}
      />
      <CommandSeparator />
      <CommandButton icon={<DownloadIcon />} label="Export" title="Export parameters to JSON or .env" disabled={!connection} onClick={() => setIo({ kind: "export", folder: newFolder })} />
      <CommandButton icon={<UploadIcon />} label="Import" title="Import parameters with a preview" disabled={readOnly || !connection} onClick={() => setIo({ kind: "import", folder: newFolder })} />
      <CommandSeparator />
      <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} />
    </>
  ) : null;

  const dialogs = (
    <>
      {details && (
        <ParamDetailsDialog
          param={details}
          onClose={() => setDetails(null)}
          onError={shell.showError}
          onSettings={() => {
            setSettingsOf({ param: details, tab: "tags" });
            setDetails(null);
          }}
          onHistory={() => {
            setHistoryOf(details.name);
            setDetails(null);
          }}
          onCopied={() => shell.showFlash("Decrypted value copied to the clipboard.")}
          onEdit={
            readOnly
              ? undefined
              : () => {
                  setEditor({ mode: "edit", param: details });
                  setDetails(null);
                }
          }
        />
      )}
      {io?.kind === "export" && <ParamExportDialog folder={io.folder} shell={shell} onClose={() => setIo(null)} />}
      {io?.kind === "import" && <ParamImportDialog folder={io.folder} shell={shell} onClose={() => setIo(null)} onImported={refresh} />}
      {settingsOf && (
        <ParamSettingsDialog
          key={settingsOf.param.name}
          param={settingsOf.param}
          initialTab={settingsOf.tab}
          shell={shell}
          onClose={() => setSettingsOf(null)}
          onChanged={refresh}
        />
      )}
      {historyOf && <ParamHistoryDialog name={historyOf} shell={shell} onClose={() => setHistoryOf(null)} onChanged={refresh} />}
      {editor && (
        <ParamEditorDialog
          target={editor}
          shell={shell}
          onClose={() => setEditor(null)}
          onSaved={(name, version) => {
            setEditor(null);
            shell.showFlash(`Saved ${name} (version ${version}).`);
            refresh();
          }}
        />
      )}
    </>
  );

  return {
    tree,
    content,
    commands,
    status,
    busy: active && (loading || paged.loading),
    refresh,
    dialogs,
  };
}
