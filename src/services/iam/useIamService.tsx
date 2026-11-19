// IAM controller (view only, global): an overview, then users, user groups and
// roles. Lists load in full and page on screen; access keys / MFA (users) and
// last used (roles) are fetched for the visible page only.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type AppError } from "../../api/s3";
import { filterPolicies, iamApi, iamPolicyApi, matchesFilter, sessionText, type PolicyScope, type PolicySummary, type GroupSummary, type RoleExtras, type RoleSummary, type UserExtras, type UserSummary } from "../../api/iam";
import { CommandButton } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { FilterBox } from "../../components/FilterBox";
import { HelpTopic } from "../../components/HelpDialog";
import { IamAccountIcon, IamGroupIcon, IamIcon, IamPolicyIcon, IamRoleIcon, IamUserIcon, RefreshIcon } from "../../components/Icons";
import { PageBar } from "../../components/PageBar";
import { TreeNote, TreeRow } from "../../components/TreeRow";
import { formatDate } from "../../format";
import { IAM_KIND_LABEL, IAM_ROOT, iamIdLabel, type IamKind, type Place } from "../../shell/places";
import type { ServiceUi, Shell } from "../../shell/shell";
import { TREE_LIMIT, usePagedDetails, usePaging } from "../../state/paged";
import { AccountView } from "./AccountView";
import { ValidatePolicyDialog } from "./PolicyValidation";
import { PolicyView } from "./PolicyViews";
import { GroupView, RoleView, UserView } from "./PrincipalViews";

/** The listed kinds ("account" is a single view, not a list). */
const KINDS: IamKind[] = ["users", "groups", "roles", "policies"];

const SINGULAR: Record<IamKind, string> = { users: "user", groups: "user group", roles: "role", policies: "policy", account: "account" };

const SCOPES: [PolicyScope, string][] = [
  ["customer", "Customer managed"],
  ["aws", "AWS managed"],
  ["all", "All"],
];

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* convenience only */
  }
}

/** The row / tree key: names, except policies, which are keyed by ARN (names can repeat across scopes). */
function keyOf(k: IamKind, p: { name: string; arn: string }): string {
  return k === "policies" ? p.arn : p.name;
}

export const KIND_ICON: Record<IamKind, ReactNode> = { users: <IamUserIcon />, groups: <IamGroupIcon />, roles: <IamRoleIcon />, policies: <IamPolicyIcon />, account: <IamAccountIcon /> };

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
const POLICY_COLUMNS: Column[] = [
  { id: "name", label: "Policy", width: 280 },
  { id: "type", label: "Type", width: 130 },
  { id: "attachments", label: "Attachments", width: 95, align: "right" },
  { id: "path", label: "Path", width: 140 },
  { id: "version", label: "Version", width: 70 },
  { id: "updated", label: "Last updated", width: 165 },
  { id: "created", label: "Created", width: 165 },
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
  policies: "Managed policies: customer managed and AWS managed",
  account: "Quotas, password policy, credential report and unused credentials",
};

type Listing<T> = { key: string; items: T[] | null; error: AppError | null };

