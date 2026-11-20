// Networking: security groups, VPCs, subnets, network interfaces and Elastic
// IPs. List configs for ResourceList and one view per resource.
import { useMemo } from "react";
import { ec2Api, interfaceOwner, matchesInstanceFilter, type Address, type Instance, type Interface, type RouteTable, type SecurityGroup, type Subnet, type Vpc } from "../../api/ec2";
import { ErrorPanel } from "../../components/ErrorPanel";
import type { Column } from "../../components/FileList";
import { HelpTopic } from "../../components/HelpDialog";
import { NetworkIcon, ShieldIcon } from "../../components/Icons";
import type { Shell } from "../../shell/shell";
import { PropsTable, RulesTable, useLoad, yesNo } from "./common";
import type { KindConfig } from "./ResourceList";
import { Ref, ResourceHead, TagsSection } from "./StorageViews";

type EditTags = (id: string, label: string, tags: [string, string][]) => void;

function Refs({ shell, kind, ids }: { shell: Shell; kind: "securityGroups" | "subnets" | "instances" | "interfaces"; ids: { id: string; label?: string }[] }) {
  if (!ids.length) return <span className="hint">None</span>;
  return (
    <>
      {ids.map((x, n) => (
        <span key={x.id}>
          {n > 0 && ", "}
          <Ref shell={shell} kind={kind} id={x.id} label={x.label} />
        </span>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Security groups

const GROUP_COLUMNS: Column[] = [
  { id: "name", label: "Group name", width: 230 },
  { id: "id", label: "Group ID", width: 190 },
  { id: "vpc", label: "VPC", width: 190 },
  { id: "inbound", label: "Inbound rules", width: 100, align: "right" },
  { id: "outbound", label: "Outbound rules", width: 105, align: "right" },
  { id: "open", label: "Open to internet", width: 150 },
  { id: "description", label: "Description", width: 300 },
];

const worldPorts = (g: SecurityGroup) =>
  g.inbound
    .filter((r) => r.source === "0.0.0.0/0" || r.source === "::/0")
    .map((r) => (r.protocol === "All" ? "all traffic" : `${r.protocol} ${r.ports}`))
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");

export const groupConfig: KindConfig<SecurityGroup> = {
  kind: "securityGroups",
  help: "ec2.securityGroups",
  noun: ["security group", "security groups"],
  load: ec2Api.securityGroups,
  key: (g) => g.id,
  columns: GROUP_COLUMNS,
  icon: () => <ShieldIcon />,
  cells: (g) => ({
    name: { text: g.name, sort: g.name.toLowerCase() },
    id: { text: g.id, sort: g.id },
    vpc: { text: g.vpcId ?? "", sort: g.vpcId ?? "" },
    inbound: { text: String(g.inbound.length), sort: g.inbound.length },
    outbound: { text: String(g.outbound.length), sort: g.outbound.length },
    open: { text: worldPorts(g), sort: worldPorts(g) },
    description: { text: g.description ?? "", sort: g.description ?? "" },
  }),
  match: (g, f) => matchesInstanceFilter(g, f) || (g.vpcId ?? "").startsWith(f.trim()),
  placeholder: "Group name, group or VPC ID prefix, or tag as key=value",
  label: (g) => g.name,
  empty: "No security groups in this region.",
};

export function SecurityGroupView({ shell, id, reloadToken, instances, onEditTags }: { shell: Shell; id: string; reloadToken: number; instances: Map<string, Instance>; onEditTags: EditTags }) {
  const { data: g, error, retry } = useLoad(`${id}|${reloadToken}`, () => ec2Api.securityGroup(id));
  if (error && !g) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!g) return <div className="empty-note">Loading…</div>;
  const goGroup = (gid: string) => shell.navigate({ service: "ec2", kind: "securityGroups", id: gid });
  return (
    <div className="queue-view db-view">
      <ResourceHead shell={shell} id={g.id} name={g.name} badges={g.vpcId ? [g.vpcId] : []} />
      {g.description && <div className="hint">{g.description}</div>}
      <HelpTopic id="ec2.securityGroup" />
      <div className="lambda-details">
        <PropsTable
          rows={[
            ["Group ID", g.id],
            ["VPC", g.vpcId ? <Ref shell={shell} kind="vpcs" id={g.vpcId} /> : null],
            ["Owner account", g.ownerId],
          ]}
        />
        <div className="props-section">Inbound rules</div>
        <RulesTable rules={g.inbound} inbound onGroup={goGroup} />
        <div className="props-section">Outbound rules</div>
        <RulesTable rules={g.outbound} inbound={false} onGroup={goGroup} />
        <div className="props-section">Used by ({g.usedBy.length})</div>
        {g.usedBy.length === 0 ? (
          <p className="hint">No network interface has this group: nothing uses it now.</p>
        ) : (
          <table className="sync-table">
            <thead>
              <tr>
                <th>Network interface</th>
                <th>Belongs to</th>
                <th>Private IP</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {g.usedBy.map((u) => {
                const inst = u.instanceId ? instances.get(u.instanceId) : undefined;
                return (
                  <tr key={u.interfaceId}>
                    <td>
                      <Ref shell={shell} kind="interfaces" id={u.interfaceId} />
                    </td>
                    <td>{u.instanceId ? <Ref shell={shell} kind="instances" id={u.instanceId} label={inst?.name ? `${inst.name} (${u.instanceId})` : undefined} /> : interfaceOwner(u)}</td>
                    <td className="mono">{u.privateIp ?? ""}</td>
                    <td>{u.description ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="props-section">Referenced by</div>
        {g.referencedBy.length === 0 ? (
          <p className="hint">No other group's rules name this group.</p>
        ) : (
          <p>
            <Refs shell={shell} kind="securityGroups" ids={g.referencedBy.map((r) => ({ id: r.id, label: r.name ? `${r.name} (${r.id})` : r.id }))} />
          </p>
        )}
        <TagsSection shell={shell} tags={g.tags} onEdit={() => onEditTags(g.id, g.name, g.tags)} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VPCs

const VPC_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 220 },
  { id: "id", label: "VPC ID", width: 200 },
  { id: "cidr", label: "IPv4 CIDR", width: 160 },
  { id: "state", label: "State", width: 80 },
  { id: "default", label: "Default", width: 65 },
  { id: "ipv6", label: "IPv6 CIDR", width: 200 },
];

export const vpcConfig: KindConfig<Vpc> = {
  kind: "vpcs",
  help: "ec2.vpcs",
  noun: ["VPC", "VPCs"],
  load: ec2Api.vpcs,
  key: (v) => v.id,
  columns: VPC_COLUMNS,
  icon: () => <NetworkIcon />,
  cells: (v) => ({
    name: { text: v.name ?? "", sort: (v.name ?? "").toLowerCase() || `~${v.id}` },
    id: { text: v.id, sort: v.id },
    cidr: { text: v.cidrs.join(", "), sort: v.cidrs.join(",") },
    state: { text: v.state ?? "", sort: v.state ?? "" },
    default: { text: v.isDefault ? "Yes" : "", sort: v.isDefault ? 0 : 1 },
    ipv6: { text: v.ipv6Cidrs.join(", "), sort: v.ipv6Cidrs.join(",") },
  }),
  match: (v, f) => matchesInstanceFilter(v, f) || v.cidrs.some((c) => c.startsWith(f.trim())),
  placeholder: "Name, VPC ID prefix, CIDR start, or tag as key=value",
  label: (v) => v.name ?? v.id,
  empty: "No VPCs in this region.",
};

function RoutesTable({ t }: { t: RouteTable }) {
  return (
    <table className="sync-table">
      <thead>
        <tr>
          <th>Destination</th>
          <th>Target</th>
          <th>State</th>
        </tr>
      </thead>
      <tbody>
        {t.routes.map((r, n) => (
          <tr key={n}>
            <td className="mono">{r.destination}</td>
            <td className="mono">
              {r.target}
              {r.target.startsWith("igw-") ? <span className="hint"> (internet gateway)</span> : r.target.startsWith("nat-") ? <span className="hint"> (NAT gateway)</span> : null}
            </td>
            <td className={r.state === "blackhole" ? "field-error" : ""}>{r.state ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function VpcView({ shell, id, reloadToken, instances, onEditTags }: { shell: Shell; id: string; reloadToken: number; instances: Instance[] | null; onEditTags: EditTags }) {
  const { data: v, error, retry } = useLoad(`${id}|${reloadToken}`, () => ec2Api.vpc(id));
  const inVpc = useMemo(() => (instances ?? []).filter((i) => i.vpcId === id && i.state !== "terminated"), [instances, id]);
  if (error && !v) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!v) return <div className="empty-note">Loading…</div>;
  return (
    <div className="queue-view db-view">
      <ResourceHead shell={shell} id={v.id} name={v.name} state={v.state} badges={[...v.cidrs, ...(v.isDefault ? ["Default VPC"] : [])]} />
      <HelpTopic id="ec2.vpc" />
      <div className="lambda-details">
        <PropsTable
          rows={[
            ["VPC ID", v.id],
            ["IPv4 CIDR", v.cidrs.join(", ")],
            ["IPv6 CIDR", v.ipv6Cidrs.join(", ")],
            ["Default VPC", v.isDefault ? "Yes" : "No"],
            ["Tenancy", v.tenancy],
            ["DHCP options", v.dhcpOptions],
            ["Owner account", v.ownerId],
            ["Instances", `${inVpc.length.toLocaleString()} (not terminated)`],
          ]}
        />
        <div className="props-section">Subnets ({v.subnets.length})</div>
        {v.subnets.length === 0 ? (
          <p className="hint">None.</p>
        ) : (
          <table className="sync-table">
            <thead>
              <tr>
                <th>Subnet</th>
                <th>Zone</th>
                <th>CIDR</th>
                <th>Free IPs</th>
                <th>Public IPs on launch</th>
              </tr>
            </thead>
            <tbody>
              {v.subnets.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Ref shell={shell} kind="subnets" id={s.id} label={s.name ? `${s.name} (${s.id})` : s.id} />
                  </td>
                  <td>{s.az ?? ""}</td>
                  <td className="mono">{s.cidr ?? ""}</td>
                  <td>{s.availableIps?.toLocaleString() ?? ""}</td>
                  <td>{s.publicIpOnLaunch ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="props-section">Gateways</div>
        {v.gateways.length === 0 ? (
          <p className="hint">No internet or NAT gateway: instances here can't reach the internet directly.</p>
        ) : (
          <PropsTable
            rows={v.gateways.map((g) => [
              g.kind === "internet" ? "Internet gateway" : "NAT gateway",
              `${g.id}${g.name ? ` (${g.name})` : ""}${g.state ? ` · ${g.state}` : ""}${g.publicIp ? ` · ${g.publicIp}` : ""}${g.subnetId ? ` · in ${g.subnetId}` : ""}`,
            ])}
          />
        )}
        {v.routeTables.map((t) => (
          <div key={t.id}>
            <div className="props-section">
              Route table {t.id}
              {t.name ? ` (${t.name})` : ""}
              {t.main ? <span className="hint"> · main: used by subnets without their own</span> : null}
            </div>
            <RoutesTable t={t} />
          </div>
        ))}
        <TagsSection shell={shell} tags={v.tags} onEdit={() => onEditTags(v.id, v.name ?? v.id, v.tags)} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subnets

const SUBNET_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 220 },
  { id: "id", label: "Subnet ID", width: 210 },
  { id: "vpc", label: "VPC", width: 190 },
  { id: "az", label: "Zone", width: 105 },
  { id: "cidr", label: "IPv4 CIDR", width: 140 },
  { id: "free", label: "Free IPs", width: 75, align: "right" },
  { id: "public", label: "Public IPs on launch", width: 135 },
];

export const subnetConfig: KindConfig<Subnet> = {
  kind: "subnets",
  help: "ec2.subnets",
  noun: ["subnet", "subnets"],
  load: ec2Api.subnets,
  key: (s) => s.id,
  columns: SUBNET_COLUMNS,
  icon: () => <NetworkIcon />,
  cells: (s) => ({
    name: { text: s.name ?? "", sort: (s.name ?? "").toLowerCase() || `~${s.id}` },
    id: { text: s.id, sort: s.id },
    vpc: { text: s.vpcId ?? "", sort: s.vpcId ?? "" },
    az: { text: s.az ?? "", sort: s.az ?? "" },
    cidr: { text: s.cidr ?? "", sort: s.cidr ?? "" },
    free: { text: s.availableIps?.toLocaleString() ?? "", sort: s.availableIps ?? 0 },
    public: { text: s.publicIpOnLaunch ? "Yes" : "No", sort: s.publicIpOnLaunch ? 1 : 0 },
  }),
  match: (s, f) => matchesInstanceFilter(s, f) || (s.vpcId ?? "").startsWith(f.trim()) || (s.cidr ?? "").startsWith(f.trim()),
  placeholder: "Name, subnet or VPC ID prefix, CIDR start, or tag as key=value",
  label: (s) => s.name ?? s.id,
  empty: "No subnets in this region.",
};

export function SubnetView({ shell, id, reloadToken, instances, onEditTags }: { shell: Shell; id: string; reloadToken: number; instances: Instance[] | null; onEditTags: EditTags }) {
  const { data: s, error, retry } = useLoad(`${id}|${reloadToken}`, () => ec2Api.subnet(id));
  const inSubnet = useMemo(() => (instances ?? []).filter((i) => i.subnetId === id && i.state !== "terminated"), [instances, id]);
  if (error && !s) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!s) return <div className="empty-note">Loading…</div>;
  return (
    <div className="queue-view db-view">
      <ResourceHead shell={shell} id={s.id} name={s.name} state={s.state} badges={[s.cidr ?? "", s.az ?? "", s.public === true ? "Public" : s.public === false ? "Private" : ""].filter(Boolean)} />
      <HelpTopic id="ec2.subnet" />
      <div className="lambda-details">
        <PropsTable
          rows={[
            ["Subnet ID", s.id],
            ["VPC", <Ref key="v" shell={shell} kind="vpcs" id={s.vpcId} />],
            ["Availability zone", s.az],
            ["IPv4 CIDR", s.cidr],
            ["IPv6 CIDR", s.ipv6Cidrs.join(", ")],
            ["Free IP addresses", s.availableIps?.toLocaleString() ?? null],
            ["Public IPs on launch", s.publicIpOnLaunch ? "Yes: instances get a public address unless told otherwise" : "No"],
            ["Default for its zone", yesNo(s.defaultForAz)],
            ["Reaches the internet", s.public === null ? "Unknown (route tables couldn't be read)" : s.public ? "Directly, through an internet gateway (a public subnet)" : "Not directly (a private subnet; a NAT gateway route may give outbound access)"],
          ]}
        />
        <div className="props-section">Instances ({inSubnet.length})</div>
        <p>
          <Refs shell={shell} kind="instances" ids={inSubnet.map((i) => ({ id: i.id, label: i.name ? `${i.name} (${i.id})` : i.id }))} />
        </p>
        {s.routeTable && (
          <>
            <div className="props-section">
              Route table {s.routeTable.id}
              {s.routeTable.main ? <span className="hint"> · the VPC's main table (the subnet has none of its own)</span> : null}
            </div>
            <RoutesTable t={s.routeTable} />
          </>
        )}
        <TagsSection shell={shell} tags={s.tags} onEdit={() => onEditTags(s.id, s.name ?? s.id, s.tags)} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Network interfaces

const ENI_COLUMNS: Column[] = [
  { id: "id", label: "Interface ID", width: 200 },
  { id: "owner", label: "Belongs to", width: 190 },
  { id: "status", label: "Status", width: 75 },
  { id: "privateIp", label: "Private IP", width: 115 },
  { id: "publicIp", label: "Public IP", width: 115 },
  { id: "subnet", label: "Subnet", width: 200 },
  { id: "description", label: "Description", width: 320 },
];

export function interfaceConfig(instances: Map<string, Instance>): KindConfig<Interface> {
  const owner = (n: Interface) => {
    const i = n.instanceId ? instances.get(n.instanceId) : undefined;
    return i?.name ? `${i.name} (${i.id})` : interfaceOwner(n);
  };
  return {
    kind: "interfaces",
    help: "ec2.interfaces",
    noun: ["network interface", "network interfaces"],
    load: ec2Api.interfaces,
    key: (n) => n.id,
    columns: ENI_COLUMNS,
    icon: () => <NetworkIcon />,
    dimmed: (n) => n.status === "available",
    cells: (n) => ({
      id: { text: n.id, sort: n.id },
      owner: { text: owner(n), sort: owner(n) },
      status: { text: n.status ?? "", sort: n.status ?? "" },
      privateIp: { text: n.privateIp ?? "", sort: n.privateIp ?? "" },
      publicIp: { text: n.publicIp ?? "", sort: n.publicIp ?? "" },
      subnet: { text: n.subnetId ?? "", sort: n.subnetId ?? "" },
      description: { text: n.description ?? "", sort: n.description ?? "" },
    }),
    match: (n, f) => {
      const t = f.trim().toLowerCase();
      return matchesInstanceFilter({ id: n.id, name: n.description, tags: n.tags }, f) || [n.instanceId, n.privateIp, n.publicIp, n.subnetId, n.vpcId].some((x) => (x ?? "").toLowerCase().startsWith(t));
    },
    placeholder: "Interface, instance, subnet or VPC ID prefix, IP, description, or tag as key=value",
    label: (n) => n.id,
    empty: "No network interfaces in this region.",
  };
}

export function InterfaceView({ shell, id, reloadToken, onEditTags }: { shell: Shell; id: string; reloadToken: number; onEditTags: EditTags }) {
  const { data: n, error, retry } = useLoad(`${id}|${reloadToken}`, () => ec2Api.interface(id));
  if (error && !n) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!n) return <div className="empty-note">Loading…</div>;
  return (
    <div className="queue-view db-view">
      <ResourceHead shell={shell} id={n.id} name={null} state={n.status} badges={n.interfaceType && n.interfaceType !== "interface" ? [n.interfaceType] : []} />
      {n.description && <div className="hint">{n.description}</div>}
      <HelpTopic id="ec2.interface" />
      <div className="lambda-details">
        <PropsTable
          rows={[
            ["Belongs to", n.instanceId ? <Ref key="i" shell={shell} kind="instances" id={n.instanceId} /> : interfaceOwner(n) || "Nothing (not attached)"],
            ["Device index", n.deviceIndex === null ? null : String(n.deviceIndex)],
            ["Private IPs", n.privateIps.map((p) => `${p.address}${p.primary ? " (primary)" : ""}${p.publicIp ? ` → ${p.publicIp}` : ""}`).join(", ") || n.privateIp],
            ["Private DNS", n.privateDns],
            ["Public IP", n.publicIp ? `${n.publicIp}${n.publicIpOwner === "amazon" ? " (auto-assigned)" : " (Elastic IP)"}` : "None"],
            ["IPv6", n.ipv6.join(", ")],
            ["VPC", <Ref key="v" shell={shell} kind="vpcs" id={n.vpcId} />],
            ["Subnet", <Ref key="s" shell={shell} kind="subnets" id={n.subnetId} />],
            ["Availability zone", n.az],
            ["MAC address", n.mac],
            ["Security groups", <Refs key="g" shell={shell} kind="securityGroups" ids={n.groups.map((g) => ({ id: g.id, label: g.name ? `${g.name} (${g.id})` : g.id }))} />],
            ["Deleted with instance", yesNo(n.deleteOnTermination)],
            ["Source / destination check", yesNo(n.sourceDestCheck)],
            ["Managed by a service", n.requesterManaged ? `Yes${n.requester ? ` (${n.requester})` : ""}: change it through that service` : "No"],
          ]}
        />
        <TagsSection shell={shell} tags={n.tags} onEdit={() => onEditTags(n.id, n.id, n.tags)} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Elastic IPs

const EIP_COLUMNS: Column[] = [
  { id: "ip", label: "Public IP", width: 130 },
  { id: "name", label: "Name", width: 180 },
  { id: "id", label: "Allocation ID", width: 220 },
  { id: "instance", label: "Instance", width: 210 },
  { id: "privateIp", label: "Private IP", width: 115 },
  { id: "interface", label: "Network interface", width: 200 },
];

export function addressConfig(instances: Map<string, Instance>): KindConfig<Address> {
  const inst = (a: Address) => {
    const i = a.instanceId ? instances.get(a.instanceId) : undefined;
    return a.instanceId ? (i?.name ? `${i.name} (${a.instanceId})` : a.instanceId) : "";
  };
  return {
    kind: "addresses",
    help: "ec2.addresses",
    noun: ["Elastic IP", "Elastic IPs"],
    load: ec2Api.addresses,
    key: (a) => a.id,
    columns: EIP_COLUMNS,
    icon: () => <NetworkIcon />,
    dimmed: (a) => !a.associationId,
    cells: (a) => ({
      ip: { text: a.publicIp ?? "", sort: a.publicIp ?? "" },
      name: { text: a.name ?? "", sort: (a.name ?? "").toLowerCase() },
      id: { text: a.id, sort: a.id },
      instance: { text: inst(a) || (a.associationId ? "" : "not associated"), sort: inst(a) },
      privateIp: { text: a.privateIp ?? "", sort: a.privateIp ?? "" },
      interface: { text: a.interfaceId ?? "", sort: a.interfaceId ?? "" },
    }),
    match: (a, f) => matchesInstanceFilter(a, f) || [a.publicIp, a.instanceId].some((x) => (x ?? "").startsWith(f.trim())),
    placeholder: "Public IP, name, allocation or instance ID prefix, or tag as key=value",
    label: (a) => a.name ?? a.publicIp ?? a.id,
    empty: "No Elastic IPs in this region.",
  };
}

export function AddressView({ shell, id, reloadToken, onEditTags }: { shell: Shell; id: string; reloadToken: number; onEditTags: EditTags }) {
  const { data: list, error, retry } = useLoad(`${id}|${reloadToken}`, () => ec2Api.addresses());
  if (error && !list) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!list) return <div className="empty-note">Loading…</div>;
  const a = list.find((x) => x.id === id);
  if (!a) return <p className="hint">There's no Elastic IP {id} in this region (it may have been released).</p>;
  return (
    <div className="queue-view db-view">
      <ResourceHead shell={shell} id={a.id} name={a.publicIp} badges={a.associationId ? [] : ["Not associated"]} />
      <HelpTopic id="ec2.addresses" />
      {!a.associationId && <div className="hint">Not associated with anything: an idle Elastic IP is charged by the hour.</div>}
      <div className="lambda-details">
        <PropsTable
          rows={[
            ["Public IP", a.publicIp],
            ["Allocation ID", a.id],
            ["Name", a.name],
            ["Instance", a.instanceId ? <Ref key="i" shell={shell} kind="instances" id={a.instanceId} /> : "None"],
            ["Network interface", a.interfaceId ? <Ref key="n" shell={shell} kind="interfaces" id={a.interfaceId} /> : "None"],
            ["Private IP", a.privateIp],
            ["Association ID", a.associationId],
            ["Network border group", a.borderGroup],
            ["Address pool", a.pool],
          ]}
        />
        <TagsSection shell={shell} tags={a.tags} onEdit={() => onEditTags(a.id, a.publicIp ?? a.id, a.tags)} />
      </div>
    </div>
  );
}
