import type { ReactNode } from "react";

interface Props {
  icon: ReactNode;
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}

/** A command-bar button: icon + label (label hidden on narrow windows). */
export function CommandButton({ icon, label, title, onClick, disabled }: Props) {
  return (
    <button className="cmd-btn" onClick={onClick} disabled={disabled} title={title}>
      {icon} <span className="cmd-label">{label}</span>
    </button>
  );
}

export function CommandSeparator() {
  return <div className="tb-sep" />;
}
