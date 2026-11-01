// DynamoDB commands. Items travel as DynamoDB JSON ({"S": "x"}); see
// util/ddbJson.ts for conversion to and from plain JSON.
import type { DdbItem, DdbValue } from "../util/ddbJson";
import { listen } from "@tauri-apps/api/event";
import { call } from "./core";

export interface KeyDef {
  name: string;
  /** "S" | "N" | "B" */
  attrType: string;
}

export interface IndexInfo {
  name: string;
  kind: "GSI" | "LSI";
  partitionKey: KeyDef | null;
  sortKey: KeyDef | null;
  projection: string;
  nonKeyAttributes: string[];
  status: string | null;
  itemCount: number | null;
  sizeBytes: number | null;
  readCapacity: number | null;
  writeCapacity: number | null;
  backfilling: boolean;
}

export interface TableInfo {
  name: string;
  arn: string | null;
  status: string | null;
  partitionKey: KeyDef | null;
  sortKey: KeyDef | null;
  itemCount: number | null;
  sizeBytes: number | null;
  billingMode: string | null;
  readCapacity: number | null;
  writeCapacity: number | null;
  tableClass: string | null;
  created: string | null;
  deletionProtection: boolean;
  streamEnabled: boolean;
  streamViewType: string | null;
  streamArn: string | null;
  sse: string | null;
  indexes: IndexInfo[];
  attributeDefinitions: KeyDef[];
  ttlAttribute: string | null;
  ttlStatus: string | null;
  pitrStatus: string | null;
  error: string | null;
}

export interface ReadRequest {
  table: string;
  index?: string | null;
  query: boolean;
  keyCondition?: string | null;
  filter?: string | null;
  projection?: string | null;
  names: Record<string, string>;
  values: Record<string, DdbValue>;
  forward?: boolean;
  limit?: number;
  startKey?: DdbItem | null;
  consistent?: boolean;
}

export interface ReadPage {
  items: DdbItem[];
  lastKey: DdbItem | null;
  count: number;
  scannedCount: number;
  consumedCapacity: number | null;
}

export interface KeySpec {
  name: string;
  attrType: string;
}

export interface IndexSpec {
  name: string;
  partitionKey: KeySpec | null;
  sortKey: KeySpec | null;
  projection: "ALL" | "KEYS_ONLY" | "INCLUDE";
  nonKeyAttributes: string[];
  readCapacity: number | null;
  writeCapacity: number | null;
}

export interface CreateTableSpec {
  name: string;
  partitionKey: KeySpec;
  sortKey: KeySpec | null;
  billingMode: "PAY_PER_REQUEST" | "PROVISIONED";
  readCapacity: number | null;
  writeCapacity: number | null;
  gsis: IndexSpec[];
  lsis: IndexSpec[];
  tableClass: string | null;
  deletionProtection: boolean;
  streamViewType: string | null;
  tags: Record<string, string>;
}

/** Only fields present are changed. */
export interface SettingsPatch {
  billingMode?: string;
  readCapacity?: number;
  writeCapacity?: number;
  deletionProtection?: boolean;
  tableClass?: string;
  /** "" turns the stream off. */
  streamViewType?: string;
  /** "" turns TTL off. */
  ttlAttribute?: string;
  pitr?: boolean;
  tags?: Record<string, string>;
}

export interface BackupInfo {
  arn: string;
  name: string;
  status: string | null;
  kind: string | null;
  created: string | null;
  sizeBytes: number | null;
}

export type ExportFormat = "dynamoJsonl" | "plainJsonl" | "csv";

export interface Progress {
  job: number;
  done: number;
  total: number | null;
  finished: boolean;
}

export interface ImportPreview {
  planId: number;
  count: number;
  dynamoJson: boolean;
  samples: unknown[];
  problems: [number, string][];
  problemCount: number;
  existing: number | null;
  duplicatesInFile: number;
}

let nextJob = Date.now();
/** A new id for a cancellable export / import. */
export function newJobId(): number {
  return ++nextJob;
}

