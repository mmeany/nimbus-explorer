// Bookmarks (see src-tauri/src/bookmarks.rs). The whole set is loaded and
// saved at once; Rust validates every save.
import { call, type Settings } from "./core";
import type { Place, ServiceId } from "../shell/places";

export interface Bookmark {
  id: string;
  profile: string;
  /** Regional services' region ("" for S3). */
  region: string;
  service: ServiceId;
  place: Place;
  /** Row to select at the place. */
  select?: string | null;
  name: string;
  description: string;
  /** UTC ISO time. */
  created: string;
}

export interface BookmarkFolder {
  id: string;
  name: string;
  description: string;
  /** Bookmark ids in the user's order. */
  items: string[];
}

export interface BookmarkFile {
  format?: string;
  version: number;
  bookmarks: Bookmark[];
  /** The user's folders, in bar order. */
  folders: BookmarkFolder[];
  /** Pinned bookmark ids, in bar order. */
  pinned: string[];
  /** Feature-folder descriptions by service id. */
  featureNotes: Partial<Record<ServiceId, string>>;
}

export const EMPTY_BOOKMARKS: BookmarkFile = { version: 1, bookmarks: [], folders: [], pinned: [], featureNotes: {} };

/** Mirrors the limits in bookmarks.rs. */
export const BOOKMARK_LIMITS = { bookmarks: 5000, folders: 100, name: 100, folderName: 40, description: 200 };

export const bookmarksApi = {
  load: () => call<BookmarkFile>("bookmarks_load"),
  /** `reason: "import"` is recorded in the activity history. */
  save: (file: BookmarkFile, reason: string | null = null) => call<BookmarkFile>("bookmarks_save", { file, reason }),
  export: (file: BookmarkFile, dest: string) => call<number>("bookmarks_export", { file, dest }),
  readImport: (path: string) => call<BookmarkFile>("bookmarks_read_import", { path }),
  setBarVisible: (visible: boolean) => call<Settings>("set_bookmarks_bar", { visible }),
};
