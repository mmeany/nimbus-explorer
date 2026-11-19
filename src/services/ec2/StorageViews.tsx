// AMIs, EBS volumes and EBS snapshots: list configs for ResourceList and one
// view per resource, linked to each other and to instances.
import type { ReactNode } from "react";
import { ec2Api, matchesInstanceFilter, type Image, type Instance, type Snapshot, type Volume } from "../../api/ec2";
import type { Column } from "../../components/FileList";
import { HelpTopic } from "../../components/HelpDialog";
import { ImageIcon, SnapshotIcon, VolumeIcon } from "../../components/Icons";
import { ErrorPanel } from "../../components/ErrorPanel";
import { formatDate } from "../../format";
import { EC2_ROOT, type Ec2Kind } from "../../shell/places";
import type { Shell } from "../../shell/shell";
import { Pill, PropsTable, TagsTable, useLoad, yesNo } from "./common";
import type { KindConfig } from "./ResourceList";

export type ImageScope = "mine" | "shared";

/** A link to another EC2 resource's view. */
export function Ref({ shell, kind, id, label }: { shell: Shell; kind: Ec2Kind; id: string | null | undefined; label?: string }) {
  if (!id) return null;
  return (
    <button className="link-btn mono" onClick={() => shell.navigate({ ...EC2_ROOT, kind, id })}>
      {label ?? id}
    </button>
  );
}

/** Header of a resource view: name / id, state pill, badges, Copy ID. */
export function ResourceHead({ shell, id, name, state, badges = [] }: { shell: Shell; id: string; name: string | null; state?: string | null; badges?: string[] }) {
  return (
    <div className="qv-head">
      <span className="qv-name">{name ?? id}</span>
      {name && <span className="hint mono">{id}</span>}
      {state !== undefined && <Pill status={state} />}
      {badges.map((b) => (
        <span key={b} className="qbadge">
          {b}
        </span>
      ))}
      <div className="spacer" />
      <button className="link-btn" onClick={() => void shell.copyText(id)}>
        Copy ID
      </button>
    </div>
  );
}

/** The Tags section with an Edit tags… button (hidden in read-only mode). */
export function TagsSection({ shell, tags, onEdit }: { shell: Shell; tags: [string, string][]; onEdit?: () => void }) {
  return (
    <>
      <div className="props-section row">
        <span>Tags</span>
        <div className="spacer" />
        {onEdit && !shell.readOnly && (
          <button className="btn small" onClick={onEdit}>
            Edit tags…
          </button>
        )}
      </div>
      <TagsTable tags={tags} />
    </>
  );
}

const size = (g: number | null) => (g == null ? "" : `${g.toLocaleString()} GiB`);

// ---------------------------------------------------------------------------
// AMIs

const IMAGE_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 260 },
  { id: "id", label: "Image ID", width: 190 },
  { id: "state", label: "State", width: 80 },
  { id: "created", label: "Created", width: 165 },
  { id: "platform", label: "Platform", width: 130 },
  { id: "arch", label: "Architecture", width: 95 },
  { id: "owner", label: "Owner", width: 120 },
  { id: "public", label: "Visibility", width: 75 },
];

const imageName = (i: Image) => i.name ?? i.nameTag;

export function imageConfig(scope: ImageScope, controls: ReactNode): KindConfig<Image> {
  return {
    kind: "images",
    help: "ec2.images",
    noun: [scope === "mine" ? "image" : "shared image", scope === "mine" ? "images" : "shared images"],
    loadKey: scope,
    load: () => ec2Api.images(scope),
    key: (i) => i.id,
    columns: IMAGE_COLUMNS,
    icon: () => <ImageIcon />,
    dimmed: (i) => i.state !== "available",
    cells: (i) => ({
      name: { text: imageName(i) ?? "", sort: (imageName(i) ?? "").toLowerCase() || `~${i.id}` },
      id: { text: i.id, sort: i.id },
      state: { text: i.state ?? "", sort: i.state ?? "" },
      created: { text: formatDate(i.created), sort: i.created ?? "" },
      platform: { text: i.platform ?? "", sort: i.platform ?? "" },
      arch: { text: i.architecture ?? "", sort: i.architecture ?? "" },
      owner: { text: i.ownerAlias ?? i.ownerId ?? "", sort: i.ownerAlias ?? i.ownerId ?? "" },
      public: { text: i.public ? "Public" : "Private", sort: i.public ? 1 : 0 },
    }),
    match: (i, f) => matchesInstanceFilter({ id: i.id, name: [i.name, i.nameTag].filter(Boolean).join(" "), tags: i.tags }, f),
    placeholder: "Name, image ID prefix, or tag as key=value (Enter to apply)",
    label: (i) => imageName(i) ?? i.id,
    controls,
    empty: scope === "mine" ? "You have no images in this region." : "No images are shared with your account in this region.",
  };
}

