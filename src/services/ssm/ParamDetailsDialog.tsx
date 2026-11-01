import { ssmApi, type ParamInfo } from "../../api/ssm";
import { MaskedValue } from "../../components/MaskedValue";
import { ValueView } from "../../components/ValueView";
import { formatDate } from "../../format";

interface Props {
  param: ParamInfo;
  onClose: () => void;
  /** Absent in read-only mode. */
  onEdit?: () => void;
  onError: (e: unknown) => void;
  onHistory: () => void;
  onSettings: () => void;
  onCopied: () => void;
}

/** Read-only view of a parameter's metadata and value. */
export function ParamDetailsDialog({ param: p, onClose, onEdit, onError, onCopied, onHistory, onSettings }: Props) {
  const rows: [string, string | null][] = [
    ["Name", p.name],
    ["Type", p.paramType],
    ["Version", String(p.version)],
    ["Last modified", p.lastModified ? formatDate(p.lastModified) : null],
    ["Modified by", p.lastModifiedUser],
    ["Tier", p.tier],
    ["Data type", p.dataType],
    ["Description", p.description],
    ["KMS key", p.keyId],
    ["Allowed pattern", p.allowedPattern],
    ["Policies", p.policies.length ? p.policies.map((x) => `${x.policyType} (${x.status})`).join(", ") : null],
  ];
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog param-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="param-title"
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="dialog-title mono" id="param-title">
          {p.name}
        </div>
        <div className="dialog-body">
          <table className="props-table">
            <tbody>
              {rows
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <tr key={k}>
                    <th>{k}</th>
                    <td className={k === "Name" || k === "KMS key" ? "mono" : ""}>{v}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <div className="props-section">Value</div>
          {p.paramType === "SecureString" ? (
            <>
              <div className="hint">Encrypted. Reveal or Copy decrypts it now; the value isn't kept after you hide it or close this window.</div>
              <MaskedValue
                load={() => ssmApi.getValue(p.name, true)}
                onError={onError}
                onCopied={onCopied}
                renderRevealed={(v) => <ValueView value={v} />}
              />
            </>
          ) : p.value === null ? (
            <div className="hint">Value not loaded.</div>
          ) : (
            <>
              {p.paramType === "StringList" && (
                <div className="hint">StringList with {p.value.split(",").length} item(s).</div>
              )}
              <ValueView value={p.value} />
            </>
          )}
        </div>
        <div className="dialog-buttons">
          {onEdit && (
            <button className="btn" onClick={onEdit}>
              Edit…
            </button>
          )}
          <button className="btn" onClick={onHistory}>
            History…
          </button>
          <button className="btn" onClick={onSettings}>
            Tags and policies…
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
