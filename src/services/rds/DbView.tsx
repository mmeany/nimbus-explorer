// One DB cluster or instance: status, connectivity, configuration, backups and
// maintenance, members, tags. Tabs for snapshots, events / logs and connecting
// are passed in by the controller.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AppError } from "../../api/core";
import { engineLabel, rdsApi, statusTone, type DbCluster, type DbInstance, type DbKind, type NameStatus, type PendingAction } from "../../api/rds";
import { ErrorPanel } from "../../components/ErrorPanel";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";

export type Db = { kind: "cluster"; db: DbCluster } | { kind: "instance"; db: DbInstance };

export interface ExtraTab {
  id: string;
  label: string;
  render: (d: Db) => ReactNode;
  /** Hidden when false (e.g. the SQL tab for clusters without Data API). */
  available?: (d: Db) => boolean;
}

interface Props {
  kind: DbKind;
  id: string;
  shell: Shell;
  reloadToken: number;
  onLoaded?: (d: Db) => void;
  onOpenInstance: (id: string) => void;
  onOpenCluster: (id: string) => void;
  /** Buttons under the header (start / stop / …). */
  actions?: (d: Db) => ReactNode;
  tabs?: ExtraTab[];
}

export function StatusPill({ status }: { status: string | null }) {
  return <span className={`status-pill ${statusTone(status)}`}>{status ?? "unknown"}</span>;
}

const yes = (b: boolean) => (b ? "Yes" : "No");
const groups = (g: NameStatus[]) => g.map((x) => (x.status && x.status !== "active" && x.status !== "in-sync" ? `${x.name} (${x.status})` : x.name)).join(", ");

