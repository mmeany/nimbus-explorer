// The bookmarks, shared by the bar, the dialogs and the context menus.
// Module-level store: changes are applied at once and saved in the background;
// a refused save (Rust validates) puts the previous state back and reports it.
import { useSyncExternalStore } from "react";
import type { AppError } from "../api/core";
import { bookmarksApi, EMPTY_BOOKMARKS, type Bookmark, type BookmarkFile, type BookmarkFolder } from "../api/bookmarks";
import { samePlace, SERVICES, type Place, type ServiceId } from "../shell/places";

let file: BookmarkFile = EMPTY_BOOKMARKS;
let loadError: AppError | null = null;
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useBookmarks(): BookmarkFile {
  return useSyncExternalStore(subscribe, () => file);
}

export function useBookmarksError(): AppError | null {
  return useSyncExternalStore(subscribe, () => loadError);
}

export function currentBookmarks(): BookmarkFile {
  return file;
}

export async function loadBookmarks() {
  try {
    file = await bookmarksApi.load();
    loadError = null;
    loaded = true;
  } catch (e) {
    // Don't let a later save replace a file that couldn't be read.
    loadError = e as AppError;
    loaded = false;
  }
  emit();
}

/** Applies `next` and saves it. Throws (after undoing) if the save is refused. */
export async function saveBookmarks(next: BookmarkFile, reason: string | null = null): Promise<void> {
  if (!loaded) throw loadError ?? { kind: "other", message: "Bookmarks haven't loaded", detail: "" };
  const before = file;
  file = next;
  emit();
  try {
    file = await bookmarksApi.save(next, reason);
    emit();
  } catch (e) {
    file = before;
    emit();
    throw e;
  }
}

/** Saves a change made to a copy of the current set. */
export function updateBookmarks(change: (f: BookmarkFile) => BookmarkFile, reason: string | null = null) {
  return saveBookmarks(change(file), reason);
}

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function sameTarget(b: { profile: string; place: Place; select?: string | null }, profile: string, place: Place, select: string | null | undefined) {
  return b.profile === profile && samePlace(b.place, place) && (b.select ?? null) === (select ?? null);
}

export function findBookmark(f: BookmarkFile, profile: string, place: Place, select: string | null | undefined): Bookmark | null {
  return f.bookmarks.find((b) => sameTarget(b, profile, place, select)) ?? null;
}

/** Is the place itself (any item) bookmarked for the profile? */
export function isPlaceBookmarked(f: BookmarkFile, profile: string, place: Place): boolean {
  return f.bookmarks.some((b) => b.profile === profile && samePlace(b.place, place));
}

export function byId(f: BookmarkFile): Map<string, Bookmark> {
  return new Map(f.bookmarks.map((b) => [b.id, b]));
}

export const byName = (a: Bookmark, b: Bookmark) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/** Feature folder contents (sorted by name), for one profile or all (null). */
export function featureItems(f: BookmarkFile, service: ServiceId, profile: string | null): Bookmark[] {
  return f.bookmarks.filter((b) => b.service === service && (profile === null || b.profile === profile)).sort(byName);
}

/** A folder's bookmarks in its order, for one profile or all (null). */
export function folderItems(f: BookmarkFile, folder: BookmarkFolder, profile: string | null): Bookmark[] {
  const map = byId(f);
  return folder.items.map((id) => map.get(id)).filter((b): b is Bookmark => !!b && (profile === null || b.profile === profile));
}

/** Services with at least one bookmark for the profile, in service order. */
export function featureServices(f: BookmarkFile, profile: string | null): ServiceId[] {
  return SERVICES.map((s) => s.id).filter((id) => f.bookmarks.some((b) => b.service === id && (profile === null || b.profile === profile)));
}

/** Removes a bookmark everywhere. */
export function withoutBookmark(f: BookmarkFile, id: string): BookmarkFile {
  return {
    ...f,
    bookmarks: f.bookmarks.filter((b) => b.id !== id),
    pinned: f.pinned.filter((p) => p !== id),
    folders: f.folders.map((d) => ({ ...d, items: d.items.filter((i) => i !== id) })),
  };
}

/** Adds a bookmark to a folder (at the end) unless it's there. */
export function withInFolder(f: BookmarkFile, folderId: string, id: string): BookmarkFile {
  return { ...f, folders: f.folders.map((d) => (d.id === folderId && !d.items.includes(id) ? { ...d, items: [...d.items, id] } : d)) };
}

export function folderNameProblem(f: BookmarkFile, name: string, exceptId: string | null): string | null {
  const n = name.trim();
  if (!n) return "Enter a name";
  if (n.length > 40) return "At most 40 characters";
  if (f.folders.some((d) => d.id !== exceptId && d.name.toLowerCase() === n.toLowerCase())) return "There's already a folder with that name";
  return null;
}
