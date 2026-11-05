// Records finished commands in the activity history. Installed once by App;
// it sees every `call` (api/core.ts) and writes an entry for commands that have
// a rule in rules.ts. Recording is fire-and-forget: a failure to write history
// never affects the command itself.
import { setCallObserver, type AppError } from "../api/core";
import { historyApi } from "../api/history";
import type { Place } from "../shell/places";
import { RULES } from "./rules";

let currentPlace: Place = { service: "home" };
const listeners = new Set<() => void>();

/** App keeps this up to date so rules can fall back to the place on screen. */
export function setHistoryPlace(p: Place) {
  currentPlace = p;
}

/** Called after each entry is written (the History dialog refreshes). */
export function onHistoryRecorded(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Refusals that mean nothing was attempted aren't worth recording. */
const NOT_ATTEMPTED = new Set(["readOnly", "notConnected"]);

function observe(cmd: string, args: Record<string, unknown>, result: unknown, error: AppError | null) {
  const rule = RULES[cmd];
  if (!rule || (error && NOT_ATTEMPTED.has(error.kind))) return;
  const place = currentPlace;
  const d = rule(args, result, { place });
  if (!d) return;
  void historyApi
    .record({
      service: d.service,
      action: d.action,
      target: d.target,
      place: d.place === undefined ? (place.service === "home" ? null : place) : d.place,
      select: d.select ?? null,
      ok: error === null,
      errorKind: error?.kind ?? null,
      message: error?.message ?? null,
      detail: d.detail ?? null,
    })
    .then(() => listeners.forEach((l) => l()))
    .catch(() => {
      /* history is best-effort */
    });
}

export function installHistoryRecorder() {
  setCallObserver((cmd, args, result, error) => {
    try {
      observe(cmd, args, result, error);
    } catch {
      /* a rule that trips over odd arguments mustn't break anything */
    }
  });
}
