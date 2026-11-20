// One managed policy (view only): the default version's document, versions with
// Compare, where it's attached, details and tags.
import { useEffect, useState } from "react";
import type { AppError } from "../../api/core";
import { entityCount, iamPolicyApi, prettyJson, type Entity, type PolicyDetails, type PolicyEntities } from "../../api/iam";
import { DiffView } from "../../components/DiffView";
import { ErrorPanel } from "../../components/ErrorPanel";
import { formatDate } from "../../format";
import { IAM_ROOT, type IamKind } from "../../shell/places";
import type { Shell } from "../../shell/shell";
import { PropsTable } from "../elasticache/CacheViews";
import { PolicyDocument } from "./PolicyDocument";
import { PrincipalFrame, Tags, useDetails, type Tab } from "./PrincipalViews";

export function PolicyView({ shell, arn, reloadToken }: { shell: Shell; arn: string; reloadToken: number }) {
  const { data: p, error, retry } = useDetails(`${arn}|${reloadToken}`, () => iamPolicyApi.policy(arn));
  if (error && !p) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!p) return <div className="empty-note">Loading…</div>;
  return <PolicyBody shell={shell} p={p} />;
}

function EntityTable({ shell, title, kind, items }: { shell: Shell; title: string; kind: IamKind; items: Entity[] }) {
  if (!items.length) return null;
  return (
    <>
      <div className="props-section">
        {title} ({items.length})
      </div>
      <table className="sync-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>ID</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id || e.name}>
              <td>
                <button className="link-btn" onClick={() => shell.navigate({ ...IAM_ROOT, kind, id: e.name })}>
                  {e.name}
                </button>
              </td>
              <td className="mono">{e.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Entities({ shell, e, users, groups, roles }: { shell: Shell; e: PolicyEntities; users: string; groups: string; roles: string }) {
  return (
    <>
      <EntityTable shell={shell} title={users} kind="users" items={e.users} />
      <EntityTable shell={shell} title={groups} kind="groups" items={e.groups} />
      <EntityTable shell={shell} title={roles} kind="roles" items={e.roles} />
    </>
  );
}

/** One version's document, or the difference between two. Documents are loaded once each. */
function Versions({ p }: { p: PolicyDetails }) {
  const def = p.versions.find((v) => v.default)?.id ?? p.defaultVersion ?? p.versions[0]?.id ?? "";
  const [shown, setShown] = useState(def);
  const [against, setAgainst] = useState("");
  const [docs, setDocs] = useState<Record<string, string>>(() => (p.document && def ? { [def]: p.document } : {}));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    for (const v of [shown, against]) {
      if (!v || docs[v] !== undefined) continue;
      iamPolicyApi
        .version(p.arn, v)
        .then((d) => !stale && setDocs((m) => ({ ...m, [v]: d })))
        .catch((e) => !stale && setError((e as AppError).message ?? String(e)));
    }
    return () => {
      stale = true;
    };
  }, [shown, against, docs, p.arn]);

  const label = (id: string) => `${id}${id === def ? " (default)" : ""}`;
  return (
    <>
      <table className="sync-table">
        <thead>
          <tr>
            <th>Version</th>
            <th>Default</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {p.versions.map((v) => (
            <tr key={v.id} className={v.id === shown ? "selected" : ""}>
              <td className="mono">{v.id}</td>
              <td>{v.default ? "Yes" : ""}</td>
              <td>{formatDate(v.created)}</td>
              <td>
                <button className="link-btn" onClick={() => setShown(v.id)}>
                  Show
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">A managed policy keeps up to five versions; the default one is in effect.</p>
      <div className="row">
        <span className="hint">Show</span>
        <select className="text-input" value={shown} onChange={(e) => setShown(e.target.value)}>
          {p.versions.map((v) => (
            <option key={v.id} value={v.id}>
              {label(v.id)}
            </option>
          ))}
        </select>
        {p.versions.length > 1 && (
          <>
            <span className="hint">compared with</span>
            <select className="text-input" value={against} onChange={(e) => setAgainst(e.target.value)}>
              <option value="">(nothing: show the document)</option>
              {p.versions
                .filter((v) => v.id !== shown)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {label(v.id)}
                  </option>
                ))}
            </select>
          </>
        )}
      </div>
      {error && <div className="field-error">{error}</div>}
      {against && against !== shown ? (
        docs[shown] !== undefined && docs[against] !== undefined ? (
          <DiffView before={prettyJson(docs[against])} after={prettyJson(docs[shown])} beforeLabel={against} afterLabel={shown} />
        ) : (
          <p className="hint">Loading…</p>
        )
      ) : docs[shown] !== undefined ? (
        <PolicyDocument document={docs[shown]} />
      ) : (
        <p className="hint">Loading…</p>
      )}
    </>
  );
}

function PolicyBody({ shell, p }: { shell: Shell; p: PolicyDetails }) {
  const attached = entityCount(p.attachedTo);
  const bounded = entityCount(p.boundaryFor);
  const tabs: Tab[] = [
    {
      id: "document",
      label: "Document",
      help: "iam.policy",
      render: () => (
        <>
          <p className="hint">Default version {p.defaultVersion ?? "?"}: the one in effect.</p>
          <PolicyDocument document={p.document} />
        </>
      ),
    },
    { id: "versions", label: `Versions (${p.versions.length})`, help: "iam.policy.versions", render: () => <Versions p={p} /> },
    {
      id: "attached",
      label: `Attached to (${attached + bounded})`,
      help: "iam.policy.attached",
      render: () => (
        <>
          {attached === 0 && bounded === 0 && <p className="hint">Not attached to any user, user group or role in this account.</p>}
          <Entities shell={shell} e={p.attachedTo} users="Users" groups="User groups" roles="Roles" />
          {bounded > 0 && <Entities shell={shell} e={p.boundaryFor} users="Permissions boundary of users" groups="" roles="Permissions boundary of roles" />}
        </>
      ),
    },
    {
      id: "details",
      label: "Details",
      help: "iam.policy",
      render: () => (
        <PropsTable
          rows={[
            ["Policy name", p.name],
            ["Policy ID", <span className="mono">{p.id}</span>],
            ["Type", p.awsManaged ? "AWS managed" : "Customer managed"],
            ["Path", p.path],
            ["ARN", <span className="mono">{p.arn}</span>],
            ["Description", p.description],
            ["Default version", p.defaultVersion],
            ["Created", formatDate(p.created)],
            ["Last updated", formatDate(p.updated)],
            ["Attachments", p.attachments.toLocaleString()],
            ["Used as a permissions boundary", p.boundaryUses ? p.boundaryUses.toLocaleString() : "No"],
            ["Attachable", p.attachable ? "Yes" : "No"],
          ]}
        />
      ),
    },
  ];
  if (!p.awsManaged) tabs.push({ id: "tags", label: `Tags (${p.tags.length})`, help: "iam.policy", render: () => <Tags tags={p.tags} /> });
  return (
    <PrincipalFrame
      shell={shell}
      title={p.name}
      arn={p.arn}
      badges={
        <>
          <span className="qbadge">{p.awsManaged ? "AWS managed" : "Customer managed"}</span>
          {p.attachments === 0 && p.boundaryUses === 0 && <span className="qbadge">Not attached</span>}
        </>
      }
      note={p.description ? <div className="hint">{p.description}</div> : undefined}
      tabs={tabs}
    />
  );
}
