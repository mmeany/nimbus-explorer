// Metadata of one secret and its value (masked until Reveal).
import { useEffect, useState, type ReactNode } from "react";
import { smApi, type SecretInfo } from "../../api/secrets";
import { MaskedValue } from "../../components/MaskedValue";
import { formatDate } from "../../format";
import type { Shell } from "../../shell/shell";
import { SecretValueDisplay } from "./SecretValueDisplay";

interface Props {
  secret: SecretInfo;
  shell: Shell;
  onClose: () => void;
  /** Extra buttons (edit, versions, …) supplied by the controller. */
  actions?: ReactNode;
}

export function SecretDetailsDialog({ secret, shell, onClose, actions }: Props) {
  const [s, setS] = useState(secret);
  const [binary, setBinary] = useState(false);
  useEffect(() => {
    smApi.describe(secret.arn ?? secret.name).then(setS).catch(() => {});
  }, [secret]);

  const rows: [string, string | null][] = [
    ["Name", s.name],
    ["Description", s.description],
    ["ARN", s.arn],
    ["Encryption key", s.kmsKeyId ?? "aws/secretsmanager (default)"],
    ["Created", s.created ? formatDate(s.created) : null],
    ["Last changed", s.lastChanged ? formatDate(s.lastChanged) : null],
    ["Last retrieved", s.lastAccessed ? formatDate(s.lastAccessed) : null],
    ["Rotation", s.rotationEnabled ? `On${s.rotationSchedule ? `, ${s.rotationSchedule}` : ""}` : "Off"],
    ["Last rotated", s.lastRotated ? formatDate(s.lastRotated) : null],
    ["Next rotation", s.nextRotation ? formatDate(s.nextRotation) : null],
    ["Scheduled deletion", s.deletedDate ? formatDate(s.deletedDate) : null],
    ["Managed by", s.owningService],
    ["Primary region", s.primaryRegion],
  ];

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog param-dialog"
        role="dialog"
        aria-modal
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && e.target === e.currentTarget && onClose()}
      >
        <div className="dialog-title mono">{s.name}</div>
        <div className="dialog-body">
          {s.deletedDate && <div className="warn-note">Scheduled for deletion on {formatDate(s.deletedDate)}. Restore it to use it again.</div>}
          <table className="props-table">
            <tbody>
              {rows
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <tr key={k}>
                    <th>{k}</th>
                    <td className={k === "Name" || k === "ARN" ? "mono selectable" : ""}>{v}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {s.tags.length > 0 && (
            <>
              <div className="props-section">Tags</div>
              <table className="props-table">
                <tbody>
                  {s.tags.map(([k, v]) => (
                    <tr key={k}>
                      <th>{k}</th>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <div className="props-section">Value (current version)</div>
          {s.deletedDate ? (
            <div className="hint">Not available while scheduled for deletion.</div>
          ) : (
            <>
              <div className="hint">Reveal or Copy decrypts it now; it isn't kept after you hide it or close this window.</div>
              <MaskedValue
                load={async () => {
                  const v = await smApi.getValue(s.arn ?? s.name);
                  setBinary(v.text === null);
                  return v.text ?? v.binaryBase64 ?? "";
                }}
                onError={shell.showError}
                onCopied={() => shell.showFlash("Secret value copied to the clipboard.")}
                renderRevealed={(v) => <SecretValueDisplay value={v} binary={binary} onCopy={(t) => void navigator.clipboard.writeText(t).then(() => shell.showFlash("Copied."))} />}
              />
            </>
          )}
        </div>
        <div className="dialog-buttons">
          {actions}
          <div className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
