// A "place" is anywhere the main panel can show: Home (the list of services) or
// a location inside a service. History, the address bar and Up work on places.
import { breadcrumbs as s3Crumbs, parentOf as s3Parent, sameLocation, toS3Uri, type Location } from "../state/navigation";

export type ServiceId = "s3" | "ssm" | "sqs" | "sns" | "dynamodb" | "rds" | "ecs" | "lambda" | "logs" | "secrets";

export type Place =
  | { service: "home" }
  | ({ service: "s3" } & Location)
  /** Parameter Store folder: "/" or "/a/b/". */
  | { service: "ssm"; path: string }
  /** SQS: the queue list (null) or one queue, by name. */
  | { service: "sqs"; queue: string | null }
  /** SNS: the topic list (null) or one topic, by name. */
  | { service: "sns"; topic: string | null }
  /** DynamoDB: the table list (null) or one table. */
  | { service: "dynamodb"; table: string | null }
  /** RDS: the database list (kind null) or one cluster / instance. */
  | { service: "rds"; kind: "cluster" | "instance" | null; id: string | null }
  /** ECS: clusters (cluster null), a cluster, or one of its services / tasks;
   *  or task definitions (cluster null, view "taskdefs", id = family or null). */
  | { service: "ecs"; cluster: string | null; view: "service" | "task" | "taskdefs" | null; id: string | null }
  /** Lambda: the function list (null) or one function. */
  | { service: "lambda"; fn: string | null }
  /** CloudWatch Logs: the log group list (null) or one group. */
  | { service: "logs"; group: string | null }
  /** Secrets Manager folder: "" (root) or a name prefix ending in "/" ("prod/app/"). */
  | { service: "secrets"; path: string };

export const HOME: Place = { service: "home" };
export const S3_ROOT: Place = { service: "s3", bucket: null, prefix: "" };
export const SSM_ROOT: Place = { service: "ssm", path: "/" };
export const SQS_ROOT: Place = { service: "sqs", queue: null };
export const SNS_ROOT: Place = { service: "sns", topic: null };
export const DDB_ROOT: Place = { service: "dynamodb", table: null };
export const RDS_ROOT: Place = { service: "rds", kind: null, id: null };
export const ECS_ROOT: Place = { service: "ecs", cluster: null, view: null, id: null };
export const LAMBDA_ROOT: Place = { service: "lambda", fn: null };
export const LOGS_ROOT: Place = { service: "logs", group: null };
export const SECRETS_ROOT: Place = { service: "secrets", path: "" };

export interface ServiceInfo {
  id: ServiceId;
  name: string;
  description: string;
  root: Place;
}

/** Services shown on Home and in the tree, in display order. */
export const SERVICES: ServiceInfo[] = [
  { id: "s3", name: "Amazon S3", description: "Buckets, folders and files", root: S3_ROOT },
  { id: "ssm", name: "Parameter Store", description: "Configuration values and secrets (SSM)", root: SSM_ROOT },
  { id: "sqs", name: "SQS", description: "Message queues", root: SQS_ROOT },
  { id: "sns", name: "SNS", description: "Topics and subscriptions", root: SNS_ROOT },
  { id: "dynamodb", name: "DynamoDB", description: "Tables and items", root: DDB_ROOT },
  { id: "rds", name: "RDS", description: "Relational databases: instances, Aurora clusters, snapshots", root: RDS_ROOT },
  { id: "ecs", name: "ECS", description: "Clusters, services, tasks and task definitions", root: ECS_ROOT },
  { id: "lambda", name: "Lambda", description: "Functions: configuration, triggers, invoke, logs", root: LAMBDA_ROOT },
  { id: "logs", name: "CloudWatch Logs", description: "Log groups, streams and events", root: LOGS_ROOT },
  { id: "secrets", name: "Secrets Manager", description: "Secrets, versions and rotation", root: SECRETS_ROOT },
];

export function samePlace(a: Place, b: Place): boolean {
  if (a.service !== b.service) return false;
  if (a.service === "s3" && b.service === "s3") return sameLocation(a, b);
  if (a.service === "ssm" && b.service === "ssm") return a.path === b.path;
  if (a.service === "sqs" && b.service === "sqs") return a.queue === b.queue;
  if (a.service === "sns" && b.service === "sns") return a.topic === b.topic;
  if (a.service === "dynamodb" && b.service === "dynamodb") return a.table === b.table;
  if (a.service === "rds" && b.service === "rds") return a.kind === b.kind && a.id === b.id;
  if (a.service === "ecs" && b.service === "ecs") return a.cluster === b.cluster && a.view === b.view && a.id === b.id;
  if (a.service === "lambda" && b.service === "lambda") return a.fn === b.fn;
  if (a.service === "logs" && b.service === "logs") return a.group === b.group;
  if (a.service === "secrets" && b.service === "secrets") return a.path === b.path;
  return true;
}

