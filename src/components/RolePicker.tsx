// A role ARN field with a picker: roles whose trust policy allows `service`
// first, the rest behind "Show all roles". Typing an ARN still works, and the
// field keeps working when roles can't be listed (no IAM permission).
import { useState } from "react";
import type { AppError } from "../api/core";
import { iamApi, pickerRoles, type RoleSummary } from "../api/iam";

export function RolePicker({ id, value, onChange, service, placeholder }: { id?: string; value: string; onChange: (arn: string) => void; service: string; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [roles, setRoles] = useState<RoleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);

  function toggle() {
    setOpen((o) => !o);
    if (!roles && !error)
      iamApi
        .roles()
        .then(setRoles)
        .catch((e) => setError((e as AppError).message ?? String(e)));
  }

  const { trusting, others } = roles ? pickerRoles(roles, service, showAll, filter) : { trusting: [], others: [] };
  const item = (r: RoleSummary) => (
    <button
      key={r.arn}
      type="button"
      className={`role-pick${r.arn === value ? " selected" : ""}`}
      title={r.arn}
      onClick={() => {
        onChange(r.arn);
        setOpen(false);
      }}
    >
      <span className="role-pick-name">{r.name}</span>
      {r.path !== "/" && <span className="hint mono"> {r.path}</span>}
      {r.description && <span className="hint"> · {r.description}</span>}
    </button>
  );

  return (
    <div className="role-picker">
      <div className="row">
        <input id={id} className="text-input mono grow" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? "arn:aws:iam::123456789012:role/my-role"} />
        <button type="button" className="btn" onClick={toggle} aria-expanded={open}>
          {open ? "Close list" : "Choose…"}
        </button>
      </div>
      {open && (
        <div className="role-pick-panel">
          {error ? (
            <p className="field-error">Couldn't list roles ({error}). Type the role ARN instead.</p>
          ) : !roles ? (
            <p className="hint">Loading roles…</p>
          ) : (
            <>
              <div className="row">
                <input className="text-input grow" autoFocus placeholder="Filter: name prefix, or a path starting with /" value={filter} onChange={(e) => setFilter(e.target.value)} />
                <label className="check-row">
                  <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all roles
                </label>
              </div>
              <div className="role-pick-list">
                <div className="hint role-pick-head">Roles that {service} can assume ({trusting.length})</div>
                {trusting.length ? trusting.map(item) : <p className="hint">None{filter ? " match the filter" : ""}. {showAll ? "" : "Tick Show all roles to pick another (its trust policy must allow the service)."}</p>}
                {showAll && (
                  <>
                    <div className="hint role-pick-head">Other roles ({others.length}): their trust policies don't name {service}</div>
                    {others.map(item)}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
