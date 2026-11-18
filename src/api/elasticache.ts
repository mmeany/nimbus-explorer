// ElastiCache commands.
import { call } from "./core";

export interface Endpoint {
  address: string;
  port: number | null;
}

export interface Member {
  clusterId: string;
  nodeId: string | null;
  /** primary or replica (cluster mode off). */
  role: string | null;
  az: string | null;
  endpoint: Endpoint | null;
}

export interface Shard {
  id: string;
  status: string | null;
  /** Hash slots ("0-5461"), cluster mode on. */
  slots: string | null;
  primaryEndpoint: Endpoint | null;
  readerEndpoint: Endpoint | null;
  members: Member[];
}

export interface Group {
  id: string;
  arn: string | null;
  description: string | null;
  status: string | null;
  engine: string | null;
  nodeType: string | null;
  clusterMode: boolean;
  shards: Shard[];
  memberCount: number;
  automaticFailover: string | null;
  multiAz: string | null;
  configurationEndpoint: Endpoint | null;
  transitEncryption: boolean;
  transitEncryptionMode: string | null;
  atRestEncryption: boolean;
  kmsKeyId: string | null;
  authToken: boolean;
  authTokenLastModified: string | null;
  userGroupIds: string[];
  snapshotRetention: number | null;
  snapshotWindow: string | null;
  snapshottingCluster: string | null;
  dataTiering: string | null;
  networkType: string | null;
  ipDiscovery: string | null;
  autoMinorVersionUpgrade: boolean | null;
  globalDatastore: string | null;
  globalDatastoreRole: string | null;
  created: string | null;
  logDelivery: string[];
  pending: string[];
}

export interface GroupDetails extends Group {
  settings: {
    engineVersion: string | null;
    parameterGroup: string | null;
    parameterStatus: string | null;
    subnetGroup: string | null;
    securityGroups: string[];
    maintenanceWindow: string | null;
    notificationTopic: string | null;
  } | null;
  tags: [string, string][];
}

export interface Serverless {
  name: string;
  arn: string | null;
  description: string | null;
  status: string | null;
  engine: string | null;
  engineVersion: string | null;
  endpoint: Endpoint | null;
  readerEndpoint: Endpoint | null;
  limits: { storageMin: number | null; storageMax: number | null; storageUnit: string | null; ecpuMin: number | null; ecpuMax: number | null } | null;
  securityGroups: string[];
  subnets: string[];
  kmsKeyId: string | null;
  userGroupId: string | null;
  snapshotRetention: number | null;
  dailySnapshotTime: string | null;
  networkType: string | null;
  created: string | null;
  tags: [string, string][];
}

export const ecApi = {
  listGroups: () => call<Group[]>("ec_list_groups"),
  listServerless: () => call<Serverless[]>("ec_list_serverless"),
  group: (id: string) => call<GroupDetails>("ec_group", { id }),
  serverless: (name: string) => call<Serverless>("ec_serverless", { name }),
  /** Reboots nodes (member cluster ids) of a cluster-mode-off group; returns those rebooted. */
  rebootNodes: (group: string, nodes: string[]) => call<string[]>("ec_reboot_nodes", { group, nodes }),
  /** Promotes a replica of the shard ("0001" when cluster mode is off). */
  testFailover: (group: string, shard: string) => call<void>("ec_test_failover", { group, shard }),
};

/** "valkey" → "Valkey", "redis" → "Redis OSS". */
export function engineLabel(engine: string | null | undefined): string {
  if (!engine) return "";
  if (engine === "redis") return "Redis OSS";
  if (engine === "valkey") return "Valkey";
  if (engine === "memcached") return "Memcached";
  return engine;
}

export const endpointText = (e: Endpoint | null | undefined) => (e ? `${e.address}${e.port ? `:${e.port}` : ""}` : "");

/** Tone for a status pill: available is fine, *ing is busy, the rest needs a look. */
export function cacheTone(s: string | null | undefined): "ok" | "busy" | "bad" | "off" {
  if (!s) return "off";
  if (s === "available") return "ok";
  if (/ing$/.test(s) || s === "snapshotting") return "busy";
  if (s === "create-failed" || s === "incompatible-network" || s === "restore-failed") return "bad";
  return "off";
}

