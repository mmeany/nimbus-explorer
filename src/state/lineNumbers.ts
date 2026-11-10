// "Line numbers" on / off for read-only text (previews, value views, diffs).
// One app-wide setting, remembered in localStorage; every view follows it live.
import { useSyncExternalStore } from "react";

const KEY = "text.lineNumbers";

function load(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

let on = load();
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setLineNumbers(v: boolean) {
  on = v;
  try {
    localStorage.setItem(KEY, v ? "on" : "off");
  } catch {
    // Not remembered; applies until the app restarts.
  }
  listeners.forEach((fn) => fn());
}

export function useLineNumbers(): [boolean, (v: boolean) => void] {
  return [useSyncExternalStore(subscribe, () => on), setLineNumbers];
}
