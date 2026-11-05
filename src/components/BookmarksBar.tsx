// The bookmarks bar: pinned bookmarks, then feature folders (one per service
// with bookmarks), then the user's folders. Only the current profile's
// bookmarks show. Items that don't fit go into a » menu.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Bookmark, BookmarkFile, BookmarkFolder } from "../api/bookmarks";
import { byId, featureItems, featureServices, folderItems } from "../state/bookmarks";
import { SERVICES, type ServiceId } from "../shell/places";
import { FolderIcon } from "./Icons";

type BarItem =
  | { kind: "pin"; key: string; bookmark: Bookmark }
  | { kind: "feature"; key: string; service: ServiceId }
  | { kind: "folder"; key: string; folder: BookmarkFolder };

interface Props {
  file: BookmarkFile;
  profile: string;
  /** Current region of the regional services (bookmarks elsewhere get a tag). */
  serviceRegion: string;
  icons: Record<ServiceId, ReactNode>;
  onOpen: (b: Bookmark) => void;
  onManage: () => void;
}

const serviceName = (id: ServiceId) => SERVICES.find((s) => s.id === id)?.name ?? id;
const OVERFLOW_W = 30;
const GAP = 2;

export function BookmarksBar({ file, profile, serviceRegion, icons, onOpen, onManage }: Props) {
  const items: BarItem[] = useMemo(() => {
    const map = byId(file);
    const pins = file.pinned
      .map((id) => map.get(id))
      .filter((b): b is Bookmark => !!b && b.profile === profile)
      .map((b) => ({ kind: "pin" as const, key: `p:${b.id}`, bookmark: b }));
    const features = featureServices(file, profile).map((s) => ({ kind: "feature" as const, key: `s:${s}`, service: s }));
    const folders = file.folders.map((f) => ({ kind: "folder" as const, key: `f:${f.id}`, folder: f }));
    return [...pins, ...features, ...folders];
  }, [file, profile]);

  // --- Overflow: measure every item once (hidden copy), then show what fits.
  const barRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(items.length);
  const [barWidth, setBarWidth] = useState(0);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBarWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const m = measureRef.current;
    if (!m || !barWidth) return;
    const widths = [...m.children].map((c) => (c as HTMLElement).offsetWidth + GAP);
    const total = widths.reduce((a, b) => a + b, 0);
    let n = widths.length;
    if (total > barWidth - 8) {
      let used = 0;
      n = 0;
      while (n < widths.length && used + widths[n] <= barWidth - OVERFLOW_W - 8) used += widths[n++];
    }
    setVisibleCount(n);
  }, [items, barWidth, file]);

  // --- Drop-down menus
  const [menu, setMenu] = useState<{ key: string; rect: DOMRect } | null>(null);
  const toggle = (key: string, el: HTMLElement) => setMenu((m) => (m?.key === key ? null : { key, rect: el.getBoundingClientRect() }));

  function groupFor(item: BarItem): MenuGroup {
    if (item.kind === "feature")
      return { heading: serviceName(item.service), description: file.featureNotes[item.service] ?? "", items: featureItems(file, item.service, profile) };
    if (item.kind === "folder") return { heading: item.folder.name, description: item.folder.description, items: folderItems(file, item.folder, profile) };
    return { heading: item.bookmark.name, description: "", items: [item.bookmark] };
  }

  function label(item: BarItem): ReactNode {
    if (item.kind === "pin")
      return (
        <>
          {icons[item.bookmark.service]}
          <span>{item.bookmark.name}</span>
        </>
      );
    if (item.kind === "feature")
      return (
        <>
          {icons[item.service]}
          <span>{serviceName(item.service)}</span>
          <span className="bm-chevron">▾</span>
        </>
      );
    return (
      <>
        <FolderIcon />
        <span>{item.folder.name}</span>
        <span className="bm-chevron">▾</span>
      </>
    );
  }

  function title(item: BarItem): string {
    if (item.kind === "pin") return [item.bookmark.name, item.bookmark.description].filter(Boolean).join("\n");
    const g = groupFor(item);
    return [g.heading, g.description].filter(Boolean).join("\n");
  }

  function render(item: BarItem, measuring: boolean) {
    const empty = item.kind === "folder" && folderItems(file, item.folder, profile).length === 0;
    return (
      <button
        key={item.key}
        className={`bm-bar-item ${empty ? "dimmed" : ""} ${menu?.key === item.key && !measuring ? "open" : ""}`}
        title={measuring ? undefined : title(item)}
        tabIndex={measuring ? -1 : undefined}
        data-bm-key={item.key}
        onClick={
          measuring
            ? undefined
            : (e) => {
                if (item.kind === "pin") onOpen(item.bookmark);
                else toggle(item.key, e.currentTarget);
              }
        }
      >
        {label(item)}
      </button>
    );
  }

  const shown = items.slice(0, visibleCount);
  const hidden = items.slice(visibleCount);
  const openItem = menu ? items.find((i) => i.key === menu.key) : null;
  const hiddenPins = hidden.flatMap((i) => (i.kind === "pin" ? [i.bookmark] : []));
  const menuGroups: MenuGroup[] =
    menu?.key === "»"
      ? [...(hiddenPins.length ? [{ heading: "Pinned", description: "", items: hiddenPins }] : []), ...hidden.filter((i) => i.kind !== "pin").map(groupFor)]
      : openItem
        ? [groupFor(openItem)]
        : [];

  return (
    <div className="toolbar-row bookmarks-bar" ref={barRef} role="toolbar" aria-label="Bookmarks">
      <div className="bm-bar-measure" ref={measureRef} aria-hidden>
        {items.map((i) => render(i, true))}
      </div>
      {items.length === 0 && <span className="bm-bar-empty">No bookmarks for this profile yet: press Ctrl+D or the ☆ by the address bar to add one.</span>}
      {shown.map((i) => render(i, false))}
      {hidden.length > 0 && (
        <button className={`bm-bar-item ${menu?.key === "»" ? "open" : ""}`} title="More bookmarks" onClick={(e) => toggle("»", e.currentTarget)}>
          »
        </button>
      )}
      {menu && (
        <BookmarkMenu
          rect={menu.rect}
          groups={menuGroups}
          showHeadings={menu.key === "»"}
          serviceRegion={serviceRegion}
          onOpen={(b) => {
            setMenu(null);
            onOpen(b);
          }}
          onManage={() => {
            setMenu(null);
            onManage();
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

interface MenuGroup {
  heading: string;
  description: string;
  items: Bookmark[];
}

/** Drop-down of a folder (or of everything in the » menu). */
function BookmarkMenu(p: {
  rect: DOMRect;
  groups: MenuGroup[];
  showHeadings: boolean;
  serviceRegion: string;
  onOpen: (b: Bookmark) => void;
  onManage: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [pos, setPos] = useState({ x: p.rect.left, y: p.rect.bottom + 1 });
  const total = p.groups.reduce((n, g) => n + g.items.length, 0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(2, Math.min(p.rect.left, window.innerWidth - r.width - 4)), y: p.rect.bottom + 1 });
  }, [p.rect]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      // A click on a bar button toggles its own menu.
      if (e instanceof MouseEvent && (ref.current?.contains(t) || t?.closest?.(".bm-bar-item"))) return;
      p.onClose();
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", p.onClose);
    window.addEventListener("resize", p.onClose);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", p.onClose);
      window.removeEventListener("resize", p.onClose);
    };
  }, [p]);

  const f = filter.trim().toLowerCase();
  const match = (b: Bookmark) => !f || b.name.toLowerCase().includes(f) || b.description.toLowerCase().includes(f);
  const single = !p.showHeadings && p.groups.length === 1 ? p.groups[0] : null;

  return (
    <div className="bm-menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {single?.description && <div className="bm-menu-head">{single.description}</div>}
      {total > 15 && (
        <input className="text-input bm-menu-filter" type="search" placeholder="Filter…" autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} />
      )}
      <div className="bm-menu-list">
        {p.groups.map((g, gi) => {
          const list = g.items.filter(match);
          return (
            <div key={gi}>
              {p.showHeadings && (
                <div className="bm-menu-group" title={g.description || undefined}>
                  {g.heading}
                </div>
              )}
              {list.length === 0 && <div className="bm-menu-empty">{g.items.length ? "No matches" : "No bookmarks for this profile"}</div>}
              {list.map((b) => (
                <button key={b.id} className="bm-menu-item" role="menuitem" data-bm-id={b.id} title={[b.name, b.description].filter(Boolean).join("\n")} onClick={() => p.onOpen(b)}>
                  {b.name}
                  {b.region && b.region !== p.serviceRegion && <span className="bm-tag">{b.region}</span>}
                  {b.description && <span className="bm-item-desc">{b.description}</span>}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="bm-menu-foot">
        <button className="bm-menu-item" role="menuitem" onClick={p.onManage}>
          Manage bookmarks…
        </button>
      </div>
    </div>
  );
}
