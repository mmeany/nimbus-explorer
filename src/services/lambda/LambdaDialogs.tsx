// Dialogs that change a Lambda function: settings (description, memory,
// timeout, environment variables, reserved concurrency) and aliases.
import { useEffect, useState } from "react";
import type { AppError } from "../../api/core";
import { envKeyProblem, lambdaApi, type FunctionDetails, type Versions } from "../../api/lambda";
import { api } from "../../api/s3";
import { formatSize } from "../../format";

function Frame({ title, children, buttons, onClose, wide }: { title: string; children: React.ReactNode; buttons: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`dialog param-dialog ${wide ? "dialog-wide" : ""}`} role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-buttons">
          <div className="spacer" />
          {buttons}
        </div>
      </div>
    </div>
  );
}

type Reserve = "none" | "some" | "zero";

export function FunctionSettingsDialog({ f, onClose, onDone }: { f: FunctionDetails; onClose: () => void; onDone: (msg: string) => void }) {
  const [description, setDescription] = useState(f.description ?? "");
  const [memory, setMemory] = useState(String(f.memoryMb ?? 128));
  const [timeout, setTimeout_] = useState(String(f.timeoutSecs ?? 3));
  // Values are loaded when the dialog opens and dropped when it closes.
  const [env, setEnv] = useState<[string, string][] | null>(f.envKeys.length ? null : []);
  const [initialEnv, setInitialEnv] = useState<Record<string, string>>({});
  const [reserve, setReserve] = useState<Reserve>(f.reservedConcurrency === null ? "none" : f.reservedConcurrency === 0 ? "zero" : "some");
  const [reserved, setReserved] = useState(String(f.reservedConcurrency || 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!f.envKeys.length) return;
    let stale = false;
    lambdaApi
      .envValues(f.name)
      .then((v) => {
        if (stale) return;
        setInitialEnv(v);
        setEnv(Object.entries(v));
      })
      .catch((e) => !stale && setError((e as AppError).message ?? String(e)));
    return () => {
      stale = true;
    };
  }, [f.name, f.envKeys.length]);

  const mem = Number(memory);
  const to = Number(timeout);
  const envMap = env ? Object.fromEntries(env.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])) : null;
  const dupKey = env && new Set(env.map(([k]) => k.trim()).filter(Boolean)).size !== env.filter(([k]) => k.trim()).length;
  const envChanged = envMap !== null && JSON.stringify(Object.entries(envMap).sort()) !== JSON.stringify(Object.entries(initialEnv).sort());
  const wantReserved = reserve === "none" ? null : reserve === "zero" ? 0 : Number(reserved);
  const concurrencyChanged = wantReserved !== f.reservedConcurrency;
  const configChanged = description !== (f.description ?? "") || mem !== f.memoryMb || to !== f.timeoutSecs || envChanged;

  const problem = !/^\d+$/.test(memory) || mem < 128 || mem > 10240
    ? "Memory is 128 to 10,240 MB"
    : !/^\d+$/.test(timeout) || to < 1 || to > 900
      ? "Timeout is 1 to 900 seconds"
      : description.length > 256
        ? "Descriptions are at most 256 characters"
        : dupKey
          ? "Each environment variable name can appear once"
          : (env ?? []).map(([k]) => (k.trim() ? envKeyProblem(k.trim()) : null)).find(Boolean) ??
            (reserve === "some" && (!/^\d+$/.test(reserved) || Number(reserved) < 1) ? "Reserve at least 1, or choose another option" : null) ??
            (!configChanged && !concurrencyChanged ? "Nothing changed yet" : null);

  async function save() {
    if (problem || busy || env === null) return;
    setBusy(true);
    setError(null);
    try {
      if (configChanged) {
        await lambdaApi.updateConfig(f.name, {
          description: description !== (f.description ?? "") ? description : null,
          memoryMb: mem !== f.memoryMb ? mem : null,
          timeoutSecs: to !== f.timeoutSecs ? to : null,
          env: envChanged ? envMap : null,
          revisionId: f.revisionId,
        });
      }
      if (concurrencyChanged) await lambdaApi.setConcurrency(f.name, wantReserved);
      onDone(`Saved ${f.name}. New settings apply to the next invocations.`);
    } catch (e) {
      const msg = (e as AppError).message ?? String(e);
      setError(/PreconditionFailed|revision/i.test(msg) ? "The function changed since you opened this. Close, refresh and try again." : msg);
      setBusy(false);
    }
  }

  return (
    <Frame
      title={`Settings: ${f.name}`}
      wide
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary" disabled={!!problem || busy || env === null} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className="pe-grid">
        <label className="form-label" htmlFor="fs-desc">
          Description
        </label>
        <input id="fs-desc" className="text-input" value={description} onChange={(e) => setDescription(e.target.value)} />
        <label className="form-label" htmlFor="fs-mem">
          Memory
        </label>
        <div className="row">
          <input id="fs-mem" className="text-input num-input" value={memory} onChange={(e) => setMemory(e.target.value)} />
          <span className="hint">MB (128 to 10,240; CPU grows with memory)</span>
        </div>
        <label className="form-label" htmlFor="fs-to">
          Timeout
        </label>
        <div className="row">
          <input id="fs-to" className="text-input num-input" value={timeout} onChange={(e) => setTimeout_(e.target.value)} />
          <span className="hint">seconds (1 to 900)</span>
        </div>
      </div>

      <div className="props-section">Environment variables</div>
      {env === null ? (
        <p className="hint">Loading values…</p>
      ) : (
        <div className="env-editor">
          {env.map(([k, v], i) => (
            <div key={i} className="row">
              <input
                className="text-input mono env-key"
                placeholder="NAME"
                value={k}
                spellCheck={false}
                aria-label="Variable name"
                onChange={(e) => setEnv(env.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))}
              />
              <input
                className="text-input mono env-value"
                placeholder="value"
                value={v}
                spellCheck={false}
                aria-label="Value"
                onChange={(e) => setEnv(env.map((x, j) => (j === i ? [x[0], e.target.value] : x)))}
              />
              <button className="link-btn" title="Remove" onClick={() => setEnv(env.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <div className="row">
            <button className="btn small" onClick={() => setEnv([...env, ["", ""]])}>
              Add variable
            </button>
            <span className="hint">Saved together, replacing the current set (4 KB in total).</span>
          </div>
        </div>
      )}

      <div className="props-section">Reserved concurrency</div>
      <fieldset className="radio-group">
        <label>
          <input type="radio" checked={reserve === "none"} onChange={() => setReserve("none")} /> Unreserved (shares the account's pool)
        </label>
        <label>
          <input type="radio" checked={reserve === "some"} onChange={() => setReserve("some")} /> Reserve{" "}
          <input className="text-input num-input" value={reserved} disabled={reserve !== "some"} onChange={(e) => setReserved(e.target.value)} aria-label="Reserved concurrency" /> concurrent
          executions (also the most it can run at once)
        </label>
        <label>
          <input type="radio" checked={reserve === "zero"} onChange={() => setReserve("zero")} /> 0: stop the function running (every invocation is throttled)
        </label>
      </fieldset>
      {problem && problem !== "Nothing changed yet" && <div className="field-error">{problem}</div>}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}

export function AliasDialog({
  fn,
  versions,
  alias,
  onClose,
  onDone,
}: {
  fn: string;
  versions: Versions;
  /** null = new alias. */
  alias: Versions["aliases"][number] | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const published = versions.versions.filter((v) => v.version !== "$LATEST").map((v) => v.version);
  const [name, setName] = useState(alias?.name ?? "");
  const [version, setVersion] = useState(alias?.version ?? published[0] ?? "$LATEST");
  const [description, setDescription] = useState(alias?.description ?? "");
  const [split, setSplit] = useState(!!alias?.routing.length);
  const [extra, setExtra] = useState(alias?.routing[0]?.[0] ?? published.find((v) => v !== version) ?? "");
  const [pct, setPct] = useState(alias?.routing[0] ? String(Math.round(alias.routing[0][1] * 1000) / 10) : "10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const share = Number(pct);
  const problem = !name.trim()
    ? "Enter a name"
    : !/^[A-Za-z0-9_-]+$/.test(name.trim()) || /^\d+$/.test(name.trim())
      ? "Alias names use letters, digits, - and _ (and can't be only digits)"
      : split && (!extra || extra === version)
        ? "Choose a different second version"
        : split && (version === "$LATEST" || extra === "$LATEST")
          ? "Traffic can only be split between published versions"
          : split && (!(share > 0) || share >= 100)
            ? "The second version's share is between 0 and 100%"
            : null;

  async function save() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await lambdaApi.saveAlias(fn, { alias: name.trim(), version, description: description.trim() || null, extra: split ? [extra, share / 100] : null }, !!alias);
      onDone(alias ? `Updated alias ${name.trim()}.` : `Created alias ${name.trim()}.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <Frame
      title={alias ? `Edit alias ${alias.name}` : "New alias"}
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary" disabled={!!problem || busy} onClick={() => void save()}>
            {busy ? "Saving…" : alias ? "Save" : "Create"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className="pe-grid">
        <label className="form-label" htmlFor="al-name">
          Name
        </label>
        <input id="al-name" className="text-input mono" value={name} disabled={!!alias} autoFocus={!alias} onChange={(e) => setName(e.target.value)} />
        <label className="form-label" htmlFor="al-ver">
          Version
        </label>
        <select id="al-ver" className="text-input" value={version} onChange={(e) => setVersion(e.target.value)}>
          {published.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
          <option value="$LATEST">$LATEST (unpublished; changes with every edit)</option>
        </select>
        <label className="form-label" htmlFor="al-desc">
          Description
        </label>
        <input id="al-desc" className="text-input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={split} disabled={published.length < 2} onChange={(e) => setSplit(e.target.checked)} /> Send part of the traffic to
        another version (gradual rollout){published.length < 2 ? " (needs two published versions)" : ""}
      </label>
      {split && (
        <div className="row">
          <input className="text-input num-input" value={pct} aria-label="Share" onChange={(e) => setPct(e.target.value)} />
          <span>% to version</span>
          <select className="text-input" value={extra} aria-label="Second version" onChange={(e) => setExtra(e.target.value)}>
            {published
              .filter((v) => v !== version)
              .map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
          </select>
          <span className="hint">
            the rest ({share > 0 && share < 100 ? `${Math.round((100 - share) * 10) / 10}%` : "…"}) to {version}
          </span>
        </div>
      )}
      {problem && name && <div className="field-error">{problem}</div>}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}

/** Saves a function's package ($LATEST or a version) with a save dialog. */
export async function downloadCode(shell: import("../../shell/shell").Shell, name: string, qualifier: string | null) {
  try {
    const dest = await api.pickSaveFile(`${name}${qualifier ? `-${qualifier}` : ""}.zip`);
    if (!dest) return;
    shell.setWorking(`Downloading the code of ${name}…`);
    const n = await lambdaApi.downloadCode(name, qualifier, dest);
    shell.showFlash(`Saved ${formatSize(n)} to ${dest}`);
  } catch (e) {
    shell.showError(e);
  } finally {
    shell.setWorking(null);
  }
}

export function UploadCodeDialog({ f, onClose, onDone }: { f: FunctionDetails; onClose: () => void; onDone: (msg: string) => void }) {
  const [kind, setKind] = useState<"zip" | "s3">("zip");
  const [path, setPath] = useState("");
  const [bucket, setBucket] = useState("");
  const [key, setKey] = useState("");
  const [version, setVersion] = useState("");
  const [publish, setPublish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = kind === "zip" ? (!path ? "Choose a .zip file" : null) : !bucket.trim() || !key.trim() ? "Enter the bucket and key of the .zip" : null;

  async function choose() {
    const p = await api.pickOpenFile("Choose the deployment package", "Zip files", ["zip"]);
    if (p) setPath(p);
  }

  async function upload() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await lambdaApi.uploadCode({
        name: f.name,
        source: kind === "zip" ? { kind: "zip", path } : { kind: "s3", bucket: bucket.trim(), key: key.trim(), version: version.trim() || null },
        publish,
        revisionId: f.revisionId,
      });
      onDone(`Uploaded new code to ${f.name} (${formatSize(r.codeSize)})${r.version ? `, published as version ${r.version}` : ""}. It's live for $LATEST once the update finishes.`);
    } catch (e) {
      const msg = (e as AppError).message ?? String(e);
      setError(/PreconditionFailed|revision/i.test(msg) ? "The function changed since you opened this. Close, refresh and try again." : msg);
      setBusy(false);
    }
  }

  return (
    <Frame
      title={`Upload code: ${f.name}`}
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary" disabled={!!problem || busy} onClick={() => void upload()}>
            {busy ? "Uploading…" : "Upload"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p>
        Replaces the code of <span className="mono">$LATEST</span>. Aliases pointing at published versions keep running their code until you move them.
      </p>
      <fieldset className="radio-group">
        <label>
          <input type="radio" checked={kind === "zip"} onChange={() => setKind("zip")} /> A .zip on this computer (up to 50 MB)
        </label>
        {kind === "zip" && (
          <div className="row">
            <button className="btn small" onClick={() => void choose()}>
              Choose file…
            </button>
            <span className="mono hint">{path || "No file chosen"}</span>
          </div>
        )}
        <label>
          <input type="radio" checked={kind === "s3"} onChange={() => setKind("s3")} /> A .zip in S3 (any size up to Lambda's limit; same region as the function)
        </label>
        {kind === "s3" && (
          <div className="pe-grid">
            <label className="form-label" htmlFor="uc-b">
              Bucket
            </label>
            <input id="uc-b" className="text-input mono" value={bucket} spellCheck={false} onChange={(e) => setBucket(e.target.value)} />
            <label className="form-label" htmlFor="uc-k">
              Key
            </label>
            <input id="uc-k" className="text-input mono" value={key} spellCheck={false} placeholder="builds/function.zip" onChange={(e) => setKey(e.target.value)} />
            <label className="form-label" htmlFor="uc-v">
              Object version
            </label>
            <input id="uc-v" className="text-input mono" value={version} spellCheck={false} placeholder="(latest)" onChange={(e) => setVersion(e.target.value)} />
          </div>
        )}
      </fieldset>
      <label className="check-row">
        <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Also publish it as a new version
      </label>
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}
