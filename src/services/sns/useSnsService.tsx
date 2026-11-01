// SNS controller: topic list (with a remembered name filter), account-wide
// subscriptions, topic view.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type AppError } from "../../api/s3";
import { snsApi, snsWriteApi, topicNameFromArn, type SubscriptionInfo, type TopicInfo } from "../../api/sns";
import { CommandButton, CommandSeparator } from "../../components/CommandButton";
import type { MenuItem } from "../../components/ContextMenu";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { FilterBox } from "../../components/FilterBox";
import { PageBar } from "../../components/PageBar";
import { TREE_LIMIT, usePagedDetails, usePaging } from "../../state/paged";
import { DeleteIcon, EditIcon, NewItemIcon, RefreshIcon, SendIcon, SnsIcon, TopicIcon } from "../../components/Icons";
import { TreeNote, TreeRow } from "../../components/TreeRow";
import type { ServiceUi, Shell } from "../../shell/shell";
import { PublishDialog } from "./PublishDialog";
import { SubscriptionDialog } from "./SubscriptionDialog";
import { TopicSettingsDialog } from "./TopicSettingsDialog";
import { TopicView } from "./TopicView";
import { WatchPanel } from "./WatchPanel";

const TOPIC_COLUMNS: Column[] = [
  { id: "name", label: "Name", width: 260 },
  { id: "type", label: "Type", width: 80 },
  { id: "display", label: "Display name", width: 160 },
  { id: "confirmed", label: "Subscriptions", width: 100, align: "right" },
  { id: "pending", label: "Pending", width: 70, align: "right" },
  { id: "encryption", label: "Encryption", width: 160 },
];

const SUB_COLUMNS: Column[] = [
  { id: "topic", label: "Topic", width: 220 },
  { id: "protocol", label: "Protocol", width: 90 },
  { id: "endpoint", label: "Endpoint", width: 360 },
  { id: "status", label: "Status", width: 150 },
];

