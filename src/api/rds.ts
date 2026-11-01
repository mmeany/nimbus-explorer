// RDS commands (instances and Aurora / Multi-AZ DB clusters).
import { call } from "./core";

export interface NameStatus {
  name: string;
  status: string | null;
}

export interface DbInstance {
  id: string;
  arn: string;
  engine: string;
  engineVersion: string | null;
  class: string | null;
  status: string | null;
  clusterId: string | null;
  endpoint: string | null;
  port: number | null;
  allocatedStorageGb: number | null;
  maxAllocatedStorageGb: number | null;
  storageType: string | null;
  iops: number | null;
  multiAz: boolean;
  availabilityZone: string | null;
  secondaryAz: string | null;
  publiclyAccessible: boolean;
  vpcId: string | null;
  subnetGroup: string | null;
  securityGroups: NameStatus[];
  encrypted: boolean;
  kmsKey: string | null;
  iamAuth: boolean;
  backupRetentionDays: number | null;
  backupWindow: string | null;
  maintenanceWindow: string | null;
  deletionProtection: boolean;
  parameterGroups: NameStatus[];
  optionGroups: NameStatus[];
  masterUsername: string | null;
  masterSecretArn: string | null;
  dbName: string | null;
  created: string | null;
  caCertificate: string | null;
  performanceInsights: boolean;
  latestRestorableTime: string | null;
  pendingChanges: string[];
  readReplicaOf: string | null;
  readReplicas: string[];
}

export interface DbCluster {
  id: string;
  arn: string;
  engine: string;
  engineVersion: string | null;
  engineMode: string | null;
  status: string | null;
  endpoint: string | null;
  readerEndpoint: string | null;
  port: number | null;
  members: { id: string; writer: boolean }[];
  multiAz: boolean;
  encrypted: boolean;
  kmsKey: string | null;
  iamAuth: boolean;
  dataApi: boolean;
  backupRetentionDays: number | null;
  backupWindow: string | null;
  maintenanceWindow: string | null;
  deletionProtection: boolean;
  parameterGroup: string | null;
  subnetGroup: string | null;
  securityGroups: NameStatus[];
  masterUsername: string | null;
  masterSecretArn: string | null;
  databaseName: string | null;
  serverlessMinAcu: number | null;
  serverlessMaxAcu: number | null;
  class: string | null;
  allocatedStorageGb: number | null;
  storageType: string | null;
  created: string | null;
  latestRestorableTime: string | null;
  pendingChanges: string[];
}

export interface PendingAction {
  action: string;
  description: string | null;
  autoAppliedAfter: string | null;
  forcedApply: string | null;
  currentApplyDate: string | null;
  optInStatus: string | null;
}

export type DbKind = "cluster" | "instance";

export interface SnapshotInfo {
  id: string;
  arn: string;
  kind: DbKind;
  dbId: string;
  snapshotType: string | null;
  status: string | null;
  engine: string;
  engineVersion: string | null;
  created: string | null;
  sizeGb: number | null;
  encrypted: boolean;
  kmsKey: string | null;
  percentProgress: number | null;
  vpcId: string | null;
  port: number | null;
}

export interface RestoreRequest {
  snapshotId?: string | null;
  sourceDbId?: string | null;
  /** ISO time; omitted with a source database = latest restorable time. */
  restoreTime?: string | null;
  newId: string;
  class?: string | null;
  serverlessMinAcu?: number | null;
  serverlessMaxAcu?: number | null;
}

