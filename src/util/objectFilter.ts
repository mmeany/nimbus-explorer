// On-screen filters for the S3 object list (applied to the loaded page).
import type { ObjectInfo } from "../api/s3";

export interface ObjectFilter {
  /** Text anywhere in the name (case-insensitive). */
  name: string;
  /** Extensions, comma or space separated (".json, csv"). */
  types: string;
  minSize: string;
  maxSize: string;
  sizeUnit: "B" | "KB" | "MB" | "GB";
  /** yyyy-mm-dd, inclusive, local time. */
  from: string;
  to: string;
  storageClass: string;
}

export const NO_FILTER: ObjectFilter = { name: "", types: "", minSize: "", maxSize: "", sizeUnit: "MB", from: "", to: "", storageClass: "" };

const UNIT = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

export function extensions(types: string): string[] {
  return types
    .split(/[\s,;]+/)
    .map((t) => t.trim().toLowerCase().replace(/^\*?\./, ""))
    .filter(Boolean);
}

/** Filters that only make sense for files (folders are hidden while any is set). */
function fileOnly(f: ObjectFilter): boolean {
  return !!(extensions(f.types).length || f.minSize || f.maxSize || f.from || f.to || f.storageClass);
}

export function activeCount(f: ObjectFilter): number {
  return [f.name.trim(), extensions(f.types).length, f.minSize || f.maxSize, f.from || f.to, f.storageClass].filter(Boolean).length;
}

const STANDARD = "STANDARD";

/** Applies the filter; `nameOf` gives the display name of a key. */
export function applyFilter(
  folders: string[],
  files: ObjectInfo[],
  f: ObjectFilter,
  nameOf: (key: string) => string,
): { folders: string[]; files: ObjectInfo[] } {
  if (!activeCount(f)) return { folders, files };
  const text = f.name.trim().toLowerCase();
  const exts = extensions(f.types);
  const min = f.minSize !== "" && Number(f.minSize) >= 0 ? Number(f.minSize) * UNIT[f.sizeUnit] : null;
  const max = f.maxSize !== "" && Number(f.maxSize) >= 0 ? Number(f.maxSize) * UNIT[f.sizeUnit] : null;
  const from = f.from ? new Date(`${f.from}T00:00:00`).getTime() : null;
  const to = f.to ? new Date(`${f.to}T23:59:59.999`).getTime() : null;
  const nameOk = (key: string) => !text || nameOf(key).toLowerCase().includes(text);
  return {
    folders: fileOnly(f) ? [] : folders.filter(nameOk),
    files: files.filter((o) => {
      if (!nameOk(o.key)) return false;
      if (exts.length) {
        const n = nameOf(o.key).toLowerCase();
        if (!exts.some((e) => n.endsWith(`.${e}`))) return false;
      }
      if (min !== null && o.size < min) return false;
      if (max !== null && o.size > max) return false;
      if (from !== null || to !== null) {
        const t = o.lastModified ? Date.parse(o.lastModified) : NaN;
        if (Number.isNaN(t) || (from !== null && t < from) || (to !== null && t > to)) return false;
      }
      // ListObjectsV2 may omit the class for STANDARD objects.
      if (f.storageClass && (o.storageClass ?? STANDARD) !== f.storageClass) return false;
      return true;
    }),
  };
}
