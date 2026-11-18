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
};

/** "arn:aws:states:r:a:stateMachine:orders" + "run-1" → "arn:aws:states:r:a:execution:orders:run-1". */
export function executionArn(machineArn: string, execution: string): string {
  return `${machineArn.replace(":stateMachine:", ":execution:")}:${execution}`;
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
