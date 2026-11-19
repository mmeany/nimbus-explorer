// EC2 commands (instances; later items add images, volumes, networking, …).
import { call } from "./core";

export interface GroupRef {
  id: string;
  name: string | null;
}

export interface BlockDevice {
  device: string;
  volumeId: string | null;
  status: string | null;
  deleteOnTermination: boolean | null;
  attached: string | null;
}

export interface Instance {
  id: string;
  /** The Name tag. */
  name: string | null;
  state: string | null;
  stateReason: string | null;
  stateTransitionReason: string | null;
  instanceType: string | null;
  az: string | null;
  tenancy: string | null;
  privateIp: string | null;
  privateDns: string | null;
  publicIp: string | null;
  publicDns: string | null;
  ipv6: string | null;
  launched: string | null;
  platform: string | null;
  windows: boolean;
  architecture: string | null;
  vpcId: string | null;
  subnetId: string | null;
  keyName: string | null;
  imageId: string | null;
  securityGroups: GroupRef[];
  iamProfileArn: string | null;
  autoScalingGroup: string | null;
  lifecycle: string | null;
  monitoring: string | null;
  ebsOptimized: boolean | null;
  rootDevice: string | null;
  rootDeviceType: string | null;
  blockDevices: BlockDevice[];
  interfaceCount: number;
  hibernation: boolean;
  metadataTokens: string | null;
  metadataEndpoint: string | null;
  metadataHopLimit: number | null;
  cpuCores: number | null;
  threadsPerCore: number | null;
  bootMode: string | null;
  virtualization: string | null;
  enaSupport: boolean | null;
  sourceDestCheck: boolean | null;
  ownerId: string | null;
  tags: [string, string][];
}

export interface VolumeAttachment {
  instanceId: string | null;
  device: string | null;
  state: string | null;
  deleteOnTermination: boolean | null;
}

export interface Volume {
  id: string;
  name: string | null;
  sizeGib: number | null;
  volumeType: string | null;
  iops: number | null;
  throughput: number | null;
  encrypted: boolean;
  kmsKeyId: string | null;
  state: string | null;
  az: string | null;
  snapshotId: string | null;
  created: string | null;
  multiAttach: boolean;
  attachments: VolumeAttachment[];
  tags: [string, string][];
}

export interface PrivateIp {
  address: string;
  primary: boolean;
  publicIp: string | null;
}

export interface Interface {
  id: string;
  description: string | null;
  interfaceType: string | null;
  status: string | null;
  vpcId: string | null;
  subnetId: string | null;
  az: string | null;
  mac: string | null;
  privateIp: string | null;
  privateDns: string | null;
  privateIps: PrivateIp[];
  publicIp: string | null;
  publicDns: string | null;
  /** "amazon" for an auto-assigned address, else the Elastic IP's owner. */
  publicIpOwner: string | null;
  ipv6: string[];
  groups: GroupRef[];
  instanceId: string | null;
  deviceIndex: number | null;
  attachmentStatus: string | null;
  deleteOnTermination: boolean | null;
  sourceDestCheck: boolean | null;
  requesterManaged: boolean;
  requester: string | null;
  tags: [string, string][];
}

export interface Rule {
  protocol: string;
  ports: string;
  sourceKind: "cidr" | "cidr6" | "prefixList" | "group";
  source: string;
  sourceName: string | null;
  sourceAccount: string | null;
  description: string | null;
}

export interface SecurityGroup {
  id: string;
  name: string;
  description: string | null;
  vpcId: string | null;
  ownerId: string | null;
  inbound: Rule[];
  outbound: Rule[];
  tags: [string, string][];
}

export interface InstanceDetails extends Instance {
  volumes: Volume[];
  interfaces: Interface[];
  groups: SecurityGroup[];
  /** null = couldn't be read. */
  terminationProtection: boolean | null;
  stopProtection: boolean | null;
  shutdownBehavior: string | null;
  roleArn: string | null;
}

export interface CheckDetail {
  name: string;
  status: string;
  impairedSince: string | null;
}

export interface Check {
  /** ok, impaired, insufficient-data, not-applicable, initializing. */
  status: string | null;
  details: CheckDetail[];
}

export interface ScheduledEvent {
  id: string | null;
  code: string | null;
  description: string | null;
  notBefore: string | null;
  notAfter: string | null;
  deadline: string | null;
}

export interface InstanceStatus {
  state: string | null;
  system: Check | null;
  instance: Check | null;
  ebs: Check | null;
  events: ScheduledEvent[];
}

export interface ConsoleOutput {
  text: string;
  captured: string | null;
  latest: boolean;
}

export interface UserData {
  text: string | null;
  bytes: number;
  compressed: boolean;
}