export function DbView({ kind, id, shell, reloadToken, onLoaded, onOpenInstance, onOpenCluster, actions, tabs = [] }: Props) {
  const [data, setData] = useState<Db | null>(null);
  const [members, setMembers] = useState<DbInstance[] | null>(null);
  const [pending, setPending] = useState<PendingAction[] | null>(null);
  const [tags, setTags] = useState<[string, string][] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [tab, setTab] = useState("details");

  const load = useCallback(async () => {
    try {
      const d: Db = kind === "cluster" ? { kind, db: await rdsApi.describeCluster(id) } : { kind, db: await rdsApi.describeInstance(id) };
      setData(d);
      setError(null);
      onLoaded?.(d);
      rdsApi.pendingMaintenance(d.db.arn).then(setPending).catch(() => setPending([]));
      rdsApi.listTags(d.db.arn).then(setTags).catch(() => setTags([]));
      if (d.kind === "cluster") {
        Promise.all(d.db.members.map((m) => rdsApi.describeInstance(m.id).catch(() => null)))
          .then((list) => setMembers(list.filter((x): x is DbInstance => !!x)))
          .catch(() => setMembers([]));
      }
    } catch (e) {
      setError(e as AppError);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  // While the database is changing (starting, modifying, …), check again every 15 s.
  const busyStatus = data && statusTone(data.db.status) === "busy";
  useEffect(() => {
    if (!busyStatus) return;
    const t = window.setTimeout(() => void load(), 15000);
    return () => window.clearTimeout(t);
  }, [busyStatus, data, load]);

  if (error && !data) return <ErrorPanel error={error} profile={shell.profile} onRetry={() => void load()} />;
  if (!data) return <div className="empty-note">Loading…</div>;

  const d = data.db;
  const visibleTabs = tabs.filter((t) => t.available?.(data) ?? true);
  const current = visibleTabs.find((t) => t.id === tab);

  return (
    <div className="queue-view db-view">
      <div className="qv-head">
        <span className="qv-name">{d.id}</span>
        <StatusPill status={d.status} />
        <span className="qbadge">{data.kind === "cluster" ? (d.engine.startsWith("aurora") ? "Aurora cluster" : "Multi-AZ DB cluster") : "DB instance"}</span>
        {data.kind === "instance" && data.db.clusterId && (
          <span className="hint">
            member of{" "}
            <button className="link-btn" onClick={() => onOpenCluster(data.db.clusterId!)}>
              {data.db.clusterId}
            </button>
          </span>
        )}
        <div className="spacer" />
        <button className="link-btn" onClick={() => void shell.copyText(d.arn)}>
          Copy ARN
        </button>
      </div>
      {actions && <div className="row db-actions">{actions(data)}</div>}

      {visibleTabs.length > 0 && (
        <div className="segmented small db-tabs">
          <button className={tab === "details" ? "active" : ""} onClick={() => setTab("details")}>
            Details
          </button>
          {visibleTabs.map((t) => (
            <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {current ? (
        current.render(data)
      ) : data.kind === "cluster" ? (
        <ClusterDetails c={data.db} members={members} pending={pending} tags={tags} onOpenInstance={onOpenInstance} />
      ) : (
        <InstanceDetails i={data.db} pending={pending} tags={tags} onOpenInstance={onOpenInstance} />
      )}
    </div>
  );
}

function PropRows({ rows }: { rows: [string, ReactNode][] }) {
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

function Maintenance({ pending, changes, window }: { pending: PendingAction[] | null; changes: string[]; window: string | null }) {
  return (
    <>
      <div className="props-section">Maintenance</div>
      <PropRows rows={[["Maintenance window", window ? `${window} (UTC)` : ""]]} />
      {changes.length > 0 && (
        <div className="warn-note">
          Changes waiting for the next maintenance window: {changes.join("; ")}
        </div>
      )}
      {pending === null ? (
        <p className="hint">Checking for pending maintenance…</p>
      ) : pending.length === 0 ? (
        <p className="hint">No pending maintenance.</p>
      ) : (
        <table className="sync-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Description</th>
              <th>Applies</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((p, i) => (
              <tr key={i}>
                <td>{p.action}</td>
                <td className="mono">{p.description ?? ""}</td>
                <td>
                  {p.currentApplyDate
                    ? formatDate(p.currentApplyDate)
                    : p.autoAppliedAfter
                      ? `After ${formatDate(p.autoAppliedAfter)}`
                      : p.forcedApply
                        ? `By ${formatDate(p.forcedApply)}`
                        : "Next window"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Tags({ tags }: { tags: [string, string][] | null }) {
  return (
    <>
      <div className="props-section">Tags</div>
      {tags === null ? (
        <p className="hint">Loading…</p>
      ) : tags.length === 0 ? (
        <p className="hint">No tags.</p>
      ) : (
        <PropRows rows={tags.map(([k, v]) => [k, v])} />
      )}
    </>
  );
}

function InstanceDetails({
  i,
  pending,
  tags,
  onOpenInstance,
}: {
  i: DbInstance;
  pending: PendingAction[] | null;
  tags: [string, string][] | null;
  onOpenInstance: (id: string) => void;
}) {
  const standalone = !i.clusterId;
  return (
    <>
      <div className="sync-totals qv-counts">
        <div className="sync-total">
          <div className="st-num">{engineLabel(i.engine)}</div>
          <div className="st-label">Engine {i.engineVersion ?? ""}</div>
        </div>
        <div className="sync-total">
          <div className="st-num">{i.class ?? "—"}</div>
          <div className="st-label">Instance class</div>
        </div>
        {standalone && (
          <div className="sync-total">
            <div className="st-num">{i.allocatedStorageGb !== null ? `${i.allocatedStorageGb} GB` : "—"}</div>
            <div className="st-label">
              {i.storageType ?? "Storage"}
              {i.maxAllocatedStorageGb ? ` · autoscaling to ${i.maxAllocatedStorageGb} GB` : ""}
            </div>
          </div>
        )}
        <div className="sync-total">
          <div className="st-num">{i.multiAz ? "Multi-AZ" : "Single-AZ"}</div>
          <div className="st-label">{[i.availabilityZone, i.secondaryAz].filter(Boolean).join(" / ")}</div>
        </div>
      </div>

      <div className="props-section">Connectivity</div>
      <PropRows
        rows={[
          ["Endpoint", i.endpoint ? <span className="mono">{i.endpoint}</span> : "Not available yet"],
          ["Port", i.port ?? ""],
          ["Publicly accessible", yes(i.publiclyAccessible)],
          ["VPC", i.vpcId ?? ""],
          ["Subnet group", i.subnetGroup ?? ""],
          ["Security groups", groups(i.securityGroups)],
          ["CA certificate", i.caCertificate ?? ""],
          ["IAM database authentication", yes(i.iamAuth)],
        ]}
      />

      <div className="props-section">Configuration</div>
      <PropRows
        rows={[
          ["Database name", i.dbName ?? ""],
          ["Master username", i.masterUsername ?? ""],
          ["Master password", i.masterSecretArn ? "Managed in Secrets Manager" : ""],
          ["Parameter groups", groups(i.parameterGroups)],
          ["Option groups", groups(i.optionGroups)],
          ["IOPS", i.iops ?? ""],
          ["Performance Insights", yes(i.performanceInsights)],
          [
            "Read replica of",
            i.readReplicaOf ? (
              <button className="link-btn" onClick={() => onOpenInstance(i.readReplicaOf!.split(":").pop()!)}>
                {i.readReplicaOf.split(":").pop()}
              </button>
            ) : (
              ""
            ),
          ],
          [
            "Read replicas",
            i.readReplicas.length
              ? i.readReplicas.map((r) => (
                  <button key={r} className="link-btn" onClick={() => onOpenInstance(r.split(":").pop()!)}>
                    {r.split(":").pop()}
                  </button>
                ))
              : "",
          ],
          ["Created", formatDate(i.created)],
        ]}
      />

      {standalone && (
        <>
          <div className="props-section">Backups and encryption</div>
          <PropRows
            rows={[
              ["Backup retention", i.backupRetentionDays ? `${i.backupRetentionDays} days` : "Automated backups off"],
              ["Backup window", i.backupWindow ? `${i.backupWindow} (UTC)` : ""],
              ["Restorable to", formatDate(i.latestRestorableTime)],
              ["Deletion protection", yes(i.deletionProtection)],
              ["Encryption", i.encrypted ? `On${i.kmsKey ? ` (${i.kmsKey})` : ""}` : "Off"],
            ]}
          />
        </>
      )}
      <Maintenance pending={pending} changes={i.pendingChanges} window={i.maintenanceWindow} />
      <Tags tags={tags} />
      <div className="props-section">ARN</div>
      <p className="mono selectable">{i.arn}</p>
    </>
  );
}

function ClusterDetails({
  c,
  members,
  pending,
  tags,
  onOpenInstance,
}: {
  c: DbCluster;
  members: DbInstance[] | null;
  pending: PendingAction[] | null;
  tags: [string, string][] | null;
  onOpenInstance: (id: string) => void;
}) {
  const serverless = c.serverlessMinAcu !== null;
  return (
    <>
      <div className="sync-totals qv-counts">
        <div className="sync-total">
          <div className="st-num">{engineLabel(c.engine)}</div>
          <div className="st-label">Engine {c.engineVersion ?? ""}</div>
        </div>
        <div className="sync-total">
          <div className="st-num">{c.members.length}</div>
          <div className="st-label">Instance{c.members.length === 1 ? "" : "s"}</div>
        </div>
        <div className="sync-total">
          <div className="st-num">{serverless ? `${c.serverlessMinAcu}–${c.serverlessMaxAcu} ACU` : (c.class ?? c.engineMode ?? "—")}</div>
          <div className="st-label">{serverless ? "Serverless v2 capacity" : c.class ? "Instance class" : "Engine mode"}</div>
        </div>
        <div className="sync-total">
          <div className="st-num">{c.dataApi ? "On" : "Off"}</div>
          <div className="st-label">Data API (SQL from this app)</div>
        </div>
      </div>

      <div className="props-section">Instances</div>
      {c.members.length === 0 ? (
        <p className="hint">This cluster has no instances.</p>
      ) : (
        <table className="sync-table">
          <thead>
            <tr>
              <th>Instance</th>
              <th>Role</th>
              <th>Class</th>
              <th>Status</th>
              <th>Zone</th>
            </tr>
          </thead>
          <tbody>
            {c.members.map((m) => {
              const i = members?.find((x) => x.id === m.id);
              return (
                <tr key={m.id}>
                  <td>
                    <button className="link-btn" onClick={() => onOpenInstance(m.id)}>
                      {m.id}
                    </button>
                  </td>
                  <td>{m.writer ? "Writer" : "Reader"}</td>
                  <td>{i?.class ?? ""}</td>
                  <td>{i ? <StatusPill status={i.status} /> : ""}</td>
                  <td>{i?.availabilityZone ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="props-section">Connectivity</div>
      <PropRows
        rows={[
          ["Writer endpoint", c.endpoint ? <span className="mono">{c.endpoint}</span> : ""],
          ["Reader endpoint", c.readerEndpoint ? <span className="mono">{c.readerEndpoint}</span> : ""],
          ["Port", c.port ?? ""],
          ["Subnet group", c.subnetGroup ?? ""],
          ["Security groups", groups(c.securityGroups)],
          ["IAM database authentication", yes(c.iamAuth)],
          ["Data API", c.dataApi ? "On" : "Off (turn it on in the AWS console to run SQL here)"],
        ]}
      />

      <div className="props-section">Configuration</div>
      <PropRows
        rows={[
          ["Database name", c.databaseName ?? ""],
          ["Master username", c.masterUsername ?? ""],
          ["Master password", c.masterSecretArn ? "Managed in Secrets Manager" : ""],
          ["Cluster parameter group", c.parameterGroup ?? ""],
          ["Engine mode", c.engineMode ?? ""],
          ["Storage", c.allocatedStorageGb ? `${c.allocatedStorageGb} GB${c.storageType ? ` (${c.storageType})` : ""}` : (c.storageType ?? "")],
          ["Multi-AZ", yes(c.multiAz)],
          ["Created", formatDate(c.created)],
        ]}
      />

      <div className="props-section">Backups and encryption</div>
      <PropRows
        rows={[
          ["Backup retention", c.backupRetentionDays ? `${c.backupRetentionDays} days` : ""],
          ["Backup window", c.backupWindow ? `${c.backupWindow} (UTC)` : ""],
          ["Restorable to", formatDate(c.latestRestorableTime)],
          ["Deletion protection", yes(c.deletionProtection)],
          ["Encryption", c.encrypted ? `On${c.kmsKey ? ` (${c.kmsKey})` : ""}` : "Off"],
        ]}
      />
      <Maintenance pending={pending} changes={c.pendingChanges} window={c.maintenanceWindow} />
      <Tags tags={tags} />
      <div className="props-section">ARN</div>
      <p className="mono selectable">{c.arn}</p>
    </>
  );
}
