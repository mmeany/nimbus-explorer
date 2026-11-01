import { useMemo } from "react";
import { diffLines } from "../util/diff";

interface Props {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
}

/** Unified line diff with +/- gutters. */
export function DiffView({ before, after, beforeLabel, afterLabel }: Props) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const added = lines.filter((l) => l.type === "add").length;
  const removed = lines.filter((l) => l.type === "del").length;
  return (
    <div className="diff-view">
      <div className="diff-head">
        <span className="diff-del-label">− {beforeLabel}</span>
        <span className="diff-add-label">+ {afterLabel}</span>
        <div className="spacer" />
        <span className="muted-note">
          {added === 0 && removed === 0 ? "No differences" : `${added} added, ${removed} removed`}
        </span>
      </div>
      <pre className="diff-body">
        {lines.map((l, i) => (
          <div key={i} className={`diff-line ${l.type}`}>
            <span className="diff-gutter">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
            {l.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
