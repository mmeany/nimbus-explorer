import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  /** The filter currently applied ("" = none). */
  applied: string;
  /** Remembered filters, newest first. */
  history: string[];
  placeholder: string;
  label: string;
  onApply: (value: string) => void;
  onClear: () => void;
  onForget: (value: string) => void;
  onClearHistory: () => void;
  /** Apply button text (default "Filter"). */
  buttonLabel?: string;
  /** Extra controls after the buttons. */
  children?: ReactNode;
}

/** Text filter with a dropdown of remembered filters (removable). */
export function FilterBox({ applied, history, placeholder, label, onApply, onClear, onForget, onClearHistory, buttonLabel = "Filter", children }: Props) {
  const [text, setText] = useState(applied);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => setText(applied), [applied]);

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const apply = (v: string) => {
    setOpen(false);
    if (v.trim()) onApply(v.trim());
    else onClear();
  };

  return (
    <div className="filter-bar" ref={wrapRef}>
      <label className="field-label" htmlFor="filter-input">
        {label}
      </label>
      <div className="filter-box">
        <input
          id="filter-input"
          className="text-input mono filter-input"
          value={text}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply(text);
            if (e.key === "Escape") setOpen(false);
            if (e.key === "ArrowDown" && history.length) setOpen(true);
          }}
        />
        <button className="filter-drop" title="Previous filters" disabled={history.length === 0} onClick={() => setOpen((v) => !v)}>
          ▾
        </button>
        {open && history.length > 0 && (
          <div className="filter-menu" role="listbox">
            {history.map((h) => (
              <div key={h} className="filter-item" role="option" aria-selected={h === applied}>
                <button className="filter-pick mono" onClick={() => apply(h)} title={`Filter by ${h}`}>
                  {h}
                </button>
                <button className="filter-forget" title="Remove from history" onClick={() => onForget(h)}>
                  ✕
                </button>
              </div>
            ))}
            <div className="filter-menu-foot">
              <button className="link-btn" onClick={() => (onClearHistory(), setOpen(false))}>
                Clear history
              </button>
            </div>
          </div>
        )}
      </div>
      <button className="btn" onClick={() => apply(text)}>
        {buttonLabel}
      </button>
      {applied && (
        <button className="btn" onClick={() => (setText(""), onClear())}>
          Clear
        </button>
      )}
      {children}
    </div>
  );
}
