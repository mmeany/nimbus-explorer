import { api, type TransferEvent } from "../api/s3";
import { formatSize } from "../format";
import { baseName } from "../state/navigation";
import { isActive, type TransferSummary } from "../state/transfers";
import { CopyIcon, DownloadIcon, UploadIcon } from "./Icons";

/** Compact status-bar indicator; click to open the panel. */
export function TransferIndicator({ summary, onClick }: { summary: TransferSummary; onClick: () => void }) {
  if (summary.active === 0 && summary.failed === 0) {
    return (
      <button className="status-btn" onClick={onClick} title="Show transfers">
        Transfers
      </button>
    );
  }
  const parts: string[] = [];
  if (summary.uploads) parts.push(`⬆ ${summary.uploads}`);
  if (summary.downloads) parts.push(`⬇ ${summary.downloads}`);
  if (summary.copies) parts.push(`⧉ ${summary.copies}`);
  if (summary.failed && summary.active === 0) parts.push(`${summary.failed} failed`);
  return (
    <button className="status-btn" onClick={onClick} title="Show transfers">
      {parts.join("  ")}
      {summary.active > 0 && summary.fraction !== null && (
        <>
          <span className="mini-bar">
            <span style={{ width: `${Math.round(summary.fraction * 100)}%` }} />
          </span>
          {Math.round(summary.fraction * 100)}%
        </>
      )}
    </button>
  );
}

interface PanelProps {
  list: TransferEvent[];
  onClose: () => void;
  onClearFinished: () => void;
}

export function TransfersPanel({ list, onClose, onClearFinished }: PanelProps) {
  const anyActive = list.some(isActive);
  return (
    <div className="transfers-panel" role="dialog" aria-label="Transfers">
      <div className="tp-header">
        <span className="tp-title">Transfers</span>
        <div className="spacer" />
        <button className="link-btn" disabled={!anyActive} onClick={() => void api.cancelAllTransfers()}>
          Cancel all
        </button>
        <button className="link-btn" onClick={onClearFinished}>
          Clear finished
        </button>
        <button className="tool-btn" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="tp-list">
        {list.length === 0 && <div className="empty-note">No transfers yet.</div>}
        {list.map((t) => (
          <TransferRow key={t.id} t={t} />
        ))}
      </div>
    </div>
  );
}

function TransferRow({ t }: { t: TransferEvent }) {
  const pct = t.bytesTotal > 0 ? Math.min(100, (t.bytesDone / t.bytesTotal) * 100) : t.state === "done" ? 100 : 0;
  let status: string;
  switch (t.state) {
    case "queued":
      status = "Waiting…";
      break;
    case "running":
      status = t.bytesTotal ? `${formatSize(t.bytesDone)} of ${formatSize(t.bytesTotal)}` : formatSize(t.bytesDone);
      break;
    case "done":
      status = t.bytesTotal ? `Done · ${formatSize(t.bytesTotal)}` : "Done";
      break;
    case "cancelled":
      status = "Cancelled";
      break;
    case "failed":
      status = t.error ?? "Failed";
      break;
  }
  const dest = `s3://${t.bucket}/${t.key}`;
  const where =
    t.direction === "upload"
      ? `${t.localPath} → ${dest}`
      : t.direction === "download"
        ? `${dest} → ${t.localPath}`
        : `s3://${t.sourceBucket}/${t.sourceKey} → ${dest}`;
  const verb = { upload: "Upload", download: "Download", copy: "Copy", move: "Move" }[t.direction];
  return (
    <div className={`tp-row state-${t.state}`} title={where}>
      <span className="tp-icon" title={verb}>
        {t.direction === "download" ? <DownloadIcon /> : t.direction === "upload" ? <UploadIcon /> : <CopyIcon />}
      </span>
      <div className="tp-main">
        <div className="tp-name">{baseName(t.key)}</div>
        <div className="tp-bar">
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="tp-status">{status}</div>
      </div>
      {isActive(t) && (
        <button className="tool-btn" title="Cancel" onClick={() => void api.cancelTransfer(t.id)}>
          ✕
        </button>
      )}
    </div>
  );
}
