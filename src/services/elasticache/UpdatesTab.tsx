// Updates tab: service updates (engine and security patches AWS schedules)
// for a replication group, most urgent first, with Apply now.
import { useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { ecApi, type ServiceUpdate } from "../../api/elasticache";
import { ErrorPanel } from "../../components/ErrorPanel";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";

/** Statuses an update can be applied from now. */
export const APPLICABLE = ["not-applied", "stopped", "scheduled", "waiting-to-start"];
const DONE = ["complete", "not-applicable"];

const label = (s: string | null) => (s ?? "").replace(/-/g, " ");
const tone = (sev: string | null) => (sev === "critical" ? "bad" : sev === "important" ? "busy" : "off");

export function UpdatesTab({ shell, group, replicas, reloadToken }: { shell: Shell; group: string; replicas: boolean; reloadToken: number }) {
  const [tick, setTick] = useState(0);
  const [showDone, setShowDone] = useState(false);
  const [data, setData] = useState<{ key: string; items: ServiceUpdate[] | null; unsupported: boolean; error: AppError | null } | null>(null);
  const key = `${group}|${reloadToken}|${tick}`;
  useEffect(() => {
    let stale = false;
    ecApi
      .updates(group)
      .then((r) => !stale && setData({ key, items: r.items, unsupported: r.unsupported, error: null }))
      .catch((e) => !stale && setData({ key, items: null, unsupported: false, error: e as AppError }));
    return () => {
      stale = true;
    };
  }, [group, key]);

  const current = data?.key === key ? data : null;
  const items = current?.items ?? null;
  const shown = useMemo(() => (items ?? []).filter((u) => showDone || !DONE.includes(u.status ?? "")), [items, showDone]);
  const hidden = (items?.length ?? 0) - shown.length;
  const inProgress = !!items?.some((u) => u.status === "in-progress" || u.status === "stopping" || u.status === "scheduling");
  useEffect(() => {
    if (!inProgress) return;
    const t = window.setTimeout(() => setTick((x) => x + 1), 30_000);
    return () => window.clearTimeout(t);
  }, [inProgress, items]);

  async function apply(u: ServiceUpdate) {
    const ok = await shell.ask(
      "Apply service update",
      <>
        <p>
          Apply <span className="mono">{u.name}</span> ({u.severity ?? "update"}) to <span className="mono">{group}</span> now, instead of waiting for the maintenance window?
        </p>
        <p className="hint">
          AWS updates the nodes one at a time{u.estimatedTime ? ` (estimated ${u.estimatedTime})` : ""}.{" "}
          {replicas ? "Replicas are updated first and the primary fails over, so the cache stays available with a brief interruption." : "With no replica, the node is unavailable while it's updated and its data may be lost."}
        </p>
      </>,
      [
        { label: "Apply now", value: "yes", danger: !replicas },
        { label: "Cancel", value: "no" },
      ],
      "no",
    );
    if (ok !== "yes") return;
    shell.setWorking("Starting the update…");
    try {
      const status = await ecApi.applyUpdate(group, u.name);
      shell.showFlash(`Applying ${u.name}${status ? ` (${label(status)})` : ""}; the list checks again while it runs.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
      setTick((x) => x + 1);
    }
  }

  if (current?.error) return <ErrorPanel error={current.error} profile={shell.profile} onRetry={() => setTick((x) => x + 1)} />;
  if (!current) return <p className="hint">Loading…</p>;
  if (current.unsupported) return <p className="hint">This endpoint doesn't support service updates (emulators usually leave them out); on AWS this tab lists the engine and security updates for this cache.</p>;
  const ro = shell.readOnly;
  return (
    <div className="lambda-details">
      <div className="row">
        <label className="check-row inline">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show completed and not applicable
        </label>
        <button className="btn small" onClick={() => setTick((x) => x + 1)}>
          Refresh
        </button>
        {inProgress && <span className="hint">An update is running; the list checks again every 30 seconds.</span>}
      </div>
      {shown.length === 0 ? (
        <p className="hint">{hidden ? `Nothing waiting (${hidden} completed or not applicable).` : "No service updates for this cache."}</p>
      ) : (
        <table className="sync-table">
          <thead>
            <tr>
              <th>Update</th>
              <th>Severity</th>
              <th>Status</th>
              <th>Apply by</th>
              <th>Released</th>
              <th>Nodes updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((u) => {
              const overdue = !!u.applyBy && Date.parse(u.applyBy) < Date.now() && !DONE.includes(u.status ?? "");
              return (
                <tr key={u.name}>
                  <td>
                    <div className="mono">{u.name}</div>
                    <div className="hint">{[label(u.kind), u.engine, u.estimatedTime ? `about ${u.estimatedTime}` : ""].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td>
                    <span className={`status-pill ${tone(u.severity)}`}>{u.severity ?? "?"}</span>
                  </td>
                  <td>{label(u.status)}</td>
                  <td className={overdue ? "danger-text" : ""}>
                    {formatDate(u.applyBy)}
                    {overdue ? " (overdue)" : ""}
                  </td>
                  <td>{formatDate(u.released)}</td>
                  <td>{u.nodesUpdated ?? ""}</td>
                  <td className="right">
                    {APPLICABLE.includes(u.status ?? "") && u.updateStatus !== "expired" && u.updateStatus !== "cancelled" && (
                      <button className="btn small" disabled={ro} onClick={() => void apply(u)}>
                        Apply now…
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="hint">Updates not applied by hand are applied by AWS in the maintenance window after their apply-by date (self-service updates), or automatically (auto-update).</p>
    </div>
  );
}
