// S3 service controller: buckets, folder tree, listing, file operations,
// transfers, preview/share/properties, sync. The shell places what it returns.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type AppError, type BucketInfo, type TransferEvent } from "../../api/s3";
import { onFileDrop } from "../../api/window";
import { CommandButton, CommandSeparator } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { FilterBox } from "../../components/FilterBox";
import { FolderTree } from "../../components/FolderTree";
import { PAGE_SIZES, PageBar } from "../../components/PageBar";
import {
  BucketIcon,
  DeleteIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  NewFolderIcon,
  SyncIcon,
  UploadIcon,
} from "../../components/Icons";
import { PreviewDialog } from "../../components/PreviewDialog";
import { PropertiesDialog } from "../../components/PropertiesDialog";
import { ShareDialog } from "../../components/ShareDialog";
import { SyncDialog } from "../../components/SyncDialog";
import { formatDate, formatSize } from "../../format";
import type { Shell, ServiceUi } from "../../shell/shell";
import { queryKey, useFolderPage, type ListQuery } from "../../state/folder";
import { baseName, parentPrefix, sameLocation, toS3Uri, type Location } from "../../state/navigation";
import { useFolderTree } from "../../state/tree";
import { activeCount, applyFilter, NO_FILTER, type ObjectFilter } from "../../util/objectFilter";
import { ObjectFilterBar } from "./ObjectFilterBar";

/** In-app clipboard for cut/copy/paste of objects (files only). */
interface Clipboard {
  mode: "copy" | "cut";
  bucket: string;
  keys: string[];
}

const S3_HOME: Location = { bucket: null, prefix: "" };

const PAGE_SIZE_KEY = "s3.pageSize";
function savedPageSize(): number {
  try {
    const n = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return PAGE_SIZES.includes(n) ? n : 1000;
  } catch {
    return 1000;
  }
}

