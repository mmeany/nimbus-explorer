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
  setTags: (resource: string, current: [string, string][], desired: [string, string][]) => call<[number, number]>("ec2_set_tags", { resource, current, desired }),
  createImage: (request: { instanceId: string; name: string; description: string | null; noReboot: boolean; tags: [string, string][] }) => call<string>("ec2_create_image", { request }),
  snapshotVolume: (volumeId: string, description: string | null, tags: [string, string][]) => call<CreatedSnapshot>("ec2_snapshot_volume", { volumeId, description, tags }),
  images: (scope: "mine" | "shared") => call<Image[]>("ec2_images", { scope }),
  image: (id: string) => call<Image>("ec2_image", { id }),
  volumes: () => call<Volume[]>("ec2_volumes"),
  volume: (id: string) => call<Volume>("ec2_volume", { id }),
  snapshots: () => call<Snapshot[]>("ec2_snapshots"),
  snapshot: (id: string) => call<SnapshotDetails>("ec2_snapshot", { id }),
  ssmAgent: (id: string) => call<SsmAgent>("ec2_ssm_agent", { id }),
  snapshotInstance: (instanceId: string, description: string | null, excludeRoot: boolean) => call<CreatedSnapshot[]>("ec2_snapshot_instance", { instanceId, description, excludeRoot }),
};

export interface ImageDevice {
  device: string;
  snapshotId: string | null;
  sizeGib: number | null;
  volumeType: string | null;
  encrypted: boolean | null;
  deleteOnTermination: boolean | null;
  /** An instance store disk ("ephemeral0") rather than EBS. */
  virtualName: string | null;
}

export interface Image {
  id: string;
  /** The image's own name (not a tag). */
  name: string | null;
  nameTag: string | null;
  description: string | null;
  state: string | null;
  stateReason: string | null;
  created: string | null;
  deprecation: string | null;
  ownerId: string | null;
  ownerAlias: string | null;
  public: boolean;
  architecture: string | null;
  platform: string | null;
  rootDevice: string | null;
  rootDeviceType: string | null;
  virtualization: string | null;
  enaSupport: boolean | null;
  bootMode: string | null;
  imdsSupport: string | null;
  location: string | null;
  devices: ImageDevice[];
  tags: [string, string][];
}

export interface Snapshot {
  id: string;
  name: string | null;
  description: string | null;
  volumeId: string | null;
  sizeGib: number | null;
  state: string | null;
  stateMessage: string | null;
  progress: string | null;
  started: string | null;
  completed: string | null;
  encrypted: boolean;
  kmsKeyId: string | null;
  ownerId: string | null;
  storageTier: string | null;
  tags: [string, string][];
}

export interface SnapshotDetails extends Snapshot {
  /** null = couldn't tell. */
  volumeExists: boolean | null;
  /** Your images that use it. */
  images: string[];
}

export interface SsmAgent {
  managed: boolean;
  pingStatus: string | null;
  lastPing: string | null;
  agentVersion: string | null;
  latestAgent: boolean | null;
  platform: string | null;
  error: string | null;
}

export interface ConnectCommand {
  id: string;
  title: string;
  command: string;
  note: string;
}

/** The OS user to suggest for SSH: Windows has none; Linux images differ, ec2-user is Amazon Linux's. */
export function guessUser(i: { platform: string | null; windows: boolean }): string | null {
  if (i.windows) return null;
  const p = (i.platform ?? "").toLowerCase();
  if (p.includes("ubuntu")) return "ubuntu";
  if (p.includes("red hat") || p.includes("suse")) return "ec2-user";
  return "ec2-user";
}

/**
 * Commands for reaching an instance from your own machine, with the profile
 * and region filled in. Nothing here connects: the app only shows them.
 */
