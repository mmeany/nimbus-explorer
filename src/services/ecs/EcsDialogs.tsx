// ECS dialogs: change a service's task definition revision, run a task.
import { useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { ecsApi, shortArn, type ClusterInfo, type ServiceInfo } from "../../api/ecs";

function Frame({ title, children, buttons, onClose, wide }: { title: string; children: React.ReactNode; buttons: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`dialog param-dialog ${wide ? "dialog-wide" : ""}`} role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-buttons">
          <div className="spacer" />
          {buttons}
        </div>
      </div>
    </div>
  );
}

const familyOf = (td: string) => td.slice(0, td.lastIndexOf(":")) || td;

export function RevisionDialog({ cluster, service, onClose, onDone }: { cluster: string; service: ServiceInfo; onClose: () => void; onDone: (msg: string) => void }) {
  const [family, setFamily] = useState(familyOf(service.taskDefinition));
  const [families, setFamilies] = useState<string[]>([]);
  const [revisions, setRevisions] = useState<string[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ecsApi.families("").then(setFamilies).catch(() => setFamilies([]));
  }, []);
  useEffect(() => {
    let stale = false;
    setRevisions(null);
    ecsApi
      .revisions(family)
      .then((r) => {
        if (stale) return;
        setRevisions(r);
        setChosen(r.find((x) => x !== service.taskDefinition) ?? r[0] ?? "");
      })
      .catch((e) => !stale && setError((e as AppError).message ?? String(e)));
    return () => {
      stale = true;
    };
  }, [family, service.taskDefinition]);

  async function deploy() {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      await ecsApi.updateService(cluster, service.name, { taskDefinition: chosen, forceNewDeployment: false });
      onDone(`Deploying ${chosen} to ${service.name}. ECS replaces the tasks gradually.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  const rev = (n: string) => Number(n.slice(n.lastIndexOf(":") + 1));
  const currentRev = familyOf(service.taskDefinition) === family ? rev(service.taskDefinition) : null;
  return (
    <Frame
      title={`Change task definition: ${service.name}`}
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary" disabled={!chosen || chosen === service.taskDefinition || busy} onClick={() => void deploy()}>
            {busy ? "Deploying…" : "Deploy"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p>
        Running now: <span className="mono">{service.taskDefinition}</span>. The service starts tasks from the revision you choose and stops the old ones,
        following its deployment settings{service.circuitBreakerRollback ? " (it rolls back on its own if the new tasks keep failing)" : ""}.
      </p>
      <div className="pe-grid">
        <label className="form-label" htmlFor="rv-fam">
          Family
        </label>
        <select id="rv-fam" className="text-input" value={family} onChange={(e) => setFamily(e.target.value)}>
          {[...new Set([familyOf(service.taskDefinition), ...families])].map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <label className="form-label" htmlFor="rv-rev">
          Revision
        </label>
        <select id="rv-rev" className="text-input" value={chosen} disabled={!revisions} onChange={(e) => setChosen(e.target.value)}>
          {(revisions ?? []).map((r) => (
            <option key={r} value={r}>
              {r}
              {r === service.taskDefinition ? " (running now)" : currentRev !== null && rev(r) < currentRev ? " (older: roll back)" : currentRev !== null ? " (newer)" : ""}
            </option>
          ))}
        </select>
      </div>
      {revisions && revisions.length === 0 && <div className="field-error">This family has no active revisions.</div>}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}

export function RunTaskDialog({ cluster, info, onClose, onDone }: { cluster: string; info: ClusterInfo | null; onClose: () => void; onDone: (ids: string[]) => void }) {
  const [families, setFamilies] = useState<string[] | null>(null);
  const [family, setFamily] = useState("");
  const [revisions, setRevisions] = useState<string[]>([]);
  const [revision, setRevision] = useState("");
  const [count, setCount] = useState("1");
  const providers = info?.capacityProviders ?? [];
  const [launch, setLaunch] = useState<string>(providers.length ? "default" : "FARGATE");
  const [services, setServices] = useState<string[]>([]);
  const [copyFrom, setCopyFrom] = useState("");
  const [subnets, setSubnets] = useState("");
  const [groups, setGroups] = useState("");
  const [publicIp, setPublicIp] = useState(false);
  const [container, setContainer] = useState("");
  const [command, setCommand] = useState("");
  const [env, setEnv] = useState("");
  const [exec, setExec] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ecsApi
      .families("")
      .then((f) => {
        setFamilies(f);
        if (f.length) setFamily((x) => x || f[0]);
      })
      .catch((e) => setError((e as AppError).message ?? String(e)));
    ecsApi
      .listServiceArns(cluster)
      .then((a) => setServices(a.map(shortArn)))
      .catch(() => setServices([]));
  }, [cluster]);
  useEffect(() => {
    if (!family) return;
    let stale = false;
    ecsApi
      .revisions(family)
      .then((r) => {
        if (stale) return;
        setRevisions(r);
        setRevision(r[0] ?? "");
      })
      .catch(() => !stale && setRevisions([]));
    return () => {
      stale = true;
    };
  }, [family]);

  // Copy a service's network settings (subnets, security groups, public IP).
  useEffect(() => {
    if (!copyFrom) return;
    ecsApi
      .service(cluster, copyFrom)
      .then((s) => {
        setSubnets(s.subnets.join(", "));
        setGroups(s.securityGroups.join(", "));
        setPublicIp(!!s.publicIp);
        if (s.launchType === "FARGATE" || s.launchType === "EC2") setLaunch(s.launchType);
        else if (s.strategy[0]) setLaunch(`cp:${s.strategy[0].capacityProvider}`);
        const f = familyOf(s.taskDefinition);
        setFamily(f);
      })
      .catch((e) => setError((e as AppError).message ?? String(e)));
  }, [copyFrom, cluster]);

  const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const envPairs = useMemo(
    () =>
      env
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l): [string, string] | null => (l.includes("=") ? [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1)] : null)),
    [env],
  );
  const n = Number(count);
  const problem = !revision
    ? "Choose a task definition"
    : !/^\d+$/.test(count) || n < 1 || n > 10
      ? "Run 1 to 10 tasks at a time"
      : launch === "FARGATE" && !list(subnets).length
        ? "Fargate tasks need at least one subnet (or copy them from a service)"
        : envPairs.some((p) => !p || !p[0])
          ? "Write environment overrides as NAME=value, one per line"
          : (command.trim() || envPairs.length) && !container.trim()
            ? "Name the container the overrides apply to"
            : null;

  async function run() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const cmd = command.trim() ? await ecsApi.splitCommand(command) : null;
      const ids = await ecsApi.runTask({
        cluster,
        taskDefinition: revision,
        count: n,
        launchType: launch === "FARGATE" || launch === "EC2" ? launch : null,
        capacityProvider: launch.startsWith("cp:") ? launch.slice(3) : null,
        subnets: list(subnets),
        securityGroups: list(groups),
        publicIp,
        container: container.trim() || null,
        command: cmd,
        env: envPairs.filter((p): p is [string, string] => !!p),
        exec,
      });
      onDone(ids);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <Frame
      title={`Run task in ${cluster}`}
      wide
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary" disabled={!!problem || busy} onClick={() => void run()}>
            {busy ? "Starting…" : "Run"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p className="hint">A one-off task (not part of a service): it runs until its essential containers exit, or until you stop it.</p>
      <div className="pe-grid">
        <label className="form-label" htmlFor="rt-copy">
          Copy settings from
        </label>
        <select id="rt-copy" className="text-input" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
          <option value="">(nothing: fill them in below)</option>
          {services.map((s) => (
            <option key={s} value={s}>
              service {s}
            </option>
          ))}
        </select>
        <label className="form-label" htmlFor="rt-fam">
          Task definition
        </label>
        <div className="row">
          <select id="rt-fam" className="text-input" value={family} disabled={!families} onChange={(e) => setFamily(e.target.value)}>
            {(families ?? []).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <select className="text-input" aria-label="Revision" value={revision} onChange={(e) => setRevision(e.target.value)}>
            {revisions.map((r, i) => (
              <option key={r} value={r}>
                {r.slice(r.lastIndexOf(":") + 1)}
                {i === 0 ? " (latest)" : ""}
              </option>
            ))}
          </select>
        </div>
        <label className="form-label" htmlFor="rt-count">
          Tasks
        </label>
        <input id="rt-count" className="text-input num-input" value={count} onChange={(e) => setCount(e.target.value)} />
        <label className="form-label" htmlFor="rt-launch">
          Run on
        </label>
        <select id="rt-launch" className="text-input" value={launch} onChange={(e) => setLaunch(e.target.value)}>
          {providers.length > 0 && <option value="default">The cluster's default capacity strategy</option>}
          {providers.map((p) => (
            <option key={p} value={`cp:${p}`}>
              Capacity provider {p}
            </option>
          ))}
          <option value="FARGATE">Fargate</option>
          <option value="EC2">EC2 (the cluster's container instances)</option>
        </select>
        <label className="form-label" htmlFor="rt-sub">
          Subnets
        </label>
        <input id="rt-sub" className="text-input mono" placeholder="subnet-…, subnet-… (awsvpc networking)" value={subnets} spellCheck={false} onChange={(e) => setSubnets(e.target.value)} />
        <label className="form-label" htmlFor="rt-sg">
          Security groups
        </label>
        <input id="rt-sg" className="text-input mono" placeholder="sg-… (default group if empty)" value={groups} spellCheck={false} onChange={(e) => setGroups(e.target.value)} />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={publicIp} onChange={(e) => setPublicIp(e.target.checked)} /> Assign a public IP (needed in public subnets without a NAT gateway to pull
        images)
      </label>
      <label className="check-row">
        <input type="checkbox" checked={exec} onChange={(e) => setExec(e.target.checked)} /> Enable ECS Exec (shell access; the task role needs the SSM permissions)
      </label>
      <div className="props-section">Overrides (optional)</div>
      <div className="pe-grid">
        <label className="form-label" htmlFor="rt-cont">
          Container
        </label>
        <input id="rt-cont" className="text-input mono" placeholder="container name from the task definition" value={container} spellCheck={false} onChange={(e) => setContainer(e.target.value)} />
        <label className="form-label" htmlFor="rt-cmd">
          Command
        </label>
        <input id="rt-cmd" className="text-input mono" placeholder={'e.g. python manage.py migrate  or  sh -c "echo hi"'} value={command} spellCheck={false} onChange={(e) => setCommand(e.target.value)} />
        <label className="form-label" htmlFor="rt-env">
          Environment
        </label>
        <textarea id="rt-env" className="text-input mono" rows={3} placeholder="NAME=value, one per line" value={env} spellCheck={false} onChange={(e) => setEnv(e.target.value)} />
      </div>
      {problem && families && <div className="field-error">{problem}</div>}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}
