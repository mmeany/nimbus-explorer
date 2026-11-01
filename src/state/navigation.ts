import { useCallback, useState } from "react";

/** A place in the S3 hierarchy. bucket=null is the root (list of buckets). */
export interface Location {
  bucket: string | null;
  /** Folder prefix inside the bucket, "" or ending in "/". */
  prefix: string;
}

export const ROOT: Location = { bucket: null, prefix: "" };

export function sameLocation(a: Location, b: Location): boolean {
  return a.bucket === b.bucket && a.prefix === b.prefix;
}

/** Parent of a location: folder -> parent folder -> bucket root -> S3 root. */
export function parentOf(loc: Location): Location | null {
  if (loc.bucket === null) return null;
  if (loc.prefix === "") return ROOT;
  const trimmed = loc.prefix.slice(0, -1);
  const cut = trimmed.lastIndexOf("/");
  return { bucket: loc.bucket, prefix: cut < 0 ? "" : trimmed.slice(0, cut + 1) };
}

/** Breadcrumb segments from root to the location. */
export function breadcrumbs(loc: Location): { label: string; loc: Location }[] {
  const out: { label: string; loc: Location }[] = [];
  if (loc.bucket === null) return out;
  out.push({ label: loc.bucket, loc: { bucket: loc.bucket, prefix: "" } });
  if (loc.prefix === "") return out;
  // Keep empty segments: "a//b/" is a valid prefix with an unnamed middle folder.
  let acc = "";
  for (const part of loc.prefix.slice(0, -1).split("/")) {
    acc += part + "/";
    out.push({ label: part || "(unnamed)", loc: { bucket: loc.bucket, prefix: acc } });
  }
  return out;
}

/** Display name of a folder prefix or object key: its last path segment. */
export function baseName(keyOrPrefix: string): string {
  const trimmed = keyOrPrefix.endsWith("/") ? keyOrPrefix.slice(0, -1) : keyOrPrefix;
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name === "" ? "(unnamed)" : name;
}

/** Folder prefix containing a key: "a/b/c.txt" -> "a/b/", "c.txt" -> "". */
export function parentPrefix(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
}

/** All locations from the bucket root down to (and including) `loc`. */
export function ancestry(loc: Location): Location[] {
  return breadcrumbs(loc).map((c) => c.loc);
}

export function toS3Uri(loc: Location): string {
  return loc.bucket === null ? "s3://" : `s3://${loc.bucket}/${loc.prefix}`;
}

/** Explorer-style history with back/forward over any kind of place. */
export function useHistory<T>(root: T, same: (a: T, b: T) => boolean) {
  const [state, setState] = useState({ stack: [root], index: 0 });
  const current = state.stack[state.index];

  const navigate = useCallback(
    (p: T) => {
      setState((s) => {
        if (same(s.stack[s.index], p)) return s;
        const stack = [...s.stack.slice(0, s.index + 1), p];
        return { stack, index: stack.length - 1 };
      });
    },
    [same],
  );

  const back = useCallback(() => setState((s) => (s.index > 0 ? { ...s, index: s.index - 1 } : s)), []);
  const forward = useCallback(
    () => setState((s) => (s.index < s.stack.length - 1 ? { ...s, index: s.index + 1 } : s)),
    [],
  );
  /** Clears history, starting again at `start` (default: the root). */
  const reset = useCallback((start?: T) => setState({ stack: [start ?? root], index: 0 }), [root]);

  return {
    current,
    navigate,
    back,
    forward,
    reset,
    canBack: state.index > 0,
    canForward: state.index < state.stack.length - 1,
  };
}
