// Edit any EC2 resource's tags; create an image (AMI) from an instance;
// snapshot an instance's volumes or one volume.
import { useState } from "react";
import type { AppError } from "../../api/core";
import { ec2Api, instanceLabel, tagProblem, type Instance } from "../../api/ec2";
import { Frame } from "./InstanceDialogs";

type Pair = [string, string];

export function TagEditorDialog({ resource, label, tags, onClose, onDone }: { resource: string; label: string; tags: Pair[]; onClose: () => void; onDone: (msg: string) => void }) {
  const fixed = tags.filter(([k]) => k.startsWith("aws:"));
  const [rows, setRows] = useState<Pair[]>(() => {
    const own = tags.filter(([k]) => !k.startsWith("aws:"));
    return own.length ? own : [["", ""]];
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const desired = rows.filter(([k, v]) => k.trim() || v.trim()).map(([k, v]) => [k.trim(), v] as Pair);
  const own = tags.filter(([k]) => !k.startsWith("aws:"));
  const same = desired.length === own.length && desired.every(([k, v]) => own.some(([ok, ov]) => ok === k && ov === v));
  const problem = tagProblem(desired);

  const set = (n: number, part: 0 | 1, value: string) => setRows((r) => r.map((p, i) => (i === n ? ((part === 0 ? [value, p[1]] : [p[0], value]) as Pair) : p)));

  async function save() {
    if (problem || same || busy) return;
    setBusy(true);
    setError(null);
    try {
      await ec2Api.setTags(resource, tags, desired);
      onDone(`Tags saved on ${label}.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <Frame
      title={`Tags of ${label}`}
      help="ec2.tags"
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary" disabled={!!problem || same || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <table className="sync-table ec2-tag-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v], n) => (
            <tr key={n}>
              <td>
                <input className="text-input mono" aria-label="Tag key" value={k} spellCheck={false} autoFocus={n === rows.length - 1 && !k} onChange={(e) => set(n, 0, e.target.value)} />
              </td>
              <td>
                <input className="text-input mono" aria-label="Tag value" value={v} spellCheck={false} onChange={(e) => set(n, 1, e.target.value)} />
              </td>
              <td>
                <button className="link-btn" title="Remove this tag" onClick={() => setRows((r) => (r.length === 1 ? [["", ""]] : r.filter((_, i) => i !== n)))}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
          {fixed.map(([k, v]) => (
            <tr key={k} className="hint" title="Set by AWS; can't be changed">
              <td className="mono">{k}</td>
              <td className="mono">{v}</td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button className="btn" disabled={rows.length >= 50} onClick={() => setRows((r) => [...r, ["", ""]])}>
          Add tag
        </button>
      </div>
      <p className="hint">Keys are case-sensitive. The Name tag is what lists and the tree show.</p>
      {problem && <div className="field-error">{problem}</div>}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function CreateImageDialog({ instance, onClose, onDone }: { instance: Instance; onClose: () => void; onDone: (msg: string) => void }) {
  const [name, setName] = useState(`${(instance.name ?? instance.id).replace(/[^A-Za-z0-9()[\]./'@_ -]/g, "-")} ${today()}`);
  const [description, setDescription] = useState("");
  const [reboot, setReboot] = useState(true);
  const [copyName, setCopyName] = useState(!!instance.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = name.trim();
  const problem = n.length < 3 || n.length > 128 ? "Image names are 3 to 128 characters" : /[^A-Za-z0-9()[\]./'@_ -]/.test(n) ? "Use letters, digits, spaces and ( ) [ ] . / - ' @ _" : description.length > 255 ? "Descriptions are at most 255 characters" : null;

  async function save() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const id = await ec2Api.createImage({ instanceId: instance.id, name: n, description: description.trim() || null, noReboot: !reboot, tags: copyName && instance.name ? [["Name", n]] : [] });
      onDone(`Creating image ${id} (${n}); it takes a few minutes to become available.`);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <Frame
      title={`Create an image of ${instanceLabel(instance)}`}
      help="ec2.image.create"
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary" disabled={!!problem || busy} onClick={() => void save()}>
            {busy ? "Creating…" : "Create image"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className="pe-grid">
        <label className="form-label" htmlFor="ci-name">
          Image name
        </label>
        <input id="ci-name" className="text-input" value={name} autoFocus spellCheck={false} onChange={(e) => setName(e.target.value)} />
        <label className="form-label" htmlFor="ci-desc">
          Description
        </label>
        <input id="ci-desc" className="text-input" value={description} placeholder="optional" onChange={(e) => setDescription(e.target.value)} />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={reboot} onChange={(e) => setReboot(e.target.checked)} /> Reboot the instance first (recommended: files are closed, so the image is consistent)
      </label>
      {!reboot && instance.state === "running" && <p className="warn-note">Without a reboot, files that were being written may be incomplete in the image.</p>}
      <label className="check-row">
        <input type="checkbox" checked={copyName} onChange={(e) => setCopyName(e.target.checked)} /> Tag the image and its snapshots with Name = the image name
      </label>
      <p className="hint">The image and a snapshot of each EBS volume are stored in your account and cost money until you deregister the image and delete its snapshots.</p>
      {problem && <div className="field-error">{problem}</div>}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}

/** Snapshots of all an instance's volumes, or of one volume. */
export function SnapshotDialog({ instance, volumeId, onClose, onDone }: { instance: Instance | null; volumeId: string | null; onClose: () => void; onDone: (msg: string) => void }) {
  const [description, setDescription] = useState(instance ? `${instance.name ?? instance.id} ${today()}` : "");
  const [excludeRoot, setExcludeRoot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = volumeId ?? (instance ? instanceLabel(instance) : "");
  const volumes = instance && !volumeId ? instance.blockDevices.filter((b) => b.volumeId).length : 1;
  const problem = description.length > 255 ? "Descriptions are at most 255 characters" : null;

  async function save() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (volumeId) {
        const s = await ec2Api.snapshotVolume(volumeId, description.trim() || null, []);
        onDone(`Creating snapshot ${s.snapshotId} of ${volumeId}.`);
      } else if (instance) {
        const list = await ec2Api.snapshotInstance(instance.id, description.trim() || null, excludeRoot);
        onDone(`Creating ${list.length} snapshot${list.length === 1 ? "" : "s"} of ${instanceLabel(instance)}: ${list.map((s) => s.snapshotId).join(", ")}.`);
      }
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      setBusy(false);
    }
  }

  return (
    <Frame
      title={`Snapshot ${target}`}
      help="ec2.snapshot.create"
      onClose={onClose}
      buttons={
        <>
          <button className="btn primary" disabled={!!problem || busy} onClick={() => void save()}>
            {busy ? "Creating…" : volumes === 1 ? "Create snapshot" : "Create snapshots"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className="pe-grid">
        <label className="form-label" htmlFor="sn-desc">
          Description
        </label>
        <input id="sn-desc" className="text-input" value={description} autoFocus placeholder="optional" onChange={(e) => setDescription(e.target.value)} />
      </div>
      {instance && !volumeId && (
        <>
          <p className="hint">
            One snapshot of each of the instance's {volumes} EBS volume{volumes === 1 ? "" : "s"}, all taken at the same moment (crash-consistent: like pulling the plug, so files being written may be incomplete). Each snapshot gets its
            volume's tags.
          </p>
          <label className="check-row">
            <input type="checkbox" checked={excludeRoot} onChange={(e) => setExcludeRoot(e.target.checked)} /> Leave out the root volume
          </label>
        </>
      )}
      {volumeId && <p className="hint">A point-in-time copy of the volume, stored in your account. The volume stays in use while the snapshot completes.</p>}
      <p className="hint">Snapshots cost money until you delete them.</p>
      {problem && <div className="field-error">{problem}</div>}
      {error && <div className="field-error">{error}</div>}
    </Frame>
  );
}
