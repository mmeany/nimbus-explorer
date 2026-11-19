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

// ---------------------------------------------------------------------------
// Managed policies (16.2)

export interface PolicySummary {
  name: string;
  id: string;
  arn: string;
  path: string;
  defaultVersion: string | null;
  attachments: number;
  boundaryUses: number;
  attachable: boolean;
  created: string | null;
  updated: string | null;
  awsManaged: boolean;
}

export interface Entity {
  name: string;
  id: string;
}

export interface PolicyEntities {
  users: Entity[];
  groups: Entity[];
  roles: Entity[];
}

export interface PolicyDetails extends PolicySummary {
  description: string | null;
  tags: [string, string][];
  /** The default version's document (decoded JSON text). */
  document: string | null;
  /** Newest first. */
  versions: { id: string; default: boolean; created: string | null }[];
  attachedTo: PolicyEntities;
  boundaryFor: PolicyEntities;
}

export const iamPolicyApi = {
  policies: () => call<PolicySummary[]>("iam_policies"),
  policy: (arn: string) => call<PolicyDetails>("iam_policy", { arn }),
  version: (arn: string, version: string) => call<string>("iam_policy_version", { arn, version }),
};

export type PolicyScope = "customer" | "aws" | "all";

/** Policies of a scope, optionally only those attached somewhere, then the name / path filter. */
export function filterPolicies(items: PolicySummary[], scope: PolicyScope, attachedOnly: boolean, filter: string): PolicySummary[] {
  return items.filter(
    (p) =>
      (scope === "all" || (scope === "aws") === p.awsManaged) &&
      (!attachedOnly || p.attachments > 0 || p.boundaryUses > 0) &&
      matchesFilter(p, filter),
  );
}

/** A managed policy's name from its ARN (arn:aws:iam::aws:policy/service-role/X → X). */
export function policyNameOf(arn: string): string {
  const i = arn.indexOf(":policy/");
  return i < 0 ? arn : arn.slice(arn.lastIndexOf("/") + 1);
}

export function entityCount(e: PolicyEntities): number {
  return e.users.length + e.groups.length + e.roles.length;
}

/** JSON pretty-printed (2 spaces) so documents stored on one line or with other spacing compare line by line; other text as it is. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Account overview and credential report (16.3)

export interface PasswordPolicy {
  minLength: number | null;
  requireSymbols: boolean;
  requireNumbers: boolean;
  requireUppercase: boolean;
  requireLowercase: boolean;
  allowUsersToChange: boolean;
  expirePasswords: boolean;
  maxAgeDays: number | null;
  reusePrevention: number | null;
  hardExpiry: boolean | null;
}

export interface AccountInfo {
  alias: string | null;
  summary: [string, number][];
  passwordPolicy: PasswordPolicy | null;
}

export interface KeyCredential {
  slot: number;
  active: boolean;
  lastRotated: string | null;
  lastUsed: string | null;
  lastRegion: string | null;
  lastService: string | null;
}

export interface CredentialRow {
  /** "<root_account>" for the root user. */
  user: string;
  arn: string;
  created: string | null;
  /** null for the root user. */
  passwordEnabled: boolean | null;
  passwordLastUsed: string | null;
  passwordLastChanged: string | null;
  passwordNextRotation: string | null;
  mfaActive: boolean;
  keys: KeyCredential[];
  certificatesActive: number;
}

export interface CredentialReport {
  generated: string | null;
  rows: CredentialRow[];
}

export const iamAccountApi = {
  account: () => call<AccountInfo>("iam_account"),
  credentialReport: (regenerate: boolean) => call<CredentialReport>("iam_credential_report", { regenerate }),
  exportCredentialReport: (dest: string) => call<number>("iam_export_credential_report", { dest }),
};

export const ROOT_USER = "<root_account>";

/** Usage against a quota, from GetAccountSummary: [label, used, quota]. */
export function quotaRows(summary: [string, number][]): [string, number, number][] {
  const m = new Map(summary);
  const pairs: [string, string, string][] = [
    ["Users", "Users", "UsersQuota"],
    ["User groups", "Groups", "GroupsQuota"],
    ["Roles", "Roles", "RolesQuota"],
    ["Customer managed policies", "Policies", "PoliciesQuota"],
    ["Policy versions in use", "PolicyVersionsInUse", "PolicyVersionsInUseQuota"],
    ["Instance profiles", "InstanceProfiles", "InstanceProfilesQuota"],
    ["Server certificates", "ServerCertificates", "ServerCertificatesQuota"],
    ["Identity providers", "Providers", "ProvidersQuota"],
  ];
  return pairs.filter(([, u, q]) => m.has(u) && m.has(q)).map(([label, u, q]) => [label, m.get(u)!, m.get(q)!]);
}

/** Per-principal limits from GetAccountSummary (keys ending in "Quota" that have no usage count). */
export function limitRows(summary: [string, number][]): [string, number][] {
  const paired = new Set(["UsersQuota", "GroupsQuota", "RolesQuota", "PoliciesQuota", "PolicyVersionsInUseQuota", "InstanceProfilesQuota", "ServerCertificatesQuota", "ProvidersQuota"]);
  return summary
    .filter(([k]) => k.endsWith("Quota") && !paired.has(k))
    .map(([k, v]): [string, number] => [k.replace(/Quota$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), v]);
}

export interface UnusedFinding {
  user: string;
  /** "Console password", "Access key 1", "Access key 2". */
  credential: string;
  /** What's wrong, in words. */
  issue: string;
  lastUsed: string | null;
  /** Days since last use, or since creation / rotation when never used. */
  days: number | null;
  kind: "never" | "unused" | "old";
}

/**
 * Credentials worth a look: passwords and active access keys never used or
 * not used for more than `unusedDays`, and active keys not rotated for more
 * than `ageDays`. Inactive keys are left out (they can't be used).
 */
export function unusedCredentials(rows: CredentialRow[], unusedDays: number, ageDays: number, now = Date.now()): UnusedFinding[] {
  const out: UnusedFinding[] = [];
  for (const r of rows) {
    if (r.passwordEnabled) {
      const since = daysSince(r.passwordLastUsed, now);
      if (since === null) out.push({ user: r.user, credential: "Console password", issue: "Never used", lastUsed: null, days: daysSince(r.passwordLastChanged ?? r.created, now), kind: "never" });
      else if (since > unusedDays) out.push({ user: r.user, credential: "Console password", issue: `Not used for ${since} days`, lastUsed: r.passwordLastUsed, days: since, kind: "unused" });
    }
    for (const k of r.keys) {
      if (!k.active) continue;
      const credential = `Access key ${k.slot}`;
      const since = daysSince(k.lastUsed, now);
      const age = daysSince(k.lastRotated, now);
      if (since === null) out.push({ user: r.user, credential, issue: "Never used", lastUsed: null, days: age, kind: "never" });
      else if (since > unusedDays) out.push({ user: r.user, credential, issue: `Not used for ${since} days`, lastUsed: k.lastUsed, days: since, kind: "unused" });
      if (age !== null && age > ageDays) out.push({ user: r.user, credential, issue: `Not rotated for ${age} days`, lastUsed: k.lastUsed, days: age, kind: "old" });
    }
  }
  return out;
}
