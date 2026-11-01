// SQS controller: queue list with a remembered name-prefix filter, queue view.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type AppError } from "../../api/s3";
import { queueNameFromArn, sqsApi, type QueueInfo, type QueueRef } from "../../api/sqs";
import { CommandButton, CommandSeparator } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { FilterBox } from "../../components/FilterBox";
import { PageBar } from "../../components/PageBar";
import { TREE_LIMIT, usePagedDetails, usePaging } from "../../state/paged";
import { DeleteIcon, EditIcon, NewItemIcon, PurgeIcon, QueueIcon, RedriveIcon, RefreshIcon, SendIcon, SqsIcon } from "../../components/Icons";
import { TreeNote, TreeRow } from "../../components/TreeRow";
import { formatDate } from "../../format";
import type { ServiceUi, Shell } from "../../shell/shell";
import { QueueSettingsDialog } from "./QueueSettingsDialog";
import { RedriveDialog, type QueueChoice } from "./RedriveDialog";
import { SendMessageDialog } from "./SendMessageDialog";
import { MessagesPanel } from "./MessagesPanel";
import { QueueView } from "./QueueView";

const COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 260 },
  { id: "type", label: "Type", width: 80 },
  { id: "visible", label: "Available", width: 80, align: "right" },
  { id: "inFlight", label: "In flight", width: 75, align: "right" },
  { id: "delayed", label: "Delayed", width: 70, align: "right" },
  { id: "dlq", label: "Dead-letter", width: 200 },
  { id: "created", label: "Created", width: 165 },
];

/** SQS allows one purge per queue per minute. */
const PURGE_COOLDOWN_MS = 60_000;

const num = (v: number | null | undefined) => ({ text: v === null || v === undefined ? "—" : v.toLocaleString(), sort: v ?? -1 });
const pending = { text: "…", sort: "" };

