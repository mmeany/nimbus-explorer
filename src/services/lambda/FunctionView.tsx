// One Lambda function: header, tabs (Details, Triggers, Versions and
// aliases, plus extra tabs from the controller such as Invoke and Logs).
import { useEffect, useState, type ReactNode } from "react";
import type { AppError } from "../../api/core";
import { lambdaApi, runtimeLabel, sourceLabel, type FunctionDetails, type Triggers, type Versions } from "../../api/lambda";
import { ErrorPanel } from "../../components/ErrorPanel";
import { ValueView } from "../../components/ValueView";
import { formatDate, formatSize } from "../../format";
import type { Shell } from "../../shell/shell";
import { AliasDialog, downloadCode, UploadCodeDialog } from "./LambdaDialogs";

export interface FunctionTab {
  id: string;
  label: string;
  /** `goTab` switches to another tab (e.g. Invoke → Logs). */
  render: (f: FunctionDetails, goTab: (id: string) => void) => ReactNode;
}

interface Props {
  name: string;
  shell: Shell;
  reloadToken: number;
  onLoaded: (f: FunctionDetails | null) => void;
  onOpenLogs: (group: string) => void;
  tabs?: FunctionTab[];
}

function Props_({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <table className="props-table">
      <tbody>
        {rows
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td className="selectable">{v}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

const stateTone = (s: string | null) => (s === "Active" || s === "Successful" ? "ok" : s === "Failed" ? "bad" : s === "Pending" || s === "InProgress" ? "busy" : "off");

export function FunctionView({ name, shell, reloadToken, onLoaded, onOpenLogs, tabs = [] }: Props) {
  const [data, setData] = useState<{ name: string; f: FunctionDetails | null; error: AppError | null } | null>(null);
  const [tab, setTab] = useState("details");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let stale = false;
    setData((d) => (d?.name === name ? d : { name, f: null, error: null }));
    lambdaApi
      .get(name)
      .then((f) => {
        if (stale) return;
        setData({ name, f, error: null });
        onLoaded(f);
      })
      .catch((e) => {
        if (stale) return;
        setData({ name, f: null, error: e as AppError });
        onLoaded(null);
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, reloadToken, tick]);

  // While a deployment or configuration change is in progress, check again every 5 s.
  const f = data?.name === name ? data.f : null;
  const changing = f && (f.state === "Pending" || f.lastUpdateStatus === "InProgress");
  useEffect(() => {
    if (!changing) return;
    const t = window.setTimeout(() => setTick((x) => x + 1), 5000);
    return () => window.clearTimeout(t);
  }, [changing, f]);

  if (data?.name === name && data.error) return <ErrorPanel error={data.error} profile={shell.profile} onRetry={() => setTick((x) => x + 1)} />;
  if (!f) return <div className="empty-note">Loading…</div>;
  const current = tabs.find((t) => t.id === tab);

  return (
    <div className="queue-view db-view">
      <div className="qv-head">
        <span className="qv-name">{f.name}</span>
        <span className={`status-pill ${stateTone(f.state)}`}>{f.state ?? "unknown"}</span>
        {f.lastUpdateStatus && f.lastUpdateStatus !== "Successful" && <span className={`status-pill ${stateTone(f.lastUpdateStatus)}`}>update {f.lastUpdateStatus.toLowerCase()}</span>}
        <span className="qbadge">{runtimeLabel(f.runtime, f.packageType)}</span>
        <div className="spacer" />
        <button className="link-btn" onClick={() => void shell.copyText(f.arn)}>
          Copy ARN
        </button>
      </div>
      {f.description && <div className="hint">{f.description}</div>}
      {(f.stateReason || f.lastUpdateReason) && f.state !== "Active" && <div className="warn-note">{f.stateReason ?? f.lastUpdateReason}</div>}
      <div className="segmented small db-tabs">
        {[{ id: "details", label: "Details" }, ...tabs, { id: "triggers", label: "Triggers" }, { id: "versions", label: "Versions and aliases" }].map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {current ? (
        current.render(f, setTab)
      ) : tab === "triggers" ? (
        <TriggersTab name={f.name} shell={shell} reloadToken={reloadToken} />
      ) : tab === "versions" ? (
        <VersionsTab name={f.name} shell={shell} reloadToken={reloadToken} />
      ) : (
        <Details f={f} shell={shell} onOpenLogs={onOpenLogs} onChanged={() => setTick((x) => x + 1)} />
      )}
    </div>
  );
}

function EnvVars({ f, shell }: { f: FunctionDetails; shell: Shell }) {
  // Values live only here, after Reveal, and go on Hide or when the view closes.
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValues(null), [f.name, f.revisionId]);
  if (!f.envKeys.length) return <p className="hint">No environment variables.</p>;
  async function reveal() {
    setBusy(true);
    try {
      setValues(await lambdaApi.envValues(f.name));
    } catch (e) {
      shell.showError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="row">
        <button className="btn small" disabled={busy} onClick={() => (values ? setValues(null) : void reveal())}>
          {values ? "Hide values" : busy ? "Loading…" : "Reveal values"}
        </button>
        <span className="hint">Values often hold secrets; they're fetched only when you reveal them.</span>
      </div>
      <table className="sync-table env-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {f.envKeys.map((k) => (
            <tr key={k}>
              <td className="mono">{k}</td>
              <td className="mono">{values ? (values[k] ?? "") : "••••••••"}</td>
              <td className="right">
                {values && (
                  <button className="link-btn" onClick={() => void shell.copyText(values[k] ?? "")}>
                    Copy
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {f.envError && <div className="warn-note">{f.envError}</div>}
    </>
  );
}

function CodeActions({ f, shell, onChanged }: { f: FunctionDetails; shell: Shell; onChanged: () => void }) {
  const [upload, setUpload] = useState(false);
  const image = f.packageType === "Image";
  return (
    <>
      <div className="props-section">Code</div>
      <div className="row">
        <button className="btn" disabled={image} title={image ? "Container image functions have no package" : "Save the .zip of $LATEST"} onClick={() => void downloadCode(shell, f.name, null)}>
          Download code…
        </button>
        <button className="btn" disabled={image || shell.readOnly} title={image ? "Container image functions are updated with a new image" : "Replace the code with a new .zip"} onClick={() => setUpload(true)}>
          Upload .zip…
        </button>
        {image && <span className="hint">Runs a container image; update it by pushing a new image and deploying it.</span>}
      </div>
      {upload && (
        <UploadCodeDialog
          f={f}
          onClose={() => setUpload(false)}
          onDone={(msg) => {
            setUpload(false);
            shell.showFlash(msg);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function Details({ f, shell, onOpenLogs, onChanged }: { f: FunctionDetails; shell: Shell; onOpenLogs: (g: string) => void; onChanged: () => void }) {
  const secs = (n: number | null) => (n === null ? "" : n >= 60 ? `${Math.floor(n / 60)} min ${n % 60 ? `${n % 60} s` : ""}`.trim() : `${n} s`);
  return (
    <div className="lambda-details">
      <Props_
        rows={[
          ["Runtime", runtimeLabel(f.runtime, f.packageType)],
          ["Handler", f.handler ? <span className="mono">{f.handler}</span> : null],
          ["Image", f.imageUri ? <span className="mono">{f.imageUri}</span> : null],
          ["Architecture", f.architecture],
          ["Memory", f.memoryMb !== null ? `${f.memoryMb.toLocaleString()} MB` : null],
          ["Timeout", secs(f.timeoutSecs)],
          ["Ephemeral storage", f.ephemeralStorageMb !== null ? `${f.ephemeralStorageMb.toLocaleString()} MB` : null],
          ["Code size", f.codeSize ? formatSize(f.codeSize) : null],
          ["Code SHA-256", f.codeSha256 ? <span className="mono">{f.codeSha256}</span> : null],
          ["Last modified", formatDate(f.lastModified)],
          ["Concurrency", f.reservedConcurrency === null ? "Unreserved (shares the account pool)" : f.reservedConcurrency === 0 ? "Reserved: 0 (the function is throttled; it can't run)" : `Reserved: ${f.reservedConcurrency.toLocaleString()}`],
          [
            "Execution role",
            f.role ? (
              <>
                <span className="mono">{f.role.split("/").pop()}</span>{" "}
                <button className="link-btn" onClick={() => void shell.copyText(f.role!)}>
                  Copy ARN
                </button>
              </>
            ) : null,
          ],
          [
            "Log group",
            <>
              <span className="mono">{f.logGroup}</span>{" "}
              <button className="link-btn" onClick={() => onOpenLogs(f.logGroup)}>
                Open in CloudWatch Logs
              </button>
            </>,
          ],
          ["Log format", f.logFormat],
          ["Tracing (X-Ray)", f.tracing === "Active" ? "Active" : f.tracing ? "Off" : null],
          ["SnapStart", f.snapStart],
          ["Encryption key", f.kmsKey ? <span className="mono">{f.kmsKey}</span> : null],
          ["Dead-letter queue", f.deadLetterTarget ? <span className="mono">{f.deadLetterTarget}</span> : null],
        ]}
      />

      <CodeActions f={f} shell={shell} onChanged={onChanged} />

      <div className="props-section">Environment variables</div>
      <EnvVars f={f} shell={shell} />

      <div className="props-section">Function URL</div>
      {f.url ? (
        <>
          <Props_
            rows={[
              [
                "URL",
                <>
                  <span className="mono">{f.url.url}</span>{" "}
                  <button className="link-btn" onClick={() => void shell.copyText(f.url!.url)}>
                    Copy
                  </button>
                </>,
              ],
              ["Authentication", f.url.authType === "NONE" ? <span className="danger-text">None: anyone with the URL can call it</span> : "AWS IAM"],
              ["Invoke mode", f.url.invokeMode === "RESPONSE_STREAM" ? "Response streaming" : f.url.invokeMode ? "Buffered" : null],
            ]}
          />
          {f.url.cors ? (
            <details className="qv-raw">
              <summary>CORS</summary>
              <ValueView value={JSON.stringify(f.url.cors, null, 2)} />
            </details>
          ) : null}
        </>
      ) : (
        <p className="hint">No function URL.</p>
      )}

      {f.invokeConfig && (
        <>
          <div className="props-section">Asynchronous invocation</div>
          <Props_
            rows={[
              ["Retry attempts", f.invokeConfig.maxRetries !== null ? String(f.invokeConfig.maxRetries) : "2 (default)"],
              ["Maximum event age", f.invokeConfig.maxAgeSecs !== null ? secs(f.invokeConfig.maxAgeSecs) : "6 hours (default)"],
              ["On success", f.invokeConfig.onSuccess ? <span className="mono">{f.invokeConfig.onSuccess}</span> : null],
              ["On failure", f.invokeConfig.onFailure ? <span className="mono">{f.invokeConfig.onFailure}</span> : null],
            ]}
          />
        </>
      )}

      {f.layers.length > 0 && (
        <>
          <div className="props-section">Layers</div>
          <table className="sync-table">
            <thead>
              <tr>
                <th>Layer</th>
                <th>Version</th>
                <th className="right">Size</th>
              </tr>
            </thead>
            <tbody>
              {f.layers.map((l) => {
                const p = l.arn.split(":");
                return (
                  <tr key={l.arn} title={l.arn}>
                    <td className="mono">{p[6] ?? l.arn}</td>
                    <td>{p[7] ?? ""}</td>
                    <td className="right">{formatSize(l.codeSize)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {f.vpc && (
        <>
          <div className="props-section">VPC</div>
          <Props_
            rows={[
              ["VPC", f.vpc.vpcId],
              ["Subnets", f.vpc.subnets.join(", ")],
              ["Security groups", f.vpc.securityGroups.join(", ")],
            ]}
          />
        </>
      )}

      <div className="props-section">Tags</div>
      {f.tags.length ? <Props_ rows={f.tags.map(([k, v]) => [k, v] as [string, ReactNode])} /> : <p className="hint">No tags.</p>}
      <p className="mono selectable hint">{f.arn}</p>
    </div>
  );
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: AppError | null; retry: () => void } {
  const [state, setState] = useState<{ data: T | null; error: AppError | null }>({ data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stale = false;
    setState({ data: null, error: null });
    load()
      .then((data) => !stale && setState({ data, error: null }))
      .catch((e) => !stale && setState({ data: null, error: e as AppError }));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, retry: () => setTick((t) => t + 1) };
}

function TriggersTab({ name, shell, reloadToken }: { name: string; shell: Shell; reloadToken: number }) {
  const { data, error, retry } = useLoad<Triggers>(() => lambdaApi.triggers(name), [name, reloadToken]);
  async function toggle(uuid: string, enable: boolean) {
    if (!enable) {
      const ok = await shell.ask("Disable trigger", <p>Lambda stops reading from this source until you enable it again. Messages and records wait in the source meanwhile (until they expire).</p>, [
        { label: "Disable", value: "yes", danger: true },
        { label: "Cancel", value: "no" },
      ], "no");
      if (ok !== "yes") return;
    }
    try {
      await lambdaApi.setMappingEnabled(uuid, enable);
      shell.showFlash(enable ? "Enabling the trigger; it takes a few seconds." : "Disabling the trigger; it takes a few seconds.");
    } catch (e) {
      shell.showError(e);
    } finally {
      retry();
    }
  }
  if (error) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!data) return <p className="hint">Loading…</p>;
  return (
    <div className="lambda-details">
      <div className="props-section">Event sources (polled by Lambda)</div>
      {data.mappings.length === 0 ? (
        <p className="hint">None. Queues and streams that Lambda reads from appear here.</p>
      ) : (
        <div className="sync-table-wrap">
          <table className="sync-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Name</th>
                <th>State</th>
                <th className="right">Batch</th>
                <th className="right">Window</th>
                <th>Last result</th>
                <th>Last modified</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.mappings.map((m) => {
                const s = sourceLabel(m.sourceArn);
                return (
                  <tr key={m.uuid} title={m.sourceArn ?? ""}>
                    <td>{s.service}</td>
                    <td className="mono">{s.name}</td>
                    <td>{m.state}</td>
                    <td className="right">{m.batchSize ?? ""}</td>
                    <td className="right">{m.batchingWindowSecs ? `${m.batchingWindowSecs} s` : ""}</td>
                    <td className="muted">{m.lastResult ?? ""}</td>
                    <td>{formatDate(m.lastModified)}</td>
                    <td className="right">
                      {(m.state === "Enabled" || m.state === "Disabled") && (
                        <button className="link-btn" disabled={shell.readOnly} onClick={() => void toggle(m.uuid, m.state !== "Enabled")}>
                          {m.state === "Enabled" ? "Disable" : "Enable"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="props-section">Allowed to invoke (resource policy)</div>
      {data.invokers.length === 0 ? (
        <p className="hint">No resource policy. Services such as S3, SNS, EventBridge and API Gateway need a statement here to invoke the function.</p>
      ) : (
        <div className="sync-table-wrap">
          <table className="sync-table">
            <thead>
              <tr>
                <th>Principal</th>
                <th>Source</th>
                <th>Account</th>
                <th>Action</th>
                <th>Statement</th>
              </tr>
            </thead>
            <tbody>
              {data.invokers.map((i, n) => {
                const s = sourceLabel(i.sourceArn);
                return (
                  <tr key={`${i.sid}-${n}`} title={i.sourceArn ?? ""}>
                    <td className="mono">{i.principal}</td>
                    <td className="mono">{i.sourceArn ? `${s.service} ${s.name}` : ""}</td>
                    <td>{i.sourceAccount ?? ""}</td>
                    <td>{i.action}</td>
                    <td className="muted">{i.sid}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data.policy && (
        <details className="qv-raw">
          <summary>Resource policy JSON</summary>
          <ValueView value={JSON.stringify(JSON.parse(data.policy), null, 2)} />
        </details>
      )}
    </div>
  );
}

function VersionsTab({ name, shell, reloadToken }: { name: string; shell: Shell; reloadToken: number }) {
  const { data, error, retry } = useLoad<Versions>(() => lambdaApi.versions(name), [name, reloadToken]);
  const [aliasDialog, setAliasDialog] = useState<{ alias: Versions["aliases"][number] | null } | null>(null);
  const ro = shell.readOnly;
  async function publish() {
    const desc = await shell.askName("Publish version", "Description (optional)", "", "Publish", (v) => (v.length > 256 ? "At most 256 characters" : null));
    if (desc === null) return;
    try {
      const v = await lambdaApi.publishVersion(name, desc);
      shell.showFlash(`Published version ${v}.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      retry();
    }
  }
  async function deleteAlias(alias: string) {
    const ok = await shell.ask("Delete alias", <p>Delete alias <span className="mono">{alias}</span>? Anything that calls the function through it (triggers, URLs, other services) will start failing.</p>, [
      { label: "Delete", value: "yes", danger: true },
      { label: "Cancel", value: "no" },
    ], "no");
    if (ok !== "yes") return;
    try {
      await lambdaApi.deleteAlias(name, alias);
      shell.showFlash(`Deleted alias ${alias}.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      retry();
    }
  }
  async function deleteVersion(version: string) {
    const used = data?.aliases.filter((a) => a.version === version || a.routing.some(([v]) => v === version)).map((a) => a.name) ?? [];
    if (used.length) return shell.showFlash(`Version ${version} is used by alias ${used.join(", ")}; change the alias first.`);
    const ok = await shell.confirmTyped("Delete version", <p>Version {version} of <span className="mono">{name}</span> will be deleted. Its code and settings can't be recovered.</p>, version, "Delete version");
    if (!ok) return;
    try {
      await lambdaApi.deleteVersion(name, version);
      shell.showFlash(`Deleted version ${version}.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      retry();
    }
  }
  if (error) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!data) return <p className="hint">Loading…</p>;
  const pct = (w: number) => `${Math.round(w * 1000) / 10}%`;
  return (
    <div className="lambda-details">
      <div className="row">
        <button className="btn" disabled={ro} title="Freeze the current code and settings ($LATEST) as a numbered version" onClick={() => void publish()}>
          Publish version…
        </button>
        <button className="btn" disabled={ro} onClick={() => setAliasDialog({ alias: null })}>
          New alias…
        </button>
      </div>
      {aliasDialog && (
        <AliasDialog
          fn={name}
          versions={data}
          alias={aliasDialog.alias}
          onClose={() => setAliasDialog(null)}
          onDone={(msg) => {
            setAliasDialog(null);
            shell.showFlash(msg);
            retry();
          }}
        />
      )}
      <div className="props-section">Aliases</div>
      {data.aliases.length === 0 ? (
        <p className="hint">No aliases.</p>
      ) : (
        <div className="sync-table-wrap">
          <table className="sync-table">
            <thead>
              <tr>
                <th>Alias</th>
                <th>Version</th>
                <th>Traffic</th>
                <th>Description</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.aliases.map((a) => {
                const extra = a.routing.reduce((t, [, w]) => t + w, 0);
                return (
                  <tr key={a.name} title={a.arn}>
                    <td className="mono">{a.name}</td>
                    <td>{a.version}</td>
                    <td>{a.routing.length ? [`${pct(1 - extra)} → ${a.version}`, ...a.routing.map(([v, w]) => `${pct(w)} → ${v}`)].join(", ") : "100%"}</td>
                    <td className="muted">{a.description ?? ""}</td>
                    <td className="right">
                      <button className="link-btn" disabled={ro} onClick={() => setAliasDialog({ alias: a })}>
                        Edit…
                      </button>
                      <button className="link-btn" disabled={ro} onClick={() => void deleteAlias(a.name)}>
                        Delete…
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="props-section">Versions</div>
      <div className="sync-table-wrap">
        <table className="sync-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Description</th>
              <th>Last modified</th>
              <th>Code SHA-256</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.versions.map((v) => (
              <tr key={v.version}>
                <td>{v.version === "$LATEST" ? "$LATEST (unpublished)" : v.version}</td>
                <td className="muted">{v.description ?? ""}</td>
                <td>{formatDate(v.lastModified)}</td>
                <td className="mono muted">{v.codeSha256 ? `${v.codeSha256.slice(0, 12)}…` : ""}</td>
                <td className="right">
                  <button className="link-btn" onClick={() => void downloadCode(shell, name, v.version === "$LATEST" ? null : v.version)}>
                    Download
                  </button>
                  {v.version !== "$LATEST" && (
                    <button className="link-btn" disabled={ro} onClick={() => void deleteVersion(v.version)}>
                      Delete…
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.provisioned.length > 0 && (
        <>
          <div className="props-section">Provisioned concurrency</div>
          <table className="sync-table">
            <thead>
              <tr>
                <th>Alias / version</th>
                <th className="right">Requested</th>
                <th className="right">Allocated</th>
                <th className="right">Available</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.provisioned.map((p) => (
                <tr key={p.qualifier}>
                  <td className="mono">{p.qualifier}</td>
                  <td className="right">{p.requested ?? ""}</td>
                  <td className="right">{p.allocated ?? ""}</td>
                  <td className="right">{p.available ?? ""}</td>
                  <td>{p.status ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
