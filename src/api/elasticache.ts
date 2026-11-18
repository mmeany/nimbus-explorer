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
