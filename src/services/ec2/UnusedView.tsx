// Unused resources: a report built in Rust (ec2_unused.rs), filtered by kind
// on screen, rows open the resource, Export saves what's shown.
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/s3";
import { ec2Api, type UnusedItem } from "../../api/ec2";
import { ErrorPanel } from "../../components/ErrorPanel";
import { FileList, type Column, type Row } from "../../components/FileList";
import { HelpTopic } from "../../components/HelpDialog";
import { UnusedIcon } from "../../components/Icons";
import { formatDate } from "../../format";
import { EC2_KIND_LABEL, EC2_ROOT, type Ec2Kind } from "../../shell/places";
import type { Shell } from "../../shell/shell";
import { useLoad } from "./common";

const KINDS: Ec2Kind[] = ["volumes", "addresses", "securityGroups", "snapshots", "images"];

const COLUMNS: Column[] = [
  { id: "kind", label: "Kind", width: 120 },
  { id: "id", label: "ID", width: 210 },
  { id: "name", label: "Name", width: 220 },
  { id: "size", label: "Size", width: 80, align: "right" },
  { id: "created", label: "Created", width: 165 },
  { id: "reason", label: "Why it's listed", width: 520 },
];

export function UnusedView({ shell, reloadToken, onStatus }: { shell: Shell; reloadToken: number; onStatus: (s: string) => void }) {
  const region = shell.connection?.serviceRegion ?? "";
  const { data, error, retry } = useLoad(`${shell.connectionId}|${region}|${reloadToken}`, () => ec2Api.unused());
  const [kind, setKind] = useState<Ec2Kind | "all">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const shown = useMemo(() => (data ? data.items.filter((i) => kind === "all" || i.kind === kind) : null), [data, kind]);
  const gib = (shown ?? []).filter((i) => i.kind === "volumes" || i.kind === "snapshots").reduce((n, i) => n + (i.sizeGib ?? 0), 0);

  useEffect(() => {
    if (shown) onStatus(`${shown.length.toLocaleString()} unused resource${shown.length === 1 ? "" : "s"}${gib ? `, ${gib.toLocaleString()} GiB of volumes and snapshots` : ""} · ${region}`);
    else onStatus(`Unused resources · ${region}`);
  }, [shown, gib, region, onStatus]);

  const rows: Row[] = useMemo(
    () =>
      (shown ?? []).map((i) => ({
        key: `${i.kind}|${i.id}`,
        icon: <UnusedIcon />,
        isContainer: false,
        cells: {
          kind: { text: EC2_KIND_LABEL[i.kind as Ec2Kind] ?? i.kind, sort: KINDS.indexOf(i.kind as Ec2Kind) },
          id: { text: i.id, sort: i.id },
          name: { text: i.name ?? "", sort: (i.name ?? "").toLowerCase() },
          size: { text: i.sizeGib != null ? `${i.sizeGib.toLocaleString()} GiB` : "", sort: i.sizeGib ?? 0 },
          created: { text: formatDate(i.created), sort: i.created ?? "" },
          reason: { text: i.reason, sort: i.reason },
        },
      })),
    [shown],
  );

  const open = (key: string) => {
    const [k, id] = key.split("|");
    shell.navigate({ ...EC2_ROOT, kind: k as Ec2Kind, id });
  };

  async function exportAs(format: "csv" | "json") {
    if (!shown) return;
    const dest = await api.pickSaveAs("Export unused resources", `unused-ec2-${region}.${format}`);
    if (!dest) return;
    try {
      const n = await ec2Api.exportUnused(shown as UnusedItem[], dest, format);
      shell.showFlash(`Saved ${n.toLocaleString()} row${n === 1 ? "" : "s"} to ${dest}.`);
    } catch (e) {
      shell.showError(e);
    }
  }

  const count = (k: Ec2Kind) => data?.items.filter((i) => i.kind === k).length ?? 0;
  return (
    <div className="service-pane">
      <HelpTopic id="ec2.unused" />
      <div className="row ec2-bar">
        <div className="segmented small">
          <button className={kind === "all" ? "active" : ""} onClick={() => setKind("all")}>
            All{data ? ` (${data.items.length})` : ""}
          </button>
          {KINDS.map((k) => (
            <button key={k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>
              {EC2_KIND_LABEL[k]}
              {data ? ` (${count(k)})` : ""}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button className="btn" disabled={!shown?.length} onClick={() => void exportAs("csv")}>
          Export CSV…
        </button>
        <button className="btn" disabled={!shown?.length} onClick={() => void exportAs("json")}>
          Export JSON…
        </button>
      </div>
      {data && data.skipped.length > 0 && <div className="warn-note">Not checked: {data.skipped.join("; ")}.</div>}
      {error && !data ? (
        <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />
      ) : (
        <FileList
          storageKey="ec2.unused"
          columns={COLUMNS}
          rows={rows}
          selected={selected}
          onSelectionChange={setSelected}
          onOpen={open}
          onContextMenu={(k, x, y) =>
            k &&
            shell.openMenu(x, y, [
              { label: "Open", bold: true, shortcut: "Enter", onClick: () => open(k) },
              { label: "Copy ID", onClick: () => void shell.copyText(k.split("|")[1]) },
            ])
          }
          emptyText={!shown ? "Checking volumes, addresses, groups, snapshots and images…" : "Nothing unused found."}
        />
      )}
    </div>
  );
}
