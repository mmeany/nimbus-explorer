// Export and import of bookmarks. Export writes the folders ticked in the
// manager (or everything); import previews the file, can put every bookmark
// on one profile, then merges: same-name folders merge, exact duplicates
// (profile + place + item) are skipped.
import { useMemo, useState } from "react";
import { api } from "../api/s3";
import { bookmarksApi, type Bookmark, type BookmarkFile } from "../api/bookmarks";
import { currentBookmarks, findBookmark, newId, saveBookmarks, sameTarget, useBookmarks } from "../state/bookmarks";
import { placeUri, SERVICES, type ServiceId } from "../shell/places";
import type { Shell } from "../shell/shell";
import { DialogHelp } from "./HelpDialog";

/** The part of the set to export: ticked folders ("s:<service>" / "f:<id>"), or all; optionally one profile. */
export function exportSubset(f: BookmarkFile, checked: Set<string>, profile: string | null): BookmarkFile {
  const all = checked.size === 0;
  const ids = new Set<string>();
  for (const b of f.bookmarks) {
    if (profile !== null && b.profile !== profile) continue;
    if (all || checked.has(`s:${b.service}`) || f.folders.some((d) => checked.has(`f:${d.id}`) && d.items.includes(b.id))) ids.add(b.id);
  }
  const services = new Set(f.bookmarks.filter((b) => ids.has(b.id)).map((b) => b.service));
  return {
    version: 1,
    bookmarks: f.bookmarks.filter((b) => ids.has(b.id)),
    folders: f.folders.filter((d) => all || checked.has(`f:${d.id}`)).map((d) => ({ ...d, items: d.items.filter((i) => ids.has(i)) })),
    pinned: f.pinned.filter((i) => ids.has(i)),
    featureNotes: Object.fromEntries(Object.entries(f.featureNotes).filter(([k]) => services.has(k as ServiceId))),
  };
}

export async function exportBookmarks(shell: Shell, checked: Set<string>, profile: string | null) {
  const subset = exportSubset(currentBookmarks(), checked, profile);
  if (subset.bookmarks.length === 0 && subset.folders.length === 0) {
    shell.showFlash("Nothing to export");
    return;
  }
  const dest = await api.pickSaveAs("Export bookmarks", profile ? `bookmarks-${profile}.json` : "bookmarks.json");
  if (!dest) return;
  try {
    const n = await bookmarksApi.export(subset, dest);
    shell.showFlash(`Exported ${n.toLocaleString()} bookmark${n === 1 ? "" : "s"} to ${dest}`);
  } catch (e) {
    shell.showError(e);
  }
}

/** Asks for a file and reads it; null when cancelled or unreadable (error shown). */
export async function pickImport(shell: Shell): Promise<{ path: string; file: BookmarkFile } | null> {
  const path = await api.pickOpenFile("Import bookmarks", "Bookmarks", ["json"]);
  if (!path) return null;
  try {
    return { path, file: await bookmarksApi.readImport(path) };
  } catch (e) {
    shell.showError(e);
    return null;
  }
}

type Status = "new" | "duplicate" | "missingProfile";

interface Plan {
  rows: { b: Bookmark; status: Status }[];
  merged: BookmarkFile;
  added: number;
  skipped: number;
  newFolders: number;
}

/** Works out the merge (pure, for the preview and the save). */
export function planImport(current: BookmarkFile, incoming: BookmarkFile, profiles: string[], asProfile: string | null): Plan {
  const idMap = new Map<string, string>();
  const rows: Plan["rows"] = [];
  const added: Bookmark[] = [];
  for (const raw of incoming.bookmarks) {
    const b = asProfile ? { ...raw, profile: asProfile } : raw;
    const existing = findBookmark(current, b.profile, b.place, b.select) ?? added.find((a) => sameTarget(a, b.profile, b.place, b.select)) ?? null;
    if (existing) {
      idMap.set(raw.id, existing.id);
      rows.push({ b, status: "duplicate" });
      continue;
    }
    const nb = { ...b, id: newId() };
    idMap.set(raw.id, nb.id);
    added.push(nb);
    rows.push({ b, status: profiles.includes(b.profile) ? "new" : "missingProfile" });
  }
  const mapIds = (ids: string[]) => ids.map((i) => idMap.get(i)).filter((i): i is string => !!i);
  let folders = [...current.folders];
  let newFolders = 0;
  for (const inc of incoming.folders) {
    const match = folders.find((d) => d.name.toLowerCase() === inc.name.toLowerCase());
    const items = mapIds(inc.items);
    if (match) {
      folders = folders.map((d) =>
        d.id === match.id ? { ...d, description: d.description || inc.description, items: [...d.items, ...items.filter((i) => !d.items.includes(i))] } : d,
      );
    } else {
      folders.push({ id: newId(), name: inc.name, description: inc.description, items: [...new Set(items)] });
      newFolders++;
    }
  }
  const pinned = [...current.pinned, ...mapIds(incoming.pinned).filter((i) => !current.pinned.includes(i))];
  const featureNotes = { ...current.featureNotes };
  for (const [k, v] of Object.entries(incoming.featureNotes)) {
    const key = k as ServiceId;
    if (v && !featureNotes[key]) featureNotes[key] = v;
  }
  return {
    rows,
    merged: { ...current, bookmarks: [...current.bookmarks, ...added], folders, pinned: [...new Set(pinned)], featureNotes },
    added: added.length,
    skipped: rows.length - added.length,
    newFolders,
  };
}

