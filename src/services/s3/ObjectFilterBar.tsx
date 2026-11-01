// Filter row above the S3 object list: name contains, file types, size range,
// modified date range, storage class. Applies to the page on screen.
import { activeCount, NO_FILTER, type ObjectFilter } from "../../util/objectFilter";

interface Props {
  filter: ObjectFilter;
  onChange: (f: ObjectFilter) => void;
  /** Storage classes seen on this page (for the list). */
  classes: string[];
}

export function ObjectFilterBar({ filter: f, onChange, classes }: Props) {
  const set = (patch: Partial<ObjectFilter>) => onChange({ ...f, ...patch });
  const n = activeCount(f);
  const classOptions = [...new Set([...classes, ...(f.storageClass ? [f.storageClass] : [])])].sort();
  return (
    <div className={`filter-bar object-filters ${n ? "active" : ""}`}>
      <span className="field-label">Filter:</span>
      <input
        className="text-input of-name"
        placeholder="Name contains"
        value={f.name}
        spellCheck={false}
        aria-label="Name contains"
        onChange={(e) => set({ name: e.target.value })}
      />
      <input
        className="text-input of-types mono"
        placeholder="Types, e.g. .json .csv"
        value={f.types}
        spellCheck={false}
        aria-label="File types"
        onChange={(e) => set({ types: e.target.value })}
      />
      <span className="of-group" title="Size range">
        <span className="hint">Size</span>
        <input className="text-input of-num" type="number" min={0} placeholder="min" value={f.minSize} aria-label="Minimum size" onChange={(e) => set({ minSize: e.target.value })} />
        <span className="hint">–</span>
        <input className="text-input of-num" type="number" min={0} placeholder="max" value={f.maxSize} aria-label="Maximum size" onChange={(e) => set({ maxSize: e.target.value })} />
        <select className="text-input of-unit" value={f.sizeUnit} aria-label="Size unit" onChange={(e) => set({ sizeUnit: e.target.value as ObjectFilter["sizeUnit"] })}>
          {(["B", "KB", "MB", "GB"] as const).map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
      </span>
      <span className="of-group" title="Modified between (inclusive)">
        <span className="hint">Modified</span>
        <input className="text-input of-date" type="date" value={f.from} max={f.to || undefined} aria-label="Modified from" onChange={(e) => set({ from: e.target.value })} />
        <span className="hint">–</span>
        <input className="text-input of-date" type="date" value={f.to} min={f.from || undefined} aria-label="Modified to" onChange={(e) => set({ to: e.target.value })} />
      </span>
      <select className="text-input of-class" value={f.storageClass} aria-label="Storage class" onChange={(e) => set({ storageClass: e.target.value })}>
        <option value="">Any storage class</option>
        {classOptions.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      {n > 0 && (
        <button className="btn small" onClick={() => onChange({ ...NO_FILTER, sizeUnit: f.sizeUnit })}>
          Clear filters
        </button>
      )}
    </div>
  );
}
