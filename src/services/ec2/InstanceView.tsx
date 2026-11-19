// One instance: header and tabs (Details, Storage, Networking, Security
// groups, plus the tabs the controller adds). Re-checks every 5 s while the
// instance is changing state.
import { useEffect, useState, type ReactNode } from "react";
import { ec2Api, type InstanceDetails } from "../../api/ec2";
import { ErrorPanel } from "../../components/ErrorPanel";
import { HelpTopic } from "../../components/HelpDialog";
import { RoleLink } from "../../components/RoleLink";
import { formatDate } from "../../format";
import type { HelpTopicId } from "../../help";
import { EC2_ROOT } from "../../shell/places";
import type { Shell } from "../../shell/shell";
import { Pill, PropsTable, RulesTable, TagsTable, useLoad, yesNo } from "./common";

const CHANGING = new Set(["pending", "stopping", "shutting-down"]);

export interface InstanceTab {
  id: string;
  label: string;
  help: HelpTopicId;
  render: (i: InstanceDetails, reload: () => void) => ReactNode;
}

const BASE_TABS: { id: string; label: string; help: HelpTopicId }[] = [
  { id: "details", label: "Details", help: "ec2.instance" },
  { id: "storage", label: "Storage", help: "ec2.instance.storage" },
  { id: "networking", label: "Networking", help: "ec2.instance.networking" },
  { id: "security", label: "Security groups", help: "ec2.instance.security" },
];

export function InstanceView({
  shell,
  id,
  reloadToken,
  onLoaded,
  tabs = [],
  initialTab,
  onEditTags,
  onSnapshotVolume,
}: {
  shell: Shell;
  id: string;
  reloadToken: number;
  onLoaded: (i: InstanceDetails | null, reload: () => void) => void;
  tabs?: InstanceTab[];
  initialTab?: string;
  /** Opens the tag editor (absent or read-only: no button). */
  onEditTags?: (i: InstanceDetails) => void;
  onSnapshotVolume?: (volumeId: string) => void;
}) {
  const [tab, setTab] = useState(initialTab ?? "details");
  const { data: i, error, retry } = useLoad(`${id}|${reloadToken}`, () => ec2Api.instance(id), (d) => (d && CHANGING.has(d.state ?? "") ? 5_000 : null));
  useEffect(() => onLoaded(i, retry), [i]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error && !i) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!i) return <div className="empty-note">Loading…</div>;
  const all = [...BASE_TABS, ...tabs];
  const current = all.find((t) => t.id === tab) ?? all[0];
  const extra = tabs.find((t) => t.id === current.id);
  const goGroup = (g: string) => shell.navigate({ ...EC2_ROOT, kind: "securityGroups", id: g });
  return (
    <div className="queue-view db-view">
      <div className="qv-head">
        <span className="qv-name">{i.name ?? i.id}</span>
        {i.name && <span className="hint mono">{i.id}</span>}
        <Pill status={i.state} />
        {i.instanceType && <span className="qbadge">{i.instanceType}</span>}
        {i.platform && <span className="qbadge">{i.platform}</span>}
        {i.lifecycle === "spot" && <span className="qbadge">Spot</span>}
        <div className="spacer" />
        <button className="link-btn" onClick={() => void shell.copyText(i.id)}>
          Copy ID
        </button>
      </div>
      {i.stateReason && i.state !== "running" && <div className="hint">{i.stateReason}</div>}
      <HelpTopic id={current.help} />
      <div className="segmented small db-tabs">
        {all.map((t) => (
          <button key={t.id} className={current.id === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.id === "storage" ? `Storage (${i.blockDevices.length})` : t.id === "networking" ? `Networking (${i.interfaces.length || i.interfaceCount})` : t.id === "security" ? `Security groups (${i.securityGroups.length})` : t.label}
          </button>
        ))}
      </div>
      {extra ? (
        extra.render(i, retry)
      ) : current.id === "storage" ? (
        <StorageTab i={i} onSnapshot={shell.readOnly ? undefined : onSnapshotVolume} />
      ) : current.id === "networking" ? (
        <NetworkingTab i={i} onGroup={goGroup} />
      ) : current.id === "security" ? (
        <SecurityTab i={i} onGroup={goGroup} />
      ) : (
        <DetailsTab i={i} shell={shell} onEditTags={shell.readOnly || !onEditTags ? undefined : () => onEditTags(i)} />
      )}
    </div>
  );
}

