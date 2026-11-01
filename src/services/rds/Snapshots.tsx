// Snapshots of one database (a tab in the database view) or of the whole
// region (the RDS root's Snapshots view), with create / copy / delete /
// restore, and the restore dialog (from a snapshot or to a point in time).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { engineLabel, identifierProblem, rdsApi, snapshotName, type DbKind, type SnapshotInfo } from "../../api/rds";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import type { MenuItem } from "../../components/ContextMenu";
import { PageBar } from "../../components/PageBar";
import { usePaging } from "../../state/paged";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";
import type { Db } from "./DbView";

const COLUMNS: Column[] = [
  { id: "name", label: "Snapshot", width: 300 },
  { id: "db", label: "Database", width: 170 },
  { id: "type", label: "Type", width: 90 },
  { id: "created", label: "Created", width: 165 },
  { id: "status", label: "Status", width: 120 },
  { id: "size", label: "Size", width: 70, align: "right" },
  { id: "engine", label: "Engine", width: 170 },
];

export type RestoreTarget = { mode: "snapshot"; snapshot: SnapshotInfo } | { mode: "pitr"; db: Db };

interface Props {
  shell: Shell;
  /** null = every snapshot in the region. */
  db: Db | null;
  reloadToken: number;
  onRestore: (t: RestoreTarget) => void;
  onOpenDb?: (kind: DbKind, id: string) => void;
}

