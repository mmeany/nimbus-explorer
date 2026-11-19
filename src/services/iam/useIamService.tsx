// IAM controller (view only, global): an overview, then users, user groups and
// roles. Lists load in full and page on screen; access keys / MFA (users) and
// last used (roles) are fetched for the visible page only.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type AppError } from "../../api/s3";
import { iamApi, matchesFilter, sessionText, type GroupSummary, type RoleExtras, type RoleSummary, type UserExtras, type UserSummary } from "../../api/iam";
import { CommandButton } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { FilterBox } from "../../components/FilterBox";
import { HelpTopic } from "../../components/HelpDialog";
import { IamGroupIcon, IamIcon, IamRoleIcon, IamUserIcon, RefreshIcon } from "../../components/Icons";
import { PageBar } from "../../components/PageBar";
import { TreeNote, TreeRow } from "../../components/TreeRow";
import { formatDate } from "../../format";
import { IAM_KIND_LABEL, IAM_ROOT, type IamKind, type Place } from "../../shell/places";
import type { ServiceUi, Shell } from "../../shell/shell";
import { TREE_LIMIT, usePagedDetails, usePaging } from "../../state/paged";
import { GroupView, RoleView, UserView } from "./PrincipalViews";

const KINDS: IamKind[] = ["users", "groups", "roles"];

export const KIND_ICON: Record<IamKind, ReactNode> = { users: <IamUserIcon />, groups: <IamGroupIcon />, roles: <IamRoleIcon /> };

const USER_COLUMNS: Column[] = [
  { id: "name", label: "User", width: 220 },
  { id: "path", label: "Path", width: 120 },
  { id: "keys", label: "Access keys", width: 100 },
  { id: "keyUsed", label: "Key last used", width: 165 },
  { id: "password", label: "Password last used", width: 165 },
  { id: "mfa", label: "MFA", width: 60 },
  { id: "created", label: "Created", width: 165 },
];
const GROUP_COLUMNS: Column[] = [
  { id: "name", label: "User group", width: 260 },
  { id: "path", label: "Path", width: 160 },
  { id: "created", label: "Created", width: 165 },
  { id: "arn", label: "ARN", width: 380 },
];
const ROLE_COLUMNS: Column[] = [
  { id: "name", label: "Role", width: 280 },
  { id: "path", label: "Path", width: 160 },
  { id: "lastUsed", label: "Last used", width: 200 },
  { id: "session", label: "Max session", width: 95 },
  { id: "created", label: "Created", width: 165 },
  { id: "description", label: "Description", width: 320 },
];
const OVERVIEW_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 200 },
  { id: "count", label: "Count", width: 80, align: "right" },
  { id: "about", label: "Description", width: 420 },
];

const ABOUT: Record<IamKind, string> = {
  users: "People and applications with long-term credentials",
  groups: "Collections of users that share permissions",
  roles: "Identities that services, accounts and federated users assume",
};

type Listing<T> = { key: string; items: T[] | null; error: AppError | null };

/** Loads one list for `key` while `enabled`, keeping the last result during a reload. */
function useList<T>(key: string, enabled: boolean, load: () => Promise<T[]>): { listing: Listing<T> | null; loading: boolean } {
  const [listing, setListing] = useState<Listing<T> | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled || listing?.key === key) return;
    let stale = false;
    setLoading(true);
    load()
      .then((items) => !stale && setListing({ key, items, error: null }))
      .catch((e) => !stale && setListing({ key, items: null, error: e as AppError }))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return { listing, loading };
}

function lastUsedText(x: RoleExtras | undefined): string {
  if (!x) return "…";
  if (x.error) return "(couldn't load)";
  if (!x.lastUsed) return "Never (or over 400 days)";
  return `${formatDate(x.lastUsed)}${x.lastUsedRegion ? ` · ${x.lastUsedRegion}` : ""}`;
}

function keysText(x: UserExtras | undefined): string {
  if (!x) return "…";
  if (x.error) return "(couldn't load)";
  if (!x.accessKeys) return "None";
  return x.activeKeys === x.accessKeys ? `${x.accessKeys} active` : `${x.activeKeys} of ${x.accessKeys} active`;
}

