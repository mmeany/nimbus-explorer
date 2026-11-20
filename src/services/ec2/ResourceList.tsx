// One EC2 resource list (AMIs, volumes, snapshots, security groups, …):
// loads in full, filters on screen with the remembered filter history, pages
// on screen, opens rows as places. Each kind describes itself with a
// KindConfig; the controller renders <ResourceList config=…/>.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type AppError } from "../../api/s3";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { FilterBox } from "../../components/FilterBox";
import { HelpTopic } from "../../components/HelpDialog";
import { PageBar } from "../../components/PageBar";
import type { HelpTopicId } from "../../help";
import { EC2_ROOT, type Ec2Kind } from "../../shell/places";
import type { Shell } from "../../shell/shell";
import { usePaging } from "../../state/paged";

export interface KindConfig<T> {
  kind: Ec2Kind;
  help: HelpTopicId;
  /** Singular and plural nouns ("volume", "volumes"). */
  noun: [string, string];
  /** Changes when the list must reload (e.g. a scope toggle). */
  loadKey?: string;
  load: () => Promise<T[]>;
  key: (t: T) => string;
  columns: Column[];
  cells: (t: T) => Row["cells"];
  icon: (t: T) => ReactNode;
  dimmed?: (t: T) => boolean;
  match: (t: T, filter: string) => boolean;
  placeholder: string;
  /** Bookmark label for a row (default: its key). */
  label?: (t: T) => string;
  /** Extra items for a row's menu (after Open). */
  menu?: (t: T) => MenuItem[];
  /** Extra controls next to the filter (scope toggles, …). */
  controls?: ReactNode;
  empty: string;
}

export function ResourceList<T>({ shell, config, reloadToken, onStatus }: { shell: Shell; config: KindConfig<T>; reloadToken: number; onStatus: (s: string) => void }) {
  const { connection, connectionId, profile } = shell;
  const region = connection?.serviceRegion ?? "";
  const listKey = `${connectionId}|${region}|${config.kind}|${config.loadKey ?? ""}|${reloadToken}`;
  const historyKey = `ec2|${profile ?? ""}|${region}|${config.kind}`;
  const [listing, setListing] = useState<{ key: string; items: T[] | null; error: AppError | null } | null>(null);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!connection || listing?.key === listKey) return;
    let stale = false;
    config
      .load()
      .then((items) => !stale && setListing({ key: listKey, items, error: null }))
      .catch((e) => !stale && setListing({ key: listKey, items: null, error: e as AppError }));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, connection]);
  useEffect(() => {
    if (!profile) return;
    api
      .getSettings()
      .then((s) => setHistory(s.filterHistory?.[historyKey] ?? []))
      .catch(() => setHistory([]));
  }, [historyKey, profile]);
  useEffect(() => setSelected(new Set()), [config.kind, config.loadKey]);

  const all = listing?.items ?? null;
  const shown = useMemo(() => (all && filter ? all.filter((t) => config.match(t, filter)) : all), [all, filter, config]);
  const byKey = useMemo(() => new Map((all ?? []).map((t) => [config.key(t), t])), [all, config]);
  const paging = usePaging(`${listKey}|${filter}`, shown?.length ?? 0, `ec2.${config.kind}.pageSize`, true);
  const rows: Row[] = useMemo(
    () =>
      paging.slice(shown ?? []).map((t) => ({
        key: config.key(t),
        icon: config.icon(t),
        isContainer: false,
        dimmed: config.dimmed?.(t),
        cells: config.cells(t),
      })),
    [paging, shown, config],
  );

  const [singular, plural] = config.noun;
  useEffect(() => {
    if (shown && all) onStatus(`${filter ? `${shown.length.toLocaleString()} of ` : ""}${all.length.toLocaleString()} ${all.length === 1 ? singular : plural}${filter ? ` matching "${filter}"` : ""} · ${region}`);
    else onStatus(`${plural[0].toUpperCase()}${plural.slice(1)} · ${region}`);
  }, [shown, all, filter, singular, plural, region, onStatus]);

  async function applyFilter(v: string) {
    setFilter(v);
    try {
      setHistory(await api.rememberFilter(historyKey, v));
    } catch {
      /* convenience only */
    }
  }
  async function forget(v: string | null) {
    try {
      setHistory(await api.forgetFilter(historyKey, v));
    } catch {
      /* ignore */
    }
  }

  const open = (k: string) => shell.navigate({ ...EC2_ROOT, kind: config.kind, id: k });
  function menu(k: string | null, x: number, y: number) {
    const t = k ? byKey.get(k) : undefined;
    const items: MenuItem[] = [];
    if (t && k) {
      items.push(
        { label: "Open", bold: true, shortcut: "Enter", onClick: () => open(k) },
        "separator",
        ...(config.menu ? [...config.menu(t), "separator" as const] : []),
        { label: "Copy ID", onClick: () => void shell.copyText(k) },
        { label: "Add bookmark…", onClick: () => shell.addBookmark({ ...EC2_ROOT, kind: config.kind, id: k }, null, config.label?.(t) ?? null) },
        "separator",
      );
    } else {
      items.push({ label: "Add bookmark…", onClick: () => shell.addBookmark({ ...EC2_ROOT, kind: config.kind }, null, null) }, "separator");
    }
    items.push({ label: "Refresh", shortcut: "F5", onClick: () => setListing(null) });
    shell.openMenu(x, y, items);
  }

  return (
    <div className="service-pane">
      <HelpTopic id={config.help} />
      <FilterBox
        label="Filter:"
        applied={filter}
        history={history}
        placeholder={config.placeholder}
        onApply={(v) => void applyFilter(v)}
        onClear={() => setFilter("")}
        onForget={(v) => void forget(v)}
        onClearHistory={() => void forget(null)}
      >
        {config.controls}
      </FilterBox>
      {listing?.error && listing.key === listKey ? (
        <ErrorPanel error={listing.error} profile={profile} onRetry={() => setListing(null)} />
      ) : (
        <>
          <FileList
            storageKey={`ec2.${config.kind}`}
            columns={config.columns}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            onOpen={open}
            onContextMenu={menu}
            emptyText={!shown || listing?.key !== listKey ? "Loading…" : filter ? `No ${plural} match "${filter}".` : config.empty}
          />
          {shown && shown.length > paging.pageSize && <PageBar {...paging.bar} loading={false} />}
        </>
      )}
    </div>
  );
}
