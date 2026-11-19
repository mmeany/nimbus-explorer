// Key pairs and launch templates: list configs and views. A template's
// versions are listed newest first; one version's data shows as a tree, and
// any two can be compared.
import { useMemo, useState } from "react";
import { ec2Api, matchesInstanceFilter, type Instance, type KeyPair, type LaunchTemplate } from "../../api/ec2";
import { DiffView } from "../../components/DiffView";
import { ErrorPanel } from "../../components/ErrorPanel";
import type { Column } from "../../components/FileList";
import { HelpTopic } from "../../components/HelpDialog";
import { KeyIcon, TemplateIcon } from "../../components/Icons";
import { ValueView } from "../../components/ValueView";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";
import { PropsTable, useLoad } from "./common";
import type { KindConfig } from "./ResourceList";
import { Ref, ResourceHead, TagsSection } from "./StorageViews";

type EditTags = (id: string, label: string, tags: [string, string][]) => void;

// ---------------------------------------------------------------------------
// Key pairs

const KEY_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 240 },
  { id: "id", label: "Key pair ID", width: 200 },
  { id: "type", label: "Type", width: 70 },
  { id: "used", label: "Instances", width: 75, align: "right" },
  { id: "created", label: "Created", width: 165 },
  { id: "fingerprint", label: "Fingerprint", width: 420 },
];

export function keyPairConfig(instances: Instance[] | null): KindConfig<KeyPair> {
  const uses = (k: KeyPair) => (instances ? instances.filter((i) => i.keyName === k.name && i.state !== "terminated").length : null);
  return {
    kind: "keyPairs",
    help: "ec2.keyPairs",
    noun: ["key pair", "key pairs"],
    load: ec2Api.keyPairs,
    key: (k) => k.id,
    columns: KEY_COLUMNS,
    icon: () => <KeyIcon />,
    dimmed: (k) => uses(k) === 0,
    cells: (k) => ({
      name: { text: k.name, sort: k.name.toLowerCase() },
      id: { text: k.id, sort: k.id },
      type: { text: k.keyType ?? "", sort: k.keyType ?? "" },
      used: { text: uses(k) === null ? "…" : String(uses(k)), sort: uses(k) ?? -1 },
      created: { text: formatDate(k.created), sort: k.created ?? "" },
      fingerprint: { text: k.fingerprint ?? "", sort: k.fingerprint ?? "" },
    }),
    match: (k, f) => matchesInstanceFilter({ id: k.id, name: k.name, tags: k.tags }, f),
    placeholder: "Name, key pair ID prefix, or tag as key=value",
    label: (k) => k.name,
    empty: "No key pairs in this region.",
  };
}

export function KeyPairView({ shell, id, reloadToken, instances, onEditTags }: { shell: Shell; id: string; reloadToken: number; instances: Instance[] | null; onEditTags: EditTags }) {
  const { data: list, error, retry } = useLoad(`${id}|${reloadToken}`, () => ec2Api.keyPairs());
  if (error && !list) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!list) return <div className="empty-note">Loading…</div>;
  const k = list.find((x) => x.id === id || x.name === id);
  if (!k) return <p className="hint">There's no key pair {id} in this region.</p>;
  const users = (instances ?? []).filter((i) => i.keyName === k.name && i.state !== "terminated");
  return (
    <div className="queue-view db-view">
      <ResourceHead shell={shell} id={k.id} name={k.name} badges={k.keyType ? [k.keyType] : []} />
      <HelpTopic id="ec2.keyPairs" />
      <div className="lambda-details">
        <PropsTable
          rows={[
            ["Name", k.name],
            ["Key pair ID", k.id],
            ["Type", k.keyType],
            ["Fingerprint", k.fingerprint],
            ["Created", formatDate(k.created)],
          ]}
        />
        <p className="hint">AWS keeps only the public key. The private key was downloaded once, when the key pair was created; neither AWS nor this app can show it.</p>
        <div className="props-section">Instances using it ({users.length})</div>
        {users.length === 0 ? (
          <p className="hint">No instance in this region was launched with it.</p>
        ) : (
          <p>
            {users.map((i, n) => (
              <span key={i.id}>
                {n > 0 && ", "}
                <Ref shell={shell} kind="instances" id={i.id} label={i.name ? `${i.name} (${i.id})` : i.id} />
              </span>
            ))}
          </p>
        )}
        <TagsSection shell={shell} tags={k.tags} onEdit={k.id.startsWith("key-") ? () => onEditTags(k.id, k.name, k.tags) : undefined} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Launch templates

const TEMPLATE_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 260 },
  { id: "id", label: "Template ID", width: 200 },
  { id: "default", label: "Default version", width: 110, align: "right" },
  { id: "latest", label: "Latest version", width: 105, align: "right" },
  { id: "created", label: "Created", width: 165 },
  { id: "by", label: "Created by", width: 300 },
];

