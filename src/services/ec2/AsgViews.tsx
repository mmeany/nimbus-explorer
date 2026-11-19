// Auto Scaling groups: list config, group view (instances, activities,
// instance refreshes) and the dialogs for capacity, processes and refreshes.
import { useState } from "react";
import type { AppError } from "../../api/core";
import { ASG_PROCESSES, ec2Api, instanceLabel, type AsgGroup, type AsgGroupDetails, type Instance } from "../../api/ec2";
import { ErrorPanel } from "../../components/ErrorPanel";
import type { Column } from "../../components/FileList";
import { HelpTopic } from "../../components/HelpDialog";
import { AutoScalingIcon } from "../../components/Icons";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";
import { PropsTable, TagsTable, useLoad } from "./common";
import { Frame } from "./InstanceDialogs";
import type { KindConfig } from "./ResourceList";
import { Ref, ResourceHead } from "./StorageViews";

const ASG_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 240 },
  { id: "instances", label: "Instances", width: 75, align: "right" },
  { id: "desired", label: "Desired", width: 65, align: "right" },
  { id: "min", label: "Min", width: 50, align: "right" },
  { id: "max", label: "Max", width: 50, align: "right" },
  { id: "launch", label: "Launches from", width: 300 },
  { id: "health", label: "Health check", width: 95 },
  { id: "suspended", label: "Suspended", width: 160 },
];

export const asgConfig: KindConfig<AsgGroup> = {
  kind: "autoScaling",
  help: "ec2.autoScaling",
  noun: ["Auto Scaling group", "Auto Scaling groups"],
  load: ec2Api.asgs,
  key: (g) => g.name,
  columns: ASG_COLUMNS,
  icon: () => <AutoScalingIcon />,
  dimmed: (g) => g.desired === 0,
  cells: (g) => ({
    name: { text: g.name, sort: g.name.toLowerCase() },
    instances: { text: String(g.instances.length), sort: g.instances.length },
    desired: { text: String(g.desired), sort: g.desired },
    min: { text: String(g.min), sort: g.min },
    max: { text: String(g.max), sort: g.max },
    launch: { text: g.launchSource ?? "", sort: g.launchSource ?? "" },
    health: { text: g.healthCheckType ?? "", sort: g.healthCheckType ?? "" },
    suspended: { text: g.suspended.join(", "), sort: g.suspended.length },
  }),
  match: (g, f) => g.name.toLowerCase().includes(f.trim().toLowerCase()) || g.instances.some((i) => i.id.startsWith(f.trim())) || g.targetGroups.some((t) => t.toLowerCase().includes(f.trim().toLowerCase())),
  placeholder: "Group name, instance ID prefix or target group name",
  label: (g) => g.name,
  empty: "No Auto Scaling groups in this region.",
};

const ACTIVE_REFRESH = new Set(["Pending", "InProgress", "Cancelling", "RollbackInProgress", "Baking"]);

type Dialog = "capacity" | "processes" | "refresh" | null;

