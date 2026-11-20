// Activity history (see src-tauri/src/history.rs). Entries are written by the
// recorder in src/history/recorder.ts; this file only reads and manages them.
import { call, type Settings } from "./core";
import type { Place } from "../shell/places";

export type HistoryPeriod = "day" | "week" | "month" | "year";

export interface HistorySettings {
  enabled: boolean;
  period: HistoryPeriod;
  /** New file within a period once the current one reaches this size (0 = no limit). */
  maxFileMb: number;
  /** Files kept per profile (0 = all). */
  keepFiles: number;
}

export const DEFAULT_HISTORY_SETTINGS: HistorySettings = { enabled: true, period: "month", maxFileMb: 10, keepFiles: 24 };

/** "app" covers connecting and the read-only lock. */
export type HistoryService = Exclude<Place["service"], "home"> | "app";

export interface NewHistoryEntry {
  service: HistoryService;
  action: string;
  target: string;
  place?: Place | null;
  select?: string | null;
  ok: boolean;
  errorKind?: string | null;
  message?: string | null;
  detail?: string | null;
}

export interface HistoryEntry extends NewHistoryEntry {
  /** UTC ISO time. */
  time: string;
  profile: string;
  /** Regional services' region at the time ("" for S3 / app). */
  region: string;
}

export interface HistoryQuery {
  profile: string;
  service?: string | null;
  text?: string | null;
  failedOnly?: boolean;
  /** UTC ISO times, inclusive. */
  from?: string | null;
  to?: string | null;
}

export interface HistoryCursor {
  file: string;
  line: number;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  next: HistoryCursor | null;
  skipped: number;
}

export const historyApi = {
  record: (entry: NewHistoryEntry) => call<void>("history_record", { entry }),
  page: (query: HistoryQuery, cursor: HistoryCursor | null, limit: number) =>
    call<HistoryPage>("history_page", { query, cursor, limit }),
  profiles: () => call<string[]>("history_profiles"),
  export: (query: HistoryQuery, format: "csv" | "json", dest: string) =>
    call<number>("history_export", { query, format, dest }),
  clear: (profile: string) => call<void>("history_clear", { profile }),
  openFolder: (profile: string | null) => call<void>("history_open_folder", { profile }),
  setSettings: (value: HistorySettings) => call<Settings>("set_history_settings", { value }),
};