const NO_LIST = { listing: null, loading: false };

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
  const [validating, setValidating] = useState(false);
  const [expanded, setExpanded] = useState<Set<IamKind>>(new Set());
  const [reloadToken, setReloadToken] = useState(0);
  const [filters, setFilters] = useState<Record<IamKind, string>>({ users: "", groups: "", roles: "", policies: "", account: "" });
  const [scope, setScopeState] = useState<PolicyScope>(() => stored("iam.policies.scope", ["customer", "aws", "all"] as const, "customer"));
  const [attachedOnly, setAttachedOnlyState] = useState(() => stored("iam.policies.attachedOnly", ["1", "0"] as const, "0") === "1");
  const setScope = (s: PolicyScope) => {
    setScopeState(s);
    store("iam.policies.scope", s);
  };
  const setAttachedOnly = (v: boolean) => {
    setAttachedOnlyState(v);
    store("iam.policies.attachedOnly", v ? "1" : "0");
  };
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const historyKey = `iam|${profile ?? ""}|${kind ?? ""}`;

  useEffect(() => {
    setFilters({ users: "", groups: "", roles: "", policies: "", account: "" });
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
  const policies = useList<PolicySummary>(listKey, enabled, iamPolicyApi.policies);
  const lists: Record<IamKind, { listing: Listing<{ name: string; arn: string; path: string }> | null; loading: boolean }> = { users, groups, roles, policies, account: NO_LIST };
  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);

  const filter = kind ? filters[kind] : "";
  function filtered<T extends { name: string; path: string }>(k: IamKind, items: T[] | null | undefined): T[] | null {
    if (!items) return null;
    return filters[k] ? items.filter((p) => matchesFilter(p, filters[k])) : items;
  }
  const fUsers = useMemo(() => filtered("users", users.listing?.items), [users.listing, filters.users]); // eslint-disable-line react-hooks/exhaustive-deps
  const fGroups = useMemo(() => filtered("groups", groups.listing?.items), [groups.listing, filters.groups]); // eslint-disable-line react-hooks/exhaustive-deps
  const fRoles = useMemo(() => filtered("roles", roles.listing?.items), [roles.listing, filters.roles]); // eslint-disable-line react-hooks/exhaustive-deps
  const fPolicies = useMemo(() => (policies.listing?.items ? filterPolicies(policies.listing.items, scope, attachedOnly, filters.policies) : null), [policies.listing, scope, attachedOnly, filters.policies]);
  const current: { name: string; arn: string }[] | null = kind === "users" ? fUsers : kind === "groups" ? fGroups : kind === "roles" ? fRoles : kind === "policies" ? fPolicies : null;
  const listing = kind ? lists[kind].listing : null;

  const paging = usePaging(`${listKey}|${kind ?? ""}|${filter}${kind === "policies" ? `|${scope}|${attachedOnly}` : ""}`, current?.length ?? 0, `iam.${kind ?? "x"}.pageSize`, active && !!kind && !id);
  const pageNames = useMemo(() => paging.slice(current ?? []).map((p) => keyOf(kind ?? "users", p)), [paging, current, kind]);
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
    if (kind === "policies")
      return (fPolicies ?? [])
        .filter((p) => page.has(p.arn))
        .map((p) => ({
          key: p.arn,
          icon: <IamPolicyIcon />,
          isContainer: false,
          dimmed: p.attachments === 0 && p.boundaryUses === 0,
          cells: {
            name: { text: p.name, sort: p.name.toLowerCase() },
            type: { text: p.awsManaged ? "AWS managed" : "Customer managed", sort: p.awsManaged ? 1 : 0 },
            attachments: { text: p.boundaryUses ? `${p.attachments} + ${p.boundaryUses} boundary` : String(p.attachments), sort: p.attachments + p.boundaryUses },
            path: { text: p.path, sort: p.path },
            version: { text: p.defaultVersion ?? "", sort: Number((p.defaultVersion ?? "").replace(/\D/g, "")) || 0 },
            updated: { text: formatDate(p.updated), sort: p.updated ?? "" },
            created: { text: formatDate(p.created), sort: p.created ?? "" },
          },
        }));
    return [];
  }, [kind, pageNames, fUsers, fGroups, fRoles, fPolicies, userX.details, roleX.details]);

  function arnOf(k: IamKind, name: string): string | null {
    if (k === "policies") return name;
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
        { label: "Copy name", onClick: () => void shell.copyText(iamIdLabel(k, name)) },
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

  const filteredList: Record<string, { name: string; arn: string }[] | null> = { users: fUsers, groups: fGroups, roles: fRoles, policies: fPolicies };
  // The account ID, read from the first ARN in this account (IAM has no call that returns it).
  const accountId = useMemo(() => {
    const arns = [users.listing?.items?.[0]?.arn, groups.listing?.items?.[0]?.arn, roles.listing?.items?.[0]?.arn, policies.listing?.items?.find((p) => !p.awsManaged)?.arn];
    for (const a of arns) {
      const m = a && /^arn:aws[\w-]*:iam::(\d{12}):/.exec(a);
      if (m) return m[1];
    }
    return null;
  }, [users.listing, groups.listing, roles.listing, policies.listing]);
  const tree = connection ? (
    <TreeRow depth={1} label="IAM" icon={<IamIcon />} selected={active && !kind} expanded={open} title="IAM · global (the region doesn't apply)" onClick={() => go({})} onToggle={() => setOpen((v) => !v)}>
      {KINDS.map((k) => {
        const items = filteredList[k];
        const err = lists[k].listing?.error;
        return (
          <TreeRow
            key={k}
            depth={2}
            label={filters[k] || (k === "policies" && attachedOnly) ? `${IAM_KIND_LABEL[k]} (filtered)` : IAM_KIND_LABEL[k]}
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
                  <TreeRow key={keyOf(k, p)} depth={3} label={p.name} icon={KIND_ICON[k]} selected={active && kind === k && id === keyOf(k, p)} onClick={() => go({ kind: k, id: keyOf(k, p) })} onContextMenu={(x, y) => menu(k, keyOf(k, p), x, y)} />
                ))}
                {items.length > TREE_LIMIT && <TreeNote depth={3}>{`${(items.length - TREE_LIMIT).toLocaleString()} more in the list`}</TreeNote>}
              </>
            )}
          </TreeRow>
        );
      })}
      <TreeRow
        depth={2}
        label="Account"
        icon={<IamAccountIcon />}
        selected={active && kind === "account"}
        onClick={() => go({ kind: "account" })}
        onContextMenu={(x, y) => shell.openMenu(x, y, [{ label: "Open", bold: true, onClick: () => go({ kind: "account" }) }, { label: "Add bookmark…", onClick: () => shell.addBookmark({ ...IAM_ROOT, kind: "account" }, null, null) }])}
      />
    </TreeRow>
  ) : null;

  function countText(k: IamKind): string {
    if (k === "account") return "";
    const l = lists[k].listing;
    if (!l?.items) return l?.error ? "?" : "…";
    if (k !== "policies") return l.items.length.toLocaleString();
    const aws = (l.items as PolicySummary[]).filter((p) => p.awsManaged).length;
    return `${(l.items.length - aws).toLocaleString()} + ${aws.toLocaleString()} AWS`;
  }

  let content: ReactNode = null;
  let status = "";
  if (active && !kind) {
    const anyError = KINDS.map((k) => lists[k].listing?.error).find(Boolean);
    const overview: Row[] = [...KINDS, "account" as IamKind].map((k) => ({
      key: k,
      icon: KIND_ICON[k],
      isContainer: true,
      cells: {
        name: { text: IAM_KIND_LABEL[k], sort: k === "account" ? KINDS.length : KINDS.indexOf(k) },
        count: { text: countText(k), sort: lists[k].listing?.items?.length ?? -1 },
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
          <FileList storageKey="iam.overview" columns={OVERVIEW_COLUMNS} rows={overview} selected={selected} onSelectionChange={setSelected} onOpen={(k) => go({ kind: k as IamKind })} onContextMenu={(k, x, y) => k && k !== "account" && menu(k as IamKind, null, x, y)} emptyText="" />
        )}
      </div>
    );
    status = "IAM · global";
  } else if (active && kind === "account") {
    content = (
      <div className="service-pane scroll-pane">
        <AccountView shell={shell} accountId={accountId} reloadToken={reloadToken} />
      </div>
    );
    status = `IAM account${accountId ? ` ${accountId}` : ""} · global`;
  } else if (active && kind && !id) {
    const columns = kind === "users" ? USER_COLUMNS : kind === "groups" ? GROUP_COLUMNS : kind === "roles" ? ROLE_COLUMNS : POLICY_COLUMNS;
    const scopeNoun = kind === "policies" && scope !== "all" ? (scope === "aws" ? "AWS managed " : "customer managed ") : "";
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
        >
          {kind === "policies" && (
            <>
              <div className="segmented small">
                {SCOPES.map(([s, label]) => (
                  <button key={s} className={scope === s ? "active" : ""} onClick={() => setScope(s)}>
                    {label}
                  </button>
                ))}
              </div>
              <label className="check-row" title="Only policies attached to a user, user group or role, or used as a permissions boundary">
                <input type="checkbox" checked={attachedOnly} onChange={(e) => setAttachedOnly(e.target.checked)} /> Attached only
              </label>
            </>
          )}
        </FilterBox>
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
              emptyText={!current ? "Loading…" : filter ? `No ${scopeNoun}${noun} match "${filter}".` : `No ${attachedOnly && kind === "policies" ? "attached " : ""}${scopeNoun}${noun} in this account.`}
            />
            {current && current.length > paging.pageSize && <PageBar {...paging.bar} loading={userX.loading || roleX.loading} />}
          </>
        )}
      </div>
    );
    if (current) status = `${current.length.toLocaleString()} ${scopeNoun}${current.length === 1 ? SINGULAR[kind] : noun}${filter ? ` matching "${filter}"` : ""} · global`;
  } else if (active && kind && id) {
    const view =
      kind === "users" ? (
        <UserView key={id} name={id} shell={shell} reloadToken={reloadToken} />
      ) : kind === "groups" ? (
        <GroupView key={id} name={id} shell={shell} reloadToken={reloadToken} />
      ) : kind === "roles" ? (
        <RoleView key={id} name={id} shell={shell} reloadToken={reloadToken} />
      ) : (
        <PolicyView key={id} arn={id} shell={shell} reloadToken={reloadToken} />
      );
    content = <div className="service-pane scroll-pane">{view}</div>;
    const single = SINGULAR[kind];
    status = `${single[0].toUpperCase()}${single.slice(1)} ${iamIdLabel(kind, id)} · global`;
  }

  const anyLoading = users.loading || groups.loading || roles.loading || policies.loading;
  const commands = active ? (
    <>
      <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} />
      <CommandButton icon={<IamPolicyIcon />} label="Validate policy…" title="Check pasted policy JSON with IAM Access Analyzer" disabled={!connection} onClick={() => setValidating(true)} />
    </>
  ) : null;

  return { tree, content, commands, status, busy: active && anyLoading, refresh, dialogs: validating ? <ValidatePolicyDialog onClose={() => setValidating(false)} /> : null };
}
