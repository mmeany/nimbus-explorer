// Dialogs for changing a database: modify settings, delete (with a final
// snapshot), fail over an Aurora cluster.
import { useState } from "react";
import type { AppError } from "../../api/core";
import { identifierProblem, rdsApi, snapshotName } from "../../api/rds";
import type { Db } from "./DbView";

/** Common instance classes, offered as suggestions (any class can be typed). */
const CLASSES = [
  "db.t4g.micro", "db.t4g.small", "db.t4g.medium", "db.t4g.large",
  "db.t3.micro", "db.t3.small", "db.t3.medium", "db.t3.large",
  "db.m7g.large", "db.m7g.xlarge", "db.m7g.2xlarge", "db.m6i.large", "db.m6i.xlarge",
  "db.r7g.large", "db.r7g.xlarge", "db.r7g.2xlarge", "db.r6g.large", "db.r6g.xlarge", "db.r6i.large",
];

function Frame({ title, children, buttons, onClose }: { title: string; children: React.ReactNode; buttons: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
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

export function ModifyDbDialog({ db, onClose, onDone }: { db: Db; onClose: () => void; onDone: (msg: string) => void }) {
  const d = db.db;
  const isInstance = db.kind === "instance";
  const member = isInstance && !!db.db.clusterId;
  const [cls, setCls] = useState(isInstance ? (db.db.class ?? "") : "");
  const [retention, setRetention] = useState(String(d.backupRetentionDays ?? ""));
  const [protect, setProtect] = useState(d.deletionProtection);
  const [now, setNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changes: { class?: string; backupRetentionDays?: number; deletionProtection?: boolean } = {};
  if (isInstance && cls.trim() && cls.trim() !== (db.db.class ?? "")) changes.class = cls.trim();
  if (!member && retention.trim() !== String(d.backupRetentionDays ?? "")) changes.backupRetentionDays = Number(retention);
  if (!member && protect !== d.deletionProtection) changes.deletionProtection = protect;
  const minDays = isInstance ? 0 : 1;
  const problem =
    changes.class !== undefined && !/^db\.[a-z0-9]+\.[a-z0-9]+$/.test(changes.class)
      ? "Instance classes look like db.t3.medium"
      : changes.backupRetentionDays !== undefined && (!/^\d+$/.test(retention.trim()) || changes.backupRetentionDays < minDays || changes.backupRetentionDays > 35)
        ? `Backup retention is ${minDays} to 35 days`
        : Object.keys(changes).length === 0
          ? "Nothing changed yet"
          : null;

  async function save() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rdsApi.modify(db.kind, d.id, { ...changes, applyImmediately: now });
      onDone(now ? `Changing ${d.id} now.` : `${d.id} will change in its next maintenance window.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <Frame
      title={`Modify ${d.id}`}
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary" disabled={!!problem || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Modify"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className="pe-grid">
        {isInstance && (
          <>
            <label className="form-label" htmlFor="md-class">
              Instance class
            </label>
            <div className="row">
              <input id="md-class" className="text-input mono" list="md-classes" value={cls} spellCheck={false} onChange={(e) => setCls(e.target.value)} />
              <datalist id="md-classes">
                {CLASSES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <span className="hint">changing it restarts the database</span>
            </div>
          </>
        )}
        {!member && (
          <>
            <label className="form-label" htmlFor="md-ret">
              Backup retention
            </label>
            <div className="row">
              <input id="md-ret" className="text-input num-input" value={retention} onChange={(e) => setRetention(e.target.value)} />
              <span className="hint">days ({minDays} to 35{isInstance ? "; 0 turns automated backups off" : ""})</span>
            </div>
          </>
        )}
      </div>
      {!member && (
        <label className="check-row">
          <input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} /> Deletion protection (the database can't be deleted
          while this is on)
        </label>
      )}
      {member && <p className="hint">Backups and deletion protection are set on the cluster.</p>}
      <fieldset className="radio-group">
        <legend>Apply</legend>
        <label>
          <input type="radio" checked={!now} onChange={() => setNow(false)} /> In the next maintenance window
          {d.maintenanceWindow ? ` (${d.maintenanceWindow} UTC)` : ""}
        </label>
        <label>
          <input type="radio" checked={now} onChange={() => setNow(true)} /> Now{changes.class ? " (the database restarts; expect a few minutes of downtime)" : ""}
        </label>
      </fieldset>
      {problem && Object.keys(changes).length > 0 && <div className="field-error">{problem}</div>}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}

export function DeleteDbDialog({ db, onClose, onDone }: { db: Db; onClose: () => void; onDone: (msg: string) => void }) {
  const d = db.db;
  const member = db.kind === "instance" && !!db.db.clusterId;
  const clusterWithMembers = db.kind === "cluster" && db.db.members.length > 0;
  const [snapshot, setSnapshot] = useState(!member);
  const [snapName, setSnapName] = useState(snapshotName(d.id, "final"));
  const [deleteBackups, setDeleteBackups] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = clusterWithMembers
    ? "Delete the cluster's instances first"
    : d.deletionProtection
      ? "Turn off deletion protection first (Modify)"
      : snapshot && !member
        ? identifierProblem(snapName.trim(), "Snapshot", 255)
        : null;
  const ok = !problem && typed === d.id;

  async function remove() {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rdsApi.delete(db.kind, d.id, { finalSnapshotId: snapshot && !member ? snapName.trim() : null, deleteAutomatedBackups: deleteBackups });
      onDone(`Deleting ${d.id}${snapshot && !member ? ` (final snapshot ${snapName.trim()})` : ""}. It can take several minutes.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <Frame
      title={`Delete ${db.kind === "cluster" ? "cluster" : "database"}`}
      onClose={onClose}
      buttons={
        <>
          <button className="btn danger" disabled={!ok || busy} onClick={() => void remove()}>
            {busy ? "Deleting…" : "Delete"}
          </button>
          <button className="btn primary" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p>
        <span className="mono">{d.id}</span> will be deleted, with all its data
        {member ? " (the cluster keeps running on its other instances; if this is the writer, a reader takes over)" : ""}.
      </p>
      {clusterWithMembers && (
        <div className="warn-note">
          This cluster still has {db.db.members.length} instance{db.db.members.length === 1 ? "" : "s"}. Delete them first; the cluster can only be deleted
          once it's empty.
        </div>
      )}
      {d.deletionProtection && <div className="warn-note">Deletion protection is on. Turn it off with Modify first.</div>}
      {!member && !clusterWithMembers && (
        <>
          <label className="check-row">
            <input type="checkbox" checked={snapshot} onChange={(e) => setSnapshot(e.target.checked)} /> Take a final snapshot (recommended: it's the only way
            to get the data back)
          </label>
          {snapshot && (
            <input className="text-input mono" value={snapName} spellCheck={false} aria-label="Final snapshot name" onChange={(e) => setSnapName(e.target.value)} />
          )}
          {db.kind === "instance" && (
            <label className="check-row">
              <input type="checkbox" checked={deleteBackups} onChange={(e) => setDeleteBackups(e.target.checked)} /> Also delete automated backups (otherwise
              they're kept for their retention period)
            </label>
          )}
          {!snapshot && <p className="danger-text">Without a final snapshot the data can't be recovered{deleteBackups ? "" : " except from automated backups"}.</p>}
        </>
      )}
      <label className="form-label" htmlFor="dd-confirm">
        Type <span className="mono">{d.id}</span> to confirm
      </label>
      <input id="dd-confirm" className="text-input mono" autoFocus value={typed} spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
      {problem && <div className="field-error">{problem}</div>}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}

export function FailoverDialog({ db, onClose, onDone }: { db: Db & { kind: "cluster" }; onClose: () => void; onDone: (msg: string) => void }) {
  const readers = db.db.members.filter((m) => !m.writer);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await rdsApi.failover(db.db.id, target || null);
      onDone(`Failing over ${db.db.id}${target ? ` to ${target}` : ""}. Connections drop for up to a minute.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <Frame
      title={`Fail over ${db.db.id}`}
      onClose={onClose}
      buttons={
        <>
          <button className="btn danger" disabled={busy} onClick={() => void run()}>
            {busy ? "Failing over…" : "Fail over"}
          </button>
          <button className="btn primary" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p>A reader becomes the writer; the current writer restarts as a reader. Applications reconnect through the cluster endpoint.</p>
      <div className="pe-grid">
        <label className="form-label" htmlFor="fo-target">
          New writer
        </label>
        <select id="fo-target" className="text-input" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Any reader (Aurora chooses)</option>
          {readers.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id}
            </option>
          ))}
        </select>
      </div>
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}
