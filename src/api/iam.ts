// IAM commands (view only). IAM is global: the region switcher doesn't apply.
import { call } from "./core";

export interface UserSummary {
  name: string;
  id: string;
  arn: string;
  path: string;
  created: string | null;
  passwordLastUsed: string | null;
}

export interface GroupSummary {
  name: string;
  id: string;
  arn: string;
  path: string;
  created: string | null;
}

export interface RoleSummary {
  name: string;
  id: string;
  arn: string;
  path: string;
  created: string | null;
  description: string | null;
  maxSessionSecs: number | null;
  serviceLinked: boolean;
}

export interface UserExtras {
  name: string;
  accessKeys: number;
  activeKeys: number;
  keyLastUsed: string | null;
  mfaDevices: number;
  error: string | null;
}

export interface RoleExtras {
  name: string;
  lastUsed: string | null;
  lastUsedRegion: string | null;
  error: string | null;
}

export interface Attached {
  name: string;
  arn: string;
  awsManaged: boolean;
}

export interface Inline {
  name: string;
  /** Decoded JSON text. */
  document: string | null;
  error: string | null;
}

export interface AccessKey {
  id: string;
  status: string | null;
  created: string | null;
  lastUsed: string | null;
  lastService: string | null;
  lastRegion: string | null;
}

export interface UserDetails extends UserSummary {
  boundary: string | null;
  tags: [string, string][];
  groups: GroupSummary[];
  attached: Attached[];
  inline: Inline[];
  /** Console password; null when the user has none. */
  login: { created: string | null; resetRequired: boolean } | null;
  accessKeys: AccessKey[];
  mfa: { serial: string; enabled: string | null; virtualDevice: boolean }[];
}

export interface GroupDetails extends GroupSummary {
  members: UserSummary[];
  attached: Attached[];
  inline: Inline[];
}

export interface Trust {
  effect: string;
  /** Service, AWS, Federated, CanonicalUser, "*" or NotPrincipal. */
  kind: string;
  principal: string;
  actions: string[];
  conditions: boolean;
  sid: string | null;
}

export interface RoleDetails extends RoleSummary {
  trustPolicy: string | null;
  trusted: Trust[];
  boundary: string | null;
  lastUsed: string | null;
  lastUsedRegion: string | null;
  tags: [string, string][];
  attached: Attached[];
  inline: Inline[];
  instanceProfiles: string[];
}

export const iamApi = {
  users: () => call<UserSummary[]>("iam_users"),
  groups: () => call<GroupSummary[]>("iam_groups"),
  roles: () => call<RoleSummary[]>("iam_roles"),
  userExtras: (names: string[]) => call<UserExtras[]>("iam_user_extras", { names }),
  roleExtras: (names: string[]) => call<RoleExtras[]>("iam_role_extras", { names }),
  user: (name: string) => call<UserDetails>("iam_user", { name }),
  group: (name: string) => call<GroupDetails>("iam_group", { name }),
  role: (name: string) => call<RoleDetails>("iam_role", { name }),
};

export type PrincipalKind = "users" | "groups" | "roles";

/** A filter starting with "/" matches the path prefix, anything else the name prefix (ignoring case). */
export function matchesFilter(p: { name: string; path: string }, filter: string): boolean {
  if (!filter) return true;
  if (filter.startsWith("/")) return p.path.startsWith(filter);
  return p.name.toLowerCase().startsWith(filter.toLowerCase());
}

/** "1 hour", "12 hours", "30 minutes". */
export function sessionText(secs: number | null): string {
  if (secs === null) return "";
  if (secs % 3600 === 0) return `${secs / 3600} hour${secs === 3600 ? "" : "s"}`;
  return `${Math.round(secs / 60)} minutes`;
}

/** Who a trust row describes, in words: "Service lambda.amazonaws.com", "Anyone", "Account 123456789012". */
export function trustText(t: Trust): string {
  if (t.kind === "*" || t.principal === "*") return t.kind === "AWS" || t.kind === "*" ? "Anyone (any AWS principal)" : `Any ${t.kind} principal`;
  if (t.kind === "AWS") {
    const root = /^arn:aws[\w-]*:iam::(\d{12}):root$/.exec(t.principal);
    if (root) return `Account ${root[1]} (any principal the account allows)`;
    if (/^\d{12}$/.test(t.principal)) return `Account ${t.principal} (any principal the account allows)`;
    return t.principal;
  }
  return `${t.kind} ${t.principal}`;
}

/** Days since an ISO date (null if none). */
export function daysSince(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((now - t) / 86_400_000);
}