export const templateConfig: KindConfig<LaunchTemplate> = {
  kind: "launchTemplates",
  help: "ec2.launchTemplates",
  noun: ["launch template", "launch templates"],
  load: ec2Api.launchTemplates,
  key: (t) => t.id,
  columns: TEMPLATE_COLUMNS,
  icon: () => <TemplateIcon />,
  cells: (t) => ({
    name: { text: t.name, sort: t.name.toLowerCase() },
    id: { text: t.id, sort: t.id },
    default: { text: t.defaultVersion == null ? "" : String(t.defaultVersion), sort: t.defaultVersion ?? 0 },
    latest: { text: t.latestVersion == null ? "" : String(t.latestVersion), sort: t.latestVersion ?? 0 },
    created: { text: formatDate(t.created), sort: t.created ?? "" },
    by: { text: t.createdBy ?? "", sort: t.createdBy ?? "" },
  }),
  match: (t, f) => matchesInstanceFilter({ id: t.id, name: t.name, tags: t.tags }, f),
  placeholder: "Name, template ID prefix, or tag as key=value",
  label: (t) => t.name,
  empty: "No launch templates in this region.",
};

const pretty = (v: unknown) => JSON.stringify(v ?? {}, null, 2);

export function TemplateView({ shell, id, reloadToken, onEditTags }: { shell: Shell; id: string; reloadToken: number; onEditTags: EditTags }) {
  const { data: t, error, retry } = useLoad(`${id}|${reloadToken}`, () => ec2Api.launchTemplate(id));
  const [picked, setPicked] = useState<number | null>(null);
  const [compare, setCompare] = useState<[number, number] | null>(null);
  const shown = useMemo(() => (t ? (t.versions.find((v) => v.version === picked) ?? t.versions.find((v) => v.default) ?? t.versions[0]) : undefined), [t, picked]);
  if (error && !t) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!t) return <div className="empty-note">Loading…</div>;
  const older = shown ? t.versions.find((v) => v.version < shown.version) : undefined;
  const pair = compare ? [t.versions.find((v) => v.version === compare[0]), t.versions.find((v) => v.version === compare[1])] : null;
  return (
    <div className="queue-view db-view">
      <ResourceHead shell={shell} id={t.id} name={t.name} badges={[`default v${t.defaultVersion ?? "?"}`, `latest v${t.latestVersion ?? "?"}`]} />
      <HelpTopic id="ec2.launchTemplate" />
      <div className="lambda-details">
        <PropsTable
          rows={[
            ["Template ID", t.id],
            ["Created", formatDate(t.created)],
            ["Created by", t.createdBy],
          ]}
        />
        <div className="props-section">Versions ({t.versions.length})</div>
        <table className="sync-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Description</th>
              <th>Created</th>
              <th>Created by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {t.versions.map((v) => (
              <tr key={v.version} className={shown?.version === v.version ? "selected-row" : ""}>
                <td>
                  <button className="link-btn" onClick={() => (setPicked(v.version), setCompare(null))}>
                    v{v.version}
                  </button>
                  {v.default ? <span className="hint"> (default)</span> : null}
                </td>
                <td>{v.description ?? ""}</td>
                <td>{formatDate(v.created)}</td>
                <td>{v.createdBy ?? ""}</td>
                <td>
                  {shown && v.version !== shown.version && (
                    <button className="link-btn" onClick={() => setCompare([Math.min(v.version, shown.version), Math.max(v.version, shown.version)])}>
                      Compare with v{shown.version}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {pair && pair[0] && pair[1] ? (
          <>
            <div className="props-section row">
              <span>
                Changes from v{pair[0].version} to v{pair[1].version}
              </span>
              <div className="spacer" />
              <button className="btn small" onClick={() => setCompare(null)}>
                Close comparison
              </button>
            </div>
            <DiffView before={pretty(pair[0].data)} after={pretty(pair[1].data)} beforeLabel={`v${pair[0].version}`} afterLabel={`v${pair[1].version}`} />
          </>
        ) : (
          shown && (
            <>
              <div className="props-section row">
                <span>
                  Launch settings in v{shown.version}
                  {shown.default ? " (default)" : ""}
                </span>
                <div className="spacer" />
                {older && (
                  <button className="btn small" onClick={() => setCompare([older.version, shown.version])}>
                    Compare with v{older.version}
                  </button>
                )}
              </div>
              <ValueView key={shown.version} value={pretty(shown.data)} />
              <p className="hint">User data is never shown here, only its size. Settings the app doesn't map (rare ones such as license or enclave options) aren't listed.</p>
            </>
          )
        )}
        <TagsSection shell={shell} tags={t.tags} onEdit={() => onEditTags(t.id, t.name, t.tags)} />
      </div>
    </div>
  );
}
