// Read-only instance tabs: status checks and scheduled events, the console
// (output or screenshot) and user data (masked until revealed).
import { useState } from "react";
import { ec2Api, userDataText, type Check, type InstanceDetails } from "../../api/ec2";
import { ErrorPanel } from "../../components/ErrorPanel";
import { MaskedValue } from "../../components/MaskedValue";
import { NumberedText } from "../../components/NumberedText";
import { ValueView } from "../../components/ValueView";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";
import { useLineNumbers } from "../../state/lineNumbers";
import { store, stored, useLoad } from "./common";

const CHECK_NAMES: Record<string, string> = { reachability: "Reachability" };

function CheckRow({ label, check, about }: { label: string; check: Check | null; about: string }) {
  const tone = check?.status === "ok" ? "ok" : check?.status === "impaired" ? "bad" : check?.status === "initializing" ? "busy" : "off";
  return (
    <tr>
      <th>{label}</th>
      <td>
        {check ? <span className={`status-pill ${tone}`}>{check.status ?? "unknown"}</span> : <span className="hint">not reported</span>}
        {check?.details
          .filter((d) => d.status !== "passed")
          .map((d) => (
            <span key={d.name} className="hint">
              {" "}
              · {CHECK_NAMES[d.name] ?? d.name}: {d.status}
              {d.impairedSince ? ` since ${formatDate(d.impairedSince)}` : ""}
            </span>
          ))}
        <div className="hint">{about}</div>
      </td>
    </tr>
  );
}

export function StatusTab({ shell, i }: { shell: Shell; i: InstanceDetails }) {
  const { data: s, error, retry } = useLoad(`${i.id}|${i.state}`, () => ec2Api.status(i.id), (d) => (d && (d.system?.status === "initializing" || d.instance?.status === "initializing") ? 15_000 : null));
  if (error && !s) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!s) return <div className="empty-note">Loading…</div>;
  const running = s.state === "running";
  return (
    <div className="lambda-details">
      <div className="row">
        <button className="btn" onClick={retry}>
          Check again
        </button>
        {!running && <span className="hint">Status checks run only while the instance is running.</span>}
      </div>
      <div className="props-section">Status checks</div>
      <table className="props-table">
        <tbody>
          <CheckRow label="System" check={s.system} about="AWS's side: the host, its network and power. If it fails, stop and start the instance to move it to another host." />
          <CheckRow label="Instance" check={s.instance} about="Your side: the operating system answers and its network is set up. If it fails, look at the console output or screenshot." />
          <CheckRow label="Attached EBS" check={s.ebs} about="The instance can reach its EBS volumes and they complete I/O." />
        </tbody>
      </table>
      <div className="props-section">Scheduled events</div>
      {s.events.length === 0 ? (
        <p className="hint">No scheduled events.</p>
      ) : (
        <table className="sync-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Description</th>
              <th>Not before</th>
              <th>Not after</th>
              <th>Latest reschedule</th>
            </tr>
          </thead>
          <tbody>
            {s.events.map((e, n) => (
              <tr key={e.id ?? n}>
                <td>{e.code ?? ""}</td>
                <td>{e.description ?? ""}</td>
                <td>{formatDate(e.notBefore)}</td>
                <td>{formatDate(e.notAfter)}</td>
                <td>{formatDate(e.deadline)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

type ConsoleMode = "output" | "screenshot";

export function ConsoleTab({ shell, i }: { shell: Shell; i: InstanceDetails }) {
  const [mode, setModeState] = useState<ConsoleMode>(() => stored("ec2.console.mode", ["output", "screenshot"] as const, "output"));
  const setMode = (m: ConsoleMode) => {
    setModeState(m);
    store("ec2.console.mode", m);
  };
  return (
    <div className="lambda-details">
      <div className="segmented small">
        <button className={mode === "output" ? "active" : ""} onClick={() => setMode("output")}>
          Output
        </button>
        <button className={mode === "screenshot" ? "active" : ""} onClick={() => setMode("screenshot")}>
          Screenshot
        </button>
      </div>
      {mode === "output" ? <ConsoleText shell={shell} id={i.id} /> : <Screenshot shell={shell} id={i.id} state={i.state} />}
    </div>
  );
}

function ConsoleText({ shell, id }: { shell: Shell; id: string }) {
  const [tick, setTick] = useState(0);
  const [wrap, setWrap] = useState(false);
  const [lineNumbers, setLineNumbers] = useLineNumbers();
  const { data, error, retry } = useLoad(`${id}|${tick}`, () => ec2Api.consoleOutput(id, true));
  return (
    <>
      <div className="row value-view-bar">
        <button className="btn" onClick={() => setTick((t) => t + 1)}>
          Refresh
        </button>
        <button className="btn" disabled={!data?.text} onClick={() => data && void shell.copyText(data.text)}>
          Copy
        </button>
        <label className="check">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap lines
        </label>
        <label className="check">
          <input type="checkbox" checked={lineNumbers} onChange={(e) => setLineNumbers(e.target.checked)} /> Line numbers
        </label>
        {data && <span className="hint">{data.captured ? `Captured ${formatDate(data.captured)}` : ""}{data.latest ? " · latest output" : " · last saved buffer (this instance type can't return the latest)"}</span>}
      </div>
      {error && !data ? (
        <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />
      ) : !data ? (
        <div className="empty-note">Loading…</div>
      ) : data.text ? (
        <NumberedText className={`value-text ec2-console${wrap ? "" : " nowrap"}`} wrap={wrap} text={data.text} />
      ) : (
        <p className="hint">No console output yet. AWS saves it shortly after boot and on stop; a new instance may take a few minutes.</p>
      )}
    </>
  );
}

function Screenshot({ shell, id, state }: { shell: Shell; id: string; state: string | null }) {
  const [tick, setTick] = useState(0);
  const { data, error, retry } = useLoad(`${id}|${tick}`, () => ec2Api.screenshot(id));
  return (
    <>
      <div className="row value-view-bar">
        <button className="btn" onClick={() => setTick((t) => t + 1)}>
          Take another
        </button>
        <span className="hint">A picture of the instance's screen, as a monitor plugged into it would show.</span>
      </div>
      {error && !data ? (
        state !== "running" ? <p className="hint">Screenshots need a running instance.</p> : <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />
      ) : !data ? (
        <div className="empty-note">Loading…</div>
      ) : (
        <img className="ec2-screenshot" src={data} alt={`Screen of ${id}`} />
      )}
    </>
  );
}

export function UserDataTab({ shell, i }: { shell: Shell; i: InstanceDetails }) {
  return (
    <div className="lambda-details">
      <p className="hint">The script or cloud-init configuration given to the instance at launch. It often contains passwords or keys, so it stays hidden until you reveal it, and is never saved by the app.</p>
      <MaskedValue
        load={async () => userDataText(await ec2Api.userData(i.id))}
        onError={shell.showError}
        onCopied={() => shell.showFlash("User data copied.")}
        renderRevealed={(v) => <ValueView value={v} />}
      />
    </div>
  );
}
