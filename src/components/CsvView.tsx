import { useMemo, useState } from "react";
import { detectDelimiter, headerNames, parseCsv } from "../viewers/csv";
import { DataTree } from "./DataTree";

interface Props {
  text: string;
  fileName: string;
  mode: "table" | "tree";
  /** True when only the start of the file was loaded. */
  truncated: boolean;
}

const PAGE = 1000;
const DELIMS: [string, string][] = [
  [",", "Comma"],
  [";", "Semicolon"],
  ["\t", "Tab"],
  ["|", "Pipe"],
];

/** CSV/TSV as a table, or as a tree of collapsible row records. */
export function CsvView({ text, fileName, mode, truncated }: Props) {
  const [delimiter, setDelimiter] = useState(() => detectDelimiter(text, fileName));
  const [hasHeader, setHasHeader] = useState(true);
  const [limit, setLimit] = useState(PAGE);

  const rows = useMemo(() => parseCsv(text, delimiter), [text, delimiter]);
  const width = useMemo(() => rows.reduce((w, r) => Math.max(w, r.length), 0), [rows]);
  const header = useMemo(() => headerNames(hasHeader ? (rows[0] ?? []) : [], width), [rows, width, hasHeader]);
  const body = hasHeader ? rows.slice(1) : rows;

  const records = useMemo(
    () => (mode === "tree" ? body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))) : []),
    [mode, body, header],
  );

  return (
    <div className="csv-view">
      <div className="dt-toolbar">
        <label className="check">
          <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> First row is
          the header
        </label>
        <label className="check">
          Delimiter
          <select className="select" value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
            {DELIMS.map(([d, name]) => (
              <option key={name} value={d}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <div className="spacer" />
        <span className="muted-note">
          {body.length.toLocaleString()} row{body.length === 1 ? "" : "s"}
          {truncated ? " (first part of file)" : ""} × {width} column{width === 1 ? "" : "s"}
        </span>
      </div>
      {mode === "tree" ? (
        <DataTree value={records} rootName="rows" rootItemLabel={(i) => `Row ${i + 1}`} initialDepth={1} />
      ) : (
        <div className="csv-table-wrap">
          <table className="csv-table">
            <thead>
              <tr>
                <th className="rownum">#</th>
                {header.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.slice(0, limit).map((r, n) => (
                <tr key={n}>
                  <td className="rownum">{n + 1}</td>
                  {header.map((_, i) => (
                    <td key={i}>{r[i] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {body.length > limit && (
            <div className="csv-more">
              <button className="link-btn" onClick={() => setLimit((l) => l + PAGE * 5)}>
                Show more ({(body.length - limit).toLocaleString()} remaining rows)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
