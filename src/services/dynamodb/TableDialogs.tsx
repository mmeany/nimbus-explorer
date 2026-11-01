// Create table, add a global secondary index, and table settings.
import { useEffect, useState } from "react";
import type { AppError } from "../../api/core";
import { ddbApi, ddbNameProblem, type IndexSpec, type KeySpec, type SettingsPatch, type TableInfo } from "../../api/dynamo";
import type { Shell } from "../../shell/shell";
import { TagRows } from "../sqs/QueueSettingsDialog";

const STREAM_VIEWS = [
  ["NEW_IMAGE", "New image"],
  ["OLD_IMAGE", "Old image"],
  ["NEW_AND_OLD_IMAGES", "New and old images"],
  ["KEYS_ONLY", "Keys only"],
];

function KeyInput({ label, value, onChange, optional }: { label: string; value: KeySpec | null; onChange: (k: KeySpec | null) => void; optional?: boolean }) {
  return (
    <>
      <span className="form-label">{label}</span>
      <div className="row">
        {optional && (
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? { name: "", attrType: "S" } : null)} title={`Use a ${label.toLowerCase()}`} />
        )}
        <input
          className="text-input mono"
          value={value?.name ?? ""}
          disabled={!value}
          placeholder={optional ? "none" : "attribute name"}
          onChange={(e) => onChange({ name: e.target.value, attrType: value?.attrType ?? "S" })}
        />
        <select className="text-input" value={value?.attrType ?? "S"} disabled={!value} onChange={(e) => onChange({ name: value?.name ?? "", attrType: e.target.value })}>
          <option value="S">String</option>
          <option value="N">Number</option>
          <option value="B">Binary</option>
        </select>
      </div>
    </>
  );
}

function capacityProblem(r: string, w: string): string | null {
  for (const v of [r, w]) if (!/^\d+$/.test(v) || Number(v) < 1) return "Capacity units must be whole numbers of at least 1";
  return null;
}

const emptyIndex = (): IndexSpec => ({ name: "", partitionKey: { name: "", attrType: "S" }, sortKey: null, projection: "ALL", nonKeyAttributes: [], readCapacity: null, writeCapacity: null });

