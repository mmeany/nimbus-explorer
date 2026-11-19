// One IAM user, user group or role (view only): details, permissions,
// credentials, trust and tags. Secrets are never shown: AWS doesn't return them.
import { useEffect, useState, type ReactNode } from "react";
import type { AppError } from "../../api/core";
import { daysSince, iamApi, sessionText, trustText, type Attached, type GroupDetails, type Inline, type RoleDetails, type UserDetails } from "../../api/iam";
import { ErrorPanel } from "../../components/ErrorPanel";
import { HelpTopic } from "../../components/HelpDialog";
import { PolicyDocument } from "./PolicyDocument";
import { formatDate } from "../../format";
import type { HelpTopicId } from "../../help";
import { IAM_ROOT } from "../../shell/places";
import type { Shell } from "../../shell/shell";
import { PropsTable } from "../elasticache/CacheViews";

export function useDetails<T>(key: string, load: () => Promise<T>) {
  const [state, setState] = useState<{ key: string; data: T | null; error: AppError | null }>({ key: "", data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stale = false;
    load()
      .then((data) => !stale && setState({ key, data, error: null }))
      .catch((e) => !stale && setState({ key, data: null, error: e as AppError }));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  const cur = state.key === key ? state : { data: null, error: null };
  return { data: cur.data, error: cur.error, retry: () => setTick((x) => x + 1) };
}

export interface Tab {
  id: string;
  label: string;
  help: HelpTopicId;
  render: () => ReactNode;
}

export function PrincipalFrame({ shell, title, badges, arn, note, tabs }: { shell: Shell; title: string; badges: ReactNode; arn: string; note?: ReactNode; tabs: Tab[] }) {
  const [tab, setTab] = useState(tabs[0].id);
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  return (
    <div className="queue-view db-view">
      <div className="qv-head">
        <span className="qv-name">{title}</span>
        {badges}
        <div className="spacer" />
        <button className="link-btn" onClick={() => void shell.copyText(arn)}>
          Copy ARN
        </button>
      </div>
      {note}
      <HelpTopic id={current.help} />
      <div className="segmented small db-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="lambda-details">{current.render()}</div>
    </div>
  );
}

export function Tags({ tags }: { tags: [string, string][] }) {
  if (!tags.length) return <p className="hint">No tags.</p>;
  return <PropsTable rows={tags.map(([k, v]) => [k, v || "(empty)"])} />;
}

/** An inline policy name that expands to its document. */
function InlinePolicy({ p }: { p: Inline }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="iam-inline">
      <button className="link-btn" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} {p.name}
      </button>
      {open && (p.error ? <div className="field-error">{p.error}</div> : <PolicyDocument document={p.document} />)}
    </div>
  );
}

