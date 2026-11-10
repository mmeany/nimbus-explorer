// App shell: profile/connection, theme, layout (toolbar, tree, main panel,
// status bar), navigation history across services, and shared dialogs.
// Each service (src/services/*) supplies its tree branch, content, commands
// and status through a controller hook.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type AppError, type ConnectionInfo, type ProfileInfo, type Settings, type ThemePref } from "./api/s3";
import { ConfirmDialog, type ConfirmButton } from "./components/ConfirmDialog";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { ContextMenu, type MenuItem } from "./components/ContextMenu";
import { ErrorPanel, NoProfilesPanel } from "./components/ErrorPanel";
import { FileList, type Column, type Row } from "./components/FileList";
import { HelpDialog } from "./components/HelpDialog";
import { HistoryDialog } from "./components/HistoryDialog";
import { BookmarkDialog, type BookmarkDraft } from "./components/BookmarkDialog";
import { BookmarksBar } from "./components/BookmarksBar";
import { BookmarkManager } from "./components/BookmarkManager";
import { BookmarkImportDialog, exportBookmarks, pickImport } from "./components/BookmarkTransfer";
import { bookmarksApi, type Bookmark } from "./api/bookmarks";
import { currentBookmarks, findBookmark, isPlaceBookmarked, loadBookmarks, useBookmarks } from "./state/bookmarks";
import { currentSelection } from "./state/selection";
import { BucketIcon, CloudIcon, LockIcon, ParamStoreIcon, ServerIcon, SqsIcon, DynamoIcon, SecretsIcon, SnsIcon, RdsIcon, LogsIcon, LambdaIcon, EcsIcon } from "./components/Icons";
import { PromptDialog } from "./components/PromptDialog";
import { TypedConfirmDialog } from "./components/TypedConfirmDialog";
import { StatusBar } from "./components/StatusBar";
import { Toolbar } from "./components/Toolbar";
import { TransferIndicator, TransfersPanel } from "./components/TransfersPanel";
import { TreeRow } from "./components/TreeRow";
import { useS3Service } from "./services/s3/useS3Service";
import { useSsmService } from "./services/ssm/useSsmService";
import { useSqsService } from "./services/sqs/useSqsService";
import { useSnsService } from "./services/sns/useSnsService";
import { useDynamoService } from "./services/dynamodb/useDynamoService";
import { useRdsService } from "./services/rds/useRdsService";
import { useLogsService } from "./services/logs/useLogsService";
import { useLambdaService } from "./services/lambda/useLambdaService";
import { useEcsService } from "./services/ecs/useEcsService";
import { useSecretsService } from "./services/secrets/useSecretsService";
import { DEFAULT_HISTORY_SETTINGS, type HistoryEntry } from "./api/history";
import { placeTopic } from "./help";
import { openHelp, registeredHelpTopic, useOpenHelp } from "./help/store";
import { HOME, parentPlace, placeCrumbs, placeUri, S3_ROOT, samePlace, SERVICES, type Place, type ServiceId } from "./shell/places";
import type { ServiceUi, Shell } from "./shell/shell";
import { installHistoryRecorder, setHistoryPlace } from "./history/recorder";
import { useHistory } from "./state/navigation";
import { requestReveal } from "./state/reveal";
import { useTheme } from "./state/theme";
import { useTransfers } from "./state/transfers";

interface ConfirmState {
  title: string;
  body: ReactNode;
  buttons: ConfirmButton<string>[];
  cancelValue: string;
  resolve: (value: string) => void;
}

interface PromptState {
  title: string;
  label: string;
  initial: string;
  okLabel: string;
  validate: (v: string) => string | null;
  resolve: (v: string | null) => void;
}

// Every finished command passes the activity-history recorder (src/history/).
installHistoryRecorder();

const TREE_WIDTH_KEY = "s3x.treeWidth";

function loadTreeWidth(): number {
  try {
    const v = Number(localStorage.getItem(TREE_WIDTH_KEY));
    return v >= 160 && v <= 600 ? v : 260;
  } catch {
    return 260;
  }
}

const SERVICE_ICONS: Record<ServiceId, ReactNode> = {
  s3: <BucketIcon />,
  ssm: <ParamStoreIcon />,
  sqs: <SqsIcon />,
  sns: <SnsIcon />,
  rds: <RdsIcon />,
  ecs: <EcsIcon />,
  lambda: <LambdaIcon />,
  logs: <LogsIcon />,
  dynamodb: <DynamoIcon />,
  secrets: <SecretsIcon />,
};

