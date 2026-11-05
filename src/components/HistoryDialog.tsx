// Activity history: what was done in the app, per profile, newest first.
// Opening an entry goes to where it happened; nothing is ever re-run.
import { useCallback, useEffect, useState } from "react";
import { api, type Settings } from "../api/s3";
import type { AppError } from "../api/core";
import {
  DEFAULT_HISTORY_SETTINGS,
  historyApi,
  type HistoryCursor,
  type HistoryEntry,
  type HistoryPeriod,
  type HistoryQuery,
  type HistorySettings,
} from "../api/history";
import { onHistoryRecorded } from "../history/recorder";
import { SERVICES } from "../shell/places";
import type { Shell } from "../shell/shell";
import { DialogHelp } from "./HelpDialog";

const PAGE = 200;

const SERVICE_NAMES: Record<string, string> = {
  app: "App",
  ...Object.fromEntries(SERVICES.map((s) => [s.id, s.name])),
};

const PERIODS: { value: HistoryPeriod; label: string }[] = [
  { value: "day", label: "Every day" },
  { value: "week", label: "Every week (ISO weeks)" },
  { value: "month", label: "Every month" },
  { value: "year", label: "Every year" },
];

interface Props {
  shell: Shell;
  settings: HistorySettings;
  onSettingsSaved: (s: Settings) => void;
  /** Go to where an entry happened (switching profile / region if needed). */
  onGoTo: (e: HistoryEntry) => void;
  onClose: () => void;
}

/** Local calendar date "YYYY-MM-DD" → UTC ISO at the start (or end) of that local day. */
function dayBound(date: string, end: boolean): string | null {
  if (!date) return null;
  const [y, m, d] = date.split("-").map(Number);
  const t = end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d);
  return isNaN(t.getTime()) ? null : t.toISOString();
}

function localTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function resultText(e: HistoryEntry): string {
  if (e.ok) return "OK";
  switch (e.errorKind) {
    case "accessDenied":
      return "Access denied";
    case "ssoExpired":
      return "SSO expired";
    case "noCredentials":
      return "No credentials";
    case "unreachable":
      return "Unreachable";
    default:
      return "Failed";
  }
}

