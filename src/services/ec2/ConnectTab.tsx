// Connect tab: commands for reaching an instance from your own machine
// (Session Manager, SSH, Instance Connect, Remote Desktop), with notes on
// what makes each one work. The app itself never connects to instances.
import { connectCommands, ec2Api, isOpenToWorld, type InstanceDetails } from "../../api/ec2";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";
import { PropsTable, useLoad } from "./common";

/** Inbound rules of the instance's groups that allow TCP `port` (or all traffic). */
function opens(i: InstanceDetails, port: number): { any: boolean; world: boolean } {
  const rules = i.groups.flatMap((g) => g.inbound);
  const hits = rules.filter((r) => {
    if (r.protocol === "All") return true;
    if (r.protocol !== "TCP") return false;
    if (r.ports === "All") return true;
    const [a, b] = r.ports.split("-").map(Number);
    return port >= a && port <= (b ?? a);
  });
  return { any: hits.length > 0, world: hits.some(isOpenToWorld) };
}

export function ConnectTab({ shell, i }: { shell: Shell; i: InstanceDetails }) {
  const region = shell.connection?.serviceRegion ?? "";
  const override = shell.connection?.endpointSource === "override" ? shell.connection.endpointUrl : null;
  const { data: agent } = useLoad(`ssm|${i.id}`, () => ec2Api.ssmAgent(i.id));
  const cmds = connectCommands(i, shell.profile, region, override);
  const port = i.windows ? 3389 : 22;
  const open = opens(i, port);
  const running = i.state === "running";

  const agentText = !agent
    ? "Checking…"
    : agent.error
      ? `Couldn't ask Systems Manager (${agent.error})`
      : !agent.managed
        ? "Not managed: Session Manager won't work until the instance runs the SSM agent, has a role allowing Systems Manager (e.g. AmazonSSMManagedInstanceCore) and can reach the Systems Manager endpoints."
        : `${agent.pingStatus ?? "unknown"}${agent.lastPing ? `, last seen ${formatDate(agent.lastPing)}` : ""}${agent.agentVersion ? ` · agent ${agent.agentVersion}${agent.latestAgent === false ? " (an update is available)" : ""}` : ""}`;

  return (
    <div className="lambda-details">
      {!running && <div className="warn-note">The instance is {i.state ?? "not running"}: start it before connecting.</div>}
      <div className="props-section">Reaching the instance</div>
      <PropsTable
        rows={[
          ["Systems Manager", agentText],
          ["Public address", i.publicDns ?? i.publicIp ?? "None: reach it from inside its VPC, through Session Manager, or an Instance Connect Endpoint"],
          ["Private address", i.privateIp],
          [
            `Port ${port} (${i.windows ? "RDP" : "SSH"})`,
            !i.groups.length ? "Unknown (security groups couldn't be read)" : open.world ? "Open to the internet" : open.any ? "Open to some sources (see Security groups)" : "Closed in every security group",
          ],
          ["Key pair", i.keyName ? `${i.keyName} (its private key, e.g. ~/.ssh/${i.keyName}.pem, is on whoever created it)` : "None"],
        ]}
      />
      {shell.connection?.endpointUrl && <p className="hint">This connection uses a custom endpoint; Session Manager and Instance Connect only work against real AWS.</p>}
      {cmds.map((c) => (
        <div key={c.id}>
          <div className="props-section">{c.title}</div>
          <div className="row sfn-cmd">
            <code className="mono selectable">{c.command}</code>
            <button className="link-btn" onClick={() => void shell.copyText(c.command)}>
              Copy
            </button>
          </div>
          <p className="hint">{c.note}</p>
        </div>
      ))}
    </div>
  );
}
