// Manage bookmarks: every profile's bookmarks, by folder. Feature folders are
// automatic (one per service, sorted by name); your folders keep your order.
import { useMemo, useState, type ReactNode } from "react";
import { BOOKMARK_LIMITS, type Bookmark, type BookmarkFile } from "../api/bookmarks";
import {
  byName,
  featureItems,
  featureServices,
  folderItems,
  folderNameProblem,
  newId,
  saveBookmarks,
  updateBookmarks,
  useBookmarks,
  withoutBookmark,
} from "../state/bookmarks";
import { placeUri, SERVICES, type ServiceId } from "../shell/places";
import type { Shell } from "../shell/shell";
import { DialogHelp } from "./HelpDialog";
import { FolderIcon } from "./Icons";

/** "s:<service>" for a feature folder, "f:<id>" for yours. */
type FolderKey = string;

interface Props {
  shell: Shell;
  /** Profiles in the AWS config (others are shown as missing). */
  profiles: string[];
  icons: Record<ServiceId, ReactNode>;
  onOpen: (b: Bookmark) => void;
  onEdit: (b: Bookmark) => void;
  /** Export / import buttons (12.5); rendered in the button row. */
  transferButtons?: (ctx: { checked: Set<FolderKey>; profile: string | null }) => ReactNode;
  onClose: () => void;
}

const serviceName = (id: string) => SERVICES.find((s) => s.id === id)?.name ?? id;