export function useSqsService(shell: Shell): ServiceUi {
  const { connection, connectionId, profile, place, readOnly } = shell;
  const active = place.service === "sqs";
  const queueName = place.service === "sqs" ? place.queue : null;
  const region = connection?.serviceRegion ?? "";
  const scope = `${connectionId}|${region}`;
  const historyKey = `sqs|${profile ?? ""}|${region}`;
  const go = useCallback((queue: string | null) => shell.navigate({ service: "sqs", queue }), [shell]);

  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<{ key: string; refs: QueueRef[] | null; error: AppError | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** URL of the queue being viewed (resolved from the listing or GetQueueUrl). */
  const [viewUrl, setViewUrl] = useState<{ name: string; url: string | null; error: AppError | null } | null>(null);
  /** Latest details of the viewed queue (from QueueView). */
  const [viewQueue, setViewQueue] = useState<QueueInfo | null>(null);
  /** Settings dialog: queue to edit, or null to create. */
  const [settings, setSettings] = useState<{ queue: QueueInfo | null } | null>(null);
  const [sendTo, setSendTo] = useState<QueueInfo | null>(null);
  const [redrive, setRedrive] = useState<QueueInfo | null>(null);
  /** When each queue (by URL) was last purged here, for the 60 s limit. */
  const [purgedAt, setPurgedAt] = useState<Map<string, number>>(new Map());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const recent = [...purgedAt.values()].some((t) => Date.now() - t < PURGE_COOLDOWN_MS);
    if (!recent) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [purgedAt, now]);

  useEffect(() => {
    setListing(null);
    setFilter("");
    setSelected(new Set());
    setViewUrl(null);
  }, [scope]);

  useEffect(() => {
    if (!profile) return;
    api
      .getSettings()
      .then((s) => setHistory(s.filterHistory?.[historyKey] ?? []))
      .catch(() => setHistory([]));
  }, [historyKey, profile]);

  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  // The queue list (also feeds the tree). Loaded when the branch is open.
  const listKey = `${scope}|${filter}|${reloadToken}`;
  useEffect(() => {
    if (!connection || !(open || active)) return;
    if (listing?.key === listKey) return;
    let stale = false;
    setLoading(true);
    sqsApi
      .listRefs(filter)
      .then((refs) => !stale && setListing({ key: listKey, refs, error: null }))
      .catch((e) => !stale && setListing({ key: listKey, refs: null, error: e as AppError }))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
      // A load cut short (deps changed after it finished) mustn't leave the busy flag on.
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, open, active, listKey]);

  // Names come in full (cheap); attributes and counts only for the visible page.
  const refs = listing?.key === listKey ? listing.refs : null;
  const refByName = useMemo(() => new Map((refs ?? []).map((r) => [r.name, r])), [refs]);
  const paging = usePaging(`${scope}|${filter}`, refs?.length ?? 0, "sqs.pageSize", active && !queueName);
  const pageRefs = useMemo(() => paging.slice(refs ?? []), [paging, refs]);
  const pageNames = useMemo(() => pageRefs.map((r) => r.name), [pageRefs]);
  const loadDetails = useCallback(
    (names: string[]) => sqsApi.detailsMany(names.map((n) => refByName.get(n)?.url ?? n)),
    [refByName],
  );
  const paged = usePagedDetails<QueueInfo>(listKey, pageNames, loadDetails, (q) => q.name, active && !queueName && !!refs);
  const byName = paged.details;
  /** Choices for the settings / redrive dialogs (every listed queue). */
  const choices: QueueChoice[] = useMemo(() => (refs ?? []).map((r) => ({ ...r, fifo: r.name.endsWith(".fifo") })), [refs]);
  /** Fresh details for a queue that may not be on the visible page. */
  async function info(name: string): Promise<QueueInfo | null> {
    if (viewQueue?.name === name) return viewQueue;
    const known = byName.get(name);
    if (known) return known;
    const url = refByName.get(name)?.url ?? (viewUrl?.name === name ? viewUrl.url : null);
    if (!url) return null;
    try {
      return await sqsApi.queueDetails(url);
    } catch (e) {
      shell.showError(e);
      return null;
    }
  }
  const urlOf = (name: string) => (viewQueue?.name === name ? viewQueue.url : (refByName.get(name)?.url ?? byName.get(name)?.url));

  // Resolve the viewed queue's URL.
  useEffect(() => {
    if (!active || !queueName || !connection) return;
    const known = refByName.get(queueName);
    if (known) {
      setViewUrl({ name: queueName, url: known.url, error: null });
      return;
    }
    if (viewUrl?.name === queueName && (viewUrl.url || viewUrl.error)) return;
    let live = true;
    setViewUrl({ name: queueName, url: null, error: null });
    sqsApi
      .queueUrl(queueName)
      .then((url) => live && setViewUrl({ name: queueName, url, error: null }))
      .catch((e) => live && setViewUrl({ name: queueName, url: null, error: e as AppError }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, queueName, refByName, scope]);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);

  // ---------------------------------------------------------------------------
  // Create / edit / delete

  const denied = () => shell.showFlash("Read-only mode: changes are disabled.");

  function newQueue() {
    if (readOnly) return denied();
    setSettings({ queue: null });
  }

  async function editQueue(name: string) {
    if (readOnly) return denied();
    const url = urlOf(name);
    if (!url) return;
    try {
      // Fresh attributes, so the form starts from what's there now.
      setSettings({ queue: await sqsApi.queueDetails(url) });
    } catch (e) {
      shell.showError(e);
    }
  }

  async function deleteQueue(name: string) {
    if (readOnly) return denied();
    const q = await info(name);
    if (!q) return;
    const total = (q.visible ?? 0) + (q.inFlight ?? 0) + (q.delayed ?? 0);
    const ok = await shell.confirmTyped(
      "Delete queue",
      <>
        <p>
          <span className="mono">{q.name}</span> and its {total.toLocaleString()} message{total === 1 ? "" : "s"} will be deleted. This can't be
          undone, and a queue with the same name can't be created for 60 seconds.
        </p>
        {q.isDlq && <p className="danger-text">Other queues use it as their dead-letter queue; their failed messages will have nowhere to go.</p>}
      </>,
      q.name,
      "Delete queue",
    );
    if (!ok) return;
    shell.setWorking(`Deleting ${q.name}…`);
    try {
      await sqsApi.deleteQueue(q.url);
      shell.showFlash(`Deleted ${q.name}. It can take up to 60 seconds to disappear everywhere.`);
      if (queueName === q.name) go(null);
      setSelected(new Set());
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
      refresh();
    }
  }

  /** Seconds until this queue can be purged again (0 = now). */
  function purgeWait(url: string): number {
    const t = purgedAt.get(url);
    return t ? Math.max(0, Math.ceil((t + PURGE_COOLDOWN_MS - now) / 1000)) : 0;
  }

  async function purgeQueue(name: string) {
    if (readOnly) return denied();
    const q = await info(name);
    if (!q) return;
    const wait = purgeWait(q.url);
    if (wait) return shell.showFlash(`SQS allows one purge a minute; try again in ${wait} s.`);
    const total = (q.visible ?? 0) + (q.inFlight ?? 0) + (q.delayed ?? 0);
    const ok = await shell.ask(
      "Purge queue",
      <>
        <p>
          Delete all {total.toLocaleString()} message{total === 1 ? "" : "s"} in <span className="mono">{q.name}</span>? This can't be undone.
        </p>
        <p className="hint">Messages sent in the next few seconds may be deleted too. SQS allows one purge per minute.</p>
      </>,
      [
        { label: "Purge", value: "purge", danger: true },
        { label: "Cancel", value: "cancel" },
      ],
      "cancel",
    );
    if (ok !== "purge") return;
    try {
      await sqsApi.purge(q.url);
      setPurgedAt((m) => new Map(m).set(q.url, Date.now()));
      setNow(Date.now());
      shell.showFlash(`Purging ${q.name}; it can take up to a minute to finish.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      refresh();
    }
  }

  async function openSend(name: string) {
    if (readOnly) return denied();
    const url = urlOf(name);
    if (!url) return;
    try {
      setSendTo(await sqsApi.queueDetails(url));
    } catch (e) {
      shell.showError(e);
    }
  }

  async function openRedrive(name: string) {
    const url = urlOf(name);
    if (!url) return;
    try {
      setRedrive(await sqsApi.queueDetails(url));
    } catch (e) {
      shell.showError(e);
    }
  }

  const modal = settings || sendTo || redrive;
  const opsRef = useRef({ newQueue, deleteQueue, editQueue, selected, active, queueName, modal });
  opsRef.current = { newQueue, deleteQueue, editQueue, selected, active, queueName, modal };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const o = opsRef.current;
      if (!o.active || o.modal) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, .modal-backdrop")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const target = o.queueName ?? (o.selected.size === 1 ? [...o.selected][0] : null);
      if (e.key === "Delete" && target) {
        e.preventDefault();
        void o.deleteQueue(target);
      } else if (ctrl && e.shiftKey && (e.key === "N" || e.key === "n")) {
        e.preventDefault();
        o.newQueue();
      } else if (ctrl && !e.shiftKey && e.key === "e" && target) {
        e.preventDefault();
        void o.editQueue(target);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function applyFilter(v: string) {
    setFilter(v);
    try {
      setHistory(await api.rememberFilter(historyKey, v));
    } catch {
      /* convenience only */
    }
  }
  async function forget(v: string | null) {
    try {
      setHistory(await api.forgetFilter(historyKey, v));
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // List

  const rows: Row[] = useMemo(
    () =>
      pageRefs.map((r): Row => {
        const q = byName.get(r.name);
        if (!q) {
          const fifo = r.name.endsWith(".fifo");
          return {
            key: r.name,
            icon: <QueueIcon fifo={fifo} dlq={false} />,
            isContainer: false,
            cells: { name: { text: r.name, sort: r.name }, type: { text: fifo ? "FIFO" : "Standard", sort: fifo ? 1 : 0 }, visible: pending, inFlight: pending, delayed: pending, dlq: pending, created: pending },
          };
        }
        const dlqName = queueNameFromArn(q.dlqArn);
        const role = q.isDlq ? "Is a dead-letter queue" : dlqName ? `→ ${dlqName}` : q.error ? `(${q.error})` : "";
        return {
          key: q.name,
          icon: <QueueIcon fifo={q.fifo} dlq={q.isDlq} />,
          isContainer: false,
          cells: {
            name: { text: q.name, sort: q.name },
            type: { text: q.fifo ? "FIFO" : "Standard", sort: q.fifo ? 1 : 0 },
            visible: num(q.visible),
            inFlight: num(q.inFlight),
            delayed: num(q.delayed),
            dlq: { text: role, sort: role },
            created: { text: formatDate(q.created), sort: q.created ?? "" },
          },
        };
      }),
    [pageRefs, byName],
  );

  function openContextMenu(key: string | null, x: number, y: number) {
    const items: MenuItem[] = [];
    const r = key ? refByName.get(key) : undefined;
    const q = key ? (byName.get(key) ?? (r ? ({ name: r.name, url: r.url, arn: r.arn, isDlq: false, dlqArn: null } as unknown as QueueInfo) : undefined)) : undefined;
    if (q) {
      items.push(
        { label: "Open", bold: true, shortcut: "Enter", onClick: () => go(q.name) },
        "separator",
        { label: "Copy URL", onClick: () => void shell.copyText(q.url) },
        ...(q.arn ? [{ label: "Copy ARN", onClick: () => void shell.copyText(q.arn!) } as MenuItem] : []),
        { label: "Copy name", onClick: () => void shell.copyText(q.name) },
      );
      const dlqName = queueNameFromArn(q.dlqArn);
      if (dlqName) items.push({ label: `Open dead-letter queue (${dlqName})`, onClick: () => go(dlqName) });
      items.push(
        "separator",
        { label: "Send message…", disabled: readOnly, onClick: () => void openSend(q.name) },
        { label: q.isDlq ? "Redrive messages…" : "Move messages to another queue…", onClick: () => void openRedrive(q.name) },
        "separator",
        { label: "Edit settings…", shortcut: "Ctrl+E", disabled: readOnly, onClick: () => void editQueue(q.name) },
        {
          label: purgeWait(q.url) ? `Purge (wait ${purgeWait(q.url)} s)` : "Purge messages…",
          disabled: readOnly || purgeWait(q.url) > 0,
          onClick: () => void purgeQueue(q.name),
        },
        { label: "Delete queue…", shortcut: "Del", disabled: readOnly, onClick: () => void deleteQueue(q.name) },
        "separator",
      );
    } else {
      items.push({ label: "New queue…", shortcut: "Ctrl+Shift+N", disabled: readOnly, onClick: newQueue }, "separator");
    }
    items.push({ label: "Refresh", shortcut: "F5", onClick: refresh });
    shell.openMenu(x, y, items);
  }

  // ---------------------------------------------------------------------------
  // Tree

  const tree = connection ? (
    <TreeRow
      depth={1}
      label={filter ? "SQS (filtered)" : "SQS"}
      icon={<SqsIcon />}
      selected={active && !queueName}
      expanded={open}
      title={`SQS · ${region}`}
      onClick={() => go(null)}
      onToggle={() => setOpen((v) => !v)}
    >
      {listing?.error ? (
        <TreeNote depth={2}>Couldn't list queues</TreeNote>
      ) : !refs ? (
        <TreeNote depth={2}>Loading…</TreeNote>
      ) : refs.length === 0 ? (
        <TreeNote depth={2}>{filter ? "No matching queues" : "No queues"}</TreeNote>
      ) : (
        <>
          {refs.slice(0, TREE_LIMIT).map((r) => {
            const q = byName.get(r.name);
            return (
              <TreeRow
                key={r.name}
                depth={2}
                label={r.name}
                icon={<QueueIcon fifo={r.name.endsWith(".fifo")} dlq={!!q?.isDlq} />}
                selected={active && queueName === r.name}
                title={q?.isDlq ? `${r.name} (dead-letter queue)` : r.name}
                onClick={() => go(r.name)}
                onContextMenu={(x, y) => openContextMenu(r.name, x, y)}
              />
            );
          })}
          {refs.length > TREE_LIMIT && <TreeNote depth={2}>{`${(refs.length - TREE_LIMIT).toLocaleString()} more in the list`}</TreeNote>}
        </>
      )}
    </TreeRow>
  ) : null;

  // ---------------------------------------------------------------------------
  // Content

  let content: ReactNode = null;
  let status = "";
  if (active && !queueName) {
    content = (
      <div className="service-pane">
        <FilterBox
          label="Filter:"
          applied={filter}
          history={history}
          placeholder="Queue name prefix, e.g. orders- (Enter to apply)"
          onApply={(v) => void applyFilter(v)}
          onClear={() => setFilter("")}
          onForget={(v) => void forget(v)}
          onClearHistory={() => void forget(null)}
        />
        {listing?.error ? (
          <ErrorPanel error={listing.error} profile={profile} onRetry={refresh} />
        ) : (
          <>
            {paged.error && <div className="warn-note list-note">Couldn't load queue details: {paged.error.message}</div>}
            <FileList
              columns={COLUMNS}
              rows={rows}
              selected={selected}
              onSelectionChange={setSelected}
              onOpen={(k) => go(k)}
              onContextMenu={openContextMenu}
              emptyText={!refs ? "Loading…" : filter ? `No queues begin with "${filter}".` : "No queues in this region."}
            />
            {refs && refs.length > paging.pageSize && <PageBar {...paging.bar} loading={paged.loading} />}
          </>
        )}
      </div>
    );
    if (refs) {
      status = `${refs.length.toLocaleString()} queue${refs.length === 1 ? "" : "s"}${filter ? ` beginning with "${filter}"` : ""}`;
      if (selected.size) status += ` · ${selected.size} selected`;
      status += ` · ${region}`;
    }
  } else if (active && queueName) {
    content =
      viewUrl?.error ? (
        <ErrorPanel error={viewUrl.error} profile={profile} onRetry={() => setViewUrl(null)} />
      ) : !viewUrl?.url ? (
        <div className="empty-note">Loading…</div>
      ) : (
        <div className="service-pane scroll-pane">
          <QueueView key={viewUrl.url} url={viewUrl.url} shell={shell} reloadToken={reloadToken} onLoaded={setViewQueue}>
            {viewQueue && viewQueue.url === viewUrl.url && <MessagesPanel key={viewQueue.url} queue={viewQueue} shell={shell} onChanged={refresh} />}
          </QueueView>
        </div>
      );
    status = `${queueName} · ${region}`;
  }

  const target = queueName ?? (selected.size === 1 ? [...selected][0] : null);
  const commands = active ? (
    <>
      <CommandButton icon={<NewItemIcon />} label="New queue" title="Create a queue (Ctrl+Shift+N)" disabled={readOnly || !connection} onClick={newQueue} />
      <CommandButton icon={<SendIcon />} label="Send" title="Send messages" disabled={readOnly || !target} onClick={() => target && void openSend(target)} />
      <CommandButton
        icon={<RedriveIcon />}
        label={(target && (viewQueue?.name === target ? viewQueue : byName.get(target))?.isDlq) ? "Redrive" : "Move"}
        title="Move messages back to their source queues, or to another queue"
        disabled={!target}
        onClick={() => target && void openRedrive(target)}
      />
      <CommandSeparator />
      <CommandButton icon={<EditIcon />} label="Edit" title="Edit queue settings (Ctrl+E)" disabled={readOnly || !target} onClick={() => target && void editQueue(target)} />
      {(() => {
        const url = target ? urlOf(target) : undefined;
        const wait = url ? purgeWait(url) : 0;
        return (
          <CommandButton
            icon={<PurgeIcon />}
            label={wait ? `Purge (${wait} s)` : "Purge"}
            title="Delete every message in the queue (once a minute)"
            disabled={readOnly || !target || wait > 0}
            onClick={() => target && void purgeQueue(target)}
          />
        );
      })()}
      <CommandButton icon={<DeleteIcon />} label="Delete" title="Delete queue (Del)" disabled={readOnly || !target} onClick={() => target && void deleteQueue(target)} />
      <CommandSeparator />
      <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} />
    </>
  ) : null;

  const redriveDialog = redrive ? (
    <RedriveDialog queue={redrive} queues={choices} shell={shell} onClose={() => setRedrive(null)} onChanged={refresh} />
  ) : null;

  const sendDialog = sendTo ? <SendMessageDialog queue={sendTo} shell={shell} onClose={() => setSendTo(null)} onSent={refresh} /> : null;

  const settingsDialog = settings ? (
    <QueueSettingsDialog
      queue={settings.queue}
      queues={choices}
      onClose={() => setSettings(null)}
      onSaved={(name) => {
        const created = !settings.queue;
        setSettings(null);
        shell.showFlash(created ? `Created ${name}.` : `Saved ${name}.`);
        refresh();
        if (created) go(name);
      }}
    />
  ) : null;

  return {
    tree,
    content,
    commands,
    status,
    busy: active && (loading || paged.loading),
    refresh,
    dialogs: (
      <>
        {settingsDialog}
        {sendDialog}
        {redriveDialog}
      </>
    ),
  };
}
