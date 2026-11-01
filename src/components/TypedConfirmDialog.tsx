import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  title: string;
  children: ReactNode;
  /** Text the user must type exactly (e.g. the queue or table name). */
  confirmText: string;
  actionLabel: string;
  onResult: (confirmed: boolean) => void;
}

/** Confirmation for irreversible actions: the user types the resource name. */
export function TypedConfirmDialog({ title, children, confirmText, actionLabel, onResult }: Props) {
  const [typed, setTyped] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const ok = typed === confirmText;

  return (
    <div className="modal-backdrop" onMouseDown={() => onResult(false)}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal
        aria-labelledby="typed-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onResult(false);
          if (e.key === "Enter" && ok) onResult(true);
        }}
      >
        <div className="dialog-title" id="typed-title">
          {title}
        </div>
        <div className="dialog-body confirm-body">
          {children}
          <label className="form-label" htmlFor="typed-input">
            Type <span className="mono">{confirmText}</span> to confirm
          </label>
          <input
            id="typed-input"
            ref={ref}
            className="text-input mono"
            value={typed}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn danger" disabled={!ok} onClick={() => onResult(true)}>
            {actionLabel}
          </button>
          <button className="btn primary" onClick={() => onResult(false)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
