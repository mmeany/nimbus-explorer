// Lambda commands.
import { call } from "./core";

export interface FunctionSummary {
  name: string;
  arn: string;
  runtime: string | null;
  handler: string | null;
  memoryMb: number | null;
  timeoutSecs: number | null;
  architecture: string | null;
  /** Zip or Image. */
  packageType: string | null;
  codeSize: number;
  lastModified: string | null;
  description: string | null;
  state: string | null;
}

export interface FunctionDetails extends FunctionSummary {
  role: string | null;
  /** Names only; values via envValues on Reveal. */
  envKeys: string[];
  envError: string | null;
  layers: { arn: string; codeSize: number }[];
  vpc: { vpcId: string | null; subnets: string[]; securityGroups: string[] } | null;
  deadLetterTarget: string | null;
  kmsKey: string | null;
  tracing: string | null;
  ephemeralStorageMb: number | null;
  snapStart: string | null;
  logGroup: string;
  logFormat: string | null;
  stateReason: string | null;
  lastUpdateStatus: string | null;
  lastUpdateReason: string | null;
  version: string | null;
  revisionId: string | null;
  codeSha256: string | null;
  imageUri: string | null;
  tags: [string, string][];
  reservedConcurrency: number | null;
  url: { url: string; authType: string; invokeMode: string | null; cors: unknown } | null;
  invokeConfig: { maxRetries: number | null; maxAgeSecs: number | null; onSuccess: string | null; onFailure: string | null } | null;
}

export interface EventSourceMapping {
  uuid: string;
  sourceArn: string | null;
  state: string | null;
  batchSize: number | null;
  batchingWindowSecs: number | null;
  startingPosition: string | null;
  lastResult: string | null;
  lastModified: string | null;
  reportBatchItemFailures: boolean;
  filters: string[];
}

export interface Invoker {
  sid: string;
  principal: string;
  sourceArn: string | null;
  sourceAccount: string | null;
  action: string;
}

export interface Triggers {
  mappings: EventSourceMapping[];
  invokers: Invoker[];
  policy: string | null;
}

export interface Versions {
  versions: { version: string; description: string | null; lastModified: string | null; codeSha256: string | null; runtime: string | null }[];
  aliases: { name: string; arn: string; version: string; description: string | null; routing: [string, number][] }[];
  provisioned: { qualifier: string; requested: number | null; allocated: number | null; available: number | null; status: string | null }[];
}

export const lambdaApi = {
  list: () => call<FunctionSummary[]>("lambda_list"),
  get: (name: string) => call<FunctionDetails>("lambda_get", { name }),
  /** Environment variable values; only on Reveal, never cached. */
  envValues: (name: string) => call<Record<string, string>>("lambda_env_values", { name }),
  triggers: (name: string) => call<Triggers>("lambda_triggers", { name }),
  versions: (name: string) => call<Versions>("lambda_versions", { name }),
  /** Runs the function; refused in read-only mode. */
  invoke: (request: InvokeRequest) => call<InvokeResult>("lambda_invoke", { request }),
  testEvents: (key: string) => call<TestEvent[]>("lambda_test_events", { key }),
  saveTestEvent: (key: string, name: string, payload: string) => call<TestEvent[]>("lambda_save_test_event", { key, name, payload }),
  deleteTestEvent: (key: string, name: string) => call<TestEvent[]>("lambda_delete_test_event", { key, name }),
  updateConfig: (name: string, change: ConfigChange) => call<void>("lambda_update_config", { name, change }),
  /** n reserves n (0 = throttled); null removes the reservation. */
  setConcurrency: (name: string, reserved: number | null) => call<void>("lambda_set_concurrency", { name, reserved }),
  setMappingEnabled: (uuid: string, enabled: boolean) => call<void>("lambda_set_mapping_enabled", { uuid, enabled }),
  publishVersion: (name: string, description: string) => call<string>("lambda_publish_version", { name, description }),
  saveAlias: (name: string, alias: AliasRequest, update: boolean) => call<void>("lambda_save_alias", { name, alias, update }),
  deleteAlias: (name: string, alias: string) => call<void>("lambda_delete_alias", { name, alias }),
  deleteVersion: (name: string, version: string) => call<void>("lambda_delete_version", { name, version }),
  deleteFunction: (name: string) => call<void>("lambda_delete_function", { name }),
  /** Saves the deployment package of $LATEST or a version; returns bytes written. */
  downloadCode: (name: string, qualifier: string | null, dest: string) => call<number>("lambda_download_code", { name, qualifier, dest }),
  uploadCode: (request: UploadRequest) => call<{ version: string | null; codeSize: number; codeSha256: string | null }>("lambda_upload_code", { request }),
};

