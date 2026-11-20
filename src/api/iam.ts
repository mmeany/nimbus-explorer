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
  /** Services the trust policy allows (for role pickers). */
  trustedServices: string[];
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

// ---------------------------------------------------------------------------
// Policy simulator (16.4)

export interface ContextIn {
  key: string;
  type: string;
  values: string[];
}

export interface SimRequest {
  kind: "users" | "groups" | "roles";
  name: string;
  arn: string;
  actions: string[];
  resources: string[];
  context: ContextIn[];
  extraPolicy: string | null;
}

export interface Matched {
  sourceId: string;
  sourceType: string | null;
  policy: string | null;
  document: string | null;
  /** 1-based [line, column]. */
  start: [number, number] | null;
  end: [number, number] | null;
}

export interface SimResult {
  action: string;
  resource: string;
  decision: "allowed" | "explicitDeny" | "implicitDeny" | string;
  matched: Matched[];
  missingContext: string[];
  boundaryAllowed: boolean | null;
  organizationsAllowed: boolean | null;
  details: [string, string][];
}

export const iamSimApi = {
  simulate: (request: SimRequest) => call<SimResult[]>("iam_simulate", { request }),
};

export const CONTEXT_TYPES = ["string", "stringList", "numeric", "numericList", "boolean", "booleanList", "ip", "ipList", "binary", "binaryList", "date", "dateList"] as const;

/** Splits on commas, whitespace and new lines; drops blanks and repeats (keeping order). */
export function splitList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

/** Action names, and a message for the first one the simulator would refuse (it needs exact names). */
export function parseActions(text: string): { actions: string[]; error: string | null } {
  const actions = splitList(text);
  for (const a of actions) {
    if (/[*?]/.test(a)) return { actions, error: `${a}: the simulator needs exact action names; wildcards aren't supported.` };
    if (!/^[A-Za-z0-9-]+:[A-Za-z0-9]+$/.test(a)) return { actions, error: `${a}: actions look like service:Action, for example s3:GetObject.` };
  }
  return { actions, error: null };
}

export function decisionText(d: string): string {
  return d === "allowed" ? "Allowed" : d === "explicitDeny" ? "Denied (explicit)" : d === "implicitDeny" ? "Denied (implicit)" : d;
}

/**
 * A document split around a statement from 1-based [line, column] positions
 * (end column inclusive). Positions outside the text give null.
 */
export function statementRange(doc: string, start: [number, number] | null, end: [number, number] | null): [string, string, string] | null {
  if (!start || !end) return null;
  const lines = doc.split("\n");
  const offset = ([line, col]: [number, number]) => {
    if (line < 1 || line > lines.length || col < 1) return -1;
    let o = 0;
    for (let i = 0; i < line - 1; i++) o += lines[i].length + 1;
    return Math.min(o + col - 1, o + lines[line - 1].length);
  };
  const a = offset(start);
  const b = offset(end);
  if (a < 0 || b < a) return null;
  return [doc.slice(0, a), doc.slice(a, b + 1), doc.slice(b + 1)];
}

// ---------------------------------------------------------------------------
// Policy validation with Access Analyzer (16.5)

export type PolicyKind = "identity" | "trust" | "resource" | "scp" | "rcp";