export function connectCommands(
  i: { id: string; keyName: string | null; publicIp: string | null; publicDns: string | null; privateIp: string | null; windows: boolean; platform: string | null },
  profile: string | null,
  region: string,
  endpointOverride: string | null = null,
): ConnectCommand[] {
  const tail = `${profile ? ` --profile ${profile}` : ""} --region ${region}${endpointOverride ? ` --endpoint-url ${endpointOverride}` : ""}`;
  const key = i.keyName ? `~/.ssh/${i.keyName}.pem` : null;
  const user = guessUser(i) ?? "ec2-user";
  const host = i.publicDns ?? i.publicIp;
  const out: ConnectCommand[] = [];
  out.push({
    id: "ssm-shell",
    title: "Session Manager shell",
    command: `aws ssm start-session --target ${i.id}${tail}`,
    note: "A shell (PowerShell on Windows) through Systems Manager: no open ports, no key, works for private instances. Needs the Session Manager plugin for the AWS CLI.",
  });
  if (i.windows) {
    out.push({
      id: "ssm-rdp",
      title: "Remote Desktop through Session Manager",
      command: `aws ssm start-session --target ${i.id} --document-name AWS-StartPortForwardingSession --parameters portNumber=3389,localPortNumber=13389${tail}`,
      note: "Keep it running, then connect Remote Desktop to localhost:13389 (mstsc /v:localhost:13389). Port 3389 doesn't need to be open.",
    });
    if (host)
      out.push({
        id: "rdp",
        title: "Remote Desktop over the internet",
        command: `mstsc /v:${host}`,
        note: "Needs inbound TCP 3389 from your address in a security group. Get the Administrator password from the EC2 console with the key pair's private key.",
      });
    return out;
  }
  out.push({
    id: "ssm-ssh",
    title: "SSH through Session Manager",
    command: `ssh ${key ? `-i ${key} ` : ""}-o ProxyCommand="aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p${tail}" ${user}@${i.id}`,
    note: `Real SSH (scp, port forwarding, VS Code Remote) without opening port 22. ${key ? "Uses the key pair's private key." : "The instance has no key pair: its authorized_keys must already hold your key."}`,
  });
  out.push({
    id: "ssm-forward",
    title: "Port forwarding through Session Manager",
    command: `aws ssm start-session --target ${i.id} --document-name AWS-StartPortForwardingSession --parameters portNumber=22,localPortNumber=2222${tail}`,
    note: "Forwards local port 2222 to the instance's port 22 while it runs (change the ports for other services, e.g. 5432).",
  });
  if (host)
    out.push({
      id: "ssh",
      title: "SSH over the internet",
      command: `ssh ${key ? `-i ${key} ` : ""}${user}@${host}`,
      note: "Needs inbound TCP 22 from your address in a security group. The user depends on the image: ec2-user (Amazon Linux, RHEL), ubuntu (Ubuntu), admin (Debian).",
    });
  out.push({
    id: "eic",
    title: "EC2 Instance Connect",
    command: `aws ec2-instance-connect ssh --instance-id ${i.id} --os-user ${user}${host ? "" : " --connection-type eice"}${tail}`,
    note: host
      ? "Pushes a one-time key for 60 seconds and connects; no key pair needed. Needs the Instance Connect package on the instance (preinstalled on Amazon Linux and Ubuntu) and port 22 open to you."
      : "The instance has no public address, so this goes through an EC2 Instance Connect Endpoint in its VPC (which must exist). No key pair needed.",
  });
  return out;
}

export interface CreatedSnapshot {
  snapshotId: string;
  volumeId: string | null;
}

/** Why a set of tags can't be saved (AWS's limits), or null. */
export function tagProblem(tags: [string, string][]): string | null {
  if (tags.length > 50) return "A resource can have at most 50 tags";
  const seen = new Set<string>();
  for (const [k, v] of tags) {
    if (!k.trim()) return "Every tag needs a key";
    if (k.length > 128) return `The key "${k.slice(0, 20)}…" is longer than 128 characters`;
    if (k.toLowerCase().startsWith("aws:")) return `"${k}": keys starting with aws: are reserved for AWS`;
    if (v.length > 256) return `The value of "${k}" is longer than 256 characters`;
    if (seen.has(k)) return `The key "${k}" is used twice`;
    seen.add(k);
  }
  return null;
}

/** The list kind an EC2 resource ID belongs to (by its prefix), or null. */
export function kindOfId(id: string): import("../shell/places").Ec2Kind | null {
  const prefix = id.slice(0, id.indexOf("-"));
  const map: Record<string, import("../shell/places").Ec2Kind> = {
    i: "instances",
    ami: "images",
    vol: "volumes",
    snap: "snapshots",
    sg: "securityGroups",
    vpc: "vpcs",
    subnet: "subnets",
    eni: "interfaces",
    eipalloc: "addresses",
    key: "keyPairs",
    lt: "launchTemplates",
  };
  return map[prefix] ?? null;
}

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