function protection(v: boolean | null): string | null {
  return v === null ? "(couldn't read)" : v ? "On" : "Off";
}

function DetailsTab({ i, shell, onEditTags }: { i: InstanceDetails; shell: Shell; onEditTags?: () => void }) {
  const cpu = i.cpuCores ? `${i.cpuCores} core${i.cpuCores === 1 ? "" : "s"} × ${i.threadsPerCore ?? 1} thread${(i.threadsPerCore ?? 1) === 1 ? "" : "s"}` : null;
  return (
    <div className="lambda-details">
      <div className="props-section">Instance</div>
      <PropsTable
        rows={[
          ["Instance ID", i.id],
          ["Name", i.name],
          ["State", `${i.state ?? "unknown"}${i.stateTransitionReason ? ` (${i.stateTransitionReason})` : ""}`],
          ["Instance type", i.instanceType],
          ["Platform", i.platform],
          ["Architecture", i.architecture],
          ["vCPUs", cpu],
          ["Launched", formatDate(i.launched)],
          ["AMI", i.imageId],
          ["Key pair", i.keyName ?? "None"],
          ["Purchase", i.lifecycle === "spot" ? "Spot" : i.lifecycle === "scheduled" ? "Scheduled" : "On demand"],
          ["Auto Scaling group", i.autoScalingGroup],
          ["Tenancy", i.tenancy],
          ["Monitoring", i.monitoring === "enabled" ? "Detailed (1 minute)" : i.monitoring === "disabled" ? "Basic (5 minutes)" : i.monitoring],
          ["Hibernation", i.hibernation ? "Configured" : "Not configured"],
          ["Boot mode", i.bootMode],
          ["Virtualization", i.virtualization],
          ["EBS optimized", yesNo(i.ebsOptimized)],
          ["Owner account", i.ownerId],
        ]}
      />
      <div className="props-section">Network</div>
      <PropsTable
        rows={[
          ["Availability zone", i.az],
          ["VPC", i.vpcId],
          ["Subnet", i.subnetId],
          ["Private IP", i.privateIp],
          ["Private DNS", i.privateDns],
          ["Public IP", i.publicIp ?? "None"],
          ["Public DNS", i.publicDns],
          ["IPv6", i.ipv6],
          ["Source / destination check", yesNo(i.sourceDestCheck)],
        ]}
      />
      <div className="props-section">Access and protection</div>
      <PropsTable
        rows={[
          ["IAM role", i.roleArn ? <RoleLink shell={shell} arn={i.roleArn} owner={i.iamProfileArn} /> : i.iamProfileArn ? "(couldn't read the instance profile)" : "None"],
          ["Instance profile", i.iamProfileArn],
          ["Instance metadata", i.metadataEndpoint === "disabled" ? "Disabled" : i.metadataTokens === "required" ? "IMDSv2 only (tokens required)" : i.metadataTokens === "optional" ? "IMDSv1 and IMDSv2 (tokens optional)" : null],
          ["Metadata hop limit", i.metadataHopLimit === null ? null : String(i.metadataHopLimit)],
          ["Termination protection", protection(i.terminationProtection)],
          ["Stop protection", protection(i.stopProtection)],
          ["Shutdown from the OS", i.shutdownBehavior === "terminate" ? "Terminates the instance" : i.shutdownBehavior === "stop" ? "Stops the instance" : null],
        ]}
      />
      <div className="props-section row">
        <span>Tags</span>
        <div className="spacer" />
        {onEditTags && (
          <button className="btn small" onClick={onEditTags}>
            Edit tags…
          </button>
        )}
      </div>
      <TagsTable tags={i.tags} />
    </div>
  );
}

