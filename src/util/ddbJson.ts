// DynamoDB JSON ({"S": "x"}) ↔ plain JSON, cell display, and expression
// building for the Scan / Query form.
//
// Plain JSON uses explicit markers where JSON has no equivalent:
//   {"$N": "123456789012345678901"}  numbers that a JS number can't hold exactly
//   {"$B": "<base64>"}                binary
//   {"$SS": [...]}, {"$NS": [...]}, {"$BS": [...]}  sets

export type DdbValue = Record<string, unknown>;
export type DdbItem = Record<string, DdbValue>;

const MARKERS = ["$N", "$B", "$SS", "$NS", "$BS"];

/** Canonical decimal text: no "+", no leading zeros, no trailing fraction zeros. */
function canonical(n: string): string {
  let t = n.trim().replace(/^\+/, "");
  const neg = t.startsWith("-");
  if (neg) t = t.slice(1);
  if (/e/i.test(t)) return (neg ? "-" : "") + t.toLowerCase();
  let [i, f = ""] = t.split(".");
  i = i.replace(/^0+(?=\d)/, "");
  f = f.replace(/0+$/, "");
  const out = f ? `${i || "0"}.${f}` : i || "0";
  return out === "0" ? "0" : (neg ? "-" : "") + out;
}

/** True if a JS number holds `n` exactly (so it can be shown as a plain number). */
export function safeNumber(n: string): boolean {
  const x = Number(n);
  return Number.isFinite(x) && String(x) === canonical(n);
}

export function toPlain(v: DdbValue): unknown {
  const [t, inner] = Object.entries(v)[0] ?? ["NULL", true];
  switch (t) {
    case "S":
      return inner;
    case "N":
      return safeNumber(String(inner)) ? Number(inner) : { $N: String(inner) };
    case "B":
      return { $B: inner };
    case "BOOL":
      return inner;
    case "NULL":
      return null;
    case "M":
      return Object.fromEntries(Object.entries(inner as Record<string, DdbValue>).map(([k, x]) => [k, toPlain(x)]));
    case "L":
      return (inner as DdbValue[]).map(toPlain);
    case "SS":
      return { $SS: inner };
    case "NS":
      return { $NS: inner };
    case "BS":
      return { $BS: inner };
    default:
      return null;
  }
}

export function itemToPlain(item: DdbItem): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, toPlain(v)]));
}

/** Plain JSON → DynamoDB JSON. Throws with a path on values DynamoDB can't hold. */
export function fromPlain(v: unknown, path = "value"): DdbValue {
  if (v === null || v === undefined) return { NULL: true };
  if (typeof v === "string") return { S: v };
  if (typeof v === "boolean") return { BOOL: v };
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`${path}: ${v} isn't a number DynamoDB can store`);
    return { N: String(v) };
  }
  if (Array.isArray(v)) return { L: v.map((x, i) => fromPlain(x, `${path}[${i}]`)) };
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && MARKERS.includes(keys[0])) {
      const m = keys[0];
      const x = o[m];
      if (m === "$N") {
        if (typeof x !== "string" || !Number.isFinite(Number(x))) throw new Error(`${path}: $N needs a number as text`);
        return { N: x.trim() };
      }
      if (m === "$B") {
        if (typeof x !== "string") throw new Error(`${path}: $B needs base64 text`);
        return { B: x };
      }
      if (!Array.isArray(x) || x.length === 0) throw new Error(`${path}: ${m} needs a non-empty array`);
      if (new Set(x.map(String)).size !== x.length) throw new Error(`${path}: ${m} can't contain duplicates`);
      if (m === "$SS") return { SS: x.map((e) => String(e)) };
      if (m === "$NS") {
        const bad = x.find((e) => !Number.isFinite(Number(e)));
        if (bad !== undefined) throw new Error(`${path}: ${JSON.stringify(bad)} isn't a number`);
        return { NS: x.map((e) => String(e)) };
      }
      return { BS: x.map((e) => String(e)) };
    }
    return { M: Object.fromEntries(keys.map((k) => [k, fromPlain(o[k], `${path}.${k}`)])) };
  }
  throw new Error(`${path}: unsupported value`);
}

export function itemFromPlain(o: unknown): DdbItem {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("An item must be a JSON object");
  return Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, fromPlain(v, k)]));
}

