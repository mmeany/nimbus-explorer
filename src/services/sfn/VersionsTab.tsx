// Versions and aliases tab: published versions (newest first) and aliases
// with their routing, plus publish / alias / delete actions.
import { useEffect, useState } from "react";
import type { AppError } from "../../api/core";
import { aliasNameProblem, sfnApi, type MachineDetails, type Versions } from "../../api/sfn";
import { ErrorPanel } from "../../components/ErrorPanel";
import { DialogHelp } from "../../components/HelpDialog";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";

type Alias = Versions["aliases"][number];

export function VersionsTab({ shell, m, reloadToken, onChanged }: { shell: Shell; m: MachineDetails; reloadToken: number; onChanged: () => void }) {
  const [state, setState] = useState<{ key: string; v: Versions | null; error: AppError | null }>({ key: "", v: null, error: null });
  const [tick, setTick] = useState(0);
  const [aliasDialog, setAliasDialog] = useState<{ alias: Alias | null } | null>(null);
  const key = `${m.arn}|${reloadToken}|${tick}`;
  useEffect(() => {
    let stale = false;
    sfnApi
      .versions(m.arn)
      .then((v) => !stale && setState({ key, v, error: null }))
      .catch((e) => !stale && setState({ key, v: null, error: e as AppError }));
    return () => {
      stale = true;
    };
  }, [m.arn, key]);
  const ro = shell.readOnly;
  const reload = () => setTick((x) => x + 1);

  async function publish() {
    const desc = await shell.askName("Publish version", "Description (optional)", "", "Publish", (v) => (v.length > 256 ? "At most 256 characters" : null));
    if (desc === null) return;
    shell.setWorking("Publishing…");
    try {
      // With the revision this view loaded, AWS refuses if the definition changed meanwhile.
      const arn = await sfnApi.publishVersion(m.arn, desc.trim() || null, m.revisionId);
      shell.showFlash(`Published version ${arn.slice(arn.lastIndexOf(":") + 1)}.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
      reload();
      onChanged();
    }
  }

  async function deleteAlias(a: Alias) {
    const ok = await shell.ask(
      "Delete alias",
      <p>
        Delete alias <span className="mono">{a.name}</span>? Anything that starts executions through it (EventBridge rules, API Gateway, other workflows) will start failing.
      </p>,
      [
        { label: "Delete", value: "yes", danger: true },
        { label: "Cancel", value: "no" },
      ],
      "no",
    );
    if (ok !== "yes") return;
    try {
      await sfnApi.deleteAlias(a.arn);
      shell.showFlash(`Deleted alias ${a.name}.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      reload();
    }
  }

  async function deleteVersion(arn: string, version: string, users: string[]) {
    if (users.length) return shell.showFlash(`Version ${version} is used by alias ${users.join(", ")}; change the alias first.`);
    const ok = await shell.confirmTyped(
      "Delete version",
      <p>
        Version {version} of <span className="mono">{m.name}</span> will be deleted. Its definition can't be recovered, and executions can no longer be started on it (running ones finish).
      </p>,
      version,
      "Delete version",
    );
    if (!ok) return;
    try {
      await sfnApi.deleteVersion(arn);
      shell.showFlash(`Deleted version ${version}.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      reload();
    }
  }

  if (state.key === key && state.error) return <ErrorPanel error={state.error} profile={shell.profile} onRetry={reload} />;
  const v = state.key === key ? state.v : null;
  if (!v) return <p className="hint">Loading…</p>;
  return (
    <div className="lambda-details">
      <div className="row">
        <button className="btn" disabled={ro} title="Freeze the current definition and settings as a numbered version" onClick={() => void publish()}>
          Publish version…
        </button>
        <button className="btn" disabled={ro || v.versions.length === 0} title={v.versions.length ? "" : "Publish a version first: aliases point at versions"} onClick={() => setAliasDialog({ alias: null })}>
          New alias…
        </button>
      </div>
      <div className="props-section">Aliases</div>
      {v.aliases.length === 0 ? (
        <p className="hint">No aliases.</p>
      ) : (
        <table className="sync-table">
          <thead>
            <tr>
              <th>Alias</th>
              <th>Routing</th>
              <th>Description</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {v.aliases.map((a) => (
              <tr key={a.arn}>
                <td className="mono">{a.name}</td>
                <td>{a.routing.map((r) => `version ${r.version} (${r.weight}%)`).join(", ")}</td>
                <td>{a.description ?? ""}</td>
                <td>{formatDate(a.created)}</td>
                <td className="right nowrap">
                  <button className="link-btn" disabled={ro} onClick={() => setAliasDialog({ alias: a })}>
                    Edit
                  </button>{" "}
                  <button className="link-btn" disabled={ro} onClick={() => void deleteAlias(a)}>
                    Delete
                  </button>{" "}
                  <button className="link-btn" onClick={() => void shell.copyText(a.arn)}>
                    Copy ARN
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="props-section">Versions</div>
      {v.versions.length === 0 ? (
        <p className="hint">No published versions. Executions run the latest definition.</p>
      ) : (
        <table className="sync-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Published</th>
              <th>Used by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {v.versions.map((ver) => {
              const users = v.aliases.filter((a) => a.routing.some((r) => r.versionArn === ver.arn)).map((a) => a.name);
              return (
                <tr key={ver.arn}>
                  <td>{ver.version}</td>
                  <td>{formatDate(ver.created)}</td>
                  <td>{users.join(", ")}</td>
                  <td className="right nowrap">
                    <button className="link-btn" disabled={ro} title={users.length ? `Used by ${users.join(", ")}` : ""} onClick={() => void deleteVersion(ver.arn, ver.version, users)}>
                      Delete
                    </button>{" "}
                    <button className="link-btn" onClick={() => void shell.copyText(ver.arn)}>
                      Copy ARN
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {aliasDialog && (
        <AliasDialog
          machine={m}
          versions={v}
          alias={aliasDialog.alias}
          onClose={() => setAliasDialog(null)}
          onDone={(msg) => {
            setAliasDialog(null);
            shell.showFlash(msg);
            reload();
          }}
        />
      )}
    </div>
  );
}

function AliasDialog({ machine, versions, alias, onClose, onDone }: { machine: MachineDetails; versions: Versions; alias: Alias | null; onClose: () => void; onDone: (msg: string) => void }) {
  const list = versions.versions;
  const [first, second] = alias ? [...alias.routing].sort((a, b) => b.weight - a.weight) : [];
  const [name, setName] = useState(alias?.name ?? "");
  const [description, setDescription] = useState(alias?.description ?? "");
  const [version, setVersion] = useState(first?.versionArn ?? list[0]?.arn ?? "");
  const [split, setSplit] = useState(!!second);
  const [other, setOther] = useState(second?.versionArn ?? list.find((x) => x.arn !== version)?.arn ?? "");
  const [share, setShare] = useState(String(second?.weight ?? 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pct = Number(share);
  const problem =
    (!alias && aliasNameProblem(name.trim())) ||
    (!version ? "Choose a version" : null) ||
    (split && (!other || other === version) ? "Choose a different second version" : null) ||
    (split && (!Number.isInteger(pct) || pct < 1 || pct > 99) ? "The second version's share is a whole number from 1 to 99%" : null) ||
    (description.length > 256 ? "The description is at most 256 characters" : null);
  const label = (arn: string) => `Version ${arn.slice(arn.lastIndexOf(":") + 1)}`;

  async function save() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const routing = split ? [{ versionArn: version, weight: 100 - pct }, { versionArn: other, weight: pct }] : [{ versionArn: version, weight: 100 }];
      await sfnApi.saveAlias({ machineArn: machine.arn, name: name.trim(), description: description.trim() || null, routing }, !!alias);
      onDone(alias ? `Updated alias ${name.trim()}.` : `Created alias ${name.trim()}.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">
          <DialogHelp topic="sfn.alias" />
          {alias ? `Edit alias ${alias.name}` : "New alias"}
        </div>
        <div className="dialog-body">
          <div className="pe-grid">
            <label className="form-label" htmlFor="sa-name">
              Name
            </label>
            <input id="sa-name" className="text-input mono" value={name} disabled={!!alias} autoFocus={!alias} onChange={(e) => setName(e.target.value)} />
            <label className="form-label" htmlFor="sa-ver">
              Version
            </label>
            <select id="sa-ver" className="text-input" value={version} onChange={(e) => setVersion(e.target.value)}>
              {list.map((x) => (
                <option key={x.arn} value={x.arn}>
                  {label(x.arn)} ({formatDate(x.created)})
                </option>
              ))}
            </select>
            <span />
            <label className="check-row">
              <input type="checkbox" checked={split} disabled={list.length < 2} onChange={(e) => setSplit(e.target.checked)} /> Send part of the executions to a second version{list.length < 2 ? " (needs two published versions)" : ""}
            </label>
            {split && (
              <>
                <label className="form-label" htmlFor="sa-other">
                  Second version
                </label>
                <select id="sa-other" className="text-input" value={other} onChange={(e) => setOther(e.target.value)}>
                  {list
                    .filter((x) => x.arn !== version)
                    .map((x) => (
                      <option key={x.arn} value={x.arn}>
                        {label(x.arn)}
                      </option>
                    ))}
                </select>
                <label className="form-label" htmlFor="sa-share">
                  Its share (%)
                </label>
                <div className="row">
                  <input id="sa-share" className="text-input num-input" inputMode="numeric" value={share} onChange={(e) => setShare(e.target.value)} />
                  {!problem && (
                    <span className="hint">
                      {label(version)} gets {100 - pct}%, {label(other)} gets {pct}%.
                    </span>
                  )}
                </div>
              </>
            )}
            <label className="form-label" htmlFor="sa-desc">
              Description
            </label>
            <input id="sa-desc" className="text-input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {problem && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" disabled={!!problem || busy} onClick={() => void save()}>
            {busy ? "Saving…" : alias ? "Save" : "Create"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