export function useSnsService(shell: Shell): ServiceUi {
  const { connection, connectionId, profile, place, readOnly } = shell;
  const active = place.service === "sns";
  const topicName = place.service === "sns" ? place.topic : null;
  const region = connection?.serviceRegion ?? "";
  const scope = `${connectionId}|${region}`;
  const historyKey = `sns|${profile ?? ""}|${region}`;
  const go = useCallback((topic: string | null) => shell.navigate({ service: "sns", topic }), [shell]);

  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<{ key: string; arns: string[] | null; error: AppError | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rootView, setRootView] = useState<"topics" | "subscriptions">("topics");
  const [allSubs, setAllSubs] = useState<{ key: string; subs: SubscriptionInfo[] | null; error: AppError | null } | null>(null);
  const [viewTopic, setViewTopic] = useState<TopicInfo | null>(null);
  /** Settings dialog: topic to edit, or null to create. */
  const [settings, setSettings] = useState<{ topic: TopicInfo | null } | null>(null);
  const [publishTo, setPublishTo] = useState<TopicInfo | null>(null);
  const [subDialog, setSubDialog] = useState<{ mode: "create"; topicArn: string | null } | { mode: "edit"; sub: SubscriptionInfo } | null>(null);

  useEffect(() => {
    setListing(null);
    setAllSubs(null);
    setFilter("");
    setSelected(new Set());
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

  const listKey = `${scope}|${reloadToken}`;
  useEffect(() => {
    if (!connection || !(open || active) || listing?.key === listKey) return;
    let stale = false;
    setLoading(true);
    snsApi
      .listTopicArns()
      .then((arns) => !stale && setListing({ key: listKey, arns, error: null }))
      .catch((e) => !stale && setListing({ key: listKey, arns: null, error: e as AppError }))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
      // A load cut short (deps changed after it finished) mustn't leave the busy flag on.
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, open, active, listKey]);

  // Account-wide subscriptions, loaded when that view is shown.
  useEffect(() => {
    if (!connection || !active || topicName || rootView !== "subscriptions" || allSubs?.key === listKey) return;
    let stale = false;
    snsApi
      .listSubscriptions(null)
      .then((subs) => !stale && setAllSubs({ key: listKey, subs, error: null }))
      .catch((e) => !stale && setAllSubs({ key: listKey, subs: null, error: e as AppError }));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, active, topicName, rootView, listKey]);

  // Every topic name loads (100 per call); attributes only for the visible page.
  const all = useMemo(() => (listing?.arns ? listing.arns.map((arn) => ({ name: topicNameFromArn(arn), arn })) : null), [listing]);
  const topics = useMemo(() => (all && filter ? all.filter((t) => t.name.startsWith(filter)) : all), [all, filter]);
  const byName = useMemo(() => new Map((all ?? []).map((t) => [t.name, t])), [all]);
  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);
  const subFor = (key: string) => allSubs?.subs?.[Number(key.split("|")[0])];
  const viewArn = topicName ? (byName.get(topicName)?.arn ?? null) : null;
  const topicsView = active && !topicName && rootView === "topics";
  const paging = usePaging(`${scope}|${filter}`, topics?.length ?? 0, "sns.pageSize", topicsView);
  const pageTopics = useMemo(() => paging.slice(topics ?? []), [paging, topics]);
  const pageNames = useMemo(() => pageTopics.map((t) => t.name), [pageTopics]);
  const loadDetails = useCallback((names: string[]) => snsApi.detailsMany(names.map((n) => byName.get(n)?.arn ?? n)), [byName]);
  const paged = usePagedDetails<TopicInfo>(listKey, pageNames, loadDetails, (t) => t.name, topicsView && !!all);
  /** Topic attributes, fetched when the topic isn't on the visible page. */
  async function detailsFor(name: string): Promise<TopicInfo | null> {
    if (viewTopic?.name === name) return viewTopic;
    const known = paged.details.get(name);
    if (known) return known;
    const arn = byName.get(name)?.arn;
    if (!arn) return null;
    try {
      return await snsApi.topicDetails(arn);
    } catch (e) {
      shell.showError(e);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Create / edit / delete

  const denied = () => shell.showFlash("Read-only mode: changes are disabled.");
  const topicFor = (name: string) => (viewTopic?.name === name ? viewTopic : byName.get(name));

  function newTopic() {
    if (readOnly) return denied();
    setSettings({ topic: null });
  }

  async function editTopic(name: string) {
    if (readOnly) return denied();
    const t = topicFor(name);
    if (!t) return;
    try {
      // Fresh attributes, so the form starts from what's there now.
      setSettings({ topic: await snsApi.topicDetails(t.arn) });
    } catch (e) {
      shell.showError(e);
    }
  }

  async function deleteTopic(name: string) {
    if (readOnly) return denied();
    const t = await detailsFor(name);
    if (!t) return;
    const subs = (t.confirmed ?? 0) + (t.pending ?? 0);
    const ok = await shell.confirmTyped(
      "Delete topic",
      <p>
        <span className="mono">{t.name}</span>
        {subs ? ` and its ${subs.toLocaleString()} subscription${subs === 1 ? "" : "s"}` : ""} will be deleted. Publishers using it will start
        failing. This can't be undone.
      </p>,
      t.name,
      "Delete topic",
    );
    if (!ok) return;
    shell.setWorking(`Deleting ${t.name}…`);
    try {
      await snsWriteApi.deleteTopic(t.arn);
      shell.showFlash(`Deleted ${t.name}.`);
      if (topicName === t.name) go(null);
      setSelected(new Set());
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
      refresh();
    }
  }

  // ---------------------------------------------------------------------------
  // Subscriptions

  function newSubscription(topicArn: string | null) {
    if (readOnly) return denied();
    setSubDialog({ mode: "create", topicArn });
  }

  function editSubscription(sub: SubscriptionInfo) {
    if (readOnly) return denied();
    if (sub.pending) return shell.showFlash("Pending subscriptions can't be edited until they're confirmed.");
    setSubDialog({ mode: "edit", sub });
  }

  async function unsubscribe(sub: SubscriptionInfo) {
    if (readOnly) return denied();
    if (sub.pending) return shell.showFlash("Pending subscriptions can't be removed; SNS deletes them after 3 days if not confirmed.");
    const ok = await shell.ask(
      "Unsubscribe",
      <>
        Stop delivering <span className="mono">{topicNameFromArn(sub.topicArn)}</span> messages to {sub.protocol}{" "}
        <span className="mono">{sub.endpoint}</span>?
      </>,
      [
        { label: "Unsubscribe", value: "yes", danger: true },
        { label: "Cancel", value: "cancel" },
      ],
      "cancel",
    );
    if (ok !== "yes") return;
    try {
      await snsWriteApi.unsubscribe(sub.arn);
      shell.showFlash(`Unsubscribed ${sub.endpoint}.`);
      setSelected(new Set());
    } catch (e) {
      shell.showError(e);
    } finally {
      refresh();
    }
  }

  async function confirmWithToken(topicArn: string) {
    if (readOnly) return denied();
    const token = await shell.askName(
      `Confirm a subscription to ${topicNameFromArn(topicArn)}`,
      "Token (from the SubscribeURL or Token field of the confirmation message)",
      "",
      "Confirm",
      (v) => (v.trim() ? null : "Paste the token"),
    );
    if (!token) return;
    try {
      // Pull the token out of a pasted SubscribeURL too.
      const m = /[?&]Token=([^&]+)/.exec(token);
      await snsWriteApi.confirmSubscription(topicArn, m ? decodeURIComponent(m[1]) : token.trim(), false);
      shell.showFlash("Subscription confirmed.");
    } catch (e) {
      shell.showError(e);
    } finally {
      refresh();
    }
  }

  const subActions = (s: SubscriptionInfo) => (
    <>
      {s.pending ? (
        <button className="link-btn" disabled={readOnly} onClick={() => void confirmWithToken(s.topicArn)}>
          Confirm…
        </button>
      ) : (
        <>
          <button className="link-btn" disabled={readOnly} onClick={() => editSubscription(s)}>
            Edit…
          </button>{" "}
          <button className="link-btn" disabled={readOnly} onClick={() => void unsubscribe(s)}>
            Unsubscribe…
          </button>{" "}
          <button className="link-btn" onClick={() => void shell.copyText(s.arn)}>
            Copy ARN
          </button>
        </>
      )}
    </>
  );

  async function openPublish(name: string) {
    if (readOnly) return denied();
    const t = topicFor(name);
    if (!t) return;
    try {
      setPublishTo(await snsApi.topicDetails(t.arn));
    } catch (e) {
      shell.showError(e);
    }
  }

  const modal = settings || subDialog || publishTo;
  const opsRef = useRef({ newTopic, deleteTopic, editTopic, selected, active, topicName, modal, rootView, subFor, unsubscribe });
  opsRef.current = { newTopic, deleteTopic, editTopic, selected, active, topicName, modal, rootView, subFor, unsubscribe };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const o = opsRef.current;
      if (!o.active || o.modal) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, .modal-backdrop")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const target = o.topicName ?? (o.rootView === "topics" && o.selected.size === 1 ? [...o.selected][0] : null);
      const sub = !o.topicName && o.rootView === "subscriptions" && o.selected.size === 1 ? o.subFor([...o.selected][0]) : undefined;
      if (e.key === "Delete" && sub) {
        e.preventDefault();
        void o.unsubscribe(sub);
      } else if (e.key === "Delete" && target) {
        e.preventDefault();
        void o.deleteTopic(target);
      } else if (ctrl && e.shiftKey && (e.key === "N" || e.key === "n")) {
        e.preventDefault();
        o.newTopic();
      } else if (ctrl && !e.shiftKey && e.key === "e" && target) {
        e.preventDefault();
        void o.editTopic(target);
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

  const topicRows: Row[] = useMemo(
    () =>
      pageTopics.map((ref): Row => {
        const t = paged.details.get(ref.name);
        if (!t) {
          const fifo = ref.name.endsWith(".fifo");
          const wait = { text: "…", sort: "" };
          return {
            key: ref.name,
            icon: <TopicIcon fifo={fifo} />,
            isContainer: false,
            cells: { name: { text: ref.name, sort: ref.name }, type: { text: fifo ? "FIFO" : "Standard", sort: fifo ? 1 : 0 }, display: wait, confirmed: wait, pending: wait, encryption: wait },
          };
        }
        return {
        key: t.name,
        icon: <TopicIcon fifo={t.fifo} />,
        isContainer: false,
        cells: {
          name: { text: t.name, sort: t.name },
          type: { text: t.fifo ? "FIFO" : "Standard", sort: t.fifo ? 1 : 0 },
          display: { text: t.displayName ?? "", sort: t.displayName ?? "" },
          confirmed: { text: t.confirmed?.toLocaleString() ?? "", sort: t.confirmed ?? -1 },
          pending: { text: t.pending ? t.pending.toLocaleString() : "", sort: t.pending ?? -1 },
          encryption: { text: t.kmsKey ? `KMS (${t.kmsKey})` : t.error ? `(${t.error})` : "None", sort: t.kmsKey ?? "" },
        },
        };
      }),
    [pageTopics, paged.details],
  );

  const subRows: Row[] = useMemo(
    () =>
      (allSubs?.subs ?? [])
        .map((s, i) => [s, i] as const)
        .filter(([s]) => !filter || topicNameFromArn(s.topicArn).startsWith(filter))
        .map(([s, i]) => ({
          key: `${i}|${s.arn}`,
          icon: <TopicIcon />,
          isContainer: false,
          cells: {
            topic: { text: topicNameFromArn(s.topicArn), sort: topicNameFromArn(s.topicArn) },
            protocol: { text: s.protocol, sort: s.protocol },
            endpoint: { text: s.endpoint, sort: s.endpoint },
            status: { text: s.pending ? "Pending confirmation" : "Confirmed", sort: s.pending ? 1 : 0 },
          },
        })),
    [allSubs, filter],
  );
  const subPaging = usePaging(`${scope}|subs|${filter}`, subRows.length, "sns.subs.pageSize", active && !topicName && rootView === "subscriptions");
  const pageSubRows = useMemo(() => subPaging.slice(subRows), [subPaging, subRows]);

  function openSubMenu(key: string | null, x: number, y: number) {
    const items: MenuItem[] = [];
    const s = key ? subFor(key) : undefined;
    if (s) {
      items.push({ label: "Open topic", bold: true, shortcut: "Enter", onClick: () => go(topicNameFromArn(s.topicArn)) }, "separator");
      if (s.pending) items.push({ label: "Confirm with token…", disabled: readOnly, onClick: () => void confirmWithToken(s.topicArn) });
      else
        items.push(
          { label: "Edit…", disabled: readOnly, onClick: () => editSubscription(s) },
          { label: "Unsubscribe…", shortcut: "Del", disabled: readOnly, onClick: () => void unsubscribe(s) },
          { label: "Copy ARN", onClick: () => void shell.copyText(s.arn) },
        );
      items.push({ label: "Copy endpoint", onClick: () => void shell.copyText(s.endpoint) }, "separator");
    } else {
      items.push({ label: "New subscription…", disabled: readOnly, onClick: () => newSubscription(null) }, "separator");
    }
    items.push({ label: "Refresh", shortcut: "F5", onClick: refresh });
    shell.openMenu(x, y, items);
  }

  function openContextMenu(key: string | null, x: number, y: number) {
    const items: MenuItem[] = [];
    const t = key ? byName.get(key) : undefined;
    if (t) {
      items.push(
        { label: "Open", bold: true, shortcut: "Enter", onClick: () => go(t.name) },
        "separator",
        { label: "Publish…", disabled: readOnly, onClick: () => void openPublish(t.name) },
        { label: "Subscribe…", disabled: readOnly, onClick: () => newSubscription(t.arn) },
        { label: "Edit…", shortcut: "Ctrl+E", disabled: readOnly, onClick: () => void editTopic(t.name) },
        { label: "Delete…", shortcut: "Del", disabled: readOnly, onClick: () => void deleteTopic(t.name) },
        "separator",
        { label: "Copy ARN", onClick: () => void shell.copyText(t.arn) },
        { label: "Copy name", onClick: () => void shell.copyText(t.name) },
        "separator",
      );
    } else {
      items.push({ label: "New topic…", shortcut: "Ctrl+Shift+N", disabled: readOnly, onClick: newTopic }, "separator");
    }
    items.push({ label: "Refresh", shortcut: "F5", onClick: refresh });
    shell.openMenu(x, y, items);
  }

  // ---------------------------------------------------------------------------
  // Tree

  const tree = connection ? (
    <TreeRow
      depth={1}
      label={filter ? "SNS (filtered)" : "SNS"}
      icon={<SnsIcon />}
      selected={active && !topicName}
      expanded={open}
      title={`SNS · ${region}`}
      onClick={() => go(null)}
      onToggle={() => setOpen((v) => !v)}
    >
      {listing?.error ? (
        <TreeNote depth={2}>Couldn't list topics</TreeNote>
      ) : !topics ? (
        <TreeNote depth={2}>Loading…</TreeNote>
      ) : topics.length === 0 ? (
        <TreeNote depth={2}>{filter ? "No matching topics" : "No topics"}</TreeNote>
      ) : (
        <>
          {topics.slice(0, TREE_LIMIT).map((t) => (
            <TreeRow
              key={t.name}
              depth={2}
              label={t.name}
              icon={<TopicIcon fifo={t.name.endsWith(".fifo")} />}
              selected={active && topicName === t.name}
              onClick={() => go(t.name)}
              onContextMenu={(x, y) => openContextMenu(t.name, x, y)}
            />
          ))}
          {topics.length > TREE_LIMIT && <TreeNote depth={2}>{`${(topics.length - TREE_LIMIT).toLocaleString()} more in the list`}</TreeNote>}
        </>
      )}
    </TreeRow>
  ) : null;

  // ---------------------------------------------------------------------------
  // Content

  let content: ReactNode = null;
  let status = "";
  if (active && !topicName) {
    const subsView = rootView === "subscriptions";
    content = (
      <div className="service-pane">
        <div className="filter-bar sns-bar">
          <div className="segmented small">
            <button className={!subsView ? "active" : ""} onClick={() => setRootView("topics")}>
              Topics
            </button>
            <button className={subsView ? "active" : ""} onClick={() => setRootView("subscriptions")}>
              All subscriptions
            </button>
          </div>
        </div>
        <FilterBox
          label="Filter:"
          applied={filter}
          history={history}
          placeholder="Topic name prefix (Enter to apply)"
          onApply={(v) => void applyFilter(v)}
          onClear={() => setFilter("")}
          onForget={(v) => void forget(v)}
          onClearHistory={() => void forget(null)}
        />
        {listing?.error ? (
          <ErrorPanel error={listing.error} profile={profile} onRetry={refresh} />
        ) : subsView ? (
          allSubs?.error ? (
            <ErrorPanel error={allSubs.error} profile={profile} onRetry={refresh} />
          ) : (
            <>
            <FileList
              key="subs"
              columns={SUB_COLUMNS}
              rows={pageSubRows}
              selected={selected}
              onSelectionChange={setSelected}
              onOpen={(k) => {
                const s = subFor(k);
                if (s) go(topicNameFromArn(s.topicArn));
              }}
              onContextMenu={openSubMenu}
              emptyText={!allSubs?.subs ? "Loading…" : "No subscriptions."}
            />
            {subRows.length > subPaging.pageSize && <PageBar {...subPaging.bar} loading={false} />}
            </>
          )
        ) : (
          <>
            {paged.error && <div className="warn-note list-note">Couldn't load topic details: {paged.error.message}</div>}
            <FileList
              key="topics"
              columns={TOPIC_COLUMNS}
              rows={topicRows}
              selected={selected}
              onSelectionChange={setSelected}
              onOpen={(k) => go(k)}
              onContextMenu={openContextMenu}
              emptyText={!topics ? "Loading…" : filter ? `No topics begin with "${filter}".` : "No topics in this region."}
            />
            {topics && topics.length > paging.pageSize && <PageBar {...paging.bar} loading={paged.loading} />}
          </>
        )}
      </div>
    );
    if (subsView && allSubs?.subs) status = `${subRows.length.toLocaleString()} subscription${subRows.length === 1 ? "" : "s"} · ${region}`;
    else if (topics) status = `${topics.length.toLocaleString()} topic${topics.length === 1 ? "" : "s"}${filter ? ` beginning with "${filter}"` : ""} · ${region}`;
  } else if (active && topicName) {
    content = !all ? (
      <div className="empty-note">Loading…</div>
    ) : !viewArn ? (
      <div className="empty-note">Topic {topicName} wasn't found in {region}.</div>
    ) : (
      <div className="service-pane scroll-pane">
        <TopicView
          key={viewArn}
          arn={viewArn}
          shell={shell}
          reloadToken={reloadToken}
          onLoaded={setViewTopic}
          subscriptionActions={subActions}
          subscriptionToolbar={
            <div className="row">
              <button className="btn" disabled={readOnly} onClick={() => newSubscription(viewArn)}>
                Subscribe…
              </button>
              <button className="btn" disabled={readOnly} onClick={() => void confirmWithToken(viewArn)}>
                Confirm with token…
              </button>
            </div>
          }
        >
          {viewTopic?.arn === viewArn && <WatchPanel topic={viewTopic} shell={shell} />}
        </TopicView>
      </div>
    );
    status = `${topicName} · ${region}`;
  }

  const target = topicName ?? (rootView === "topics" && selected.size === 1 ? [...selected][0] : null);
  const subsView = active && !topicName && rootView === "subscriptions";
  const selSub = subsView && selected.size === 1 ? subFor([...selected][0]) : undefined;
  const commands = subsView ? (
    <>
      <CommandButton icon={<NewItemIcon />} label="New subscription" title="Subscribe an endpoint to a topic" disabled={readOnly || !all} onClick={() => newSubscription(null)} />
      <CommandSeparator />
      <CommandButton icon={<EditIcon />} label="Edit" title="Edit subscription" disabled={readOnly || !selSub || selSub.pending} onClick={() => selSub && editSubscription(selSub)} />
      <CommandButton icon={<DeleteIcon />} label="Unsubscribe" title="Unsubscribe (Del)" disabled={readOnly || !selSub || selSub.pending} onClick={() => selSub && void unsubscribe(selSub)} />
      <CommandSeparator />
      <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} />
    </>
  ) : active ? (
    <>
      <CommandButton icon={<NewItemIcon />} label="New topic" title="Create a topic (Ctrl+Shift+N)" disabled={readOnly || !connection} onClick={newTopic} />
      <CommandButton icon={<SendIcon />} label="Publish" title="Publish messages" disabled={readOnly || !target} onClick={() => target && void openPublish(target)} />
      <CommandSeparator />
      <CommandButton icon={<EditIcon />} label="Edit" title="Edit topic settings (Ctrl+E)" disabled={readOnly || !target} onClick={() => target && void editTopic(target)} />
      <CommandButton icon={<DeleteIcon />} label="Delete" title="Delete topic (Del)" disabled={readOnly || !target} onClick={() => target && void deleteTopic(target)} />
      <CommandSeparator />
      <CommandButton icon={<RefreshIcon />} label="Refresh" title="Refresh (F5)" disabled={!connection} onClick={refresh} />
    </>
  ) : null;

  const settingsDialog = settings ? (
    <TopicSettingsDialog
      topic={settings.topic}
      onClose={() => setSettings(null)}
      onSaved={(name, warning) => {
        const created = !settings.topic;
        setSettings(null);
        if (warning) shell.showError({ kind: "other", message: `${created ? "Created" : "Saved"} ${name}, but: ${warning}` });
        else shell.showFlash(created ? `Created ${name}.` : `Saved ${name}.`);
        refresh();
        if (created) go(name);
      }}
    />
  ) : null;

  const subscriptionDialog = subDialog ? (
    <SubscriptionDialog
      {...(subDialog.mode === "create" ? { mode: "create" as const, topicArn: subDialog.topicArn, topics: all ?? [] } : { mode: "edit" as const, sub: subDialog.sub })}
      onClose={() => setSubDialog(null)}
      onSaved={(msg, warning) => {
        setSubDialog(null);
        if (warning) shell.showError({ kind: "other", message: `${msg} But: ${warning}` });
        else shell.showFlash(msg);
        refresh();
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
        {subscriptionDialog}
        {publishTo && <PublishDialog topic={publishTo} shell={shell} onClose={() => setPublishTo(null)} onSent={refresh} />}
      </>
    ),
  };
}