export const ddbApi = {
  /** Every table name (100 per call); descriptions come per page from detailsMany. */
  listTableNames: () => call<string[]>("ddb_list_table_names"),
  detailsMany: (names: string[]) => call<TableInfo[]>("ddb_details_many", { names }),
  describeTable: (name: string) => call<TableInfo>("ddb_describe_table", { name }),
  listTags: (arn: string) => call<[string, string][]>("ddb_list_tags", { arn }),
  readPage: (request: ReadRequest) => call<ReadPage>("ddb_read_page", { request }),
  /** Counts all matching items (every page; no items returned). */
  count: (request: ReadRequest) => call<number>("ddb_count", { request }),
  /** Strongly consistent read of one item. */
  getItem: (table: string, key: DdbItem) => call<DdbItem | null>("ddb_get_item", { table, key }),
  /** mustExist: false = create only, true = replace only, null = either. */
  putItem: (table: string, keyAttrs: string[], item: DdbItem, mustExist: boolean | null) =>
    call<void>("ddb_put_item", { table, keyAttrs, item, mustExist }),
  /** One page of a PartiQL statement; parameters are DynamoDB JSON for "?". */
  execute: (statement: string, parameters: DdbValue[], nextToken: string | null, limit: number | null) =>
    call<{ items: DdbItem[]; nextToken: string | null; consumedCapacity: number | null }>("ddb_execute", {
      statement,
      parameters,
      nextToken,
      limit,
    }),
  exportItems: (items: DdbItem[], keyAttrs: string[], format: ExportFormat, dest: string) =>
    call<number>("ddb_export_items", { items, keyAttrs, format, dest }),
  /** Resolves with [items written, cancelled]. */
  exportTable: (table: string, keyAttrs: string[], format: ExportFormat, dest: string, job: number, total: number | null) =>
    call<[number, boolean]>("ddb_export_table", { table, keyAttrs, format, dest, job, total }),
  cancelJob: (job: number) => call<void>("ddb_cancel_job", { job }),
  planImport: (table: string, keyAttrs: string[], keyTypes: string[], path: string) =>
    call<ImportPreview>("ddb_plan_import", { table, keyAttrs, keyTypes, path }),
  runImport: (planId: number, overwrite: boolean, job: number) =>
    call<{ written: number; skippedExisting: number; failed: [number, string][] }>("ddb_run_import", { planId, overwrite, job }),
  /** Subscribes to export / import progress. Returns an unsubscribe function. */
  onProgress(cb: (p: Progress) => void): () => void {
    let un: (() => void) | null = null;
    let cancelled = false;
    listen<Progress>("ddb-progress", (e) => cb(e.payload))
      .then((u) => (cancelled ? u() : (un = u)))
      .catch(() => {});
    return () => {
      cancelled = true;
      un?.();
    };
  },
  createTable: (spec: CreateTableSpec) => call<void>("ddb_create_table", { spec }),
  deleteTable: (name: string) => call<void>("ddb_delete_table", { name }),
  addGsi: (table: string, index: IndexSpec) => call<void>("ddb_add_gsi", { table, index }),
  deleteGsi: (table: string, index: string) => call<void>("ddb_delete_gsi", { table, index }),
  updateSettings: (table: string, patch: SettingsPatch) => call<void>("ddb_update_settings", { table, patch }),
  listBackups: (table: string) => call<BackupInfo[]>("ddb_list_backups", { table }),
  createBackup: (table: string, name: string) => call<string>("ddb_create_backup", { table, name }),
  restoreBackup: (backupArn: string, target: string) => call<void>("ddb_restore_backup", { backupArn, target }),
  deleteBackup: (backupArn: string) => call<void>("ddb_delete_backup", { backupArn }),
  deleteItems: (table: string, keys: DdbItem[]) =>
    call<{ done: number; failed: [number, string][] }>("ddb_delete_items", { table, keys }),
};

/** "pk (S)" */
export function keyLabel(k: KeyDef | null): string {
  return k ? `${k.name} (${k.attrType})` : "";
}

/** Key attribute names of the table (partition, then sort). */
export function tableKeyAttrs(t: TableInfo): string[] {
  return [t.partitionKey?.name, t.sortKey?.name].filter((x): x is string => !!x);
}

/** The item's primary key (for get / delete / matching). */
export function itemKey(t: TableInfo, item: DdbItem): DdbItem {
  return Object.fromEntries(tableKeyAttrs(t).map((k) => [k, item[k]]));
}

/** Stable text form of an item's key, for comparing items. */
export function keyString(t: TableInfo, item: DdbItem): string {
  return JSON.stringify(tableKeyAttrs(t).map((k) => item[k] ?? null));
}

/** Mirrors the backend check: only SELECT runs in read-only mode. */
export function isSelect(statement: string): boolean {
  const s = statement.replace(/^(\s|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/|\()*/, "");
  return /^select(?![A-Za-z0-9_])/i.test(s);
}

/** Table, index and backup names: 3–255 of letters, digits, _ - . */
export function ddbNameProblem(name: string, what = "Table"): string | null {
  if (name.length < 3 || name.length > 255) return `${what} names must be 3 to 255 characters`;
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return `${what} names can use letters, digits, _ - and . only`;
  return null;
}
