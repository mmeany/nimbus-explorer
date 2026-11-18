// One replication group or serverless cache: header and tabs. The group view
// re-checks every 15 s while its status is changing.
import { useEffect, useState, type ReactNode } from "react";
import type { AppError } from "../../api/core";
import { cacheTone, ecApi, endpointText, engineLabel, limitsText, type GroupDetails, type Serverless } from "../../api/elasticache";
import { ErrorPanel } from "../../components/ErrorPanel";
import { HelpTopic } from "../../components/HelpDialog";
import { formatDate } from "../../format";
import type { HelpTopicId } from "../../help";
import type { Shell } from "../../shell/shell";

export function Pill({ status }: { status: string | null | undefined }) {
  return <span className={`status-pill ${cacheTone(status)}`}>{status ?? "unknown"}</span>;
}

export function PropsTable({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <table className="props-table">
      <tbody>
        {rows
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td className="selectable">{v}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

const yesNo = (b: boolean | null | undefined) => (b ? "Yes" : "No");

/** Loads `load()` for `key`, re-running every `pollMs(data)` ms when that's not null. */
function useLoad<T>(key: string, load: () => Promise<T>, pollMs: (d: T | null) => number | null) {
  const [state, setState] = useState<{ key: string; data: T | null; error: AppError | null }>({ key: "", data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stale = false;
    setState((s) => (s.key === key ? s : { key, data: null, error: null }));
    load()
      .then((data) => !stale && setState({ key, data, error: null }))
      .catch((e) => !stale && setState((s) => ({ key, data: s.key === key ? s.data : null, error: e as AppError })));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  const current = state.key === key ? state : { data: null, error: null };
  const every = pollMs(current.data);
  useEffect(() => {
    if (!every) return;
    const t = window.setTimeout(() => setTick((x) => x + 1), every);
    return () => window.clearTimeout(t);
  }, [every, current.data]);
  return { data: current.data, error: current.error, retry: () => setTick((x) => x + 1) };
}

export interface GroupTab {
  id: string;
  label: string;
  help: HelpTopicId;
  render: (g: GroupDetails) => ReactNode;
}

export function GroupView({ shell, id, reloadToken, onLoaded, tabs = [] }: { shell: Shell; id: string; reloadToken: number; onLoaded: (g: GroupDetails | null) => void; tabs?: GroupTab[] }) {
  const [tab, setTab] = useState("details");
  const { data: g, error, retry } = useLoad(`${id}|${reloadToken}`, () => ecApi.group(id), (d) => (d && d.status !== "available" ? 15_000 : null));
  useEffect(() => onLoaded(g), [g, onLoaded]);
  if (error && !g) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!g) return <div className="empty-note">Loading…</div>;
  const current = tabs.find((t) => t.id === tab);
  return (
    <div className="queue-view db-view">
      <div className="qv-head">
        <span className="qv-name">{g.id}</span>
        <Pill status={g.status} />
        <span className="qbadge">{engineLabel(g.engine)}</span>
        <span className="qbadge">{g.clusterMode ? "Cluster mode on" : "Cluster mode off"}</span>
        <div className="spacer" />
        {g.arn && (
          <button className="link-btn" onClick={() => void shell.copyText(g.arn!)}>
            Copy ARN
          </button>
        )}
      </div>
      {g.description && <div className="hint">{g.description}</div>}
      {g.pending.length > 0 && <div className="warn-note">Changes waiting to apply: {g.pending.join("; ")}.</div>}
      <HelpTopic id={current?.help ?? "elasticache.group"} />
      <div className="segmented small db-tabs">
        {[{ id: "details", label: "Details" }, { id: "nodes", label: `Shards and nodes (${g.memberCount})` }, ...tabs].map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {current ? current.render(g) : tab === "nodes" ? <Nodes g={g} /> : <GroupDetailsTab g={g} />}
    </div>
  );
}

function GroupDetailsTab({ g }: { g: GroupDetails }) {
  const s = g.settings;
  const primary = g.clusterMode ? g.configurationEndpoint : g.shards[0]?.primaryEndpoint;
  return (
    <div className="lambda-details">
      <div className="props-section">Cache</div>
      <PropsTable
        rows={[
          ["Engine", `${engineLabel(g.engine)}${s?.engineVersion ? ` ${s.engineVersion}` : ""}`],
          ["Node type", g.nodeType],
          ["Shards", g.clusterMode ? String(g.shards.length) : "1 (cluster mode off)"],
          ["Nodes", String(g.memberCount)],
          [g.clusterMode ? "Configuration endpoint" : "Primary endpoint", endpointText(primary)],
          ["Reader endpoint", g.clusterMode ? null : endpointText(g.shards[0]?.readerEndpoint)],
          ["Automatic failover", g.automaticFailover],
          ["Multi-AZ", g.multiAz],
          ["Data tiering", g.dataTiering],
          ["Created", formatDate(g.created)],
          ["Global datastore", g.globalDatastore ? `${g.globalDatastore}${g.globalDatastoreRole ? ` (${g.globalDatastoreRole})` : ""}` : null],
        ]}
      />
      <div className="props-section">Security</div>
      <PropsTable
        rows={[
          ["Encryption in transit", g.transitEncryption ? `Yes${g.transitEncryptionMode ? ` (${g.transitEncryptionMode})` : ""}` : "No"],
          ["Encryption at rest", g.atRestEncryption ? `Yes${g.kmsKeyId ? `, KMS key ${g.kmsKeyId}` : ", AWS owned key"}` : "No"],
          ["AUTH token", g.authToken ? `Yes${g.authTokenLastModified ? ` (changed ${formatDate(g.authTokenLastModified)})` : ""}` : "No"],
          ["User groups (RBAC)", g.userGroupIds.length ? g.userGroupIds.join(", ") : "None"],
        ]}
      />
      <div className="props-section">Network and maintenance</div>
      <PropsTable
        rows={[
          ["Subnet group", s?.subnetGroup],
          ["Security groups", s?.securityGroups.length ? s.securityGroups.join(", ") : null],
          ["Network type", g.networkType],
          ["IP discovery", g.ipDiscovery],
          ["Parameter group", s?.parameterGroup ? `${s.parameterGroup}${s.parameterStatus ? ` (${s.parameterStatus})` : ""}` : null],
          ["Maintenance window", s?.maintenanceWindow],
          ["Auto minor version upgrade", g.autoMinorVersionUpgrade === null ? null : yesNo(g.autoMinorVersionUpgrade)],
          ["Notifications", s?.notificationTopic],
          ["Backups", g.snapshotRetention ? `Kept ${g.snapshotRetention} day${g.snapshotRetention === 1 ? "" : "s"}, window ${g.snapshotWindow ?? "?"} (UTC)${g.snapshottingCluster ? `, from ${g.snapshottingCluster}` : ""}` : "Off"],
          ["Log delivery", g.logDelivery.length ? g.logDelivery.join("; ") : "None"],
        ]}
      />
      <div className="props-section">Tags</div>
      {g.tags.length === 0 ? <p className="hint">No tags.</p> : <PropsTable rows={g.tags.map(([k, v]) => [k, v] as [string, ReactNode])} />}
    </div>
  );
}

function Nodes({ g }: { g: GroupDetails }) {
  return (
    <div className="lambda-details">
      {g.shards.map((s) => (
        <div key={s.id}>
          {g.clusterMode && (
            <div className="props-section">
              Shard {s.id}
              {s.slots ? <span className="hint"> · slots {s.slots}</span> : null}
              {s.status && s.status !== "available" ? <span className="hint"> · {s.status}</span> : null}
            </div>
          )}
          <table className="sync-table">
            <thead>
              <tr>
                <th>Node</th>
                <th>Role</th>
                <th>Availability zone</th>
                <th>Endpoint</th>
              </tr>
            </thead>
            <tbody>
              {s.members.map((m) => (
                <tr key={m.clusterId}>
                  <td className="mono">{m.clusterId}</td>
                  <td>{m.role ?? (g.clusterMode ? "" : "replica")}</td>
                  <td>{m.az ?? ""}</td>
                  <td className="mono">{endpointText(m.endpoint)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!g.clusterMode && (
            <p className="hint">
              Write to the primary endpoint <span className="mono">{endpointText(s.primaryEndpoint)}</span>; read from the reader endpoint <span className="mono">{endpointText(s.readerEndpoint)}</span>, which spreads reads over the replicas.
            </p>
          )}
        </div>
      ))}
      {g.clusterMode && <p className="hint">Clients connect to the configuration endpoint in cluster mode and are sent to the right shard for each key.</p>}
    </div>
  );
}

export function ServerlessView({ shell, name, reloadToken, onLoaded }: { shell: Shell; name: string; reloadToken: number; onLoaded: (s: Serverless | null) => void }) {
  const { data: s, error, retry } = useLoad(`${name}|${reloadToken}`, () => ecApi.serverless(name), (d) => (d && d.status !== "available" ? 15_000 : null));
  useEffect(() => onLoaded(s), [s, onLoaded]);
  if (error && !s) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!s) return <div className="empty-note">Loading…</div>;
  return (
    <div className="queue-view db-view">
      <div className="qv-head">
        <span className="qv-name">{s.name}</span>
        <Pill status={s.status} />
        <span className="qbadge">{engineLabel(s.engine)}</span>
        <span className="qbadge">Serverless</span>
        <div className="spacer" />
        {s.arn && (
          <button className="link-btn" onClick={() => void shell.copyText(s.arn!)}>
            Copy ARN
          </button>
        )}
      </div>
      {s.description && <div className="hint">{s.description}</div>}
      <HelpTopic id="elasticache.serverless" />
      <div className="lambda-details">
        <PropsTable
          rows={[
            ["Engine", `${engineLabel(s.engine)}${s.engineVersion ? ` ${s.engineVersion}` : ""}`],
            ["Endpoint", endpointText(s.endpoint)],
            ["Reader endpoint", endpointText(s.readerEndpoint)],
            ["Usage limits", limitsText(s.limits) || "None (scales as needed)"],
            ["Created", formatDate(s.created)],
            ["Encryption at rest", s.kmsKeyId ? `KMS key ${s.kmsKeyId}` : "AWS owned key"],
            ["Encryption in transit", "Always (TLS only)"],
            ["User group (RBAC)", s.userGroupId ?? "None"],
            ["Security groups", s.securityGroups.join(", ")],
            ["Subnets", s.subnets.join(", ")],
            ["Network type", s.networkType],
            ["Backups", s.snapshotRetention ? `Kept ${s.snapshotRetention} day${s.snapshotRetention === 1 ? "" : "s"}, daily at ${s.dailySnapshotTime ?? "?"} (UTC)` : "Off"],
          ]}
        />
        <div className="props-section">Tags</div>
        {s.tags.length === 0 ? <p className="hint">No tags.</p> : <PropsTable rows={s.tags.map(([k, v]) => [k, v] as [string, ReactNode])} />}
      </div>
    </div>
  );
}
