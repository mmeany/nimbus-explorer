import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem =
  | { label: string; onClick: () => void; disabled?: boolean; shortcut?: string; bold?: boolean }
  | "separator";

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** Classic right-click menu, kept inside the window and closed by click-away/Escape. */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 4),
      y: Math.min(y, window.innerHeight - r.height - 4),
    });
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div className="context-menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="cm-sep" role="separator" />
        ) : (
          <button
            key={i}
            className={`cm-item ${item.bold ? "bold" : ""}`}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="cm-shortcut">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
