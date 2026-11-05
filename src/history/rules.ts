// What the activity history records for each command: one rule per command,
// keyed by the Rust command name. A rule picks names and locations out of the
// command's arguments and result. Rules must NEVER copy values (parameter /
// secret values, message bodies, item contents, environment variables, SQL or
// PartiQL text, payloads).
//
// Every command that calls `ensure_writable` needs a rule here; a Rust test
// (history.rs, every_write_command_has_a_history_rule) checks it. Keep each
// rule key indented by two spaces and followed by a colon.
import type { HistoryService } from "../api/history";
import { DDB_ROOT, LAMBDA_ROOT, RDS_ROOT, SNS_ROOT, SQS_ROOT, type Place } from "../shell/places";

export interface Described {
  service: HistoryService;
  action: string;
  target: string;
  /** Where it happened; omitted = the place on screen when it ran. */
  place?: Place | null;
  /** Row to select at the place. */
  select?: string | null;
  detail?: string | null;
}

export interface RuleContext {
  /** The place on screen when the command ran. */
  place: Place;
}

// Arguments arrive as the UI passed them to invoke(); rules read them loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rule = (a: Args, result: any, ctx: RuleContext) => Described | null;

// ---------------------------------------------------------------------------
// Helpers

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const lastAfter = (s: string, sep: string) => s.slice(s.lastIndexOf(sep) + 1);
const base = (path: string) => lastAfter(path.replace(/[\\/]+$/, ""), path.includes("\\") ? "\\" : "/");
const firstWord = (sql: string) => (sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, "").match(/^[A-Za-z]+/)?.[0] ?? "").toUpperCase();

/** Folder prefix holding an S3 key (a folder key "a/b/" lives in "a/"). */
function s3Parent(key: string): string {
  const k = key.endsWith("/") ? key.slice(0, -1) : key;
  return k.slice(0, k.lastIndexOf("/") + 1);
}
const s3Uri = (bucket: string, key: string) => `s3://${bucket}/${key}`;
const s3Place = (bucket: string, prefix: string): Place => ({ service: "s3", bucket, prefix });

const ssmFolder = (name: string): Place & { service: "ssm" } => ({ service: "ssm", path: name.slice(0, name.lastIndexOf("/") + 1) || "/" });

/** Secret name from a name or ARN ("arn:…:secret:prod/db-AbCdEf" → "prod/db"). */
function secretName(id: string): string {
  if (!id.startsWith("arn:")) return id;
  const after = id.slice(id.indexOf(":secret:") + 8);
  return after.replace(/-[A-Za-z0-9]{6}$/, "");
}
const secretFolder = (id: string): Place => {
  const n = secretName(id);
  return { service: "secrets", path: n.slice(0, n.lastIndexOf("/") + 1) };
};

const queueFromUrl = (url: string) => lastAfter(url, "/");
const queueFromArn = (arn: string) => lastAfter(arn, ":");
const queuePlace = (name: string): Place => ({ service: "sqs", queue: name });
const topicFromArn = (arn: string) => lastAfter(arn, ":");
const topicPlace = (name: string): Place => ({ service: "sns", topic: name });
/** Subscription ARN "arn:aws:sns:r:a:topic:id" → "topic". */
const topicOfSubscription = (arn: string) => arn.split(":").slice(-2, -1)[0] ?? arn;

const tablePlace = (table: string): Place => ({ service: "dynamodb", table });
const fnPlace = (fn: string): Place => ({ service: "lambda", fn });
type DbKind = "cluster" | "instance";
const dbPlace = (kind: DbKind, id: string): Place => ({ service: "rds", kind, id });
const dbRow = (kind: DbKind, id: string) => `${kind === "cluster" ? "c" : "i"}:${id}`;

/** Changed field names of a patch object (values are never recorded). */
const fieldNames = (o: Args | null | undefined, skip: string[] = []) =>
  Object.entries(o ?? {})
    .filter(([k, v]) => v !== undefined && v !== null && !skip.includes(k))
    .map(([k]) => k)
    .join(", ");