const STATUS_TEXT: Record<Status, string> = { new: "New", duplicate: "Duplicate (skipped)", missingProfile: "Profile not found" };
const serviceName = (id: string) => SERVICES.find((s) => s.id === id)?.name ?? id;

export function BookmarkImportDialog({
  shell,
  path,
  incoming,
  profiles,
  onClose,
}: {
  shell: Shell;
  path: string;
  incoming: BookmarkFile;
  profiles: string[];
  onClose: () => void;
}) {
  const current = useBookmarks();
  const [mode, setMode] = useState<"keep" | "one">("keep");
  const [asProfile, setAsProfile] = useState(shell.connection?.profile ?? profiles[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = useMemo(() => planImport(current, incoming, profiles, mode === "one" ? asProfile : null), [current, incoming, profiles, mode, asProfile]);
  const fileName = path.replace(/^.*[\\/]/, "");
  const missingCount = plan.rows.filter((r) => r.status === "missingProfile").length;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await saveBookmarks(plan.merged, `import|${plan.added}|${plan.skipped}|${fileName}`);
      shell.showFlash(`Imported ${plan.added} bookmark${plan.added === 1 ? "" : "s"}${plan.skipped ? `, skipped ${plan.skipped} duplicate${plan.skipped === 1 ? "" : "s"}` : ""}`);
      onClose();
    } catch (e) {
      setError((e as { message?: string }).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog activity-dialog" role="dialog" aria-modal aria-labelledby="bmi-title" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title" id="bmi-title">
          Import bookmarks · <span className="mono">{fileName}</span>
          <DialogHelp topic="bookmarks.import" />
        </div>
        <div className="dialog-body">
          <div className="row">
            <label className="check">
              <input type="radio" name="bmi-mode" checked={mode === "keep"} onChange={() => setMode("keep")} /> Keep the profiles in the file
            </label>
            <label className="check">
              <input type="radio" name="bmi-mode" checked={mode === "one"} onChange={() => setMode("one")} /> Put every bookmark on profile
            </label>
            <select className="select" value={asProfile} disabled={mode !== "one"} onChange={(e) => setAsProfile(e.target.value)} aria-label="Profile for every bookmark">
              {profiles.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="hint">
            {plan.added} new, {plan.skipped} duplicate{plan.skipped === 1 ? "" : "s"} skipped
            {missingCount ? `, ${missingCount} for a profile that isn't in your AWS config` : ""} · {incoming.folders.length} folder
            {incoming.folders.length === 1 ? "" : "s"} in the file ({plan.newFolders} new, the rest merge by name)
          </div>
          <div className="sync-table-wrap activity-table-wrap">
            <table className="sync-table activity-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Name</th>
                  <th>Profile</th>
                  <th>Service</th>
                  <th>Location</th>
                  <th>Region</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map(({ b, status }, i) => (
                  <tr key={i}>
                    <td className={status === "missingProfile" ? "danger-text" : status === "duplicate" ? "muted" : ""}>{STATUS_TEXT[status]}</td>
                    <td>{b.name}</td>
                    <td>{b.profile}</td>
                    <td>{serviceName(b.service)}</td>
                    <td className="mono">
                      {placeUri(b.place)}
                      {b.select ? ` › ${b.select}` : ""}
                    </td>
                    <td>{b.region}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" disabled={busy || (plan.added === 0 && plan.newFolders === 0)} onClick={() => void run()}>
            Import {plan.added} bookmark{plan.added === 1 ? "" : "s"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
