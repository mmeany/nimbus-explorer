import { useEffect, useRef, useState } from "react";
import type { ConnectionOverride, ProfileInfo } from "../api/s3";

interface Props {
  profile: ProfileInfo;
  current: ConnectionOverride | null;
  onSave: (value: ConnectionOverride | null) => void;
  onCancel: () => void;
}

type PathMode = "auto" | "on" | "off";

/** Per-profile endpoint / addressing override, stored in app settings. */
export function ConnectionDialog({ profile, current, onSave, onCancel }: Props) {
  const [endpoint, setEndpoint] = useState(current?.endpointUrl ?? "");
  const [pathMode, setPathMode] = useState<PathMode>(
    current?.pathStyle == null ? "auto" : current.pathStyle ? "on" : "off",
  );
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  function save() {
    const ep = endpoint.trim();
    if (ep) {
      try {
        const u = new URL(ep);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
      } catch {
        setError("Enter a full URL such as http://localhost:4566");
        return;
      }
    }
    const value: ConnectionOverride = {
      endpointUrl: ep || null,
      pathStyle: pathMode === "auto" ? null : pathMode === "on",
    };
    onSave(value.endpointUrl === null && value.pathStyle === null ? null : value);
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal
        aria-labelledby="conn-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter") save();
        }}
      >
        <div className="dialog-title" id="conn-title">
          Connection settings: {profile.name}
        </div>
        <div className="dialog-body">
          <label className="form-label" htmlFor="ep">
            Endpoint URL
          </label>
          <input
            id="ep"
            ref={inputRef}
            className="text-input"
            placeholder={profile.endpointUrl ?? "Leave blank for real AWS"}
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e.target.value);
              setError(null);
            }}
          />
          <div className="hint">
            {profile.endpointUrl
              ? `Leave blank to use the profile's endpoint_url (${profile.endpointUrl}).`
              : "Leave blank to use real AWS. For LocalStack use http://localhost:4566."}
          </div>
          {error && <div className="field-error">{error}</div>}

          <fieldset className="radio-group">
            <legend>Addressing style</legend>
            {(
              [
                ["auto", "Automatic (path-style for custom endpoints)"],
                ["on", "Path-style (endpoint/bucket/key)"],
                ["off", "Virtual-hosted (bucket.endpoint/key)"],
              ] as const
            ).map(([v, label]) => (
              <label key={v}>
                <input type="radio" name="pathmode" checked={pathMode === v} onChange={() => setPathMode(v)} /> {label}
              </label>
            ))}
          </fieldset>
        </div>
        <div className="dialog-buttons">
          <button className="btn" onClick={() => onSave(null)} title="Remove the override for this profile">
            Reset
          </button>
          <div className="spacer" />
          <button className="btn primary" onClick={save}>
            OK
          </button>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
