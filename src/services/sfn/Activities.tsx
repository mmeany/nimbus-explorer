// Step Functions activities: a tree node under Step Functions with its own
// list (place `{ service: "sfn", view: "activities" }`), details, and
// create / delete. An activity is a task your own workers poll for.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppError } from "../../api/core";
import { sfnApi, type Activity } from "../../api/sfn";
import { CommandButton, CommandSeparator } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { DialogHelp } from "../../components/HelpDialog";
import { ActivityIcon, DeleteIcon, NewItemIcon, RefreshIcon } from "../../components/Icons";
import { PageBar } from "../../components/PageBar";
import { TreeRow } from "../../components/TreeRow";
import { formatDate } from "../../format";
import { SFN_ROOT, type Place } from "../../shell/places";
import type { Shell } from "../../shell/shell";
import { usePaging } from "../../state/paged";
import { PropsTable } from "./MachineView";

const COLUMNS: Column[] = [
  { id: "name", label: "Activity", width: 280 },
  { id: "created", label: "Created", width: 165 },
  { id: "arn", label: "ARN", width: 460 },
];

const ACTIVITIES: Place = { ...SFN_ROOT, view: "activities" };

export interface ActivitiesUi {
  treeRow: ReactNode;
  content: ReactNode;
  commands: ReactNode;
  status: string;
  dialogs: ReactNode;
  busy: boolean;
  refresh: () => void;
}

