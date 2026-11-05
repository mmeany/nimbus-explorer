// Shared IPC layer. src/api/ is the only place that calls invoke(); each
// service has its own file (s3.ts, ssm.ts, …) built on `call`.
import { invoke } from "@tauri-apps/api/core";

export interface ProfileInfo {
  name: string;
  region: string | null;
  endpointUrl: string | null;
  /** The profile's sso_session, if it uses one. */
  ssoSession: string | null;
}

/** How a profile is shown in the profile list: "sso-session (profile)" for SSO session profiles. */
export function profileLabel(p: ProfileInfo): string {
  return p.ssoSession ? `${p.ssoSession} (${p.name})` : p.name;
}

/** Profiles sorted by their label, so profiles sharing an SSO session sit together. */
export function sortProfiles(list: ProfileInfo[]): ProfileInfo[] {
  return [...list].sort((a, b) => profileLabel(a).localeCompare(profileLabel(b), undefined, { sensitivity: "base", numeric: true }));
}

export interface ConnectionOverride {
  /** null = use the profile's endpoint_url (or real AWS). */
  endpointUrl: string | null;
  /** null = automatic (on for custom endpoints). */
  pathStyle: boolean | null;
}

export type ThemePref = "system" | "light" | "dark";

export interface Settings {
  lastProfile: string | null;
  theme: ThemePref;
  overrides: Record<string, ConnectionOverride>;
  /** profile -> selected service region */
  regions: Record<string, string>;
  /** Remembered filters, newest first, keyed "<service>|<profile>|<region>". */
  filterHistory: Record<string, string[]>;
  /** Activity history options (see api/history.ts). */
  history: import("./history").HistorySettings;
}

export interface ConnectionInfo {
  profile: string;
  region: string;
  endpointUrl: string | null;
  endpointSource: "override" | "profile" | null;
  pathStyle: boolean;
  /** Region for Parameter Store, SQS, DynamoDB, Secrets Manager (S3 buckets use their own). */
  serviceRegion: string;
  /** Read-only mode for this profile: writes are disabled (and refused by the backend). */
  readOnly: boolean;
}

export type ErrorKind =
  | "notConnected"
  | "ssoExpired"
  | "noCredentials"
  | "unreachable"
  | "accessDenied"
  | "readOnly"
  | "other";

export interface AppError {
  kind: ErrorKind;
  message: string;
  detail: string;
}

/** Normalises anything thrown by invoke() into an AppError. */
export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "kind" in e && "message" in e) {
    return e as AppError;
  }
  const message = e instanceof Error ? e.message : String(e);
  return { kind: "other", message, detail: message };
}

/** Sees every finished command (the activity history, src/history/recorder.ts). */
export type CallObserver = (cmd: string, args: Record<string, unknown>, result: unknown, error: AppError | null) => void;
let observer: CallObserver | null = null;

export function setCallObserver(o: CallObserver | null) {
  observer = o;
}

function observe(cmd: string, args: Record<string, unknown> | undefined, result: unknown, error: AppError | null) {
  try {
    observer?.(cmd, args ?? {}, result, error);
  } catch {
    /* history must never break the command it records */
  }
}

/** Invokes a Rust command, normalising errors to AppError. */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  let result: T;
  try {
    result = await invoke<T>(cmd, args);
  } catch (e) {
    const err = toAppError(e);
    observe(cmd, args, undefined, err);
    throw err;
  }
  observe(cmd, args, result, null);
  return result;
}
