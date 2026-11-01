import { useEffect, useRef, type ReactNode } from "react";

export interface ConfirmButton<T> {
  label: string;
  value: T;
  primary?: boolean;
  danger?: boolean;
}

interface Props<T> {
  title: string;
  children: ReactNode;
  buttons: ConfirmButton<T>[];
  /** Value returned on Escape / click-away. */
  cancelValue: T;
  onResult: (value: T) => void;
}

/** Generic modal question with a set of buttons. */
export function ConfirmDialog<T>({ title, children, buttons, cancelValue, onResult }: Props<T>) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => primaryRef.current?.focus(), []);

  return (
    <div className="modal-backdrop" onMouseDown={() => onResult(cancelValue)}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal
        aria-labelledby="confirm-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onResult(cancelValue)}
      >
        <div className="dialog-title" id="confirm-title">
          {title}
        </div>
        <div className="dialog-body confirm-body">{children}</div>
        <div className="dialog-buttons">
          <div className="spacer" />
          {buttons.map((b) => (
            <button
              key={b.label}
              ref={b.primary ? primaryRef : undefined}
              className={`btn ${b.primary ? "primary" : ""} ${b.danger ? "danger" : ""}`}
              onClick={() => onResult(b.value)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