/** "report.csv" -> "report - Copy.csv", then "report - Copy (2).csv" … avoiding `taken`. */
function copyName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; ; n++) {
    const candidate = `${stem} - Copy${n > 1 ? ` (${n})` : ""}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Validates a single folder/file name segment. */
function nameError(name: string): string | null {
  const t = name.trim();
  if (!t) return "Enter a name.";
  if (t.includes("/")) return "Names can't contain '/'.";
  if (t === "." || t === "..") return "That name isn't allowed.";
  return null;
}

/** File name from a local path (Windows or POSIX separators). */
const localName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

const BUCKET_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 320 },
  { id: "region", label: "Region", width: 140 },
  { id: "created", label: "Date created", width: 170 },
];

const OBJECT_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 320 },
  { id: "size", label: "Size", width: 100, align: "right" },
  { id: "modified", label: "Date modified", width: 170 },
  { id: "class", label: "Storage class", width: 140 },
];

/** Recursive (flat) view: the folder each file is in, relative to the current one. */
const FLAT_COLUMNS: Column[] = [OBJECT_COLUMNS[0], { id: "path", label: "Path", width: 260 }, ...OBJECT_COLUMNS.slice(1)];

export function useS3Service(shell: Shell): ServiceUi {
  const { connection, connectionId, profile, place, readOnly } = shell;
  const active = place.service === "s3";
  /** Current S3 location; the S3 root when another service is active. */
  const loc: Location = place.service === "s3" ? { bucket: place.bucket, prefix: place.prefix } : S3_HOME;
  const go = useCallback((l: Location) => shell.navigate({ service: "s3", ...l }), [shell]);
  const { ask, askName, showError, showFlash, setWorking, copyText, openTransfers } = shell;

  const [buckets, setBuckets] = useState<BucketInfo[] | null>(null);
  const [bucketsError, setBucketsError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reloadToken, setReloadToken] = useState(0);
  const [serviceOpen, setServiceOpen] = useState(true);
  const [pageSize, setPageSizeState] = useState(savedPageSize);
  /** Search + "Include subfolders", tied to the folder they were set in. */
  const locId = `${connectionId}|${loc.bucket ?? ""}|${loc.prefix}`;
  const [searchState, setSearchState] = useState({ locId, search: "", recursive: false });
  const search = searchState.locId === locId ? searchState.search : "";
  const recursive = searchState.locId === locId ? searchState.recursive : false;
  const setSearch = (v: string) => setSearchState({ locId, search: v, recursive });
  const setRecursive = (v: boolean) => setSearchState({ locId, search, recursive: v });
  /** On-screen filters; kept while browsing until cleared. */
  const [objFilter, setObjFilter] = useState<ObjectFilter>(NO_FILTER);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const searchHistoryKey = `s3|${profile ?? ""}|${loc.bucket ?? ""}`;
  const listLoc = active ? loc : S3_HOME;
  const query: ListQuery = { bucket: listLoc.bucket, prefix: listLoc.prefix, search, recursive, pageSize };
  const qKey = queryKey(connectionId, query);
  /** Page index, tied to the query it belongs to (a new query starts at page 0). */
  const [pageState, setPageState] = useState({ key: qKey, page: 0 });
  const page = pageState.key === qKey ? pageState.page : 0;
  const goPage = (n: number) => setPageState({ key: qKey, page: Math.max(0, n) });
  const setPageSize = (n: number) => {
    setPageSizeState(n);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(n));
    } catch {
      /* convenience only */
    }
  };
  const folder = useFolderPage(connectionId, query, page, reloadToken);
  const tree = useFolderTree(connectionId);
  const [dropTarget, setDropTarget] = useState<Location | null>(null);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [preview, setPreview] = useState<{ keys: string[]; index: number } | null>(null);
  const [shareKey, setShareKey] = useState<string | null>(null);
  const [propsKey, setPropsKey] = useState<string | null>(null);
  /** Properties opened from the tree (may be outside the current folder). */
  const [propsTarget, setPropsTarget] = useState<{ bucket: string; key: string } | null>(null);
  const [syncTarget, setSyncTarget] = useState<Location | null>(null);
  /** Row keys in the order the list currently shows them. */
  const displayOrder = useRef<string[]>([]);
  const onOrderChange = useCallback((keys: string[]) => {
    displayOrder.current = keys;
  }, []);

  // Each load gets a sequence number so a slow response from a previous
  // connection can't overwrite the current one.
  const seq = useRef(0);
  const loadBuckets = useCallback(async () => {
    const my = ++seq.current;
    setBusy(true);
    setBucketsError(null);
    try {
      const list = await api.listBuckets();
      if (my === seq.current) setBuckets(list);
    } catch (e) {
      if (my === seq.current) {
        setBuckets(null);
        setBucketsError(e as AppError);
      }
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }, []);

  // New connection: forget everything and list buckets.
  useEffect(() => {
    setBuckets(null);
    setBucketsError(null);
    setClipboard(null);
    if (connectionId > 0) void loadBuckets();
  }, [connectionId, loadBuckets]);

  const refresh = useCallback(() => {
    if (!connection) return;
    const { bucket, prefix } = loc;
    if (bucket === null) {
      void loadBuckets();
    } else {
      tree.invalidate(bucket, prefix);
      setReloadToken((n) => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, loc.bucket, loc.prefix, loadBuckets, tree]);

  // Navigating expands the tree down to the new location.
  useEffect(() => {
    if (active) tree.reveal(loc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loc.bucket, loc.prefix, connectionId]);

  // A folder that fits on one page feeds its sub-folders to the tree; for a
  // bigger one the tree lists the sub-folders itself.
  const plainListing = !search && !recursive;
  useEffect(() => {
    if (folder.bucket === null || folder.loading || !plainListing || folder.queryKey !== qKey) return;
    if (folder.complete) tree.setChildren(folder.bucket, folder.prefix, folder.folders, true);
    else if (folder.error && folder.page === 0) tree.setChildren(folder.bucket, folder.prefix, [], false);
    else tree.ensure(folder.bucket, folder.prefix);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder.complete, folder.error, folder.loading, folder.bucket, folder.prefix, folder.queryKey]);

  useEffect(() => {
    if (!profile || loc.bucket === null) return;
    api
      .getSettings()
      .then((st) => setSearchHistory(st.filterHistory?.[searchHistoryKey] ?? []))
      .catch(() => setSearchHistory([]));
  }, [searchHistoryKey, profile, loc.bucket]);

  async function applySearch(v: string) {
    setSearch(v);
    try {
      setSearchHistory(await api.rememberFilter(searchHistoryKey, v));
    } catch {
      /* convenience only */
    }
  }
  async function forgetSearch(v: string | null) {
    try {
      setSearchHistory(await api.forgetFilter(searchHistoryKey, v));
    } catch {
      /* ignore */
    }
  }

  // Clear selection whenever the location or page changes.
  useEffect(() => setSelected(new Set()), [loc.bucket, loc.prefix, active, qKey, page]);

  const bucketRows: Row[] = useMemo(
    () =>
      (buckets ?? []).map((b) => ({
        key: b.name,
        icon: <BucketIcon />,
        isContainer: true,
        cells: {
          name: { text: b.name, sort: b.name },
          region: { text: b.region ?? "", sort: b.region ?? "" },
          created: { text: formatDate(b.creationDate), sort: b.creationDate ?? "" },
        },
      })),
    [buckets],
  );

  // The listing hook resets after render, so guard against one frame of stale data.
  const listingCurrent = folder.queryKey === qKey && folder.page === page;

  const cutKeys = useMemo(
    () => new Set(clipboard?.mode === "cut" && clipboard.bucket === loc.bucket ? clipboard.keys : []),
    [clipboard, loc.bucket],
  );

  const filtering = activeCount(objFilter) > 0;
  const shown = useMemo(
    () => applyFilter(folder.folders, folder.files, objFilter, baseName),
    [folder.folders, folder.files, objFilter],
  );
  const pageClasses = useMemo(() => [...new Set(folder.files.map((f) => f.storageClass ?? "STANDARD"))], [folder.files]);

  // Hidden rows drop out of the selection.
  useEffect(() => {
    if (!filtering) return;
    const visible = new Set([...shown.folders, ...shown.files.map((f) => f.key)]);
    setSelected((sel) => {
      const kept = [...sel].filter((k) => visible.has(k));
      return kept.length === sel.size ? sel : new Set(kept);
    });
  }, [shown, filtering]);

  const objectRows: Row[] = useMemo(() => {
    if (!listingCurrent) return [];
    const rows: Row[] = shown.folders.map((p) => {
      const name = baseName(p);
      return {
        key: p,
        icon: <FolderIcon />,
        isContainer: true,
        cells: {
          name: { text: name, sort: name },
          size: { text: "", sort: -1 },
          modified: { text: "", sort: "" },
          class: { text: "", sort: "" },
        },
      };
    });
    for (const f of shown.files) {
      const name = baseName(f.key);
      const path = parentPrefix(f.key).slice(loc.prefix.length);
      rows.push({
        key: f.key,
        icon: <FileIcon />,
        isContainer: false,
        dimmed: cutKeys.has(f.key),
        cells: {
          name: { text: name, sort: name },
          path: { text: path, sort: path },
          size: { text: formatSize(f.size), sort: f.size },
          modified: { text: formatDate(f.lastModified), sort: f.lastModified ?? "" },
          class: { text: f.storageClass ?? "", sort: f.storageClass ?? "" },
        },
      });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, listingCurrent, cutKeys]);

  // ---------------------------------------------------------------------------
  // Uploads & downloads

  async function startUpload(paths: string[], target: Location) {
    if (readOnly) return showFlash("Read-only mode: uploads are disabled.");
    if (target.bucket === null || paths.length === 0) return;
    let list = paths;
    // Warn before overwriting files already in the current folder.
    if (sameLocation(target, loc)) {
      let existing: Set<string>;
      try {
        existing = await takenNames(target, paths.map(localName));
      } catch (e) {
        showError(e);
        return;
      }
      const conflicts = paths.filter((p) => existing.has(localName(p)));
      if (conflicts.length > 0) {
        const choice = await ask(
          "Replace files?",
          <>
            <p>
              {conflicts.length === 1
                ? `"${localName(conflicts[0])}" already exists in this folder.`
                : `${conflicts.length} files already exist in this folder.`}
            </p>
            {conflicts.length > 1 && (
              <ul className="name-list">
                {conflicts.slice(0, 8).map((c) => (
                  <li key={c}>{localName(c)}</li>
                ))}
                {conflicts.length > 8 && <li>…and {conflicts.length - 8} more</li>}
              </ul>
            )}
          </>,
          [
            { label: "Replace", value: "replace", primary: true },
            { label: "Skip these", value: "skip" },
            { label: "Cancel", value: "cancel" },
          ],
          "cancel",
        );
        if (choice === "cancel") return;
        if (choice === "skip") list = paths.filter((p) => !existing.has(localName(p)));
      }
    }
    if (list.length === 0) return;
    try {
      await api.uploadPaths(target.bucket, target.prefix, list);
      openTransfers();
    } catch (e) {
      showError(e);
    }
  }

  async function uploadFilesTo(target: Location) {
    if (readOnly) return;
    try {
      const paths = await api.pickUploadFiles();
      await startUpload(paths, target);
    } catch (e) {
      showError(e);
    }
  }

  async function uploadFolderTo(target: Location) {
    if (readOnly) return;
    try {
      const path = await api.pickFolder(`Upload a folder to ${toS3Uri(target)}`);
      if (path) await startUpload([path], target);
    } catch (e) {
      showError(e);
    }
  }

  async function downloadItems(keys: string[]) {
    const bucket = loc.bucket;
    if (bucket === null || keys.length === 0) return;
    try {
      if (keys.length === 1 && !keys[0].endsWith("/")) {
        const dest = await api.pickSaveFile(baseName(keys[0]));
        if (!dest) return;
        await api.downloadFile(bucket, keys[0], dest);
      } else {
        const dest = await api.pickFolder("Download to folder");
        if (!dest) return;
        await api.downloadToFolder(bucket, keys, dest);
      }
      openTransfers();
    } catch (e) {
      showError(e);
    }
  }

  // Re-list the current folder (debounced) when transfers land in or below it.
  const reloadTimer = useRef<number | undefined>(undefined);
  const locationRef = useRef({ loc, active, readOnly });
  locationRef.current = { loc, active, readOnly };
  const onTransferFinished = useCallback((t: TransferEvent) => {
    const { loc: here, active: isActive } = locationRef.current;
    if (!isActive) return;
    const under = (bucket: string | null, key: string | null) =>
      bucket === here.bucket && key !== null && key.startsWith(here.prefix);
    const affectsHere =
      (t.direction !== "download" && under(t.bucket, t.key)) || (t.direction === "move" && under(t.sourceBucket, t.sourceKey));
    if (!affectsHere) return;
    window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => setReloadToken((n) => n + 1), 400);
  }, []);

  /** Re-list the current folder in place (after create/delete). */
  const reloadHere = () => setReloadToken((n) => n + 1);

  // ---------------------------------------------------------------------------
  // File operations

  /** Names (files and folders) in the current folder, when it's fully listed on screen. */
  function currentNames(): Set<string> | null {
    if (!listingCurrent || !folder.complete || !plainListing) return null;
    return new Set([...folder.files.map((f) => baseName(f.key)), ...folder.folders.map((p) => baseName(p))]);
  }

  /** Which of `names` (files) exist in `target`: from the listing when it's all on screen, else asked of S3. */
  async function takenNames(target: Location, names: string[]): Promise<Set<string>> {
    const known = sameLocation(target, loc) ? currentNames() : null;
    if (known) return new Set(names.filter((n) => known.has(n)));
    if (target.bucket === null || names.length === 0) return new Set();
    const found = await api.existingKeys(target.bucket, [...new Set(names)].map((n) => target.prefix + n));
    return new Set(found.map(baseName));
  }

  async function newFolder(target: Location = loc) {
    if (readOnly) return;
    if (target.bucket === null) return;
    const names = sameLocation(target, loc) ? currentNames() : null;
    let initial = "New folder";
    for (let n = 2; names?.has(initial); n++) initial = `New folder (${n})`;
    const name = await askName("New folder", `Create a folder in ${toS3Uri(target)}`, initial, "Create", (v) =>
      nameError(v) ?? (names?.has(v.trim()) ? "Something with that name already exists here." : null),
    );
    if (!name) return;
    try {
      await api.createFolder(target.bucket, `${target.prefix}${name}/`);
      if (sameLocation(target, loc)) reloadHere();
      else tree.invalidate(target.bucket, target.prefix);
    } catch (e) {
      showError(e);
    }
  }

  async function deleteItems(keys: string[]) {
    if (readOnly) return;
    const bucket = loc.bucket;
    if (bucket === null || keys.length === 0) return;
    const folders = keys.filter((k) => k.endsWith("/"));
    let body: ReactNode;
    if (folders.length > 0) {
      setWorking("Counting objects…");
      let count;
      try {
        count = await api.countItems(bucket, keys);
      } catch (e) {
        showError(e);
        return;
      } finally {
        setWorking(null);
      }
      const what =
        keys.length === 1 ? `the folder "${baseName(keys[0])}"` : `these ${keys.length.toLocaleString()} items`;
      body = (
        <>
          <p>Permanently delete {what} and everything in it?</p>
          <p>
            <strong>
              {count.objects.toLocaleString()} object{count.objects === 1 ? "" : "s"} ({formatSize(count.bytes)})
            </strong>{" "}
            will be deleted.
          </p>
        </>
      );
    } else {
      body = (
        <p>
          {keys.length === 1
            ? `Permanently delete "${baseName(keys[0])}"?`
            : `Permanently delete these ${keys.length.toLocaleString()} files?`}
        </p>
      );
    }
    const choice = await ask(
      "Delete",
      <>
        {body}
        <p className="muted-note">This can't be undone (unless versioning is enabled on the bucket).</p>
      </>,
      [
        { label: "Delete", value: "delete", danger: true },
        { label: "Cancel", value: "cancel", primary: true },
      ],
      "cancel",
    );
    if (choice !== "delete") return;
    setWorking("Deleting…");
    try {
      const res = await api.deleteItems(bucket, keys);
      setSelected(new Set());
      setClipboard((c) => (c && c.bucket === bucket ? { ...c, keys: c.keys.filter((k) => !keys.includes(k)) } : c));
      if (res.failed.length > 0) {
        void ask(
          "Some items weren't deleted",
          <>
            <p>
              Deleted {res.deleted.toLocaleString()}; {res.failed.length.toLocaleString()} failed:
            </p>
            <ul className="name-list">
              {res.failed.slice(0, 10).map((f) => (
                <li key={f.key}>
                  {f.key}: {f.message}
                </li>
              ))}
              {res.failed.length > 10 && <li>…and {res.failed.length - 10} more</li>}
            </ul>
          </>,
          [{ label: "OK", value: "ok", primary: true }],
          "ok",
        );
      }
    } catch (e) {
      showError(e);
    } finally {
      setWorking(null);
      reloadHere();
    }
  }

  async function renameItem(key: string) {
    if (readOnly) return;
    const bucket = loc.bucket;
    if (bucket === null || key.endsWith("/")) return;
    const old = baseName(key);
    const names = currentNames();
    const name = await askName("Rename", `New name for "${old}"`, old, "Rename", (v) =>
      nameError(v) ?? (v.trim() !== old && names?.has(v.trim()) ? "Something with that name already exists here." : null),
    );
    if (!name || name === old) return;
    const folderOfKey = parentPrefix(key);
    try {
      if (!names && (await takenNames({ bucket, prefix: folderOfKey }, [name])).size) {
        const choice = await ask(
          "Replace file?",
          <p>"{name}" already exists in this folder.</p>,
          [
            { label: "Replace", value: "replace", danger: true },
            { label: "Cancel", value: "cancel", primary: true },
          ],
          "cancel",
        );
        if (choice !== "replace") return;
      }
      await api.copyItems(bucket, bucket, [{ from: key, to: folderOfKey + name }], true);
    } catch (e) {
      showError(e);
    }
  }

  /** Puts selected files on the clipboard. Folders aren't supported yet. */
  function toClipboard(mode: "copy" | "cut", keys: string[]) {
    if (readOnly) return; // copy/cut only lead to writes (paste)
    const bucket = loc.bucket;
    if (bucket === null || keys.length === 0) return;
    const files = keys.filter((k) => !k.endsWith("/"));
    if (files.length < keys.length) {
      void ask(
        mode === "copy" ? "Copy" : "Cut",
        <p>
          Copying and moving whole folders isn't supported yet.
          {files.length > 0 ? ` Only the ${files.length} selected file(s) were ${mode === "copy" ? "copied" : "cut"}.` : ""}
        </p>,
        [{ label: "OK", value: "ok", primary: true }],
        "ok",
      );
    }
    if (files.length > 0) setClipboard({ mode, bucket, keys: files });
  }

  async function paste(target: Location = loc) {
    if (readOnly) return;
    if (!clipboard || target.bucket === null) return;
    const isMove = clipboard.mode === "cut";
    const sameFolder = (k: string) => clipboard.bucket === target.bucket && parentPrefix(k) === target.prefix;
    let pairs = clipboard.keys.map((k) => ({ from: k, to: target.prefix + baseName(k) }));
    if (isMove) pairs = pairs.filter((p) => !sameFolder(p.from)); // moving onto itself: nothing to do

    let names = sameLocation(target, loc) ? currentNames() : null;
    if (!names) {
      // Not all on screen: ask S3 about the names this paste could use.
      const candidates = new Set<string>();
      for (const p of pairs) {
        candidates.add(baseName(p.to));
        if (!isMove && sameFolder(p.from)) {
          const none = new Set<string>();
          let n = baseName(p.from);
          for (let i = 0; i < 20; i++) {
            n = copyName(baseName(p.from), none);
            none.add(n);
            candidates.add(n);
          }
        }
      }
      try {
        names = await takenNames(target, [...candidates]);
      } catch (e) {
        showError(e);
        return;
      }
    }
    {
      const taken = new Set(names);
      // Copy into the same folder: "name - Copy.ext", like Explorer.
      pairs = pairs.map((p) => {
        if (!isMove && sameFolder(p.from)) {
          const n = copyName(baseName(p.from), taken);
          taken.add(n);
          return { ...p, to: target.prefix + n };
        }
        return p;
      });
      const conflicts = pairs.filter((p) => !(!isMove && sameFolder(p.from)) && names.has(baseName(p.to)));
      if (conflicts.length > 0) {
        const choice = await ask(
          "Replace files?",
          <p>
            {conflicts.length === 1
              ? `"${baseName(conflicts[0].to)}" already exists in this folder.`
              : `${conflicts.length} files already exist in this folder.`}
          </p>,
          [
            { label: "Replace", value: "replace", primary: true },
            { label: "Skip these", value: "skip" },
            { label: "Cancel", value: "cancel" },
          ],
          "cancel",
        );
        if (choice === "cancel") return;
        if (choice === "skip") pairs = pairs.filter((p) => !conflicts.includes(p));
      }
    }
    if (pairs.length === 0) return;
    try {
      await api.copyItems(clipboard.bucket, target.bucket, pairs, isMove);
      if (isMove) setClipboard(null);
      openTransfers();
    } catch (e) {
      showError(e);
    }
  }

  /** Opens the preview for a file, stepping through the folder's files in display order. */
  function openPreview(key: string) {
    const files = displayOrder.current.filter((k) => !k.endsWith("/"));
    const index = files.indexOf(key);
    setPreview(index >= 0 ? { keys: files, index } : { keys: [key], index: 0 });
  }

  /** Saves a recursive listing of a folder (or bucket) as a text file. */
  async function downloadListing(l: Location) {
    if (l.bucket === null) return;
    const name = l.prefix ? baseName(l.prefix) : l.bucket;
    try {
      const dest = await api.pickSaveFile(`${name}-listing.txt`);
      if (!dest) return;
      setWorking(`Listing ${toS3Uri(l)}…`);
      const res = await api.exportListing(l.bucket, l.prefix, dest);
      setWorking(null);
      showFlash(`Saved a list of ${res.objects.toLocaleString()} objects (${formatSize(res.bytes)}) to ${res.path}`);
    } catch (e) {
      setWorking(null);
      showError(e);
    }
  }

  /** Downloads a folder (recursively) into a chosen local folder. */
  async function downloadFolder(l: Location) {
    if (l.bucket === null || !l.prefix) return;
    try {
      const dest = await api.pickFolder("Download to folder");
      if (!dest) return;
      await api.downloadToFolder(l.bucket, [l.prefix], dest);
      openTransfers();
    } catch (e) {
      showError(e);
    }
  }

  /** Right-click menu for a bucket/folder in the tree. */
  function openTreeMenu(l: Location, x: number, y: number) {
    const isBucket = l.prefix === "";
    const items: MenuItem[] = [
      { label: "Open", bold: true, onClick: () => go(l) },
      "separator",
      { label: isBucket ? "Sync this bucket…" : "Sync this folder…", onClick: () => setSyncTarget(l) },
      { label: "Download list of contents…", onClick: () => void downloadListing(l) },
      ...(isBucket ? [] : [{ label: "Download folder…", onClick: () => void downloadFolder(l) } as MenuItem]),
      "separator",
      { label: "Paste into this folder", disabled: readOnly || !clipboard, onClick: () => void paste(l) },
      { label: "New folder inside…", disabled: readOnly, onClick: () => void newFolder(l) },
      { label: "Upload files into this folder…", disabled: readOnly, onClick: () => void uploadFilesTo(l) },
      { label: "Upload folder into this folder…", disabled: readOnly, onClick: () => void uploadFolderTo(l) },
      "separator",
      { label: "Copy S3 URI", onClick: () => void copyText(toS3Uri(l)) },
      ...(isBucket || l.bucket === null
        ? []
        : [{ label: "Properties", onClick: () => setPropsTarget({ bucket: l.bucket!, key: l.prefix }) } as MenuItem]),
    ];
    shell.openMenu(x, y, items);
  }

  // Keyboard shortcuts for file operations (latest closures via ref; only while S3 is active).
  const pageNav = (delta: number) => {
    if (!listingCurrent || folder.loading) return;
    if (delta > 0 && folder.hasNext) goPage(page + 1);
    if (delta < 0 && page > 0) goPage(page - 1);
  };
  const opsRef = useRef({ newFolder, deleteItems, renameItem, toClipboard, paste, setPropsKey, pageNav });
  opsRef.current = { newFolder, deleteItems, renameItem, toClipboard, paste, setPropsKey, pageNav };
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [role=dialog], [role=alertdialog]")) return;
      const { loc: here, active: isActive } = locationRef.current;
      if (!isActive || here.bucket === null) return;
      const ops = opsRef.current;
      const sel = [...selectedRef.current];
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === "Enter" && e.altKey && sel.length === 1) {
        e.preventDefault();
        ops.setPropsKey(sel[0]);
      } else if (e.key === "Delete" && sel.length) {
        e.preventDefault();
        void ops.deleteItems(sel);
      } else if (e.key === "F2" && sel.length === 1) {
        e.preventDefault();
        void ops.renameItem(sel[0]);
      } else if (ctrl && e.shiftKey && (e.key === "N" || e.key === "n")) {
        e.preventDefault();
        void ops.newFolder();
      } else if (ctrl && !e.shiftKey && (e.key === "c" || e.key === "x") && sel.length) {
        e.preventDefault();
        ops.toClipboard(e.key === "c" ? "copy" : "cut", sel);
      } else if (ctrl && !e.shiftKey && e.key === "v") {
        e.preventDefault();
        void ops.paste();
      } else if (ctrl && !e.shiftKey && e.key === "f") {
        const box = document.getElementById("filter-input") as HTMLInputElement | null;
        if (box) {
          e.preventDefault();
          box.focus();
          box.select();
        }
      } else if (ctrl && (e.key === "PageDown" || e.key === "PageUp")) {
        e.preventDefault();
        ops.pageNav(e.key === "PageDown" ? 1 : -1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Drag-and-drop from the OS. Target: an S3 tree folder, a folder row, or the current folder.
  const startUploadRef = useRef(startUpload);
  startUploadRef.current = startUpload;
  useEffect(() => {
    function targetAt(x: number, y: number): Location | null {
      if (locationRef.current.readOnly) return null; // no uploads in read-only mode
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!el || el.closest(".modal-backdrop")) return null;
      const treeRow = el.closest<HTMLElement>(".tree-row[data-bucket]");
      if (treeRow) return { bucket: treeRow.dataset.bucket!, prefix: treeRow.dataset.prefix ?? "" };
      const { loc: here, active: isActive } = locationRef.current;
      if (!isActive || here.bucket === null || !el.closest(".pane-main")) return null;
      const key = el.closest<HTMLElement>(".fl-row")?.dataset.key;
      return key?.endsWith("/") ? { bucket: here.bucket, prefix: key } : here;
    }
    return onFileDrop({
      over: (x, y) => setDropTarget(targetAt(x, y)),
      leave: () => setDropTarget(null),
      drop: (paths, x, y) => {
        const t = targetAt(x, y);
        setDropTarget(null);
        if (t) void startUploadRef.current(paths, t);
      },
    });
  }, []);

  // Highlight the element under a drag.
  useEffect(() => {
    document.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
    if (!dropTarget || dropTarget.bucket === null) return;
    const b = CSS.escape(dropTarget.bucket);
    const p = CSS.escape(dropTarget.prefix);
    if (active && sameLocation(dropTarget, loc)) {
      document.querySelector(".pane-main")?.classList.add("drop-target");
    } else if (active && dropTarget.bucket === loc.bucket) {
      document.querySelector(`.fl-row[data-key="${p}"]`)?.classList.add("drop-target");
    }
    document.querySelector(`.tree-row[data-bucket="${b}"][data-prefix="${p}"]`)?.classList.add("drop-target");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropTarget, active, loc.bucket, loc.prefix]);

  // ---------------------------------------------------------------------------
  // Context menu (main list)

  function openContextMenu(key: string | null, x: number, y: number) {
    let items: MenuItem[];
    if (loc.bucket === null) {
      const b: Location = { bucket: key, prefix: "" };
      items = key
        ? [
            { label: "Open", bold: true, onClick: () => go(b) },
            "separator",
            { label: "Sync this bucket…", onClick: () => setSyncTarget(b) },
            { label: "Download list of contents…", onClick: () => void downloadListing(b) },
            { label: "Copy S3 URI", onClick: () => void copyText(toS3Uri(b)) },
          ]
        : [{ label: "Refresh", shortcut: "F5", onClick: refresh }];
    } else if (key === null) {
      items = [
        { label: "Paste", shortcut: "Ctrl+V", disabled: readOnly || !clipboard, onClick: () => void paste(loc) },
        "separator",
        { label: "New folder…", disabled: readOnly, shortcut: "Ctrl+Shift+N", onClick: () => void newFolder(loc) },
        { label: "Upload files…", disabled: readOnly, onClick: () => void uploadFilesTo(loc) },
        { label: "Upload folder…", disabled: readOnly, onClick: () => void uploadFolderTo(loc) },
        "separator",
        { label: "Sync this folder…", onClick: () => setSyncTarget(loc) },
        { label: "Download list of contents…", onClick: () => void downloadListing(loc) },
        { label: "Copy S3 URI", onClick: () => void copyText(toS3Uri(loc)) },
        "separator",
        { label: "Refresh", shortcut: "F5", onClick: refresh },
      ];
    } else {
      // The clicked row is selected by FileList before this runs.
      const keys = selected.has(key) ? [...selected] : [key];
      const single = keys.length === 1;
      const isFolder = single && key.endsWith("/");
      const into: Location = isFolder ? { bucket: loc.bucket, prefix: key } : loc;
      const anyFolder = keys.some((k) => k.endsWith("/"));
      const noFolders = "Folders can't be copied or moved yet";
      const isFile = single && !isFolder;
      items = [
        ...(isFolder ? [{ label: "Open", bold: true, onClick: () => go(into) } as MenuItem] : []),
        ...(isFile ? [{ label: "Preview", bold: true, shortcut: "Enter", onClick: () => openPreview(key) } as MenuItem] : []),
        { label: single ? "Download…" : `Download ${keys.length} items…`, onClick: () => void downloadItems(keys) },
        ...(isFile ? [{ label: "Share link…", onClick: () => setShareKey(key) } as MenuItem] : []),
        ...(single ? [{ label: "Copy S3 URI", onClick: () => void copyText(`s3://${loc.bucket}/${key}`) } as MenuItem] : []),
        "separator",
        { label: anyFolder ? `Cut (${noFolders.toLowerCase()})` : "Cut", shortcut: "Ctrl+X", disabled: readOnly || anyFolder, onClick: () => toClipboard("cut", keys) },
        { label: anyFolder ? `Copy (${noFolders.toLowerCase()})` : "Copy", shortcut: "Ctrl+C", disabled: readOnly || anyFolder, onClick: () => toClipboard("copy", keys) },
        ...(isFolder ? [{ label: "Paste into this folder", disabled: readOnly || !clipboard, onClick: () => void paste(into) } as MenuItem] : []),
        "separator",
        ...(single && !isFolder ? [{ label: "Rename…", disabled: readOnly, shortcut: "F2", onClick: () => void renameItem(key) } as MenuItem] : []),
        { label: single ? "Delete…" : `Delete ${keys.length} items…`, disabled: readOnly, shortcut: "Del", onClick: () => void deleteItems(keys) },
        "separator",
        ...(isFolder ? [{ label: "New folder inside…", disabled: readOnly, onClick: () => void newFolder(into) } as MenuItem] : []),
        ...(isFolder ? [{ label: "Sync this folder…", onClick: () => setSyncTarget(into) } as MenuItem] : []),
        ...(isFolder ? [{ label: "Download list of contents…", onClick: () => void downloadListing(into) } as MenuItem] : []),
        { label: isFolder ? "Upload files into this folder…" : "Upload files…", disabled: readOnly, onClick: () => void uploadFilesTo(into) },
        { label: isFolder ? "Upload folder into this folder…" : "Upload folder…", disabled: readOnly, onClick: () => void uploadFolderTo(into) },
        "separator",
        { label: "Refresh", shortcut: "F5", onClick: refresh },
        ...(single ? (["separator", { label: "Properties", shortcut: "Alt+Enter", onClick: () => setPropsKey(key) }] as MenuItem[]) : []),
      ];
    }
    shell.openMenu(x, y, items);
  }

  // ---------------------------------------------------------------------------
  // What the shell shows

  function emptyObjectsText(): string {
    if (!listingCurrent || folder.loading) return "Loading…";
    if (filtering && folder.folders.length + folder.files.length > 0)
      return `Nothing on this page matches the filters${folder.hasNext ? "; try the next page" : ""}.`;
    if (page > 0) return "Nothing on this page.";
    const where = recursive ? " in this folder or below" : " in this folder";
    if (search) return `No names start with "${search}"${where}.`;
    return recursive ? "No files in this folder or below." : "This folder is empty.";
  }

  let content: ReactNode = null;
  if (active) {
    if (loc.bucket === null) {
      content = bucketsError ? (
        <ErrorPanel error={bucketsError} profile={profile} onRetry={loadBuckets} />
      ) : (
        <FileList
          columns={BUCKET_COLUMNS}
          rows={bucketRows}
          selected={selected}
          onSelectionChange={setSelected}
          onOpen={(name) => go({ bucket: name, prefix: "" })}
          onContextMenu={openContextMenu}
          emptyText={busy ? "Loading…" : "No buckets"}
        />
      );
    } else if (listingCurrent && folder.error) {
      content = <ErrorPanel error={folder.error} profile={profile} onRetry={refresh} />;
    } else {
      content = (
        <div className="service-pane">
          <FilterBox
            label="Search:"
            buttonLabel="Search"
            applied={search}
            history={searchHistory}
            placeholder="Names starting with… (Enter to search)"
            onApply={(v) => void applySearch(v)}
            onClear={() => setSearch("")}
            onForget={(v) => void forgetSearch(v)}
            onClearHistory={() => void forgetSearch(null)}
          >
            <label className="check-row s3-recursive" title="List every file below this folder, as one flat list">
              <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} /> Include subfolders
            </label>
          </FilterBox>
          <ObjectFilterBar filter={objFilter} onChange={setObjFilter} classes={pageClasses} />
          <FileList
            key={`${toS3Uri(loc)}|${recursive ? "flat" : ""}`}
            columns={recursive ? FLAT_COLUMNS : OBJECT_COLUMNS}
            rows={objectRows}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={(key) => {
              // Folders open; files preview.
              if (key.endsWith("/")) go({ bucket: loc.bucket, prefix: key });
              else openPreview(key);
            }}
            onContextMenu={openContextMenu}
            onOrderChange={onOrderChange}
            emptyText={emptyObjectsText()}
          />
          <PageBar
            page={page}
            hasNext={listingCurrent && folder.hasNext}
            lastPage={listingCurrent ? folder.lastPage : null}
            pageSize={pageSize}
            rows={listingCurrent ? folder.folders.length + folder.files.length : 0}
            loading={!listingCurrent || folder.loading}
            onPage={goPage}
            onPageSize={setPageSize}
          />
        </div>
      );
    }
  }

  let status = "";
  if (active) {
    if (loc.bucket === null) {
      status = buckets
        ? `${buckets.length} bucket${buckets.length === 1 ? "" : "s"}${selected.size ? ` · ${selected.size} selected` : ""}`
        : "";
    } else if (!listingCurrent) {
      status = "Loading…";
    } else {
      const n = folder.folders.length + folder.files.length;
      const paged = page > 0 || folder.hasNext;
      const parts = [
        paged
          ? `Items ${(page * pageSize + 1).toLocaleString()}–${(page * pageSize + n).toLocaleString()} (page ${page + 1}${folder.lastPage !== null ? ` of ${folder.lastPage + 1}` : ""})`
          : `${n.toLocaleString()} item${n === 1 ? "" : "s"}`,
      ];
      if (search || recursive)
        parts[0] += ` ${search ? `starting with "${search}"` : ""}${recursive ? " (including subfolders)" : ""}`.replace("  ", " ");
      if (folder.loading) parts[0] += " (loading…)";
      if (filtering) {
        const m = shown.folders.length + shown.files.length;
        parts.push(`${m.toLocaleString()} item${m === 1 ? " matches" : "s match"} the filters`);
      }
      if (selected.size) {
        const bytes = folder.files.filter((f) => selected.has(f.key)).reduce((t, f) => t + f.size, 0);
        parts.push(`${selected.size.toLocaleString()} selected${bytes ? ` (${formatSize(bytes)})` : ""}`);
      }
      status = parts.join(" · ");
      if (clipboard && selected.size === 0)
        status += ` · ${clipboard.keys.length} item${clipboard.keys.length === 1 ? "" : "s"} ${clipboard.mode === "cut" ? "cut" : "copied"} (Ctrl+V to paste)`;
    }
  }
  if (dropTarget) status = `Drop to upload to ${toS3Uri(dropTarget)}`;

  const inBucket = active && loc.bucket !== null && !!connection;
  const canWrite = inBucket && !readOnly;
  const commands = active ? (
    <>
      <CommandButton icon={<UploadIcon />} label="Upload files" title="Upload files into this folder" disabled={!canWrite} onClick={() => void uploadFilesTo(loc)} />
      <CommandButton icon={<UploadIcon />} label="Upload folder" title="Upload a folder into this folder" disabled={!canWrite} onClick={() => void uploadFolderTo(loc)} />
      <CommandButton icon={<DownloadIcon />} label="Download" title="Download the selected items" disabled={!inBucket || selected.size === 0} onClick={() => void downloadItems([...selected])} />
      <CommandSeparator />
      <CommandButton icon={<NewFolderIcon />} label="New folder" title="New folder (Ctrl+Shift+N)" disabled={!canWrite} onClick={() => void newFolder()} />
      <CommandButton icon={<DeleteIcon />} label="Delete" title="Delete the selected items (Del)" disabled={!canWrite || selected.size === 0} onClick={() => void deleteItems([...selected])} />
      <CommandSeparator />
      <CommandButton icon={<SyncIcon />} label="Sync…" title="Sync a local folder with this S3 folder (with dry run)" disabled={!inBucket} onClick={() => setSyncTarget(loc)} />
    </>
  ) : null;

  const tree_ = connection ? (
    <FolderTree
      location={active ? loc : null}
      buckets={buckets}
      bucketsFailed={bucketsError !== null}
      tree={tree}
      expanded={serviceOpen}
      onToggleService={() => setServiceOpen((v) => !v)}
      onNavigate={go}
      onContextMenu={openTreeMenu}
    />
  ) : null;

  const dialogs = (
    <>
      {preview && active && loc.bucket !== null && (
        <PreviewDialog
          bucket={loc.bucket}
          keys={preview.keys}
          index={preview.index}
          onIndexChange={(index) => {
            setPreview({ ...preview, index });
            setSelected(new Set([preview.keys[index]]));
          }}
          onDownload={(k) => void downloadItems([k])}
          onClose={() => setPreview(null)}
        />
      )}
      {shareKey && connection && loc.bucket !== null && (
        <ShareDialog bucket={loc.bucket} objectKey={shareKey} connection={connection} onClose={() => setShareKey(null)} />
      )}
      {propsTarget && connection && (
        <PropertiesDialog bucket={propsTarget.bucket} itemKey={propsTarget.key} connection={connection} onClose={() => setPropsTarget(null)} />
      )}
      {propsKey && connection && loc.bucket !== null && (
        <PropertiesDialog bucket={loc.bucket} itemKey={propsKey} connection={connection} onClose={() => setPropsKey(null)} />
      )}
      {syncTarget && syncTarget.bucket !== null && (
        <SyncDialog
          bucket={syncTarget.bucket}
          prefix={syncTarget.prefix}
          readOnly={readOnly}
          onClose={() => setSyncTarget(null)}
          onRan={(result, summary) => {
            setSyncTarget(null);
            if (result.transferIds.length > 0) openTransfers();
            // Remote deletes don't go through transfers, so refresh here.
            if (summary.direction === "upload" && result.deleted > 0) reloadHere();
            if (result.deleteFailures.length > 0) {
              void ask(
                "Some files weren't deleted",
                <ul className="name-list">
                  {result.deleteFailures.slice(0, 10).map((f) => (
                    <li key={f.path}>
                      {f.path}: {f.message}
                    </li>
                  ))}
                  {result.deleteFailures.length > 10 && <li>…and {result.deleteFailures.length - 10} more</li>}
                </ul>,
                [{ label: "OK", value: "ok", primary: true }],
                "ok",
              );
            }
          }}
        />
      )}
    </>
  );

  return {
    tree: tree_,
    content,
    commands,
    status,
    busy: busy || (active && listingCurrent && folder.loading),
    refresh,
    dialogs,
    onTransferFinished,
  };
}
