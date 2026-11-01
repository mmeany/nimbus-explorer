// Window/OS integration via Tauri. Together with s3.ts, src/api/ is the only
// place that touches Tauri APIs, so the rest of the UI also runs in a browser.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ThemePref } from "./s3";

export type Theme = "light" | "dark";

const inTauri = "__TAURI_INTERNALS__" in window;

/** Browser fallback: the CSS media query, or null if it gives no answer. */
function mediaTheme(): Theme | null {
  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
  if (window.matchMedia?.("(prefers-color-scheme: light)").matches) return "light";
  return null;
}

/** Applies the preference to the native window (title bar). null = follow OS. */
export async function applyWindowTheme(pref: ThemePref): Promise<void> {
  if (!inTauri) return;
  try {
    await getCurrentWindow().setTheme(pref === "system" ? null : pref);
  } catch {
    /* unsupported platform: the page theme still applies */
  }
}

/** The OS theme, or null if the platform can't report one. */
export async function getOsTheme(): Promise<Theme | null> {
  if (!inTauri) return mediaTheme();
  try {
    return await getCurrentWindow().theme();
  } catch {
    return null;
  }
}

/** Calls `cb` when the OS theme changes. Returns an unsubscribe function. */
export function onOsThemeChanged(cb: (t: Theme) => void): () => void {
  if (!inTauri) {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const h = (e: MediaQueryListEvent) => cb(e.matches ? "dark" : "light");
    mq?.addEventListener("change", h);
    return () => mq?.removeEventListener("change", h);
  }
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  getCurrentWindow()
    .onThemeChanged(({ payload }) => cb(payload))
    .then((u) => (cancelled ? u() : (unlisten = u)))
    .catch(() => {});
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/** Best synchronous guess for first paint, before settings load. Dark if unknown. */
export function initialThemeGuess(): Theme {
  return mediaTheme() ?? "dark";
}

export interface FileDropHandlers {
  /** Files are being dragged over the window at CSS pixel (x, y). */
  over: (x: number, y: number) => void;
  leave: () => void;
  drop: (paths: string[], x: number, y: number) => void;
}

/**
 * Native file drag-and-drop from the OS (e.g. Windows Explorer). Unlike HTML5
 * drop events, this provides real file paths. Returns an unsubscribe function.
 */
export function onFileDrop(h: FileDropHandlers): () => void {
  if (!inTauri) return () => {};
  let un: (() => void) | null = null;
  let cancelled = false;
  getCurrentWebview()
    .onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") return h.leave();
      // Positions are physical pixels; the DOM works in CSS pixels.
      const r = window.devicePixelRatio || 1;
      const x = payload.position.x / r;
      const y = payload.position.y / r;
      if (payload.type === "drop") h.drop(payload.paths, x, y);
      else h.over(x, y);
    })
    .then((u) => (cancelled ? u() : (un = u)))
    .catch(() => {});
  return () => {
    cancelled = true;
    un?.();
  };
}
