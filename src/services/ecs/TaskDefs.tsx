// ECS task definitions: families (active / inactive) and one family's
// revisions with details, the JSON, a comparison with another revision, new
// revisions from edited JSON, and deregistering.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppError } from "../../api/core";
import { ecsApi, type TaskDefJson } from "../../api/ecs";
import { DiffView } from "../../components/DiffView";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { EcsTaskIcon } from "../../components/Icons";
import { PageBar } from "../../components/PageBar";
import { ValueEditor } from "../../components/ValueEditor";
import { ValueView } from "../../components/ValueView";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";
import { usePaging } from "../../state/paged";
import { PropRows } from "./EcsViews";

const COLUMNS: Column[] = [{ id: "name", label: "Family", width: 420 }];

export function FamilyList({ shell, filter, reloadToken, onOpen }: { shell: Shell; filter: string; reloadToken: number; onOpen: (family: string) => void }) {
  const [inactive, setInactive] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [data, setData] = useState<{ key: string; list: string[] | null; error: AppError | null } | null>(null);
  const key = `${filter}|${inactive}|${reloadToken}`;
  useEffect(() => {
    let stale = false;
    ecsApi
      .families(filter, inactive)
      .then((list) => !stale && setData({ key, list, error: null }))
      .catch((e) => !stale && setData({ key, list: null, error: e as AppError }));
    return () => {
      stale = true;
    };
  }, [key, filter, inactive]);
  const current = data?.key === key ? data : null;
  const list = current?.list ?? [];
  const paging = usePaging(`${filter}|${inactive}`, list.length, "ecs.families.pageSize", true);
  const rows: Row[] = useMemo(() => paging.slice(list).map((f) => ({ key: f, icon: <EcsTaskIcon />, isContainer: false, dimmed: inactive, cells: { name: { text: f, sort: f } } })), [paging, list, inactive]);
  return (
    <>
      <div className="row filter-bar">
        <div className="segmented small">
          <button className={!inactive ? "active" : ""} onClick={() => setInactive(false)}>
            Active
          </button>
          <button className={inactive ? "active" : ""} onClick={() => setInactive(true)}>
            Inactive
          </button>
        </div>
        <span className="hint">{inactive ? "Families whose revisions are all deregistered." : "Families with at least one active revision."}</span>
      </div>
      {current?.error ? (
        <ErrorPanel error={current.error} profile={shell.profile} onRetry={() => setData(null)} />
      ) : (
        <>
          <FileList columns={COLUMNS} rows={rows} selected={selected} onSelectionChange={setSelected} onOpen={onOpen} emptyText={!current ? "Loading…" : filter ? `No task definition families begin with "${filter}".` : "No task definitions."} />
          {list.length > paging.pageSize && <PageBar {...paging.bar} loading={false} />}
        </>
      )}
    </>
  );
}

type Def = Record<string, unknown>;
type Container = Record<string, unknown>;
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

