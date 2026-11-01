// Version history of a parameter: values, diff any two, labels, restore.
import { useCallback, useEffect, useState } from "react";
import type { AppError } from "../../api/core";
import { ssmApi, type ParamVersion } from "../../api/ssm";
import { DiffView } from "../../components/DiffView";
import { MaskedValue } from "../../components/MaskedValue";
import { ValueView } from "../../components/ValueView";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";

interface Props {
  name: string;
  shell: Shell;
  onClose: () => void;
  /** A write happened (restore / labels): the list should refresh. */
  onChanged: () => void;
}

/** Mirrors `ssm::label_problem` in Rust. */
export function labelProblem(label: string): string | null {
  if (!label) return "Enter a label";
  if (label.length > 100) return "Labels can be at most 100 characters";
  if (!/^[A-Za-z0-9_.-]+$/.test(label)) return "Use letters, digits, _ . and - only";
  if (/^\d/.test(label)) return "Labels can't begin with a digit";
  if (/^(aws|ssm)/i.test(label)) return 'Labels can\'t begin with "aws" or "ssm"';
  return null;
}

/** "arn:aws:iam::123:user/mark" → "mark". */
function shortUser(u: string | null): string {
  if (!u) return "";
  return u.slice(u.lastIndexOf("/") + 1) || u;
}

