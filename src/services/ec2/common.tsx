// Small pieces shared by the EC2 views.
import { useEffect, useState, type ReactNode } from "react";
import type { AppError } from "../../api/core";
import { instanceTone, isOpenToWorld, ruleSource, type Rule } from "../../api/ec2";
import { PropsTable } from "../elasticache/CacheViews";

export { PropsTable };

export function Pill({ status }: { status: string | null | undefined }) {
  return <span className={`status-pill ${instanceTone(status)}`}>{status ?? "unknown"}</span>;
}

export const yesNo = (b: boolean | null | undefined) => (b === null || b === undefined ? null : b ? "Yes" : "No");

export function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* convenience only */
  }
}

/** Loads `load()` for `key`, again every `pollMs(data)` ms while that isn't null. */
export function useLoad<T>(key: string, load: () => Promise<T>, pollMs: (d: T | null) => number | null = () => null) {
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

export function TagsTable({ tags }: { tags: [string, string][] }) {
  if (tags.length === 0) return <p className="hint">No tags.</p>;
  return <PropsTable rows={tags.map(([k, v]) => [k, v || " "] as [string, ReactNode])} />;
}

/** One direction of a security group's rules. */
export function RulesTable({ rules, inbound, onGroup }: { rules: Rule[]; inbound: boolean; onGroup?: (id: string) => void }) {
  if (rules.length === 0) return <p className="hint">{inbound ? "No inbound rules: nothing can connect in." : "No outbound rules: nothing can go out."}</p>;
  return (
    <table className="sync-table">
      <thead>
        <tr>
          <th>Protocol</th>
          <th>Ports</th>
          <th>{inbound ? "Source" : "Destination"}</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {rules.map((r, n) => (
          <tr key={n}>
            <td>{r.protocol}</td>
            <td>{r.ports}</td>
            <td className="mono selectable">
              {r.sourceKind === "group" && onGroup && !r.sourceAccount ? (
                <button className="link-btn mono" title="Open the security group" onClick={() => onGroup(r.source)}>
                  {ruleSource(r)}
                </button>
              ) : (
                ruleSource(r)
              )}
              {inbound && isOpenToWorld(r) && (
                <span className="qbadge warn-badge" title="Anyone on the internet can reach this port">
                  open to the internet
                </span>
              )}
            </td>
            <td>{r.description ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Tabs for a resource view; ids are local, help topics come with each tab. */
export function Tabs<T extends string>({ tabs, current, onChange }: { tabs: { id: T; label: string }[]; current: T; onChange: (t: T) => void }) {
  return (
    <div className="segmented small db-tabs">
      {tabs.map((t) => (
        <button key={t.id} className={current === t.id ? "active" : ""} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