export const ec2Api = {
  instances: () => call<Instance[]>("ec2_instances"),
  instance: (id: string) => call<InstanceDetails>("ec2_instance", { id }),
  status: (id: string) => call<InstanceStatus>("ec2_status", { id }),
  consoleOutput: (id: string, latest: boolean) => call<ConsoleOutput>("ec2_console_output", { id, latest }),
  screenshot: (id: string) => call<string>("ec2_screenshot", { id }),
  userData: (id: string) => call<UserData>("ec2_user_data", { id }),
  start: (ids: string[]) => call<StateChange[]>("ec2_start", { ids }),
  stop: (ids: string[], hibernate: boolean, force: boolean) => call<StateChange[]>("ec2_stop", { ids, hibernate, force }),
  reboot: (ids: string[]) => call<void>("ec2_reboot", { ids }),
  terminate: (ids: string[]) => call<StateChange[]>("ec2_terminate", { ids }),
  setType: (id: string, instanceType: string) => call<void>("ec2_set_type", { id, instanceType }),
  setProtection: (id: string, termination: boolean | null, stop: boolean | null) => call<void>("ec2_set_protection", { id, termination, stop }),
  instanceTypes: (az: string, architecture: string | null) => call<TypeInfo[]>("ec2_instance_types", { az, architecture }),
};

export interface StateChange {
  id: string;
  previous: string | null;
  current: string | null;
}

export interface TypeInfo {
  name: string;
  vcpus: number | null;
  memoryMib: number | null;
  currentGeneration: boolean | null;
}

/** "t3.small · 2 vCPUs · 2 GiB". */
export function typeText(t: TypeInfo): string {
  const mem = t.memoryMib == null ? "" : t.memoryMib % 1024 === 0 ? `${t.memoryMib / 1024} GiB` : `${(t.memoryMib / 1024).toFixed(1)} GiB`;
  return [t.name, t.vcpus == null ? "" : `${t.vcpus} vCPU${t.vcpus === 1 ? "" : "s"}`, mem].filter(Boolean).join(" · ");
}

/** Which lifecycle actions make sense for instances in these states. */
export function allowedActions(states: (string | null)[]): { start: boolean; stop: boolean; reboot: boolean; terminate: boolean } {
  const all = (ok: string[]) => states.length > 0 && states.every((s) => ok.includes(s ?? ""));
  return {
    start: all(["stopped"]),
    stop: all(["running", "pending"]),
    reboot: all(["running"]),
    terminate: all(["pending", "running", "stopping", "stopped"]),
  };
}

/** What the masked user data field reveals: the text, or a note when there's nothing to show. */
export function userDataText(u: UserData): string {
  if (u.compressed) return `(gzip-compressed, ${u.bytes.toLocaleString()} bytes: the app can't show compressed user data)`;
  if (!u.text) return "(no user data)";
  return u.text;
}

export const INSTANCE_STATES = ["pending", "running", "stopping", "stopped", "shutting-down", "terminated"] as const;
export type InstanceState = (typeof INSTANCE_STATES)[number];

/** States shown when nothing is remembered: everything but terminated. */
export const DEFAULT_STATES: InstanceState[] = ["pending", "running", "stopping", "stopped", "shutting-down"];

export function instanceTone(s: string | null | undefined): "ok" | "busy" | "bad" | "off" {
  if (s === "running" || s === "available" || s === "in-use" || s === "completed" || s === "active") return "ok";
  if (s === "pending" || s === "stopping" || s === "shutting-down" || s === "creating" || s === "deleting") return "busy";
  if (s === "error" || s === "failed") return "bad";
  return "off";
}

/** "web-1 (i-0abc…)", or the id alone when there's no Name tag. */
export function instanceLabel(i: { id: string; name: string | null }): string {
  return i.name ? `${i.name} (${i.id})` : i.id;
}

/**
 * The instance list filter: "key=value" matches a tag (key exactly, value
 * prefix; both ignoring case; "key=" = has the tag); anything else matches
 * the start of the id or any part of the Name tag, ignoring case.
 */
export function matchesInstanceFilter(i: { id: string; name: string | null; tags: [string, string][] }, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  const eq = f.indexOf("=");
  if (eq > 0) {
    const key = f.slice(0, eq).trim();
    const value = f.slice(eq + 1).trim();
    return i.tags.some(([k, v]) => k.toLowerCase() === key && v.toLowerCase().startsWith(value));
  }
  return i.id.toLowerCase().startsWith(f) || (i.name ?? "").toLowerCase().includes(f);
}

/** "TCP 443 from 0.0.0.0/0" style source text for a rule. */
export function ruleSource(r: Rule): string {
  if (r.sourceKind !== "group") return r.source;
  const who = r.sourceName ? `${r.sourceName} (${r.source})` : r.source;
  return r.sourceAccount ? `${who} · account ${r.sourceAccount}` : who;
}

/** Rules open to the whole internet (for a warning marker). */
export function isOpenToWorld(r: Rule): boolean {
  return r.source === "0.0.0.0/0" || r.source === "::/0";
}
