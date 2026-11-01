// Tags, tier and policies of one parameter.
import { useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { ssmApi, type ParamInfo, type Tag } from "../../api/ssm";
import type { Shell } from "../../shell/shell";

interface Props {
  param: ParamInfo;
  shell: Shell;
  initialTab?: "tags" | "tier";
  onClose: () => void;
  onChanged: () => void;
}

type Unit = "Days" | "Hours";

/** The three policy kinds as form state ("" = not set). */
export interface PolicyForm {
  /** Expiration time, local "YYYY-MM-DDTHH:mm" (datetime-local). */
  expiresAt: string;
  notifyBefore: string;
  notifyBeforeUnit: Unit;
  noChangeAfter: string;
  noChangeAfterUnit: Unit;
}

const EMPTY_POLICIES: PolicyForm = { expiresAt: "", notifyBefore: "", notifyBeforeUnit: "Days", noChangeAfter: "", noChangeAfterUnit: "Days" };

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Reads stored policy JSON texts into the form. Unknown shapes are ignored. */
export function parsePolicies(texts: string[]): PolicyForm {
  const f = { ...EMPTY_POLICIES };
  for (const text of texts) {
    let list: unknown;
    try {
      list = JSON.parse(text);
    } catch {
      continue;
    }
    for (const p of Array.isArray(list) ? list : [list]) {
      const a = (p as { Attributes?: Record<string, string> })?.Attributes ?? {};
      switch ((p as { Type?: string })?.Type) {
        case "Expiration":
          if (a.Timestamp) f.expiresAt = toLocalInput(a.Timestamp);
          break;
        case "ExpirationNotification":
          f.notifyBefore = String(a.Before ?? "");
          f.notifyBeforeUnit = a.Unit === "Hours" ? "Hours" : "Days";
          break;
        case "NoChangeNotification":
          f.noChangeAfter = String(a.After ?? "");
          f.noChangeAfterUnit = a.Unit === "Hours" ? "Hours" : "Days";
          break;
      }
    }
  }
  return f;
}

/** Builds the Policies JSON array SSM expects ("[]" when none). */
export function buildPolicies(f: PolicyForm): string {
  const out: object[] = [];
  if (f.expiresAt) {
    out.push({ Type: "Expiration", Version: "1.0", Attributes: { Timestamp: new Date(f.expiresAt).toISOString() } });
  }
  if (f.notifyBefore) {
    out.push({ Type: "ExpirationNotification", Version: "1.0", Attributes: { Before: f.notifyBefore, Unit: f.notifyBeforeUnit } });
  }
  if (f.noChangeAfter) {
    out.push({ Type: "NoChangeNotification", Version: "1.0", Attributes: { After: f.noChangeAfter, Unit: f.noChangeAfterUnit } });
  }
  return JSON.stringify(out);
}

export function policyProblem(f: PolicyForm): string | null {
  for (const n of [f.notifyBefore, f.noChangeAfter]) if (n && !/^[1-9]\d*$/.test(n)) return "Enter whole numbers of days or hours";
  if (f.expiresAt && new Date(f.expiresAt).getTime() <= Date.now()) return "The expiration time must be in the future";
  if (f.notifyBefore && !f.expiresAt) return "A notification before expiration needs an expiration time";
  return null;
}

const TAG_KEY = /^[\p{L}\p{N}\s_.:/=+\-@]{1,128}$/u;
const TAG_VALUE = /^[\p{L}\p{N}\s_.:/=+\-@]{0,256}$/u;

export function tagsProblem(tags: Tag[]): string | null {
  const keys = new Set<string>();
  for (const t of tags) {
    if (!t.key) return "Every tag needs a key";
    if (!TAG_KEY.test(t.key)) return `Tag key "${t.key}" has characters AWS doesn't allow (or is over 128)`;
    if (/^aws:/i.test(t.key)) return 'Tag keys can\'t begin with "aws:"';
    if (!TAG_VALUE.test(t.value)) return `Tag value for "${t.key}" has characters AWS doesn't allow (or is over 256)`;
    if (keys.has(t.key)) return `Duplicate key "${t.key}"`;
    keys.add(t.key);
  }
  if (tags.length > 50) return "At most 50 tags";
  return null;
}

export function ParamSettingsDialog({ param, shell, initialTab = "tags", onClose, onChanged }: Props) {
  const { readOnly } = shell;
  const [tab, setTab] = useState(initialTab);
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [origTags, setOrigTags] = useState<Tag[]>([]);
  const [tagError, setTagError] = useState<string | null>(null);
  const origPolicies = useMemo(() => parsePolicies(param.policies.map((p) => p.text)), [param]);
  const [policies, setPolicies] = useState<PolicyForm>(origPolicies);
  const [tier, setTier] = useState(param.tier ?? "Standard");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ssmApi
      .listTags(param.name)
      .then((t) => {
        setTags(t);
        setOrigTags(t);
      })
      .catch((e) => setTagError((e as AppError).message ?? String(e)));
  }, [param.name]);

  const tagsChanged = tags !== null && JSON.stringify(tags) !== JSON.stringify(origTags);
  const tagProblem = tags ? tagsProblem(tags) : null;
  const newPolicies = buildPolicies(policies);
  const policiesChanged = newPolicies !== buildPolicies(origPolicies);
  const tierChanged = tier !== (param.tier ?? "Standard");
  const pProblem = policiesChanged ? policyProblem(policies) : null;
  const needsAdvanced = newPolicies !== "[]" && tier !== "Advanced";

  async function saveTags() {
    if (!tags || tagProblem) return;
    setBusy(true);
    setError(null);
    try {
      const clean = tags.map((t) => ({ key: t.key.trim(), value: t.value.trim() }));
      await ssmApi.setTags(param.name, clean);
      setTags(clean);
      setOrigTags(clean);
      shell.showFlash(`Tags saved for ${param.name}.`);
      onChanged();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveTier() {
    if (pProblem || needsAdvanced) return;
    if (tierChanged && tier === "Advanced") {
      const ok = await shell.ask(
        "Change to Advanced tier",
        <>Advanced parameters are charged per parameter per month and can't be changed back to Standard. Continue?</>,
        [
          { label: "Change tier", value: "yes", primary: true },
          { label: "Cancel", value: "no" },
        ],
        "no",
      );
      if (ok !== "yes") return;
    }
    setBusy(true);
    setError(null);
    try {
      const v = await ssmApi.updateTierPolicies(param.name, tierChanged ? tier : null, policiesChanged ? newPolicies : null);
      shell.showFlash(`Saved ${param.name} (version ${v}).`);
      onChanged();
      onClose();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const setP = (patch: Partial<PolicyForm>) => setPolicies((p) => ({ ...p, ...patch }));
  const unitSelect = (value: Unit, onChange: (u: Unit) => void) => (
    <select className="text-input" value={value} disabled={readOnly} onChange={(e) => onChange(e.target.value as Unit)}>
      <option>Days</option>
      <option>Hours</option>
    </select>
  );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog param-dialog settings-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="ps-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="dialog-title" id="ps-title">
          Settings · <span className="mono">{param.name}</span>
        </div>
        <div className="dialog-body">
          <div className="segmented small">
            <button className={tab === "tags" ? "active" : ""} onClick={() => setTab("tags")}>
              Tags
            </button>
            <button className={tab === "tier" ? "active" : ""} onClick={() => setTab("tier")}>
              Tier and policies
            </button>
          </div>

          {tab === "tags" ? (
            tagError ? (
              <div className="field-error">{tagError}</div>
            ) : !tags ? (
              <div className="hint">Loading…</div>
            ) : (
              <>
                <table className="tag-table">
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th>Value</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {tags.map((t, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            className="text-input"
                            value={t.key}
                            disabled={readOnly}
                            autoFocus={i === tags.length - 1 && !t.key}
                            onChange={(e) => setTags(tags.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                          />
                        </td>
                        <td>
                          <input
                            className="text-input"
                            value={t.value}
                            disabled={readOnly}
                            onChange={(e) => setTags(tags.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                          />
                        </td>
                        <td>
                          <button className="link-btn" disabled={readOnly} title="Remove tag" onClick={() => setTags(tags.filter((_, j) => j !== i))}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                    {tags.length === 0 && (
                      <tr>
                        <td colSpan={3} className="hint">
                          No tags.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <div className="row">
                  <button className="link-btn" disabled={readOnly || tags.length >= 50} onClick={() => setTags([...tags, { key: "", value: "" }])}>
                    + Add tag
                  </button>
                  <div className="spacer" />
                  {tagProblem && <span className="field-error">{tagProblem}</span>}
                </div>
                <div className="row">
                  <div className="spacer" />
                  <button className="btn" disabled={!tagsChanged || busy} onClick={() => setTags(origTags)}>
                    Undo changes
                  </button>
                  <button className="btn primary" disabled={readOnly || !tagsChanged || !!tagProblem || busy} onClick={() => void saveTags()}>
                    Save tags
                  </button>
                </div>
              </>
            )
          ) : (
            <>
              <div className="pe-grid">
                <label className="form-label" htmlFor="ps-tier">
                  Tier
                </label>
                <select id="ps-tier" className="text-input" value={tier} disabled={readOnly} onChange={(e) => setTier(e.target.value)}>
                  {["Standard", "Advanced"].map((t) => (
                    <option key={t} value={t} disabled={t === "Standard" && param.tier === "Advanced"}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="props-section">Policies (Advanced tier only)</div>
              <div className="pe-grid">
                <label className="form-label" htmlFor="ps-exp">
                  Expires at
                </label>
                <div className="row">
                  <input
                    id="ps-exp"
                    type="datetime-local"
                    className="text-input"
                    value={policies.expiresAt}
                    disabled={readOnly}
                    onChange={(e) => setP({ expiresAt: e.target.value })}
                  />
                  <span className="hint">Your local time. SSM deletes the parameter then.</span>
                </div>
                <label className="form-label" htmlFor="ps-nb">
                  Notify before
                </label>
                <div className="row">
                  <input
                    id="ps-nb"
                    className="text-input num-input"
                    value={policies.notifyBefore}
                    placeholder="—"
                    disabled={readOnly}
                    onChange={(e) => setP({ notifyBefore: e.target.value.trim() })}
                  />
                  {unitSelect(policies.notifyBeforeUnit, (u) => setP({ notifyBeforeUnit: u }))}
                  <span className="hint">EventBridge event before expiration</span>
                </div>
                <label className="form-label" htmlFor="ps-nc">
                  Notify if unchanged for
                </label>
                <div className="row">
                  <input
                    id="ps-nc"
                    className="text-input num-input"
                    value={policies.noChangeAfter}
                    placeholder="—"
                    disabled={readOnly}
                    onChange={(e) => setP({ noChangeAfter: e.target.value.trim() })}
                  />
                  {unitSelect(policies.noChangeAfterUnit, (u) => setP({ noChangeAfterUnit: u }))}
                </div>
              </div>
              {param.policies.length > 0 && (
                <div className="hint">
                  Current: {param.policies.map((p) => `${p.policyType} (${p.status})`).join(", ")}
                </div>
              )}
              {needsAdvanced && <div className="field-error">Policies need the Advanced tier.</div>}
              {pProblem && <div className="field-error">{pProblem}</div>}
              <div className="warn-note">
                SSM changes tier and policies only by writing the parameter again, so saving creates version {param.version + 1}{" "}
                with the same value.
              </div>
              <div className="row">
                <div className="spacer" />
                <button
                  className="btn primary"
                  disabled={readOnly || busy || (!tierChanged && !policiesChanged) || !!pProblem || needsAdvanced}
                  onClick={() => void saveTier()}
                >
                  Save
                </button>
              </div>
            </>
          )}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          {readOnly && <span className="hint">Read-only mode</span>}
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