function StorageTab({ i, onSnapshot }: { i: InstanceDetails; onSnapshot?: (volumeId: string) => void }) {
  const vols = new Map(i.volumes.map((v) => [v.id, v]));
  if (i.blockDevices.length === 0) return <p className="hint">No EBS volumes{i.rootDeviceType === "instance-store" ? ": the root device is an instance store, which is lost when the instance stops" : ""}.</p>;
  return (
    <div className="lambda-details">
      <table className="sync-table">
        <thead>
          <tr>
            <th>Device</th>
            <th>Volume</th>
            <th>Size</th>
            <th>Type</th>
            <th>IOPS / throughput</th>
            <th>Encrypted</th>
            <th>Deleted with instance</th>
            <th>State</th>
            <th>Attached</th>
            {onSnapshot && <th />}
          </tr>
        </thead>
        <tbody>
          {i.blockDevices.map((b) => {
            const v = b.volumeId ? vols.get(b.volumeId) : undefined;
            return (
              <tr key={b.device}>
                <td className="mono">
                  {b.device}
                  {b.device === i.rootDevice ? <span className="hint"> (root)</span> : null}
                </td>
                <td className="mono selectable">{b.volumeId ?? ""}</td>
                <td>{v?.sizeGib != null ? `${v.sizeGib} GiB` : ""}</td>
                <td>{v?.volumeType ?? ""}</td>
                <td>{[v?.iops ? `${v.iops.toLocaleString()} IOPS` : "", v?.throughput ? `${v.throughput} MiB/s` : ""].filter(Boolean).join(", ")}</td>
                <td>{v ? (v.encrypted ? "Yes" : "No") : ""}</td>
                <td>{yesNo(b.deleteOnTermination) ?? ""}</td>
                <td>{b.status ?? ""}</td>
                <td>{formatDate(b.attached)}</td>
                {onSnapshot && (
                  <td>
                    {b.volumeId && (
                      <button className="link-btn" onClick={() => onSnapshot(b.volumeId!)}>
                        Snapshot…
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {i.volumes.length === 0 && <p className="hint">Volume details couldn't be read (ec2:DescribeVolumes).</p>}
    </div>
  );
}

function NetworkingTab({ i, onGroup }: { i: InstanceDetails; onGroup: (id: string) => void }) {
  if (i.interfaces.length === 0) return <p className="hint">Network interfaces couldn't be read (ec2:DescribeNetworkInterfaces), or there are none.</p>;
  return (
    <div className="lambda-details">
      {i.interfaces.map((n) => (
        <div key={n.id}>
          <div className="props-section">
            {n.id} <span className="hint">· device {n.deviceIndex ?? "?"}</span>
          </div>
          <PropsTable
            rows={[
              ["Description", n.description],
              ["Private IPs", n.privateIps.map((p) => `${p.address}${p.primary ? " (primary)" : ""}${p.publicIp ? ` → ${p.publicIp}` : ""}`).join(", ") || n.privateIp],
              ["Private DNS", n.privateDns],
              ["Public IP", n.publicIp ? `${n.publicIp}${n.publicIpOwner === "amazon" ? " (auto-assigned: changes when the instance stops)" : " (Elastic IP)"}` : "None"],
              ["Public DNS", n.publicDns],
              ["IPv6", n.ipv6.join(", ")],
              ["Subnet", n.subnetId],
              ["MAC address", n.mac],
              [
                "Security groups",
                n.groups.length ? (
                  <>
                    {n.groups.map((g, k) => (
                      <span key={g.id}>
                        {k > 0 && ", "}
                        <button className="link-btn" onClick={() => onGroup(g.id)}>
                          {g.name ? `${g.name} (${g.id})` : g.id}
                        </button>
                      </span>
                    ))}
                  </>
                ) : null,
              ],
              ["Deleted with instance", yesNo(n.deleteOnTermination)],
              ["Source / destination check", yesNo(n.sourceDestCheck)],
              ["Type", n.interfaceType],
            ]}
          />
        </div>
      ))}
    </div>
  );
}

function SecurityTab({ i, onGroup }: { i: InstanceDetails; onGroup: (id: string) => void }) {
  if (i.securityGroups.length === 0) return <p className="hint">No security groups.</p>;
  if (i.groups.length === 0) return <p className="hint">The groups' rules couldn't be read (ec2:DescribeSecurityGroups): {i.securityGroups.map((g) => g.name ?? g.id).join(", ")}.</p>;
  return (
    <div className="lambda-details">
      <p className="hint">The rules of every group apply together: a connection is allowed if any group allows it.</p>
      {i.groups.map((g) => (
        <div key={g.id}>
          <div className="ec2-group-head">
            <button className="link-btn" onClick={() => onGroup(g.id)}>
              <b>{g.name}</b> ({g.id})
            </button>
            {g.description && <span className="hint">{g.description}</span>}
          </div>
          <div className="props-section">Inbound</div>
          <RulesTable rules={g.inbound} inbound onGroup={onGroup} />
          <div className="props-section">Outbound</div>
          <RulesTable rules={g.outbound} inbound={false} onGroup={onGroup} />
        </div>
      ))}
    </div>
  );
}
