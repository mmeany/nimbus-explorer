// Step Functions commands.
import { call } from "./core";

/** A state machine as the list returns it (every one is listed). */
export interface MachineRef {
  name: string;
  arn: string;
  /** STANDARD or EXPRESS. */
  kind: string;
  created: string | null;
}

export interface Logging {
  /** ALL, ERROR, FATAL or OFF. */
  level: string;
  includeExecutionData: boolean;
  logGroupArn: string | null;
  logGroup: string | null;
}

export interface MachineDetails {
  name: string;
  arn: string;
  kind: string;
  status: string | null;
  description: string | null;
  created: string | null;
  roleArn: string | null;
  revisionId: string | null;
  /** The ASL (JSON) as stored. */
  definition: string;
  logging: Logging | null;
  tracing: boolean;
  encryption: { kind: string; kmsKeyId: string | null; reusePeriodSecs: number | null } | null;
  /** Only from `describe`. */
  tags: [string, string][];
  /** Set when DescribeStateMachine failed for this row. */
  error: string | null;
}

export const EXECUTION_STATUSES = ["RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED", "PENDING_REDRIVE"] as const;

export interface ExecutionSummary {
  name: string;
  arn: string;
  status: string;
  start: string | null;
  stop: string | null;
  versionArn: string | null;
  aliasArn: string | null;
  mapRunArn: string | null;
  redriveCount: number | null;
}

export interface ExecutionDetails extends ExecutionSummary {
  machineArn: string;
  input: string | null;
  output: string | null;
  error: string | null;
  cause: string | null;
  redriveStatus: string | null;
  redriveStatusReason: string | null;
  traceHeader: string | null;
}

/** A history event as AWS sends it: id, previousEventId, type, timestamp (ISO) and one `…EventDetails`. */
export type HistoryEvent = { id: number; previousEventId?: number; type: string; timestamp: string } & Record<string, unknown>;

export interface Versions {
  versions: { arn: string; version: string; created: string | null }[];
  aliases: { name: string; arn: string; description: string | null; created: string | null; routing: { versionArn: string; version: string; weight: number }[] }[];
}

export const sfnApi = {
  list: () => call<MachineRef[]>("sfn_list"),
  detailsMany: (arns: string[]) => call<MachineDetails[]>("sfn_details_many", { arns }),
  describe: (arn: string) => call<MachineDetails>("sfn_describe", { arn }),
  executions: (arn: string, status: string | null, token: string | null, pageSize: number) =>
    call<{ items: ExecutionSummary[]; nextToken: string | null }>("sfn_executions", { arn, status, token, pageSize }),
  execution: (arn: string) => call<ExecutionDetails>("sfn_execution", { arn }),
  history: (arn: string, token: string | null, pageSize: number) => call<{ events: HistoryEvent[]; nextToken: string | null }>("sfn_history", { arn, token, pageSize }),
  versions: (arn: string) => call<Versions>("sfn_versions", { arn }),
  /** Every event (up to 25,000), for the graph. */
  historyAll: (arn: string) => call<{ events: HistoryEvent[]; truncated: boolean }>("sfn_history_all", { arn }),
  /** The definition the execution ran with. */
  executionDefinition: (arn: string) => call<string>("sfn_execution_definition", { arn }),
  /** Saves an exported graph (a local write). */
  exportSvg: (path: string, svg: string) => call<void>("sfn_export_svg", { path, svg }),
  /** Starts an execution; refused in read-only mode. */
  start: (request: StartRequest) => call<{ executionArn: string; name: string; start: string | null }>("sfn_start", { request }),
  stop: (arn: string, error: string | null, cause: string | null) => call<void>("sfn_stop", { arn, error, cause }),
  /** Restarts a failed / aborted / timed-out Standard execution from where it stopped. */
  redrive: (arn: string) => call<string | null>("sfn_redrive", { arn }),
  /** Saved inputs for "profile|region|machine" (on this computer). */
  inputs: (key: string) => call<SavedInput[]>("sfn_inputs", { key }),
  saveInput: (key: string, name: string, input: string) => call<SavedInput[]>("sfn_save_input", { key, name, input }),
  deleteInput: (key: string, name: string) => call<SavedInput[]>("sfn_delete_input", { key, name }),
  /** The Distributed Map runs an execution started. */
  mapRuns: (arn: string) => call<MapRunRef[]>("sfn_map_runs", { arn }),
  mapRun: (arn: string) => call<MapRunDetails>("sfn_map_run", { arn }),
  /** Changes a running map run's settings; refused in read-only mode. */
  updateMapRun: (arn: string, change: MapRunChange) => call<void>("sfn_update_map_run", { arn, change }),
  /** ValidateStateMachineDefinition (reads only). */
  validate: (definition: string, kind: string) => call<Validation>("sfn_validate", { definition, kind }),
  /** Saves the changed fields; "changed" means someone else saved first and nothing was written. */
  update: (request: UpdateRequest) => call<UpdateOutcome>("sfn_update", { request }),
  /** With revisionId, AWS refuses if the machine changed since it was read. */
  publishVersion: (arn: string, description: string | null, revisionId: string | null) => call<string>("sfn_publish_version", { arn, description, revisionId }),
  /** Creates the alias, or updates it when `update`; routing is one version, or two with weights adding up to 100. */
  saveAlias: (alias: { machineArn: string; name: string; description: string | null; routing: { versionArn: string; weight: number }[] }, update: boolean) => call<void>("sfn_save_alias", { alias, update }),
  deleteAlias: (arn: string) => call<void>("sfn_delete_alias", { arn }),
  /** Refused while an alias routes to the version. */
  deleteVersion: (arn: string) => call<void>("sfn_delete_version", { arn }),
};