export interface FindingLocation {
  path: string;
  /** 0-based offsets: start inclusive, end exclusive. */
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface Finding {
  severity: "ERROR" | "SECURITY_WARNING" | "WARNING" | "SUGGESTION" | string;
  issueCode: string;
  details: string;
  learnMore: string;
  locations: FindingLocation[];
}

export const iamValidateApi = {
  validate: (document: string, kind: PolicyKind, resourceType: string | null = null) => call<Finding[]>("iam_validate_policy", { request: { document, kind, resourceType } }),
};

export const SEVERITIES = ["ERROR", "SECURITY_WARNING", "WARNING", "SUGGESTION"] as const;

export const SEVERITY_LABEL: Record<string, string> = { ERROR: "Errors", SECURITY_WARNING: "Security warnings", WARNING: "Warnings", SUGGESTION: "Suggestions" };

export const POLICY_KIND_LABEL: Record<PolicyKind, string> = {
  identity: "Identity policy",
  trust: "Role trust policy",
  resource: "Resource policy",
  scp: "Service control policy (SCP)",
  rcp: "Resource control policy (RCP)",
};

export const RESOURCE_TYPES = ["AWS::S3::Bucket", "AWS::S3::AccessPoint", "AWS::S3::MultiRegionAccessPoint", "AWS::S3ObjectLambda::AccessPoint", "AWS::S3Express::DirectoryBucket", "AWS::S3Express::AccessPoint", "AWS::DynamoDB::Table", "AWS::DynamoDB::Stream"] as const;

function severityRank(s: string): number {
  const i = (SEVERITIES as readonly string[]).indexOf(s);
  return i < 0 ? SEVERITIES.length : i;
}

/** Findings in severity order, each with its index in `findings`. */
export function groupFindings(findings: Finding[]): { severity: string; items: { f: Finding; index: number }[] }[] {
  const groups = new Map<string, { f: Finding; index: number }[]>();
  findings.forEach((f, index) => groups.set(f.severity, [...(groups.get(f.severity) ?? []), { f, index }]));
  return [...groups.entries()].sort((a, b) => severityRank(a[0]) - severityRank(b[0])).map(([severity, items]) => ({ severity, items }));
}

export interface Segment {
  text: string;
  /** The most severe finding covering this text, if any. */
  severity: string | null;
  /** Covered by the selected finding. */
  selected: boolean;
}

/** The document cut into runs, marked by the findings' locations (offsets clamped to the text). */
export function highlightSegments(doc: string, findings: Finding[], selected: number | null): Segment[] {
  const spans = findings.flatMap((f, i) =>
    f.locations.map((l) => ({ start: Math.max(0, Math.min(doc.length, l.start)), end: Math.max(0, Math.min(doc.length, Math.max(l.end, l.start + 1))), rank: severityRank(f.severity), severity: f.severity, i })),
  );
  const cuts = [...new Set([0, doc.length, ...spans.flatMap((s) => [s.start, s.end])])].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const [a, b] = [cuts[k], cuts[k + 1]];
    const over = spans.filter((s) => s.start <= a && s.end >= b);
    const top = over.sort((x, y) => x.rank - y.rank)[0];
    const seg = { text: doc.slice(a, b), severity: top?.severity ?? null, selected: over.some((s) => s.i === selected) };
    const last = out[out.length - 1];
    if (last && last.severity === seg.severity && last.selected === seg.selected) last.text += seg.text;
    else out.push(seg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Role picker and role links (16.6)

/** The account in an ARN (its fifth field), or null. */
export function accountOf(arn: string | null | undefined): string | null {
  const a = arn?.split(":")[4];
  return a && /^\d{12}$/.test(a) ? a : null;
}

/**
 * The role name to open in IAM for a role ARN shown on a resource, or null
 * when it isn't a role ARN or belongs to another account than the resource.
 */
export function roleLinkName(roleArn: string | null | undefined, ownerArn: string | null | undefined): string | null {
  const m = roleArn ? /^arn:aws[\w-]*:iam::(\d{12}):role\/(?:.*\/)?([^/]+)$/.exec(roleArn) : null;
  if (!m) return null;
  return accountOf(ownerArn) === m[1] ? m[2] : null;
}

/** Roles that trust `service` first (by name), then the others; filtered by name prefix or path. */
export function pickerRoles(roles: RoleSummary[], service: string, showAll: boolean, filter: string): { trusting: RoleSummary[]; others: RoleSummary[] } {
  const f = roles.filter((r) => !r.serviceLinked && matchesFilter(r, filter.trim()));
  const trusting = f.filter((r) => r.trustedServices.includes(service));
  return { trusting, others: showAll ? f.filter((r) => !r.trustedServices.includes(service)) : [] };
}
