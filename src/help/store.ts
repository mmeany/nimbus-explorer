// Which help topic is current, and which one the help dialog is showing.
// Module-level so any view or dialog can take part without a shell prop.
//
// Views only register a topic when the place alone doesn't say enough (a tab, a
// toggle, an open dialog). The newest registration wins, so an open dialog
// beats the view under it; with none, App falls back to `placeTopic`.
import { useSyncExternalStore } from "react";
import type { HelpTopicId } from "./index";

let registered: { token: object; id: HelpTopicId }[] = [];
let open: HelpTopicId | null = null;
const listeners = new Set<() => void>();

export function registerHelpTopic(id: HelpTopicId): () => void {
  const token = {};
  registered = [...registered, { token, id }];
  return () => {
    registered = registered.filter((r) => r.token !== token);
  };
}

/** The topic of the innermost view or dialog on screen, if any registered one. */
export function registeredHelpTopic(): HelpTopicId | null {
  return registered.length ? registered[registered.length - 1].id : null;
}

export function openHelp(id: HelpTopicId) {
  open = id;
  listeners.forEach((l) => l());
}

export function closeHelp() {
  open = null;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The topic the help dialog should show (null = closed). */
export function useOpenHelp(): HelpTopicId | null {
  return useSyncExternalStore(subscribe, () => open);
}
