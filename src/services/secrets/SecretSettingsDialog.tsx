// Tags and resource policy of a secret.
import { useEffect, useState } from "react";
import type { AppError } from "../../api/core";
import { smApi, type SecretInfo } from "../../api/secrets";
import { ValueEditor } from "../../components/ValueEditor";
import type { Shell } from "../../shell/shell";
import { TagRows } from "../sqs/QueueSettingsDialog";

const TEMPLATE = `{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::123456789012:role/app" },
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "*"
    }
  ]
}`;

export function SecretSettingsDialog({ secret, shell, initialTab, onClose, onChanged }: { secret: SecretInfo; shell: Shell; initialTab: "tags" | "policy"; onClose: () => void; onChanged: () => void }) {
  const id = secret.arn ?? secret.name;
  const ro = shell.readOnly;
  const [tab, setTab] = useState(initialTab);
  const [tags, setTags] = useState(secret.tags.map(([key, value]) => ({ key, value })));
  const origTags = JSON.stringify(secret.tags.map(([key, value]) => ({ key, value })));
  const [policy, setPolicy] = useState<string | null>(null);
  const [origPolicy, setOrigPolicy] = useState<string | null>(null);
  const [blockPublic, setBlockPublic] = useState(true);
  const [check, setCheck] = useState<{ valid: boolean; errors: string[] } | { unavailable: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    smApi
      .getPolicy(id)
      .then((p) => {
        const pretty = p ? JSON.stringify(JSON.parse(p), null, 2) : "";
        setPolicy(pretty);
        setOrigPolicy(pretty);
      })
      .catch((e) => {
        setPolicy("");
        setOrigPolicy("");
        setError(`Couldn't read the policy: ${(e as AppError).message ?? e}`);
      });
  }, [id]);

  const tagsChanged = JSON.stringify(tags) !== origTags;
  const tagProblem = tags.some((t) => !t.key.trim()) ? "Every tag needs a key" : null;

  async function saveTags() {
    setBusy(true);
    setError(null);
    try {
      await smApi.setTags(
        id,
        tags.map((t) => [t.key.trim(), t.value]),
      );
      shell.showFlash("Tags saved.");
      onChanged();
      onClose();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function validate(): Promise<boolean | null> {
    if (!policy?.trim()) return null;
    try {
      const c = await smApi.validatePolicy(id, policy);
      setCheck(c);
      return c.valid;
    } catch (e) {
      setCheck({ unavailable: (e as AppError).message ?? String(e) });
      return null;
    }
  }

  async function savePolicy() {
    if (!policy?.trim()) return;
    const ok = await validate();
    if (ok === false) return;
    if (ok === null) {
      const go = await shell.ask(
        "Policy not validated",
        <>The policy couldn't be checked with ValidateResourcePolicy (some endpoints don't support it). Save it anyway?</>,
        [
          { label: "Save", value: "save", primary: true },
          { label: "Cancel", value: "cancel" },
        ],
        "cancel",
      );
      if (go !== "save") return;
    }
    setBusy(true);
    setError(null);
    try {
      await smApi.putPolicy(id, policy, blockPublic);
      shell.showFlash("Resource policy saved.");
      onChanged();
      onClose();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removePolicy() {
    const go = await shell.ask(
      "Delete resource policy",
      <>Remove the resource policy? Access then depends only on IAM policies.</>,
      [
        { label: "Delete", value: "delete", danger: true },
        { label: "Cancel", value: "cancel" },
      ],
      "cancel",
    );
    if (go !== "delete") return;
    setBusy(true);
    try {
      await smApi.deletePolicy(id);
      shell.showFlash("Resource policy deleted.");
      onChanged();
      onClose();
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog param-dialog settings-dialog" role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-title">
          Settings · <span className="mono">{secret.name}</span>
        </div>
        <div className="dialog-body">
          <div className="segmented small">
            <button className={tab === "tags" ? "active" : ""} onClick={() => setTab("tags")}>
              Tags
            </button>
            <button className={tab === "policy" ? "active" : ""} onClick={() => setTab("policy")}>
              Resource policy
            </button>
          </div>
          {tab === "tags" ? (
            <>
              <TagRows tags={tags} onChange={setTags} disabled={ro} />
              {tagProblem && <div className="field-error">{tagProblem}</div>}
            </>
          ) : policy === null ? (
            <div className="hint">Loading…</div>
          ) : (
            <>
              {!origPolicy && !policy && (
                <div className="row">
                  <span className="hint">No resource policy.</span>
                  <button className="link-btn" disabled={ro} onClick={() => setPolicy(TEMPLATE)}>
                    Start from an example
                  </button>
                </div>
              )}
              <ValueEditor
                value={policy}
                onChange={(v) => {
                  setPolicy(v);
                  setCheck(null);
                }}
                rows={14}
                disabled={ro}
              />
              <label className="check-row">
                <input type="checkbox" checked={blockPublic} onChange={(e) => setBlockPublic(e.target.checked)} /> Block policies that grant broad (public)
                access
              </label>
              {check &&
                ("unavailable" in check ? (
                  <div className="hint">Couldn't validate: {check.unavailable.split("(")[0]}</div>
                ) : check.valid ? (
                  <div className="ok-note">Policy is valid.</div>
                ) : (
                  <div className="field-error">
                    {check.errors.length ? check.errors.map((e, i) => <div key={i}>{e}</div>) : "Policy is not valid."}
                  </div>
                ))}
            </>
          )}
          {error && <div className="field-error">{error}</div>}
        </div>
        <div className="dialog-buttons">
          {tab === "policy" && (
            <>
              <button className="btn" disabled={busy || !policy?.trim()} onClick={() => void validate()}>
                Validate
              </button>
              <button className="btn" disabled={ro || busy || !origPolicy} onClick={() => void removePolicy()}>
                Delete policy…
              </button>
            </>
          )}
          <div className="spacer" />
          {tab === "tags" ? (
            <button className="btn primary" disabled={ro || busy || !tagsChanged || !!tagProblem} onClick={() => void saveTags()}>
              Save tags
            </button>
          ) : (
            <button className="btn primary" disabled={ro || busy || !policy?.trim() || policy === origPolicy} onClick={() => void savePolicy()}>
              Save policy
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
