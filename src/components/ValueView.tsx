import { useEffect, useState } from "react";
import { api } from "../api/s3";
import { DataTree } from "./DataTree";

export type ValueFormat = "json" | "yaml" | "text";

/** Guesses whether a value is JSON or YAML worth showing as a tree. */
export function detectFormat(value: string): ValueFormat {
  const t = value.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      JSON.parse(t);
      return "json";
    } catch {
      return "text";
    }
  }
  // YAML-looking: several "key: value" lines or a "- item" list (not a single plain line).
  const lines = t.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (lines.length >= 2 && lines.every((l) => /^\s*(-\s|[\w"'.-][^:]*:(\s|$))/.test(l))) return "yaml";
  return "text";
}

interface Props {
  value: string;
  /** Initial mode; "auto" picks tree for JSON/YAML. */
  initial?: "auto" | "text";
}

/** Shows a value as text, or as a collapsible tree when it is JSON or YAML. */
export function ValueView({ value, initial = "auto" }: Props) {
  const format = detectFormat(value);
  const [mode, setMode] = useState<"tree" | "text">(initial === "auto" && format !== "text" ? "tree" : "text");
  const [parsed, setParsed] = useState<{ ok: true; value: unknown } | { ok: false; error: string } | null>(null);

  useEffect(() => {
    setParsed(null);
    if (mode !== "tree" || format === "text") return;
    let stale = false;
    if (format === "json") {
      setParsed({ ok: true, value: JSON.parse(value) });
    } else {
      api
        .parseYaml(value)
        .then((docs) => !stale && setParsed({ ok: true, value: docs.length === 1 ? docs[0] : docs }))
        .catch(() => !stale && setParsed({ ok: false, error: "Not valid YAML" }));
    }
    return () => {
      stale = true;
    };
  }, [value, format, mode]);

  return (
    <div className="value-view">
      {format !== "text" && (
        <div className="segmented small">
          <button className={mode === "tree" ? "active" : ""} onClick={() => setMode("tree")}>
            Tree
          </button>
          <button className={mode === "text" ? "active" : ""} onClick={() => setMode("text")}>
            Text
          </button>
        </div>
      )}
      {mode === "tree" && format !== "text" ? (
        parsed === null ? (
          <div className="hint">Parsing…</div>
        ) : parsed.ok ? (
          <DataTree value={parsed.value} rootName={format.toUpperCase()} />
        ) : (
          <pre className="value-text">{value}</pre>
        )
      ) : (
        <pre className="value-text">{value}</pre>
      )}
    </div>
  );
}
