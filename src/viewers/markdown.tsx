// Minimal Markdown (CommonMark/GFM subset) rendered straight to React elements.
// No HTML strings and no dangerouslySetInnerHTML: content from a bucket can't
// inject markup or scripts. Raw HTML in the source is shown as text.

import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Inline

const LINK_RE = /^\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]*)>?(?:\s+"([^"]*)")?\s*\)/;
const IMAGE_RE = /^!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"([^"]*)")?\s*\)/;
const AUTOLINK_RE = /^<((?:https?|mailto|ftp):[^>\s]+)>/;
const ESCAPABLE = "\\`*_{}[]()#+-.!|~<>\"'";

function copyToClipboard(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

/** A link that shows its target but never navigates the app window. */
function Link({ href, title, children }: { href: string; title?: string; children: ReactNode }) {
  return (
    <span
      className="md-link"
      title={`${title ? title + " · " : ""}${href}\n(click to copy the address)`}
      onClick={() => copyToClipboard(href)}
    >
      {children}
    </span>
  );
}

export function renderInline(src: string, keyBase = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let text = "";
  let k = 0;
  const key = () => `${keyBase}-${k++}`;
  const flush = () => {
    if (text) out.push(text);
    text = "";
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);

    if (ch === "\\" && i + 1 < src.length) {
      if (src[i + 1] === "\n") {
        flush();
        out.push(<br key={key()} />);
        i += 2;
        continue;
      }
      if (ESCAPABLE.includes(src[i + 1])) {
        text += src[i + 1];
        i += 2;
        continue;
      }
    }
    if (ch === "\n") {
      // Two trailing spaces = hard break; otherwise a soft break (space).
      if (text.endsWith("  ")) {
        text = text.replace(/ +$/, "");
        flush();
        out.push(<br key={key()} />);
      } else {
        text = text.replace(/ +$/, "") + " ";
      }
      i++;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(rest)![0];
      const end = src.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        let code = src.slice(i + run.length, end).replace(/\n/g, " ");
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        out.push(<code key={key()}>{code}</code>);
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if (ch === "!" && src[i + 1] === "[") {
      const m = IMAGE_RE.exec(rest);
      if (m) {
        flush();
        const [, alt, url, title] = m;
        out.push(
          url.startsWith("data:image/") ? (
            <img key={key()} className="md-image" src={url} alt={alt} title={title} />
          ) : (
            // Remote/relative images are blocked by the app's security policy.
            <span key={key()} className="md-img-placeholder" title={url}>
              🖼 {alt || "image"}
            </span>
          ),
        );
        i += m[0].length;
        continue;
      }
    }
    if (ch === "[") {
      const m = LINK_RE.exec(rest);
      if (m) {
        flush();
        out.push(
          <Link key={key()} href={m[2]} title={m[3]}>
            {renderInline(m[1], key())}
          </Link>,
        );
        i += m[0].length;
        continue;
      }
    }
    if (ch === "<") {
      const m = AUTOLINK_RE.exec(rest);
      if (m) {
        flush();
        out.push(
          <Link key={key()} href={m[1]}>
            {m[1]}
          </Link>,
        );
        i += m[0].length;
        continue;
      }
    }
    if (ch === "~" && src[i + 1] === "~") {
      const end = src.indexOf("~~", i + 2);
      if (end > i + 2) {
        flush();
        out.push(<del key={key()}>{renderInline(src.slice(i + 2, end), key())}</del>);
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const prev = src[i - 1] ?? " ";
      // Intraword underscores (snake_case) are literal.
      if (ch === "_" && /[A-Za-z0-9]/.test(prev)) {
        text += ch;
        i++;
        continue;
      }
      const dbl = src[i + 1] === ch;
      const delim = dbl ? ch + ch : ch;
      const start = i + delim.length;
      if (src[start] && src[start] !== " ") {
        let end = src.indexOf(delim, start);
        // For single delimiters, skip over doubles inside (e.g. *a **b** c*).
        while (!dbl && end > 0 && src[end + 1] === ch) end = src.indexOf(delim, end + 2);
        if (end > start && src[end - 1] !== " ") {
          flush();
          const inner = renderInline(src.slice(start, end), key());
          out.push(dbl ? <strong key={key()}>{inner}</strong> : <em key={key()}>{inner}</em>);
          i = end + delim.length;
          continue;
        }
      }
      text += delim;
      i += delim.length;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Blocks

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^ {0,3}> ?/;
const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])(\s+|$)/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (s: string) => s.length - s.trimStart().length;
const isBlank = (s: string) => s.trim() === "";

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** True if a line starts a block other than a paragraph (ends a paragraph). */
function interrupts(line: string): boolean {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line);
}

export function renderBlocks(lines: string[], keyBase = "b", tight = false): ReactNode[] {
  const out: ReactNode[] = [];
  let k = 0;
  const key = () => `${keyBase}-${k++}`;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    // Fenced code
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++]);
      i++; // closing fence
      out.push(
        <pre key={key()} className="md-code" data-lang={fence[2] || undefined}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Heading
    const h = HEADING_RE.exec(line);
    if (h) {
      const level = h[1].length;
      const content = renderInline(h[2] ?? "", key());
      const Tag = `h${level}` as "h1";
      out.push(<Tag key={key()}>{content}</Tag>);
      i++;
      continue;
    }

    // Horizontal rule
    if (HR_RE.test(line)) {
      out.push(<hr key={key()} />);
      i++;
      continue;
    }

    // Blockquote
    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i]) && (QUOTE_RE.test(lines[i]) || !interrupts(lines[i]))) {
        body.push(lines[i].replace(QUOTE_RE, ""));
        i++;
      }
      out.push(<blockquote key={key()}>{renderBlocks(body, key())}</blockquote>);
      continue;
    }

    // List
    const lm = LIST_RE.exec(line);
    if (lm) {
      const baseIndent = lm[1].length;
      const ordered = /\d/.test(lm[2]);
      const startNum = ordered ? parseInt(lm[2], 10) : 1;
      const items: string[][] = [];
      let looseGap = false;
      while (i < lines.length) {
        const l = lines[i];
        const m = LIST_RE.exec(l);
        if (m && m[1].length === baseIndent && /\d/.test(m[2]) === ordered) {
          const contentIndent = m[0].length;
          const first = l.slice(contentIndent);
          const item = [first];
          i++;
          // Continuation: indented lines, lazy paragraph lines, blank lines followed by indented content.
          while (i < lines.length) {
            const c = lines[i];
            if (isBlank(c)) {
              const next = lines[i + 1];
              if (next !== undefined && !isBlank(next) && indentOf(next) > baseIndent) {
                item.push("");
                looseGap = true;
                i++;
                continue;
              }
              break;
            }
            if (indentOf(c) > baseIndent) {
              item.push(c.slice(Math.min(contentIndent, indentOf(c))));
              i++;
            } else if (!interrupts(c) && !isBlank(item[item.length - 1])) {
              item.push(c.trimStart()); // lazy continuation
              i++;
            } else break;
          }
          items.push(item);
          // A blank line between items makes the list loose.
          const nextItem = LIST_RE.exec(lines[i + 1] ?? "");
          if (isBlank(lines[i] ?? "x") && nextItem?.[1].length === baseIndent && /\d/.test(nextItem[2]) === ordered) {
            looseGap = true;
            i++;
          }
        } else break;
      }
      const lis = items.map((item, n) => {
        const task = /^\[([ xX])\]\s+/.exec(item[0]);
        const lines2 = task ? [item[0].slice(task[0].length), ...item.slice(1)] : item;
        return (
          <li key={n} className={task ? "md-task" : undefined}>
            {task && <input type="checkbox" checked={task[1] !== " "} readOnly tabIndex={-1} />}
            {renderBlocks(lines2, `${keyBase}-li${n}`, !looseGap)}
          </li>
        );
      });
      out.push(
        ordered ? (
          <ol key={key()} start={startNum !== 1 ? startNum : undefined}>
            {lis}
          </ol>
        ) : (
          <ul key={key()}>{lis}</ul>
        ),
      );
      continue;
    }

    // Table (header row + separator row)
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : undefined,
      );
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) body.push(splitRow(lines[i++]));
      out.push(
        <div key={key()} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {head.map((c, n) => (
                  <th key={n} style={{ textAlign: aligns[n] }}>
                    {renderInline(c, `${keyBase}-th${n}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>
                  {head.map((_, n) => (
                    <td key={n} style={{ textAlign: aligns[n] }}>
                      {renderInline(row[n] ?? "", `${keyBase}-td${r}-${n}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Indented code block
    if (indentOf(line) >= 4 && !tight) {
      const body: string[] = [];
      while (i < lines.length && (indentOf(lines[i]) >= 4 || isBlank(lines[i]))) body.push(lines[i++].slice(4));
      while (body.length && isBlank(body[body.length - 1])) body.pop();
      out.push(
        <pre key={key()} className="md-code">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Paragraph (possibly a setext heading)
    const para: string[] = [line.trimStart()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !interrupts(lines[i])) {
      if (/^ {0,3}=+\s*$/.test(lines[i]) || /^ {0,3}-+\s*$/.test(lines[i])) break;
      para.push(lines[i++]);
    }
    if (i < lines.length && /^ {0,3}=+\s*$/.test(lines[i])) {
      out.push(<h1 key={key()}>{renderInline(para.join("\n"), key())}</h1>);
      i++;
      continue;
    }
    if (i < lines.length && /^ {0,3}-+\s*$/.test(lines[i])) {
      out.push(<h2 key={key()}>{renderInline(para.join("\n"), key())}</h2>);
      i++;
      continue;
    }
    const content = renderInline(para.join("\n"), key());
    out.push(tight ? <span key={key()}>{content}</span> : <p key={key()}>{content}</p>);
  }
  return out;
}

/** Renders a Markdown document. */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return <div className="md">{renderBlocks(lines)}</div>;
}
