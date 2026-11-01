import { useEffect, useRef, useState } from "react";
import { api, type AppError, type ListPage, type ObjectInfo } from "../api/s3";

/** What to list: a folder (or bucket root), optionally narrowed by a name prefix. */
export interface ListQuery {
  bucket: string | null;
  /** Folder prefix ("" or ending in "/"). */
  prefix: string;
  /** Start of the names to show (sent to S3 as part of the prefix). */
  search: string;
  /** List every object below the folder instead of one level. */
  recursive: boolean;
  /** Rows per page (1–1,000). */
  pageSize: number;
}

export interface FolderPage {
  /** Query this page belongs to (guards against showing stale data). */
  bucket: string | null;
  prefix: string;
  queryKey: string;
  /** 0-based page index. */
  page: number;
  folders: string[];
  files: ObjectInfo[];
  loading: boolean;
  error: AppError | null;
  /** A later page exists. */
  hasNext: boolean;
  /** Index of the last page, once it has been reached. */
  lastPage: number | null;
  /** The whole listing fits on this (first) page. */
  complete: boolean;
}

export const queryKey = (connectionId: number, q: ListQuery) =>
  [connectionId, q.bucket, q.prefix, q.search, q.recursive ? "r" : "", q.pageSize].join("\u0000");

const empty = (q: ListQuery, key: string, page: number): FolderPage => ({
  bucket: q.bucket,
  prefix: q.prefix,
  queryKey: key,
  page,
  folders: [],
  files: [],
  loading: false,
  error: null,
  hasNext: false,
  lastPage: null,
  complete: false,
});

/**
 * Loads one page of a folder listing at a time (ListObjectsV2 with MaxKeys =
 * page size). Continuation tokens are remembered per query, so Previous /
 * First work without re-reading from the start, and visited pages are cached
 * until the next refresh. Changing the query, page or reloadToken cancels an
 * in-flight load.
 */
export function useFolderPage(connectionId: number, q: ListQuery, page: number, reloadToken: number): FolderPage {
  const key = queryKey(connectionId, q);
  const [state, setState] = useState<FolderPage>(() => empty(q, key, page));
  /** tokens[i] = continuation token that starts page i (tokens[0] = null). */
  const cache = useRef<{ key: string; tokens: (string | null)[]; pages: Map<number, ListPage>; lastPage: number | null }>({
    key: "",
    tokens: [null],
    pages: new Map(),
    lastPage: null,
  });
  const lastLoad = useRef({ key: "", page: -1, reload: -1 });

  useEffect(() => {
    const c = cache.current;
    if (c.key !== key) {
      cache.current = { key, tokens: [null], pages: new Map(), lastPage: null };
    }
    const cc = cache.current;
    const prev = lastLoad.current;
    const refreshing = prev.key === key && prev.page === page && prev.reload !== reloadToken;
    if (refreshing) {
      // Re-read this page from its token; later tokens and pages may have shifted.
      cc.pages.clear();
      cc.tokens.length = Math.min(cc.tokens.length, page + 1);
      cc.lastPage = null;
    }
    lastLoad.current = { key, page, reload: reloadToken };

    if (connectionId === 0 || q.bucket === null) {
      setState(empty(q, key, page));
      return;
    }
    const show = (p: ListPage) =>
      setState({
        bucket: q.bucket,
        prefix: q.prefix,
        queryKey: key,
        page,
        folders: p.folders,
        files: p.files,
        loading: false,
        error: null,
        hasNext: !!p.nextToken,
        lastPage: cc.lastPage,
        complete: page === 0 && !p.nextToken,
      });
    const cached = cc.pages.get(page);
    if (cached) {
      show(cached);
      return;
    }
    const token = cc.tokens[page];
    if (token === undefined) {
      // Not reachable yet (e.g. page index beyond what's been walked): go back to the start.
      setState({ ...empty(q, key, page), error: { kind: "other", message: "That page isn't available; go to the first page." } as AppError });
      return;
    }
    let cancelled = false;
    // Refresh keeps the rows on screen until the new page arrives.
    if (refreshing) setState((s) => ({ ...s, loading: true, error: null }));
    else setState({ ...empty(q, key, page), loading: true });

    api
      .listObjects(q.bucket, q.prefix + q.search, token, q.pageSize, q.recursive)
      .then((p) => {
        if (cancelled) return;
        cc.pages.set(page, p);
        if (p.nextToken) cc.tokens[page + 1] = p.nextToken;
        else cc.lastPage = page;
        show(p);
      })
      .catch((e) => {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: e as AppError }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, page, reloadToken]);

  return state;
}