export function AsgView({ shell, id, reloadToken, instances }: { shell: Shell; id: string; reloadToken: number; instances: Map<string, Instance> }) {
  const [tick, setTick] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const { data: g, error, retry } = useLoad(
    `${id}|${reloadToken}|${tick}`,
    () => ec2Api.asg(id),
    (d) => (d && (d.refreshes.some((r) => ACTIVE_REFRESH.has(r.status ?? "")) || d.activities.some((a) => a.status === "InProgress" || a.status === "PreInService") || d.instances.length !== d.desired) ? 10_000 : null),
  );
  if (error && !g) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!g) return <div className="empty-note">Loading…</div>;
  const ro = shell.readOnly;
  const running = g.refreshes.find((r) => ACTIVE_REFRESH.has(r.status ?? ""));
  const done = (msg: string) => {
    setDialog(null);
    shell.showFlash(msg);
    setTick((t) => t + 1);
  };

  async function cancelRefresh() {
    const ok = await shell.ask(
      "Cancel instance refresh",
      <p>
        Stop the instance refresh of <b>{g!.name}</b>? Instances already replaced stay replaced; the rest keep their old settings.
      </p>,
      [
        { label: "Cancel refresh", value: "yes", danger: true },
        { label: "Keep it running", value: "no" },
      ],
      "no",
    );
    if (ok !== "yes") return;
    try {
      await ec2Api.asgCancelRefresh(g!.name);
      done(`Cancelling the instance refresh of ${g!.name}.`);
    } catch (e) {
      shell.showError(e);
    }
  }

  return (
    <div className="queue-view db-view">
      <ResourceHead shell={shell} id={g.name} name={null} badges={[`${g.instances.length} of ${g.desired} instances`, ...(g.suspended.length ? ["processes suspended"] : [])]} />
      {g.status && <div className="warn-note">{g.status}</div>}
      <HelpTopic id="ec2.asg" />
      <div className="lambda-details">
        <div className="row">
          <button className="btn" disabled={ro} onClick={() => setDialog("capacity")}>
            Set capacity…
          </button>
          <button className="btn" disabled={ro} onClick={() => setDialog("processes")}>
            Suspend / resume…
          </button>
          {running ? (
            <button className="btn" disabled={ro} onClick={() => void cancelRefresh()}>
              Cancel instance refresh…
            </button>
          ) : (
            <button className="btn" disabled={ro || g.instances.length === 0} onClick={() => setDialog("refresh")}>
              Start instance refresh…
            </button>
          )}
        </div>
        <PropsTable
          rows={[
            ["Capacity", `desired ${g.desired}, minimum ${g.min}, maximum ${g.max}`],
            ["Launches from", g.launchTemplateId ? <Ref key="lt" shell={shell} kind="launchTemplates" id={g.launchTemplateId} label={g.launchSource ?? g.launchTemplateId} /> : g.launchSource],
            [
              "Subnets",
              g.subnets.length ? (
                <span key="s">
                  {g.subnets.map((s, n) => (
                    <span key={s}>
                      {n > 0 && ", "}
                      <Ref shell={shell} kind="subnets" id={s} />
                    </span>
                  ))}
                </span>
              ) : (
                g.zones.join(", ")
              ),
            ],
            [
              "Target groups",
              g.targetGroups.length ? (
                <span key="t">
                  {g.targetGroups.map((t, n) => (
                    <span key={t}>
                      {n > 0 && ", "}
                      <Ref shell={shell} kind="targetGroups" id={t} />
                    </span>
                  ))}
                </span>
              ) : (
                "None"
              ),
            ],
            ["Classic load balancers", g.classicLoadBalancers.length ? g.classicLoadBalancers.join(", ") : null],
            ["Health check", `${g.healthCheckType ?? "EC2"}${g.healthCheckGrace != null ? `, grace period ${g.healthCheckGrace} s` : ""}`],
            ["Suspended processes", g.suspended.length ? g.suspended.join(", ") : "None"],
            ["Scaling policies", g.policies.length ? g.policies.join(", ") : "None"],
            ["Created", formatDate(g.created)],
          ]}
        />
        <div className="props-section">Instances ({g.instances.length})</div>
        {g.instances.length === 0 ? (
          <p className="hint">None.</p>
        ) : (
          <table className="sync-table">
            <thead>
              <tr>
                <th>Instance</th>
                <th>Lifecycle</th>
                <th>Health</th>
                <th>Type</th>
                <th>Zone</th>
                <th>Launched from</th>
                <th>Scale-in protection</th>
              </tr>
            </thead>
            <tbody>
              {g.instances.map((i) => {
                const x = instances.get(i.id);
                return (
                  <tr key={i.id}>
                    <td>
                      <Ref shell={shell} kind="instances" id={i.id} label={x ? instanceLabel(x) : undefined} />
                    </td>
                    <td>{i.lifecycle ?? ""}</td>
                    <td>
                      <span className={`status-pill ${i.health === "Healthy" ? "ok" : i.health === "Unhealthy" ? "bad" : "off"}`}>{i.health ?? "unknown"}</span>
                    </td>
                    <td>{i.instanceType ?? ""}</td>
                    <td>{i.az ?? ""}</td>
                    <td className="mono">{i.launchedFrom ?? ""}</td>
                    <td>{i.protected ? "Yes" : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="props-section">Instance refreshes</div>
        {g.refreshes.length === 0 ? (
          <p className="hint">None.</p>
        ) : (
          <table className="sync-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Done</th>
                <th>Minimum healthy</th>
                <th>Ended</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {g.refreshes.map((r) => (
                <tr key={r.id}>
                  <td>{formatDate(r.started)}</td>
                  <td>{r.status ?? ""}</td>
                  <td>{r.percentage != null ? `${r.percentage}%` : ""}</td>
                  <td>{r.minHealthy != null ? `${r.minHealthy}%` : ""}</td>
                  <td>{formatDate(r.ended)}</td>
                  <td className="hint">{r.statusReason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="props-section">Activity (newest first)</div>
        {g.activities.length === 0 ? (
          <p className="hint">No recent activity.</p>
        ) : (
          <table className="sync-table ec2-wrap">
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>What</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {g.activities.map((a, n) => (
                <tr key={n}>
                  <td>{formatDate(a.started)}</td>
                  <td className={a.status === "Failed" ? "field-error" : ""}>{a.status ?? ""}</td>
                  <td>
                    {a.description ?? ""}
                    {a.statusMessage ? <div className="hint">{a.statusMessage}</div> : null}
                  </td>
                  <td className="hint">{a.cause ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="props-section">Tags</div>
        <TagsTable tags={g.tags} />
      </div>
      {dialog === "capacity" && <CapacityDialog g={g} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "processes" && <ProcessesDialog g={g} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "refresh" && <RefreshDialog g={g} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  );
}

function CapacityDialog({ g, onClose, onDone }: { g: AsgGroupDetails; onClose: () => void; onDone: (m: string) => void }) {
  const [min, setMin] = useState(String(g.min));
  const [max, setMax] = useState(String(g.max));
  const [desired, setDesired] = useState(String(g.desired));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = [min, max, desired].map((v) => (/^\d+$/.test(v.trim()) ? Number(v) : NaN));
  const [lo, hi, want] = n;
  const problem = n.some(Number.isNaN) ? "Sizes are whole numbers" : lo > hi ? "Minimum can't be more than maximum" : want < lo || want > hi ? "Desired must be between minimum and maximum" : lo === g.min && hi === g.max && want === g.desired ? "Nothing changed yet" : null;

  async function save() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await ec2Api.asgCapacity(g.name, lo, hi, want);
      onDone(`${g.name}: desired ${want}, minimum ${lo}, maximum ${hi}.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }
  const field = (id: string, label: string, v: string, set: (s: string) => void) => (
    <>
      <label className="form-label" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="text-input num-input" value={v} onChange={(e) => set(e.target.value)} />
    </>
  );
  return (
    <Frame
      title={`Capacity of ${g.name}`}
      help="ec2.asg.capacity"
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary" disabled={!!problem || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className="pe-grid">
        {field("cap-des", "Desired", desired, setDesired)}
        {field("cap-min", "Minimum", min, setMin)}
        {field("cap-max", "Maximum", max, setMax)}
      </div>
      {want < g.instances.length && <p className="warn-note">Lowering desired below the current {g.instances.length} instances terminates the difference (instances protected from scale-in are kept).</p>}
      {want === 0 && <p className="hint">Desired 0 removes every instance from the group.</p>}
      <p className="hint">Scaling policies and scheduled actions may change desired again within the new minimum and maximum.</p>
      {problem && problem !== "Nothing changed yet" && <div className="field-error">{problem}</div>}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}

function ProcessesDialog({ g, onClose, onDone }: { g: AsgGroupDetails; onClose: () => void; onDone: (m: string) => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set(g.suspended));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suspend = [...sel].filter((p) => !g.suspended.includes(p));
  const resume = g.suspended.filter((p) => !sel.has(p));

  async function save() {
    if (busy || (!suspend.length && !resume.length)) return;
    setBusy(true);
    setError(null);
    try {
      if (suspend.length) await ec2Api.asgProcesses(g.name, suspend, true);
      if (resume.length) await ec2Api.asgProcesses(g.name, resume, false);
      onDone([suspend.length ? `Suspended ${suspend.join(", ")}` : "", resume.length ? `resumed ${resume.join(", ")}` : ""].filter(Boolean).join("; ") + ".");
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }
  return (
    <Frame
      title={`Processes of ${g.name}`}
      help="ec2.asg.processes"
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary" disabled={busy || (!suspend.length && !resume.length)} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p className="hint">Ticked processes are suspended: Auto Scaling stops doing them until they're resumed.</p>
      {ASG_PROCESSES.map(([p, about]) => (
        <label key={p} className="check-row">
          <input
            type="checkbox"
            checked={sel.has(p)}
            onChange={() =>
              setSel((s) => {
                const n = new Set(s);
                if (n.has(p)) n.delete(p);
                else n.add(p);
                return n;
              })
            }
          />{" "}
          <b>{p}</b> <span className="hint">· {about}</span>
        </label>
      ))}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}

function RefreshDialog({ g, onClose, onDone }: { g: AsgGroupDetails; onClose: () => void; onDone: (m: string) => void }) {
  const [minHealthy, setMinHealthy] = useState("90");
  const [warmup, setWarmup] = useState("");
  const [skip, setSkip] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mh = /^\d+$/.test(minHealthy.trim()) ? Number(minHealthy) : NaN;
  const wu = warmup.trim() === "" ? null : /^\d+$/.test(warmup.trim()) ? Number(warmup) : NaN;
  const problem = Number.isNaN(mh) || mh > 100 ? "Minimum healthy is 0 to 100 (%)" : Number.isNaN(wu as number) ? "Warm-up is a number of seconds" : null;

  async function save() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await ec2Api.asgStartRefresh(g.name, mh, wu, skip);
      onDone(`Started an instance refresh of ${g.name}; the view updates while it runs.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }
  return (
    <Frame
      title={`Instance refresh of ${g.name}`}
      help="ec2.asg.refresh"
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary danger" disabled={!!problem || busy} onClick={() => void save()}>
            {busy ? "Starting…" : "Start refresh"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p>
        Replaces the group's {g.instances.length} instance{g.instances.length === 1 ? "" : "s"} with new ones launched from its current settings, a batch at a time.
      </p>
      <div className="pe-grid">
        <label className="form-label" htmlFor="rf-mh">
          Minimum healthy
        </label>
        <div className="row">
          <input id="rf-mh" className="text-input num-input" value={minHealthy} onChange={(e) => setMinHealthy(e.target.value)} />
          <span className="hint">% of capacity kept in service while replacing</span>
        </div>
        <label className="form-label" htmlFor="rf-wu">
          Warm-up
        </label>
        <div className="row">
          <input id="rf-wu" className="text-input num-input" value={warmup} placeholder="default" onChange={(e) => setWarmup(e.target.value)} />
          <span className="hint">seconds before a new instance counts as healthy</span>
        </div>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> Skip instances that already match the group's launch template version
      </label>
      {problem && <div className="field-error">{problem}</div>}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}