export function ParamHistoryDialog({ name, shell, onClose, onChanged }: Props) {
  const { readOnly } = shell;
  const [versions, setVersions] = useState<ParamVersion[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  /** Selected versions, in click order (at most two). */
  const [picked, setPicked] = useState<number[]>([]);
  /** Decrypted values for a diff, only while the diff is shown. */
  const [diff, setDiff] = useState<{ a: ParamVersion; b: ParamVersion; av: string; bv: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const h = await ssmApi.history(name);
      setVersions(h);
      setError(null);
      setPicked((p) => (p.length ? p.filter((v) => h.some((x) => x.version === v)) : h.length ? [h[h.length - 1].version] : []));
    } catch (e) {
      setError(e as AppError);
    }
  }, [name]);

  useEffect(() => {
    void load();
    return () => setDiff(null); // drop any decrypted values
  }, [load]);

  const byVersion = new Map((versions ?? []).map((v) => [v.version, v]));
  const sel = picked.map((v) => byVersion.get(v)).filter((v): v is ParamVersion => !!v);
  const latest = versions?.length ? versions[versions.length - 1].version : 0;

  function toggle(v: number, additive: boolean) {
    setDiff(null);
    setPicked((p) => {
      if (!additive) return [v];
      if (p.includes(v)) return p.filter((x) => x !== v);
      return [...p, v].slice(-2);
    });
  }

  async function run(what: () => Promise<unknown>) {
    setBusy(true);
    try {
      await what();
      await load();
      onChanged();
    } catch (e) {
      shell.showError(e);
    } finally {
      setBusy(false);
    }
  }

  async function addLabel(v: ParamVersion) {
    const label = await shell.askName(`Add label to version ${v.version}`, "Label", "", "Add", (s) => labelProblem(s.trim()));
    if (!label) return;
    const l = label.trim();
    const holder = versions?.find((x) => x.labels.includes(l));
    if (holder && holder.version !== v.version) {
      const ok = await shell.ask(
        "Move label",
        <>
          <b>{l}</b> is on version {holder.version}. Move it to version {v.version}?
        </>,
        [
          { label: "Move", value: "move", primary: true },
          { label: "Cancel", value: "cancel" },
        ],
        "cancel",
      );
      if (ok !== "move") return;
    }
    if (holder?.version === v.version) return;
    await run(() => ssmApi.label(name, v.version, [l]));
  }

  async function restore(v: ParamVersion) {
    const ok = await shell.ask(
      "Restore version",
      <>
        Save the value of version {v.version} as a new version {latest + 1} of <span className="mono">{name}</span>? Labels stay
        where they are.
      </>,
      [
        { label: "Restore", value: "restore", primary: true },
        { label: "Cancel", value: "cancel" },
      ],
      "cancel",
    );
    if (ok !== "restore") return;
    await run(async () => {
      const nv = await ssmApi.restore(name, v.version);
      shell.showFlash(`Restored version ${v.version} as version ${nv}.`);
      setPicked([nv]);
    });
  }

  /** Values for a diff: plain ones from the history, secure ones decrypted now. */
  async function compare(a: ParamVersion, b: ParamVersion) {
    const [x, y] = a.version < b.version ? [a, b] : [b, a];
    setBusy(true);
    try {
      const get = (v: ParamVersion) => (v.value !== null ? Promise.resolve(v.value) : ssmApi.getValue(`${name}:${v.version}`, true));
      const [av, bv] = await Promise.all([get(x), get(y)]);
      setDiff({ a: x, b: y, av: pretty(av), bv: pretty(bv) });
    } catch (e) {
      shell.showError(e);
    } finally {
      setBusy(false);
    }
  }

  const one = sel.length === 1 ? sel[0] : null;
  const two = sel.length === 2 ? sel : null;
  const needsDecrypt = two?.some((v) => v.value === null);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog param-dialog history-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="ph-title"
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && e.target === e.currentTarget && onClose()}
      >
        <div className="dialog-title" id="ph-title">
          History · <span className="mono">{name}</span>
        </div>
        <div className="dialog-body">
          {error ? (
            <div className="field-error">{error.message}</div>
          ) : !versions ? (
            <div className="hint">Loading…</div>
          ) : (
            <>
              <div className="hint">Click a version to view it; Ctrl+click a second one to compare.</div>
              <div className="sync-table-wrap history-table-wrap">
                <table className="sync-table history-table">
                  <thead>
                    <tr>
                      <th className="right">Version</th>
                      <th>Modified</th>
                      <th>By</th>
                      <th>Labels</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...versions].reverse().map((v) => (
                      <tr
                        key={v.version}
                        className={picked.includes(v.version) ? "selected" : ""}
                        onClick={(e) => toggle(v.version, e.ctrlKey || e.metaKey)}
                      >
                        <td className="right">
                          {v.version}
                          {v.version === latest && <span className="hint"> (current)</span>}
                        </td>
                        <td>{formatDate(v.lastModified)}</td>
                        <td title={v.lastModifiedUser ?? ""}>{shortUser(v.lastModifiedUser)}</td>
                        <td>
                          {v.labels.map((l) => (
                            <span key={l} className="label-chip">
                              {l}
                              {!readOnly && (
                                <button
                                  title={`Remove label ${l}`}
                                  disabled={busy}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void run(() => ssmApi.unlabel(name, v.version, [l]));
                                  }}
                                >
                                  ×
                                </button>
                              )}
                            </span>
                          ))}
                        </td>
                        <td className="mono history-value">{v.value === null ? "••••••••" : v.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="row history-actions">
                {one && (
                  <>
                    <button className="btn" disabled={readOnly || busy || one.labels.length >= 10} onClick={() => void addLabel(one)}>
                      Add label…
                    </button>
                    <button className="btn" disabled={readOnly || busy || one.version === latest} onClick={() => void restore(one)}>
                      Restore this version…
                    </button>
                    {one.version !== latest && (
                      <button className="btn" disabled={busy} onClick={() => void compare(one, byVersion.get(latest)!)}>
                        {one.value === null ? "Compare with current (decrypts)" : "Compare with current"}
                      </button>
                    )}
                  </>
                )}
                {two && (
                  <button className="btn" disabled={busy} onClick={() => void compare(two[0], two[1])}>
                    {needsDecrypt ? "Compare (decrypts both)" : "Compare"}
                  </button>
                )}
                <div className="spacer" />
                {busy && <span className="hint">Working…</span>}
              </div>

              {diff ? (
                <DiffView before={diff.av} after={diff.bv} beforeLabel={`version ${diff.a.version}`} afterLabel={`version ${diff.b.version}`} />
              ) : (
                one && (
                  <div className="history-detail">
                    <div className="props-section">
                      Version {one.version} · {one.paramType}
                      {one.description ? ` · ${one.description}` : ""}
                    </div>
                    {one.value === null ? (
                      <MaskedValue
                        key={one.version}
                        load={() => ssmApi.getValue(`${name}:${one.version}`, true)}
                        onError={shell.showError}
                        onCopied={() => shell.showFlash("Decrypted value copied to the clipboard.")}
                        renderRevealed={(val) => <ValueView value={val} />}
                      />
                    ) : (
                      <ValueView value={one.value} />
                    )}
                  </div>
                )
              )}
            </>
          )}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Pretty-prints JSON so diffs show per-key changes; other text unchanged. */
function pretty(v: string): string {
  const t = v.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not JSON */
    }
  }
  return v;
}
