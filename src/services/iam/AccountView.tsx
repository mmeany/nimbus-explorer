// The IAM account overview (view only): summary and quotas, password policy,
// the credential report and unused credentials worked out from it.
import { useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { api } from "../../api/s3";
import { iamAccountApi, limitRows, quotaRows, ROOT_USER, unusedCredentials, type AccountInfo, type CredentialReport, type CredentialRow, type KeyCredential } from "../../api/iam";
import { ErrorPanel } from "../../components/ErrorPanel";
import { HelpTopic } from "../../components/HelpDialog";
import { formatDate } from "../../format";
import type { HelpTopicId } from "../../help";
import { IAM_ROOT } from "../../shell/places";
import type { Shell } from "../../shell/shell";
import { PropsTable } from "../elasticache/CacheViews";
import { useDetails } from "./PrincipalViews";

type TabId = "summary" | "password" | "report" | "unused";
const TABS: [TabId, string, HelpTopicId][] = [
  ["summary", "Summary", "iam.account"],
  ["password", "Password policy", "iam.account.password"],
  ["report", "Credential report", "iam.credentialReport"],
  ["unused", "Unused credentials", "iam.unused"],
];

function storedNumber(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isInteger(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function storeNumber(key: string, n: number) {
  try {
    localStorage.setItem(key, String(n));
  } catch {
    /* convenience only */
  }
}

const yesNo = (b: boolean) => (b ? "Yes" : "No");

export function AccountView({ shell, accountId, reloadToken }: { shell: Shell; accountId: string | null; reloadToken: number }) {
  const { data, error, retry } = useDetails(`account|${reloadToken}`, () => iamAccountApi.account());
  const [tab, setTab] = useState<TabId>("summary");
  const [report, setReport] = useState<{ data: CredentialReport | null; error: AppError | null; loading: boolean }>({ data: null, error: null, loading: false });

  function loadReport(regenerate: boolean) {
    setReport((r) => ({ ...r, error: null, loading: true }));
    iamAccountApi
      .credentialReport(regenerate)
      .then((d) => setReport({ data: d, error: null, loading: false }))
      .catch((e) => setReport((r) => ({ ...r, error: e as AppError, loading: false })));
  }

  // The report is fetched (or generated) the first time a tab needs it, and again on Refresh.
  const needsReport = tab === "report" || tab === "unused";
  const [reportToken, setReportToken] = useState<number | null>(null);
  useEffect(() => {
    if (needsReport && reportToken !== reloadToken) {
      setReportToken(reloadToken);
      loadReport(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsReport, reloadToken]);

  async function exportReport() {
    const dest = await api.pickSaveAs("Export credential report", `credential-report${accountId ? `-${accountId}` : ""}.csv`);
    if (!dest) return;
    shell.setWorking("Exporting the credential report…");
    try {
      const n = await iamAccountApi.exportCredentialReport(dest);
      shell.showFlash(`Exported the credential report (${n.toLocaleString()} row${n === 1 ? "" : "s"}) to ${dest}.`);
    } catch (e) {
      shell.showError(e);
    } finally {
      shell.setWorking(null);
    }
  }

  const help = TABS.find((t) => t[0] === tab)![2];
  return (
    <div className="queue-view db-view">
      <div className="qv-head">
        <span className="qv-name">{data?.alias ?? (accountId ? `Account ${accountId}` : "Account")}</span>
        <span className="qbadge">Account</span>
        <div className="spacer" />
        {accountId && (
          <button className="link-btn" onClick={() => void shell.copyText(accountId)}>
            Copy account ID
          </button>
        )}
      </div>
      <HelpTopic id={help} />
      <div className="segmented small db-tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="lambda-details">
        {tab === "summary" || tab === "password" ? (
          error && !data ? (
            <ErrorPanel error={error} profile={shell.profile} onRetry={retry} />
          ) : !data ? (
            <div className="empty-note">Loading…</div>
          ) : tab === "summary" ? (
            <Summary info={data} accountId={accountId} />
          ) : (
            <Password info={data} />
          )
        ) : (
          <>
            <div className="row">
              <span className="hint">{report.loading ? "Getting the credential report (generating one can take a minute)…" : report.data?.generated ? `Report generated ${formatDate(report.data.generated)}` : ""}</span>
              <div className="spacer" />
              <button className="btn" disabled={report.loading} onClick={() => loadReport(true)} title="Ask AWS for a new report (AWS allows one every four hours; until then it returns the latest)">
                Generate new report
              </button>
              <button className="btn" disabled={report.loading || !report.data} onClick={() => void exportReport()}>
                Export CSV…
              </button>
            </div>
            {report.error && <ErrorPanel error={report.error} profile={shell.profile} onRetry={() => loadReport(false)} />}
            {report.data && (tab === "report" ? <ReportTable shell={shell} rows={report.data.rows} /> : <Unused shell={shell} rows={report.data.rows} />)}
          </>
        )}
      </div>
    </div>
  );
}

function summaryValue(info: AccountInfo, key: string): number | undefined {
  return info.summary.find(([k]) => k === key)?.[1];
}

function Summary({ info, accountId }: { info: AccountInfo; accountId: string | null }) {
  const rootMfa = summaryValue(info, "AccountMFAEnabled");
  const rootKeys = summaryValue(info, "AccountAccessKeysPresent");
  const rootCerts = summaryValue(info, "AccountSigningCertificatesPresent");
  const quotas = quotaRows(info.summary);
  const limits = limitRows(info.summary);
  return (
    <>
      <PropsTable
        rows={[
          ["Account ID", accountId ? <span className="mono">{accountId}</span> : "Unknown (no users, groups, roles or customer policies to read it from)"],
          ["Account alias", info.alias ?? "None (the sign-in URL uses the account ID)"],
          ["MFA devices", summaryValue(info, "MFADevices") === undefined ? null : `${summaryValue(info, "MFADevicesInUse") ?? 0} in use of ${summaryValue(info, "MFADevices")}`],
        ]}
      />
      <div className="props-section">Root user</div>
      <PropsTable
        rows={[
          ["MFA", rootMfa === undefined ? null : rootMfa ? "Enabled" : <span className="field-error">Not enabled: AWS strongly recommends MFA on the root user</span>],
          ["Access keys", rootKeys === undefined ? null : rootKeys ? <span className="field-error">Present: AWS recommends the root user has none</span> : "None"],
          ["Signing certificates", rootCerts === undefined ? null : rootCerts ? "Present" : "None"],
        ]}
      />
      <div className="props-section">Usage and quotas</div>
      <table className="sync-table">
        <thead>
          <tr>
            <th>Resource</th>
            <th>Used</th>
            <th>Quota</th>
            <th>Used %</th>
          </tr>
        </thead>
        <tbody>
          {quotas.map(([label, used, quota]) => {
            const pct = quota ? Math.round((used / quota) * 100) : 0;
            return (
              <tr key={label}>
                <td>{label}</td>
                <td>{used.toLocaleString()}</td>
                <td>{quota.toLocaleString()}</td>
                <td className={pct >= 80 ? "field-error" : ""}>{pct}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {limits.length > 0 && (
        <>
          <div className="props-section">Limits</div>
          <PropsTable rows={limits.map(([k, v]) => [k, v.toLocaleString()])} />
          <p className="hint">Sizes are in characters, excluding whitespace. Some quotas can be raised through Service Quotas.</p>
        </>
      )}
    </>
  );
}

function Password({ info }: { info: AccountInfo }) {
  const p = info.passwordPolicy;
  if (!p)
    return (
      <p className="hint">
        No password policy is set, so AWS's default applies: at least 8 characters with at least three of uppercase letters, lowercase letters, numbers and symbols, not the
        same as the account name or email address. Passwords don't expire.
      </p>
    );
  return (
    <PropsTable
      rows={[
        ["Minimum length", p.minLength === null ? null : `${p.minLength} characters`],
        ["Uppercase letter", yesNo(p.requireUppercase)],
        ["Lowercase letter", yesNo(p.requireLowercase)],
        ["Number", yesNo(p.requireNumbers)],
        ["Symbol", yesNo(p.requireSymbols)],
        ["Users can change their own password", yesNo(p.allowUsersToChange)],
        ["Passwords expire", p.expirePasswords && p.maxAgeDays ? `After ${p.maxAgeDays} days` : "No"],
        ["After expiry", p.expirePasswords ? (p.hardExpiry ? "An administrator must reset the password" : "The user chooses a new one at sign-in") : null],
        ["Reuse prevention", p.reusePrevention ? `The last ${p.reusePrevention} passwords` : "None"],
      ]}
    />
  );
}

function UserCell({ shell, user }: { shell: Shell; user: string }) {
  if (user === ROOT_USER) return <span>Root user</span>;
  return (
    <button className="link-btn" onClick={() => shell.navigate({ ...IAM_ROOT, kind: "users", id: user })}>
      {user}
    </button>
  );
}

function keyText(k: KeyCredential | undefined): string {
  if (!k) return "";
  return `${k.active ? "Active" : "Inactive"} · ${k.lastUsed ? `used ${formatDate(k.lastUsed)}${k.lastService ? ` (${k.lastService})` : ""}` : "never used"}`;
}

function ReportTable({ shell, rows }: { shell: Shell; rows: CredentialRow[] }) {
  return (
    <table className="sync-table">
      <thead>
        <tr>
          <th>User</th>
          <th>Password</th>
          <th>Password last used</th>
          <th>MFA</th>
          <th>Access key 1</th>
          <th>Access key 2</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.arn || r.user}>
            <td>
              <UserCell shell={shell} user={r.user} />
            </td>
            <td>{r.passwordEnabled === null ? "Root" : r.passwordEnabled ? "Enabled" : "None"}</td>
            <td>{r.passwordLastUsed ? formatDate(r.passwordLastUsed) : r.passwordEnabled !== false ? "Never / unknown" : ""}</td>
            <td className={!r.mfaActive && r.passwordEnabled !== false ? "field-error" : ""}>{r.mfaActive ? "Yes" : "No"}</td>
            <td>{keyText(r.keys.find((k) => k.slot === 1))}</td>
            <td>{keyText(r.keys.find((k) => k.slot === 2))}</td>
            <td>{formatDate(r.created)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Unused({ shell, rows }: { shell: Shell; rows: CredentialRow[] }) {
  const [days, setDays] = useState(() => storedNumber("iam.unused.days", 90));
  const [ageDays, setAgeDays] = useState(() => storedNumber("iam.unused.ageDays", 90));
  const findings = useMemo(() => unusedCredentials(rows, days, ageDays), [rows, days, ageDays]);
  const num = (v: number, set: (n: number) => void, key: string) => (
    <input
      className="text-input"
      type="number"
      min={1}
      max={3650}
      style={{ width: 70 }}
      value={v}
      onChange={(e) => {
        const n = Math.floor(Number(e.target.value));
        if (n > 0 && n <= 3650) {
          set(n);
          storeNumber(key, n);
        }
      }}
    />
  );
  return (
    <>
      <div className="row">
        <span className="hint">Not used for more than</span>
        {num(days, setDays, "iam.unused.days")}
        <span className="hint">days; access keys not rotated for more than</span>
        {num(ageDays, setAgeDays, "iam.unused.ageDays")}
        <span className="hint">days</span>
      </div>
      {findings.length === 0 ? (
        <p className="hint">Nothing found: every console password and active access key has been used and rotated within those limits.</p>
      ) : (
        <table className="sync-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Credential</th>
              <th>Finding</th>
              <th>Last used</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((f, i) => (
              <tr key={i}>
                <td>
                  <UserCell shell={shell} user={f.user} />
                </td>
                <td>{f.credential}</td>
                <td>{f.kind === "never" && f.days !== null ? `Never used (created ${f.days} day${f.days === 1 ? "" : "s"} ago)` : f.issue}</td>
                <td>{f.lastUsed ? formatDate(f.lastUsed) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">From the credential report, which AWS refreshes at most every four hours. Inactive access keys are left out: they can't be used.</p>
    </>
  );
}
