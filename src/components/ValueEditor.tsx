import { useMemo } from "react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  /** Mask the text (for secrets) while editing. */
  secret?: boolean;
}

/** JSON check for values that look like JSON; null if they don't look like JSON. */
export function jsonProblem(value: string): string | null {
  const t = value.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    JSON.parse(t);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Multi-line value editor that validates JSON-looking text and can pretty-print it. */
export function ValueEditor({ value, onChange, rows = 8, placeholder, disabled, secret }: Props) {
  const looksJson = useMemo(() => /^\s*[[{]/.test(value), [value]);
  const problem = useMemo(() => jsonProblem(value), [value]);

  function format(minify: boolean) {
    try {
      onChange(JSON.stringify(JSON.parse(value), null, minify ? 0 : 2));
    } catch {
      /* invalid: button is disabled anyway */
    }
  }

  return (
    <div className="value-editor">
      <textarea
        className={`text-input mono value-textarea ${secret ? "secret" : ""}`}
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {looksJson && (
        <div className="row">
          {problem ? (
            <span className="field-error">Invalid JSON: {problem}</span>
          ) : (
            <span className="hint">Valid JSON</span>
          )}
          <div className="spacer" />
          <button className="link-btn" disabled={!!problem || disabled} onClick={() => format(false)}>
            Format
          </button>
          <button className="link-btn" disabled={!!problem || disabled} onClick={() => format(true)}>
            Minify
          </button>
        </div>
      )}
    </div>
  );
}
