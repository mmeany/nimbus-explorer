// Dialogs for instance actions: stop (hibernate / force), change instance
// type, termination and stop protection.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppError } from "../../api/core";
import { ec2Api, instanceLabel, typeText, type Instance, type InstanceDetails, type TypeInfo } from "../../api/ec2";
import { DialogHelp } from "../../components/HelpDialog";
import type { HelpTopicId } from "../../help";
import type { Shell } from "../../shell/shell";

export function Frame({ title, help, children, buttons, onClose }: { title: string; help: HelpTopicId; children: ReactNode; buttons: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">
          <DialogHelp topic={help} />
          {title}
        </div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-buttons">
          <div className="spacer" />
          {buttons}
        </div>
      </div>
    </div>
  );
}

const names = (list: Instance[]) => (list.length === 1 ? instanceLabel(list[0]) : `${list.length} instances`);

export function StopDialog({ instances, onClose, onDone }: { instances: Instance[]; onClose: () => void; onDone: (msg: string) => void }) {
  const canHibernate = instances.every((i) => i.hibernation);
  const [hibernate, setHibernate] = useState(false);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spot = instances.some((i) => i.lifecycle === "spot");
  const publicIps = instances.filter((i) => i.publicIp).length;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await ec2Api.stop(
        instances.map((i) => i.id),
        hibernate,
        force,
      );
      onDone(`${hibernate ? "Hibernating" : "Stopping"} ${names(instances)}.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <Frame
      title={`Stop ${names(instances)}`}
      help="ec2.instance.stop"
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary danger" disabled={busy} onClick={() => void run()}>
            {busy ? "Stopping…" : hibernate ? "Hibernate" : "Stop"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      {instances.length > 1 && <p className="mono hint">{instances.map((i) => instanceLabel(i)).join(", ")}</p>}
      <p>
        The instance{instances.length === 1 ? " shuts down" : "s shut down"}. EBS volumes keep their data; instance store disks lose theirs. You aren't charged for the instance while it's stopped, but you are for its volumes
        {publicIps ? " and any Elastic IPs" : ""}.
      </p>
      {publicIps > 0 && <p className="hint">Auto-assigned public IP addresses are released and change on the next start; Elastic IPs stay.</p>}
      {spot && <p className="warn-note">Some of these are Spot instances: only persistent Spot requests can be stopped.</p>}
      <label className="check-row" title={canHibernate ? "" : "Hibernation must be configured when an instance is launched"}>
        <input type="checkbox" checked={hibernate} disabled={!canHibernate} onChange={(e) => setHibernate(e.target.checked)} /> Hibernate (save memory to the root volume, so programs resume where they were)
        {!canHibernate && <span className="hint"> · not configured</span>}
      </label>
      <label className="check-row">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Force stop (skip the OS's clean shutdown: only for an instance stuck in stopping; unsaved data is lost)
      </label>
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}

export function ChangeTypeDialog({ instance, onClose, onDone }: { instance: Instance; onClose: () => void; onDone: (msg: string) => void }) {
  const [types, setTypes] = useState<TypeInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState(instance.instanceType ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!instance.az) return;
    ec2Api
      .instanceTypes(instance.az, instance.architecture === "arm64" ? "arm64" : instance.architecture ? "x86_64" : null)
      .then(setTypes)
      .catch((e) => setLoadError((e as AppError).message ?? String(e)));
  }, [instance.az, instance.architecture]);

  const family = (instance.instanceType ?? "").split(".")[0];
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = (types ?? []).filter((t) => (s ? t.name.includes(s) : t.currentGeneration !== false));
    // The current family first, so the nearest sizes are at hand.
    return [...list.filter((t) => t.name.startsWith(`${family}.`)), ...list.filter((t) => !t.name.startsWith(`${family}.`))];
  }, [types, search, family]);

  const valid = /^[a-z0-9-]+\.[a-z0-9-]+$/.test(picked.trim());
  const problem = !valid ? "Instance types look like t3.micro" : picked.trim() === instance.instanceType ? "That's the current type" : null;

  async function save() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await ec2Api.setType(instance.id, picked.trim());
      onDone(`${instanceLabel(instance)} is now ${picked.trim()}.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <Frame
      title={`Change the type of ${instanceLabel(instance)}`}
      help="ec2.instance.type"
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary" disabled={!!problem || busy} onClick={() => void save()}>
            {busy ? "Changing…" : "Change type"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p className="hint">
        Now <b>{instance.instanceType}</b>
        {instance.architecture ? ` · ${instance.architecture}` : ""} in {instance.az}. Types offered in that zone for that architecture are listed; older generations show when you search.
      </p>
      <div className="row">
        <input className="text-input" placeholder="Search types (e.g. m7i or large)" value={search} autoFocus spellCheck={false} onChange={(e) => setSearch(e.target.value)} />
        <input className="text-input mono" aria-label="Instance type" value={picked} spellCheck={false} onChange={(e) => setPicked(e.target.value)} />
      </div>
      {loadError ? (
        <p className="hint">The type list couldn't be loaded ({loadError}). Type an instance type instead.</p>
      ) : !types ? (
        <p className="hint">Loading instance types…</p>
      ) : (
        <select className="ec2-type-list" size={12} value={picked} onChange={(e) => setPicked(e.target.value)} onDoubleClick={() => void save()}>
          {shown.map((t) => (
            <option key={t.name} value={t.name}>
              {typeText(t)}
              {t.name === instance.instanceType ? "  (current)" : ""}
            </option>
          ))}
        </select>
      )}
      <p className="hint">The new type must support the instance's image: its architecture, virtualization and network adapter (ENA). AWS refuses types that don't.</p>
      {problem && picked.trim() !== instance.instanceType && <div className="field-error">{problem}</div>}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}

export function ProtectionDialog({ shell, instance, onClose, onDone }: { shell: Shell; instance: InstanceDetails; onClose: () => void; onDone: (msg: string) => void }) {
  const [term, setTerm] = useState(instance.terminationProtection ?? false);
  const [stop, setStop] = useState(instance.stopProtection ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const termChanged = instance.terminationProtection !== null && term !== instance.terminationProtection;
  const stopChanged = instance.stopProtection !== null && stop !== instance.stopProtection;
  const unknown = instance.terminationProtection === null || instance.stopProtection === null;

  async function save() {
    if (busy || (!termChanged && !stopChanged)) return;
    const off = [termChanged && !term ? "termination" : "", stopChanged && !stop ? "stop" : ""].filter(Boolean);
    if (off.length) {
      const ok = await shell.ask(
        "Turn protection off",
        <p>
          Turn {off.join(" and ")} protection off for <span className="mono">{instanceLabel(instance)}</span>? Anyone with permission can then {off.includes("termination") ? "terminate" : "stop"} it through the API, by mistake or by script.
        </p>,
        [
          { label: "Turn off", value: "yes", danger: true },
          { label: "Cancel", value: "no" },
        ],
        "no",
      );
      if (ok !== "yes") return;
    }
    setBusy(true);
    setError(null);
    try {
      await ec2Api.setProtection(instance.id, termChanged ? term : null, stopChanged ? stop : null);
      onDone(`Protection changed for ${instanceLabel(instance)}.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <Frame
      title={`Protection of ${instanceLabel(instance)}`}
      help="ec2.instance.protection"
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary" disabled={busy || (!termChanged && !stopChanged)} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <label className="check-row">
        <input type="checkbox" checked={term} disabled={instance.terminationProtection === null} onChange={(e) => setTerm(e.target.checked)} /> Termination protection: the instance can't be terminated through the API or console
      </label>
      <label className="check-row">
        <input type="checkbox" checked={stop} disabled={instance.stopProtection === null} onChange={(e) => setStop(e.target.checked)} /> Stop protection: the instance can't be stopped (or hibernated) through the API or console
      </label>
      <p className="hint">Neither stops a shutdown from inside the operating system, or Auto Scaling replacing the instance.</p>
      {unknown && <p className="hint">A setting that couldn't be read (ec2:DescribeInstanceAttribute) can't be changed here.</p>}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}