/** "1 GB – 10 GB, 1,000 – 5,000 ECPU/s" (either part may be missing). */
export function limitsText(l: Serverless["limits"]): string {
  if (!l) return "";
  const range = (min: number | null, max: number | null, unit: string) =>
    min === null && max === null ? "" : `${min !== null ? min.toLocaleString() : "0"} – ${max !== null ? max.toLocaleString() : "∞"} ${unit}`;
  return [range(l.storageMin, l.storageMax, l.storageUnit ?? "GB"), range(l.ecpuMin, l.ecpuMax, "ECPU/s")].filter(Boolean).join(", ");
}

/** How to reach a cache: what the Connect tab needs, for a group or a serverless cache. */
export interface ConnectTarget {
  engine: string | null;
  /** The endpoint clients start from: configuration (cluster mode), primary, or the serverless endpoint. */
  main: Endpoint | null;
  /** Labelled endpoints to list (main first). */
  endpoints: { label: string; endpoint: Endpoint }[];
  tls: boolean;
  /** TLS is optional (the "preferred" transit mode): plain connections work too. */
  tlsOptional: boolean;
  /** Cluster mode (serverless caches speak it too): clients follow redirects with -c. */
  cluster: boolean;
  /** rbac = users and passwords (or IAM); token = one AUTH password; none. */
  auth: "rbac" | "token" | "none";
}

export function groupTarget(g: Group): ConnectTarget {
  const endpoints: { label: string; endpoint: Endpoint }[] = [];
  if (g.clusterMode && g.configurationEndpoint) endpoints.push({ label: "Configuration endpoint", endpoint: g.configurationEndpoint });
  if (!g.clusterMode) {
    const s = g.shards[0];
    if (s?.primaryEndpoint) endpoints.push({ label: "Primary endpoint (reads and writes)", endpoint: s.primaryEndpoint });
    if (s?.readerEndpoint) endpoints.push({ label: "Reader endpoint (reads, spread over replicas)", endpoint: s.readerEndpoint });
  }
  for (const s of g.shards) for (const m of s.members) if (m.endpoint) endpoints.push({ label: `Node ${m.clusterId}${m.role ? ` (${m.role})` : ""}`, endpoint: m.endpoint });
  return {
    engine: g.engine,
    main: endpoints[0]?.endpoint ?? null,
    endpoints,
    tls: g.transitEncryption,
    tlsOptional: g.transitEncryption && g.transitEncryptionMode === "preferred",
    cluster: g.clusterMode,
    auth: g.userGroupIds.length ? "rbac" : g.authToken ? "token" : "none",
  };
}

export function serverlessTarget(s: Serverless): ConnectTarget {
  const endpoints: { label: string; endpoint: Endpoint }[] = [];
  if (s.endpoint) endpoints.push({ label: "Endpoint", endpoint: s.endpoint });
  if (s.readerEndpoint) endpoints.push({ label: "Reader endpoint (reads)", endpoint: s.readerEndpoint });
  // Serverless caches always use TLS and the cluster protocol.
  return { engine: s.engine, main: endpoints[0]?.endpoint ?? null, endpoints, tls: true, tlsOptional: false, cluster: true, auth: s.userGroupId ? "rbac" : "none" };
}

/** valkey-cli for Valkey (redis-cli works too), redis-cli for Redis OSS. */
export const cliFor = (engine: string | null) => (engine === "valkey" ? "valkey-cli" : "redis-cli");

/** A CLI line for `host:port`; never includes a password (--askpass prompts for it). */
export function cliCommand(t: ConnectTarget, host: string, port: number | null, opts: { sni?: string } = {}): string {
  const parts = [cliFor(t.engine), "-h", host, "-p", String(port ?? 6379)];
  if (t.tls) parts.push("--tls");
  if (t.tls && opts.sni) parts.push("--sni", opts.sni);
  if (t.cluster) parts.push("-c");
  if (t.auth === "rbac") parts.push("--user", "<username>", "--askpass");
  if (t.auth === "token") parts.push("--askpass");
  return parts.join(" ");
}

/** A client library URI, without the password ("rediss://user@host:6379"). */
export function connectionUri(t: ConnectTarget, e: Endpoint): string {
  return `${t.tls && !t.tlsOptional ? "rediss" : "redis"}://${t.auth === "rbac" ? "<username>@" : ""}${e.address}:${e.port ?? 6379}`;
}

/** Port forwarding through an instance in the cache's VPC with Session Manager. */
export function ssmTunnelCommand(e: Endpoint, profile: string | null, region: string): string {
  const port = e.port ?? 6379;
  return `aws ssm start-session --target <instance-id> --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host=${e.address},portNumber=${port},localPortNumber=${port}${profile ? ` --profile ${profile}` : ""} --region ${region}`;
}