export interface Validation {
  /** OK or FAIL. */
  result: string;
  diagnostics: { severity: string; code: string; message: string; location: string | null; state: string | null }[];
  truncated: boolean;
}

export interface UpdateRequest {
  arn: string;
  /** The revision the editor opened. */
  expectedRevision: string | null;
  overwrite: boolean;
  definition: string | null;
  roleArn: string | null;
  logging: { level: string; includeExecutionData: boolean; logGroupArn: string | null } | null;
  tracing: boolean | null;
  publish: boolean;
  versionDescription: string | null;
}

export type UpdateOutcome = { outcome: "saved"; revisionId: string | null; versionArn: string | null } | { outcome: "changed"; currentRevision: string | null; updated: string | null };

export interface MapRunRef {
  arn: string;
  /** The Map state's Label (a generated id when the state has no Label). */
  label: string;
  /** "label:uuid", as places name it. */
  id: string;
  start: string | null;
  stop: string | null;
}

export interface MapRunCounts {
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  aborted: number;
  total: number;
  resultsWritten: number;
  failuresNotRedrivable: number | null;
  pendingRedrive: number | null;
}

export interface MapRunDetails extends MapRunRef {
  executionArn: string;
  /** RUNNING, SUCCEEDED, FAILED or ABORTED. */
  status: string;
  /** 0 = no limit. */
  maxConcurrency: number;
  toleratedFailurePercentage: number;
  toleratedFailureCount: number;
  items: MapRunCounts;
  executions: MapRunCounts;
  redriveCount: number | null;
  redriveDate: string | null;
}

export interface MapRunChange {
  maxConcurrency?: number;
  toleratedFailurePercentage?: number;
  toleratedFailureCount?: number;
}

/** "arn:…:stateMachine:orders" + "Fan:uuid" → "arn:…:mapRun:orders/Fan:uuid". */
export function mapRunArn(machineArn: string, id: string): string {
  return `${machineArn.replace(":stateMachine:", ":mapRun:")}/${id}`;
}

/** Child executions of a map run are named "label:uuid" in places (execution names never contain ":"). */
export const isChildExecution = (name: string) => name.includes(":");

export interface StartRequest {
  machineArn: string;
  /** A version number or alias name; null runs the latest definition. */
  qualifier: string | null;
  /** null lets AWS name it. */
  name: string | null;
  input: string;
}

export interface SavedInput {
  name: string;
  input: string;
}

/** Why AWS would refuse an execution name (null if it wouldn't); the backend checks too. */
export function executionNameProblem(name: string): string | null {
  if (!name) return null;
  if ([...name].length > 80) return "Execution names are at most 80 characters";
  const bad = [...name].find((c) => /\s/.test(c) || c < " " || '<>{}[]?*"#%\\^|~`$&,;:/'.includes(c));
  return bad ? `Execution names can't contain ${/\s/.test(bad) ? "spaces" : `"${bad}"`}` : null;
}

/** Statuses an execution can be redriven from (Standard machines only). */
export const REDRIVABLE = ["FAILED", "ABORTED", "TIMED_OUT"];

