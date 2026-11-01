import { useState } from "react";
import type { AppError } from "../api/s3";

interface Props {
  error: AppError;
  profile: string | null;
  onRetry: () => void;
}

const TITLES: Record<AppError["kind"], string> = {
  notConnected: "Not connected",
  ssoExpired: "SSO login required",
  noCredentials: "No valid credentials",
  unreachable: "Can't connect",
  accessDenied: "Access denied",
  readOnly: "Read-only mode",
  other: "Something went wrong",
};

export function ErrorPanel({ error, profile, onRetry }: Props) {
  const [copied, setCopied] = useState(false);
  const loginCmd = profile ? `aws sso login --profile ${profile}` : "aws sso login";

  return (
    <div className="error-panel" role="alert">
      <div className="error-title">⚠ {TITLES[error.kind]}</div>
      <p>{error.message}</p>
      {error.kind === "ssoExpired" && (
        <div className="cmd-box">
          <code>{loginCmd}</code>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(loginCmd);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                /* clipboard unavailable: user can still select the text */
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      <div className="error-actions">
        <button className="btn primary" onClick={onRetry}>
          Retry
        </button>
      </div>
      {error.detail && error.detail !== error.message && (
        <details>
          <summary>Details</summary>
          <pre>{error.detail}</pre>
        </details>
      )}
    </div>
  );
}

export function NoProfilesPanel({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="error-panel">
      <div className="error-title">No AWS profiles found</div>
      <p>
        Add a profile to <code>%USERPROFILE%\.aws\config</code> (or <code>~/.aws/config</code>), for example with{" "}
        <code>aws configure --profile myprofile</code>. For LocalStack:
      </p>
      <pre>{`# ~/.aws/config
[profile localstack]
region = us-east-1
endpoint_url = http://localhost:4566

# ~/.aws/credentials
[localstack]
aws_access_key_id = test
aws_secret_access_key = test`}</pre>
      <div className="error-actions">
        <button className="btn primary" onClick={onRetry}>
          Reload profiles
        </button>
      </div>
    </div>
  );
}