function IndexEditor({ index, onChange, local, provisioned }: { index: IndexSpec; onChange: (i: IndexSpec) => void; local?: boolean; provisioned: boolean }) {
  return (
    <div className="pe-grid ix-grid">
      <span className="form-label">Index name</span>
      <input className="text-input mono" value={index.name} onChange={(e) => onChange({ ...index, name: e.target.value })} />
      {!local && <KeyInput label="Partition key" value={index.partitionKey} onChange={(k) => onChange({ ...index, partitionKey: k })} />}
      <KeyInput label="Sort key" value={index.sortKey} optional={!local} onChange={(k) => onChange({ ...index, sortKey: k })} />
      <span className="form-label">Projection</span>
      <div className="row">
        <select className="text-input" value={index.projection} onChange={(e) => onChange({ ...index, projection: e.target.value as IndexSpec["projection"] })}>
          <option value="ALL">All attributes</option>
          <option value="KEYS_ONLY">Keys only</option>
          <option value="INCLUDE">Keys and…</option>
        </select>
        {index.projection === "INCLUDE" && (
          <input
            className="text-input mono"
            placeholder="attr1, attr2"
            value={index.nonKeyAttributes.join(", ")}
            onChange={(e) => onChange({ ...index, nonKeyAttributes: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
          />
        )}
      </div>
      {!local && provisioned && (
        <>
          <span className="form-label">Capacity</span>
          <div className="row">
            <input className="text-input num-input" value={index.readCapacity ?? 5} onChange={(e) => onChange({ ...index, readCapacity: Number(e.target.value) || 0 })} />
            <span className="hint">read</span>
            <input className="text-input num-input" value={index.writeCapacity ?? 5} onChange={(e) => onChange({ ...index, writeCapacity: Number(e.target.value) || 0 })} />
            <span className="hint">write units</span>
          </div>
        </>
      )}
    </div>
  );
}

function indexProblem(i: IndexSpec, local: boolean): string | null {
  const n = ddbNameProblem(i.name, "Index");
  if (n) return n;
  if (!local && !i.partitionKey?.name.trim()) return `Index ${i.name}: enter a partition key`;
  if (local && !i.sortKey?.name.trim()) return `Index ${i.name}: enter a sort key`;
  if (i.sortKey && !i.sortKey.name.trim()) return `Index ${i.name}: enter the sort key's name or untick it`;
  if (i.projection === "INCLUDE" && !i.nonKeyAttributes.length) return `Index ${i.name}: list the attributes to include`;
  return null;
}

export function CreateTableDialog({ shell, onClose, onCreated }: { shell: Shell; onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState("");
  const [pk, setPk] = useState<KeySpec | null>({ name: "", attrType: "S" });
  const [sk, setSk] = useState<KeySpec | null>(null);
  const [billing, setBilling] = useState<"PAY_PER_REQUEST" | "PROVISIONED">("PAY_PER_REQUEST");
  const [rcu, setRcu] = useState("5");
  const [wcu, setWcu] = useState("5");
  const [gsis, setGsis] = useState<IndexSpec[]>([]);
  const [lsis, setLsis] = useState<IndexSpec[]>([]);
  const [tableClass, setTableClass] = useState("STANDARD");
  const [protect, setProtect] = useState(false);
  const [stream, setStream] = useState("");
  const [tags, setTags] = useState<{ key: string; value: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provisioned = billing === "PROVISIONED";

  const problem =
    ddbNameProblem(name.trim()) ??
    (!pk?.name.trim() ? "Enter a partition key" : null) ??
    (sk && !sk.name.trim() ? "Enter the sort key's name or untick it" : null) ??
    (provisioned ? capacityProblem(rcu, wcu) : null) ??
    gsis.map((g) => indexProblem(g, false)).find(Boolean) ??
    (lsis.length && !sk ? "Local indexes need a table sort key" : null) ??
    lsis.map((l) => indexProblem(l, true)).find(Boolean) ??
    (tags.some((t) => !t.key.trim()) ? "Every tag needs a key" : null);

  async function create() {
    if (problem || !pk) return;
    setBusy(true);
    setError(null);
    try {
      await ddbApi.createTable({
        name: name.trim(),
        partitionKey: { ...pk, name: pk.name.trim() },
        sortKey: sk ? { ...sk, name: sk.name.trim() } : null,
        billingMode: billing,
        readCapacity: provisioned ? Number(rcu) : null,
        writeCapacity: provisioned ? Number(wcu) : null,
        gsis: gsis.map((g) => (provisioned ? { ...g, readCapacity: g.readCapacity ?? 5, writeCapacity: g.writeCapacity ?? 5 } : g)),
        lsis,
        tableClass,
        deletionProtection: protect,
        streamViewType: stream || null,
        tags: Object.fromEntries(tags.map((t) => [t.key.trim(), t.value])),
      });
      onCreated(name.trim());
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog table-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">New table</div>
        <div className="dialog-body">
          <div className="pe-grid">
            <span className="form-label">Name</span>
            <input className="text-input mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            <KeyInput label="Partition key" value={pk} onChange={setPk} />
            <KeyInput label="Sort key" value={sk} optional onChange={setSk} />
            <span className="form-label">Capacity</span>
            <div className="row">
              <select className="text-input" value={billing} onChange={(e) => setBilling(e.target.value as typeof billing)}>
                <option value="PAY_PER_REQUEST">On-demand</option>
                <option value="PROVISIONED">Provisioned</option>
              </select>
              {provisioned && (
                <>
                  <input className="text-input num-input" value={rcu} onChange={(e) => setRcu(e.target.value.trim())} />
                  <span className="hint">read</span>
                  <input className="text-input num-input" value={wcu} onChange={(e) => setWcu(e.target.value.trim())} />
                  <span className="hint">write units</span>
                </>
              )}
            </div>
            <span className="form-label">Table class</span>
            <select className="text-input" value={tableClass} onChange={(e) => setTableClass(e.target.value)}>
              <option value="STANDARD">Standard</option>
              <option value="STANDARD_INFREQUENT_ACCESS">Standard-Infrequent Access</option>
            </select>
            <span className="form-label">Stream</span>
            <select className="text-input" value={stream} onChange={(e) => setStream(e.target.value)}>
              <option value="">Off</option>
              {STREAM_VIEWS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} /> Deletion protection
          </label>

          <div className="props-section">Global secondary indexes</div>
          {gsis.map((g, i) => (
            <div key={i} className="ix-box">
              <IndexEditor index={g} provisioned={provisioned} onChange={(x) => setGsis(gsis.map((y, j) => (j === i ? x : y)))} />
              <button className="link-btn" onClick={() => setGsis(gsis.filter((_, j) => j !== i))}>
                Remove index
              </button>
            </div>
          ))}
          <div className="row">
            <button className="link-btn" disabled={gsis.length >= 20} onClick={() => setGsis([...gsis, emptyIndex()])}>
              + Add global index
            </button>
          </div>

          <div className="props-section">Local secondary indexes (only when creating; share the partition key)</div>
          {lsis.map((l, i) => (
            <div key={i} className="ix-box">
              <IndexEditor index={l} local provisioned={provisioned} onChange={(x) => setLsis(lsis.map((y, j) => (j === i ? x : y)))} />
              <button className="link-btn" onClick={() => setLsis(lsis.filter((_, j) => j !== i))}>
                Remove index
              </button>
            </div>
          ))}
          <div className="row">
            <button className="link-btn" disabled={!sk || lsis.length >= 5} onClick={() => setLsis([...lsis, { ...emptyIndex(), partitionKey: null, sortKey: { name: "", attrType: "S" } }])}>
              + Add local index
            </button>
            {!sk && <span className="hint">Needs a table sort key</span>}
          </div>

          <div className="props-section">Tags</div>
          <TagRows tags={tags} onChange={setTags} />
          {problem && name && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" disabled={!!problem || busy || shell.readOnly} onClick={() => void create()}>
            {busy ? "Creating…" : "Create table"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function AddIndexDialog({ table, shell, onClose, onAdded }: { table: TableInfo; shell: Shell; onClose: () => void; onAdded: () => void }) {
  const [index, setIndex] = useState<IndexSpec>(emptyIndex);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provisioned = table.billingMode === "PROVISIONED";
  const problem = indexProblem(index, false) ?? (table.indexes.some((i) => i.name === index.name) ? "An index with this name exists" : null);

  async function add() {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      await ddbApi.addGsi(table.name, {
        ...index,
        name: index.name.trim(),
        readCapacity: provisioned ? (index.readCapacity ?? 5) : null,
        writeCapacity: provisioned ? (index.writeCapacity ?? 5) : null,
      });
      onAdded();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog table-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">
          Add global index · <span className="mono">{table.name}</span>
        </div>
        <div className="dialog-body">
          <IndexEditor index={index} provisioned={provisioned} onChange={setIndex} />
          <div className="hint">DynamoDB builds the index in the background (backfilling); its status shows in Details until it's ACTIVE.</div>
          {problem && index.name && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" disabled={!!problem || busy || shell.readOnly} onClick={() => void add()}>
            {busy ? "Adding…" : "Add index"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function TableSettingsDialog({ table: t, shell, onClose, onSaved }: { table: TableInfo; shell: Shell; onClose: () => void; onSaved: () => void }) {
  const [billing, setBilling] = useState(t.billingMode ?? "PAY_PER_REQUEST");
  const [rcu, setRcu] = useState(String(t.readCapacity ?? 5));
  const [wcu, setWcu] = useState(String(t.writeCapacity ?? 5));
  const [protect, setProtect] = useState(t.deletionProtection);
  const [tableClass, setTableClass] = useState(t.tableClass ?? "STANDARD");
  const [stream, setStream] = useState(t.streamEnabled ? (t.streamViewType ?? "NEW_AND_OLD_IMAGES") : "");
  const ttlOn = t.ttlStatus === "ENABLED" || t.ttlStatus === "ENABLING";
  const [ttl, setTtl] = useState(ttlOn ? (t.ttlAttribute ?? "") : "");
  const [pitr, setPitr] = useState(t.pitrStatus === "ENABLED");
  const [tags, setTags] = useState<{ key: string; value: string }[] | null>(null);
  const [origTags, setOrigTags] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!t.arn) return setTags([]);
    ddbApi
      .listTags(t.arn)
      .then((x) => {
        const rows = x.map(([key, value]) => ({ key, value }));
        setTags(rows);
        setOrigTags(JSON.stringify(rows));
      })
      .catch(() => setTags([]));
  }, [t.arn]);

  const patch: SettingsPatch = {};
  const provisioned = billing === "PROVISIONED";
  if (billing !== t.billingMode || (provisioned && (Number(rcu) !== t.readCapacity || Number(wcu) !== t.writeCapacity))) {
    patch.billingMode = billing;
    if (provisioned) {
      patch.readCapacity = Number(rcu);
      patch.writeCapacity = Number(wcu);
    }
  }
  if (protect !== t.deletionProtection) patch.deletionProtection = protect;
  if (tableClass !== (t.tableClass ?? "STANDARD")) patch.tableClass = tableClass;
  if (stream !== (t.streamEnabled ? (t.streamViewType ?? "") : "")) patch.streamViewType = stream;
  if (ttl.trim() !== (ttlOn ? (t.ttlAttribute ?? "") : "")) patch.ttlAttribute = ttl.trim();
  if (pitr !== (t.pitrStatus === "ENABLED")) patch.pitr = pitr;
  if (tags && JSON.stringify(tags) !== origTags) patch.tags = Object.fromEntries(tags.map((x) => [x.key.trim(), x.value]));
  const changed = Object.keys(patch).length > 0;
  const problem = (provisioned ? capacityProblem(rcu, wcu) : null) ?? (tags?.some((x) => !x.key.trim()) ? "Every tag needs a key" : null);

  async function save() {
    if (!changed || problem) return;
    setBusy(true);
    setError(null);
    try {
      await ddbApi.updateSettings(t.name, patch);
      onSaved();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog table-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">
          Table settings · <span className="mono">{t.name}</span>
        </div>
        <div className="dialog-body">
          <div className="pe-grid">
            <span className="form-label">Capacity</span>
            <div className="row">
              <select className="text-input" value={billing} onChange={(e) => setBilling(e.target.value)}>
                <option value="PAY_PER_REQUEST">On-demand</option>
                <option value="PROVISIONED">Provisioned</option>
              </select>
              {provisioned && (
                <>
                  <input className="text-input num-input" value={rcu} onChange={(e) => setRcu(e.target.value.trim())} />
                  <span className="hint">read</span>
                  <input className="text-input num-input" value={wcu} onChange={(e) => setWcu(e.target.value.trim())} />
                  <span className="hint">write units</span>
                </>
              )}
            </div>
            <span className="form-label">Table class</span>
            <select className="text-input" value={tableClass} onChange={(e) => setTableClass(e.target.value)}>
              <option value="STANDARD">Standard</option>
              <option value="STANDARD_INFREQUENT_ACCESS">Standard-Infrequent Access</option>
            </select>
            <span className="form-label">Stream</span>
            <select className="text-input" value={stream} onChange={(e) => setStream(e.target.value)}>
              <option value="">Off</option>
              {STREAM_VIEWS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <span className="form-label">Time to live</span>
            <div className="row">
              <input className="text-input mono" value={ttl} placeholder="off (or the attribute holding the expiry time)" onChange={(e) => setTtl(e.target.value)} />
              <span className="hint">epoch seconds</span>
            </div>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={pitr} onChange={(e) => setPitr(e.target.checked)} /> Point-in-time recovery (continuous backups for the last 35 days)
          </label>
          <label className="check-row">
            <input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} /> Deletion protection
          </label>
          {patch.streamViewType !== undefined && t.streamEnabled && stream && <div className="hint">Changing the view type turns the stream off and on again; the stream ARN changes.</div>}
          {billing !== t.billingMode && <div className="hint">DynamoDB allows switching capacity mode once every 24 hours.</div>}
          <div className="props-section">Tags</div>
          {tags === null ? <div className="hint">Loading…</div> : <TagRows tags={tags} onChange={setTags} />}
          {problem && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" disabled={!changed || !!problem || busy || shell.readOnly} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