export function ImageView({ shell, id, reloadToken, instances, onEditTags }: { shell: Shell; id: string; reloadToken: number; instances: Instance[] | null; onEditTags: (i: Image) => void }) {
  const { data: i, error, retry } = useLoad(`${id}|${reloadToken}`, () => ec2Api.image(id), (d) => (d?.state === "pending" ? 15_000 : null));
  if (error && !i) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!i) return <div className="empty-note">Loading…</div>;
  const users = (instances ?? []).filter((x) => x.imageId === i.id && x.state !== "terminated");
  return (
    <div className="queue-view db-view">
      <ResourceHead shell={shell} id={i.id} name={imageName(i)} state={i.state} badges={[i.public ? "Public" : "Private", ...(i.architecture ? [i.architecture] : [])]} />
      {i.description && <div className="hint">{i.description}</div>}
      {i.stateReason && i.state !== "available" && <div className="warn-note">{i.stateReason}</div>}
      <HelpTopic id="ec2.image" />
      <div className="lambda-details">
        <PropsTable
          rows={[
            ["Image ID", i.id],
            ["Name", i.name],
            ["Created", formatDate(i.created)],
            ["Deprecated from", i.deprecation ? formatDate(i.deprecation) : null],
            ["Owner", i.ownerAlias ? `${i.ownerAlias} (${i.ownerId ?? "?"})` : i.ownerId],
            ["Platform", i.platform],
            ["Architecture", i.architecture],
            ["Root device", `${i.rootDevice ?? "?"} (${i.rootDeviceType ?? "?"})`],
            ["Virtualization", i.virtualization],
            ["ENA networking", yesNo(i.enaSupport)],
            ["Boot mode", i.bootMode],
            ["Instance metadata", i.imdsSupport === "v2.0" ? "IMDSv2 required for instances launched from it" : null],
            ["Location", i.location],
          ]}
        />
        <div className="props-section">Block devices</div>
        <table className="sync-table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Snapshot</th>
              <th>Size</th>
              <th>Type</th>
              <th>Encrypted</th>
              <th>Deleted with instance</th>
            </tr>
          </thead>
          <tbody>
            {i.devices.map((d) => (
              <tr key={d.device}>
                <td className="mono">
                  {d.device}
                  {d.device === i.rootDevice ? <span className="hint"> (root)</span> : null}
                </td>
                <td>{d.virtualName ? <span className="hint">instance store ({d.virtualName})</span> : <Ref shell={shell} kind="snapshots" id={d.snapshotId} />}</td>
                <td>{size(d.sizeGib)}</td>
                <td>{d.volumeType ?? ""}</td>
                <td>{yesNo(d.encrypted) ?? ""}</td>
                <td>{yesNo(d.deleteOnTermination) ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="props-section">Instances launched from it</div>
        {!instances ? (
          <p className="hint">Loading instances…</p>
        ) : users.length === 0 ? (
          <p className="hint">No instance in this region uses it now.</p>
        ) : (
          <p>
            {users.map((x, n) => (
              <span key={x.id}>
                {n > 0 && ", "}
                <Ref shell={shell} kind="instances" id={x.id} label={x.name ? `${x.name} (${x.id})` : x.id} />
              </span>
            ))}
          </p>
        )}
        <TagsSection shell={shell} tags={i.tags} onEdit={() => onEditTags(i)} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Volumes

const VOLUME_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 200 },
  { id: "id", label: "Volume ID", width: 190 },
  { id: "size", label: "Size", width: 80, align: "right" },
  { id: "type", label: "Type", width: 60 },
  { id: "state", label: "State", width: 80 },
  { id: "attached", label: "Attached to", width: 230 },
  { id: "az", label: "Zone", width: 105 },
  { id: "encrypted", label: "Encrypted", width: 75 },
  { id: "created", label: "Created", width: 165 },
];

export function volumeConfig(instances: Map<string, Instance>): KindConfig<Volume> {
  const attachedText = (v: Volume) =>
    v.attachments
      .map((a) => {
        const i = a.instanceId ? instances.get(a.instanceId) : undefined;
        return `${i?.name ? `${i.name} ` : ""}${a.instanceId ?? "?"}${a.device ? ` ${a.device}` : ""}`;
      })
      .join(", ");
  return {
    kind: "volumes",
    help: "ec2.volumes",
    noun: ["volume", "volumes"],
    load: ec2Api.volumes,
    key: (v) => v.id,
    columns: VOLUME_COLUMNS,
    icon: () => <VolumeIcon />,
    dimmed: (v) => v.state === "available",
    cells: (v) => ({
      name: { text: v.name ?? "", sort: (v.name ?? "").toLowerCase() || `~${v.id}` },
      id: { text: v.id, sort: v.id },
      size: { text: size(v.sizeGib), sort: v.sizeGib ?? 0 },
      type: { text: v.volumeType ?? "", sort: v.volumeType ?? "" },
      state: { text: v.state === "available" ? "unattached" : (v.state ?? ""), sort: v.state ?? "" },
      attached: { text: attachedText(v), sort: attachedText(v) },
      az: { text: v.az ?? "", sort: v.az ?? "" },
      encrypted: { text: v.encrypted ? "Yes" : "No", sort: v.encrypted ? 1 : 0 },
      created: { text: formatDate(v.created), sort: v.created ?? "" },
    }),
    match: (v, f) => matchesInstanceFilter(v, f) || (f.startsWith("i-") && v.attachments.some((a) => a.instanceId?.startsWith(f))),
    placeholder: "Name, volume ID prefix, attached instance ID, or tag as key=value",
    label: (v) => v.name ?? v.id,
    empty: "No EBS volumes in this region.",
  };
}

export function VolumeView({ shell, id, reloadToken, instances, onEditTags, onSnapshot }: { shell: Shell; id: string; reloadToken: number; instances: Map<string, Instance>; onEditTags: (v: Volume) => void; onSnapshot: (v: Volume) => void }) {
  const { data: v, error, retry } = useLoad(`${id}|${reloadToken}`, () => ec2Api.volume(id), (d) => (d && ["creating", "deleting"].includes(d.state ?? "") ? 10_000 : null));
  if (error && !v) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!v) return <div className="empty-note">Loading…</div>;
  return (
    <div className="queue-view db-view">
      <ResourceHead shell={shell} id={v.id} name={v.name} state={v.state === "available" ? "unattached" : v.state} badges={[size(v.sizeGib), v.volumeType ?? ""].filter(Boolean)} />
      {v.state === "available" && <div className="hint">Not attached to any instance: it still costs money every month.</div>}
      <HelpTopic id="ec2.volume" />
      <div className="lambda-details">
        <div className="row">
          <button className="btn" disabled={shell.readOnly} onClick={() => onSnapshot(v)}>
            Create snapshot…
          </button>
        </div>
        <PropsTable
          rows={[
            ["Volume ID", v.id],
            ["Size", size(v.sizeGib)],
            ["Type", v.volumeType],
            ["IOPS", v.iops ? v.iops.toLocaleString() : null],
            ["Throughput", v.throughput ? `${v.throughput} MiB/s` : null],
            ["Availability zone", v.az],
            ["Encrypted", v.encrypted ? `Yes${v.kmsKeyId ? `, KMS key ${v.kmsKeyId}` : ""}` : "No"],
            ["Created", formatDate(v.created)],
            ["From snapshot", v.snapshotId ? <Ref shell={shell} kind="snapshots" id={v.snapshotId} /> : "None"],
            ["Multi-Attach", v.multiAttach ? "Enabled" : null],
          ]}
        />
        <div className="props-section">Attachments</div>
        {v.attachments.length === 0 ? (
          <p className="hint">None.</p>
        ) : (
          <table className="sync-table">
            <thead>
              <tr>
                <th>Instance</th>
                <th>Device</th>
                <th>State</th>
                <th>Deleted with instance</th>
              </tr>
            </thead>
            <tbody>
              {v.attachments.map((a) => {
                const i = a.instanceId ? instances.get(a.instanceId) : undefined;
                return (
                  <tr key={`${a.instanceId}|${a.device}`}>
                    <td>
                      <Ref shell={shell} kind="instances" id={a.instanceId} label={i?.name ? `${i.name} (${a.instanceId})` : undefined} />
                    </td>
                    <td className="mono">{a.device ?? ""}</td>
                    <td>{a.state ?? ""}</td>
                    <td>{yesNo(a.deleteOnTermination) ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <TagsSection shell={shell} tags={v.tags} onEdit={() => onEditTags(v)} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Snapshots

const SNAPSHOT_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 200 },
  { id: "id", label: "Snapshot ID", width: 200 },
  { id: "size", label: "Size", width: 80, align: "right" },
  { id: "state", label: "State", width: 90 },
  { id: "started", label: "Started", width: 165 },
  { id: "volume", label: "Volume", width: 190 },
  { id: "tier", label: "Tier", width: 70 },
  { id: "description", label: "Description", width: 320 },
];

export function snapshotConfig(): KindConfig<Snapshot> {
  return {
    kind: "snapshots",
    help: "ec2.snapshots",
    noun: ["snapshot", "snapshots"],
    load: ec2Api.snapshots,
    key: (s) => s.id,
    columns: SNAPSHOT_COLUMNS,
    icon: () => <SnapshotIcon />,
    dimmed: (s) => s.state !== "completed",
    cells: (s) => ({
      name: { text: s.name ?? "", sort: (s.name ?? "").toLowerCase() || `~${s.id}` },
      id: { text: s.id, sort: s.id },
      size: { text: size(s.sizeGib), sort: s.sizeGib ?? 0 },
      state: { text: s.state === "pending" && s.progress ? `pending ${s.progress}` : (s.state ?? ""), sort: s.state ?? "" },
      started: { text: formatDate(s.started), sort: s.started ?? "" },
      volume: { text: s.volumeId ?? "", sort: s.volumeId ?? "" },
      tier: { text: s.storageTier ?? "", sort: s.storageTier ?? "" },
      description: { text: s.description ?? "", sort: s.description ?? "" },
    }),
    match: (s, f) => matchesInstanceFilter(s, f) || (s.volumeId ?? "").startsWith(f.trim()) || (s.description ?? "").toLowerCase().includes(f.trim().toLowerCase()),
    placeholder: "Name, snapshot or volume ID prefix, description, or tag as key=value",
    label: (s) => s.name ?? s.id,
    empty: "You have no snapshots in this region.",
  };
}

export function SnapshotView({ shell, id, reloadToken, onEditTags }: { shell: Shell; id: string; reloadToken: number; onEditTags: (s: Snapshot) => void }) {
  const { data: s, error, retry } = useLoad(`${id}|${reloadToken}`, () => ec2Api.snapshot(id), (d) => (d?.state === "pending" ? 15_000 : null));
  if (error && !s) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!s) return <div className="empty-note">Loading…</div>;
  return (
    <div className="queue-view db-view">
      <ResourceHead shell={shell} id={s.id} name={s.name} state={s.state} badges={[size(s.sizeGib), s.encrypted ? "Encrypted" : ""].filter(Boolean)} />
      {s.description && <div className="hint">{s.description}</div>}
      {s.stateMessage && <div className="warn-note">{s.stateMessage}</div>}
      <HelpTopic id="ec2.snapshot" />
      <div className="lambda-details">
        <PropsTable
          rows={[
            ["Snapshot ID", s.id],
            ["Size", size(s.sizeGib)],
            ["State", s.state === "pending" && s.progress ? `pending (${s.progress})` : s.state],
            ["Started", formatDate(s.started)],
            ["Completed", s.completed ? formatDate(s.completed) : null],
            [
              "Volume",
              s.volumeId ? (
                <>
                  <Ref shell={shell} kind="volumes" id={s.volumeId} />
                  {s.volumeExists === false && <span className="hint"> (deleted)</span>}
                </>
              ) : (
                "None (copied from another snapshot)"
              ),
            ],
            ["Encrypted", s.encrypted ? `Yes${s.kmsKeyId ? `, KMS key ${s.kmsKeyId}` : ""}` : "No"],
            ["Storage tier", s.storageTier === "archive" ? "Archive (must be restored before use)" : s.storageTier],
            ["Owner account", s.ownerId],
          ]}
        />
        <div className="props-section">Images using it</div>
        {s.images.length === 0 ? (
          <p className="hint">None of your images in this region.</p>
        ) : (
          <p>
            {s.images.map((im, n) => (
              <span key={im}>
                {n > 0 && ", "}
                <Ref shell={shell} kind="images" id={im} />
              </span>
            ))}
          </p>
        )}
        <TagsSection shell={shell} tags={s.tags} onEdit={() => onEditTags(s)} />
      </div>
    </div>
  );
}

export const STORAGE_ICONS: Partial<Record<Ec2Kind, ReactNode>> = { images: <ImageIcon />, volumes: <VolumeIcon />, snapshots: <SnapshotIcon /> };