/** "arn:aws:states:r:a:stateMachine:orders" + "run-1" → "arn:aws:states:r:a:execution:orders:run-1". */
export function executionArn(machineArn: string, execution: string): string {
  // A map run's child ("Fan:uuid") lives under "<machine>/Fan:uuid".
  return `${machineArn.replace(":stateMachine:", ":execution:")}${execution.includes(":") ? "/" : ":"}${execution}`;
}

/** "arn:…:execution:orders/Fan:uuid" → "Fan:uuid"; "arn:…:execution:orders:run-1" → "run-1". */
export function executionPlaceName(arn: string): string {
  const tail = arn.slice(arn.indexOf(":execution:") + ":execution:".length);
  const slash = tail.indexOf("/");
  return slash >= 0 ? tail.slice(slash + 1) : tail.slice(tail.indexOf(":") + 1);
}

/** The part after the last ":" of an ARN (a version number, an alias or execution name). */
export const arnTail = (arn: string) => arn.slice(arn.lastIndexOf(":") + 1);

/** Tone for a status pill. */
export function statusTone(s: string | null | undefined): "ok" | "bad" | "busy" | "off" {
  if (s === "SUCCEEDED" || s === "ACTIVE") return "ok";
  if (s === "FAILED" || s === "TIMED_OUT" || s === "ABORTED") return "bad";
  if (s === "RUNNING" || s === "PENDING_REDRIVE" || s === "DELETING") return "busy";
  return "off";
}

/** The `…EventDetails` object of an event, if any. */
export function eventDetails(e: HistoryEvent): Record<string, unknown> | null {
  for (const [k, v] of Object.entries(e)) if (k.endsWith("EventDetails") && v && typeof v === "object") return v as Record<string, unknown>;
  return null;
}

/** States in the definition, top level first then nested branches / iterators, for the states table. */
export interface StateRow {
  name: string;
  type: string;
  /** "" top level; "Parallel › branch 1" etc. inside. */
  path: string;
  next: string;
  resource: string;
  comment: string;
}

export function definitionStates(definition: string): { start: string; rows: StateRow[]; queryLanguage: string } | null {
  let asl: unknown;
  try {
    asl = JSON.parse(definition);
  } catch {
    return null;
  }
  if (!asl || typeof asl !== "object") return null;
  const rows: StateRow[] = [];
  const walk = (machine: Record<string, unknown>, path: string) => {
    const states = (machine.States ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, s] of Object.entries(states)) {
      if (!s || typeof s !== "object") continue;
      const type = String(s.Type ?? "");
      let next = s.End ? "(end)" : typeof s.Next === "string" ? s.Next : "";
      if (type === "Choice") {
        const targets = ((s.Choices as Record<string, unknown>[] | undefined) ?? []).map((c) => c?.Next).filter((n): n is string => typeof n === "string");
        if (typeof s.Default === "string") targets.push(`${s.Default} (default)`);
        next = targets.join(", ");
      }
      if (type === "Succeed" || type === "Fail") next = "(end)";
      rows.push({ name, type, path, next, resource: typeof s.Resource === "string" ? s.Resource : "", comment: typeof s.Comment === "string" ? s.Comment : "" });
      if (type === "Parallel") {
        ((s.Branches as Record<string, unknown>[] | undefined) ?? []).forEach((b, i) => b && walk(b, `${path ? `${path} › ` : ""}${name} › branch ${i + 1}`));
      }
      if (type === "Map") {
        const inner = (s.ItemProcessor ?? s.Iterator) as Record<string, unknown> | undefined;
        if (inner) walk(inner, `${path ? `${path} › ` : ""}${name} › items`);
      }
    }
  };
  const root = asl as Record<string, unknown>;
  walk(root, "");
  return { start: String(root.StartAt ?? ""), rows, queryLanguage: typeof root.QueryLanguage === "string" ? root.QueryLanguage : "JSONPath" };
}

/** A log group name or ARN → the ARN Step Functions wants ("…:log-group:<name>:*"), in the machine's account and region. */
export function logGroupArn(machineArn: string, value: string): string {
  const v = value.trim();
  if (!v || v.startsWith("arn:")) return v;
  const [, partition, , region, account] = machineArn.split(":");
  return `arn:${partition}:logs:${region}:${account}:log-group:${v}:*`;
}

/** Why AWS would refuse an alias name (the backend checks too). */
export function aliasNameProblem(name: string): string | null {
  if (!name || [...name].length > 80) return "Alias names are 1 to 80 characters";
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return "Alias names use letters, digits, -, _ and .";
  if (/^\d+$/.test(name)) return "An alias name can't be only digits (it would look like a version)";
  return null;
}
