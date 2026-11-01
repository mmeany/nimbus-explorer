// On-demand backups of a table: list, create, restore to a new table, delete.
import { useCallback, useEffect, useState } from "react";
import type { AppError } from "../../api/core";
import { ddbApi, ddbNameProblem, type BackupInfo, type TableInfo } from "../../api/dynamo";
import { formatDate, formatSize } from "../../format";
import type { Shell } from "../../shell/shell";

export function BackupsTab({ table, shell, onRestored }: { table: TableInfo; shell: Shell; onRestored: (name: string) => void }) {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBackups(await ddbApi.listBackups(table.name));
      setError(null);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    }
  }, [table.name]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const name = await shell.askName("Create backup", "Backup name", `${table.name}-${stamp}`, "Create", (v) => ddbNameProblem(v.trim(), "Backup"));
    if (!name) return;
    try {
      await ddbApi.createBackup(table.name, name.trim());
      shell.showFlash(`Backup ${name.trim()} started.`);
      await load();
    } catch (e) {
      shell.showError(e);
    }
  }

  async function restore(b: BackupInfo) {
    const target = await shell.askName("Restore backup to a new table", "New table name", `${table.name}-restored`, "Restore", (v) =>
      ddbNameProblem(v.trim()) ?? (v.trim() === table.name ? "Restore creates a new table; choose another name" : null),
    );
    if (!target) return;
    try {
      await ddbApi.restoreBackup(b.arn, target.trim());
      shell.showFlash(`Restoring ${b.name} into ${target.trim()}; it can take a while to become ACTIVE.`);
      onRestored(target.trim());
    } catch (e) {
      shell.showError(e);
    }
  }

  async function remove(b: BackupInfo) {
    const ok = await shell.ask(
      "Delete backup",
      <>
        Delete backup <span className="mono">{b.name}</span>? This can't be undone.
      </>,
      [
        { label: "Delete", value: "delete", danger: true },
        { label: "Cancel", value: "cancel" },
      ],
      "cancel",
    );
    if (ok !== "delete") return;
    try {
      await ddbApi.deleteBackup(b.arn);
      shell.showFlash(`Deleted backup ${b.name}.`);
      await load();
    } catch (e) {
      shell.showError(e);
    }
  }

  const ro = shell.readOnly;
  return (
    <div className="table-details">
      <div className="row">
        <button className="btn" disabled={ro} onClick={() => void create()}>
          Create backup…
        </button>
        <button className="btn" onClick={() => void load()}>
          Refresh
        </button>
        <span className="hint">
          On-demand backups. Point-in-time recovery is set in Details › Settings ({table.pitrStatus === "ENABLED" ? "on" : "off"}).
        </span>
      </div>
      {error ? (
        <div className="field-error">{error}</div>
      ) : !backups ? (
        <p className="hint">Loading…</p>
      ) : backups.length === 0 ? (
        <p className="hint">No backups.</p>
      ) : (
        <table className="sync-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Created</th>
              <th>Status</th>
              <th>Type</th>
              <th className="right">Size</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.arn}>
                <td className="mono">{b.name}</td>
                <td>{formatDate(b.created)}</td>
                <td>{b.status ?? ""}</td>
                <td>{b.kind ?? ""}</td>
                <td className="right">{b.sizeBytes !== null ? formatSize(b.sizeBytes) : ""}</td>
                <td>
                  <button className="link-btn" disabled={ro || b.status !== "AVAILABLE"} onClick={() => void restore(b)}>
                    Restore…
                  </button>{" "}
                  <button className="link-btn" disabled={ro || b.kind === "SYSTEM"} onClick={() => void remove(b)}>
                    Delete…
                  </button>{" "}
                  <button className="link-btn" onClick={() => void shell.copyText(b.arn)}>
                    Copy ARN
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