export const rdsApi = {
  list: () => call<{ clusters: DbCluster[]; instances: DbInstance[] }>("rds_list"),
  describeInstance: (id: string) => call<DbInstance>("rds_describe_instance", { id }),
  describeCluster: (id: string) => call<DbCluster>("rds_describe_cluster", { id }),
  pendingMaintenance: (arn: string) => call<PendingAction[]>("rds_pending_maintenance", { arn }),
  listTags: (arn: string) => call<[string, string][]>("rds_list_tags", { arn }),
  start: (kind: DbKind, id: string) => call<void>("rds_start", { kind, id }),
  stop: (kind: DbKind, id: string) => call<void>("rds_stop", { kind, id }),
  reboot: (kind: DbKind, id: string, forceFailover: boolean) => call<void>("rds_reboot", { kind, id, forceFailover }),
  failover: (clusterId: string, target: string | null) => call<void>("rds_failover", { clusterId, target }),
  modify: (
    kind: DbKind,
    id: string,
    request: { class?: string | null; backupRetentionDays?: number | null; deletionProtection?: boolean | null; applyImmediately: boolean },
  ) => call<void>("rds_modify", { kind, id, request }),
  delete: (kind: DbKind, id: string, request: { finalSnapshotId: string | null; deleteAutomatedBackups: boolean }) =>
    call<void>("rds_delete", { kind, id, request }),
  /** id null = every snapshot in the region. */
  listSnapshots: (kind: DbKind | null, id: string | null) => call<SnapshotInfo[]>("rds_list_snapshots", { kind, id }),
  createSnapshot: (kind: DbKind, id: string, snapshotId: string) => call<void>("rds_create_snapshot", { kind, id, snapshotId }),
  copySnapshot: (kind: DbKind, source: string, target: string) => call<void>("rds_copy_snapshot", { kind, source, target }),
  deleteSnapshot: (kind: DbKind, snapshotId: string) => call<void>("rds_delete_snapshot", { kind, snapshotId }),
  /** Returns the new database's identifier. */
  restore: (kind: DbKind, request: RestoreRequest) => call<string>("rds_restore", { kind, request }),
  /** Events over the last `minutes`; for a cluster pass its member instance ids too. */
  events: (kind: DbKind, id: string, members: string[], minutes: number) => call<RdsEvent[]>("rds_events", { kind, id, members, minutes }),
  logFiles: (id: string) => call<LogFile[]>("rds_log_files", { id }),
  logTail: (id: string, file: string, lines: number) => call<LogTail>("rds_log_tail", { id, file, lines }),
  /** Saves the whole file; returns bytes written. */
  logDownload: (id: string, file: string, dest: string) => call<number>("rds_log_download", { id, file, dest }),
  /** One statement through the Data API (Aurora clusters with Data API on). */
  executeSql: (request: SqlRequest) => call<SqlResult>("rds_execute_sql", { request }),
  saveResult: (dest: string, columns: SqlColumn[], rows: unknown[][], format: "csv" | "json") =>
    call<void>("rds_save_result", { dest, columns, rows, format }),
};

export interface SqlRequest {
  clusterArn: string;
  secretArn: string;
  database: string | null;
  sql: string;
  family: "postgres" | "mysql";
  /** Runs in a transaction that's rolled back; required in read-only mode. */
  readOnly: boolean;
}

export interface SqlColumn {
  name: string;
  typeName: string | null;
}

export interface SqlResult {
  columns: SqlColumn[];
  rows: unknown[][];
  updated: number;
  readOnly: boolean;
  elapsedMs: number;
}

export interface RdsEvent {
  date: string | null;
  source: string;
  sourceType: string | null;
  message: string;
  categories: string[];
}

export interface LogFile {
  name: string;
  size: number;
  lastWritten: string | null;
}

export interface LogTail {
  text: string;
  truncated: boolean;
}

const ENGINE_NAMES: Record<string, string> = {
  "aurora-postgresql": "Aurora PostgreSQL",
  "aurora-mysql": "Aurora MySQL",
  aurora: "Aurora MySQL 5.6",
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  "sqlserver-ee": "SQL Server Enterprise",
  "sqlserver-se": "SQL Server Standard",
  "sqlserver-ex": "SQL Server Express",
  "sqlserver-web": "SQL Server Web",
  "oracle-ee": "Oracle Enterprise",
  "oracle-se2": "Oracle SE2",
  "db2-se": "Db2 Standard",
  "db2-ae": "Db2 Advanced",
};

/** "aurora-postgresql" → "Aurora PostgreSQL". */
export const engineLabel = (engine: string) => ENGINE_NAMES[engine] ?? engine;

export type EngineFamily = "postgres" | "mysql" | "sqlserver" | "oracle" | "db2" | "other";

/** Which client tools / URL formats apply. */
export function engineFamily(engine: string): EngineFamily {
  const e = engine.toLowerCase();
  if (e.includes("postgres")) return "postgres";
  if (e.includes("mysql") || e.includes("mariadb") || e === "aurora") return "mysql";
  if (e.startsWith("sqlserver")) return "sqlserver";
  if (e.startsWith("oracle")) return "oracle";
  if (e.startsWith("db2")) return "db2";
  return "other";
}

/** CSS modifier for a status: ok / off / busy / bad. */
export function statusTone(status: string | null): "ok" | "off" | "busy" | "bad" {
  const s = (status ?? "").toLowerCase();
  if (s === "available") return "ok";
  if (s === "stopped" || s === "stopping") return "off";
  if (/fail|error|incompatible|inaccessible|storage-full|restore-error/.test(s)) return "bad";
  return "busy";
}

/** Same rules as the backend's identifier_problem. */
export function identifierProblem(id: string, what: string, max = 63): string | null {
  if (!id || id.length > max) return `${what} names are 1 to ${max} characters`;
  if (!/^[A-Za-z]/.test(id)) return `${what} names start with a letter`;
  if (!/^[A-Za-z0-9-]+$/.test(id)) return "Use letters, digits and hyphens only";
  if (id.includes("--") || id.endsWith("-")) return "No two hyphens in a row, and no hyphen at the end";
  return null;
}

/** "orders-db-final-2026-10-29-2015" */
export function snapshotName(base: string, suffix: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{4})$/, "$1-$2");
  return `${base}-${suffix}-${stamp}`.slice(0, 255);
}
