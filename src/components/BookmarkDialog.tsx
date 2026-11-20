// Add or edit one bookmark: name, description, pinned, and which of the
// user's folders it's in. It's always in its service's feature folder.
import { useState } from "react";
import { BOOKMARK_LIMITS, type Bookmark } from "../api/bookmarks";
import { newId, folderNameProblem, saveBookmarks, useBookmarks, withoutBookmark } from "../state/bookmarks";
import { placeUri, SERVICES, type Place, type ServiceId } from "../shell/places";
import type { Shell } from "../shell/shell";
import { DialogHelp } from "./HelpDialog";

export interface BookmarkDraft {
  profile: string;
  region: string;
  service: ServiceId;
  place: Place;
  select: string | null;
  name: string;
}

interface Props {
  shell: Shell;
  /** What a new bookmark would hold (used when `existing` is null). */
  draft: BookmarkDraft;
  existing: Bookmark | null;
  /** Folder to tick for a new bookmark (e.g. it was dropped on one). */
  initialFolder?: string | null;
  onClose: () => void;
}

export function BookmarkDialog({ shell, draft, existing, initialFolder, onClose }: Props) {
  const file = useBookmarks();
  const [name, setName] = useState(existing?.name ?? draft.name);
  const [description, setDescription] = useState(existing?.description ?? "");
  const [pinned, setPinned] = useState(existing ? file.pinned.includes(existing.id) : false);
  const [inFolders, setInFolders] = useState<Set<string>>(
    () => new Set(existing ? file.folders.filter((f) => f.items.includes(existing.id)).map((f) => f.id) : initialFolder ? [initialFolder] : []),
  );
  /** Folders created in this dialog (saved with the bookmark). */
  const [newFolders, setNewFolders] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = existing ?? { ...draft, select: draft.select };
  const service = SERVICES.find((s) => s.id === target.service);
  const nameProblem = !name.trim() ? "Enter a name" : name.trim().length > BOOKMARK_LIMITS.name ? `At most ${BOOKMARK_LIMITS.name} characters` : null;
  const descProblem = description.trim().length > BOOKMARK_LIMITS.description ? `At most ${BOOKMARK_LIMITS.description} characters` : null;
  const allFolders = [...file.folders.map((f) => ({ id: f.id, name: f.name })), ...newFolders];

  async function addFolder() {
    const n = await shell.askName("New folder", "Folder name", "", "Create", (v) => {
      const p = folderNameProblem(file, v, null);
      if (p) return p;
      return newFolders.some((f) => f.name.toLowerCase() === v.trim().toLowerCase()) ? "There's already a folder with that name" : null;
    });
    if (!n) return;
    if (file.folders.length + newFolders.length >= BOOKMARK_LIMITS.folders) {
      setError(`At most ${BOOKMARK_LIMITS.folders} folders`);
      return;
    }
    const id = newId();
    setNewFolders((l) => [...l, { id, name: n.trim() }]);
    setInFolders((s) => new Set([...s, id]));
  }

  async function save() {
    if (nameProblem || descProblem) return;
    setBusy(true);
    setError(null);
    const id = existing?.id ?? newId();
    const bookmark: Bookmark = existing
      ? { ...existing, name: name.trim(), description: description.trim() }
      : {
          id,
          profile: draft.profile,
          region: draft.region,
          service: draft.service,
          place: draft.place,
          select: draft.select,
          name: name.trim(),
          description: description.trim(),
          created: new Date().toISOString(),
        };
    const folders = [
      ...file.folders,
      ...newFolders.map((f) => ({ id: f.id, name: f.name, description: "", items: [] as string[] })),
    ].map((f) => {
      const has = f.items.includes(id);
      if (inFolders.has(f.id) && !has) return { ...f, items: [...f.items, id] };
      if (!inFolders.has(f.id) && has) return { ...f, items: f.items.filter((i) => i !== id) };
      return f;
    });
    const pinnedList = pinned ? (file.pinned.includes(id) ? file.pinned : [...file.pinned, id]) : file.pinned.filter((p) => p !== id);
    const bookmarks = existing ? file.bookmarks.map((b) => (b.id === id ? bookmark : b)) : [...file.bookmarks, bookmark];
    try {
      await saveBookmarks({ ...file, bookmarks, folders, pinned: pinnedList });
      shell.showFlash(existing ? `Bookmark "${bookmark.name}" saved` : `Bookmarked "${bookmark.name}"`);
      onClose();
    } catch (e) {
      setError((e as { message?: string }).message ?? String(e));
      setBusy(false);
    }
  }

  async function remove() {
    if (!existing) return;
    setBusy(true);
    try {
      await saveBookmarks(withoutBookmark(file, existing.id));
      shell.showFlash(`Bookmark "${existing.name}" deleted`);
      onClose();
    } catch (e) {
      setError((e as { message?: string }).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog bookmark-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="bm-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type === "text") void save();
        }}
      >
        <div className="dialog-title" id="bm-title">
          {existing ? "Edit bookmark" : "Add bookmark"}
          <DialogHelp topic="bookmarks.edit" />
        </div>
        <div className="dialog-body">
          <div className="bm-where">
            <div>
              <span className="muted">Location: </span>
              <span className="mono">
                {service?.name ?? target.service}
                {placeUri(target.place) ? ` › ${placeUri(target.place)}` : ""}
              </span>
            </div>
            {target.select && (
              <div>
                <span className="muted">Selects: </span>
                <span className="mono">{target.select}</span>
              </div>
            )}
            <div>
              <span className="muted">Profile: </span>
              {target.profile}
              {target.region && (
                <>
                  <span className="muted"> · Region: </span>
                  {target.region}
                </>
              )}
            </div>
          </div>
          <label className="form-label" htmlFor="bm-name">
            Name
          </label>
          <input id="bm-name" type="text" className="text-input" autoFocus maxLength={BOOKMARK_LIMITS.name + 20} value={name} onChange={(e) => setName(e.target.value)} />
          {nameProblem && <div className="field-error">{nameProblem}</div>}
          <label className="form-label" htmlFor="bm-desc">
            Description (optional)
          </label>
          <input id="bm-desc" type="text" className="text-input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Shown under the name and as its tooltip" />
          {descProblem && <div className="field-error">{descProblem}</div>}
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin to the bookmarks bar
            </label>
          </div>
          <div className="form-label">Folders</div>
          <div className="bm-folders">
            <label className="check muted" title="Every bookmark is in its service's folder">
              <input type="checkbox" checked disabled /> {service?.name ?? target.service} (always)
            </label>
            {allFolders.map((f) => (
              <label key={f.id} className="check">
                <input
                  type="checkbox"
                  checked={inFolders.has(f.id)}
                  onChange={(e) =>
                    setInFolders((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(f.id);
                      else n.delete(f.id);
                      return n;
                    })
                  }
                />{" "}
                {f.name}
              </label>
            ))}
          </div>
          <div className="row">
            <button className="btn" onClick={() => void addFolder()}>
              New folder…
            </button>
          </div>
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          {existing && (
            <button className="btn danger" disabled={busy} onClick={() => void remove()}>
              Delete
            </button>
          )}
          <div className="spacer" />
          <button className="btn primary" disabled={busy || !!nameProblem || !!descProblem} onClick={() => void save()}>
            {existing ? "Save" : "Add bookmark"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
