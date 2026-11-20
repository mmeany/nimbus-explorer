//! IAM account overview (view only): alias, GetAccountSummary (usage and
//! quotas), password policy, and the credential report. Generating a
//! credential report changes no configuration, so it's allowed in read-only
//! mode; exporting it is a local write.

use crate::error::{AppError, ErrorKind};
use crate::iam::{client, err, iso};
use crate::s3::Connection;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PasswordPolicy {
    pub min_length: Option<i32>,
    pub require_symbols: bool,
    pub require_numbers: bool,
    pub require_uppercase: bool,
    pub require_lowercase: bool,
    pub allow_users_to_change: bool,
    pub expire_passwords: bool,
    pub max_age_days: Option<i32>,
    pub reuse_prevention: Option<i32>,
    pub hard_expiry: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub alias: Option<String>,
    /// GetAccountSummary's map, sorted by key.
    pub summary: Vec<(String, i64)>,
    /// None when the account has no password policy (AWS defaults apply).
    pub password_policy: Option<PasswordPolicy>,
}

fn no_such_entity(e: &impl std::error::Error) -> bool {
    aws_smithy_types::error::display::DisplayErrorContext(e)
        .to_string()
        .contains("NoSuchEntity")
}

pub async fn account(conn: &Connection) -> Result<AccountInfo, AppError> {
    let c = client(conn);
    let aliases = c
        .list_account_aliases()
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let summary = c
        .get_account_summary()
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let mut map: Vec<(String, i64)> = summary
        .summary_map()
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.as_str().to_string(), i64::from(*v)))
                .collect()
        })
        .unwrap_or_default();
    map.sort();
    let password_policy = match c.get_account_password_policy().send().await {
        Ok(o) => o.password_policy().map(|p| PasswordPolicy {
            min_length: p.minimum_password_length(),
            require_symbols: p.require_symbols(),
            require_numbers: p.require_numbers(),
            require_uppercase: p.require_uppercase_characters(),
            require_lowercase: p.require_lowercase_characters(),
            allow_users_to_change: p.allow_users_to_change_password(),
            expire_passwords: p.expire_passwords(),
            max_age_days: p.max_password_age(),
            reuse_prevention: p.password_reuse_prevention(),
            hard_expiry: p.hard_expiry(),
        }),
        Err(e) if no_such_entity(&e) => None,
        Err(e) => return Err(err(conn, e)),
    };
    Ok(AccountInfo {
        alias: aliases.account_aliases().first().cloned(),
        summary: map,
        password_policy,
    })
}

