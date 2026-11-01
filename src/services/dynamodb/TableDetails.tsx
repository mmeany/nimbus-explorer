// Read-only overview of one table: keys, capacity, indexes, TTL, streams, …
import { useEffect, useState, type ReactNode } from "react";
import { ddbApi, keyLabel, type TableInfo } from "../../api/dynamo";
import { formatDate, formatSize } from "../../format";
import type { Shell } from "../../shell/shell";

interface Props {
  table: TableInfo;
  shell: Shell;
  onSettings?: () => void;
  onAddIndex?: () => void;
  onDeleteIndex?: (name: string) => void;
}

const BILLING: Record<string, string> = { PAY_PER_REQUEST: "On-demand", PROVISIONED: "Provisioned" };

export function TableDetails({ table: t, shell, onSettings, onAddIndex, onDeleteIndex }: Props) {
  const ro = shell.readOnly;
  const [tags, setTags] = useState<[string, string][] | null>(null);
  useEffect(() => {
    if (!t.arn) return setTags([]);
    ddbApi.listTags(t.arn).then(setTags).catch(() => setTags([]));
  }, [t.arn]);

  const rows: [string, ReactNode][] = [
    ["Status", t.status ?? ""],
    ["Partition key", keyLabel(t.partitionKey)],
    ["Sort key", t.sortKey ? keyLabel(t.sortKey) : "None"],
    ["Items (approx.)", t.itemCount !== null ? t.itemCount.toLocaleString() : ""],
    ["Size (approx.)", t.sizeBytes !== null ? formatSize(t.sizeBytes) : ""],
    [
      "Capacity",
      `${BILLING[t.billingMode ?? ""] ?? t.billingMode ?? ""}${
        t.billingMode === "PROVISIONED" ? ` · ${t.readCapacity ?? 0} read / ${t.writeCapacity ?? 0} write units` : ""
      }`,
    ],
    ["Table class", t.tableClass ?? "STANDARD"],
    ["Time to live", t.ttlStatus ? `${t.ttlStatus}${t.ttlAttribute ? ` (attribute ${t.ttlAttribute})` : ""}` : "Unknown"],
    ["Stream", t.streamEnabled ? `On (${t.streamViewType ?? ""})` : "Off"],
    ["Point-in-time recovery", t.pitrStatus ?? "Unknown"],
    ["Deletion protection", t.deletionProtection ? "On" : "Off"],
    ["Encryption", t.sse ?? "AWS owned key"],
    ["Created", formatDate(t.created)],
  ];

  return (
    <div className="table-details">
      <div className="row td-actions">
        <button className="btn" disabled={ro || !onSettings} onClick={onSettings}>
          Settings…
        </button>
        <button className="btn" disabled={ro || !onAddIndex} onClick={onAddIndex}>
          Add index…
        </button>
        {t.status && t.status !== "ACTIVE" && <span className="hint">The table is {t.status.toLowerCase()}; refresh to see when it's done.</span>}
      </div>
      <table className="props-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td>{v}</td>
            </tr>
          ))}
          {t.arn && (
            <tr>
              <th>ARN</th>
              <td className="mono selectable">
                {t.arn}{" "}
                <button className="link-btn" onClick={() => void shell.copyText(t.arn!)}>
                  Copy
                </button>
              </td>
            </tr>
          )}
          {t.streamArn && (
            <tr>
              <th>Stream ARN</th>
              <td className="mono selectable">{t.streamArn}</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="props-section">Indexes</div>
      {t.indexes.length === 0 ? (
        <p className="hint">No secondary indexes.</p>
      ) : (
        <table className="sync-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Partition key</th>
              <th>Sort key</th>
              <th>Projection</th>
              <th>Status</th>
              <th className="right">Items</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {t.indexes.map((i) => (
              <tr key={i.name}>
                <td className="mono">{i.name}</td>
                <td>{i.kind}</td>
                <td>{keyLabel(i.partitionKey)}</td>
                <td>{keyLabel(i.sortKey)}</td>
                <td title={i.nonKeyAttributes.join(", ")}>
                  {i.projection}
                  {i.nonKeyAttributes.length ? ` (${i.nonKeyAttributes.length})` : ""}
                </td>
                <td>
                  {i.status ?? (i.kind === "LSI" ? "ACTIVE" : "")}
                  {i.backfilling ? " (backfilling)" : ""}
                </td>
                <td className="right">{i.itemCount?.toLocaleString() ?? ""}</td>
                <td>
                  {i.kind === "GSI" && onDeleteIndex && (
                    <button className="link-btn" disabled={ro || i.status !== "ACTIVE"} onClick={() => onDeleteIndex(i.name)}>
                      Delete…
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="props-section">Attribute definitions</div>
      <p className="mono">{t.attributeDefinitions.map((d) => `${d.name} (${d.attrType})`).join(", ")}</p>

      <div className="props-section">Tags</div>
      {tags === null ? (
        <p className="hint">Loading…</p>
      ) : tags.length === 0 ? (
        <p className="hint">No tags.</p>
      ) : (
        <table className="props-table">
          <tbody>
            {tags.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">Item count and size are updated by DynamoDB about every six hours.</p>
    </div>
  );
}
