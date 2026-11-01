// Create a secret, or change an existing one's value / description / KMS key.
import { useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { secretNameProblem, smApi, type SecretInfo } from "../../api/secrets";
import { ValueEditor } from "../../components/ValueEditor";
import type { Shell } from "../../shell/shell";
import { TagRows } from "../sqs/QueueSettingsDialog";
import { flatObject } from "./SecretValueDisplay";

interface Props {
  /** null = create in `folder`. */
  secret: SecretInfo | null;
  folder: string;
  shell: Shell;
  onClose: () => void;
  onSaved: (name: string) => void;
}

type Mode = "kv" | "text" | "binary";
type Kind = "string" | "number" | "boolean" | "null";
type Pair = { key: string; value: string; kind: Kind };

function typed(p: Pair): unknown {
  if (p.kind === "number" && p.value.trim() !== "" && Number.isFinite(Number(p.value))) return Number(p.value);
  if (p.kind === "boolean" && (p.value === "true" || p.value === "false")) return p.value === "true";
  if (p.kind === "null") return null;
  return p.value;
}

function pairsToJson(pairs: Pair[]): string {
  return JSON.stringify(Object.fromEntries(pairs.map((p) => [p.key.trim(), typed(p)])));
}

/** Pairs from a flat JSON object, keeping each value's JSON type. */
function toPairs(text: string): Pair[] | null {
  if (!flatObject(text)) return null;
  const o = JSON.parse(text) as Record<string, unknown>;
  return Object.entries(o).map(([key, v]) => ({
    key,
    value: v === null ? "" : String(v),
    kind: v === null ? "null" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string",
  }));
}

function kindProblem(p: Pair): string | null {
  if (p.kind === "number" && (p.value.trim() === "" || !Number.isFinite(Number(p.value)))) return `"${p.key}" must be a number`;
  if (p.kind === "boolean" && p.value !== "true" && p.value !== "false") return `"${p.key}" must be true or false`;
  return null;
}

export function SecretEditorDialog({ secret, folder, shell, onClose, onSaved }: Props) {
  const editing = !!secret;
  const [name, setName] = useState(folder);
  const [mode, setMode] = useState<Mode>("kv");
  const [pairs, setPairs] = useState<Pair[]>([{ key: "", value: "", kind: "string" }]);
  const [text, setText] = useState("");
  const [binary, setBinary] = useState("");
  const [show, setShow] = useState(false);
  const [description, setDescription] = useState(secret?.description ?? "");
  const [kms, setKms] = useState(secret?.kmsKeyId ?? "");
  const [tags, setTags] = useState<{ key: string; value: string }[]>([]);
  /** Editing: the original value (to know whether it changed); loaded on open. */
  const [original, setOriginal] = useState<string | null>(editing ? null : "");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!secret) return;
    let live = true;
    smApi
      .getValue(secret.arn ?? secret.name)
      .then((v) => {
        if (!live) return;
        if (v.text === null) {
          setMode("binary");
          setBinary(v.binaryBase64 ?? "");
          setOriginal(`b:${v.binaryBase64 ?? ""}`);
          return;
        }
        const ps = toPairs(v.text);
        if (ps && ps.length) {
          setMode("kv");
          setPairs(ps);
        } else {
          setMode("text");
        }
        setText(v.text);
        setOriginal(`t:${v.text}`);
      })
      .catch((e) => live && setLoadError((e as AppError).message ?? String(e)));
    return () => {
      live = false;
      setText("");
      setPairs([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo(() => {
    if (mode === "binary") return { text: null, binaryBase64: binary.trim() };
    return { text: mode === "kv" ? pairsToJson(pairs) : text, binaryBase64: null };
  }, [mode, pairs, text, binary]);
  const valueKey = value.text !== null ? `t:${value.text}` : `b:${value.binaryBase64}`;
  // Key/value edits are compared by content, so reformatting alone isn't a change.
  const valueChanged =
    !editing || (original !== null && valueKey !== original && !(value.text !== null && original.startsWith("t:") && flatEqual(original.slice(2), value.text)));

  const problem =
    (!editing ? secretNameProblem(name.trim()) : null) ??
    (mode === "kv" ? (pairs.some((p) => !p.key.trim()) ? "Every key needs a name" : new Set(pairs.map((p) => p.key.trim())).size !== pairs.length ? "Keys must be different" : !pairs.length ? "Add at least one key" : (pairs.map(kindProblem).find(Boolean) ?? null)) : null) ??
    (mode === "text" && !text ? "Enter a value" : null) ??
    (mode === "binary" && !/^[A-Za-z0-9+/]+={0,2}$/.test(binary.trim()) ? "Binary values must be base64" : null) ??
    (tags.some((t) => !t.key.trim()) ? "Every tag needs a key" : null);
  const suffixWarning = !editing && /-[A-Za-z0-9]{6}$/.test(name.trim());

  function switchMode(m: Mode) {
    if (m === mode) return;
    if (m === "text" && mode === "kv") setText(JSON.stringify(JSON.parse(pairsToJson(pairs)), null, 2));
    if (m === "kv" && mode === "text") {
      const ps = toPairs(text);
      if (text.trim() && !ps) return setError("Only a flat JSON object (keys with text / number / true / false values) can be edited as key / value pairs");
      setPairs(ps && ps.length ? ps : [{ key: "", value: "", kind: "string" }]);
    }
    setError(null);
    setMode(m);
  }

  async function save() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!editing) {
        await smApi.create(name.trim(), value, description.trim() || null, kms.trim() || null, tags.map((t) => [t.key.trim(), t.value]));
        onSaved(name.trim());
      } else {
        const id = secret!.arn ?? secret!.name;
        if (description !== (secret!.description ?? "") || kms !== (secret!.kmsKeyId ?? "")) {
          await smApi.updateMetadata(id, description, kms.trim() || null);
        }
        if (valueChanged) await smApi.putValue(id, value);
        onSaved(secret!.name);
      }
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const loading = editing && original === null && !loadError;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog secret-editor" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">{editing ? <>Edit secret · <span className="mono">{secret!.name}</span></> : "New secret"}</div>
        <div className="dialog-body">
          {!editing && (
            <>
              <label className="form-label" htmlFor="se-name">
                Name
              </label>
              <input id="se-name" className="text-input mono" autoFocus value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
              {suffixWarning && <div className="hint">Names ending in a hyphen and six characters can be confused with the random suffix Secrets Manager adds to ARNs.</div>}
            </>
          )}
          <div className="row se-head">
            <span className="form-label">Value</span>
            <div className="segmented small">
              <button className={mode === "kv" ? "active" : ""} disabled={loading} onClick={() => switchMode("kv")}>
                Key / value
              </button>
              <button className={mode === "text" ? "active" : ""} disabled={loading} onClick={() => switchMode("text")}>
                Plaintext
              </button>
              <button className={mode === "binary" ? "active" : ""} disabled={loading} onClick={() => switchMode("binary")}>
                Binary
              </button>
            </div>
            <div className="spacer" />
            <button className="link-btn" onClick={() => setShow((v) => !v)}>
              {show ? "Hide values" : "Show values"}
            </button>
          </div>
          {loadError ? (
            <div className="field-error">Couldn't load the current value: {loadError}</div>
          ) : loading ? (
            <div className="hint">Loading the current value…</div>
          ) : mode === "kv" ? (
            <>
              <table className="tag-table">
                <tbody>
                  {pairs.map((p, i) => (
                    <tr key={i}>
                      <td>
                        <input className="text-input mono" placeholder="Key" value={p.key} onChange={(e) => setPairs(pairs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
                      </td>
                      <td>
                        <input
                          className={`text-input mono ${show ? "" : "masked-input"}`}
                          placeholder="Value"
                          value={p.value}
                          spellCheck={false}
                          autoComplete="off"
                          onChange={(e) => setPairs(pairs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                        />
                      </td>
                      <td style={{ width: 100 }}>
                        <select className="text-input" value={p.kind} title="JSON type of the value" onChange={(e) => setPairs(pairs.map((x, j) => (j === i ? { ...x, kind: e.target.value as Kind } : x)))}>
                          <option value="string">Text</option>
                          <option value="number">Number</option>
                          <option value="boolean">true/false</option>
                          <option value="null">null</option>
                        </select>
                      </td>
                      <td>
                        <button className="link-btn" onClick={() => setPairs(pairs.filter((_, j) => j !== i))}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row">
                <button className="link-btn" onClick={() => setPairs([...pairs, { key: "", value: "", kind: "string" }])}>
                  + Add key
                </button>
              </div>
            </>
          ) : mode === "text" ? (
            <ValueEditor value={text} onChange={setText} rows={8} secret={!show} />
          ) : (
            <ValueEditor value={binary} onChange={setBinary} rows={4} secret={!show} placeholder="base64" />
          )}

          <label className="form-label" htmlFor="se-desc">
            Description
          </label>
          <input id="se-desc" className="text-input" value={description} onChange={(e) => setDescription(e.target.value)} />
          <label className="form-label" htmlFor="se-kms">
            Encryption key
          </label>
          <input id="se-kms" className="text-input mono" value={kms} placeholder="aws/secretsmanager (default), or a KMS key ID / alias / ARN" spellCheck={false} onChange={(e) => setKms(e.target.value)} />
          {!editing && (
            <>
              <div className="props-section">Tags</div>
              <TagRows tags={tags} onChange={setTags} />
            </>
          )}
          {editing && <div className="hint">Saving a new value creates a new version labelled AWSCURRENT; the previous one becomes AWSPREVIOUS.</div>}
          {problem && (editing || name !== folder) && <div className="field-error">{problem}</div>}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          <div className="spacer" />
          <button className="btn primary" disabled={!!problem || busy || loading || !!loadError || shell.readOnly} onClick={() => void save()}>
            {busy ? "Saving…" : editing ? "Save" : "Create secret"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Same keys and values regardless of key order / formatting. */
function flatEqual(a: string, b: string): boolean {
  const x = flatObject(a);
  const y = flatObject(b);
  if (!x || !y) return false;
  const kx = Object.keys(x);
  return kx.length === Object.keys(y).length && kx.every((k) => y[k] === x[k]);
}
