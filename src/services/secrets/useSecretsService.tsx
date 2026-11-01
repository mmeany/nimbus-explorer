// Secrets Manager controller: "/" in names as folders, name-prefix filter
// with history, secret details with masked value.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type AppError } from "../../api/s3";
import { childrenOf, segment, smApi, type SecretInfo } from "../../api/secrets";
import { CommandButton, CommandSeparator } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { PageBar } from "../../components/PageBar";
import { usePaging } from "../../state/paged";
import { FilterBox } from "../../components/FilterBox";
import { DeleteIcon, EditIcon, FolderIcon, HistoryIcon, NewItemIcon, RefreshIcon, SecretKeyIcon, SecretsIcon } from "../../components/Icons";
import { TreeNote, TreeRow } from "../../components/TreeRow";
import { formatDate } from "../../format";
import type { ServiceUi, Shell } from "../../shell/shell";
import { DeleteSecretDialog } from "./DeleteSecretDialog";
import { SecretDetailsDialog } from "./SecretDetailsDialog";
import { SecretEditorDialog } from "./SecretEditorDialog";
import { SecretVersionsDialog } from "./SecretVersionsDialog";
import { RotationDialog } from "./RotationDialog";
import { SecretSettingsDialog } from "./SecretSettingsDialog";

const COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 240 },
  { id: "description", label: "Description", width: 220 },
  { id: "changed", label: "Last changed", width: 160 },
  { id: "accessed", label: "Last retrieved", width: 120 },
  { id: "rotation", label: "Rotation", width: 130 },
  { id: "deletion", label: "Scheduled deletion", width: 150 },
];
const FILTER_COLUMNS: Column[] = [COLUMNS[0], { id: "path", label: "Folder", width: 180 }, ...COLUMNS.slice(1)];

/** Folders on the way to a path ("a/b/" → ["", "a/", "a/b/"]). */
function ancestors(path: string): string[] {
  const out = [""];
  let acc = "";
  for (const seg of path.split("/").slice(0, -1)) {
    acc += seg + "/";
    out.push(acc);
  }
  return out;
}

function folderOf(name: string): string {
  const i = name.lastIndexOf("/");
  return i < 0 ? "" : name.slice(0, i + 1);
}

