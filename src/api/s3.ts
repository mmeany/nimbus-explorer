// Typed wrappers over the S3 (and app-level) Rust commands.
import { listen } from "@tauri-apps/api/event";
import { call, type ConnectionInfo, type ConnectionOverride, type ProfileInfo, type Settings, type ThemePref } from "./core";

export * from "./core";

export interface BucketInfo {
  name: string;
  creationDate: string | null;
  region: string | null;
}

export interface ObjectInfo {
  key: string;
  size: number;
  lastModified: string | null;
  storageClass: string | null;
  etag: string | null;
}

export interface ListPage {
  /** Sub-folder prefixes, each ending in "/". */
  folders: string[];
  files: ObjectInfo[];
  nextToken: string | null;
}

export interface FolderList {
  folders: string[];
  complete: boolean;
}

export type TransferState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface TransferEvent {
  id: number;
  direction: "upload" | "download" | "copy" | "move";
  /** Destination bucket/key for uploads, copies and moves; source for downloads. */
  bucket: string;
  key: string;
  /** Empty for copies/moves. */
  localPath: string;
  sourceBucket: string | null;
  sourceKey: string | null;
  bytesDone: number;
  /** 0 until known. */
  bytesTotal: number;
  state: TransferState;
  error: string | null;
}

export interface ItemCount {
  objects: number;
  bytes: number;
}

export interface DeleteResult {
  deleted: number;
  failed: { key: string; message: string }[];
}

export interface CopyPair {
  from: string;
  to: string;
}

export type Preview =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "image"; dataUrl: string }
  | { kind: "tooLarge"; limit: number }
  | { kind: "unsupported" };

export interface PreviewResult {
  size: number;
  contentType: string | null;
  preview: Preview;
}

export interface ShareLink {
  url: string;
  expiresAt: string;
  limitedByCredentials: boolean;
  temporaryCredentials: boolean;
}

export interface ObjectProperties {
  size: number;
  lastModified: string | null;
  etag: string | null;
  contentType: string | null;
  storageClass: string;
  versionId: string | null;
  serverSideEncryption: string | null;
  kmsKeyId: string | null;
  cacheControl: string | null;
  contentEncoding: string | null;
  contentDisposition: string | null;
  metadata: Record<string, string>;
  region: string;
}

export type SyncDirection = "upload" | "download";

export interface SyncRequest {
  direction: SyncDirection;
  localDir: string;
  bucket: string;
  prefix: string;
  deleteExtras: boolean;
  sizeOnly: boolean;
  excludes: string[];
}

export interface SyncTotals {
  count: number;
  bytes: number;
}

export type SyncActionKind = "upload" | "download" | "deleteRemote" | "deleteLocal";

export interface SyncSummary {
  planId: number;
  direction: SyncDirection;
  uploads: SyncTotals;
  downloads: SyncTotals;
  deletes: SyncTotals;
  unchanged: number;
  totalActions: number;
  /** First 100 actions only. */
  actions: { kind: SyncActionKind; path: string; size: number; reason: string }[];
  /** True if `actions` is a summary (more than 100). */
  truncated: boolean;
  totalWarnings: number;
  warnings: { path: string; message: string }[];
}

export interface SyncRunResult {
  transferIds: number[];
  deleted: number;
  deleteFailures: { path: string; message: string }[];
}

export interface ListingResult {
  objects: number;
  bytes: number;
  path: string;
}