/** `listed` is true while the Step Functions tree node is open or the view is on screen. */
export function useActivities(shell: Shell, active: boolean, listed: boolean): ActivitiesUi {
  const { connection, connectionId, profile } = shell;
  const region = connection?.serviceRegion ?? "";
  const scope = `${connectionId}|${region}`;
  const [reloadToken, setReloadToken] = useState(0);
  const [data, setData] = useState<{ key: string; list: Activity[] | null; error: AppError | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Activity | null>(null);
  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);

  const key = `${scope}|${reloadToken}`;
  useEffect(() => {
    if (!connection || !(active || listed) || data?.key === key) return;
    let stale = false;
    setLoading(true);
    sfnApi
      .activities()
      .then((list) => !stale && setData({ key, list, error: null }))
      .catch((e) => !stale && setData({ key, list: null, error: e as AppError }))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, active, listed, key]);
  useEffect(() => setSelected(new Set()), [scope]);

  const all = data?.key === key ? data.list : (data?.list ?? null);
  const byName = useMemo(() => new Map((all ?? []).map((a) => [a.name, a])), [all]);
  const paging = usePaging(scope, all?.length ?? 0, "sfn.activities.pageSize", active);
  const page = useMemo(() => paging.slice(all ?? []), [paging, all]);
  const rows: Row[] = useMemo(
    () =>
      page.map((a) => ({
        key: a.name,
        icon: <ActivityIcon />,
        isContainer: false,
        cells: { name: { text: a.name, sort: a.name }, created: { text: formatDate(a.created), sort: a.created ?? "" }, arn: { text: a.arn, sort: a.arn } },
      })),
    [page],
  );
  const target = selected.size === 1 ? (byName.get([...selected][0]) ?? null) : null;
  const ro = shell.readOnly;
  const denied = () => shell.showFlash("Read-only mode: changes are disabled.");

  async function open(a: Activity) {
    try {
      setDetails(await sfnApi.activity(a.arn));
    } catch (e) {
      shell.showError(e);
    }
  }

  async function create() {
    if (ro) return denied();
    const name = await shell.askName("New activity", "Name", "", "Create", (v) => {
      const n = v.trim();
      if (!n || n.length > 80) return "1 to 80 characters";
      if (/[\s<>{}[\]?*"#%\\^|~`$&,;:/]/.test(n) || [...n].some((c) => c < " ")) return "No spaces or < > { } [ ] ? * \" # % \\ ^ | ~ ` $ & , ; : /";
      if (byName.has(n)) return "There's already an activity with this name";
      return null;
    });
    if (!name) return;
    try {
      await sfnApi.createActivity(name.trim());
      shell.showFlash(`Created activity ${name.trim()}.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      refresh();
    }
  }

  async function remove(a: Activity) {
    if (ro) return denied();
    const ok = await shell.ask(
      "Delete activity",
      <>
        <p>
          Delete activity <span className="mono">{a.name}</span>?
        </p>
        <p className="hint">State machines whose Task states use it fail at that state from now on, and workers polling it get errors.</p>
      </>,
      [
        { label: "Delete", value: "yes", danger: true },
        { label: "Cancel", value: "no" },
      ],
      "no",
    );
    if (ok !== "yes") return;
    try {
      await sfnApi.deleteActivity(a.arn);
      shell.showFlash(`Deleted activity ${a.name}.`);
      setSelected(new Set());
    } catch (e) {
      shell.showError(e);
    } finally {
      refresh();
    }
  }

  function menu(k: string | null, x: number, y: number) {
    const a = k ? byName.get(k) : undefined;
    const items: MenuItem[] = [];
    if (a)
      items.push(
        { label: "Details", bold: true, shortcut: "Enter", onClick: () => void open(a) },
        "separator",
        { label: "Delete…", shortcut: "Del", disabled: ro, onClick: () => void remove(a) },
        "separator",
        { label: "Copy name", onClick: () => void shell.copyText(a.name) },
        { label: "Copy ARN", onClick: () => void shell.copyText(a.arn) },
        { label: "Add bookmark…", onClick: () => shell.addBookmark(ACTIVITIES, a.name, null) },
        "separator",
      );
    items.push({ label: "New activity…", disabled: ro, onClick: () => void create() }, { label: "Refresh", shortcut: "F5", onClick: refresh });
    shell.openMenu(x, y, items);
  }

  // Del on the selected row (Enter opens details through the list).
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Delete" || e.ctrlKey || e.metaKey || !target || details) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, .modal-backdrop")) return;
      e.preventDefault();
      void remove(target);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const treeRow = connection ? (
    <TreeRow depth={2} label={all ? `Activities (${all.length.toLocaleString()})` : "Activities"} icon={<ActivityIcon />} selected={active} onClick={() => shell.navigate(ACTIVITIES)} onContextMenu={(x, y) => menu(null, x, y)} />
  ) : null;

  let content: ReactNode = null;
  let status = "";
  if (active) {
    content = (
      <div className="service-pane">
        <p className="hint sfn-activities-note">An activity is a Task your own code (a worker, anywhere) polls for with GetActivityTask and answers with SendTaskSuccess or SendTaskFailure. A Task state uses it with the activity's ARN as its Resource.</p>
        {data?.error ? (
          <ErrorPanel error={data.error} profile={profile} onRetry={refresh} />
        ) : (
          <>
            <FileList storageKey="sfn.activities" columns={COLUMNS} rows={rows} selected={selected} onSelectionChange={setSelected} onOpen={(k) => byName.get(k) && void open(byName.get(k)!)} onContextMenu={menu} emptyText={!all ? "Loading…" : "No activities in this region."} />
            {all && all.length > paging.pageSize && <PageBar {...paging.bar} loading={false} />}
          </>
        )}
      </div>
    );
    if (all) status = `${all.length.toLocaleString()} activit${all.length === 1 ? "y" : "ies"} · ${region}`;
  }

  const commands = active ? (
    <>
      <CommandButton icon={<NewItemIcon />} label="New activity" title="Create an activity" disabled={ro} onClick={() => void create()} />
      <CommandButton icon={<DeleteIcon />} label="Delete" title="Delete the activity (Del)" disabled={ro || !target} onClick={() => target && void remove(target)} />
      <CommandSeparator />
      <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} />
    </>
  ) : null;

  // The CLI reads a profile's endpoint_url itself; only the app's own override has to be passed.
  const endpoint = connection?.endpointSource === "override" ? connection.endpointUrl : null;
  const dialogs = details ? <ActivityDialog a={details} profile={profile} region={region} endpoint={endpoint} shell={shell} onClose={() => setDetails(null)} /> : null;
  return { treeRow, content, commands, status, dialogs, busy: active && loading, refresh };
}

function ActivityDialog({ a, profile, region, endpoint, shell, onClose }: { a: Activity; profile: string | null; region: string; endpoint: string | null; shell: Shell; onClose: () => void }) {
  const opts = `${profile ? ` --profile ${profile}` : ""} --region ${region}${endpoint ? ` --endpoint-url ${endpoint}` : ""}`;
  const commands = [
    `aws stepfunctions get-activity-task --activity-arn ${a.arn} --worker-name my-worker${opts}`,
    `aws stepfunctions send-task-success --task-token <token> --task-output '{"ok": true}'${opts}`,
    `aws stepfunctions send-task-failure --task-token <token> --error MyError --cause "what went wrong"${opts}`,
  ];
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">
          <DialogHelp topic="sfn.activities" />
          Activity {a.name}
        </div>
        <div className="dialog-body">
          <PropsTable
            rows={[
              ["Name", a.name],
              ["ARN", a.arn],
              ["Created", formatDate(a.created)],
              ["Encryption", a.encryption?.kind === "CUSTOMER_MANAGED_KMS_KEY" ? `KMS key ${a.encryption.kmsKeyId ?? ""}` : "AWS owned key"],
              ["Tags", a.tags.length ? a.tags.map(([k, v]) => `${k}=${v}`).join(", ") : "None"],
            ]}
          />
          <div className="props-section">Use it in a Task state</div>
          <pre className="mono selectable sfn-snippet">{JSON.stringify({ Type: "Task", Resource: a.arn, TimeoutSeconds: 300, HeartbeatSeconds: 60, End: true }, null, 2)}</pre>
          <div className="props-section">A worker, from the AWS CLI</div>
          {commands.map((c) => (
            <div key={c} className="row sfn-cmd">
              <code className="mono selectable">{c}</code>
              <button className="link-btn" onClick={() => void shell.copyText(c)}>
                Copy
              </button>
            </div>
          ))}
          <p className="hint">get-activity-task waits up to 60 s for a task and returns its input and a task token; answer with that token before the Task's timeout (and send heartbeats if it sets HeartbeatSeconds).</p>
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn" onClick={() => void shell.copyText(a.arn)}>
            Copy ARN
          </button>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
