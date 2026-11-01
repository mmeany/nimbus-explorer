// Paging for lists whose names are cheap to load in full but whose details
// cost one AWS call per row (SQS queues, SNS topics, DynamoDB tables, …):
// usePaging picks the visible slice; usePagedDetails loads details for that
// slice only and caches them until the list is reloaded.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppError } from "../api/core";
import { PAGE_SIZES } from "../components/PageBar";

function savedSize(storageKey: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(storageKey));
    return PAGE_SIZES.includes(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

export interface Paging {
  page: number;
  pageSize: number;
  lastPage: number;
  /** The rows of `all` on the current page. */
  slice: <T>(all: readonly T[]) => T[];
  /** Props for <PageBar> (spread them, then add `loading`). */
  bar: {
    page: number;
    hasNext: boolean;
    lastPage: number;
    pageSize: number;
    rows: number;
    onPage: (p: number) => void;
    onPageSize: (n: number) => void;
  };
}

/**
 * The current page of a list of `total` rows. The page belongs to `listKey`
 * (e.g. scope + filter): a new key starts at page 1 in the same render, so a
 * page number can't be applied to a different list. The page size is
 * remembered under `storageKey`. Ctrl+PgUp / Ctrl+PgDn turn pages while
 * `active`.
 */
export function usePaging(listKey: string, total: number, storageKey: string, active: boolean, fallbackSize = 100): Paging {
  const [pageSize, setPageSizeState] = useState(() => savedSize(storageKey, fallbackSize));
  const [state, setState] = useState({ key: listKey, page: 0 });
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const page = state.key === listKey ? Math.min(state.page, lastPage) : 0;
  const setPage = useCallback((p: number) => setState({ key: listKey, page: Math.max(0, p) }), [listKey]);
  const setPageSize = useCallback(
    (n: number) => {
      setPageSizeState(n);
      setState({ key: listKey, page: 0 });
      try {
        localStorage.setItem(storageKey, String(n));
      } catch {
        /* remembered only for this session */
      }
    },
    [listKey, storageKey],
  );

  const keys = useRef({ active, page, lastPage, setPage });
  keys.current = { active, page, lastPage, setPage };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const k = keys.current;
      if (!k.active || !(e.ctrlKey || e.metaKey) || (e.key !== "PageDown" && e.key !== "PageUp")) return;
      if ((e.target as HTMLElement).closest("textarea, .modal-backdrop")) return;
      e.preventDefault();
      if (e.key === "PageDown" && k.page < k.lastPage) k.setPage(k.page + 1);
      if (e.key === "PageUp" && k.page > 0) k.setPage(k.page - 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const slice = useCallback(<T,>(all: readonly T[]) => all.slice(page * pageSize, (page + 1) * pageSize), [page, pageSize]);
  const rows = Math.max(0, Math.min(pageSize, total - page * pageSize));
  return {
    page,
    pageSize,
    lastPage,
    slice,
    bar: { page, hasNext: page < lastPage, lastPage, pageSize, rows, onPage: setPage, onPageSize: setPageSize },
  };
}

export interface PagedDetails<T> {
  /** Details loaded so far for this list (by key). */
  details: Map<string, T>;
  /** Loading details for keys on the current page. */
  loading: boolean;
  error: AppError | null;
  /** Replace one entry (e.g. fresher details from a detail view). */
  put: (key: string, value: T) => void;
}

/**
 * Loads details for `keys` (the visible page) that aren't cached yet, one
 * request per page. The cache is dropped when `cacheKey` changes (new scope,
 * filter or Refresh). Responses for an earlier page or cache are ignored.
 */
export function usePagedDetails<T>(
  cacheKey: string,
  keys: readonly string[],
  load: (keys: string[]) => Promise<T[]>,
  keyOf: (t: T) => string,
  enabled = true,
): PagedDetails<T> {
  const [cache, setCache] = useState<{ key: string; map: Map<string, T> }>({ key: cacheKey, map: new Map() });
  const [status, setStatus] = useState<{ key: string; loading: boolean; error: AppError | null }>({ key: "", loading: false, error: null });
  const map = cache.key === cacheKey ? cache.map : null;
  const missing = enabled ? keys.filter((k) => !map?.has(k)) : [];
  const want = missing.join("\u0000");
  const loadRef = useRef(load);
  loadRef.current = load;
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;

  useEffect(() => {
    if (!want) return;
    let stale = false;
    const ask = want.split("\u0000");
    const statusKey = `${cacheKey}\u0001${want}`;
    setStatus({ key: statusKey, loading: true, error: null });
    loadRef
      .current(ask)
      .then((items) => {
        if (stale) return;
        setCache((c) => {
          const next = new Map(c.key === cacheKey ? c.map : undefined);
          for (const it of items) next.set(keyOfRef.current(it), it);
          return { key: cacheKey, map: next };
        });
        setStatus({ key: statusKey, loading: false, error: null });
      })
      .catch((e) => !stale && setStatus({ key: statusKey, loading: false, error: e as AppError }));
    return () => {
      stale = true;
    };
  }, [cacheKey, want]);

  const put = useCallback(
    (key: string, value: T) =>
      setCache((c) => (c.key === cacheKey ? { key: cacheKey, map: new Map(c.map).set(key, value) } : { key: cacheKey, map: new Map([[key, value]]) })),
    [cacheKey],
  );
  const current = status.key === `${cacheKey}\u0001${want}`;
  return {
    details: map ?? new Map(),
    loading: !!want && (!current || status.loading),
    error: want && current ? status.error : null,
    put,
  };
}

export interface TokenPage<T> {
  items: T[] | null;
  loading: boolean;
  error: AppError | null;
  /** Props for <PageBar> (spread them). */
  bar: {
    page: number;
    hasNext: boolean;
    lastPage: number | null;
    pageSize: number;
    rows: number;
    loading: boolean;
    onPage: (p: number) => void;
    onPageSize: (n: number) => void;
  };
}

/**
 * Pages that AWS hands out by continuation token only (forward): page n is
 * read with the token that ended page n-1. Tokens and visited pages are kept
 * per `listKey` (scope + filter + reload), so Previous / First don't re-read
 * from the start. `fetch` must be stable for a given listKey.
 */
export function useTokenPages<T>(
  listKey: string,
  storageKey: string,
  enabled: boolean,
  fetch: (token: string | null, pageSize: number) => Promise<{ items: T[]; nextToken: string | null }>,
  fallbackSize = 100,
): TokenPage<T> {
  const [pageSize, setPageSizeState] = useState(() => savedSize(storageKey, fallbackSize));
  const [state, setState] = useState({ key: listKey, page: 0 });
  const page = state.key === listKey ? state.page : 0;
  const cache = useRef<{ key: string; tokens: (string | null)[]; pages: Map<number, T[]>; last: number | null }>({ key: "", tokens: [null], pages: new Map(), last: null });
  const fullKey = `${listKey}\u0000${pageSize}`;
  if (cache.current.key !== fullKey) cache.current = { key: fullKey, tokens: [null], pages: new Map(), last: null };
  const [view, setView] = useState<{ key: string; page: number; items: T[] | null; error: AppError | null; loading: boolean }>({ key: "", page: -1, items: null, error: null, loading: false });
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  useEffect(() => {
    if (!enabled) return;
    const c = cache.current;
    const cached = c.pages.get(page);
    if (cached) {
      setView({ key: fullKey, page, items: cached, error: null, loading: false });
      return;
    }
    // Only pages whose starting token is known can be read.
    if (page >= c.tokens.length) return;
    let stale = false;
    setView((v) => ({ key: fullKey, page, items: v.key === fullKey && v.page === page ? v.items : null, error: null, loading: true }));
    fetchRef
      .current(c.tokens[page], pageSize)
      .then((r) => {
        if (stale || cache.current !== c) return;
        c.pages.set(page, r.items);
        if (r.nextToken) c.tokens[page + 1] = r.nextToken;
        else c.last = page;
        setView({ key: fullKey, page, items: r.items, error: null, loading: false });
      })
      .catch((e) => !stale && setView({ key: fullKey, page, items: null, error: e as AppError, loading: false }));
    return () => {
      stale = true;
    };
  }, [fullKey, page, enabled, pageSize]);

  const current = view.key === fullKey && view.page === page ? view : null;
  const c = cache.current;
  const setPageSize = (n: number) => {
    setPageSizeState(n);
    setState({ key: listKey, page: 0 });
    try {
      localStorage.setItem(storageKey, String(n));
    } catch {
      /* session only */
    }
  };
  return {
    items: current?.items ?? null,
    loading: !current || current.loading,
    error: current?.error ?? null,
    bar: {
      page,
      hasNext: c.last === null ? c.tokens.length > page + 1 : page < c.last,
      lastPage: c.last,
      pageSize,
      rows: current?.items?.length ?? 0,
      loading: !current || current.loading,
      onPage: (p: number) => setState({ key: listKey, page: Math.max(0, p) }),
      onPageSize: setPageSize,
    },
  };
}

/** Most child rows a service shows under its tree node; the list has the rest. */
export const TREE_LIMIT = 200;
