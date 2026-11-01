// RFC 4180 CSV parsing: quoted fields, "" escapes, CR/LF/CRLF, newlines inside quotes.

/** Picks the most likely delimiter from the first line (outside quotes). */
export function detectDelimiter(text: string, fileName = ""): string {
  if (/\.tsv$/i.test(fileName)) return "\t";
  const candidates = [",", ";", "\t", "|"];
  const counts = new Map(candidates.map((c) => [c, 0]));
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best = ",";
  for (const c of candidates) if (counts.get(c)! > counts.get(best)!) best = c;
  return best;
}

/** Parses CSV text into rows of fields. Blank lines are skipped. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const endRow = () => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      endRow();
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else {
      field += ch;
    }
    i++;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** Header names, made unique and non-empty ("Column 3", "name (2)"). */
export function headerNames(first: string[], width: number): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    let name = (first[i] ?? "").trim() || `Column ${i + 1}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    out.push(name);
  }
  return out;
}
