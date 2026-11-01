// Create / edit a parameter.
import { useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { ssmApi, type ParamInfo, type ParamType } from "../../api/ssm";
import { ValueEditor } from "../../components/ValueEditor";
import type { Shell } from "../../shell/shell";

export type EditorTarget = { mode: "create"; folder: string } | { mode: "edit"; param: ParamInfo };

interface Props {
  target: EditorTarget;
  shell: Shell;
  onClose: () => void;
  onSaved: (name: string, version: number) => void;
}

const TYPES: { id: ParamType; hint: string }[] = [
  { id: "String", hint: "Any text" },
  { id: "StringList", hint: "Comma-separated values" },
  { id: "SecureString", hint: "Encrypted with KMS" },
];
const TIERS = ["Standard", "Advanced", "Intelligent-Tiering"];
const DATA_TYPES = ["text", "aws:ec2:image", "aws:ssm:integration"];
/** Value size limits in bytes. */
const STANDARD_MAX = 4096;
const ADVANCED_MAX = 8192;

/** Mirrors `ssm::name_problem` in Rust (the backend checks again). */
export function paramNameProblem(name: string): string | null {
  if (!name) return "Enter a name";
  if (name.length > 1011) return "Names can be at most 1011 characters";
  const bad = [...name].find((c) => !/[A-Za-z0-9_.\-/]/.test(c));
  if (bad) return `${bad === " " ? "Spaces aren't" : `"${bad}" isn't`} allowed; use letters, digits, _ . - and /`;
  if (name.includes("/") && !name.startsWith("/")) return "Hierarchical names must begin with /";
  if (name.endsWith("/") || name.includes("//")) return "Names can't end with / or contain empty segments";
  const first = name.replace(/^\/+/, "").toLowerCase();
  if (first.startsWith("aws") || first.startsWith("ssm")) return 'Names can\'t begin with "aws" or "ssm"';
  if ((name.match(/\//g) ?? []).length > 15) return "At most 15 levels of hierarchy";
  return null;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function ParamEditorDialog({ target, shell, onClose, onSaved }: Props) {
  const editing = target.mode === "edit";
  const orig = editing ? target.param : null;
  const [name, setName] = useState(editing ? target.param.name : target.folder === "/" ? "/" : target.folder);
  const [type, setType] = useState<ParamType>(orig?.paramType ?? "String");
  const [value, setValue] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [description, setDescription] = useState(orig?.description ?? "");
  const [keyId, setKeyId] = useState(orig?.keyId && orig.keyId !== "alias/aws/ssm" ? orig.keyId : "");
  const [pattern, setPattern] = useState(orig?.allowedPattern ?? "");
  const [dataType, setDataType] = useState(orig?.dataType ?? "text");
  const [tier, setTier] = useState(orig?.tier ?? "Standard");
  /** Editing loads the current value first (decrypted for SecureString: Edit is an explicit action). */
  const [loaded, setLoaded] = useState(!editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!orig) return;
    let live = true;
    ssmApi
      .getValue(orig.name, orig.paramType === "SecureString")
      .then((v) => {
        if (!live) return;
        setValue(v);
        setLoaded(true);
      })
      .catch((e) => live && setError((e as AppError).message ?? String(e)));
    return () => {
      live = false;
      setValue(""); // drop any plaintext
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nameErr = editing ? null : paramNameProblem(name.trim());
  const size = byteLength(value);
  const max = tier === "Standard" ? STANDARD_MAX : ADVANCED_MAX;

  const patternProblem = useMemo(() => {
    if (!pattern) return null;
    try {
      const re = new RegExp(pattern);
      return value && !re.test(value) ? "The value doesn't match the allowed pattern" : null;
    } catch {
      return null; // SSM uses Java regexes; let the service judge ones JS can't parse
    }
  }, [pattern, value]);

  const valueErr = !value
    ? "A value is required"
    : size > ADVANCED_MAX
      ? `Values can be at most ${ADVANCED_MAX.toLocaleString()} bytes`
      : size > max
        ? `Standard tier allows ${STANDARD_MAX.toLocaleString()} bytes; choose Advanced or Intelligent-Tiering`
        : patternProblem;
  const invalid = !!nameErr || !!valueErr || !loaded;

  async function save() {
    setTouched(true);
    if (invalid || saving) return;
    setSaving(true);
    setError(null);
    const finalName = name.trim();
    const param = {
      name: finalName,
      value,
      paramType: type,
      description: description.trim() || null,
      keyId: type === "SecureString" ? keyId.trim() || null : null,
      allowedPattern: pattern.trim() || null,
      dataType: dataType || null,
      tier,
      overwrite: editing,
    };
    try {
      if (orig) {
        // Someone else may have changed it while the dialog was open.
        const now = await ssmApi.describe(orig.name);
        if (now && now.version !== orig.version) {
          const go = await shell.ask(
            "Parameter changed",
            <>
              <span className="mono">{orig.name}</span> is now at version {now.version} (you opened version {orig.version}).
              Saving replaces the newer value.
            </>,
            [
              { label: "Save anyway", value: "save", primary: true },
              { label: "Cancel", value: "cancel" },
            ],
            "cancel",
          );
          if (go !== "save") return;
        }
      } else if (await ssmApi.describe(finalName)) {
        const go = await shell.ask(
          "Parameter exists",
          <>
            <span className="mono">{finalName}</span> already exists. Overwrite it? The current value is kept as an older version.
          </>,
          [
            { label: "Overwrite", value: "overwrite", primary: true },
            { label: "Cancel", value: "cancel" },
          ],
          "cancel",
        );
        if (go !== "overwrite") return;
        param.overwrite = true;
      }
      const version = await ssmApi.put(param);
      onSaved(finalName, version);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  const secret = type === "SecureString";
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog param-dialog param-editor"
        role="dialog"
        aria-modal
        aria-labelledby="pe-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && e.ctrlKey) void save();
        }}
      >
        <div className="dialog-title" id="pe-title">
          {editing ? "Edit parameter" : "New parameter"}
        </div>
        <div className="dialog-body">
          <label className="form-label" htmlFor="pe-name">
            Name
          </label>
          <input
            id="pe-name"
            className="text-input mono"
            value={name}
            readOnly={editing}
            autoFocus={!editing}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setTouched(true)}
          />
          {touched && nameErr && <div className="field-error">{nameErr}</div>}

          <fieldset className="radio-group inline">
            <legend>Type</legend>
            {TYPES.map((t) => (
              <label key={t.id} title={t.hint}>
                <input type="radio" name="pe-type" checked={type === t.id} onChange={() => setType(t.id)} /> {t.id}
              </label>
            ))}
          </fieldset>

          <div className="row pe-value-head">
            <span className="form-label">Value</span>
            {type === "StringList" && <span className="hint">Comma-separated, e.g. a,b,c</span>}
            <div className="spacer" />
            {secret && (
              <button className="link-btn" onClick={() => setShowSecret((v) => !v)}>
                {showSecret ? "Hide" : "Show"}
              </button>
            )}
            <span className={`hint ${size > max ? "danger-text" : ""}`}>
              {size.toLocaleString()} / {max.toLocaleString()} bytes
            </span>
          </div>
          <ValueEditor
            value={value}
            onChange={setValue}
            rows={8}
            disabled={!loaded}
            placeholder={loaded ? "" : "Loading current value…"}
            secret={secret && !showSecret}
          />
          {touched && valueErr && loaded && <div className="field-error">{valueErr}</div>}

          <label className="form-label" htmlFor="pe-desc">
            Description
          </label>
          <input id="pe-desc" className="text-input" value={description} maxLength={1024} onChange={(e) => setDescription(e.target.value)} />

          {secret && (
            <>
              <label className="form-label" htmlFor="pe-kms">
                KMS key
              </label>
              <input
                id="pe-kms"
                className="text-input mono"
                value={keyId}
                placeholder="alias/aws/ssm (default), a key ID, alias or ARN"
                spellCheck={false}
                onChange={(e) => setKeyId(e.target.value)}
              />
            </>
          )}

          <div className="pe-grid">
            <label className="form-label" htmlFor="pe-tier">
              Tier
            </label>
            <select id="pe-tier" className="text-input" value={tier} onChange={(e) => setTier(e.target.value)}>
              {TIERS.map((t) => (
                <option key={t} value={t} disabled={t === "Standard" && orig?.tier === "Advanced"}>
                  {t}
                  {t === "Standard" && orig?.tier === "Advanced" ? " (can't downgrade)" : ""}
                </option>
              ))}
            </select>
            <label className="form-label" htmlFor="pe-dt">
              Data type
            </label>
            <select id="pe-dt" className="text-input" value={dataType} onChange={(e) => setDataType(e.target.value)}>
              {DATA_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <label className="form-label" htmlFor="pe-pat">
              Allowed pattern
            </label>
            <input
              id="pe-pat"
              className="text-input mono"
              value={pattern}
              placeholder="Optional regular expression, e.g. ^\d+$"
              spellCheck={false}
              onChange={(e) => setPattern(e.target.value)}
            />
          </div>
          {tier === "Advanced" && orig?.tier !== "Advanced" && (
            <div className="warn-note">Advanced parameters are charged and can't be changed back to Standard.</div>
          )}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          {editing && <span className="hint">Saving creates version {orig!.version + 1}.</span>}
          <div className="spacer" />
          <button className="btn primary" disabled={saving || (touched && invalid) || !loaded} onClick={() => void save()}>
            {saving ? "Saving…" : editing ? "Save" : "Create"}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
