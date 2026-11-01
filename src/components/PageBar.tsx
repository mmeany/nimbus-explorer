// Pager under a list: First / Previous / Next, page number, rows shown and
// the page size.
export const PAGE_SIZES = [100, 500, 1000];

interface Props {
  /** 0-based. */
  page: number;
  hasNext: boolean;
  /** Index of the last page, when known. */
  lastPage: number | null;
  pageSize: number;
  /** Rows on this page (before any on-screen filter). */
  rows: number;
  loading: boolean;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}

export function PageBar({ page, hasNext, lastPage, pageSize, rows, loading, onPage, onPageSize }: Props) {
  const first = page * pageSize + 1;
  const range = rows ? `${first.toLocaleString()}–${(first + rows - 1).toLocaleString()}` : "none";
  return (
    <div className="page-bar">
      <button className="btn small" disabled={page === 0 || loading} title="First page" onClick={() => onPage(0)}>
        ⏮
      </button>
      <button className="btn small" disabled={page === 0 || loading} title="Previous page (Ctrl+PgUp)" onClick={() => onPage(page - 1)}>
        ◀ Previous
      </button>
      <span className="page-bar-label">
        Page {(page + 1).toLocaleString()}
        {lastPage !== null ? ` of ${(lastPage + 1).toLocaleString()}` : hasNext ? " of more" : ""}
      </span>
      <button className="btn small" disabled={!hasNext || loading} title="Next page (Ctrl+PgDn)" onClick={() => onPage(page + 1)}>
        Next ▶
      </button>
      <span className="hint">
        {loading ? "Loading…" : `Items ${range}`}
      </span>
      <div className="spacer" />
      <label className="hint" htmlFor="page-size">
        Per page
      </label>
      <select id="page-size" className="text-input page-size" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>
            {n.toLocaleString()}
          </option>
        ))}
      </select>
    </div>
  );
}