export function HistoryDialog({ shell, settings, onSettingsSaved, onGoTo, onClose }: Props) {
  const current = shell.connection?.profile ?? shell.profile ?? "";
  const [profile, setProfile] = useState(current);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [service, setService] = useState("");
  const [text, setText] = useState("");
  const [failedOnly, setFailedOnly] = useState(false);
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [next, setNext] = useState<HistoryCursor | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState<AppError | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState<HistorySettings>({ ...DEFAULT_HISTORY_SETTINGS, ...settings });
  const [busy, setBusy] = useState(false);

  const query: HistoryQuery = {
    profile,
    service: service || null,
    text: text.trim() || null,
    failedOnly,
    from: dayBound(fromDay, false),
    to: dayBound(toDay, true),
  };
  const queryKey = JSON.stringify(query);

  const load = useCallback(async () => {
    if (!profile) return;
    try {
      const q = JSON.parse(queryKey) as HistoryQuery;
      const p = await historyApi.page(q, null, PAGE);
      setEntries(p.entries);
      setNext(p.next);
      setSkipped(p.skipped);
      setSelected(null);
      setError(null);
    } catch (e) {
      setError(e as AppError);
    }
  }, [profile, queryKey]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 150);
    return () => window.clearTimeout(t);
  }, [load]);

  // New entries (from actions taken while the dialog is open) show up at once,
  // as long as only the first page is loaded.
  useEffect(
    () =>
      onHistoryRecorded(() => {
        if (next === null || (entries?.length ?? 0) <= PAGE) void load();
      }),
    [load, next, entries],
  );

  useEffect(() => {
    historyApi
      .profiles()
      .then((list) => setProfiles(list.includes(current) || !current ? list : [...list, current].sort((a, b) => a.localeCompare(b))))
      .catch(() => setProfiles(current ? [current] : []));
  }, [current]);

  async function loadMore() {
    if (!next) return;
    try {
      const p = await historyApi.page(query, next, PAGE);
      setEntries((e) => [...(e ?? []), ...p.entries]);
      setNext(p.next);
      setSkipped((s) => s + p.skipped);
    } catch (e) {
      setError(e as AppError);
    }
  }

  async function exportEntries() {
    const dest = await api.pickSaveAs("Export history", `history-${profile}.csv`);
    if (!dest) return;
    const format = dest.toLowerCase().endsWith(".json") ? "json" : "csv";
    setBusy(true);
    try {
      const n = await historyApi.export(query, format, dest);
      shell.showFlash(`Exported ${n.toLocaleString()} entr${n === 1 ? "y" : "ies"} to ${dest}`);
    } catch (e) {
      shell.showError(e);
    } finally {
      setBusy(false);
    }
  }

  async function clearHistory() {
    const ok = await shell.confirmTyped(
      "Clear history",
      <p>
        Permanently delete every history file for profile <b>{profile}</b>? This can't be undone. Other profiles' history stays.
      </p>,
      profile,
      "Clear history",
    );
    if (!ok) return;
    try {
      await historyApi.clear(profile);
      shell.showFlash(`History cleared for ${profile}`);
      void load();
    } catch (e) {
      shell.showError(e);
    }
  }

  async function saveSettings() {
    setBusy(true);
    try {
      const value: HistorySettings = {
        ...draft,
        maxFileMb: Math.max(0, Math.min(1024, Math.round(draft.maxFileMb) || 0)),
        keepFiles: Math.max(0, Math.min(10000, Math.round(draft.keepFiles) || 0)),
      };
      onSettingsSaved(await historyApi.setSettings(value));
      setDraft(value);
      shell.showFlash("History settings saved");
      void load();
    } catch (e) {
      shell.showError(e);
    } finally {
      setBusy(false);
    }
  }

  const sel = selected !== null ? (entries?.[selected] ?? null) : null;
  const canGo = (e: HistoryEntry | null) => !!e?.place;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog activity-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="activity-title"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "Enter" && sel && canGo(sel) && !(e.target as HTMLElement).closest("input, select, button")) onGoTo(sel);
        }}
      >
        <div className="dialog-title" id="activity-title">
          History
          <DialogHelp topic="history" />
        </div>
        <div className="dialog-body">
          <div className="row activity-filters">
            <label className="field-label" htmlFor="ah-profile">
              Profile:
            </label>
            <select id="ah-profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
              {profiles.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select aria-label="Service" value={service} onChange={(e) => setService(e.target.value)}>
              <option value="">All services</option>
              {Object.entries(SERVICE_NAMES).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <input type="search" placeholder="Contains…" aria-label="Text" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="row activity-filters">
            <label className="field-label" htmlFor="ah-from">
              From:
            </label>
            <input id="ah-from" type="date" value={fromDay} onChange={(e) => setFromDay(e.target.value)} />
            <label className="field-label" htmlFor="ah-to">
              To:
            </label>
            <input id="ah-to" type="date" value={toDay} onChange={(e) => setToDay(e.target.value)} />
            <label className="check">
              <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} /> Failures only
            </label>
          </div>

          {!settings.enabled && <div className="warn-note">Recording is off. Turn it on under Settings.</div>}
          {error && <div className="field-error">{error.message}</div>}
          {entries === null && !error && <div className="hint">Loading…</div>}
          {entries !== null && entries.length === 0 && <div className="hint">Nothing recorded{query.service || query.text || failedOnly || fromDay || toDay ? " matches the filters" : " yet"}.</div>}
          {entries !== null && entries.length > 0 && (
            <div className="sync-table-wrap activity-table-wrap">
              <table className="sync-table activity-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Service</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Result</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) => (
                    <tr
                      key={`${e.time}-${i}`}
                      className={`${selected === i ? "selected" : ""} ${e.ok ? "" : "failed"}`}
                      title={canGo(e) ? "Double-click to go to where this happened" : undefined}
                      onClick={() => setSelected(i)}
                      onDoubleClick={() => canGo(e) && onGoTo(e)}
                    >
                      <td>{localTime(e.time)}</td>
                      <td>
                        {SERVICE_NAMES[e.service] ?? e.service}
                        {e.region && <span className="muted"> {e.region}</span>}
                      </td>
                      <td>{e.action}</td>
                      <td className="mono">{e.target}</td>
                      <td className={e.ok ? "" : "danger-text"} title={e.message ?? undefined}>
                        {resultText(e)}
                      </td>
                      <td className="mono">{e.ok ? (e.detail ?? "") : [e.message, e.detail].filter(Boolean).join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row">
            {entries !== null && (
              <span className="hint">
                {entries.length.toLocaleString()} entr{entries.length === 1 ? "y" : "ies"}
                {next ? " shown" : ""}
                {skipped > 0 ? ` · ${skipped} unreadable line${skipped === 1 ? "" : "s"} skipped` : ""}
              </span>
            )}
            {next && (
              <button className="btn" onClick={() => void loadMore()}>
                Load older
              </button>
            )}
            <div className="spacer" />
            <button className="btn" disabled={!sel || !canGo(sel)} onClick={() => sel && onGoTo(sel)} title="Opens the location; nothing is run again">
              Go to location
            </button>
          </div>

          {showSettings && (
            <div className="props-section activity-settings">
              <div className="row">
                <label className="check">
                  <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Record history
                </label>
              </div>
              <div className="row">
                <label className="field-label" htmlFor="ah-period">
                  Start a new file:
                </label>
                <select id="ah-period" value={draft.period} onChange={(e) => setDraft({ ...draft, period: e.target.value as HistoryPeriod })}>
                  {PERIODS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <label className="field-label" htmlFor="ah-size">
                  and at
                </label>
                <input id="ah-size" type="number" min={0} max={1024} className="num-input" value={draft.maxFileMb} onChange={(e) => setDraft({ ...draft, maxFileMb: Number(e.target.value) })} />
                <span>MB (0 = no limit)</span>
              </div>
              <div className="row">
                <label className="field-label" htmlFor="ah-keep">
                  Keep the newest
                </label>
                <input id="ah-keep" type="number" min={0} max={10000} className="num-input" value={draft.keepFiles} onChange={(e) => setDraft({ ...draft, keepFiles: Number(e.target.value) })} />
                <span>files per profile (0 = keep all; older files are deleted)</span>
              </div>
              <div className="row">
                <span className="hint">Times are in UTC for file names, shown in local time here. Only names and locations are recorded, never values.</span>
                <div className="spacer" />
                <button className="btn" disabled={busy} onClick={() => void saveSettings()}>
                  Save settings
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="dialog-buttons">
          <button className="btn" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? "Hide settings" : "Settings…"}
          </button>
          <button className="btn" disabled={busy || !entries?.length} onClick={() => void exportEntries()} title="CSV, or JSON if the file name ends in .json">
            Export…
          </button>
          <button className="btn" onClick={() => void historyApi.openFolder(profile || null).catch(shell.showError)}>
            Open folder
          </button>
          <button className="btn danger" disabled={!profile || !entries?.length} onClick={() => void clearHistory()}>
            Clear…
          </button>
          <div className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
