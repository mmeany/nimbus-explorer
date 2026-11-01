import { useEffect, useState, type ReactNode } from "react";

interface Props {
  /** Fetches (decrypts) the value on demand. Never called until the user asks. */
  load: () => Promise<string>;
  onError: (e: unknown) => void;
  onCopied?: () => void;
  /** Rich view of the revealed value (e.g. a JSON tree), shown below the controls. */
  renderRevealed?: (value: string) => ReactNode;
}

/**
 * A secret shown as dots. Reveal/Copy decrypt on demand; the plaintext lives
 * only in this component's state while revealed and is dropped on Hide or
 * unmount. It is never cached elsewhere or logged.
 */
export function MaskedValue({ load, onError, onCopied, renderRevealed }: Props) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Drop the plaintext when the component goes away.
  useEffect(() => () => setValue(null), []);

  async function fetchValue(): Promise<string | null> {
    setBusy(true);
    try {
      return await load();
    } catch (e) {
      onError(e);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const controls = (
    <span className="masked-value">
      <span className={`mono ${value === null ? "dots" : "revealed"}`}>{value === null || !renderRevealed ? (value ?? "••••••••") : ""}</span>
      {value === null ? (
        <button className="link-btn" disabled={busy} onClick={async () => setValue(await fetchValue())}>
          {busy ? "…" : "Reveal"}
        </button>
      ) : (
        <button className="link-btn" onClick={() => setValue(null)}>
          Hide
        </button>
      )}
      <button
        className="link-btn"
        disabled={busy}
        onClick={async () => {
          const v = value ?? (await fetchValue());
          if (v === null) return;
          try {
            await navigator.clipboard.writeText(v);
            onCopied?.();
          } catch (e) {
            onError(e);
          }
        }}
      >
        Copy
      </button>
    </span>
  );
  if (!renderRevealed) return controls;
  return (
    <div className="masked-block">
      {controls}
      {value !== null && renderRevealed(value)}
    </div>
  );
}
