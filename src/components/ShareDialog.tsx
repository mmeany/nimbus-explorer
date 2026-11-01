import { useState } from "react";
import { api, toAppError, type AppError, type ConnectionInfo, type ShareLink } from "../api/s3";
import { baseName } from "../state/navigation";

interface Props {
  bucket: string;
  objectKey: string;
  connection: ConnectionInfo;
  onClose: () => void;
}

const EXPIRY: [label: string, secs: number][] = [
  ["15 minutes", 15 * 60],
  ["1 hour", 3600],
  ["12 hours", 12 * 3600],
  ["1 day", 86400],
  ["7 days (maximum)", 7 * 86400],
];

/** Creates a time-limited presigned download link. */
export function ShareDialog({ bucket, objectKey, connection, onClose }: Props) {
  const [secs, setSecs] = useState(3600);
  const [link, setLink] = useState<ShareLink | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setLink(await api.shareLink(bucket, objectKey, secs));
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      /* user can select the text manually */
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog share-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="share-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="dialog-title" id="share-title">
          Share link: {baseName(objectKey)}
        </div>
        <div className="dialog-body">
          <p className="hint">
            Anyone with the link can download this file until it expires. No AWS account is needed.
          </p>
          <div className="row">
            <label className="form-label" htmlFor="expiry">
              Expires after
            </label>
            <select
              id="expiry"
              className="select"
              value={secs}
              onChange={(e) => {
                setSecs(Number(e.target.value));
                setLink(null);
              }}
            >
              {EXPIRY.map(([label, s]) => (
                <option key={s} value={s}>
                  {label}
                </option>
              ))}
            </select>
            <button className="btn primary" onClick={create} disabled={busy}>
              {busy ? "Creating…" : link ? "Create new link" : "Create link"}
            </button>
          </div>

          {error && <div className="field-error">{error.message}</div>}

          {link && (
            <>
              <div className="row">
                <input className="text-input grow mono" readOnly value={link.url} onFocus={(e) => e.target.select()} />
                <button className="btn" onClick={copy}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="hint">Expires {new Date(link.expiresAt).toLocaleString()}.</div>
              {link.limitedByCredentials && (
                <div className="warn-note">
                  ⚠ Shortened to match your session: the credentials for profile "{connection.profile}" expire before the
                  time you chose, and the link stops working when they do.
                </div>
              )}
              {!link.limitedByCredentials && link.temporaryCredentials && (
                <div className="warn-note">
                  ⚠ This profile uses temporary credentials (e.g. SSO or an assumed role). The link may stop working
                  early if that session ends.
                </div>
              )}
              {connection.endpointUrl && (
                <div className="warn-note">
                  ⚠ This link points at {connection.endpointUrl}, so it only works where that endpoint is reachable
                  (usually just this machine).
                </div>
              )}
            </>
          )}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
