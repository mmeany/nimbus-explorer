// Create / edit / duplicate an item as plain JSON (with markers for sets,
// binary and big numbers) or as DynamoDB JSON.
import { useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { ddbApi, keyString, tableKeyAttrs, type TableInfo } from "../../api/dynamo";
import { ValueEditor } from "../../components/ValueEditor";
import type { Shell } from "../../shell/shell";
import { ddbType, itemFromPlain, itemToPlain, type DdbItem } from "../../util/ddbJson";

export type EditorMode = "create" | "edit" | "duplicate";

interface Props {
  table: TableInfo;
  mode: EditorMode;
  /** The item being edited / duplicated (fresh from the table). */
  item: DdbItem | null;
  shell: Shell;
  onClose: () => void;
  /** `replaced` = the original (edit with a changed key that was moved away). */
  onSaved: (item: DdbItem, replaced: DdbItem | null) => void;
}

/** Starting JSON for a new item: the key attributes with empty values. */
function template(t: TableInfo): DdbItem {
  const out: DdbItem = {};
  for (const k of [t.partitionKey, t.sortKey]) {
    if (!k) continue;
    out[k.name] = k.attrType === "N" ? { N: "0" } : k.attrType === "B" ? { B: "" } : { S: "" };
  }
  return out;
}

function show(item: DdbItem, ddb: boolean): string {
  return JSON.stringify(ddb ? item : itemToPlain(item), null, 2);
}

/** Parses the editor text into DynamoDB JSON (throws with a readable message). */
export function parseItem(text: string, ddb: boolean): DdbItem {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${(e as Error).message}`);
  }
  if (!ddb) return itemFromPlain(v);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("An item must be a JSON object");
  for (const [k, x] of Object.entries(v as object)) {
    if (!x || typeof x !== "object" || Object.keys(x).length !== 1) throw new Error(`${k}: expected a typed value like {"S": "text"}`);
  }
  return v as DdbItem;
}

/** Problems with the key attributes (missing, wrong type, empty). */
export function keyProblem(t: TableInfo, item: DdbItem): string | null {
  for (const k of [t.partitionKey, t.sortKey]) {
    if (!k) continue;
    const v = item[k.name];
    if (!v) return `The item needs its key attribute "${k.name}"`;
    if (ddbType(v) !== k.attrType) return `"${k.name}" must be of type ${k.attrType} (it's ${ddbType(v)})`;
    const inner = Object.values(v)[0];
    if (k.attrType !== "N" && inner === "") return `"${k.name}" can't be empty`;
  }
  return null;
}

export function ItemEditorDialog({ table, mode, item, shell, onClose, onSaved }: Props) {
  const [ddb, setDdb] = useState(false);
  const start = useMemo(() => (mode === "create" || !item ? template(table) : item), [mode, item, table]);
  const [text, setText] = useState(() => show(start, false));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo((): { item: DdbItem | null; problem: string | null } => {
    try {
      const it = parseItem(text, ddb);
      return { item: it, problem: keyProblem(table, it) };
    } catch (e) {
      return { item: null, problem: (e as Error).message };
    }
  }, [text, ddb, table]);

  function toggleFormat(toDdb: boolean) {
    if (toDdb === ddb) return;
    try {
      const it = parseItem(text, ddb);
      setText(show(it, toDdb));
      setDdb(toDdb);
    } catch (e) {
      setError(`Fix the JSON before switching: ${(e as Error).message}`);
    }
  }

  async function save() {
    const it = parsed.item;
    if (!it || parsed.problem || busy) return;
    setBusy(true);
    setError(null);
    const keys = tableKeyAttrs(table);
    try {
      if (mode === "edit" && item && keyString(table, it) !== keyString(table, item)) {
        // The key changed: that's a different item.
        const choice = await shell.ask(
          "Key changed",
          <>The key is part of an item's identity, so this saves a new item. Keep the original too, or move it (create the new one, then delete the original)?</>,
          [
            { label: "Move", value: "move", primary: true },
            { label: "Keep both", value: "copy" },
            { label: "Cancel", value: "cancel" },
          ],
          "cancel",
        );
        if (choice === "cancel") return;
        await ddbApi.putItem(table.name, keys, it, false);
        if (choice === "move") {
          const r = await ddbApi.deleteItems(table.name, [Object.fromEntries(keys.map((k) => [k, item[k]]))]);
          if (r.failed.length) shell.showError({ kind: "other", message: `Saved, but the original couldn't be deleted: ${r.failed[0][1]}` });
        }
        onSaved(it, choice === "move" ? item : null);
      } else {
        await ddbApi.putItem(table.name, keys, it, mode === "edit" ? true : false);
        onSaved(it, null);
      }
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const title = mode === "create" ? "New item" : mode === "duplicate" ? "Duplicate item" : "Edit item";
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog param-dialog item-editor"
        role="dialog"
        aria-modal
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && e.ctrlKey) void save();
        }}
      >
        <div className="dialog-title">
          {title} · <span className="mono">{table.name}</span>
        </div>
        <div className="dialog-body">
          <div className="row ie-head">
            <div className="segmented small">
              <button className={!ddb ? "active" : ""} onClick={() => toggleFormat(false)}>
                JSON
              </button>
              <button className={ddb ? "active" : ""} onClick={() => toggleFormat(true)}>
                DynamoDB JSON
              </button>
            </div>
            <span className="hint">
              Key: {tableKeyAttrs(table).join(" + ")}
              {mode === "duplicate" ? " · change the key before saving" : ""}
            </span>
          </div>
          <ValueEditor value={text} onChange={setText} rows={20} />
          {!ddb && (
            <div className="hint">
              Sets, binary and numbers too big for JSON use markers: {'{"$SS": ["a","b"]}'}, {'{"$NS": [1,2]}'}, {'{"$BS": ["base64"]}'}, {'{"$B": "base64"}'},{" "}
              {'{"$N": "12345678901234567890"}'}. null is DynamoDB NULL.
            </div>
          )}
          {parsed.problem && <div className="field-error">{parsed.problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <span className="hint">{mode === "edit" ? "Replaces the whole item." : "Won't overwrite an existing item."}</span>
          <div className="spacer" />
          <button className="btn primary" disabled={!!parsed.problem || busy || shell.readOnly} onClick={() => void save()}>
            {busy ? "Saving…" : mode === "edit" ? "Save" : "Create"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
