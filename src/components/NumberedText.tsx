// Read-only text with line numbers in a left margin, when the "Line numbers"
// setting is on and the text has more than one line. Numbers are never
// selected or copied.
// - Not wrapped: two columns, a gutter <pre> with every number (sticky, so it
//   stays put when scrolling sideways) and the text in one <pre>. Two elements
//   however long the file is.
// - Wrapped: one block per line with the number in a ::before hanging indent,
//   so a wrapped line is numbered on its first row and its other rows are
//   indented under the text. Long texts go in chunks of CHUNK lines that the
//   browser skips laying out while off screen (content-visibility: auto).
import { useMemo, type CSSProperties } from "react";
import { useLineNumbers } from "../state/lineNumbers";

/** Lines per off-screen-skippable block in wrapped mode. */
const CHUNK = 500;

interface Props {
  text: string;
  /** Classes for the outer element (e.g. "pv-text", "value-text"). */
  className: string;
  /** Long lines wrap (the className must wrap them too). */
  wrap: boolean;
}

export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  // A final newline ends the last line rather than starting an empty one.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function NumberedText({ text, className, wrap }: Props) {
  const [on] = useLineNumbers();
  const lines = useMemo(() => (on ? splitLines(text) : null), [on, text]);
  const gutter = useMemo(() => (lines && !wrap ? lines.map((_, i) => i + 1).join("\n") : ""), [lines, wrap]);
  if (!lines || lines.length < 2) return <pre className={className}>{text}</pre>;
  const style = { "--ln-w": `${String(lines.length).length}ch` } as CSSProperties;
  if (!wrap) {
    return (
      <div className={`${className} numbered-cols`} style={style}>
        <pre className="ln-gutter" aria-hidden>
          {gutter}
        </pre>
        <pre className="ln-body">{text}</pre>
      </div>
    );
  }
  const row = (l: string, i: number) => (
    <span key={i} className="ln" data-n={i + 1}>
      {l}
      {"\n"}
    </span>
  );
  if (lines.length <= CHUNK) {
    return (
      <pre className={`${className} numbered`} style={style}>
        {lines.map(row)}
      </pre>
    );
  }
  const chunks: string[][] = [];
  for (let i = 0; i < lines.length; i += CHUNK) chunks.push(lines.slice(i, i + CHUNK));
  return (
    <pre className={`${className} numbered`} style={style}>
      {chunks.map((c, ci) => (
        <span key={ci} className="ln-chunk" style={{ "--ln-rows": c.length } as CSSProperties}>
          {c.map((l, i) => row(l, ci * CHUNK + i))}
        </span>
      ))}
    </pre>
  );
}
