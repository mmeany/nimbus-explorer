// Load balancers (listeners and rules) and target groups (target health,
// register / deregister targets).
import { useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { ec2Api, instanceLabel, type Instance, type LoadBalancer, type RuleAction, type TargetGroup } from "../../api/ec2";
import { ErrorPanel } from "../../components/ErrorPanel";
import type { Column } from "../../components/FileList";
import { HelpTopic } from "../../components/HelpDialog";
import { LoadBalancerIcon, TargetIcon } from "../../components/Icons";
import { formatDate } from "../../format";
import { EC2_ROOT } from "../../shell/places";
import type { Shell } from "../../shell/shell";
import { PropsTable, TagsTable, useLoad } from "./common";
import { Frame } from "./InstanceDialogs";
import type { KindConfig } from "./ResourceList";
import { Ref, ResourceHead } from "./StorageViews";

const lower = (s: string) => s.toLowerCase();

function Actions({ shell, actions }: { shell: Shell; actions: RuleAction[] }) {
  return (
    <>
      {actions.map((a, n) => (
        <div key={n}>
          {a.targetGroups.length ? (
            <>
              forward to{" "}
              {a.targetGroups.map(([g, w], k) => (
                <span key={g}>
                  {k > 0 && ", "}
                  <button className="link-btn" onClick={() => shell.navigate({ ...EC2_ROOT, kind: "targetGroups", id: g })}>
                    {g}
                  </button>
                  {a.targetGroups.length > 1 ? ` (weight ${w ?? 1})` : ""}
                </span>
              ))}
            </>
          ) : (
            a.text
          )}
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Load balancers

const LB_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 220 },
  { id: "type", label: "Type", width: 90 },
  { id: "scheme", label: "Scheme", width: 105 },
  { id: "state", label: "State", width: 90 },
  { id: "dns", label: "DNS name", width: 360 },
  { id: "vpc", label: "VPC", width: 190 },
  { id: "created", label: "Created", width: 165 },
];

export const lbConfig: KindConfig<LoadBalancer> = {
  kind: "loadBalancers",
  help: "ec2.loadBalancers",
  noun: ["load balancer", "load balancers"],
  load: ec2Api.loadBalancers,
  key: (l) => l.name,
  columns: LB_COLUMNS,
  icon: () => <LoadBalancerIcon />,
  dimmed: (l) => l.state !== "active",
  cells: (l) => ({
    name: { text: l.name, sort: lower(l.name) },
    type: { text: l.lbType ?? "", sort: l.lbType ?? "" },
    scheme: { text: l.scheme ?? "", sort: l.scheme ?? "" },
    state: { text: l.state ?? "", sort: l.state ?? "" },
    dns: { text: l.dnsName ?? "", sort: l.dnsName ?? "" },
    vpc: { text: l.vpcId ?? "", sort: l.vpcId ?? "" },
    created: { text: formatDate(l.created), sort: l.created ?? "" },
  }),
  match: (l, f) => lower(l.name).includes(lower(f.trim())) || lower(l.dnsName ?? "").includes(lower(f.trim())) || (l.vpcId ?? "").startsWith(f.trim()),
  placeholder: "Name, DNS name or VPC ID (Enter to apply)",
  label: (l) => l.name,
  empty: "No load balancers in this region.",
};

export function LoadBalancerView({ shell, id, reloadToken }: { shell: Shell; id: string; reloadToken: number }) {
  const { data: l, error, retry } = useLoad(`${id}|${reloadToken}`, () => ec2Api.loadBalancer(id), (d) => (d?.state === "provisioning" ? 15_000 : null));
  if (error && !l) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!l) return <div className="empty-note">Loading…</div>;
  const attr = new Map(l.attributes);
  return (
    <div className="queue-view db-view">
      <ResourceHead shell={shell} id={l.name} name={null} state={l.state} badges={[l.lbType ?? "", l.scheme ?? ""].filter(Boolean)} />
      {l.stateReason && <div className="warn-note">{l.stateReason}</div>}
      <HelpTopic id="ec2.loadBalancer" />
      <div className="lambda-details">
        <PropsTable
          rows={[
            [
              "DNS name",
              l.dnsName ? (
                <span className="row">
                  <span className="mono selectable">{l.dnsName}</span>
                  <button className="link-btn" onClick={() => void shell.copyText(l.dnsName!)}>
                    Copy
                  </button>
                </span>
              ) : null,
            ],
            ["ARN", l.arn],
            ["VPC", <Ref key="v" shell={shell} kind="vpcs" id={l.vpcId} />],
            [
              "Zones",
              <span key="z">
                {l.zones.map((z, n) => (
                  <span key={z.zone}>
                    {n > 0 && ", "}
                    {z.zone} (<Ref shell={shell} kind="subnets" id={z.subnetId} />
                    {z.addresses.length ? ` ${z.addresses.join(", ")}` : ""})
                  </span>
                ))}
              </span>,
            ],
            [
              "Security groups",
              l.securityGroups.length ? (
                <span key="g">
                  {l.securityGroups.map((g, n) => (
                    <span key={g}>
                      {n > 0 && ", "}
                      <Ref shell={shell} kind="securityGroups" id={g} />
                    </span>
                  ))}
                </span>
              ) : l.lbType === "application" ? "None" : null,
            ],
            ["IP address type", l.ipType],
            ["Created", formatDate(l.created)],
            ["Deletion protection", attr.has("deletion_protection.enabled") ? (attr.get("deletion_protection.enabled") === "true" ? "On" : "Off") : null],
            ["Idle timeout", attr.has("idle_timeout.timeout_seconds") ? `${attr.get("idle_timeout.timeout_seconds")} seconds` : null],
            ["Cross-zone load balancing", attr.has("load_balancing.cross_zone.enabled") ? (attr.get("load_balancing.cross_zone.enabled") === "true" ? "On" : "Off") : null],
            ["Access logs", attr.get("access_logs.s3.enabled") === "true" ? `On, to s3://${attr.get("access_logs.s3.bucket") ?? "?"}` : attr.has("access_logs.s3.enabled") ? "Off" : null],
          ]}
        />
        <div className="props-section">Listeners ({l.listeners.length})</div>
        {l.listeners.length === 0 && <p className="hint">No listeners: the load balancer accepts no traffic.</p>}
        {l.listeners.map((li) => (
          <div key={li.arn}>
            <div className="ec2-group-head">
              <b>
                {li.protocol} {li.port}
              </b>
              {li.sslPolicy && <span className="hint">TLS policy {li.sslPolicy}</span>}
              {li.certificates.length > 0 && <span className="hint">{li.certificates.length} certificate{li.certificates.length === 1 ? "" : "s"}</span>}
            </div>
            {li.rules.length > 0 ? (
              <table className="sync-table">
                <thead>
                  <tr>
                    <th>Priority</th>
                    <th>When</th>
                    <th>Then</th>
                  </tr>
                </thead>
                <tbody>
                  {li.rules.map((r, n) => (
                    <tr key={n}>
                      <td>{r.isDefault ? "default" : r.priority}</td>
                      <td>{r.isDefault ? <span className="hint">no other rule matches</span> : r.conditions.join(" and ")}</td>
                      <td>
                        <Actions shell={shell} actions={r.actions} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <PropsTable rows={[["Default action", <Actions key="a" shell={shell} actions={li.defaultActions} />]]} />
            )}
          </div>
        ))}
        <div className="props-section">Tags</div>
        <TagsTable tags={l.tags} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Target groups

const TG_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 230 },
  { id: "protocol", label: "Protocol : port", width: 120 },
  { id: "type", label: "Target type", width: 90 },
  { id: "lbs", label: "Load balancers", width: 260 },
  { id: "vpc", label: "VPC", width: 190 },
  { id: "check", label: "Health check", width: 220 },
];

const checkText = (g: TargetGroup) => [g.healthCheck.protocol, g.healthCheck.path].filter(Boolean).join(" ");

export const tgConfig: KindConfig<TargetGroup> = {
  kind: "targetGroups",
  help: "ec2.targetGroups",
  noun: ["target group", "target groups"],
  load: ec2Api.targetGroups,
  key: (g) => g.name,
  columns: TG_COLUMNS,
  icon: () => <TargetIcon />,
  dimmed: (g) => g.loadBalancers.length === 0,
  cells: (g) => ({
    name: { text: g.name, sort: lower(g.name) },
    protocol: { text: [g.protocol, g.port].filter((x) => x != null).join(" : "), sort: g.port ?? 0 },
    type: { text: g.targetType ?? "", sort: g.targetType ?? "" },
    lbs: { text: g.loadBalancers.join(", ") || "none", sort: g.loadBalancers.join(",") },
    vpc: { text: g.vpcId ?? "", sort: g.vpcId ?? "" },
    check: { text: checkText(g), sort: checkText(g) },
  }),
  match: (g, f) => lower(g.name).includes(lower(f.trim())) || g.loadBalancers.some((l) => lower(l).includes(lower(f.trim()))),
  placeholder: "Target group or load balancer name (Enter to apply)",
  label: (g) => g.name,
  empty: "No target groups in this region.",
};

const HEALTH_TONE: Record<string, string> = { healthy: "ok", unhealthy: "bad", initial: "busy", draining: "busy" };

export function TargetGroupView({ shell, id, reloadToken, instances }: { shell: Shell; id: string; reloadToken: number; instances: Map<string, Instance> }) {
  const [tick, setTick] = useState(0);
  const { data: g, error, retry } = useLoad(`${id}|${reloadToken}|${tick}`, () => ec2Api.targetGroup(id), (d) => (d?.targets.some((t) => t.state === "initial" || t.state === "draining") ? 10_000 : null));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [registering, setRegistering] = useState(false);
  if (error && !g) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!g) return <div className="empty-note">Loading…</div>;
  const key = (t: { id: string; port: number | null }) => `${t.id}|${t.port ?? ""}`;
  const ro = shell.readOnly;
  const changed = (msg: string) => {
    setPicked(new Set());
    setRegistering(false);
    shell.showFlash(msg);
    setTick((t) => t + 1);
  };

  async function deregister() {
    const list = g!.targets.filter((t) => picked.has(key(t)));
    const ok = await shell.ask(
      "Deregister targets",
      <>
        <p>
          Remove {list.length === 1 ? <span className="mono">{list[0].id}</span> : `${list.length} targets`} from <b>{g!.name}</b>?
        </p>
        <p className="hint">The load balancer stops sending new requests to them; existing connections drain for the deregistration delay{g!.attributes.find(([k]) => k === "deregistration_delay.timeout_seconds") ? ` (${g!.attributes.find(([k]) => k === "deregistration_delay.timeout_seconds")![1]} s)` : ""}. An Auto Scaling group that manages this target group may register them again.</p>
      </>,
      [
        { label: "Deregister", value: "yes", danger: true },
        { label: "Cancel", value: "no" },
      ],
      "no",
    );
    if (ok !== "yes") return;
    shell.setWorking("Deregistering…");
    try {
      await ec2Api.deregisterTargets(
        g!.name,
        list.map((t) => ({ id: t.id, port: t.port })),
      );
      changed(`Deregistering ${list.length === 1 ? list[0].id : `${list.length} targets`} from ${g!.name}.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
    }
  }

  const hc = g.healthCheck;
  return (
    <div className="queue-view db-view">
      <ResourceHead shell={shell} id={g.name} name={null} badges={[[g.protocol, g.port].filter((x) => x != null).join(" "), g.targetType ?? ""].filter(Boolean)} />
      <HelpTopic id="ec2.targetGroup" />
      <div className="lambda-details">
        <PropsTable
          rows={[
            ["ARN", g.arn],
            ["Target type", g.targetType],
            ["VPC", <Ref key="v" shell={shell} kind="vpcs" id={g.vpcId} />],
            [
              "Load balancers",
              g.loadBalancers.length ? (
                <span key="l">
                  {g.loadBalancers.map((n, k) => (
                    <span key={n}>
                      {k > 0 && ", "}
                      <Ref shell={shell} kind="loadBalancers" id={n} />
                    </span>
                  ))}
                </span>
              ) : (
                "None: no load balancer sends traffic here"
              ),
            ],
            ["Health check", `${hc.protocol ?? "?"} ${hc.path ?? ""} on port ${hc.port ?? "traffic port"}${hc.matcher ? `, expects ${hc.matcher}` : ""}`],
            ["Check timing", `every ${hc.interval ?? "?"} s, timeout ${hc.timeout ?? "?"} s, healthy after ${hc.healthyThreshold ?? "?"}, unhealthy after ${hc.unhealthyThreshold ?? "?"}`],
            ...g.attributes.map(([k, v]) => [k, v] as [string, string]),
          ]}
        />
        <div className="props-section row">
          <span>Targets ({g.targets.length})</span>
          <div className="spacer" />
          <button className="btn small" disabled={ro || g.targetType === "lambda" || g.targetType === "alb"} title={g.targetType === "lambda" || g.targetType === "alb" ? "Register this kind of target in the AWS console" : ""} onClick={() => setRegistering(true)}>
            Register targets…
          </button>
          <button className="btn small" disabled={ro || picked.size === 0} onClick={() => void deregister()}>
            Deregister selected…
          </button>
        </div>
        {g.targets.length === 0 ? (
          <p className="hint">No targets registered.</p>
        ) : (
          <table className="sync-table">
            <thead>
              <tr>
                <th />
                <th>Target</th>
                <th>Port</th>
                <th>Zone</th>
                <th>Health</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {g.targets.map((t) => {
                const i = instances.get(t.id);
                return (
                  <tr key={key(t)}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${t.id}`}
                        disabled={ro}
                        checked={picked.has(key(t))}
                        onChange={() =>
                          setPicked((p) => {
                            const n = new Set(p);
                            if (n.has(key(t))) n.delete(key(t));
                            else n.add(key(t));
                            return n;
                          })
                        }
                      />
                    </td>
                    <td>{t.id.startsWith("i-") ? <Ref shell={shell} kind="instances" id={t.id} label={i ? instanceLabel(i) : undefined} /> : <span className="mono">{t.id}</span>}</td>
                    <td>{t.port ?? ""}</td>
                    <td>{t.az ?? ""}</td>
                    <td>
                      <span className={`status-pill ${HEALTH_TONE[t.state ?? ""] ?? "off"}`}>{t.state ?? "unknown"}</span>
                    </td>
                    <td className="hint">{t.description ?? t.reason ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="props-section">Tags</div>
        <TagsTable tags={g.tags} />
      </div>
      {registering && <RegisterDialog group={g} instances={instances} onClose={() => setRegistering(false)} onDone={changed} />}
    </div>
  );
}

function RegisterDialog({ group, instances, onClose, onDone }: { group: TargetGroup & { targets: { id: string }[] }; instances: Map<string, Instance>; onClose: () => void; onDone: (msg: string) => void }) {
  const byInstance = group.targetType !== "ip";
  const already = new Set(group.targets.map((t) => t.id));
  const candidates = useMemo(
    () => [...instances.values()].filter((i) => i.vpcId === group.vpcId && (i.state === "running" || i.state === "stopped") && !already.has(i.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instances, group.vpcId],
  );
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [ips, setIps] = useState("");
  const [port, setPort] = useState(group.port ? String(group.port) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const portNum = port.trim() ? Number(port) : null;
  const targets = byInstance ? [...picked].map((id) => ({ id, port: portNum })) : ips.split(/[\s,]+/).filter(Boolean).map((id) => ({ id, port: portNum }));
  const problem = portNum !== null && (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) ? "Ports are 1 to 65535" : targets.length === 0 ? (byInstance ? "Tick at least one instance" : "Enter at least one IP address") : null;

  async function save() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await ec2Api.registerTargets(group.name, targets);
      onDone(`Registering ${targets.length === 1 ? targets[0].id : `${targets.length} targets`} with ${group.name}; health checks start now.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <Frame
      title={`Register targets with ${group.name}`}
      help="ec2.targetGroup.register"
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary" disabled={!!problem || busy} onClick={() => void save()}>
            {busy ? "Registering…" : "Register"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      {byInstance ? (
        candidates.length === 0 ? (
          <p className="hint">No running or stopped instances in {group.vpcId ?? "this VPC"} that aren't registered already.</p>
        ) : (
          <div className="ec2-pick-list">
            {candidates.map((i) => (
              <label key={i.id} className="check-row">
                <input
                  type="checkbox"
                  checked={picked.has(i.id)}
                  onChange={() =>
                    setPicked((p) => {
                      const n = new Set(p);
                      if (n.has(i.id)) n.delete(i.id);
                      else n.add(i.id);
                      return n;
                    })
                  }
                />{" "}
                {instanceLabel(i)} <span className="hint">· {i.state} · {i.az}</span>
              </label>
            ))}
          </div>
        )
      ) : (
        <>
          <label className="form-label" htmlFor="rt-ips">
            IP addresses (separated by spaces or commas)
          </label>
          <input id="rt-ips" className="text-input mono" value={ips} spellCheck={false} autoFocus onChange={(e) => setIps(e.target.value)} />
        </>
      )}
      <div className="pe-grid">
        <label className="form-label" htmlFor="rt-port">
          Port
        </label>
        <div className="row">
          <input id="rt-port" className="text-input num-input" value={port} onChange={(e) => setPort(e.target.value)} />
          <span className="hint">blank = the group's port{group.port ? ` (${group.port})` : ""}</span>
        </div>
      </div>
      {problem && targets.length > 0 && <div className="field-error">{problem}</div>}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}