/** The DynamoDB type letter of a value ("S", "N", "M", …). */
export function ddbType(v: DdbValue | undefined): string {
  return v ? (Object.keys(v)[0] ?? "") : "";
}

/** Short text for a grid cell. */
export function cellText(v: DdbValue | undefined): string {
  if (!v) return "";
  const [t, inner] = Object.entries(v)[0];
  switch (t) {
    case "S":
      return String(inner);
    case "N":
      return String(inner);
    case "BOOL":
      return String(inner);
    case "NULL":
      return "null";
    case "B":
      return `<binary ${Math.floor((String(inner).length * 3) / 4)} B>`;
    case "M": {
      const n = Object.keys(inner as object).length;
      return `{${n} key${n === 1 ? "" : "s"}}`;
    }
    case "L":
      return `[${(inner as unknown[]).length} item${(inner as unknown[]).length === 1 ? "" : "s"}]`;
    case "SS":
    case "NS":
      return `{${(inner as string[]).join(", ")}}`;
    case "BS":
      return `{${(inner as string[]).length} binary}`;
    default:
      return "";
  }
}

/** Typed DynamoDB JSON from text typed into a form (S, N, B, BOOL or NULL). */
export function typedValue(text: string, type: string): DdbValue {
  switch (type) {
    case "N": {
      const t = text.trim();
      if (!t || !Number.isFinite(Number(t))) throw new Error(`"${text}" isn't a number`);
      return { N: t };
    }
    case "B":
      return { B: text.trim() };
    case "BOOL": {
      const t = text.trim().toLowerCase();
      if (t !== "true" && t !== "false") throw new Error("Enter true or false");
      return { BOOL: t === "true" };
    }
    case "NULL":
      return { NULL: true };
    default:
      return { S: text };
  }
}

// ---------------------------------------------------------------------------
// Expressions

/** Accumulates #name / :value placeholders. */
export class Placeholders {
  names: Record<string, string> = {};
  values: Record<string, DdbValue> = {};
  private n = 0;
  private v = 0;

  /** "#n0" for an attribute path; dots split nested map keys ("a.b" → #n0.#n1). */
  name(path: string): string {
    return path
      .split(".")
      .map((seg) => {
        const existing = Object.entries(this.names).find(([, x]) => x === seg);
        if (existing) return existing[0];
        const key = `#n${this.n++}`;
        this.names[key] = seg;
        return key;
      })
      .join(".");
  }

  value(v: DdbValue): string {
    const key = `:v${this.v++}`;
    this.values[key] = v;
    return key;
  }
}

export type SortOp = "" | "=" | "<" | "<=" | ">" | ">=" | "between" | "begins_with";
export type FilterOp = "=" | "<>" | "<" | "<=" | ">" | ">=" | "between" | "begins_with" | "contains" | "not_contains" | "exists" | "not_exists";

export const FILTER_OPS: { id: FilterOp; label: string; values: 0 | 1 | 2 }[] = [
  { id: "=", label: "=", values: 1 },
  { id: "<>", label: "≠", values: 1 },
  { id: "<", label: "<", values: 1 },
  { id: "<=", label: "≤", values: 1 },
  { id: ">", label: ">", values: 1 },
  { id: ">=", label: "≥", values: 1 },
  { id: "between", label: "between", values: 2 },
  { id: "begins_with", label: "begins with", values: 1 },
  { id: "contains", label: "contains", values: 1 },
  { id: "not_contains", label: "doesn't contain", values: 1 },
  { id: "exists", label: "exists", values: 0 },
  { id: "not_exists", label: "doesn't exist", values: 0 },
];

/** One comparison as expression text. */
export function condition(p: Placeholders, path: string, op: FilterOp | SortOp, a: DdbValue | null, b: DdbValue | null): string {
  const n = p.name(path);
  switch (op) {
    case "between":
      return `${n} BETWEEN ${p.value(a!)} AND ${p.value(b!)}`;
    case "begins_with":
      return `begins_with(${n}, ${p.value(a!)})`;
    case "contains":
      return `contains(${n}, ${p.value(a!)})`;
    case "not_contains":
      return `NOT contains(${n}, ${p.value(a!)})`;
    case "exists":
      return `attribute_exists(${n})`;
    case "not_exists":
      return `attribute_not_exists(${n})`;
    default:
      return `${n} ${op} ${p.value(a!)}`;
  }
}