// ---------------------------------------------------------------------------
// Credential report

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyCredential {
    /// 1 or 2: a user has at most two access keys.
    pub slot: u8,
    pub active: bool,
    pub last_rotated: Option<String>,
    pub last_used: Option<String>,
    pub last_region: Option<String>,
    pub last_service: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRow {
    /// "<root_account>" for the root user.
    pub user: String,
    pub arn: String,
    pub created: Option<String>,
    /// None for the root user (AWS reports "not_supported").
    pub password_enabled: Option<bool>,
    pub password_last_used: Option<String>,
    pub password_last_changed: Option<String>,
    pub password_next_rotation: Option<String>,
    pub mfa_active: bool,
    /// Only the keys that exist.
    pub keys: Vec<KeyCredential>,
    pub certificates_active: u8,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CredentialReport {
    pub generated: Option<String>,
    pub rows: Vec<CredentialRow>,
}

/// RFC 4180 CSV (the report doesn't quote today, but may).
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if quoted {
            match ch {
                '"' if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                '"' => quoted = false,
                _ => field.push(ch),
            }
            continue;
        }
        match ch {
            '"' => quoted = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(ch),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// A report value, or None for "N/A", "no_information", "not_supported" and "".
fn value(s: Option<&String>) -> Option<String> {
    s.filter(|v| !matches!(v.as_str(), "" | "N/A" | "no_information" | "not_supported"))
        .cloned()
}

pub fn parse_report(text: &str) -> Vec<CredentialRow> {
    let rows = parse_csv(text);
    let Some((head, body)) = rows.split_first() else {
        return Vec::new();
    };
    let col: HashMap<&str, usize> = head
        .iter()
        .enumerate()
        .map(|(i, h)| (h.as_str(), i))
        .collect();
    body.iter()
        .filter(|r| r.iter().any(|f| !f.is_empty()))
        .map(|r| {
            let get = |name: &str| col.get(name).and_then(|&i| r.get(i));
            let yes = |name: &str| get(name).map(|v| v == "true").unwrap_or(false);
            let keys = (1u8..=2)
                .filter_map(|n| {
                    let k = |f: &str| format!("access_key_{n}_{f}");
                    let key = KeyCredential {
                        slot: n,
                        active: yes(&k("active")),
                        last_rotated: value(get(&k("last_rotated"))),
                        last_used: value(get(&k("last_used_date"))),
                        last_region: value(get(&k("last_used_region"))),
                        last_service: value(get(&k("last_used_service"))),
                    };
                    (key.active || key.last_rotated.is_some()).then_some(key)
                })
                .collect();
            CredentialRow {
                user: get("user").cloned().unwrap_or_default(),
                arn: get("arn").cloned().unwrap_or_default(),
                created: value(get("user_creation_time")),
                password_enabled: match get("password_enabled").map(String::as_str) {
                    Some("true") => Some(true),
                    Some("false") => Some(false),
                    _ => None,
                },
                password_last_used: value(get("password_last_used")),
                password_last_changed: value(get("password_last_changed")),
                password_next_rotation: value(get("password_next_rotation")),
                mfa_active: yes("mfa_active"),
                keys,
                certificates_active: u8::from(yes("cert_1_active"))
                    + u8::from(yes("cert_2_active")),
            }
        })
        .collect()
}

/// Asks AWS to build a report and waits until it's ready (about a minute at most).
async fn generate(conn: &Connection) -> Result<(), AppError> {
    let c = client(conn);
    for _ in 0..40 {
        let o = c
            .generate_credential_report()
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        if o.state().map(|s| s.as_str()) == Some("COMPLETE") {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    }
    Err(AppError::new(
        ErrorKind::Other,
        "The credential report is still being generated. Try again in a minute.",
    ))
}

/// The latest report: CSV text and when AWS generated it.
async fn fetch(conn: &Connection, regenerate: bool) -> Result<(String, Option<String>), AppError> {
    let c = client(conn);
    if regenerate {
        generate(conn).await?;
    }
    for attempt in 0..2 {
        match c.get_credential_report().send().await {
            Ok(o) => {
                let text = o
                    .content()
                    .map(|b| String::from_utf8_lossy(b.as_ref()).into_owned())
                    .unwrap_or_default();
                return Ok((text, iso(o.generated_time())));
            }
            Err(e) => {
                let detail = aws_smithy_types::error::display::DisplayErrorContext(&e).to_string();
                let missing = ["ReportNotPresent", "ReportExpired", "ReportInProgress"]
                    .iter()
                    .any(|k| detail.contains(k));
                if !missing || attempt == 1 {
                    return Err(err(conn, e));
                }
                generate(conn).await?;
            }
        }
    }
    unreachable!()
}

/// The latest credential report, generating one if there's none (AWS keeps
/// one for four hours) or `regenerate` is set.
pub async fn credential_report(
    conn: &Connection,
    regenerate: bool,
) -> Result<CredentialReport, AppError> {
    let (text, generated) = fetch(conn, regenerate).await?;
    Ok(CredentialReport {
        generated,
        rows: parse_report(&text),
    })
}

/// Saves the latest report's CSV as AWS sends it; returns the number of users.
pub async fn export_report(conn: &Connection, dest: &str) -> Result<usize, AppError> {
    let (text, _) = fetch(conn, false).await?;
    let part = format!("{dest}.s3x-part");
    let fail =
        |e: std::io::Error| AppError::new(ErrorKind::Other, format!("Couldn't save {dest}: {e}"));
    tokio::fs::write(&part, &text).await.map_err(fail)?;
    if let Err(e) = tokio::fs::rename(&part, dest).await {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(fail(e));
    }
    Ok(parse_report(&text).len())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPORT: &str = "user,arn,user_creation_time,password_enabled,password_last_used,password_last_changed,password_next_rotation,mfa_active,access_key_1_active,access_key_1_last_rotated,access_key_1_last_used_date,access_key_1_last_used_region,access_key_1_last_used_service,access_key_2_active,access_key_2_last_rotated,access_key_2_last_used_date,access_key_2_last_used_region,access_key_2_last_used_service,cert_1_active,cert_1_last_rotated,cert_2_active,cert_2_last_rotated\n\
<root_account>,arn:aws:iam::123456789012:root,2020-01-01T00:00:00+00:00,not_supported,2026-11-01T10:00:00+00:00,not_supported,not_supported,true,false,N/A,N/A,N/A,N/A,false,N/A,N/A,N/A,N/A,false,N/A,false,N/A\n\
alice,arn:aws:iam::123456789012:user/alice,2024-01-01T00:00:00+00:00,true,no_information,2024-01-02T00:00:00+00:00,N/A,false,true,2024-01-01T00:00:00+00:00,2026-11-18T08:00:00+00:00,eu-west-2,s3,false,2025-01-01T00:00:00+00:00,N/A,N/A,N/A,true,2024-01-01T00:00:00+00:00,false,N/A\r\n";

    #[test]
    fn parses_csv_with_quotes() {
        assert_eq!(
            parse_csv("a,\"b,c\",\"d\"\"e\"\n1,2,3"),
            vec![vec!["a", "b,c", "d\"e"], vec!["1", "2", "3"]]
        );
        assert!(parse_csv("").is_empty());
    }

    #[test]
    fn parses_credential_reports() {
        let r = parse_report(REPORT);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].user, "<root_account>");
        assert_eq!(r[0].password_enabled, None);
        assert!(r[0].mfa_active);
        assert!(r[0].keys.is_empty());
        let a = &r[1];
        assert_eq!(a.password_enabled, Some(true));
        assert_eq!(a.password_last_used, None);
        assert_eq!(a.keys.len(), 2);
        assert!(a.keys[0].active);
        assert_eq!(a.keys[0].last_service.as_deref(), Some("s3"));
        assert!(!a.keys[1].active);
        assert_eq!(a.keys[1].last_used, None);
        assert_eq!(a.certificates_active, 1);
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn reads_account_and_credential_report() {
        let conn = crate::sqs::emulator_tests::connect().await;
        let a = account(&conn).await.unwrap();
        assert!(a.summary.iter().any(|(k, _)| k == "UsersQuota"));
        let _ = client(&conn)
            .create_user()
            .user_name("s3x-iam-user")
            .send()
            .await;
        let r = credential_report(&conn, true).await.unwrap();
        assert!(
            r.rows.iter().any(|u| u.user == "s3x-iam-user"),
            "{:?}",
            r.rows
        );
        let r2 = credential_report(&conn, false).await.unwrap();
        assert_eq!(r.rows.len(), r2.rows.len());
    }
}
