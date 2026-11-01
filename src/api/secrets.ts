// Secrets Manager commands. Values are fetched only on explicit Reveal / Copy /
// Edit and must never be cached.
import { call } from "./core";

export interface SecretInfo {
  name: string;
  arn: string | null;
  description: string | null;
  kmsKeyId: string | null;
  created: string | null;
  lastChanged: string | null;
  lastAccessed: string | null;
  rotationEnabled: boolean;
  rotationLambdaArn: string | null;
  rotationSchedule: string | null;
  lastRotated: string | null;
  nextRotation: string | null;
  /** Scheduled for deletion on this date (restorable until then). */
  deletedDate: string | null;
  primaryRegion: string | null;
  owningService: string | null;
  tags: [string, string][];
}

export interface SecretValue {
  text: string | null;
  binaryBase64: string | null;
  versionId: string | null;
  stages: string[];
  created: string | null;
}

export interface VersionInfo {
  versionId: string;
  stages: string[];
  created: string | null;
  lastAccessed: string | null;
}

export interface NewValue {
  text: string | null;
  binaryBase64: string | null;
}

export const smApi = {
  list: (prefix = "") => call<SecretInfo[]>("sm_list", { prefix }),
  describe: (id: string) => call<SecretInfo>("sm_describe", { id }),
  /** Decrypts now. Never cache the result. */
  getValue: (id: string, versionId: string | null = null, stage: string | null = null) =>
    call<SecretValue>("sm_get_value", { id, versionId, stage }),
  /** Returns the ARN. */
  create: (name: string, value: NewValue, description: string | null, kmsKeyId: string | null, tags: [string, string][]) =>
    call<string>("sm_create", { name, value, description, kmsKeyId, tags }),
  /** New version labelled AWSCURRENT; returns the version id. */
  putValue: (id: string, value: NewValue) => call<string>("sm_put_value", { id, value }),
  updateMetadata: (id: string, description: string | null, kmsKeyId: string | null) =>
    call<void>("sm_update_metadata", { id, description, kmsKeyId }),
  /** Returns the deletion date. */
  delete: (id: string, recoveryDays: number | null, force: boolean) => call<string | null>("sm_delete", { id, recoveryDays, force }),
  restore: (id: string) => call<void>("sm_restore", { id }),
  /** Newest first. */
  listVersions: (id: string) => call<VersionInfo[]>("sm_list_versions", { id }),
  /** Move / attach (to) or remove (from only) a staging label. */
  moveLabel: (id: string, stage: string, to: string | null, from: string | null) => call<void>("sm_move_label", { id, stage, to, from }),
  /** Turns rotation on / changes it. schedule: rate(…) or cron(…). */
  configureRotation: (id: string, lambdaArn: string | null, schedule: string, window: string | null, rotateNow: boolean) =>
    call<void>("sm_configure_rotation", { id, lambdaArn, schedule, window, rotateNow }),
  rotateNow: (id: string) => call<void>("sm_rotate_now", { id }),
  cancelRotation: (id: string) => call<void>("sm_cancel_rotation", { id }),
  setTags: (id: string, tags: [string, string][]) => call<void>("sm_set_tags", { id, tags }),
  getPolicy: (id: string) => call<string | null>("sm_get_policy", { id }),
  validatePolicy: (id: string, policy: string) => call<{ valid: boolean; errors: string[] }>("sm_validate_policy", { id, policy }),
  putPolicy: (id: string, policy: string, blockPublic: boolean) => call<void>("sm_put_policy", { id, policy, blockPublic }),
  deletePolicy: (id: string) => call<void>("sm_delete_policy", { id }),
};

/** Direct children of `path` ("" or "a/b/"): sub-folders and secret names. */
export function childrenOf(path: string, names: string[]): { folders: string[]; secrets: string[] } {
  const folders = new Set<string>();
  const secrets: string[] = [];
  for (const n of names) {
    if (!n.startsWith(path)) continue;
    const rest = n.slice(path.length);
    const i = rest.indexOf("/");
    if (i >= 0) folders.add(path + rest.slice(0, i + 1));
    else secrets.push(n);
  }
  return { folders: [...folders].sort(), secrets: secrets.sort() };
}

/** Last segment ("a/b/" → "b", "a/b/c" → "c"). */
export function segment(nameOrPath: string): string {
  const t = nameOrPath.endsWith("/") ? nameOrPath.slice(0, -1) : nameOrPath;
  return t.slice(t.lastIndexOf("/") + 1) || "(unnamed)";
}

/** Mirrors the backend: 1–512 of letters, digits and / _ + = . @ - */
export function secretNameProblem(name: string): string | null {
  if (!name || name.length > 512) return "Names must be 1 to 512 characters";
  if (!/^[A-Za-z0-9/_+=.@-]+$/.test(name)) return "Use letters, digits and / _ + = . @ - only";
  if (/-[A-Za-z0-9]{6}$/.test(name)) return null; // allowed, but see the warning in the editor
  return null;
}

/** Mirrors the backend check of rotation schedules. */
export function scheduleProblem(expr: string): string | null {
  const e = expr.trim();
  const rate = /^rate\((\d+) (days?|hours?)\)$/.exec(e);
  if (rate) {
    const n = Number(rate[1]);
    if (rate[2].startsWith("day")) return n >= 1 && n <= 1000 ? null : "Rates in days must be 1 to 1000";
    return n >= 4 && n <= 23 ? null : "Rates in hours must be 4 to 23";
  }
  const cron = /^cron\((.*)\)$/.exec(e);
  if (cron) return cron[1].trim().split(/\s+/).length === 6 ? null : "cron() needs six fields: minutes hours day-of-month month day-of-week year";
  return "Use rate(30 days), rate(4 hours) or cron(…)";
}