export function SnapshotList({ shell, db, reloadToken, onRestore, onOpenDb }: Props) {
  const [list, setList] = useState<SnapshotInfo[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [type, setType] = useState<"all" | "manual" | "automated">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  const ro = shell.readOnly;
  const member = db?.kind === "instance" && !!db.db.clusterId;

  const load = useCallback(async () => {
    try {
      setList(await rdsApi.listSnapshots(db ? db.kind : null, db ? db.db.id : null));
      setError(null);
    } catch (e) {
      setError(e as AppError);
    }
  }, [db]);

  useEffect(() => {
    if (member) return;
    void load();
  }, [load, reloadToken, tick, member]);

  // Snapshots being created / copied: check again every 15 s.
  const busy = list?.some((s) => s.status !== "available" && s.status !== "failed");
  useEffect(() => {
    if (!busy) return;
    const t = window.setTimeout(() => setTick((n) => n + 1), 15000);
    return () => window.clearTimeout(t);
  }, [busy, list]);

  const shown = useMemo(() => (list ?? []).filter((s) => type === "all" || s.snapshotType === type), [list, type]);
  const byKey = useMemo(() => new Map(shown.map((s) => [`${s.kind}:${s.id}`, s])), [shown]);
  // Newest first, paged on screen (the region view can hold thousands).
  const paging = usePaging(`${db?.kind ?? ""}|${db?.db.id ?? "region"}|${type}`, shown.length, "rds.snapshots.pageSize", true);
  const pageShown = useMemo(() => paging.slice(shown), [paging, shown]);
  const rows: Row[] = useMemo(
    () =>
      pageShown.map((s) => ({
        key: `${s.kind}:${s.id}`,
        icon: <span className="snap-icon" aria-hidden>{s.kind === "cluster" ? "⧉" : "▣"}</span>,
        isContainer: false,
        cells: {
          name: { text: s.id, sort: s.id },
          db: { text: s.dbId, sort: s.dbId },
          type: { text: s.snapshotType ?? "", sort: s.snapshotType ?? "" },
          created: { text: formatDate(s.created), sort: s.created ?? "" },
          status: { text: s.status === "creating" && s.percentProgress !== null ? `creating ${s.percentProgress}%` : (s.status ?? ""), sort: s.status ?? "" },
          size: { text: s.sizeGb !== null ? `${s.sizeGb} GB` : "", sort: s.sizeGb ?? -1 },
          engine: { text: `${engineLabel(s.engine)} ${s.engineVersion ?? ""}`, sort: s.engine },
        },
      })),
    [pageShown],
  );

  const sel = selected.size === 1 ? byKey.get([...selected][0]) : undefined;
  const denied = () => shell.showFlash("Read-only mode: changes are disabled.");

  async function create() {
    if (!db) return;
    if (ro) return denied();
    const name = await shell.askName("Create snapshot", `Snapshot of ${db.db.id}`, snapshotName(db.db.id, "manual"), "Create", (v) =>
      identifierProblem(v.trim(), "Snapshot", 255),
    );
    if (!name) return;
    try {
      await rdsApi.createSnapshot(db.kind, db.db.id, name.trim());
      shell.showFlash(`Creating snapshot ${name.trim()}; it takes a few minutes.`);
      void load();
    } catch (e) {
      shell.showError(e);
    }
  }

  async function copy(s: SnapshotInfo) {
    if (ro) return denied();
    const base = s.id.replace(/^rds:/, "");
    const name = await shell.askName(
      "Copy snapshot",
      s.snapshotType === "automated" ? "Name for the copy (a manual snapshot you keep until you delete it)" : "Name for the copy",
      `${base}-copy`.slice(0, 255),
      "Copy",
      (v) => identifierProblem(v.trim(), "Snapshot", 255),
    );
    if (!name) return;
    try {
      await rdsApi.copySnapshot(s.kind, s.arn || s.id, name.trim());
      shell.showFlash(`Copying to ${name.trim()}.`);
      void load();
    } catch (e) {
      shell.showError(e);
    }
  }

  async function remove(s: SnapshotInfo) {
    if (ro) return denied();
    const ok = await shell.confirmTyped(
      "Delete snapshot",
      <p>
        <span className="mono">{s.id}</span> ({formatDate(s.created)}) will be deleted. This can't be undone.
      </p>,
      s.id,
      "Delete snapshot",
    );
    if (!ok) return;
    try {
      await rdsApi.deleteSnapshot(s.kind, s.id);
      shell.showFlash(`Deleting ${s.id}.`);
      setSelected(new Set());
      void load();
    } catch (e) {
      shell.showError(e);
    }
  }

  function menu(key: string | null, x: number, y: number) {
    const s = key ? byKey.get(key) : undefined;
    const items: MenuItem[] = [];
    if (s) {
      items.push(
        { label: "Restore to a new database…", bold: true, disabled: ro || s.status !== "available", onClick: () => (ro ? denied() : onRestore({ mode: "snapshot", snapshot: s })) },
        { label: "Copy…", disabled: ro || s.status !== "available", onClick: () => void copy(s) },
        { label: "Delete…", disabled: ro || s.snapshotType !== "manual", onClick: () => void remove(s) },
        "separator",
        { label: "Copy name", onClick: () => void shell.copyText(s.id) },
        { label: "Copy ARN", onClick: () => void shell.copyText(s.arn) },
        ...(onOpenDb ? [{ label: `Open ${s.dbId}`, onClick: () => onOpenDb(s.kind, s.dbId) } as MenuItem] : []),
        "separator",
      );
    }
    items.push({ label: "Refresh", onClick: () => void load() });
    shell.openMenu(x, y, items);
  }

  if (member)
    return (
      <p className="hint">
        Snapshots of Aurora instances are taken of their cluster: open{" "}
        <button className="link-btn" onClick={() => onOpenDb?.("cluster", (db as Db & { kind: "instance" }).db.clusterId!)}>
          {(db as Db & { kind: "instance" }).db.clusterId}
        </button>{" "}
        for its snapshots.
      </p>
    );

  const backupsOn = db && (db.db.backupRetentionDays ?? 0) > 0;
  return (
    <div className={db ? "snapshots-tab" : "service-pane"}>
      <div className={`row ${db ? "" : "filter-bar"} snap-bar`}>
        {db && (
          <>
            <button className="btn" disabled={ro} onClick={() => void create()}>
              Create snapshot…
            </button>
            <button
              className="btn"
              disabled={ro || !backupsOn}
              title={backupsOn ? "" : "Automated backups are off, so there's nothing to restore from"}
              onClick={() => (ro ? denied() : onRestore({ mode: "pitr", db }))}
            >
              Restore to point in time…
            </button>
          </>
        )}
        <button className="btn" disabled={ro || !sel || sel.status !== "available"} onClick={() => sel && onRestore({ mode: "snapshot", snapshot: sel })}>
          Restore…
        </button>
        <button className="btn" disabled={ro || !sel || sel.status !== "available"} onClick={() => sel && void copy(sel)}>
          Copy…
        </button>
        <button className="btn" disabled={ro || !sel || sel.snapshotType !== "manual"} title="Only manual snapshots can be deleted" onClick={() => sel && void remove(sel)}>
          Delete…
        </button>
        <div className="segmented small">
          {(["all", "manual", "automated"] as const).map((t) => (
            <button key={t} className={type === t ? "active" : ""} onClick={() => setType(t)}>
              {t === "all" ? "All" : t === "manual" ? "Manual" : "Automated"}
            </button>
          ))}
        </div>
        <div className="spacer" />
        {db?.db.latestRestorableTime && <span className="hint">Restorable to {formatDate(db.db.latestRestorableTime)}</span>}
      </div>
      {error ? (
        <ErrorPanel error={error} profile={shell.profile} onRetry={() => void load()} />
      ) : (
        <div className={db ? "snap-list" : "snap-list grow-list"}>
          <FileList
            columns={db ? COLUMNS.filter((c) => c.id !== "db" && c.id !== "engine") : COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={(k) => {
              const s = byKey.get(k);
              if (s && !ro && s.status === "available") onRestore({ mode: "snapshot", snapshot: s });
            }}
            onContextMenu={menu}
            emptyText={!list ? "Loading…" : type !== "all" ? `No ${type} snapshots.` : "No snapshots."}
            initialSort={{ col: "created", dir: -1 }}
          />
          {shown.length > paging.pageSize && <PageBar {...paging.bar} loading={false} />}
        </div>
      )}
    </div>
  );
}

const CLUSTER_CLASSES = ["db.serverless", "db.t4g.medium", "db.r7g.large", "db.r7g.xlarge", "db.r6g.large", "db.r6g.xlarge", "db.r6i.large"];

/** Local "YYYY-MM-DDTHH:MM" for <input type="datetime-local">. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function RestoreDialog({ target, onClose, onDone }: { target: RestoreTarget; onClose: () => void; onDone: (kind: DbKind, newId: string) => void }) {
  const kind: DbKind = target.mode === "snapshot" ? target.snapshot.kind : target.db.kind;
  const sourceName = target.mode === "snapshot" ? target.snapshot.dbId : target.db.db.id;
  const latest = target.mode === "pitr" ? target.db.db.latestRestorableTime : null;
  const [newId, setNewId] = useState(`${sourceName}-restored`.slice(0, 63));
  const [cls, setCls] = useState(kind === "cluster" ? "db.r6g.large" : target.mode === "pitr" && target.db.kind === "instance" ? (target.db.db.class ?? "") : "");
  const [minAcu, setMinAcu] = useState("0.5");
  const [maxAcu, setMaxAcu] = useState("8");
  const [useLatest, setUseLatest] = useState(true);
  const [when, setWhen] = useState(toLocalInput(latest));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serverless = kind === "cluster" && cls === "db.serverless";

  const problem =
    identifierProblem(newId.trim(), kind === "cluster" ? "Cluster" : "Instance") ??
    (newId.trim() === sourceName ? "Choose a name that isn't in use" : null) ??
    (cls.trim() && !/^db\.[a-z0-9]+(\.[a-z0-9]+)?$/.test(cls.trim()) ? "Instance classes look like db.t3.medium" : null) ??
    (kind === "cluster" && !cls.trim() ? "Choose a class for the cluster's instance" : null) ??
    (serverless && !(Number(minAcu) >= 0 && Number(maxAcu) >= 1 && Number(minAcu) <= Number(maxAcu) && Number(maxAcu) <= 256)
      ? "Serverless capacity: minimum 0 to 256 ACU, maximum 1 to 256 and not below the minimum"
      : null) ??
    (target.mode === "pitr" && !useLatest && !when ? "Choose a time" : null);

  async function run() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const id = await rdsApi.restore(kind, {
        snapshotId: target.mode === "snapshot" ? target.snapshot.arn || target.snapshot.id : null,
        sourceDbId: target.mode === "pitr" ? target.db.db.id : null,
        restoreTime: target.mode === "pitr" && !useLatest ? new Date(when).toISOString().replace(/\.\d+Z$/, "Z") : null,
        newId: newId.trim(),
        class: cls.trim() || null,
        serverlessMinAcu: serverless ? Number(minAcu) : null,
        serverlessMaxAcu: serverless ? Number(maxAcu) : null,
      });
      onDone(kind, id);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">{target.mode === "snapshot" ? `Restore ${target.snapshot.id}` : `Restore ${sourceName} to a point in time`}</div>
        <div className="dialog-body">
          <p className="hint">
            This creates a new {kind === "cluster" ? "cluster" : "database"}; {sourceName} isn't changed. Network settings (subnet group, security groups) are
            copied from {sourceName} if it still exists, otherwise the account's defaults are used. Check them, and the parameter group, once it's available.
          </p>
          <div className="pe-grid">
            <label className="form-label" htmlFor="rs-id">
              New {kind === "cluster" ? "cluster" : "instance"} name
            </label>
            <input id="rs-id" className="text-input mono" autoFocus value={newId} spellCheck={false} onChange={(e) => setNewId(e.target.value)} />
            <label className="form-label" htmlFor="rs-class">
              {kind === "cluster" ? "Instance class" : "Instance class"}
            </label>
            <div className="row">
              <input
                id="rs-class"
                className="text-input mono"
                list="rs-classes"
                value={cls}
                placeholder={kind === "cluster" ? "" : "Same as the source"}
                spellCheck={false}
                onChange={(e) => setCls(e.target.value)}
              />
              <datalist id="rs-classes">
                {(kind === "cluster" ? CLUSTER_CLASSES : ["db.t4g.micro", "db.t4g.small", "db.t3.micro", "db.t3.small", "db.t3.medium", "db.m7g.large", "db.r7g.large"]).map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              {kind === "cluster" && <span className="hint">one writer instance, {newId.trim() || "name"}-1</span>}
            </div>
            {serverless && (
              <>
                <label className="form-label">Capacity</label>
                <div className="row">
                  <input className="text-input num-input" value={minAcu} onChange={(e) => setMinAcu(e.target.value)} aria-label="Minimum ACU" />
                  <span className="hint">to</span>
                  <input className="text-input num-input" value={maxAcu} onChange={(e) => setMaxAcu(e.target.value)} aria-label="Maximum ACU" />
                  <span className="hint">ACU</span>
                </div>
              </>
            )}
          </div>
          {target.mode === "pitr" && (
            <fieldset className="radio-group">
              <legend>Restore to</legend>
              <label>
                <input type="radio" checked={useLatest} onChange={() => setUseLatest(true)} /> Latest restorable time{latest ? ` (${formatDate(latest)})` : ""}
              </label>
              <label>
                <input type="radio" checked={!useLatest} onChange={() => setUseLatest(false)} /> A specific time (your local time):
                <input type="datetime-local" className="text-input" value={when} max={toLocalInput(latest)} disabled={useLatest} onChange={(e) => setWhen(e.target.value)} />
              </label>
            </fieldset>
          )}
          {problem && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" disabled={!!problem || busy} onClick={() => void run()}>
            {busy ? "Restoring…" : "Restore"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