export interface UploadRequest {
  name: string;
  source: { kind: "zip"; path: string } | { kind: "s3"; bucket: string; key: string; version: string | null };
  publish: boolean;
  revisionId: string | null;
}

export interface ConfigChange {
  description?: string | null;
  memoryMb?: number | null;
  timeoutSecs?: number | null;
  /** The complete new set. */
  env?: Record<string, string> | null;
  revisionId?: string | null;
}

export interface AliasRequest {
  alias: string;
  version: string;
  description: string | null;
  /** A second version and its share of traffic (0–1). */
  extra: [string, number] | null;
}

/** Why an environment variable name is refused (null = fine). */
export function envKeyProblem(k: string): string | null {
  if (!k) return "Names can't be empty";
  if (!/^[A-Za-z]/.test(k)) return `${k}: names start with a letter`;
  if (!/^[A-Za-z0-9_]+$/.test(k)) return `${k}: names use letters, digits and _ only`;
  if (k.startsWith("AWS_")) return `${k}: names starting with AWS_ are reserved`;
  return null;
}

export interface InvokeRequest {
  name: string;
  qualifier: string | null;
  payload: string;
  asynchronous: boolean;
}

export interface InvokeResult {
  statusCode: number;
  functionError: string | null;
  payload: string;
  logTail: string | null;
  executedVersion: string | null;
  report: { requestId: string | null; durationMs: number | null; billedMs: number | null; memoryMb: number | null; maxMemoryUsedMb: number | null; initMs: number | null } | null;
  elapsedMs: number;
}

export interface TestEvent {
  name: string;
  payload: string;
}

/** "python3.12" → "Python 3.12"; images show as "Container image". */
export function runtimeLabel(runtime: string | null, packageType: string | null): string {
  if (packageType === "Image") return "Container image";
  if (!runtime) return "";
  const m = /^([a-z]+)([\d.x]+)?(.*)$/.exec(runtime);
  if (!m) return runtime;
  const names: Record<string, string> = { python: "Python", nodejs: "Node.js", java: "Java", dotnet: ".NET", ruby: "Ruby", go: "Go", provided: "Custom runtime" };
  const base = names[m[1]] ?? m[1];
  return `${base}${m[2] ? ` ${m[2].replace(/\.x$/, "")}` : ""}${m[3] ? ` (${m[3].replace(/^[.-]/, "")})` : ""}`;
}

/** The resource's service and name from an event source ARN. */
export function sourceLabel(arn: string | null): { service: string; name: string } {
  if (!arn) return { service: "", name: "" };
  const p = arn.split(":");
  const service = p[2] ?? "";
  const rest = p.slice(5).join(":");
  const label: Record<string, string> = { sqs: "SQS", dynamodb: "DynamoDB stream", kinesis: "Kinesis", kafka: "Kafka (MSK)", mq: "Amazon MQ", s3: "S3", sns: "SNS", events: "EventBridge", "execute-api": "API Gateway", logs: "CloudWatch Logs" };
  let name = rest;
  if (service === "dynamodb") name = rest.replace(/^table\//, "").replace(/\/stream\/.*$/, "");
  if (service === "kinesis") name = rest.replace(/^stream\//, "");
  if (service === "s3") name = p.slice(5).join(":") || arn.replace("arn:aws:s3:::", "");
  if (service === "events") name = rest.replace(/^rule\//, "");
  return { service: label[service] ?? service, name };
}
