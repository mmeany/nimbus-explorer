// Parameters tab (read only): the parameter group a replication group uses,
// and its parameters, optionally only those changed from the defaults.
import { useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { ecApi, type CacheParameter, type ParameterGroup } from "../../api/elasticache";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import type { Shell } from "../../shell/shell";
import { PropsTable } from "./CacheViews";

const COLUMNS: Column[] = [
  { id: "name", label: "Parameter", width: 260 },
  { id: "value", label: "Value", width: 180 },
  { id: "changed", label: "Changed", width: 70 },
  { id: "applies", label: "Takes effect", width: 110 },
  { id: "modifiable", label: "Modifiable", width: 80 },
  { id: "type", label: "Type", width: 80 },
  { id: "allowed", label: "Allowed values", width: 220 },
  { id: "description", label: "Description", width: 360 },
];
const STORAGE = "elasticache.params.changedOnly";

/** The value to show: plain, or this node type's for node-type-specific parameters. */
export function parameterValue(p: CacheParameter, nodeType: string | null): string {
  if (!p.perNodeType.length) return p.value ?? "";
  const mine = nodeType ? p.perNodeType.find(([t]) => t === nodeType) : undefined;
  return mine ? `${mine[1]} (for ${nodeType})` : "varies by node type";
}

function savedChangedOnly(): boolean {
  try {
    return localStorage.getItem(STORAGE) === "1";
  } catch {
    return false;
  }
}

export function ParametersTab({ shell, group, status, nodeType }: { shell: Shell; group: string | null; status: string | null; nodeType: string | null }) {
  const [changedOnly, setChangedOnly] = useState(savedChangedOnly);
  const [search, setSearch] = useState("");
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [data, setData] = useState<{ key: string; g: ParameterGroup | null; error: AppError | null } | null>(null);
  const key = `${group}|${changedOnly}|${tick}`;
  useEffect(() => {
    if (!group) return;
    let stale = false;
    ecApi
      .parameters(group, changedOnly)
      .then((g) => !stale && setData({ key, g, error: null }))
      .catch((e) => !stale && setData({ key, g: null, error: e as AppError }));
    return () => {
      stale = true;
    };
  }, [group, changedOnly, key]);

  const g = data?.key === key ? data.g : null;
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (g?.parameters ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q));
  }, [g, search]);
  const byName = useMemo(() => new Map(shown.map((p) => [p.name, p])), [shown]);
  const rows: Row[] = useMemo(
    () =>
      shown.map((p) => ({
        key: p.name,
        icon: null,
        isContainer: false,
        cells: {
          name: { text: p.name, sort: p.name },
          value: { text: parameterValue(p, nodeType), sort: p.value ?? "" },
          changed: { text: p.source === "user" ? "changed" : "", sort: p.source === "user" ? 1 : 0 },
          applies: { text: p.changeType === "requires-reboot" ? "after reboot" : p.changeType === "immediate" ? "immediately" : "", sort: p.changeType ?? "" },
          modifiable: { text: p.modifiable === null ? "" : p.modifiable ? "yes" : "no", sort: p.modifiable ? 1 : 0 },
          type: { text: p.dataType ?? "", sort: p.dataType ?? "" },
          allowed: { text: p.allowedValues ?? "", sort: p.allowedValues ?? "" },
          description: { text: p.description ?? "", sort: p.description ?? "" },
        },
      })),
    [shown, nodeType],
  );
  const chosen = selected.size === 1 ? byName.get([...selected][0]) : undefined;

  if (!group) return <p className="hint">This cache's parameter group isn't known (its nodes couldn't be read).</p>;

  function toggle(v: boolean) {
    setChangedOnly(v);
    try {
      localStorage.setItem(STORAGE, v ? "1" : "0");
    } catch {
      /* this session only */
    }
  }

  return (
    <div className="lambda-details">
      <PropsTable
        rows={[
          ["Parameter group", group],
          ["Family", g?.family],
          ["Description", g?.description],
          ["Status", status === "in-sync" ? "In sync with the nodes" : status === "pending-reboot" ? "Changes wait for a reboot of the nodes" : status],
        ]}
      />
      <div className="row">
        <label className="check-row inline">
          <input type="checkbox" checked={changedOnly} onChange={(e) => toggle(e.target.checked)} /> Only values changed from the default
        </label>
        <input className="text-input" placeholder="Find a parameter" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find a parameter" />
        <span className="hint">{g ? `${shown.length.toLocaleString()} of ${g.parameters.length.toLocaleString()}` : "Loading…"}</span>
      </div>
      {data?.key === key && data.error ? (
        <ErrorPanel error={data.error} profile={shell.profile} onRetry={() => setTick((x) => x + 1)} />
      ) : (
        <div className="ec-snap-list">
          <FileList
            storageKey="elasticache.parameters"
            columns={COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={() => undefined}
            emptyText={!g ? "Loading…" : changedOnly ? (search ? "No changed parameter matches." : "Nothing is changed from the defaults.") : "No parameters match."}
          />
        </div>
      )}
      {chosen && chosen.perNodeType.length > 0 && (
        <>
          <div className="props-section">{chosen.name} by node type</div>
          <PropsTable rows={chosen.perNodeType.map(([t, v]) => [t, v])} />
        </>
      )}
      <p className="hint">Read only: change parameters in the console or your infrastructure code. Default groups (default.*) can't be changed at all; a cache needs its own group for that.</p>
    </div>
  );
}
