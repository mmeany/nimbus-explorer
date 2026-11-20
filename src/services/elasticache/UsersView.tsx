// Users and user groups (RBAC, view only): users with their access strings
// and authentication, groups with their members and the caches using them.
import { useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { ecApi, engineLabel, type Rbac } from "../../api/elasticache";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { HelpTopic } from "../../components/HelpDialog";
import { EC_ROOT } from "../../shell/places";
import type { Shell } from "../../shell/shell";
import { PropsTable } from "./CacheViews";

const USER_COLUMNS: Column[] = [
  { id: "id", label: "User ID", width: 200 },
  { id: "name", label: "User name", width: 160 },
  { id: "status", label: "Status", width: 90 },
  { id: "engine", label: "Engine", width: 90 },
  { id: "auth", label: "Authentication", width: 160 },
  { id: "access", label: "Access string", width: 320 },
  { id: "groups", label: "User groups", width: 220 },
];

const GROUP_COLUMNS: Column[] = [
  { id: "id", label: "User group", width: 220 },
  { id: "status", label: "Status", width: 90 },
  { id: "engine", label: "Engine", width: 90 },
  { id: "users", label: "Users", width: 280 },
  { id: "caches", label: "Used by", width: 300 },
  { id: "pending", label: "Pending", width: 200 },
];

/** "Password (2)", "IAM", "No password". */
export function authLabel(type: string | null, count: number | null): string {
  if (type === "iam") return "IAM";
  if (type === "no-password" || type === "no-password-required") return "No password";
  if (type === "password") return count ? `Password${count > 1 ? `s (${count})` : ""}` : "Password";
  return type ?? "";
}

export function UsersView({ shell, reloadToken }: { shell: Shell; reloadToken: number }) {
  const [tab, setTab] = useState<"users" | "groups">("users");
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<{ key: string; r: Rbac | null; error: AppError | null } | null>(null);
  const [selUsers, setSelUsers] = useState<Set<string>>(new Set());
  const [selGroups, setSelGroups] = useState<Set<string>>(new Set());
  const key = `${reloadToken}|${tick}`;
  useEffect(() => {
    let stale = false;
    ecApi
      .users()
      .then((r) => !stale && setData({ key, r, error: null }))
      .catch((e) => !stale && setData({ key, r: null, error: e as AppError }));
    return () => {
      stale = true;
    };
  }, [key]);
  const r = data?.r ?? null;
  const usersById = useMemo(() => new Map((r?.users ?? []).map((u) => [u.id, u])), [r]);
  const groupsById = useMemo(() => new Map((r?.groups ?? []).map((g) => [g.id, g])), [r]);

  const userRows: Row[] = useMemo(
    () =>
      (r?.users ?? []).map((u) => ({
        key: u.id,
        icon: null,
        isContainer: false,
        dimmed: u.status !== "active",
        cells: {
          id: { text: u.id, sort: u.id },
          name: { text: u.name ?? "", sort: u.name ?? "" },
          status: { text: u.status ?? "", sort: u.status ?? "" },
          engine: { text: engineLabel(u.engine), sort: u.engine ?? "" },
          auth: { text: authLabel(u.authType, u.passwordCount), sort: u.authType ?? "" },
          access: { text: u.accessString ?? "", sort: u.accessString ?? "" },
          groups: { text: u.groupIds.join(", "), sort: u.groupIds.length },
        },
      })),
    [r],
  );
  const groupRows: Row[] = useMemo(
    () =>
      (r?.groups ?? []).map((g) => {
        const caches = [...g.replicationGroups, ...g.serverlessCaches];
        const pending = [g.adding.length ? `adding ${g.adding.join(", ")}` : "", g.removing.length ? `removing ${g.removing.join(", ")}` : ""].filter(Boolean).join("; ");
        return {
          key: g.id,
          icon: null,
          isContainer: false,
          dimmed: g.status !== "active",
          cells: {
            id: { text: g.id, sort: g.id },
            status: { text: g.status ?? "", sort: g.status ?? "" },
            engine: { text: engineLabel(g.engine), sort: g.engine ?? "" },
            users: { text: g.userIds.join(", "), sort: g.userIds.length },
            caches: { text: caches.join(", ") || "none", sort: caches.length },
            pending: { text: pending, sort: pending },
          },
        };
      }),
    [r],
  );

  const user = selUsers.size === 1 ? usersById.get([...selUsers][0]) : undefined;
  const group = selGroups.size === 1 ? groupsById.get([...selGroups][0]) : undefined;
  const usersPlace = { ...EC_ROOT, kind: "users" as const };

  function userMenu(k: string | null, x: number, y: number) {
    const u = k ? usersById.get(k) : undefined;
    if (!u) return;
    shell.openMenu(x, y, [
      { label: "Copy user ID", onClick: () => void shell.copyText(u.id) },
      { label: "Copy user name", disabled: !u.name, onClick: () => u.name && void shell.copyText(u.name) },
      { label: "Copy access string", disabled: !u.accessString, onClick: () => u.accessString && void shell.copyText(u.accessString) },
      { label: "Copy ARN", disabled: !u.arn, onClick: () => u.arn && void shell.copyText(u.arn) },
      "separator",
      { label: "Add bookmark…", onClick: () => shell.addBookmark(usersPlace, u.id, null) },
    ]);
  }
  function groupMenu(k: string | null, x: number, y: number) {
    const g = k ? groupsById.get(k) : undefined;
    if (!g) return;
    shell.openMenu(x, y, [
      ...g.replicationGroups.map((c) => ({ label: `Open ${c}`, onClick: () => shell.navigate({ ...EC_ROOT, kind: "group", id: c }) })),
      ...g.serverlessCaches.map((c) => ({ label: `Open ${c}`, onClick: () => shell.navigate({ ...EC_ROOT, kind: "serverless", id: c }) })),
      ...(g.replicationGroups.length + g.serverlessCaches.length ? ["separator" as const] : []),
      { label: "Copy group ID", onClick: () => void shell.copyText(g.id) },
      { label: "Copy ARN", disabled: !g.arn, onClick: () => g.arn && void shell.copyText(g.arn) },
      "separator",
      { label: "Add bookmark…", onClick: () => shell.addBookmark(usersPlace, g.id, null) },
    ]);
  }

  return (
    <div className="service-pane ec-users">
      <HelpTopic id="elasticache.users" />
      <div className="row ec-snap-bar">
        <div className="segmented small">
          <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>
            Users{r ? ` (${r.users.length})` : ""}
          </button>
          <button className={tab === "groups" ? "active" : ""} onClick={() => setTab("groups")}>
            User groups{r ? ` (${r.groups.length})` : ""}
          </button>
        </div>
        <span className="hint">View only. Passwords are never shown (AWS doesn't return them).</span>
      </div>
      {data?.error ? (
        <ErrorPanel error={data.error} profile={shell.profile} onRetry={() => setTick((x) => x + 1)} />
      ) : tab === "users" ? (
        <>
          <div className="ec-snap-list region">
            <FileList storageKey="elasticache.users" columns={USER_COLUMNS} rows={userRows} selected={selUsers} onSelectionChange={setSelUsers} onOpen={() => undefined} onContextMenu={userMenu} emptyText={!r ? "Loading…" : "No users in this region."} />
          </div>
          {user && (
            <div className="ec-detail">
              <PropsTable
                rows={[
                  ["User ID", user.id],
                  ["User name", user.name],
                  ["Access string", <span className="mono">{user.accessString}</span>],
                  ["Authentication", authLabel(user.authType, user.passwordCount)],
                  ["Minimum engine version", user.minimumEngineVersion],
                  ["User groups", user.groupIds.join(", ") || "None"],
                  ["ARN", user.arn],
                ]}
              />
            </div>
          )}
        </>
      ) : (
        <>
          <div className="ec-snap-list region">
            <FileList storageKey="elasticache.usergroups" columns={GROUP_COLUMNS} rows={groupRows} selected={selGroups} onSelectionChange={setSelGroups} onOpen={() => undefined} onContextMenu={groupMenu} emptyText={!r ? "Loading…" : "No user groups in this region."} />
          </div>
          {group && (
            <div className="ec-detail">
              <div className="props-section">Members of {group.id}</div>
              <table className="sync-table">
                <thead>
                  <tr>
                    <th>User ID</th>
                    <th>User name</th>
                    <th>Authentication</th>
                    <th>Access string</th>
                  </tr>
                </thead>
                <tbody>
                  {group.userIds.map((id) => {
                    const u = usersById.get(id);
                    return (
                      <tr key={id}>
                        <td className="mono">{id}</td>
                        <td>{u?.name ?? ""}</td>
                        <td>{u ? authLabel(u.authType, u.passwordCount) : ""}</td>
                        <td className="mono">{u?.accessString ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="props-section">Used by</div>
              {group.replicationGroups.length + group.serverlessCaches.length === 0 ? (
                <p className="hint">No cache uses this group.</p>
              ) : (
                <div className="row">
                  {group.replicationGroups.map((c) => (
                    <button key={c} className="link-btn" onClick={() => shell.navigate({ ...EC_ROOT, kind: "group", id: c })}>
                      {c}
                    </button>
                  ))}
                  {group.serverlessCaches.map((c) => (
                    <button key={c} className="link-btn" onClick={() => shell.navigate({ ...EC_ROOT, kind: "serverless", id: c })}>
                      {c} (serverless)
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
