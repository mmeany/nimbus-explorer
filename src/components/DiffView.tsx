import { useMemo, type CSSProperties } from "react";
import { diffLines } from "../util/diff";
import { useLineNumbers } from "../state/lineNumbers";

interface Props {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
}

/** Unified line diff with +/- gutters and, when line numbers are on, old / new line numbers. */
export function DiffView({ before, after, beforeLabel, afterLabel }: Props) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const added = lines.filter((l) => l.type === "add").length;
  const removed = lines.filter((l) => l.type === "del").length;
  const [lineNumbers] = useLineNumbers();
  // Line number in `before` / `after` for each diff line (null where the line isn't in that side).
  const numbers = useMemo(() => {
    let a = 0;
    let b = 0;
    return lines.map((l) => ({ a: l.type === "add" ? null : ++a, b: l.type === "del" ? null : ++b }));
  }, [lines]);
  // Digits for the longer side: every line but the added ones is in `before`, and so on.
  const width = String(Math.max(1, lines.length - added, lines.length - removed)).length;
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
      <pre className="diff-body" style={{ "--ln-w": `${width}ch` } as CSSProperties}>
        {lines.map((l, i) => (
          <div key={i} className={`diff-line ${l.type}`}>
            {lineNumbers && (
              <>
                <span className="diff-num">{numbers[i].a ?? ""}</span>
                <span className="diff-num">{numbers[i].b ?? ""}</span>
              </>
            )}
            <span className="diff-gutter">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
            {l.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