export function useSecretsService(shell: Shell): ServiceUi {
  const { connection, connectionId, profile, place, readOnly } = shell;
  const active = place.service === "secrets";
  const path = place.service === "secrets" ? place.path : "";
  const region = connection?.serviceRegion ?? "";
  const scope = `${connectionId}|${region}`;
  const historyKey = `secrets|${profile ?? ""}|${region}`;
  const go = useCallback((p: string) => shell.navigate({ service: "secrets", path: p }), [shell]);

  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [listing, setListing] = useState<{ key: string; secrets: SecretInfo[] | null; error: AppError | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<SecretInfo | null>(null);
  const [editor, setEditor] = useState<{ secret: SecretInfo | null; folder: string } | null>(null);
  const [deleting, setDeleting] = useState<SecretInfo | null>(null);
  const [versionsOf, setVersionsOf] = useState<SecretInfo | null>(null);
  const [rotationOf, setRotationOf] = useState<SecretInfo | null>(null);
  const [settingsOf, setSettingsOf] = useState<{ secret: SecretInfo; tab: "tags" | "policy" } | null>(null);

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
    if (!active) return;
    setOpen(true);
    setExpanded((s) => new Set([...s, ...ancestors(path)]));
  }, [active, path]);

  // All secrets are listed once (ListSecrets is cheap and folders are derived).
  const listKey = `${scope}|${reloadToken}`;
  useEffect(() => {
    if (!connection || !(open || active) || listing?.key === listKey) return;
    let stale = false;
    setLoading(true);
    smApi
      .list("")
      .then((secrets) => !stale && setListing({ key: listKey, secrets, error: null }))
      .catch((e) => !stale && setListing({ key: listKey, secrets: null, error: e as AppError }))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
      // A load cut short (deps changed after it finished) mustn't leave the busy flag on.
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, open, active, listKey]);

  const all = listing?.secrets ?? null;
  const byName = useMemo(() => new Map((all ?? []).map((s) => [s.name, s])), [all]);
  const names = useMemo(() => (all ?? []).map((s) => s.name), [all]);
  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);
  useEffect(() => setSelected(new Set()), [path, filter]);

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
  // Create / edit / delete / restore

  const denied = () => shell.showFlash("Read-only mode: changes are disabled.");
  const newFolder = filter ? folderOf(filter) : path;

  function newSecret(folder = newFolder) {
    if (readOnly) return denied();
    setEditor({ secret: null, folder });
  }

  function editSecret(s: SecretInfo) {
    if (readOnly) return denied();
    if (s.deletedDate) return shell.showFlash("Restore the secret before editing it.");
    setDetails(null);
    setEditor({ secret: s, folder: folderOf(s.name) });
  }

  function deleteSecret(s: SecretInfo) {
    if (readOnly) return denied();
    if (s.deletedDate) return shell.showFlash("Already scheduled for deletion.");
    setDetails(null);
    setDeleting(s);
  }

  async function restoreSecret(s: SecretInfo) {
    if (readOnly) return denied();
    try {
      await smApi.restore(s.arn ?? s.name);
      shell.showFlash(`Restored ${s.name}.`);
      refresh();
    } catch (e) {
      shell.showError(e);
    }
  }

  const opsRef = useRef({ active, selected, byName, modal: !!(details || editor || deleting || versionsOf || rotationOf || settingsOf), newSecret, deleteSecret, editSecret });
  opsRef.current = { active, selected, byName, modal: !!(details || editor || deleting || versionsOf || rotationOf || settingsOf), newSecret, deleteSecret, editSecret };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const o = opsRef.current;
      if (!o.active || o.modal || (e.target as HTMLElement).closest("input, textarea, select, .modal-backdrop")) return;
      const s = o.selected.size === 1 ? o.byName.get([...o.selected][0]) : undefined;
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === "Delete" && s) {
        e.preventDefault();
        o.deleteSecret(s);
      } else if (ctrl && e.shiftKey && (e.key === "N" || e.key === "n")) {
        e.preventDefault();
        o.newSecret();
      } else if (ctrl && !e.shiftKey && e.key === "e" && s) {
        e.preventDefault();
        o.editSecret(s);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------------------------------------------------------------------------
  // List

  const filtered = useMemo(() => (filter ? names.filter((n) => n.startsWith(filter)) : null), [names, filter]);
  const view = useMemo(() => (filtered ? { folders: [], secrets: filtered } : childrenOf(path, names)), [filtered, path, names]);

  // Every secret is listed (100 per call, no per-row calls); the list is paged on screen.
  const total = view.folders.length + view.secrets.length;
  const paging = usePaging(`${scope}|${filter ? `f:${filter}` : `p:${path}`}`, total, "secrets.pageSize", active);
  const pageFolders = useMemo(() => paging.slice(view.folders), [paging, view]);
  const pageSecrets = useMemo(() => {
    const start = Math.max(0, paging.page * paging.pageSize - view.folders.length);
    return view.secrets.slice(start, start + paging.pageSize - pageFolders.length);
  }, [paging, view, pageFolders]);
  const rows: Row[] = useMemo(() => {
    const out: Row[] = pageFolders.map((f) => ({
      key: f,
      icon: <FolderIcon />,
      isContainer: true,
      cells: { name: { text: segment(f), sort: segment(f) } },
    }));
    for (const n of pageSecrets) {
      const s = byName.get(n)!;
      const label = filter ? n : segment(n);
      const rotation = s.rotationEnabled ? `On${s.rotationSchedule ? ` (${s.rotationSchedule})` : ""}` : "Off";
      out.push({
        key: n,
        icon: <SecretKeyIcon />,
        isContainer: false,
        dimmed: !!s.deletedDate,
        cells: {
          name: { text: label, sort: label },
          path: { text: folderOf(n), sort: n },
          description: { text: s.description ?? "", sort: s.description ?? "" },
          changed: { text: formatDate(s.lastChanged), sort: s.lastChanged ?? "" },
          accessed: { text: s.lastAccessed ? new Date(s.lastAccessed).toLocaleDateString() : "", sort: s.lastAccessed ?? "" },
          rotation: { text: rotation, sort: rotation },
          deletion: { text: s.deletedDate ? formatDate(s.deletedDate) : "", sort: s.deletedDate ?? "" },
        },
      });
    }
    return out;
  }, [pageFolders, pageSecrets, byName, filter]);

  function openContextMenu(key: string | null, x: number, y: number) {
    const items: MenuItem[] = [];
    const s = key ? byName.get(key) : undefined;
    if (key && !s) {
      items.push(
        { label: "Open", bold: true, onClick: () => go(key) },
        { label: "Filter by this folder", onClick: () => void applyFilter(key) },
        { label: "New secret here…", disabled: readOnly, onClick: () => newSecret(key) },
        "separator",
      );
    } else if (s) {
      items.push(
        { label: "View details", bold: true, shortcut: "Enter", onClick: () => setDetails(s) },
        ...(s.deletedDate
          ? [{ label: "Restore", disabled: readOnly, onClick: () => void restoreSecret(s) } as MenuItem]
          : [
              { label: "Edit…", disabled: readOnly, onClick: () => editSecret(s) } as MenuItem,
              { label: "Versions and labels…", onClick: () => setVersionsOf(s) } as MenuItem,
              { label: "Rotation…", onClick: () => setRotationOf(s) } as MenuItem,
              { label: "Tags…", onClick: () => setSettingsOf({ secret: s, tab: "tags" }) } as MenuItem,
              { label: "Resource policy…", onClick: () => setSettingsOf({ secret: s, tab: "policy" }) } as MenuItem,
              { label: "Delete…", shortcut: "Del", disabled: readOnly, onClick: () => deleteSecret(s) } as MenuItem,
            ]),
        {
          label: "Copy value",
          disabled: !!s.deletedDate,
          onClick: async () => {
            try {
              const v = await smApi.getValue(s.arn ?? s.name);
              await navigator.clipboard.writeText(v.text ?? v.binaryBase64 ?? "");
              shell.showFlash("Secret value copied to the clipboard.");
            } catch (e) {
              shell.showError(e);
            }
          },
        },
        "separator",
        { label: "Copy name", onClick: () => void shell.copyText(s.name) },
        ...(s.arn ? [{ label: "Copy ARN", onClick: () => void shell.copyText(s.arn!) } as MenuItem] : []),
        ...(filter ? [{ label: "Open containing folder", onClick: () => (setFilter(""), go(folderOf(s.name))) } as MenuItem] : []),
        "separator",
      );
    }
    if (!key) items.push({ label: "New secret…", disabled: readOnly, onClick: () => newSecret() }, "separator");
    items.push({ label: "Refresh", shortcut: "F5", onClick: refresh });
    shell.openMenu(x, y, items);
  }

  // ---------------------------------------------------------------------------
  // Tree

  const filterFolders = useMemo(() => {
    if (!filtered) return null;
    const set = new Set<string>([""]);
    for (const n of filtered) for (const a of ancestors(folderOf(n))) set.add(a);
    return set;
  }, [filtered]);

  function treeFolders(p: string): string[] {
    const kids = childrenOf(p, names).folders;
    return filterFolders ? kids.filter((k) => filterFolders.has(k)) : kids;
  }

  function renderFolder(p: string, depth: number): ReactNode {
    const kids = treeFolders(p);
    const isOpen = filterFolders ? true : expanded.has(p);
    return (
      <TreeRow
        key={p}
        depth={depth}
        label={segment(p)}
        icon={<FolderIcon open={isOpen && kids.length > 0} />}
        selected={active && !filter && path === p}
        expanded={kids.length ? isOpen : undefined}
        title={p}
        onClick={() => {
          setFilter("");
          go(p);
        }}
        onToggle={() =>
          setExpanded((s) => {
            const n = new Set(s);
            if (n.has(p)) n.delete(p);
            else n.add(p);
            return n;
          })
        }
        onContextMenu={(x, y) => openContextMenu(p, x, y)}
      >
        {kids.map((k) => renderFolder(k, depth + 1))}
      </TreeRow>
    );
  }

  const rootKids = all ? treeFolders("") : null;
  const tree = connection ? (
    <TreeRow
      depth={1}
      label={filter ? "Secrets Manager (filtered)" : "Secrets Manager"}
      icon={<SecretsIcon />}
      selected={active && !path && !filter}
      expanded={open}
      title={`Secrets Manager · ${region}`}
      onClick={() => {
        setFilter("");
        go("");
      }}
      onToggle={() => setOpen((v) => !v)}
    >
      {listing?.error ? (
        <TreeNote depth={2}>Couldn't list secrets</TreeNote>
      ) : rootKids === null ? (
        <TreeNote depth={2}>Loading…</TreeNote>
      ) : rootKids.length === 0 ? (
        <TreeNote depth={2}>{all!.length ? "No folders" : "No secrets"}</TreeNote>
      ) : (
        rootKids.map((k) => renderFolder(k, 2))
      )}
    </TreeRow>
  ) : null;

  // ---------------------------------------------------------------------------
  // Content

  let content: ReactNode = null;
  let status = "";
  if (active) {
    content = (
      <div className="service-pane">
        <FilterBox
          label="Filter:"
          applied={filter}
          history={history}
          placeholder="Secret name prefix, e.g. prod/ (Enter to apply)"
          onApply={(v) => void applyFilter(v)}
          onClear={() => setFilter("")}
          onForget={(v) => void forget(v)}
          onClearHistory={() => void forget(null)}
        />
        {listing?.error ? (
          <ErrorPanel error={listing.error} profile={profile} onRetry={refresh} />
        ) : (
          <FileList
            key={filter ? `f:${filter}` : `p:${path}`}
            columns={filter ? FILTER_COLUMNS : COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={(k) => {
              const s = byName.get(k);
              if (s) setDetails(s);
              else go(k);
            }}
            onContextMenu={openContextMenu}
            emptyText={!all ? "Loading…" : filter ? `No secrets begin with "${filter}".` : "No secrets here."}
          />
        )}
        {!listing?.error && total > paging.pageSize && <PageBar {...paging.bar} loading={false} />}
      </div>
    );
    if (all) {
      status = filter
        ? `${view.secrets.length} secret${view.secrets.length === 1 ? "" : "s"} beginning with "${filter}"`
        : `${view.folders.length} folder${view.folders.length === 1 ? "" : "s"}, ${view.secrets.length} secret${view.secrets.length === 1 ? "" : "s"}`;
      const scheduled = view.secrets.filter((n) => byName.get(n)?.deletedDate).length;
      if (scheduled) status += ` · ${scheduled} scheduled for deletion`;
      status += ` · ${region}`;
    }
  }

  const sel = selected.size === 1 ? byName.get([...selected][0]) : undefined;
  const commands = active ? (
    <>
      <CommandButton icon={<NewItemIcon />} label="New" title="New secret" disabled={readOnly || !connection} onClick={() => newSecret()} />
      <CommandButton icon={<EditIcon />} label="Edit" title="Edit the selected secret" disabled={readOnly || !sel || !!sel.deletedDate} onClick={() => sel && editSecret(sel)} />
      <CommandButton icon={<HistoryIcon />} label="Versions" title="Versions and staging labels" disabled={!sel || !!sel.deletedDate} onClick={() => sel && setVersionsOf(sel)} />
      <CommandButton icon={<DeleteIcon />} label="Delete" title="Delete the selected secret" disabled={readOnly || !sel || !!sel.deletedDate} onClick={() => sel && deleteSecret(sel)} />
      {sel?.deletedDate && <CommandButton icon={<RefreshIcon />} label="Restore" title="Cancel the scheduled deletion" disabled={readOnly} onClick={() => void restoreSecret(sel)} />}
      <CommandSeparator />
      <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} />
    </>
  ) : null;

  const dialogs = (
    <>
      {details && (
        <SecretDetailsDialog
          key={details.name}
          secret={details}
          shell={shell}
          onClose={() => setDetails(null)}
          actions={
            details.deletedDate ? (
              <button className="btn" disabled={readOnly} onClick={() => (setDetails(null), void restoreSecret(details))}>
                Restore
              </button>
            ) : (
              <>
                <button className="btn" disabled={readOnly} onClick={() => editSecret(details)}>
                  Edit…
                </button>
                <button className="btn" onClick={() => (setDetails(null), setVersionsOf(details))}>
                  Versions…
                </button>
                <button className="btn" onClick={() => (setDetails(null), setRotationOf(details))}>
                  Rotation…
                </button>
                <button className="btn" onClick={() => (setDetails(null), setSettingsOf({ secret: details, tab: "tags" }))}>
                  Tags and policy…
                </button>
                <button className="btn" disabled={readOnly} onClick={() => deleteSecret(details)}>
                  Delete…
                </button>
              </>
            )
          }
        />
      )}
      {editor && (
        <SecretEditorDialog
          secret={editor.secret}
          folder={editor.folder}
          shell={shell}
          onClose={() => setEditor(null)}
          onSaved={(name) => {
            setEditor(null);
            shell.showFlash(editor.secret ? `Saved ${name}.` : `Created ${name}.`);
            refresh();
          }}
        />
      )}
      {settingsOf && (
        <SecretSettingsDialog secret={settingsOf.secret} initialTab={settingsOf.tab} shell={shell} onClose={() => setSettingsOf(null)} onChanged={refresh} />
      )}
      {rotationOf && <RotationDialog secret={rotationOf} shell={shell} onClose={() => setRotationOf(null)} onChanged={refresh} />}
      {versionsOf && <SecretVersionsDialog secret={versionsOf} shell={shell} onClose={() => setVersionsOf(null)} onChanged={refresh} />}
      {deleting && (
        <DeleteSecretDialog
          secret={deleting}
          shell={shell}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            refresh();
          }}
        />
      )}
    </>
  );

  return { tree, content, commands, status, busy: active && loading, refresh, dialogs };
}
