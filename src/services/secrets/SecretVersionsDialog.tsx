// Versions and staging labels: view old values, compare, roll back by moving
// AWSCURRENT, add / move / remove custom labels.
import { useCallback, useEffect, useState } from "react";
import type { AppError } from "../../api/core";
import { smApi, type SecretInfo, type VersionInfo } from "../../api/secrets";
import { DiffView } from "../../components/DiffView";
import { MaskedValue } from "../../components/MaskedValue";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";
import { SecretValueDisplay } from "./SecretValueDisplay";

const AWS_LABELS = ["AWSCURRENT", "AWSPREVIOUS", "AWSPENDING"];

function pretty(v: string): string {
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}

export function SecretVersionsDialog({ secret, shell, onClose, onChanged }: { secret: SecretInfo; shell: Shell; onClose: () => void; onChanged: () => void }) {
  const id = secret.arn ?? secret.name;
  const ro = shell.readOnly;
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [diff, setDiff] = useState<{ a: string; b: string; av: string; bv: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const vs = await smApi.listVersions(id);
      setVersions(vs);
      setPicked((p) => (p.length ? p.filter((x) => vs.some((v) => v.versionId === x)) : vs.length ? [vs[0].versionId] : []));
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
    return () => setDiff(null);
  }, [load]);

  const byId = new Map((versions ?? []).map((v) => [v.versionId, v]));
  const holder = (stage: string) => versions?.find((v) => v.stages.includes(stage));
  const one = picked.length === 1 ? byId.get(picked[0]) : undefined;
  const two = picked.length === 2 ? picked.map((p) => byId.get(p)!).filter(Boolean) : null;

  async function run(f: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await f();
      shell.showFlash(msg);
      await load();
      onChanged();
    } catch (e) {
      shell.showError(e);
    } finally {
      setBusy(false);
    }
  }

  async function rollBack(v: VersionInfo) {
    const cur = holder("AWSCURRENT");
    if (!cur || cur.versionId === v.versionId) return;
    const ok = await shell.ask(
      "Make this version current",
      <>Move AWSCURRENT to this version? Applications reading the secret get this value from now on; the version that was current keeps its other labels.</>,
      [
        { label: "Make current", value: "go", primary: true },
        { label: "Cancel", value: "cancel" },
      ],
      "cancel",
    );
    if (ok !== "go") return;
    await run(() => smApi.moveLabel(id, "AWSCURRENT", v.versionId, cur.versionId), "AWSCURRENT moved.");
  }

  async function addLabel(v: VersionInfo) {
    const label = await shell.askName("Add staging label", "Label", "", "Add", (s) => {
      const t = s.trim();
      if (!t || t.length > 256) return "Labels must be 1 to 256 characters";
      if (t === "AWSCURRENT") return "Use “Make current” to move AWSCURRENT";
      if (v.stages.includes(t)) return "This version already has that label";
      return null;
    });
    if (!label) return;
    const t = label.trim();
    const from = holder(t);
    if (from) {
      const ok = await shell.ask(
        "Move label",
        <>
          <b>{t}</b> is on another version. Move it here?
        </>,
        [
          { label: "Move", value: "go", primary: true },
          { label: "Cancel", value: "cancel" },
        ],
        "cancel",
      );
      if (ok !== "go") return;
    }
    await run(() => smApi.moveLabel(id, t, v.versionId, from?.versionId ?? null), `Label ${t} set.`);
  }

  async function compare(a: VersionInfo, b: VersionInfo) {
    setBusy(true);
    try {
      const [x, y] = [a, b].sort((p, q) => (p.created ?? "").localeCompare(q.created ?? ""));
      const [xv, yv] = await Promise.all([smApi.getValue(id, x.versionId), smApi.getValue(id, y.versionId)]);
      setDiff({ a: x.versionId, b: y.versionId, av: pretty(xv.text ?? xv.binaryBase64 ?? ""), bv: pretty(yv.text ?? yv.binaryBase64 ?? "") });
    } catch (e) {
      shell.showError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog history-dialog" role="dialog" aria-modal tabIndex={-1} ref={(el) => el?.focus()} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && e.target === e.currentTarget && onClose()}>
        <div className="dialog-title">
          Versions · <span className="mono">{secret.name}</span>
        </div>
        <div className="dialog-body">
          {error ? (
            <div className="field-error">{error}</div>
          ) : !versions ? (
            <div className="hint">Loading…</div>
          ) : (
            <>
              <div className="hint">Click a version; Ctrl+click a second one to compare. Versions without labels are deprecated and may be removed by Secrets Manager.</div>
              <div className="sync-table-wrap history-table-wrap">
                <table className="sync-table history-table">
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>Labels</th>
                      <th>Created</th>
                      <th>Last retrieved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr
                        key={v.versionId}
                        className={picked.includes(v.versionId) ? "selected" : ""}
                        onClick={(e) => {
                          setDiff(null);
                          setPicked((p) => (e.ctrlKey || e.metaKey ? (p.includes(v.versionId) ? p.filter((x) => x !== v.versionId) : [...p, v.versionId].slice(-2)) : [v.versionId]));
                        }}
                      >
                        <td className="mono" title={v.versionId}>
                          {v.versionId.slice(0, 8)}…
                        </td>
                        <td>
                          {v.stages.length === 0 && <span className="hint">(none)</span>}
                          {v.stages.map((s) => (
                            <span key={s} className={`label-chip ${s === "AWSCURRENT" ? "current" : ""}`}>
                              {s}
                              {!ro && !AWS_LABELS.includes(s) && (
                                <button
                                  title={`Remove ${s}`}
                                  disabled={busy}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void run(() => smApi.moveLabel(id, s, null, v.versionId), `Label ${s} removed.`);
                                  }}
                                >
                                  ×
                                </button>
                              )}
                            </span>
                          ))}
                        </td>
                        <td>{formatDate(v.created)}</td>
                        <td>{v.lastAccessed ? new Date(v.lastAccessed).toLocaleDateString() : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row history-actions">
                {one && (
                  <>
                    <button className="btn" disabled={ro || busy || one.stages.includes("AWSCURRENT")} onClick={() => void rollBack(one)}>
                      Make current…
                    </button>
                    <button className="btn" disabled={ro || busy} onClick={() => void addLabel(one)}>
                      Add label…
                    </button>
                    {!one.stages.includes("AWSCURRENT") && holder("AWSCURRENT") && (
                      <button className="btn" disabled={busy} onClick={() => void compare(one, holder("AWSCURRENT")!)}>
                        Compare with current (decrypts)
                      </button>
                    )}
                  </>
                )}
                {two && two.length === 2 && (
                  <button className="btn" disabled={busy} onClick={() => void compare(two[0], two[1])}>
                    Compare (decrypts both)
                  </button>
                )}
              </div>
              {diff ? (
                <DiffView before={diff.av} after={diff.bv} beforeLabel={diff.a.slice(0, 8)} afterLabel={diff.b.slice(0, 8)} />
              ) : (
                one && (
                  <div className="history-detail">
                    <div className="props-section">Value of version {one.versionId.slice(0, 8)}…</div>
                    <MaskedValue
                      key={one.versionId}
                      load={async () => {
                        const v = await smApi.getValue(id, one.versionId);
                        return v.text ?? v.binaryBase64 ?? "";
                      }}
                      onError={shell.showError}
                      onCopied={() => shell.showFlash("Copied.")}
                      renderRevealed={(v) => <SecretValueDisplay value={v} onCopy={(t) => void navigator.clipboard.writeText(t).then(() => shell.showFlash("Copied."))} />}
                    />
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