export function BookmarkManager({ shell, profiles, icons, onOpen, onEdit, transferButtons, onClose }: Props) {
  const file = useBookmarks();
  const [profile, setProfile] = useState<string | null>(shell.connection?.profile ?? null);
  const [folderKey, setFolderKey] = useState<FolderKey | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<FolderKey>>(new Set());
  const [folderEdit, setFolderEdit] = useState<{ key: FolderKey | null } | null>(null);

  const bookmarkProfiles = useMemo(() => [...new Set(file.bookmarks.map((b) => b.profile))].sort((a, b) => a.localeCompare(b)), [file]);
  const profileOptions = useMemo(() => [...new Set([...profiles, ...bookmarkProfiles])].sort((a, b) => a.localeCompare(b)), [profiles, bookmarkProfiles]);
  const missing = (p: string) => !profiles.includes(p);

  const features = featureServices(file, profile);
  const current: FolderKey = folderKey ?? (features[0] ? `s:${features[0]}` : file.folders[0] ? `f:${file.folders[0].id}` : "");
  const userFolder = current.startsWith("f:") ? (file.folders.find((f) => f.id === current.slice(2)) ?? null) : null;
  const featureId = current.startsWith("s:") ? (current.slice(2) as ServiceId) : null;
  const list: Bookmark[] = userFolder ? folderItems(file, userFolder, profile) : featureId ? featureItems(file, featureId, profile) : [];
  const sel = list.find((b) => b.id === selected) ?? null;
  const pinned = sel ? file.pinned.includes(sel.id) : false;

  async function apply(change: (f: BookmarkFile) => BookmarkFile, flash?: string) {
    try {
      await updateBookmarks(change);
      if (flash) shell.showFlash(flash);
    } catch (e) {
      shell.showError(e);
    }
  }

  function moveBookmark(delta: number) {
    if (!userFolder || !sel) return;
    // Moves among the bookmarks shown (the profile filter may hide some).
    const shownIds = list.map((b) => b.id);
    const i = shownIds.indexOf(sel.id);
    const j = i + delta;
    if (j < 0 || j >= shownIds.length) return;
    const other = shownIds[j];
    void apply((f) => ({
      ...f,
      folders: f.folders.map((d) => {
        if (d.id !== userFolder.id) return d;
        const items = [...d.items];
        const a = items.indexOf(sel.id);
        const b = items.indexOf(other);
        [items[a], items[b]] = [items[b], items[a]];
        return { ...d, items };
      }),
    }));
  }

  function moveFolder(delta: number) {
    if (!userFolder) return;
    const i = file.folders.findIndex((f) => f.id === userFolder.id);
    const j = i + delta;
    if (j < 0 || j >= file.folders.length) return;
    void apply((f) => {
      const folders = [...f.folders];
      [folders[i], folders[j]] = [folders[j], folders[i]];
      return { ...f, folders };
    });
  }

  async function deleteBookmark(b: Bookmark) {
    const v = await shell.ask(
      "Delete bookmark",
      <p>
        Delete the bookmark <b>{b.name}</b> from every folder?
      </p>,
      [
        { label: "Delete", value: "yes", danger: true },
        { label: "Cancel", value: "no", primary: true },
      ],
      "no",
    );
    if (v === "yes") await apply((f) => withoutBookmark(f, b.id), `Bookmark "${b.name}" deleted`);
  }

  async function deleteFolder() {
    if (!userFolder) return;
    const v = await shell.ask(
      "Delete folder",
      <>
        <p>
          Delete the folder <b>{userFolder.name}</b>?
        </p>
        <p className="hint">Its {userFolder.items.length} bookmark(s) stay in their feature folders and any other folders.</p>
      </>,
      [
        { label: "Delete folder", value: "yes", danger: true },
        { label: "Cancel", value: "no", primary: true },
      ],
      "no",
    );
    if (v !== "yes") return;
    await apply((f) => ({ ...f, folders: f.folders.filter((d) => d.id !== userFolder.id) }), `Folder "${userFolder.name}" deleted`);
    setFolderKey(null);
  }

  const folderRow = (key: FolderKey, icon: ReactNode, name: string, count: number, title: string, dim = false) => (
    <div
      key={key}
      className={`bmm-folder ${current === key ? "selected" : ""} ${dim ? "dimmed" : ""}`}
      title={title || undefined}
      onClick={() => {
        setFolderKey(key);
        setSelected(null);
      }}
    >
      <input
        type="checkbox"
        aria-label={`Include ${name} in export`}
        title="Include in export"
        checked={checked.has(key)}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) =>
          setChecked((s) => {
            const n = new Set(s);
            if (e.target.checked) n.add(key);
            else n.delete(key);
            return n;
          })
        }
      />
      {icon}
      <span className="bmm-folder-name">{name}</span>
      <span className="muted">{count}</span>
    </div>
  );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog bookmark-manager"
        role="dialog"
        aria-modal
        aria-labelledby="bmm-title"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && !folderEdit && onClose()}
      >
        <div className="dialog-title" id="bmm-title">
          Manage bookmarks
          <DialogHelp topic="bookmarks.manager" />
        </div>
        <div className="dialog-body">
          <div className="row">
            <label className="field-label" htmlFor="bmm-profile">
              Profile:
            </label>
            <select
              id="bmm-profile"
              className="select"
              value={profile ?? ""}
              onChange={(e) => {
                setProfile(e.target.value || null);
                setSelected(null);
              }}
            >
              <option value="">All profiles</option>
              {profileOptions.map((p) => (
                <option key={p} value={p}>
                  {p}
                  {missing(p) ? " (missing)" : ""}
                </option>
              ))}
            </select>
            <span className="hint">
              {file.bookmarks.length.toLocaleString()} bookmark{file.bookmarks.length === 1 ? "" : "s"} in all · {file.folders.length} folder{file.folders.length === 1 ? "" : "s"} of yours
            </span>
          </div>
          <div className="bmm-panes">
            <div className="bmm-left">
              <div className="bmm-heading">Feature folders</div>
              {features.length === 0 && <div className="hint bmm-pad">None yet</div>}
              {features.map((s) => folderRow(`s:${s}`, icons[s], serviceName(s), featureItems(file, s, profile).length, file.featureNotes[s] ?? ""))}
              <div className="bmm-heading">Your folders</div>
              {file.folders.length === 0 && <div className="hint bmm-pad">None yet</div>}
              {file.folders.map((f) => {
                const n = folderItems(file, f, profile).length;
                return folderRow(`f:${f.id}`, <FolderIcon />, f.name, n, f.description, n === 0);
              })}
              <div className="bmm-left-buttons">
                <button className="btn" disabled={file.folders.length >= BOOKMARK_LIMITS.folders} onClick={() => setFolderEdit({ key: null })}>
                  New folder…
                </button>
                <button className="btn" disabled={!current} onClick={() => setFolderEdit({ key: current })}>
                  Edit folder…
                </button>
                <button className="btn" disabled={!userFolder} onClick={() => void deleteFolder()}>
                  Delete folder
                </button>
                <button className="btn" disabled={!userFolder || file.folders[0]?.id === userFolder.id} onClick={() => moveFolder(-1)} title="Earlier on the bar">
                  Move up
                </button>
                <button className="btn" disabled={!userFolder || file.folders[file.folders.length - 1]?.id === userFolder.id} onClick={() => moveFolder(1)} title="Later on the bar">
                  Move down
                </button>
              </div>
            </div>
            <div className="bmm-right">
              {(userFolder?.description || (featureId && file.featureNotes[featureId])) && (
                <div className="hint bmm-desc">{userFolder ? userFolder.description : file.featureNotes[featureId!]}</div>
              )}
              <div className="sync-table-wrap bmm-table-wrap">
                <table className="sync-table bmm-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      {profile === null && <th>Profile</th>}
                      <th>Location</th>
                      <th>Region</th>
                      <th>Description</th>
                      <th title="Pinned to the bar">Pin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.length === 0 && (
                      <tr>
                        <td colSpan={6} className="muted">
                          {current ? "No bookmarks here" + (profile ? ` for ${profile}` : "") : "No bookmarks yet. Press Ctrl+D anywhere to add one."}
                        </td>
                      </tr>
                    )}
                    {(userFolder ? list : [...list].sort(byName)).map((b) => (
                      <tr key={b.id} className={selected === b.id ? "selected" : ""} onClick={() => setSelected(b.id)} onDoubleClick={() => onOpen(b)}>
                        <td>
                          {icons[b.service]} {b.name}
                        </td>
                        {profile === null && (
                          <td className={missing(b.profile) ? "danger-text" : ""}>
                            {b.profile}
                            {missing(b.profile) ? " (missing)" : ""}
                          </td>
                        )}
                        <td className="mono">
                          {placeUri(b.place) || serviceName(b.service)}
                          {b.select ? ` › ${b.select}` : ""}
                        </td>
                        <td>{b.region}</td>
                        <td>{b.description}</td>
                        <td>{file.pinned.includes(b.id) ? "★" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row bmm-right-buttons">
                <button className="btn" disabled={!sel} onClick={() => sel && onOpen(sel)}>
                  Open
                </button>
                <button className="btn" disabled={!sel} onClick={() => sel && onEdit(sel)}>
                  Edit…
                </button>
                <button
                  className="btn"
                  disabled={!sel}
                  onClick={() =>
                    sel &&
                    void apply((f) => ({ ...f, pinned: pinned ? f.pinned.filter((p) => p !== sel.id) : [...f.pinned, sel.id] }), pinned ? `Unpinned "${sel.name}"` : `Pinned "${sel.name}"`)
                  }
                >
                  {pinned ? "Unpin" : "Pin"}
                </button>
                <button className="btn" disabled={!userFolder || !sel || list[0]?.id === sel.id} onClick={() => moveBookmark(-1)}>
                  Move up
                </button>
                <button className="btn" disabled={!userFolder || !sel || list[list.length - 1]?.id === sel.id} onClick={() => moveBookmark(1)}>
                  Move down
                </button>
                <button
                  className="btn"
                  disabled={!userFolder || !sel}
                  onClick={() =>
                    sel &&
                    userFolder &&
                    void apply(
                      (f) => ({ ...f, folders: f.folders.map((d) => (d.id === userFolder.id ? { ...d, items: d.items.filter((i) => i !== sel.id) } : d)) }),
                      `Removed "${sel.name}" from ${userFolder.name}`,
                    )
                  }
                >
                  Remove from folder
                </button>
                <button className="btn danger" disabled={!sel} onClick={() => sel && void deleteBookmark(sel)}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="dialog-buttons">
          {transferButtons?.({ checked, profile })}
          <div className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
        {folderEdit && (
          <FolderDialog
            file={file}
            folderKey={folderEdit.key}
            onClose={() => setFolderEdit(null)}
            onSaved={(key, msg) => {
              setFolderEdit(null);
              if (key) setFolderKey(key);
              shell.showFlash(msg);
            }}
          />
        )}
      </div>
    </div>
  );
}

/** New folder, or edit one: name + description (feature folders: description only). */
function FolderDialog({
  file,
  folderKey,
  onClose,
  onSaved,
}: {
  file: BookmarkFile;
  folderKey: FolderKey | null;
  onClose: () => void;
  onSaved: (key: FolderKey | null, msg: string) => void;
}) {
  const feature = folderKey?.startsWith("s:") ? (folderKey.slice(2) as ServiceId) : null;
  const folder = folderKey?.startsWith("f:") ? (file.folders.find((f) => f.id === folderKey.slice(2)) ?? null) : null;
  const [name, setName] = useState(folder?.name ?? "");
  const [description, setDescription] = useState(feature ? (file.featureNotes[feature] ?? "") : (folder?.description ?? ""));
  const [error, setError] = useState<string | null>(null);
  const nameProblem = feature ? null : folderNameProblem(file, name, folder?.id ?? null);
  const descProblem = description.trim().length > BOOKMARK_LIMITS.description ? `At most ${BOOKMARK_LIMITS.description} characters` : null;

  async function save() {
    if (nameProblem || descProblem) return;
    try {
      if (feature) {
        await saveBookmarks({ ...file, featureNotes: { ...file.featureNotes, [feature]: description.trim() } });
        onSaved(null, `Description saved for ${serviceName(feature)}`);
      } else if (folder) {
        await saveBookmarks({ ...file, folders: file.folders.map((f) => (f.id === folder.id ? { ...f, name: name.trim(), description: description.trim() } : f)) });
        onSaved(null, `Folder "${name.trim()}" saved`);
      } else {
        const id = newId();
        await saveBookmarks({ ...file, folders: [...file.folders, { id, name: name.trim(), description: description.trim(), items: [] }] });
        onSaved(`f:${id}`, `Folder "${name.trim()}" created`);
      }
    } catch (e) {
      setError((e as { message?: string }).message ?? String(e));
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog bookmark-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="bmf-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
          else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") void save();
        }}
      >
        <div className="dialog-title" id="bmf-title">
          {feature ? `${serviceName(feature)} folder` : folder ? "Edit folder" : "New folder"}
        </div>
        <div className="dialog-body">
          {feature ? (
            <div className="hint">Feature folders hold every bookmark of their service automatically. You can give it a description.</div>
          ) : (
            <>
              <label className="form-label" htmlFor="bmf-name">
                Name
              </label>
              <input id="bmf-name" className="text-input" type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
              {name && nameProblem && <div className="field-error">{nameProblem}</div>}
            </>
          )}
          <label className="form-label" htmlFor="bmf-desc">
            Description (optional)
          </label>
          <input id="bmf-desc" className="text-input" type="text" autoFocus={!!feature} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Shown as the folder's tooltip and at the top of its drop-down" />
          {descProblem && <div className="field-error">{descProblem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" disabled={!!nameProblem || !!descProblem} onClick={() => void save()}>
            {folder || feature ? "Save" : "Create"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