export function useIamService(shell: Shell): ServiceUi {
  const { connection, connectionId, profile, place } = shell;
  const active = place.service === "iam";
  const kind = place.service === "iam" ? place.kind : null;
  const id = place.service === "iam" ? place.id : null;
  const go = useCallback((p: Partial<Place & { service: "iam" }>) => shell.navigate({ ...IAM_ROOT, ...p }), [shell]);

  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<IamKind>>(new Set());
  const [reloadToken, setReloadToken] = useState(0);
  const [filters, setFilters] = useState<Record<IamKind, string>>({ users: "", groups: "", roles: "" });
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const historyKey = `iam|${profile ?? ""}|${kind ?? ""}`;

  useEffect(() => {
    setFilters({ users: "", groups: "", roles: "" });
    setSelected(new Set());
  }, [connectionId]);
  useEffect(() => setSelected(new Set()), [kind]);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  useEffect(() => {
    if (kind) setExpanded((s) => (s.has(kind) ? s : new Set([...s, kind])));
  }, [kind]);
  useEffect(() => {
    if (!profile || !kind) return;
    api
      .getSettings()
      .then((s) => setHistory(s.filterHistory?.[historyKey] ?? []))
      .catch(() => setHistory([]));
  }, [historyKey, profile, kind]);

  const enabled = !!connection && (open || active);
  const listKey = `${connectionId}|${reloadToken}`;
  const users = useList<UserSummary>(listKey, enabled, iamApi.users);
  const groups = useList<GroupSummary>(listKey, enabled, iamApi.groups);
  const roles = useList<RoleSummary>(listKey, enabled, iamApi.roles);
  const lists = { users, groups, roles };
  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);

  const filter = kind ? filters[kind] : "";
  function filtered<T extends { name: string; path: string }>(k: IamKind, items: T[] | null | undefined): T[] | null {
    if (!items) return null;
    return filters[k] ? items.filter((p) => matchesFilter(p, filters[k])) : items;
  }
  const fUsers = useMemo(() => filtered("users", users.listing?.items), [users.listing, filters.users]); // eslint-disable-line react-hooks/exhaustive-deps
  const fGroups = useMemo(() => filtered("groups", groups.listing?.items), [groups.listing, filters.groups]); // eslint-disable-line react-hooks/exhaustive-deps
  const fRoles = useMemo(() => filtered("roles", roles.listing?.items), [roles.listing, filters.roles]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = kind === "users" ? fUsers : kind === "groups" ? fGroups : kind === "roles" ? fRoles : null;
  const listing = kind ? lists[kind].listing : null;

  const paging = usePaging(`${listKey}|${kind ?? ""}|${filter}`, current?.length ?? 0, `iam.${kind ?? "x"}.pageSize`, active && !!kind && !id);
  const pageNames = useMemo(() => paging.slice(current ?? []).map((p) => p.name), [paging, current]);
  const userX = usePagedDetails<UserExtras>(`u|${listKey}`, kind === "users" ? pageNames : [], iamApi.userExtras, (x) => x.name, active && kind === "users" && !id);
  const roleX = usePagedDetails<RoleExtras>(`r|${listKey}`, kind === "roles" ? pageNames : [], iamApi.roleExtras, (x) => x.name, active && kind === "roles" && !id);

  async function applyFilter(v: string) {
    if (!kind) return;
    setFilters((f) => ({ ...f, [kind]: v }));
    try {
      setHistory(await api.rememberFilter(historyKey, v));
    } catch {
      /* convenience only */
    }
  }
  async function forget(v: string | null) {
    try {
      setHistory(await api.forgetFilter(historyKey, v));
    } catch {
      /* ignore */
    }
  }

  const rows: Row[] = useMemo(() => {
    const page = new Set(pageNames);
    if (kind === "users")
      return (fUsers ?? [])
        .filter((u) => page.has(u.name))
        .map((u) => {
          const x = userX.details.get(u.name);
          return {
            key: u.name,
            icon: <IamUserIcon />,
            isContainer: false,
            cells: {
              name: { text: u.name, sort: u.name.toLowerCase() },
              path: { text: u.path, sort: u.path },
              keys: { text: keysText(x), sort: x?.activeKeys ?? -1 },
              keyUsed: { text: x?.keyLastUsed ? formatDate(x.keyLastUsed) : x && !x.error && x.accessKeys ? "Never" : "", sort: x?.keyLastUsed ?? "" },
              password: { text: formatDate(u.passwordLastUsed), sort: u.passwordLastUsed ?? "" },
              mfa: { text: !x ? "…" : x.error ? "" : x.mfaDevices ? "Yes" : "No", sort: x?.mfaDevices ?? -1 },
              created: { text: formatDate(u.created), sort: u.created ?? "" },
            },
          };
        });
    if (kind === "groups")
      return (fGroups ?? [])
        .filter((g) => page.has(g.name))
        .map((g) => ({
          key: g.name,
          icon: <IamGroupIcon />,
          isContainer: false,
          cells: {
            name: { text: g.name, sort: g.name.toLowerCase() },
            path: { text: g.path, sort: g.path },
            created: { text: formatDate(g.created), sort: g.created ?? "" },
            arn: { text: g.arn, sort: g.arn },
          },
        }));
    if (kind === "roles")
      return (fRoles ?? [])
        .filter((r) => page.has(r.name))
        .map((r) => {
          const x = roleX.details.get(r.name);
          return {
            key: r.name,
            icon: <IamRoleIcon />,
            isContainer: false,
            dimmed: r.serviceLinked,
            cells: {
              name: { text: r.name, sort: r.name.toLowerCase() },
              path: { text: r.path, sort: r.path },
              lastUsed: { text: lastUsedText(x), sort: x?.lastUsed ?? "" },
              session: { text: sessionText(r.maxSessionSecs), sort: r.maxSessionSecs ?? 0 },
              created: { text: formatDate(r.created), sort: r.created ?? "" },
              description: { text: r.description ?? "", sort: r.description ?? "" },
            },
          };
        });
    return [];
  }, [kind, pageNames, fUsers, fGroups, fRoles, userX.details, roleX.details]);

  function arnOf(k: IamKind, name: string): string | null {
    const items: { name: string; arn: string }[] = lists[k].listing?.items ?? [];
    return items.find((p) => p.name === name)?.arn ?? null;
  }

  function menu(k: IamKind, name: string | null, x: number, y: number) {
    const items: MenuItem[] = [];
    if (name) {
      const arn = arnOf(k, name);
      items.push(
        { label: "Open", bold: true, shortcut: "Enter", onClick: () => go({ kind: k, id: name }) },
        "separator",
        { label: "Copy name", onClick: () => void shell.copyText(name) },
        { label: "Copy ARN", disabled: !arn, onClick: () => arn && void shell.copyText(arn) },
        { label: "Add bookmark…", onClick: () => shell.addBookmark({ ...IAM_ROOT, kind: k, id: name }, null, null) },
        "separator",
      );
    } else {
      items.push({ label: "Add bookmark…", onClick: () => shell.addBookmark({ ...IAM_ROOT, kind: k }, null, null) }, "separator");
    }
    items.push({ label: "Refresh", shortcut: "F5", onClick: refresh });
    shell.openMenu(x, y, items);
  }

  const filteredList: Record<IamKind, { name: string }[] | null> = { users: fUsers, groups: fGroups, roles: fRoles };
  const tree = connection ? (
    <TreeRow depth={1} label="IAM" icon={<IamIcon />} selected={active && !kind} expanded={open} title="IAM · global (the region doesn't apply)" onClick={() => go({})} onToggle={() => setOpen((v) => !v)}>
      {KINDS.map((k) => {
        const items = filteredList[k];
        const err = lists[k].listing?.error;
        return (
          <TreeRow
            key={k}
            depth={2}
            label={filters[k] ? `${IAM_KIND_LABEL[k]} (filtered)` : IAM_KIND_LABEL[k]}
            icon={KIND_ICON[k]}
            selected={active && kind === k && !id}
            expanded={expanded.has(k)}
            onClick={() => go({ kind: k })}
            onToggle={() =>
              setExpanded((s) => {
                const n = new Set(s);
                if (n.has(k)) n.delete(k);
                else n.add(k);
                return n;
              })
            }
            onContextMenu={(x, y) => menu(k, null, x, y)}
          >
            {err ? (
              <TreeNote depth={3}>Couldn't list {IAM_KIND_LABEL[k].toLowerCase()}</TreeNote>
            ) : !items ? (
              <TreeNote depth={3}>Loading…</TreeNote>
            ) : items.length === 0 ? (
              <TreeNote depth={3}>None</TreeNote>
            ) : (
              <>
                {items.slice(0, TREE_LIMIT).map((p) => (
                  <TreeRow key={p.name} depth={3} label={p.name} icon={KIND_ICON[k]} selected={active && kind === k && id === p.name} onClick={() => go({ kind: k, id: p.name })} onContextMenu={(x, y) => menu(k, p.name, x, y)} />
                ))}
                {items.length > TREE_LIMIT && <TreeNote depth={3}>{`${(items.length - TREE_LIMIT).toLocaleString()} more in the list`}</TreeNote>}
              </>
            )}
          </TreeRow>
        );
      })}
    </TreeRow>
  ) : null;

  let content: ReactNode = null;
  let status = "";
  if (active && !kind) {
    const anyError = KINDS.map((k) => lists[k].listing?.error).find(Boolean);
    const overview: Row[] = KINDS.map((k) => ({
      key: k,
      icon: KIND_ICON[k],
      isContainer: true,
      cells: {
        name: { text: IAM_KIND_LABEL[k], sort: KINDS.indexOf(k) },
        count: { text: lists[k].listing?.items ? lists[k].listing!.items!.length.toLocaleString() : lists[k].listing?.error ? "?" : "…", sort: lists[k].listing?.items?.length ?? -1 },
        about: { text: ABOUT[k], sort: k },
      },
    }));
    content = (
      <div className="service-pane">
        <HelpTopic id="iam.overview" />
        <div className="hint iam-note">IAM is global: the region switcher doesn't apply. This view is read only; nothing here changes IAM.</div>
        {anyError ? (
          <ErrorPanel error={anyError} profile={profile} onRetry={refresh} />
        ) : (
          <FileList storageKey="iam.overview" columns={OVERVIEW_COLUMNS} rows={overview} selected={selected} onSelectionChange={setSelected} onOpen={(k) => go({ kind: k as IamKind })} onContextMenu={(k, x, y) => k && menu(k as IamKind, null, x, y)} emptyText="" />
        )}
      </div>
    );
    status = "IAM · global";
  } else if (active && kind && !id) {
    const columns = kind === "users" ? USER_COLUMNS : kind === "groups" ? GROUP_COLUMNS : ROLE_COLUMNS;
    const noun = IAM_KIND_LABEL[kind].toLowerCase();
    content = (
      <div className="service-pane">
        <HelpTopic id={`iam.${kind}`} />
        <FilterBox
          label="Filter:"
          applied={filter}
          history={history}
          placeholder="Name prefix, or a path starting with / (Enter to apply)"
          onApply={(v) => void applyFilter(v)}
          onClear={() => setFilters((f) => ({ ...f, [kind]: "" }))}
          onForget={(v) => void forget(v)}
          onClearHistory={() => void forget(null)}
        />
        {listing?.error ? (
          <ErrorPanel error={listing.error} profile={profile} onRetry={refresh} />
        ) : (
          <>
            <FileList
              storageKey={`iam.${kind}`}
              columns={columns}
              rows={rows}
              selected={selected}
              onSelectionChange={setSelected}
              onOpen={(k) => go({ kind, id: k })}
              onContextMenu={(k, x, y) => menu(kind, k, x, y)}
              emptyText={!current ? "Loading…" : filter ? `No ${noun} match "${filter}".` : `No ${noun} in this account.`}
            />
            {current && current.length > paging.pageSize && <PageBar {...paging.bar} loading={userX.loading || roleX.loading} />}
          </>
        )}
      </div>
    );
    if (current) status = `${current.length.toLocaleString()} ${current.length === 1 ? noun.replace(/s$/, "") : noun}${filter ? ` matching "${filter}"` : ""} · global`;
  } else if (active && kind && id) {
    const view =
      kind === "users" ? (
        <UserView key={id} name={id} shell={shell} reloadToken={reloadToken} />
      ) : kind === "groups" ? (
        <GroupView key={id} name={id} shell={shell} reloadToken={reloadToken} />
      ) : (
        <RoleView key={id} name={id} shell={shell} reloadToken={reloadToken} />
      );
    content = <div className="service-pane scroll-pane">{view}</div>;
    status = `${IAM_KIND_LABEL[kind].replace(/s$/, "")} ${id} · global`;
  }

  const anyLoading = users.loading || groups.loading || roles.loading;
  const commands = active ? <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} /> : null;

  return { tree, content, commands, status, busy: active && anyLoading, refresh, dialogs: null };
}