function ContainerDetails({ c }: { c: Container }) {
  const ports = arr(c.portMappings).map((p) => `${str(p.containerPort)}${p.hostPort && p.hostPort !== p.containerPort ? `→${str(p.hostPort)}` : ""}/${str(p.protocol || "tcp")}${p.name ? ` (${str(p.name)})` : ""}`);
  const log = (c.logConfiguration ?? null) as Record<string, unknown> | null;
  const logOpts = (log?.options ?? {}) as Record<string, string>;
  const env = arr(c.environment);
  const secrets = arr(c.secrets);
  const hc = (c.healthCheck ?? null) as Record<string, unknown> | null;
  return (
    <details className="td-container" open>
      <summary>
        <span className="mono">{str(c.name)}</span> <span className="hint">{str(c.image)}</span>
        {c.essential === false ? <span className="hint"> · not essential</span> : null}
      </summary>
      <PropRows
        rows={[
          ["Image", <span className="mono">{str(c.image)}</span>],
          ["CPU units", str(c.cpu) || null],
          ["Memory", c.memory ? `${str(c.memory)} MB (hard limit)` : c.memoryReservation ? `${str(c.memoryReservation)} MB (soft limit)` : null],
          ["Ports", ports.join(", ")],
          ["Command", Array.isArray(c.command) ? <span className="mono">{(c.command as string[]).join(" ")}</span> : null],
          ["Entry point", Array.isArray(c.entryPoint) ? <span className="mono">{(c.entryPoint as string[]).join(" ")}</span> : null],
          ["Working directory", str(c.workingDirectory)],
          ["Health check", hc && Array.isArray(hc.command) ? <span className="mono">{(hc.command as string[]).join(" ")}</span> : null],
          ["Depends on", arr(c.dependsOn).map((d) => `${str(d.containerName)} (${str(d.condition).toLowerCase()})`).join(", ")],
          ["Logs", log ? `${str(log.logDriver)}${logOpts["awslogs-group"] ? `: ${logOpts["awslogs-group"]}${logOpts["awslogs-stream-prefix"] ? ` (prefix ${logOpts["awslogs-stream-prefix"]})` : ""}` : ""}` : null],
        ]}
      />
      {env.length > 0 && (
        <table className="sync-table env-table">
          <thead>
            <tr>
              <th>Environment variable</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {env.map((e) => (
              <tr key={str(e.name)}>
                <td className="mono">{str(e.name)}</td>
                <td className="mono">{str(e.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {secrets.length > 0 && (
        <table className="sync-table env-table">
          <thead>
            <tr>
              <th>Secret</th>
              <th>From (Secrets Manager / Parameter Store)</th>
            </tr>
          </thead>
          <tbody>
            {secrets.map((e) => (
              <tr key={str(e.name)}>
                <td className="mono">{str(e.name)}</td>
                <td className="mono">{str(e.valueFrom)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

function Details({ td }: { td: TaskDefJson }) {
  const d = useMemo(() => JSON.parse(td.json) as Def, [td.json]);
  const rp = (d.runtimePlatform ?? null) as Record<string, string> | null;
  return (
    <div className="lambda-details">
      <PropRows
        rows={[
          ["Status", td.status.toLowerCase()],
          ["Runs on", arr(d.requiresCompatibilities as unknown).length ? (d.requiresCompatibilities as string[]).join(", ") : null],
          ["CPU / memory", d.cpu || d.memory ? `${str(d.cpu) || "?"} CPU units · ${str(d.memory) || "?"} MB` : null],
          ["Network mode", str(d.networkMode)],
          ["Platform", rp ? [rp.operatingSystemFamily, rp.cpuArchitecture].filter(Boolean).join(", ") : null],
          ["Task role", d.taskRoleArn ? <span className="mono">{str(d.taskRoleArn)}</span> : null],
          ["Execution role", d.executionRoleArn ? <span className="mono">{str(d.executionRoleArn)}</span> : null],
          ["Volumes", arr(d.volumes).map((v) => str(v.name)).join(", ")],
          ["Ephemeral storage", d.ephemeralStorage ? `${str((d.ephemeralStorage as Record<string, unknown>).sizeInGiB)} GiB` : null],
          ["Registered", d.registeredAt ? formatDate(typeof d.registeredAt === "number" ? new Date((d.registeredAt as number) * 1000).toISOString() : str(d.registeredAt)) : null],
          ["Registered by", d.registeredBy ? <span className="mono">{str(d.registeredBy)}</span> : null],
        ]}
      />
      <div className="props-section">Containers</div>
      {arr(d.containerDefinitions).map((c) => (
        <ContainerDetails key={str(c.name)} c={c} />
      ))}
      <p className="mono selectable hint">{td.arn}</p>
    </div>
  );
}

function Compare({ td, revisions }: { td: TaskDefJson; revisions: string[] }) {
  const others = revisions.filter((r) => r !== td.name);
  const [other, setOther] = useState(others[0] ?? "");
  const [otherJson, setOtherJson] = useState<{ name: string; json: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!other) return;
    let stale = false;
    ecsApi
      .taskDefinition(other)
      .then((t) => !stale && setOtherJson({ name: other, json: t.registerJson }))
      .catch((e) => !stale && setError((e as AppError).message ?? String(e)));
    return () => {
      stale = true;
    };
  }, [other]);
  if (!others.length) return <p className="hint">There's no other revision to compare with.</p>;
  return (
    <div className="lambda-details">
      <div className="row">
        <span className="hint">Compare with</span>
        <select className="text-input" value={other} onChange={(e) => setOther(e.target.value)}>
          {others.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <span className="hint">(fields AWS sets itself, like the revision number, are left out)</span>
      </div>
      {error && <div className="field-error">{error}</div>}
      {otherJson?.name === other ? <DiffView before={otherJson.json} after={td.registerJson} beforeLabel={other} afterLabel={td.name} /> : <p className="hint">Loading…</p>}
    </div>
  );
}

function NewRevisionDialog({ td, onClose, onDone }: { td: TaskDefJson; onClose: () => void; onDone: (name: string) => void }) {
  const [json, setJson] = useState(td.registerJson);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  let problem: string | null = null;
  try {
    const v = JSON.parse(json) as Def;
    if (!v.family) problem = 'The JSON needs a "family"';
    else if (!arr(v.containerDefinitions).length) problem = 'The JSON needs at least one entry in "containerDefinitions"';
  } catch (e) {
    problem = `Not valid JSON: ${(e as Error).message}`;
  }
  const changed = json.trim() !== td.registerJson.trim();
  async function save() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await ecsApi.registerTaskDefinition(json));
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog dialog-wide" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">New revision of {td.name.slice(0, td.name.lastIndexOf(":"))}</div>
        <div className="dialog-body">
          <p className="hint">
            Starts from {td.name}. Edit the JSON (for example the image tag, CPU / memory, environment) and register it as a new revision. Services keep running their current
            revision until you deploy the new one (Change revision). Changing "family" registers into that family instead.
          </p>
          <ValueEditor value={json} onChange={setJson} rows={22} />
          {problem && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" disabled={!!problem || busy} onClick={() => void save()}>
            {busy ? "Registering…" : changed ? "Register new revision" : "Register (unchanged)"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function FamilyView({ shell, family, reloadToken, onChanged }: { shell: Shell; family: string; reloadToken: number; onChanged: () => void }) {
  const [revs, setRevs] = useState<{ active: string[]; inactive: string[] } | null>(null);
  const [rev, setRev] = useState<string | null>(null);
  const [td, setTd] = useState<{ name: string; data: TaskDefJson | null; error: AppError | null } | null>(null);
  const [tab, setTab] = useState<"details" | "json" | "compare">("details");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let stale = false;
    Promise.all([ecsApi.revisions(family, false), ecsApi.revisions(family, true)])
      .then(([active, inactive]) => {
        if (stale) return;
        setRevs({ active, inactive });
        setRev((r) => (r && [...active, ...inactive].includes(r) ? r : (active[0] ?? inactive[0] ?? null)));
      })
      .catch((e) => !stale && setError(e as AppError));
    return () => {
      stale = true;
    };
  }, [family, reloadToken, tick]);

  useEffect(() => {
    if (!rev) return;
    let stale = false;
    setTd((t) => (t?.name === rev ? t : { name: rev, data: null, error: null }));
    ecsApi
      .taskDefinition(rev)
      .then((data) => !stale && setTd({ name: rev, data, error: null }))
      .catch((e) => !stale && setTd({ name: rev, data: null, error: e as AppError }));
    return () => {
      stale = true;
    };
  }, [rev, reloadToken, tick]);

  async function deregister(name: string) {
    if (shell.readOnly) return shell.showFlash("Read-only mode: changes are disabled.");
    const ok = await shell.confirmTyped(
      "Deregister task definition",
      <>
        <p>
          <span className="mono">{name}</span> will be deregistered. Tasks and services already using it keep running, but no new tasks or deployments can use it. It can't be
          made active again.
        </p>
      </>,
      name,
      "Deregister",
    );
    if (!ok) return;
    try {
      await ecsApi.deregisterTaskDefinition(name);
      shell.showFlash(`Deregistered ${name}.`);
      setTick((t) => t + 1);
      onChanged();
    } catch (e) {
      shell.showError(e);
    }
  }

  if (error) return <ErrorPanel error={error} profile={shell.profile} onRetry={() => setTick((t) => t + 1)} />;
  if (!revs) return <div className="empty-note">Loading…</div>;
  const all = [...revs.active, ...revs.inactive];
  const current = td?.name === rev ? td : null;
  const data = current?.data ?? null;
  const active = data?.status === "ACTIVE";
  let body: ReactNode = <div className="empty-note">Loading…</div>;
  if (current?.error) body = <ErrorPanel error={current.error} profile={shell.profile} onRetry={() => setTick((t) => t + 1)} />;
  else if (data) body = tab === "json" ? <ValueView key={data.name} value={data.json} /> : tab === "compare" ? <Compare key={data.name} td={data} revisions={all} /> : <Details td={data} />;
  return (
    <div className="queue-view db-view">
      <div className="qv-head">
        <span className="qv-name">{family}</span>
        <select className="text-input" aria-label="Revision" value={rev ?? ""} onChange={(e) => setRev(e.target.value)}>
          {revs.active.map((r, i) => (
            <option key={r} value={r}>
              revision {r.slice(r.lastIndexOf(":") + 1)}
              {i === 0 ? " (latest)" : ""}
            </option>
          ))}
          {revs.inactive.map((r) => (
            <option key={r} value={r}>
              revision {r.slice(r.lastIndexOf(":") + 1)} (deregistered)
            </option>
          ))}
        </select>
        {data && <span className={`status-pill ${active ? "ok" : "off"}`}>{data.status.toLowerCase()}</span>}
        <div className="spacer" />
        {data && (
          <button className="link-btn" onClick={() => void shell.copyText(data.arn)}>
            Copy ARN
          </button>
        )}
      </div>
      <div className="row">
        <button className="btn" disabled={!data || shell.readOnly} onClick={() => setEditing(true)}>
          New revision…
        </button>
        <button className="btn" disabled={!data || !active || shell.readOnly} onClick={() => data && void deregister(data.name)}>
          Deregister…
        </button>
        <span className="hint">
          {revs.active.length} active, {revs.inactive.length} deregistered revision{revs.inactive.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="segmented small db-tabs">
        <button className={tab === "details" ? "active" : ""} onClick={() => setTab("details")}>
          Details
        </button>
        <button className={tab === "json" ? "active" : ""} onClick={() => setTab("json")}>
          JSON
        </button>
        <button className={tab === "compare" ? "active" : ""} onClick={() => setTab("compare")}>
          Compare
        </button>
      </div>
      {body}
      {editing && data && (
        <NewRevisionDialog
          td={data}
          onClose={() => setEditing(false)}
          onDone={(name) => {
            setEditing(false);
            shell.showFlash(`Registered ${name}. Deploy it to a service with Change revision.`);
            setRev(name);
            setTick((t) => t + 1);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