function Permissions({ shell, attached, inline, boundary, via }: { shell: Shell; attached: Attached[]; inline: Inline[]; boundary?: string | null; via?: ReactNode }) {
  return (
    <>
      <div className="props-section">Managed policies attached ({attached.length})</div>
      {attached.length === 0 ? (
        <p className="hint">None.</p>
      ) : (
        <table className="sync-table">
          <thead>
            <tr>
              <th>Policy</th>
              <th>Type</th>
              <th>ARN</th>
            </tr>
          </thead>
          <tbody>
            {attached.map((p) => (
              <tr key={p.arn}>
                <td>
                  <button className="link-btn" title="Open the policy" onClick={() => shell.navigate({ ...IAM_ROOT, kind: "policies", id: p.arn })}>
                    {p.name}
                  </button>
                </td>
                <td>{p.awsManaged ? "AWS managed" : "Customer managed"}</td>
                <td className="mono">
                  <button className="link-btn" title="Copy ARN" onClick={() => void shell.copyText(p.arn)}>
                    {p.arn}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="props-section">Inline policies ({inline.length})</div>
      {inline.length === 0 ? <p className="hint">None.</p> : inline.map((p) => <InlinePolicy key={p.name} p={p} />)}
      {boundary !== undefined && (
        <>
          <div className="props-section">Permissions boundary</div>
          {boundary ? (
            <p className="mono">
              <button className="link-btn" title="Open the policy" onClick={() => shell.navigate({ ...IAM_ROOT, kind: "policies", id: boundary })}>
                {boundary}
              </button>
            </p>
          ) : (
            <p className="hint">None: the policies above aren't capped by a boundary.</p>
          )}
        </>
      )}
      {via}
    </>
  );
}

// ---------------------------------------------------------------------------

export function UserView({ shell, name, reloadToken }: { shell: Shell; name: string; reloadToken: number }) {
  const { data: u, error, retry } = useDetails(`${name}|${reloadToken}`, () => iamApi.user(name));
  if (error && !u) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!u) return <div className="empty-note">Loading…</div>;
  return <UserBody shell={shell} u={u} />;
}

function UserBody({ shell, u }: { shell: Shell; u: UserDetails }) {
  const activeKeys = u.accessKeys.filter((k) => k.status === "Active");
  const tabs: Tab[] = [
    {
      id: "details",
      label: "Details",
      help: "iam.user",
      render: () => (
        <PropsTable
          rows={[
            ["User name", u.name],
            ["User ID", <span className="mono">{u.id}</span>],
            ["Path", u.path],
            ["ARN", <span className="mono">{u.arn}</span>],
            ["Created", formatDate(u.created)],
            ["Console access", u.login ? `Yes${u.login.resetRequired ? " (must change password at next sign-in)" : ""}` : "No"],
            ["Password last used", u.login || u.passwordLastUsed ? formatDate(u.passwordLastUsed) || "Never" : null],
            ["Access keys", u.accessKeys.length ? `${activeKeys.length} active of ${u.accessKeys.length}` : "None"],
            ["MFA", u.mfa.length ? `${u.mfa.length} device${u.mfa.length === 1 ? "" : "s"}` : "None"],
            ["User groups", u.groups.length ? u.groups.map((g) => g.name).join(", ") : "None"],
            ["Permissions boundary", u.boundary],
          ]}
        />
      ),
    },
    {
      id: "permissions",
      label: `Permissions (${u.attached.length + u.inline.length})`,
      help: "iam.permissions",
      render: () => (
        <Permissions
          shell={shell}
          attached={u.attached}
          inline={u.inline}
          boundary={u.boundary}
          via={
            u.groups.length > 0 && (
              <p className="hint">
                The user also gets the permissions of its groups:{" "}
                {u.groups.map((g, i) => (
                  <span key={g.name}>
                    {i > 0 && ", "}
                    <button className="link-btn" onClick={() => shell.navigate({ ...IAM_ROOT, kind: "groups", id: g.name })}>
                      {g.name}
                    </button>
                  </span>
                ))}
                .
              </p>
            )
          }
        />
      ),
    },
    {
      id: "groups",
      label: `User groups (${u.groups.length})`,
      help: "iam.user",
      render: () =>
        u.groups.length === 0 ? (
          <p className="hint">The user isn't in any group.</p>
        ) : (
          <table className="sync-table">
            <thead>
              <tr>
                <th>User group</th>
                <th>Path</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {u.groups.map((g) => (
                <tr key={g.name}>
                  <td>
                    <button className="link-btn" onClick={() => shell.navigate({ ...IAM_ROOT, kind: "groups", id: g.name })}>
                      {g.name}
                    </button>
                  </td>
                  <td>{g.path}</td>
                  <td>{formatDate(g.created)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ),
    },
    {
      id: "credentials",
      label: "Credentials",
      help: "iam.credentials",
      render: () => (
        <>
          <div className="props-section">Console password</div>
          <PropsTable
            rows={[
              ["Console access", u.login ? "Enabled" : "None (no password)"],
              ["Password set", u.login ? formatDate(u.login.created) : null],
              ["Must change at next sign-in", u.login ? (u.login.resetRequired ? "Yes" : "No") : null],
              ["Last used", u.login || u.passwordLastUsed ? formatDate(u.passwordLastUsed) || "Never" : null],
            ]}
          />
          <div className="props-section">Access keys ({u.accessKeys.length})</div>
          {u.accessKeys.length === 0 ? (
            <p className="hint">None.</p>
          ) : (
            <table className="sync-table">
              <thead>
                <tr>
                  <th>Access key ID</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Age</th>
                  <th>Last used</th>
                  <th>Service</th>
                  <th>Region</th>
                </tr>
              </thead>
              <tbody>
                {u.accessKeys.map((k) => {
                  const age = daysSince(k.created);
                  return (
                    <tr key={k.id} className={k.status === "Active" ? "" : "dimmed"}>
                      <td className="mono">{k.id}</td>
                      <td>{k.status ?? ""}</td>
                      <td>{formatDate(k.created)}</td>
                      <td>{age === null ? "" : `${age} day${age === 1 ? "" : "s"}`}</td>
                      <td>{k.lastUsed ? formatDate(k.lastUsed) : "Never"}</td>
                      <td>{k.lastService ?? ""}</td>
                      <td>{k.lastRegion ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="hint">Secret access keys are only shown by AWS when a key is created; they can't be read later.</p>
          <div className="props-section">MFA devices ({u.mfa.length})</div>
          {u.mfa.length === 0 ? (
            <p className="hint">None{u.login ? ": this user can sign in to the console with a password alone." : "."}</p>
          ) : (
            <table className="sync-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Type</th>
                  <th>Enabled</th>
                </tr>
              </thead>
              <tbody>
                {u.mfa.map((m) => (
                  <tr key={m.serial}>
                    <td className="mono">{m.serial}</td>
                    <td>{m.virtualDevice ? "Virtual (authenticator app)" : "Hardware or security key"}</td>
                    <td>{formatDate(m.enabled)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ),
    },
    { id: "tags", label: `Tags (${u.tags.length})`, help: "iam.user", render: () => <Tags tags={u.tags} /> },
  ];
  return (
    <PrincipalFrame
      shell={shell}
      title={u.name}
      arn={u.arn}
      badges={
        <>
          <span className="qbadge">User</span>
          {u.login && <span className="qbadge">Console</span>}
          {u.login && u.mfa.length === 0 && <span className="qbadge dlq">No MFA</span>}
        </>
      }
      tabs={tabs}
    />
  );
}

// ---------------------------------------------------------------------------

export function GroupView({ shell, name, reloadToken }: { shell: Shell; name: string; reloadToken: number }) {
  const { data: g, error, retry } = useDetails(`${name}|${reloadToken}`, () => iamApi.group(name));
  if (error && !g) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!g) return <div className="empty-note">Loading…</div>;
  return <GroupBody shell={shell} g={g} />;
}

function GroupBody({ shell, g }: { shell: Shell; g: GroupDetails }) {
  const tabs: Tab[] = [
    {
      id: "members",
      label: `Users (${g.members.length})`,
      help: "iam.group",
      render: () =>
        g.members.length === 0 ? (
          <p className="hint">No users in this group.</p>
        ) : (
          <table className="sync-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Path</th>
                <th>Password last used</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {g.members.map((m) => (
                <tr key={m.name}>
                  <td>
                    <button className="link-btn" onClick={() => shell.navigate({ ...IAM_ROOT, kind: "users", id: m.name })}>
                      {m.name}
                    </button>
                  </td>
                  <td>{m.path}</td>
                  <td>{formatDate(m.passwordLastUsed)}</td>
                  <td>{formatDate(m.created)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ),
    },
    { id: "permissions", label: `Permissions (${g.attached.length + g.inline.length})`, help: "iam.permissions", render: () => <Permissions shell={shell} attached={g.attached} inline={g.inline} /> },
    {
      id: "details",
      label: "Details",
      help: "iam.group",
      render: () => (
        <PropsTable
          rows={[
            ["Group name", g.name],
            ["Group ID", <span className="mono">{g.id}</span>],
            ["Path", g.path],
            ["ARN", <span className="mono">{g.arn}</span>],
            ["Created", formatDate(g.created)],
          ]}
        />
      ),
    },
  ];
  return <PrincipalFrame shell={shell} title={g.name} arn={g.arn} badges={<span className="qbadge">User group</span>} tabs={tabs} />;
}

// ---------------------------------------------------------------------------

export function RoleView({ shell, name, reloadToken }: { shell: Shell; name: string; reloadToken: number }) {
  const { data: r, error, retry } = useDetails(`${name}|${reloadToken}`, () => iamApi.role(name));
  if (error && !r) return <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />;
  if (!r) return <div className="empty-note">Loading…</div>;
  return <RoleBody shell={shell} r={r} />;
}

function RoleBody({ shell, r }: { shell: Shell; r: RoleDetails }) {
  const tabs: Tab[] = [
    {
      id: "trust",
      label: "Trust",
      help: "iam.trust",
      render: () => (
        <>
          <div className="props-section">Who can assume this role</div>
          {r.trusted.length === 0 ? (
            <p className="hint">The trust policy names no principals.</p>
          ) : (
            <table className="sync-table">
              <thead>
                <tr>
                  <th>Effect</th>
                  <th>Principal</th>
                  <th>Actions</th>
                  <th>Conditions</th>
                </tr>
              </thead>
              <tbody>
                {r.trusted.map((t, i) => (
                  <tr key={i} className={t.effect === "Deny" ? "dimmed" : ""}>
                    <td>{t.effect}</td>
                    <td className="selectable">{trustText(t)}</td>
                    <td className="mono">{t.actions.join(", ")}</td>
                    <td>{t.conditions ? "Yes (see the policy)" : "None"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="props-section">Trust policy</div>
          <PolicyDocument document={r.trustPolicy} />
        </>
      ),
    },
    { id: "permissions", label: `Permissions (${r.attached.length + r.inline.length})`, help: "iam.permissions", render: () => <Permissions shell={shell} attached={r.attached} inline={r.inline} boundary={r.boundary} /> },
    {
      id: "details",
      label: "Details",
      help: "iam.role",
      render: () => (
        <PropsTable
          rows={[
            ["Role name", r.name],
            ["Role ID", <span className="mono">{r.id}</span>],
            ["Path", r.path],
            ["ARN", <span className="mono">{r.arn}</span>],
            ["Description", r.description],
            ["Created", formatDate(r.created)],
            ["Maximum session", sessionText(r.maxSessionSecs)],
            ["Last used", r.lastUsed ? `${formatDate(r.lastUsed)}${r.lastUsedRegion ? ` in ${r.lastUsedRegion}` : ""}` : "Never (AWS tracks the last 400 days)"],
            ["Instance profiles", r.instanceProfiles.length ? r.instanceProfiles.join(", ") : "None"],
            ["Permissions boundary", r.boundary],
            ["Service-linked", r.serviceLinked ? "Yes: created and managed by an AWS service" : null],
          ]}
        />
      ),
    },
    { id: "tags", label: `Tags (${r.tags.length})`, help: "iam.role", render: () => <Tags tags={r.tags} /> },
  ];
  return (
    <PrincipalFrame
      shell={shell}
      title={r.name}
      arn={r.arn}
      badges={
        <>
          <span className="qbadge">Role</span>
          {r.serviceLinked && <span className="qbadge">Service-linked</span>}
        </>
      }
      note={r.description ? <div className="hint">{r.description}</div> : undefined}
      tabs={tabs}
    />
  );
}
