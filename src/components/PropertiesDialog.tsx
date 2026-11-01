import { useEffect, useState } from "react";
import { api, toAppError, type AppError, type ConnectionInfo, type ItemCount, type ObjectProperties } from "../api/s3";
import { formatDate, formatSize } from "../format";
import { baseName } from "../state/navigation";

interface Props {
  bucket: string;
  /** Object key, or folder prefix ending in "/". */
  itemKey: string;
  connection: ConnectionInfo;
  onClose: () => void;
}

/** Encodes a key for use in a URL path, keeping "/". */
const encodeKey = (k: string) => k.split("/").map(encodeURIComponent).join("/");

function objectUrl(c: ConnectionInfo, region: string, bucket: string, key: string): string {
  if (c.endpointUrl) {
    const base = c.endpointUrl.replace(/\/+$/, "");
    return `${base}/${bucket}/${encodeKey(key)}`;
  }
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodeKey(key)}`;
}

export function PropertiesDialog({ bucket, itemKey, connection, onClose }: Props) {
  const isFolder = itemKey.endsWith("/");
  const [props, setProps] = useState<ObjectProperties | null>(null);
  const [count, setCount] = useState<ItemCount | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  useEffect(() => {
    const p = isFolder ? api.countItems(bucket, [itemKey]).then(setCount) : api.objectProperties(bucket, itemKey).then(setProps);
    p.catch((e) => setError(toAppError(e)));
  }, [bucket, itemKey, isFolder]);

  const uri = `s3://${bucket}/${itemKey}`;
  const rows: [string, string | null, boolean?][] = [
    ["Name", baseName(itemKey)],
    ["Type", isFolder ? "Folder" : (props?.contentType ?? null)],
    ["Location", `s3://${bucket}/${itemKey.slice(0, itemKey.slice(0, -1).lastIndexOf("/") + 1)}`],
  ];
  if (isFolder) {
    rows.push(
      ["Contains", count ? `${count.objects.toLocaleString()} object${count.objects === 1 ? "" : "s"}` : "Counting…"],
      ["Total size", count ? `${formatSize(count.bytes)} (${count.bytes.toLocaleString()} bytes)` : "Counting…"],
    );
  } else if (props) {
    rows.push(
      ["Size", `${formatSize(props.size)} (${props.size.toLocaleString()} bytes)`],
      ["Last modified", formatDate(props.lastModified)],
      ["Storage class", props.storageClass],
      ["ETag", props.etag, true],
      ["Version ID", props.versionId, true],
      ["Encryption", props.serverSideEncryption ? `${props.serverSideEncryption}${props.kmsKeyId ? ` (${props.kmsKeyId})` : ""}` : null],
      ["Cache-Control", props.cacheControl],
      ["Content-Encoding", props.contentEncoding],
      ["Content-Disposition", props.contentDisposition],
      ["Region", props.region],
    );
  }
  const links: [string, string][] = [["S3 URI", uri]];
  if (!isFolder && props) {
    links.push(["Object URL", objectUrl(connection, props.region, bucket, itemKey)]);
  }
  if (!connection.endpointUrl) links.push(["ARN", `arn:aws:s3:::${bucket}/${itemKey}`]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog props-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="props-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => (e.key === "Escape" || e.key === "Enter") && onClose()}
        tabIndex={-1}
        ref={(el) => el?.focus()}
      >
        <div className="dialog-title" id="props-title">
          Properties: {baseName(itemKey)}
        </div>
        <div className="dialog-body">
          {error && <div className="field-error">{error.message}</div>}
          {!error && !isFolder && !props && <div className="hint">Loading…</div>}
          <table className="props-table">
            <tbody>
              {rows
                .filter(([, v]) => v)
                .map(([k, v, mono]) => (
                  <tr key={k}>
                    <th>{k}</th>
                    <td className={mono ? "mono" : ""}>{v}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {props && Object.keys(props.metadata).length > 0 && (
            <>
              <div className="props-section">Metadata</div>
              <table className="props-table">
                <tbody>
                  {Object.entries(props.metadata).map(([k, v]) => (
                    <tr key={k}>
                      <th className="mono">x-amz-meta-{k}</th>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <div className="props-section">Addresses</div>
          {links.map(([label, value]) => (
            <CopyField key={label} label={label} value={value} />
          ))}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="row copy-field">
      <span className="copy-label">{label}</span>
      <input className="text-input grow mono" readOnly value={value} onFocus={(e) => e.target.select()} />
      <button
        className="btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          } catch {
            /* select manually */
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
