// Parameter Store (SSM) commands.
import { call } from "./core";

export type ParamType = "String" | "StringList" | "SecureString";

export interface ParamInfo {
  name: string;
  paramType: ParamType;
  version: number;
  lastModified: string | null;
  lastModifiedUser: string | null;
  tier: string | null;
  dataType: string | null;
  description: string | null;
  keyId: string | null;
  allowedPattern: string | null;
  policyCount: number;
  policies: ParamPolicy[];
  /** String/StringList value; null for SecureString (or not loaded). */
  value: string | null;
}

export interface ParamPolicy {
  policyType: string;
  /** Policy JSON as stored. */
  text: string;
  status: string;
}

export interface Tag {
  key: string;
  value: string;
}

export interface ParamListing {
  /** Sub-folder paths, each ending in "/". */
  folders: string[];
  parameters: ParamInfo[];
}

export interface PutParam {
  name: string;
  value: string;
  paramType: ParamType;
  description: string | null;
  keyId: string | null;
  allowedPattern: string | null;
  dataType: string | null;
  tier: string | null;
  /** JSON array; "[]" removes; omitted leaves them. */
  policies?: string | null;
  overwrite: boolean;
}

export interface ParamDeleteResult {
  deleted: string[];
  failed: { name: string; message: string }[];
}

export interface ParamVersion {
  version: number;
  paramType: ParamType;
  lastModified: string | null;
  lastModifiedUser: string | null;
  labels: string[];
  description: string | null;
  tier: string | null;
  keyId: string | null;
  dataType: string | null;
  /** null for SecureString: decrypt on demand with getValue(`${name}:${version}`, true). */
  value: string | null;
}

export interface CopyPair {
  from: string;
  to: string;
  /** Destination exists already (planning only). */
  exists: boolean;
}

export interface CopyResult {
  copied: string[];
  skipped: string[];
  failed: { name: string; message: string }[];
}

export type ExportFormat = "json" | "env";
export type ImportAction = "create" | "overwrite" | "unchanged" | "skip";

export interface ImportPreview {
  planId: number;
  rows: { name: string; paramType: string; action: ImportAction; note: string | null }[];
  creates: number;
  overwrites: number;
  unchanged: number;
  skips: number;
}

export const ssmApi = {
  /** Folder view; withValues=false skips loading values (tree expansion). */
  listPath: (path: string, withValues = true) => call<ParamListing>("ssm_list_path", { path, withValues }),
  listPrefix: (prefix: string) => call<ParamListing>("ssm_list_prefix", { prefix }),
  /** Values for the visible page (never SecureString; missing names are left out). */
  values: (names: string[]) => call<Record<string, string>>("ssm_values", { names }),
  describe: (name: string) => call<ParamInfo | null>("ssm_describe", { name }),
  /** decrypt=true only on an explicit user action; never cache the result. */
  getValue: (name: string, decrypt: boolean) => call<string>("ssm_get_value", { name, decrypt }),
  /** Returns the new version. */
  put: (param: PutParam) => call<number>("ssm_put", { param }),
  delete: (names: string[]) => call<ParamDeleteResult>("ssm_delete", { names }),
  /** Oldest first. */
  history: (name: string) => call<ParamVersion[]>("ssm_history", { name }),
  label: (name: string, version: number, labels: string[]) => call<void>("ssm_label", { name, version, labels }),
  unlabel: (name: string, version: number, labels: string[]) => call<void>("ssm_unlabel", { name, version, labels }),
  /** Saves an old version's value as a new version; returns the new version. */
  restore: (name: string, version: number) => call<number>("ssm_restore", { name, version }),
  listTags: (name: string) => call<Tag[]>("ssm_list_tags", { name }),
  /** Makes the tags exactly `tags`. */
  setTags: (name: string, tags: Tag[]) => call<void>("ssm_set_tags", { name, tags }),
  /** Re-writes the value with a new tier / policies; returns the new version. */
  /** Items are names or folders ending in "/"; renameTo renames the single item. */
  planCopy: (items: string[], destFolder: string, renameTo: string | null = null) =>
    call<CopyPair[]>("ssm_plan_copy", { items, destFolder, renameTo }),
  copy: (pairs: CopyPair[], overwrite: boolean, removeSource: boolean) =>
    call<CopyResult>("ssm_copy", { pairs, overwrite, removeSource }),
  /** Decrypted SecureString values only with includeSecrets (ask each time). */
  export: (folder: string, format: ExportFormat, includeSecrets: boolean, dest: string) =>
    call<{ path: string; exported: number; secretsOmitted: number }>("ssm_export", { folder, format, includeSecrets, dest }),
  /** Values stay in the backend; the preview has names and actions only. */
  planImport: (options: { path: string; targetFolder: string | null; defaultType: string }) =>
    call<ImportPreview>("ssm_plan_import", { options }),
  runImport: (planId: number, includeOverwrites: boolean) =>
    call<{ created: number; overwritten: number; failed: { name: string; message: string }[] }>("ssm_run_import", {
      planId,
      includeOverwrites,
    }),
  updateTierPolicies: (name: string, tier: string | null, policies: string | null) =>
    call<number>("ssm_update_tier_policies", { name, tier, policies }),
};
