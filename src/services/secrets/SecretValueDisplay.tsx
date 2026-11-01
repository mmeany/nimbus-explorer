// A revealed secret value: key/value table for flat JSON objects (the usual
// "username / password" shape), tree for other JSON, otherwise text.
import { useMemo, useState } from "react";
import { ValueView } from "../../components/ValueView";

export function flatObject(text: string): Record<string, string> | null {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.every(([, x]) => x === null || ["string", "number", "boolean"].includes(typeof x))) return null;
    return Object.fromEntries(entries.map(([k, x]) => [k, x === null ? "null" : String(x)]));
  } catch {
    return null;
  }
}

export function SecretValueDisplay({ value, binary, onCopy }: { value: string; binary?: boolean; onCopy: (text: string) => void }) {
  const flat = useMemo(() => (binary ? null : flatObject(value)), [value, binary]);
  const [mode, setMode] = useState<"table" | "raw">("table");
  if (binary) {
    return (
      <>
        <div className="hint">Binary secret, shown as base64.</div>
        <pre className="value-text">{value}</pre>
      </>
    );
  }
  if (!flat) return <ValueView value={value} />;
  return (
    <div className="value-view">
      <div className="segmented small">
        <button className={mode === "table" ? "active" : ""} onClick={() => setMode("table")}>
          Key / value
        </button>
        <button className={mode === "raw" ? "active" : ""} onClick={() => setMode("raw")}>
          JSON
        </button>
      </div>
      {mode === "table" ? (
        <table className="props-table kv-table">
          <tbody>
            {Object.entries(flat).map(([k, v]) => (
              <tr key={k}>
                <th className="mono">{k}</th>
                <td className="mono selectable">
                  {v}{" "}
                  <button className="link-btn" onClick={() => onCopy(v)}>
                    Copy
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ValueView value={value} />
      )}
    </div>
  );
}