export const api = {
  listProfiles: () => call<ProfileInfo[]>("list_profiles"),
  getSettings: () => call<Settings>("get_settings"),
  setConnectionOverride: (profile: string, value: ConnectionOverride | null) =>
    call<Settings>("set_connection_override", { profile, value }),
  setTheme: (theme: ThemePref) => call<Settings>("set_theme", { theme }),
  connect: (profile: string) => call<ConnectionInfo>("connect", { profile }),
  /** Selects the region for the regional services (remembered per profile). */
  setRegion: (region: string) => call<ConnectionInfo>("set_region", { region }),
  /** Turns read-only mode on/off for the connected profile (remembered). */
  setReadOnly: (enabled: boolean) => call<ConnectionInfo>("set_read_only", { enabled }),
  /** Remembers a filter (newest first, last 10); returns the history. */
  rememberFilter: (key: string, value: string) => call<string[]>("remember_filter", { key, value }),
  /** Forgets one filter, or the whole history when value is null. */
  forgetFilter: (key: string, value: string | null) => call<string[]>("forget_filter", { key, value }),
  listBuckets: () => call<BucketInfo[]>("list_buckets"),
  /** One page of up to pageSize rows (folders + files) for keys starting with prefix. */
  listObjects: (bucket: string, prefix: string, token: string | null, pageSize = 1000, recursive = false) =>
    call<ListPage>("list_objects", { bucket, prefix, token, pageSize, recursive }),
  /** Which of `keys` exist (HeadObject each). */
  existingKeys: (bucket: string, keys: string[]) => call<string[]>("existing_keys", { bucket, keys }),
  listFolders: (bucket: string, prefix: string) => call<FolderList>("list_folders", { bucket, prefix }),

  // Native dialogs (empty / null when cancelled)
  pickUploadFiles: () => call<string[]>("pick_upload_files"),
  pickFolder: (title: string) => call<string | null>("pick_folder", { title }),
  pickSaveFile: (defaultName: string) => call<string | null>("pick_save_file", { defaultName }),
  pickOpenFile: (title: string, filterName: string, extensions: string[]) =>
    call<string | null>("pick_open_file", { title, filterName, extensions }),
  pickSaveAs: (title: string, defaultName: string) => call<string | null>("pick_save_as", { title, defaultName }),

  // Transfers: progress arrives via onTransfer()
  uploadPaths: (bucket: string, prefix: string, paths: string[]) =>
    call<number[]>("upload_paths", { bucket, prefix, paths }),
  downloadFile: (bucket: string, key: string, dest: string) => call<number>("download_file", { bucket, key, dest }),
  downloadToFolder: (bucket: string, items: string[], dest: string) =>
    call<number[]>("download_to_folder", { bucket, items, dest }),
  copyItems: (srcBucket: string, dstBucket: string, pairs: CopyPair[], isMove: boolean) =>
    call<number[]>("copy_items", { srcBucket, dstBucket, pairs, isMove }),

  // File operations
  createFolder: (bucket: string, prefix: string) => call<void>("create_folder", { bucket, prefix }),
  countItems: (bucket: string, items: string[]) => call<ItemCount>("count_items", { bucket, items }),
  deleteItems: (bucket: string, items: string[]) => call<DeleteResult>("delete_items", { bucket, items }),

  // Inspect
  previewObject: (bucket: string, key: string) => call<PreviewResult>("preview_object", { bucket, key }),
  shareLink: (bucket: string, key: string, expiresSecs: number) =>
    call<ShareLink>("share_link", { bucket, key, expiresSecs }),
  objectProperties: (bucket: string, key: string) => call<ObjectProperties>("object_properties", { bucket, key }),
  /** Parses YAML into one JSON value per document (the browser has no YAML parser). */
  parseYaml: (text: string) => call<unknown[]>("parse_yaml", { text }),

  /** Saves a recursive listing of a folder to a text file (aws s3 ls format). */
  exportListing: (bucket: string, prefix: string, dest: string) =>
    call<ListingResult>("export_listing", { bucket, prefix, dest }),

  // Sync
  /** Dry run: compares both sides and stores the plan; changes nothing. */
  planSync: (request: SyncRequest) => call<SyncSummary>("plan_sync", { request }),
  /** Executes the previewed plan. */
  runSync: (planId: number) => call<SyncRunResult>("run_sync", { planId }),

  cancelTransfer: (id: number) => call<void>("cancel_transfer", { id }),
  cancelAllTransfers: () => call<void>("cancel_all_transfers"),

  /** Subscribes to transfer progress. Returns an unsubscribe function. */
  onTransfer(cb: (ev: TransferEvent) => void): () => void {
    let un: (() => void) | null = null;
    let cancelled = false;
    listen<TransferEvent>("transfer", (e) => cb(e.payload))
      .then((u) => (cancelled ? u() : (un = u)))
      .catch(() => {});
    return () => {
      cancelled = true;
      un?.();
    };
  },
};
