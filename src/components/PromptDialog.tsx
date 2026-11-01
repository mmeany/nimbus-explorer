import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  label: string;
  initial: string;
  okLabel?: string;
  /** Returns an error message, or null if the value is acceptable. */
  validate: (value: string) => string | null;
  onResult: (value: string | null) => void;
}

/** Single-line text prompt (new folder, rename). Selects the name before any extension. */
export function PromptDialog({ title, label, initial, okLabel = "OK", validate, onResult }: Props) {
  const [value, setValue] = useState(initial);
  const [touched, setTouched] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const error = validate(value);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  function submit() {
    setTouched(true);
    if (!error) onResult(value.trim());
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => onResult(null)}>
      <div
        className="dialog"
        role="dialog"
        aria-modal
        aria-labelledby="prompt-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onResult(null);
          if (e.key === "Enter") submit();
        }}
      >
        <div className="dialog-title" id="prompt-title">
          {title}
        </div>
        <div className="dialog-body">
          <label className="form-label" htmlFor="prompt-input">
            {label}
          </label>
          <input
            id="prompt-input"
            ref={ref}
            className="text-input"
            value={value}
            spellCheck={false}
            onChange={(e) => {
              setValue(e.target.value);
              setTouched(true);
            }}
          />
          {touched && error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" onClick={submit} disabled={touched && !!error}>
            {okLabel}
          </button>
          <button className="btn" onClick={() => onResult(null)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
