// ElastiCache snapshots: one list for the whole region (Snapshots node) or
// for one cache (its Snapshots tab), with create, copy, delete (manual only,
// typed) and restore to a new cache.
import { useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { ecApi, engineLabel, type EcSnapshot, type SnapshotKind } from "../../api/elasticache";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { DialogHelp } from "../../components/HelpDialog";
import { CacheGroupIcon, ServerlessCacheIcon } from "../../components/Icons";
import { PageBar } from "../../components/PageBar";
import { formatDate } from "../../format";
import { EC_ROOT } from "../../shell/places";
import type { Shell } from "../../shell/shell";
import { usePaging } from "../../state/paged";

const COLUMNS: Column[] = [
  { id: "name", label: "Snapshot", width: 240 },
  { id: "cache", label: "Of", width: 200 },
  { id: "kind", label: "Cache type", width: 100 },
  { id: "source", label: "Taken", width: 90 },
  { id: "status", label: "Status", width: 90 },
  { id: "created", label: "Created", width: 165 },
  { id: "size", label: "Size", width: 110 },
  { id: "engine", label: "Engine", width: 110 },
  { id: "node", label: "Node type", width: 130 },
];

/** Why AWS would refuse a snapshot name (the backend checks too). */
export function snapshotNameProblem(n: string): string | null {
  if (!n || n.length > 255) return "1 to 255 characters";
  if (!/^[A-Za-z]/.test(n)) return "Starts with a letter";
  if (!/^[A-Za-z0-9-]+$/.test(n)) return "Letters, digits and hyphens";
  if (n.includes("--") || n.endsWith("-")) return "No two hyphens in a row, and not ending with one";
  return null;
}

/** Replication group ids and serverless names: 1–40 letters, digits and single hyphens, starting with a letter. */
export function cacheNameProblem(n: string): string | null {
  if (!n || n.length > 40) return "1 to 40 characters";
  if (!/^[A-Za-z]/.test(n)) return "Starts with a letter";
  if (!/^[A-Za-z0-9-]+$/.test(n) || n.includes("--") || n.endsWith("-")) return "Letters, digits and single hyphens, not ending with one";
  return null;
}

const today = () => new Date().toISOString().slice(0, 10);

interface Props {
  shell: Shell;
  /** One cache's snapshots, or null for the whole region. */
  cache: { kind: SnapshotKind; id: string } | null;
  reloadToken: number;
}

export function SnapshotList({ shell, cache, reloadToken }: Props) {
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<{ key: string; items: EcSnapshot[] | null; serverlessUnsupported: boolean; error: AppError | null } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [restoring, setRestoring] = useState<EcSnapshot | null>(null);
  const key = `${cache?.kind ?? ""}|${cache?.id ?? ""}|${reloadToken}|${tick}`;
  useEffect(() => {
    let stale = false;
    ecApi
      .snapshots(cache?.kind ?? null, cache?.id ?? null)
      .then((r) => !stale && setData({ key, items: r.items, serverlessUnsupported: r.serverlessUnsupported, error: null }))
      .catch((e) => !stale && setData({ key, items: null, serverlessUnsupported: false, error: e as AppError }));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const reload = () => setTick((x) => x + 1);
  const items = data?.items ?? null;
  const pending = !!items?.some((s) => s.status === "creating" || s.status === "copying" || s.status === "restoring" || s.status === "deleting");
  useEffect(() => {
    if (!pending) return;
    const t = window.setTimeout(reload, 15_000);
    return () => window.clearTimeout(t);
  }, [pending, items]);

  const keyOf = (s: EcSnapshot) => `${s.kind}:${s.name}`;
  const byKey = useMemo(() => new Map((items ?? []).map((s) => [keyOf(s), s])), [items]);
  const paging = usePaging(`${cache?.id ?? "region"}`, items?.length ?? 0, "elasticache.snapshots.pageSize", true);
  const page = useMemo(() => paging.slice(items ?? []), [paging, items]);
  const rows: Row[] = useMemo(
    () =>
      page.map((s) => ({
        key: keyOf(s),
        icon: s.kind === "serverless" ? <ServerlessCacheIcon /> : <CacheGroupIcon />,
        isContainer: false,
        dimmed: s.status === "deleting",
        cells: {
          name: { text: s.name, sort: s.name },
          cache: { text: s.cache ?? "", sort: s.cache ?? "" },
          kind: { text: s.kind === "serverless" ? "Serverless" : "Replication group", sort: s.kind },
          source: { text: s.source, sort: s.source },
          status: { text: s.status ?? "", sort: s.status ?? "" },
          created: { text: formatDate(s.created), sort: s.created ?? "" },
          size: { text: s.size ?? "", sort: s.size ?? "" },
          engine: { text: `${engineLabel(s.engine)}${s.engineVersion ? ` ${s.engineVersion}` : ""}`, sort: s.engine ?? "" },
          node: { text: s.nodeType ?? (s.kind === "serverless" ? "" : ""), sort: s.nodeType ?? "" },
        },
      })),
    [page],
  );
  const target = selected.size === 1 ? (byKey.get([...selected][0]) ?? null) : null;
  const ro = shell.readOnly;

  async function create() {
    if (!cache) return;
    const name = await shell.askName("Create snapshot", "Name", `${cache.id}-${today()}`, "Create", (v) => snapshotNameProblem(v.trim()));
    if (!name) return;
    shell.setWorking("Creating the snapshot…");
    try {
      await ecApi.createSnapshot(cache.kind, cache.id, name.trim());
      shell.showFlash(`Creating snapshot ${name.trim()}; it shows as available when done.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
      reload();
    }
  }

  async function copy(s: EcSnapshot) {
    const name = await shell.askName("Copy snapshot", "Name of the copy", `${s.name}-copy`, "Copy", (v) => snapshotNameProblem(v.trim()) ?? (byKey.has(`${s.kind}:${v.trim()}`) ? "There's already a snapshot with this name" : null));
    if (!name) return;
    shell.setWorking("Copying…");
    try {
      await ecApi.copySnapshot(s.kind, s.name, name.trim());
      shell.showFlash(`Copying ${s.name} to ${name.trim()}${s.source === "automated" ? "; the copy is manual, so it doesn't expire" : ""}.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
      reload();
    }
  }

  async function remove(s: EcSnapshot) {
    if (s.source !== "manual") return shell.showFlash("Automated snapshots can't be deleted; they expire on their own. Copy one to keep it.");
    const ok = await shell.confirmTyped("Delete snapshot", <p>Snapshot <span className="mono">{s.name}</span>{s.cache ? <> of <span className="mono">{s.cache}</span></> : null} will be deleted. This can't be undone.</p>, s.name, "Delete snapshot");
    if (!ok) return;
    shell.setWorking("Deleting…");
    try {
      await ecApi.deleteSnapshot(s.kind, s.name);
      shell.showFlash(`Deleted ${s.name}.`);
      setSelected(new Set());
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
      reload();
    }
  }

  function menu(k: string | null, x: number, y: number) {
    const s = k ? byKey.get(k) : undefined;
    if (!s) return;
    shell.openMenu(x, y, [
      { label: "Restore to a new cache…", bold: true, disabled: ro || s.status !== "available", onClick: () => setRestoring(s) },
      { label: "Copy…", disabled: ro || s.status !== "available", onClick: () => void copy(s) },
      { label: "Delete…", disabled: ro || s.source !== "manual", onClick: () => void remove(s) },
      "separator",
      ...(s.cache ? [{ label: `Open ${s.cache}`, onClick: () => shell.navigate({ ...EC_ROOT, kind: s.kind, id: s.cache }) }, "separator" as const] : []),
      { label: "Copy name", onClick: () => void shell.copyText(s.name) },
      { label: "Copy ARN", disabled: !s.arn, onClick: () => s.arn && void shell.copyText(s.arn) },
      { label: "Add bookmark…", onClick: () => shell.addBookmark(cache ? { ...EC_ROOT, kind: cache.kind, id: cache.id } : { ...EC_ROOT, kind: "snapshots" }, keyOf(s), null) },
    ]);
  }

  return (
    <div className={cache ? "lambda-details" : "service-pane"}>
      <div className="row ec-snap-bar">
        {cache && (
          <button className="btn" disabled={ro} onClick={() => void create()}>
            Create snapshot…
          </button>
        )}
        <button className="btn" disabled={ro || !target || target.status !== "available"} onClick={() => target && setRestoring(target)}>
          Restore…
        </button>
        <button className="btn" disabled={ro || !target || target.status !== "available"} onClick={() => target && void copy(target)}>
          Copy…
        </button>
        <button className="btn" disabled={ro || !target || target.source !== "manual"} title={target && target.source !== "manual" ? "Automated snapshots expire on their own" : ""} onClick={() => target && void remove(target)}>
          Delete…
        </button>
        {pending && <span className="hint">Some snapshots are changing; the list checks again every 15 seconds.</span>}
      </div>
      {data?.serverlessUnsupported && <p className="hint">This endpoint doesn't support serverless snapshots, so only replication group snapshots are listed.</p>}
      {data?.error ? (
        <ErrorPanel error={data.error} profile={shell.profile} onRetry={reload} />
      ) : (
        <div className={cache ? "ec-snap-list" : "ec-snap-list region"}>
          <FileList storageKey="elasticache.snapshots" columns={COLUMNS} rows={rows} selected={selected} onSelectionChange={setSelected} onOpen={(k) => byKey.get(k) && !ro && setRestoring(byKey.get(k)!)} onContextMenu={menu} initialSort={{ col: "created", dir: -1 }} emptyText={!items ? "Loading…" : cache ? "No snapshots of this cache." : "No snapshots in this region."} />
          {items && items.length > paging.pageSize && <PageBar {...paging.bar} loading={false} />}
        </div>
      )}
      {restoring && (
        <RestoreDialog
          s={restoring}
          onClose={() => setRestoring(null)}
          onDone={(name, copied) => {
            setRestoring(null);
            shell.showFlash(`Restoring into ${name}${copied ? " (network and encryption settings copied from the original)" : ""}; it shows as creating until ready.`);
            shell.navigate({ ...EC_ROOT, kind: restoring.kind, id: name });
          }}
        />
      )}
    </div>
  );
}

function RestoreDialog({ s, onClose, onDone }: { s: EcSnapshot; onClose: () => void; onDone: (name: string, copied: boolean) => void }) {
  const [name, setName] = useState(`${(s.cache ?? s.name).slice(0, 30)}-restored`);
  const [description, setDescription] = useState("");
  const [nodeType, setNodeType] = useState(s.nodeType ?? "");
  const [replicas, setReplicas] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const group = s.kind === "group";
  const r = Number(replicas);
  const problem = cacheNameProblem(name.trim()) ?? (group && (!Number.isInteger(r) || r < 0 || r > 5) ? "Replicas per shard are 0 to 5" : null);

  async function restore() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await ecApi.restoreSnapshot({ kind: s.kind, snapshot: s.name, name: name.trim(), description: description.trim() || null, nodeType: group ? nodeType.trim() || null : null, replicas: group ? r : 0 });
      onDone(out.name, out.copiedFromSource);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">
          <DialogHelp topic="elasticache.restore" />
          Restore {s.name}
        </div>
        <div className="dialog-body">
          <p className="hint">
            Creates a new {group ? "replication group" : "serverless cache"} with the snapshot's data. {s.cache ? `Network settings${group ? " and encryption in transit" : ""} are copied from ${s.cache} if it still exists; otherwise AWS's defaults apply (the default VPC).` : "AWS's default network settings apply."}
          </p>
          <div className="pe-grid">
            <label className="form-label" htmlFor="er-name">
              New cache name
            </label>
            <input id="er-name" className="text-input mono" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
            {group && (
              <>
                <label className="form-label" htmlFor="er-type">
                  Node type
                </label>
                <input id="er-type" className="text-input mono" value={nodeType} onChange={(e) => setNodeType(e.target.value)} placeholder="cache.r7g.large" />
                <label className="form-label" htmlFor="er-rep">
                  Replicas per shard
                </label>
                <div className="row">
                  <input id="er-rep" className="text-input num-input" inputMode="numeric" value={replicas} onChange={(e) => setReplicas(e.target.value)} />
                  <span className="hint">{s.shards && s.shards > 1 ? `${s.shards} shards (from the snapshot)` : "One shard"}; with replicas, automatic failover is turned on.</span>
                </div>
              </>
            )}
            <label className="form-label" htmlFor="er-desc">
              Description
            </label>
            <input id="er-desc" className="text-input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={`Restored from ${s.name}`} />
          </div>
          <p className="hint">The new cache is billed from when it's created. Its endpoint is new: point clients at it once it's available.</p>
          {problem && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" disabled={!!problem || busy} onClick={() => void restore()}>
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