const HOME_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 260 },
  { id: "desc", label: "Description", width: 360 },
];

export default function App() {
  const [profiles, setProfiles] = useState<ProfileInfo[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [connectError, setConnectError] = useState<AppError | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [showConnDialog, setShowConnDialog] = useState(false);
  const [treeWidth, setTreeWidth] = useState(loadTreeWidth);
  const [connectionId, setConnectionId] = useState(0);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [typedConfirm, setTypedConfirm] = useState<{
    title: string;
    body: ReactNode;
    confirmText: string;
    actionLabel: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [showTransfers, setShowTransfers] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [homeSelected, setHomeSelected] = useState<Set<string>>(new Set());
  const [showHistory, setShowHistory] = useState(false);
  const flashTimer = useRef<number | undefined>(undefined);
  const nav = useHistory<Place>(HOME, samePlace);
  const place = nav.current;
  // History entries fall back to the place on screen when a command doesn't say where.
  setHistoryPlace(place);
  const treeRef = useRef<HTMLDivElement>(null);

  const themePref: ThemePref = settings?.theme ?? "system";
  useTheme(themePref);

  async function changeTheme(theme: ThemePref) {
    // Apply immediately; persisting is best-effort.
    setSettings((s) => (s ? { ...s, theme } : { lastProfile: null, overrides: {}, regions: {}, filterHistory: {}, history: DEFAULT_HISTORY_SETTINGS, hideBookmarksBar: false, theme }));
    try {
      setSettings(await api.setTheme(theme));
    } catch {
      /* keep the in-memory choice even if saving failed */
    }
  }

  async function toggleReadOnly() {
    if (!connection) return;
    const enable = !connection.readOnly;
    if (!enable) {
      const prod = /prod|prd/i.test(connection.profile);
      const ok = await ask(
        "Allow changes?",
        <>
          <p>Allow uploads, deletes and other changes for profile "{connection.profile}"?</p>
          {prod && <p className="warn-note">This looks like a production profile.</p>}
          <p className="hint">Changes stay allowed until you lock it again or connect to a profile; every connection starts read-only.</p>
        </>,
        [
          { label: "Allow changes", value: "yes", danger: true },
          { label: "Stay read-only", value: "no", primary: true },
        ],
        "no",
      );
      if (ok !== "yes") return;
    }
    try {
      setConnection(await api.setReadOnly(enable));
    } catch (e) {
      showError(e);
    }
  }

  async function changeRegion(region: string) {
    let r: string | null = region;
    if (region === "__other") {
      r = await askName("Other region", "Region code (e.g. us-gov-west-1)", connection?.serviceRegion ?? "", "Use region", (v) =>
        /^[a-z0-9]+(-[a-z0-9]+)+$/.test(v.trim()) ? null : "Enter a region code such as eu-west-2",
      );
    }
    if (!r || r === connection?.serviceRegion) return;
    try {
      setConnection(await api.setRegion(r));
      showFlash(`Region set to ${r} for every service except S3`);
    } catch (e) {
      showError(e);
    }
  }

  // ---------------------------------------------------------------------------
  // Shared dialogs and messages (offered to services through the Shell)

  const ask = useCallback(
    (title: string, body: ReactNode, buttons: ConfirmButton<string>[], cancelValue: string) =>
      new Promise<string>((resolve) => setConfirm({ title, body, buttons, cancelValue, resolve })),
    [],
  );
  const askName = useCallback(
    (title: string, label: string, initial: string, okLabel: string, validate: (v: string) => string | null) =>
      new Promise<string | null>((resolve) => setPrompt({ title, label, initial, okLabel, validate, resolve })),
    [],
  );
  const confirmTyped = useCallback(
    (title: string, body: ReactNode, confirmText: string, actionLabel: string) =>
      new Promise<boolean>((resolve) => setTypedConfirm({ title, body, confirmText, actionLabel, resolve })),
    [],
  );
  const showError = useCallback(
    (e: unknown) => {
      const msg = (e as AppError)?.message ?? String(e);
      void ask("Something went wrong", <p>{msg}</p>, [{ label: "OK", value: "ok", primary: true }], "ok");
    },
    [ask],
  );
  const showFlash = useCallback((msg: string) => {
    setFlash(msg);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 2500);
  }, []);
  const copyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showFlash(`Copied ${text}`);
      } catch (e) {
        showError(e);
      }
    },
    [showFlash, showError],
  );

  const shell: Shell = {
    connection,
    connectionId,
    profile,
    readOnly: connection?.readOnly ?? false,
    place,
    navigate: nav.navigate,
    ask,
    askName,
    confirmTyped,
    showError,
    showFlash,
    setWorking,
    openMenu: (x, y, items) => setMenu({ x, y, items }),
    copyText,
    openTransfers: () => setShowTransfers(true),
    addBookmark: (at, select, label) => addBookmark(at, select, label),
  };

  // ---------------------------------------------------------------------------
  // Services

  const s3 = useS3Service(shell);
  const ssm = useSsmService(shell);
  const sqs = useSqsService(shell);
  const sns = useSnsService(shell);
  const dynamodb = useDynamoService(shell);
  const rds = useRdsService(shell);
  const ecs = useEcsService(shell);
  const lambda = useLambdaService(shell);
  const logs = useLogsService(shell);
  const secrets = useSecretsService(shell);
  const services: Record<ServiceId, ServiceUi> = { s3, ssm, sqs, sns, dynamodb, rds, ecs, lambda, logs, secrets };
  const active: ServiceUi | null = place.service === "home" ? null : services[place.service];

  const servicesRef = useRef(services);
  servicesRef.current = services;
  const transfers = useTransfers((t) => {
    for (const svc of Object.values(servicesRef.current)) svc.onTransferFinished?.(t);
  });

  // ---------------------------------------------------------------------------
  // Profiles & connection

  // Each connect gets a sequence number so a slow response can't win over a newer one.
  const seq = useRef(0);
  const connectTo = useCallback(
    async (name: string): Promise<ConnectionInfo | null> => {
      const my = ++seq.current;
      setProfile(name);
      setConnectError(null);
      setConnecting(true);
      try {
        const info = await api.connect(name);
        if (my !== seq.current) return null;
        setConnection(info);
        setConnectionId((n) => n + 1);
        nav.reset(S3_ROOT);
        return info;
      } catch (e) {
        if (my === seq.current) {
          setConnection(null);
          setConnectError(e as AppError);
        }
      } finally {
        if (my === seq.current) setConnecting(false);
      }
      return null;
    },
    [nav.reset],
  );

  const loadProfiles = useCallback(async () => {
    try {
      const [list, s] = await Promise.all([api.listProfiles(), api.getSettings()]);
      setProfiles(list);
      setSettings(s);
      if (s.lastProfile && list.some((p) => p.name === s.lastProfile)) {
        void connectTo(s.lastProfile);
      }
    } catch (e) {
      setConnectError(e as AppError);
      setProfiles([]);
    }
  }, [connectTo]);

  useEffect(() => {
    void loadProfiles();
    // Run once on start-up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Going to a recorded location (history entries and bookmarks). Never re-runs
  // anything: switches profile (after asking) and region if needed, navigates,
  // and selects the item when it's listed.

  async function openLocation(
    t: { profile: string; region: string; place?: Place | null; select?: string | null },
    what: "entry" | "bookmark",
  ): Promise<boolean> {
    const target = t.place;
    if (!target || !SERVICES.some((s) => s.id === target.service)) {
      showFlash(`This ${what} has no location to go to`);
      return false;
    }
    let info = connection;
    if (!info || t.profile !== info.profile) {
      if (!profiles?.some((p) => p.name === t.profile)) {
        showError({ kind: "other", message: `Profile "${t.profile}" isn't in your AWS config any more.`, detail: "" });
        return false;
      }
      const ok = await ask(
        "Switch profile?",
        <>
          <p>
            {what === "entry" ? "This happened with" : "This bookmark is for"} profile "{t.profile}". Connect to it and go there?
          </p>
          <p className="hint">The new connection starts read-only, as always.</p>
        </>,
        [
          { label: "Switch and go", value: "yes", primary: true },
          { label: "Cancel", value: "no" },
        ],
        "no",
      );
      if (ok !== "yes") return false;
      info = await connectTo(t.profile);
      if (!info) return false;
    }
    if (t.region && target.service !== "s3" && t.region !== info.serviceRegion) {
      try {
        setConnection(await api.setRegion(t.region));
        showFlash(`Region set to ${t.region} (${what === "entry" ? "where this happened" : "the bookmark's region"})`);
      } catch (err) {
        showError(err);
        return false;
      }
    }
    requestReveal(t.select ?? null);
    nav.navigate(target);
    return true;
  }

  async function goToEntry(e: HistoryEntry) {
    if (await openLocation(e, "entry")) setShowHistory(false);
  }

  // ---------------------------------------------------------------------------
  // Bookmarks

  const bookmarks = useBookmarks();
  const [bookmarkEdit, setBookmarkEdit] = useState<{ draft: BookmarkDraft; existing: Bookmark | null; folder?: string | null } | null>(null);
  const barVisible = !(settings?.hideBookmarksBar ?? false);

  useEffect(() => {
    void loadBookmarks();
  }, []);

  /** Opens the add (or, if it exists, edit) dialog for a place and optional item. */
  const addBookmark = useCallback(
    (at: Place, select: string | null, label: string | null, folder: string | null = null, who: { profile: string; region: string } | null = null) => {
      if (!connection || at.service === "home") return;
      const profile = who?.profile ?? connection.profile;
      const existing = findBookmark(currentBookmarks(), profile, at, select);
      const crumbs = placeCrumbs(at);
      const name = label ?? crumbs[crumbs.length - 1]?.label ?? SERVICES.find((s) => s.id === at.service)?.name ?? "Bookmark";
      setBookmarkEdit({
        existing,
        folder,
        draft: {
          profile,
          region: at.service === "s3" ? "" : (who?.region || connection.serviceRegion),
          service: at.service,
          place: at,
          select,
          name: name.slice(0, 100),
        },
      });
    },
    [connection],
  );

  /** Star / Ctrl+D: the current place, plus the selected row when exactly one is. */
  function bookmarkHere() {
    if (!connection || place.service === "home") return;
    const sel = currentSelection();
    addBookmark(place, sel?.key ?? null, sel?.label ?? null);
  }

  const [showManager, setShowManager] = useState(false);
  const [importing, setImporting] = useState<{ path: string; file: import("./api/bookmarks").BookmarkFile } | null>(null);
  function manageBookmarks() {
    setShowManager(true);
  }

  function editBookmark(b: Bookmark) {
    setBookmarkEdit({ existing: b, draft: { profile: b.profile, region: b.region, service: b.service, place: b.place, select: b.select ?? null, name: b.name } });
  }

  async function toggleBar() {
    const visible = !barVisible;
    setSettings((s) => (s ? { ...s, hideBookmarksBar: !visible } : s));
    try {
      setSettings(await bookmarksApi.setBarVisible(visible));
    } catch {
      /* keep the in-memory choice */
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation

  const refresh = useCallback(() => {
    if (connection) active?.refresh();
  }, [connection, active]);

  const goUp = useCallback(() => {
    const p = parentPlace(place);
    if (p) nav.navigate(p);
  }, [nav, place]);

  const helpTopic = useOpenHelp();
  const showHelp = useCallback(() => {
    openHelp(connection ? (registeredHelpTopic() ?? placeTopic(place)) : "general");
  }, [connection, place]);

  // Explorer keyboard shortcuts (ignored while typing in inputs or dialogs).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // F1 works everywhere, including inside dialogs.
      if (e.key === "F1") {
        e.preventDefault();
        if (!document.querySelector(".help-dialog")) showHelp();
        return;
      }
      const t = e.target as HTMLElement;
      const inDialog = !!t.closest?.("[role=dialog], [role=alertdialog]");
      const k = e.key.toLowerCase();
      if (e.ctrlKey && !e.altKey && !inDialog && ((!e.shiftKey && (k === "h" || k === "d")) || (e.shiftKey && (k === "b" || k === "o")))) {
        e.preventDefault();
        if (k === "h") setShowHistory(true);
        else if (k === "d") bookmarkHereRef.current();
        else if (k === "b") void toggleBarRef.current();
        else onManageBookmarksRef.current();
        return;
      }
      if (t.closest("input, textarea, select, [role=dialog], [role=alertdialog]")) return;
      if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) {
        e.preventDefault();
        goUp();
      } else if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        nav.back();
      } else if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        nav.forward();
      } else if (e.key === "F5") {
        e.preventDefault();
        refresh();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goUp, nav, refresh, showHelp]);
  // The key handler is registered once per dependency change; these stay current.
  const bookmarkHereRef = useRef(bookmarkHere);
  bookmarkHereRef.current = bookmarkHere;
  const toggleBarRef = useRef(toggleBar);
  toggleBarRef.current = toggleBar;
  const onManageBookmarksRef = useRef(manageBookmarks);
  onManageBookmarksRef.current = manageBookmarks;

  // Keep the selected tree node in view.
  useEffect(() => {
    treeRef.current?.querySelector(".tree-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [place]);

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = treeWidth;
    const clamp = (x: number) => Math.min(600, Math.max(160, startW + x - startX));
    const move = (ev: MouseEvent) => setTreeWidth(clamp(ev.clientX));
    const up = (ev: MouseEvent) => {
      try {
        localStorage.setItem(TREE_WIDTH_KEY, String(clamp(ev.clientX)));
      } catch {
        /* storage unavailable: width just isn't remembered */
      }
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // ---------------------------------------------------------------------------
  // Layout

  const homeRows: Row[] = useMemo(
    () =>
      SERVICES.map((s) => ({
        key: s.id,
        icon: SERVICE_ICONS[s.id],
        isContainer: true,
        cells: { name: { text: s.name, sort: s.name }, desc: { text: s.description, sort: s.description } },
      })),
    [],
  );

  const currentProfile = profiles?.find((p) => p.name === profile) ?? null;

  let content: ReactNode;
  if (profiles !== null && profiles.length === 0 && !connectError) {
    content = <NoProfilesPanel onRetry={loadProfiles} />;
  } else if (connectError) {
    content = (
      <ErrorPanel error={connectError} profile={profile} onRetry={() => (profile ? connectTo(profile) : loadProfiles())} />
    );
  } else if (!profile) {
    content = <div className="empty-note center">Choose an AWS profile to start.</div>;
  } else if (!connection) {
    content = <div className="empty-note center">Connecting…</div>;
  } else if (active) {
    content = active.content;
  } else {
    content = (
      <FileList
        storageKey="home"
        columns={HOME_COLUMNS}
        rows={homeRows}
        selected={homeSelected}
        onSelectionChange={setHomeSelected}
        onOpen={(id) => nav.navigate(SERVICES.find((s) => s.id === id)!.root)}
        emptyText=""
      />
    );
  }

  let statusLeft = active ? active.status : connection ? `${SERVICES.length} service${SERVICES.length === 1 ? "" : "s"}` : "";
  if (working) statusLeft = working;
  else if (flash) statusLeft = flash;
  const statusRight = connection ? `Profile: ${connection.profile}` : "Not connected";

  return (
    <div className="app">
      <Toolbar
        profiles={profiles ?? []}
        profile={profile}
        connection={connection}
        busy={connecting || working !== null || (active?.busy ?? false)}
        theme={themePref}
        onThemeChange={(t) => void changeTheme(t)}
        onRegionChange={(r) => void changeRegion(r)}
        onToggleReadOnly={() => void toggleReadOnly()}
        place={place}
        canBack={nav.canBack}
        canForward={nav.canForward}
        canUp={parentPlace(place) !== null}
        commands={connection ? active?.commands : null}
        uri={placeUri(place)}
        onProfileChange={(name) => name && void connectTo(name)}
        onConnectionSettings={() => setShowConnDialog(true)}
        onRefresh={refresh}
        onCopyLocation={() => void copyText(placeUri(place))}
        onBack={nav.back}
        onForward={nav.forward}
        onUp={goUp}
        onNavigate={nav.navigate}
        onHelp={showHelp}
        onHistory={() => setShowHistory(true)}
        canBookmark={!!connection && place.service !== "home"}
        bookmarked={!!connection && isPlaceBookmarked(bookmarks, connection.profile, place)}
        onBookmark={bookmarkHere}
        bookmarksBar={
          connection && barVisible ? (
            <BookmarksBar
              file={bookmarks}
              profile={connection.profile}
              serviceRegion={connection.serviceRegion}
              icons={SERVICE_ICONS}
              onOpen={(b) => void openLocation(b, "bookmark")}
              onManage={manageBookmarks}
              onFlash={showFlash}
              onError={showError}
            />
          ) : null
        }
      />
      {connection?.readOnly && (
        <div className="readonly-banner" role="status">
          <LockIcon size={14} /> Read-only mode: changes are disabled for profile "{connection.profile}".
          <button className="link-btn" onClick={() => void toggleReadOnly()}>
            Allow changes…
          </button>
        </div>
      )}
      <div className="panes">
        <div className="pane-tree" style={{ width: treeWidth }} ref={treeRef}>
          {connection ? (
            <div className="tree" role="tree">
              <TreeRow
                depth={0}
                label={connection.endpointUrl ?? `AWS (${connection.profile})`}
                icon={connection.endpointUrl ? <ServerIcon /> : <CloudIcon />}
                selected={place.service === "home"}
                expanded
                onClick={() => nav.navigate(HOME)}
              >
                {SERVICES.map((s) => (
                  <div key={s.id}>{services[s.id].tree}</div>
                ))}
              </TreeRow>
            </div>
          ) : (
            <div className="tree empty-note">No connection</div>
          )}
        </div>
        <div className="splitter" onMouseDown={startResize} />
        <div className="pane-main">{content}</div>
      </div>
      <StatusBar
        left={statusLeft}
        middle={<TransferIndicator summary={transfers.summary} onClick={() => setShowTransfers((v) => !v)} />}
        right={statusRight}
      />
      {showTransfers && (
        <TransfersPanel list={transfers.list} onClose={() => setShowTransfers(false)} onClearFinished={transfers.clearFinished} />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {SERVICES.map((s) => (
        <div key={s.id} style={{ display: "contents" }}>
          {services[s.id].dialogs}
        </div>
      ))}
      {/* Before the shared dialogs, so their confirmations and prompts show on top. */}
      {showHistory && (
        <HistoryDialog
          shell={shell}
          settings={settings?.history ?? DEFAULT_HISTORY_SETTINGS}
          onSettingsSaved={setSettings}
          onGoTo={(e) => void goToEntry(e)}
          onBookmark={(e) => e.place && e.place.service !== "home" && addBookmark(e.place, e.select ?? null, null, null, { profile: e.profile, region: e.region })}
          onClose={() => setShowHistory(false)}
        />
      )}
      {showManager && (
        <BookmarkManager
          shell={shell}
          profiles={(profiles ?? []).map((p) => p.name)}
          icons={SERVICE_ICONS}
          onOpen={(b) => void openLocation(b, "bookmark").then((ok) => ok && setShowManager(false))}
          onEdit={editBookmark}
          transferButtons={({ checked, profile: only }) => (
            <>
              <button
                className="btn"
                title={checked.size ? "Export the ticked folders (and the profile filter)" : "Export everything (or tick folders first)"}
                onClick={() => void exportBookmarks(shell, checked, only)}
              >
                {checked.size ? `Export ${checked.size} folder${checked.size === 1 ? "" : "s"}…` : "Export…"}
              </button>
              <button className="btn" onClick={() => void pickImport(shell).then((r) => r && setImporting(r))}>
                Import…
              </button>
            </>
          )}
          onClose={() => setShowManager(false)}
        />
      )}
      {importing && (
        <BookmarkImportDialog
          shell={shell}
          path={importing.path}
          incoming={importing.file}
          profiles={(profiles ?? []).map((p) => p.name)}
          onClose={() => setImporting(null)}
        />
      )}
      {bookmarkEdit && (
        <BookmarkDialog
          shell={shell}
          draft={bookmarkEdit.draft}
          existing={bookmarkEdit.existing}
          initialFolder={bookmarkEdit.folder}
          onClose={() => setBookmarkEdit(null)}
        />
      )}
      {prompt && (
        <PromptDialog
          title={prompt.title}
          label={prompt.label}
          initial={prompt.initial}
          okLabel={prompt.okLabel}
          validate={prompt.validate}
          onResult={(v) => {
            setPrompt(null);
            prompt.resolve(v);
          }}
        />
      )}
      {typedConfirm && (
        <TypedConfirmDialog
          title={typedConfirm.title}
          confirmText={typedConfirm.confirmText}
          actionLabel={typedConfirm.actionLabel}
          onResult={(ok) => {
            setTypedConfirm(null);
            typedConfirm.resolve(ok);
          }}
        >
          {typedConfirm.body}
        </TypedConfirmDialog>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          buttons={confirm.buttons}
          cancelValue={confirm.cancelValue}
          onResult={(v) => {
            setConfirm(null);
            confirm.resolve(v);
          }}
        >
          {confirm.body}
        </ConfirmDialog>
      )}
      {showConnDialog && currentProfile && (
        <ConnectionDialog
          profile={currentProfile}
          current={settings?.overrides[currentProfile.name] ?? null}
          onCancel={() => setShowConnDialog(false)}
          onSave={async (value) => {
            setShowConnDialog(false);
            try {
              setSettings(await api.setConnectionOverride(currentProfile.name, value));
              await connectTo(currentProfile.name);
            } catch (e) {
              setConnectError(e as AppError);
            }
          }}
        />
      )}
      {helpTopic && <HelpDialog topic={helpTopic} />}
    </div>
  );
}
