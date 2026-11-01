// Line diff (LCS) for comparing values, e.g. parameter versions.

export type DiffLine = { type: "same" | "add" | "del"; text: string };

/** Above this many cells the O(n·m) table is skipped and a simple diff is used. */
const MAX_CELLS = 4_000_000;

/** Lines of `a` → lines of `b`: unchanged ("same"), removed ("del"), added ("add"). */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  // Trim common prefix/suffix (keeps the table small for typical edits).
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  const head: DiffLine[] = x.slice(0, start).map((text) => ({ type: "same", text }));
  const tail: DiffLine[] = x.slice(endX).map((text) => ({ type: "same", text }));
  const mx = x.slice(start, endX);
  const my = y.slice(start, endY);

  let middle: DiffLine[];
  if (mx.length * my.length > MAX_CELLS) {
    middle = [...mx.map((text) => ({ type: "del" as const, text })), ...my.map((text) => ({ type: "add" as const, text }))];
  } else {
    // lcs[i][j] = LCS length of mx[i..] and my[j..]
    const n = mx.length;
    const m = my.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i][j] = mx[i] === my[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    middle = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (mx[i] === my[j]) {
        middle.push({ type: "same", text: mx[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        middle.push({ type: "del", text: mx[i++] });
      } else {
        middle.push({ type: "add", text: my[j++] });
      }
    }
    while (i < n) middle.push({ type: "del", text: mx[i++] });
    while (j < m) middle.push({ type: "add", text: my[j++] });
  }
  return [...head, ...middle, ...tail];
}