/** "pk=abc, sk=12" from a DynamoDB JSON item's key attributes. */
function ddbKey(item: Args, keyAttrs: string[]): string {
  return keyAttrs
    .map((k) => {
      const v = item?.[k];
      const inner = v && typeof v === "object" ? Object.values(v)[0] : v;
      return `${k}=${String(inner).slice(0, 100)}`;
    })
    .join(", ");
}

const report = (r: { sent?: number; failed?: unknown[] } | undefined) =>
  r ? `${r.sent ?? 0} sent${r.failed?.length ? `, ${r.failed.length} failed` : ""}` : null;

// ---------------------------------------------------------------------------
// Rules

export const RULES: Record<string, Rule> = {
  // App
  connect: (a) => ({ service: "app", action: "Connect", target: a.profile, place: null }),
  set_read_only: (a) => ({ service: "app", action: a.enabled ? "Lock (read-only)" : "Allow changes", target: "", place: null }),

  // S3
  upload_paths: (a) => ({
    service: "s3",
    action: "Upload",
    target: s3Uri(a.bucket, a.prefix),
    place: s3Place(a.bucket, a.prefix),
    select: a.paths?.length === 1 ? a.prefix + base(a.paths[0]) : null,
    detail: a.paths?.length === 1 ? `from ${a.paths[0]}` : `${plural(a.paths?.length ?? 0, "item")} (started)`,
  }),
  create_folder: (a) => ({ service: "s3", action: "New folder", target: s3Uri(a.bucket, a.prefix), place: s3Place(a.bucket, s3Parent(a.prefix)), select: a.prefix }),
  delete_items: (a, r) => ({
    service: "s3",
    action: "Delete",
    target: a.items.length === 1 ? s3Uri(a.bucket, a.items[0]) : `${plural(a.items.length, "item")} in ${s3Uri(a.bucket, s3Parent(a.items[0] ?? ""))}`,
    place: s3Place(a.bucket, s3Parent(a.items[0] ?? "")),
    detail: r ? `${plural(r.deleted, "object")} deleted${r.failed?.length ? `, ${r.failed.length} failed` : ""}` : null,
  }),
  copy_items: (a) => {
    const first = a.pairs?.[0] ?? { from: "", to: "" };
    const one = a.pairs?.length === 1;
    return {
      service: "s3",
      action: a.isMove ? "Move" : "Copy",
      target: one ? s3Uri(a.dstBucket, first.to) : `${plural(a.pairs.length, "file")} to ${s3Uri(a.dstBucket, s3Parent(first.to))}`,
      place: s3Place(a.dstBucket, s3Parent(first.to)),
      select: one ? first.to : null,
      detail: `from ${s3Uri(a.srcBucket, one ? first.from : s3Parent(first.from))}`,
    };
  },
  run_sync: (_a, r, ctx) => ({
    service: "s3",
    action: "Sync",
    target: ctx.place.service === "s3" && ctx.place.bucket ? s3Uri(ctx.place.bucket, ctx.place.prefix) : "",
    detail: r ? `${plural(r.transferIds?.length ?? 0, "transfer")} started, ${plural(r.deleted ?? 0, "file")} deleted` : null,
  }),
  download_file: (a) => ({ service: "s3", action: "Download", target: s3Uri(a.bucket, a.key), place: s3Place(a.bucket, s3Parent(a.key)), select: a.key, detail: `to ${a.dest}` }),
  download_to_folder: (a) => ({
    service: "s3",
    action: "Download",
    target: a.items.length === 1 ? s3Uri(a.bucket, a.items[0]) : `${plural(a.items.length, "item")} from ${s3Uri(a.bucket, s3Parent(a.items[0] ?? ""))}`,
    place: s3Place(a.bucket, s3Parent(a.items[0] ?? "")),
    select: a.items.length === 1 ? a.items[0] : null,
    detail: `to ${a.dest}`,
  }),
  export_listing: (a) => ({ service: "s3", action: "Download list of contents", target: s3Uri(a.bucket, a.prefix), place: s3Place(a.bucket, a.prefix), detail: `to ${a.dest}` }),

  // Parameter Store
  ssm_put: (a) => ({
    service: "ssm",
    action: a.param.overwrite ? "Update parameter" : "Create parameter",
    target: a.param.name,
    place: ssmFolder(a.param.name),
    select: a.param.name,
    detail: a.param.paramType,
  }),
  ssm_delete: (a, r) => ({
    service: "ssm",
    action: a.names.length === 1 ? "Delete parameter" : "Delete parameters",
    target: a.names.length === 1 ? a.names[0] : `${plural(a.names.length, "parameter")} in ${ssmFolder(a.names[0] ?? "/").path}`,
    place: ssmFolder(a.names[0] ?? "/"),
    detail: r?.failed?.length ? `${r.deleted.length} deleted, ${r.failed.length} failed` : null,
  }),
  ssm_label: (a) => ({ service: "ssm", action: "Add labels", target: a.name, place: ssmFolder(a.name), select: a.name, detail: `version ${a.version}: ${a.labels.join(", ")}` }),
  ssm_unlabel: (a) => ({ service: "ssm", action: "Remove labels", target: a.name, place: ssmFolder(a.name), select: a.name, detail: `version ${a.version}: ${a.labels.join(", ")}` }),
  ssm_restore: (a, r) => ({ service: "ssm", action: "Restore version", target: a.name, place: ssmFolder(a.name), select: a.name, detail: `version ${a.version}${r ? ` saved as version ${r}` : ""}` }),
  ssm_set_tags: (a) => ({ service: "ssm", action: "Set tags", target: a.name, place: ssmFolder(a.name), select: a.name, detail: plural(a.tags?.length ?? 0, "tag") }),
  ssm_update_tier_policies: (a) => ({ service: "ssm", action: "Change tier / policies", target: a.name, place: ssmFolder(a.name), select: a.name, detail: a.tier ? `tier ${a.tier}` : null }),
  ssm_copy: (a, r) => {
    const first = a.pairs?.[0] ?? { from: "/", to: "/" };
    const one = a.pairs?.length === 1;
    return {
      service: "ssm",
      action: a.removeSource ? "Move parameters" : "Copy parameters",
      target: one ? `${first.from} → ${first.to}` : `${plural(a.pairs.length, "parameter")} to ${ssmFolder(first.to).path}`,
      place: ssmFolder(first.to),
      select: one ? first.to : null,
      detail: r ? `${r.copied.length} done${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}${r.failed.length ? `, ${r.failed.length} failed` : ""}` : null,
    };
  },
  ssm_run_import: (_a, r, ctx) => ({
    service: "ssm",
    action: "Import parameters",
    target: ctx.place.service === "ssm" ? ctx.place.path : "",
    detail: r ? `${r.created} created, ${r.overwritten} overwritten${r.failed.length ? `, ${r.failed.length} failed` : ""}` : null,
  }),
  ssm_export: (a) => ({
    service: "ssm",
    action: "Export parameters",
    target: a.folder,
    place: { service: "ssm", path: a.folder },
    detail: `${a.format}${a.includeSecrets ? ", decrypted values included" : ""} to ${a.dest}`,
  }),

  // SQS
  sqs_create_queue: (a) => ({ service: "sqs", action: "Create queue", target: a.name, place: queuePlace(a.name) }),
  sqs_set_attributes: (a) => ({ service: "sqs", action: "Edit queue settings", target: queueFromUrl(a.url), place: queuePlace(queueFromUrl(a.url)), detail: fieldNames(a.attributes) }),
  sqs_set_tags: (a) => ({ service: "sqs", action: "Set tags", target: queueFromUrl(a.url), place: queuePlace(queueFromUrl(a.url)), detail: plural(Object.keys(a.tags ?? {}).length, "tag") }),
  sqs_delete_queue: (a) => ({ service: "sqs", action: "Delete queue", target: queueFromUrl(a.url), place: SQS_ROOT, select: queueFromUrl(a.url) }),
  sqs_purge: (a) => ({ service: "sqs", action: "Purge queue", target: queueFromUrl(a.url), place: queuePlace(queueFromUrl(a.url)) }),
  sqs_send: (a, r) => ({ service: "sqs", action: "Send message", target: queueFromUrl(a.url), place: queuePlace(queueFromUrl(a.url)), detail: r?.messageId ? `message ${r.messageId}` : null }),
  sqs_send_batch: (a, r) => ({ service: "sqs", action: "Send messages", target: queueFromUrl(a.url), place: queuePlace(queueFromUrl(a.url)), detail: report(r) ?? plural(a.messages?.length ?? 0, "message") }),
  sqs_send_file: (a, r) => ({ service: "sqs", action: "Send messages from file", target: queueFromUrl(a.url), place: queuePlace(queueFromUrl(a.url)), detail: `${a.path}${r ? `: ${report(r)}` : ""}` }),
  sqs_delete_messages: (a) => ({ service: "sqs", action: "Delete messages", target: queueFromUrl(a.url), place: queuePlace(queueFromUrl(a.url)), detail: plural(a.receiptHandles?.length ?? 0, "message") }),
  sqs_start_redrive: (a) => ({
    service: "sqs",
    action: "Start redrive",
    target: queueFromArn(a.dlqArn),
    place: queuePlace(queueFromArn(a.dlqArn)),
    detail: a.destinationArn ? `to ${queueFromArn(a.destinationArn)}` : "to the source queues",
  }),
  sqs_move_messages: (a, r) => ({
    service: "sqs",
    action: "Move messages",
    target: queueFromUrl(a.fromUrl),
    place: queuePlace(queueFromUrl(a.fromUrl)),
    detail: `to ${queueFromUrl(a.toUrl)}${r ? `: ${report(r)}` : ""}`,
  }),
  sqs_export_messages: (a) => ({ service: "sqs", action: "Export messages", target: a.path, detail: plural(a.messages?.length ?? 0, "message") }),

  // SNS
  sns_create_topic: (a) => ({ service: "sns", action: "Create topic", target: a.name, place: topicPlace(a.name) }),
  sns_set_topic_attributes: (a) => ({ service: "sns", action: "Edit topic settings", target: topicFromArn(a.arn), place: topicPlace(topicFromArn(a.arn)), detail: fieldNames(a.attributes) }),
  sns_set_tags: (a) => ({ service: "sns", action: "Set tags", target: topicFromArn(a.arn), place: topicPlace(topicFromArn(a.arn)), detail: plural(a.tags?.length ?? 0, "tag") }),
  sns_put_data_protection_policy: (a) => ({ service: "sns", action: "Edit data protection policy", target: topicFromArn(a.arn), place: topicPlace(topicFromArn(a.arn)) }),
  sns_delete_topic: (a) => ({ service: "sns", action: "Delete topic", target: topicFromArn(a.arn), place: SNS_ROOT, select: topicFromArn(a.arn) }),
  sns_subscribe: (a) => ({ service: "sns", action: "Subscribe", target: topicFromArn(a.topicArn), place: topicPlace(topicFromArn(a.topicArn)), detail: `${a.protocol}: ${a.endpoint}` }),
  sns_confirm_subscription: (a) => ({ service: "sns", action: "Confirm subscription", target: topicFromArn(a.topicArn), place: topicPlace(topicFromArn(a.topicArn)) }),
  sns_unsubscribe: (a) => ({ service: "sns", action: "Unsubscribe", target: a.arn, place: topicPlace(topicOfSubscription(a.arn)) }),
  sns_set_subscription_attributes: (a) => ({ service: "sns", action: "Edit subscription", target: a.arn, place: topicPlace(topicOfSubscription(a.arn)), detail: fieldNames(a.attributes) }),
  sns_allow_topic_on_queue: (a, r) => ({
    service: "sqs",
    action: "Allow topic in queue policy",
    target: queueFromArn(a.queueArn),
    place: queuePlace(queueFromArn(a.queueArn)),
    detail: `${topicFromArn(a.topicArn)}${r === false ? " (already allowed)" : ""}`,
  }),
  sns_publish: (a, r) => ({ service: "sns", action: "Publish message", target: topicFromArn(a.topicArn), place: topicPlace(topicFromArn(a.topicArn)), detail: r?.messageId ? `message ${r.messageId}` : null }),
  sns_publish_batch: (a, r) => ({ service: "sns", action: "Publish messages", target: topicFromArn(a.topicArn), place: topicPlace(topicFromArn(a.topicArn)), detail: report(r) ?? plural(a.messages?.length ?? 0, "message") }),
  sns_publish_file: (a, r) => ({ service: "sns", action: "Publish messages from file", target: topicFromArn(a.topicArn), place: topicPlace(topicFromArn(a.topicArn)), detail: `${a.path}${r ? `: ${report(r)}` : ""}` }),
  sns_watch_start: (a) => ({ service: "sns", action: "Start watching", target: topicFromArn(a.topicArn), place: topicPlace(topicFromArn(a.topicArn)) }),
  sns_watch_clean_leftovers: (_a, r) => ({ service: "sns", action: "Clean up watch leftovers", target: "", place: SNS_ROOT, detail: typeof r === "number" ? plural(r, "item") + " removed" : null }),

  // DynamoDB
  ddb_put_item: (a) => ({
    service: "dynamodb",
    action: a.mustExist === false ? "Create item" : a.mustExist ? "Update item" : "Put item",
    target: a.table,
    place: tablePlace(a.table),
    detail: ddbKey(a.item, a.keyAttrs ?? []),
  }),
  ddb_delete_items: (a, r) => ({
    service: "dynamodb",
    action: "Delete items",
    target: a.table,
    place: tablePlace(a.table),
    detail: a.keys?.length === 1 ? ddbKey(a.keys[0], Object.keys(a.keys[0])) : plural(a.keys?.length ?? 0, "item") + (r?.failed?.length ? `, ${r.failed.length} failed` : ""),
  }),
  ddb_execute: (a) => {
    // Reads (and further pages) aren't changes; the statement text is never recorded.
    const verb = firstWord(a.statement ?? "");
    if (verb === "SELECT" || a.nextToken) return null;
    const table = (a.statement as string).match(/\b(?:update|into|from)\s+"?([A-Za-z0-9_.-]+)"?/i)?.[1];
    return { service: "dynamodb", action: `PartiQL ${verb || "statement"}`, target: table ?? "", place: table ? tablePlace(table) : undefined };
  },
  ddb_run_import: (_a, r, ctx) => ({
    service: "dynamodb",
    action: "Import items",
    target: ctx.place.service === "dynamodb" ? (ctx.place.table ?? "") : "",
    detail: r ? `${r.written} written, ${r.skippedExisting} skipped${r.failed?.length ? `, ${r.failed.length} failed` : ""}` : null,
  }),
  ddb_export_items: (a) => ({ service: "dynamodb", action: "Export items", target: a.dest, detail: `${plural(a.items?.length ?? 0, "item")} as ${a.format}` }),
  ddb_export_table: (a, r) => ({ service: "dynamodb", action: "Export table", target: a.table, place: tablePlace(a.table), detail: `${r ? plural(r[0], "item") + " " : ""}to ${a.dest}` }),
  ddb_create_table: (a) => ({ service: "dynamodb", action: "Create table", target: a.spec.name, place: tablePlace(a.spec.name) }),
  ddb_delete_table: (a) => ({ service: "dynamodb", action: "Delete table", target: a.name, place: DDB_ROOT, select: a.name }),
  ddb_add_gsi: (a) => ({ service: "dynamodb", action: "Add index", target: a.table, place: tablePlace(a.table), detail: a.index?.name }),
  ddb_delete_gsi: (a) => ({ service: "dynamodb", action: "Delete index", target: a.table, place: tablePlace(a.table), detail: a.index }),
  ddb_update_settings: (a) => ({ service: "dynamodb", action: "Change table settings", target: a.table, place: tablePlace(a.table), detail: fieldNames(a.patch) }),
  ddb_create_backup: (a) => ({ service: "dynamodb", action: "Create backup", target: a.table, place: tablePlace(a.table), detail: a.name }),
  ddb_restore_backup: (a) => ({ service: "dynamodb", action: "Restore backup", target: a.target, place: tablePlace(a.target), detail: `from ${a.backupArn}` }),
  ddb_delete_backup: (a) => {
    const table = (a.backupArn as string).match(/:table\/([^/]+)\//)?.[1];
    return { service: "dynamodb", action: "Delete backup", target: a.backupArn, place: table ? tablePlace(table) : undefined };
  },

  // RDS
  rds_start: (a) => ({ service: "rds", action: "Start", target: a.id, place: dbPlace(a.kind, a.id) }),
  rds_stop: (a) => ({ service: "rds", action: "Stop", target: a.id, place: dbPlace(a.kind, a.id) }),
  rds_reboot: (a) => ({ service: "rds", action: a.forceFailover ? "Reboot with failover" : "Reboot", target: a.id, place: dbPlace(a.kind, a.id) }),
  rds_failover: (a) => ({ service: "rds", action: "Fail over", target: a.clusterId, place: dbPlace("cluster", a.clusterId), detail: a.target ? `to ${a.target}` : null }),
  rds_modify: (a) => ({ service: "rds", action: "Modify", target: a.id, place: dbPlace(a.kind, a.id), detail: fieldNames(a.request) }),
  rds_delete: (a) => ({ service: "rds", action: "Delete", target: a.id, place: RDS_ROOT, select: dbRow(a.kind, a.id), detail: a.request?.finalSnapshotId ? `final snapshot ${a.request.finalSnapshotId}` : null }),
  rds_create_snapshot: (a) => ({ service: "rds", action: "Create snapshot", target: a.snapshotId, place: dbPlace(a.kind, a.id), detail: `of ${a.id}` }),
  rds_copy_snapshot: (a) => ({ service: "rds", action: "Copy snapshot", target: a.target, detail: `from ${a.source}` }),
  rds_delete_snapshot: (a) => ({ service: "rds", action: "Delete snapshot", target: a.snapshotId }),
  rds_restore: (a, r) => {
    const id = (r as string) || a.request.newId;
    return {
      service: "rds",
      action: a.request.snapshotId ? "Restore snapshot" : "Point-in-time restore",
      target: id,
      place: dbPlace(a.kind, id),
      detail: `from ${a.request.snapshotId ?? a.request.sourceDbId ?? ""}`,
    };
  },
  rds_execute_sql: (a) => {
    // Read-only runs are always rolled back; the SQL text is never recorded.
    if (a.request.readOnly) return null;
    const id = lastAfter(a.request.clusterArn, ":");
    return { service: "rds", action: `SQL ${firstWord(a.request.sql) || "statement"}`, target: id, place: dbPlace("cluster", id), detail: a.request.database ? `database ${a.request.database}` : null };
  },
  rds_log_download: (a) => ({ service: "rds", action: "Download log file", target: a.file, detail: `${a.id} to ${a.dest}` }),
  rds_save_result: (a) => ({ service: "rds", action: "Save SQL results", target: a.dest, detail: `${plural(a.rows?.length ?? 0, "row")} as ${a.format}` }),

  // ECS
  ecs_update_service: (a) => ({
    service: "ecs",
    action:
      a.change?.desired != null ? `Scale to ${a.change.desired}` : a.change?.taskDefinition ? "Change revision" : a.change?.forceNewDeployment ? "Redeploy" : "Update service",
    target: `${a.cluster}/${a.service}`,
    place: { service: "ecs", cluster: a.cluster, view: "service", id: a.service },
    detail: a.change?.taskDefinition ?? null,
  }),
  ecs_stop_task: (a) => ({ service: "ecs", action: "Stop task", target: `${a.cluster}/${a.task}`, place: { service: "ecs", cluster: a.cluster, view: "task", id: a.task }, detail: a.reason || null }),
  ecs_run_task: (a, r) => ({
    service: "ecs",
    action: "Run task",
    target: a.request.taskDefinition,
    place: { service: "ecs", cluster: a.request.cluster, view: null, id: null },
    detail: `${plural(Array.isArray(r) ? r.length : a.request.count, "task")} in ${a.request.cluster}`,
  }),
  ecs_register_task_definition: (_a, r) => {
    const name = typeof r === "string" ? lastAfter(r, "/") : "";
    const family = name.split(":")[0];
    return { service: "ecs", action: "Register task definition", target: name, place: { service: "ecs", cluster: null, view: "taskdefs", id: family || null } };
  },
  ecs_deregister_task_definition: (a) => ({
    service: "ecs",
    action: "Deregister task definition",
    target: a.name,
    place: { service: "ecs", cluster: null, view: "taskdefs", id: lastAfter(a.name, "/").split(":")[0] },
  }),

  // Lambda
  lambda_invoke: (a, r) => ({
    service: "lambda",
    action: a.request.asynchronous ? "Invoke (async)" : "Invoke",
    target: a.request.qualifier ? `${a.request.name}:${a.request.qualifier}` : a.request.name,
    place: fnPlace(a.request.name),
    detail: r ? `status ${r.statusCode}${r.functionError ? `, ${r.functionError}` : ""}` : null,
  }),
  lambda_update_config: (a) => ({ service: "lambda", action: "Change settings", target: a.name, place: fnPlace(a.name), detail: fieldNames(a.change, ["revisionId"]).replace("env", "environment variables") }),
  lambda_set_concurrency: (a) => ({ service: "lambda", action: "Set reserved concurrency", target: a.name, place: fnPlace(a.name), detail: a.reserved == null ? "unreserved" : String(a.reserved) }),
  lambda_set_mapping_enabled: (a) => ({ service: "lambda", action: a.enabled ? "Enable trigger" : "Disable trigger", target: a.uuid }),
  lambda_publish_version: (a, r) => ({ service: "lambda", action: "Publish version", target: a.name, place: fnPlace(a.name), detail: r ? `version ${r}` : null }),
  lambda_save_alias: (a) => ({
    service: "lambda",
    action: a.update ? "Edit alias" : "Create alias",
    target: `${a.name}:${a.alias.alias}`,
    place: fnPlace(a.name),
    detail: `version ${a.alias.version}${a.alias.extra ? ` + ${a.alias.extra[0]} (${Math.round(a.alias.extra[1] * 100)}%)` : ""}`,
  }),
  lambda_delete_alias: (a) => ({ service: "lambda", action: "Delete alias", target: `${a.name}:${a.alias}`, place: fnPlace(a.name) }),
  lambda_delete_version: (a) => ({ service: "lambda", action: "Delete version", target: `${a.name}:${a.version}`, place: fnPlace(a.name) }),
  lambda_delete_function: (a) => ({ service: "lambda", action: "Delete function", target: a.name, place: LAMBDA_ROOT, select: a.name }),
  lambda_upload_code: (a) => ({
    service: "lambda",
    action: "Upload code",
    target: a.request.name,
    place: fnPlace(a.request.name),
    detail: `${a.request.source.kind === "zip" ? a.request.source.path : s3Uri(a.request.source.bucket, a.request.source.key)}${a.request.publish ? ", published" : ""}`,
  }),
  lambda_download_code: (a) => ({ service: "lambda", action: "Download code", target: a.qualifier ? `${a.name}:${a.qualifier}` : a.name, place: fnPlace(a.name), detail: `to ${a.dest}` }),

  // CloudWatch Logs
  logs_download: (a) => ({ service: "logs", action: "Download log events", target: a.request.group, place: { service: "logs", group: a.request.group }, detail: `to ${a.dest}` }),

  // Bookmarks (local; only exporting and importing are recorded)
  bookmarks_export: (a) => ({ service: "app", action: "Export bookmarks", target: a.dest, place: null, detail: plural(a.file?.bookmarks?.length ?? 0, "bookmark") }),
  bookmarks_save: (a) => {
    const r = typeof a.reason === "string" ? a.reason.split("|") : [];
    if (r[0] !== "import") return null;
    return { service: "app", action: "Import bookmarks", target: r.slice(3).join("|"), place: null, detail: `${plural(Number(r[1]) || 0, "bookmark")} added, ${Number(r[2]) || 0} duplicates skipped` };
  },

  // Secrets Manager
  sm_create: (a) => ({ service: "secrets", action: "Create secret", target: a.name, place: secretFolder(a.name), select: a.name }),
  sm_put_value: (a) => ({ service: "secrets", action: "Update secret value", target: secretName(a.id), place: secretFolder(a.id), select: secretName(a.id) }),
  sm_update_metadata: (a) => ({ service: "secrets", action: "Edit description / KMS key", target: secretName(a.id), place: secretFolder(a.id), select: secretName(a.id) }),
  sm_delete: (a) => ({
    service: "secrets",
    action: a.force ? "Delete secret now" : "Schedule secret deletion",
    target: secretName(a.id),
    place: secretFolder(a.id),
    select: a.force ? null : secretName(a.id),
    detail: a.force ? "no recovery window" : `${a.recoveryDays ?? 30}-day recovery window`,
  }),
  sm_restore: (a) => ({ service: "secrets", action: "Restore secret", target: secretName(a.id), place: secretFolder(a.id), select: secretName(a.id) }),
  sm_move_label: (a) => ({
    service: "secrets",
    action: "Move staging label",
    target: secretName(a.id),
    place: secretFolder(a.id),
    select: secretName(a.id),
    detail: `${a.stage}${a.from ? ` from ${a.from}` : ""}${a.to ? ` to ${a.to}` : " removed"}`,
  }),
  sm_configure_rotation: (a) => ({ service: "secrets", action: "Configure rotation", target: secretName(a.id), place: secretFolder(a.id), select: secretName(a.id), detail: `${a.schedule}${a.rotateNow ? ", rotate now" : ""}` }),
  sm_rotate_now: (a) => ({ service: "secrets", action: "Rotate now", target: secretName(a.id), place: secretFolder(a.id), select: secretName(a.id) }),
  sm_cancel_rotation: (a) => ({ service: "secrets", action: "Turn off rotation", target: secretName(a.id), place: secretFolder(a.id), select: secretName(a.id) }),
  sm_set_tags: (a) => ({ service: "secrets", action: "Set tags", target: secretName(a.id), place: secretFolder(a.id), select: secretName(a.id), detail: plural(a.tags?.length ?? 0, "tag") }),
  sm_put_policy: (a) => ({ service: "secrets", action: "Set resource policy", target: secretName(a.id), place: secretFolder(a.id), select: secretName(a.id) }),
  sm_delete_policy: (a) => ({ service: "secrets", action: "Remove resource policy", target: secretName(a.id), place: secretFolder(a.id), select: secretName(a.id) }),
};
