import type { ReactNode } from "react";

interface Props {
  left: string;
  middle?: ReactNode;
  right: string;
}

export function StatusBar({ left, middle, right }: Props) {
  return (
    <div className="status-bar">
      <span className="status-cell grow">{left}</span>
      {middle && <span className="status-cell">{middle}</span>}
      <span className="status-cell">{right}</span>
    </div>
  );
}
