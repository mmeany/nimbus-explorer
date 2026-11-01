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
import { HOME, parentPlace, placeUri, S3_ROOT, samePlace, SERVICES, type Place, type ServiceId } from "./shell/places";
import type { ServiceUi, Shell } from "./shell/shell";
import { useHistory } from "./state/navigation";
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
  const flashTimer = useRef<number | undefined>(undefined);
  const nav = useHistory<Place>(HOME, samePlace);
  const place = nav.current;
  const treeRef = useRef<HTMLDivElement>(null);

  const themePref: ThemePref = settings?.theme ?? "system";
  useTheme(themePref);

  async function changeTheme(theme: ThemePref) {
    // Apply immediately; persisting is best-effort.
    setSettings((s) => (s ? { ...s, theme } : { lastProfile: null, overrides: {}, regions: {}, filterHistory: {}, theme }));
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
    async (name: string) => {
      const my = ++seq.current;
      setProfile(name);
      setConnectError(null);
      setConnecting(true);
      try {
        const info = await api.connect(name);
        if (my !== seq.current) return;
        setConnection(info);
        setConnectionId((n) => n + 1);
        nav.reset(S3_ROOT);
      } catch (e) {
        if (my === seq.current) {
          setConnection(null);
          setConnectError(e as AppError);
        }
      } finally {
        if (my === seq.current) setConnecting(false);
      }
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
  // Navigation

  const refresh = useCallback(() => {
    if (connection) active?.refresh();
  }, [connection, active]);

  const goUp = useCallback(() => {
    const p = parentPlace(place);
    if (p) nav.navigate(p);
  }, [nav, place]);

  // Explorer keyboard shortcuts (ignored while typing in inputs or dialogs).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
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
  }, [goUp, nav, refresh]);

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
    </div>
  );
}