/** Address-bar segments after the root ("AWS"). */
export function placeCrumbs(p: Place): { label: string; place: Place }[] {
  if (p.service === "home") return [];
  const info = SERVICES.find((s) => s.id === p.service)!;
  const out = [{ label: info.name, place: info.root }];
  if (p.service === "s3") {
    for (const c of s3Crumbs(p)) out.push({ label: c.label, place: { service: "s3", ...c.loc } });
  }
  if (p.service === "ssm") {
    let acc = "/";
    for (const seg of p.path.split("/").filter(Boolean)) {
      acc += seg + "/";
      out.push({ label: seg, place: { service: "ssm", path: acc } });
    }
  }
  if (p.service === "sqs" && p.queue) out.push({ label: p.queue, place: p });
  if (p.service === "sns" && p.topic) out.push({ label: p.topic, place: p });
  if (p.service === "dynamodb" && p.table) out.push({ label: p.table, place: p });
  if (p.service === "rds" && p.id) out.push({ label: p.id, place: p });
  if (p.service === "ecs" && p.view === "taskdefs") {
    out.push({ label: "Task definitions", place: { service: "ecs", cluster: null, view: "taskdefs", id: null } });
    if (p.id) out.push({ label: p.id, place: p });
  }
  if (p.service === "ecs" && p.cluster) {
    out.push({ label: p.cluster, place: { service: "ecs", cluster: p.cluster, view: null, id: null } });
    if (p.view && p.id) out.push({ label: p.view === "task" ? `task ${p.id.slice(0, 8)}` : p.id, place: p });
  }
  if (p.service === "lambda" && p.fn) out.push({ label: p.fn, place: p });
  if (p.service === "logs" && p.group) out.push({ label: p.group, place: p });
  if (p.service === "secrets") {
    let acc = "";
    for (const seg of p.path.split("/").slice(0, -1)) {
      acc += seg + "/";
      out.push({ label: seg || "(unnamed)", place: { service: "secrets", path: acc } });
    }
  }
  return out;
}

/** One level up: folder → parent → bucket → service root → Home. */
export function parentPlace(p: Place): Place | null {
  if (p.service === "home") return null;
  if (p.service === "s3") {
    const up = s3Parent(p);
    return up ? { service: "s3", ...up } : HOME;
  }
  if (p.service === "ssm") {
    if (p.path === "/") return HOME;
    const trimmed = p.path.slice(0, -1);
    return { service: "ssm", path: trimmed.slice(0, trimmed.lastIndexOf("/") + 1) || "/" };
  }
  if (p.service === "sqs") return p.queue ? SQS_ROOT : HOME;
  if (p.service === "sns") return p.topic ? SNS_ROOT : HOME;
  if (p.service === "dynamodb") return p.table ? DDB_ROOT : HOME;
  if (p.service === "rds") return p.id ? RDS_ROOT : HOME;
  if (p.service === "ecs" && p.view === "taskdefs") return p.id ? { service: "ecs", cluster: null, view: "taskdefs", id: null } : ECS_ROOT;
  if (p.service === "ecs") return p.view ? { service: "ecs", cluster: p.cluster, view: null, id: null } : p.cluster ? ECS_ROOT : HOME;
  if (p.service === "lambda") return p.fn ? LAMBDA_ROOT : HOME;
  if (p.service === "logs") return p.group ? LOGS_ROOT : HOME;
  if (p.service === "secrets") {
    if (!p.path) return HOME;
    const t = p.path.slice(0, -1);
    return { service: "secrets", path: t.includes("/") ? t.slice(0, t.lastIndexOf("/") + 1) : "" };
  }
  return HOME;
}

/** Copyable address for the place ("" if none). */
export function placeUri(p: Place): string {
  if (p.service === "s3") return toS3Uri(p);
  if (p.service === "ssm") return p.path;
  if (p.service === "sqs") return p.queue ?? "";
  if (p.service === "sns") return p.topic ?? "";
  if (p.service === "dynamodb") return p.table ?? "";
  if (p.service === "rds") return p.id ?? "";
  if (p.service === "ecs") return p.id ?? p.cluster ?? "";
  if (p.service === "lambda") return p.fn ?? "";
  if (p.service === "logs") return p.group ?? "";
  if (p.service === "secrets") return p.path;
  return "";
}

/** Key for remounting per-place components. */
export function placeKey(p: Place): string {
  if (p.service === "s3") return `s3:${toS3Uri(p)}`;
  if (p.service === "ssm") return `ssm:${p.path}`;
  if (p.service === "sqs") return `sqs:${p.queue ?? ""}`;
  if (p.service === "sns") return `sns:${p.topic ?? ""}`;
  if (p.service === "dynamodb") return `ddb:${p.table ?? ""}`;
  if (p.service === "rds") return `rds:${p.kind ?? ""}:${p.id ?? ""}`;
  if (p.service === "ecs") return `ecs:${p.cluster ?? ""}:${p.view ?? ""}:${p.id ?? ""}`;
  if (p.service === "lambda") return `lambda:${p.fn ?? ""}`;
  if (p.service === "logs") return `logs:${p.group ?? ""}`;
  if (p.service === "secrets") return `sm:${p.path}`;
  return p.service;
}
