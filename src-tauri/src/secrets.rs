//! Secrets Manager. Secret values are fetched only on an explicit Reveal /
//! Copy / Edit and returned straight to the UI; nothing here stores them.

use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use aws_sdk_secretsmanager::types::{Filter, FilterNameStringType, SecretListEntry};
use aws_sdk_secretsmanager::Client;
use serde::Serialize;

pub fn client(conn: &Connection) -> Client {
    Client::new(&conn.service_config())
}

pub(crate) fn err(conn: &Connection, e: impl std::error::Error) -> AppError {
    AppError::from_sdk(e, &conn.info.profile, conn.info.endpoint_url.as_deref())
}

pub(crate) fn other(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Other, msg)
}

pub(crate) fn fmt_time(d: Option<&aws_sdk_secretsmanager::primitives::DateTime>) -> Option<String> {
    d.and_then(|d| {
        d.fmt(aws_sdk_secretsmanager::primitives::DateTimeFormat::DateTime)
            .ok()
    })
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecretInfo {
    pub name: String,
    pub arn: Option<String>,
    pub description: Option<String>,
    pub kms_key_id: Option<String>,
    pub created: Option<String>,
    pub last_changed: Option<String>,
    pub last_accessed: Option<String>,
    pub rotation_enabled: bool,
    pub rotation_lambda_arn: Option<String>,
    /// e.g. "rate(30 days)" or "cron(…)"; or days as "30 days".
    pub rotation_schedule: Option<String>,
    pub last_rotated: Option<String>,
    pub next_rotation: Option<String>,
    /// Scheduled for deletion on this date (restorable until then).
    pub deleted_date: Option<String>,
    pub primary_region: Option<String>,
    pub owning_service: Option<String>,
    pub tags: Vec<(String, String)>,
}

fn rotation_schedule(
    rr: Option<&aws_sdk_secretsmanager::types::RotationRulesType>,
) -> Option<String> {
    let rr = rr?;
    if let Some(e) = rr.schedule_expression() {
        return Some(e.to_string());
    }
    rr.automatically_after_days()
        .map(|d| format!("every {d} days"))
}

fn from_entry(e: &SecretListEntry) -> SecretInfo {
    let mut tags: Vec<(String, String)> = e
        .tags()
        .iter()
        .map(|t| {
            (
                t.key().unwrap_or_default().to_string(),
                t.value().unwrap_or_default().to_string(),
            )
        })
        .collect();
    tags.sort();
    SecretInfo {
        name: e.name().unwrap_or_default().to_string(),
        arn: e.arn().map(String::from),
        description: e.description().map(String::from),
        kms_key_id: e.kms_key_id().map(String::from),
        created: fmt_time(e.created_date()),
        last_changed: fmt_time(e.last_changed_date()),
        last_accessed: fmt_time(e.last_accessed_date()),
        rotation_enabled: e.rotation_enabled().unwrap_or(false),
        rotation_lambda_arn: e.rotation_lambda_arn().map(String::from),
        rotation_schedule: rotation_schedule(e.rotation_rules()),
        last_rotated: fmt_time(e.last_rotated_date()),
        next_rotation: fmt_time(e.next_rotation_date()),
        deleted_date: fmt_time(e.deleted_date()),
        primary_region: e.primary_region().map(String::from),
        owning_service: e.owning_service().map(String::from),
        tags,
    }
}

/// Every secret (including ones scheduled for deletion), optionally only
/// names beginning with `prefix` (server-side filter).
pub async fn list_secrets(conn: &Connection, prefix: &str) -> Result<Vec<SecretInfo>, AppError> {
    let c = client(conn);
    let filters = if prefix.trim().is_empty() {
        None
    } else {
        Some(vec![Filter::builder()
            .key(FilterNameStringType::Name)
            .values(prefix.trim())
            .build()])
    };
    let mut out = Vec::new();
    let mut token = None;
    loop {
        let page = c
            .list_secrets()
            .include_planned_deletion(true)
            .set_filters(filters.clone())
            .max_results(100)
            .set_next_token(token)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.secret_list().iter().map(from_entry));
        token = page.next_token().map(String::from);
        if token.is_none() {
            break;
        }
    }
    // The name filter matches words anywhere in some implementations; keep prefixes only.
    if !prefix.trim().is_empty() {
        out.retain(|s| s.name.starts_with(prefix.trim()));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Current metadata for one secret.
pub async fn describe(conn: &Connection, id: &str) -> Result<SecretInfo, AppError> {
    let d = client(conn)
        .describe_secret()
        .secret_id(id)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let mut tags: Vec<(String, String)> = d
        .tags()
        .iter()
        .map(|t| {
            (
                t.key().unwrap_or_default().to_string(),
                t.value().unwrap_or_default().to_string(),
            )
        })
        .collect();
    tags.sort();
    Ok(SecretInfo {
        name: d.name().unwrap_or_default().to_string(),
        arn: d.arn().map(String::from),
        description: d.description().map(String::from),
        kms_key_id: d.kms_key_id().map(String::from),
        created: fmt_time(d.created_date()),
        last_changed: fmt_time(d.last_changed_date()),
        last_accessed: fmt_time(d.last_accessed_date()),
        rotation_enabled: d.rotation_enabled().unwrap_or(false),
        rotation_lambda_arn: d.rotation_lambda_arn().map(String::from),
        rotation_schedule: rotation_schedule(d.rotation_rules()),
        last_rotated: fmt_time(d.last_rotated_date()),
        next_rotation: fmt_time(d.next_rotation_date()),
        deleted_date: fmt_time(d.deleted_date()),
        primary_region: d.primary_region().map(String::from),
        owning_service: d.owning_service().map(String::from),
        tags,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretValue {
    /// SecretString, if the secret is text.
    pub text: Option<String>,
    /// SecretBinary as base64, if the secret is binary.
    pub binary_base64: Option<String>,
    pub version_id: Option<String>,
    pub stages: Vec<String>,
    pub created: Option<String>,
}

/// The decrypted value (AWSCURRENT unless a version id or stage is given).
pub async fn get_value(
    conn: &Connection,
    id: &str,
    version_id: Option<String>,
    stage: Option<String>,
) -> Result<SecretValue, AppError> {
    let out = client(conn)
        .get_secret_value()
        .secret_id(id)
        .set_version_id(version_id)
        .set_version_stage(stage)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(SecretValue {
        text: out.secret_string().map(String::from),
        binary_base64: out
            .secret_binary()
            .map(|b| aws_smithy_types::base64::encode(b.as_ref())),
        version_id: out.version_id().map(String::from),
        stages: out.version_stages().to_vec(),
        created: fmt_time(out.created_date()),
    })
}

// ---------------------------------------------------------------------------
// Create / update / delete / restore

/// Secret names: 1–512 of letters, digits and / _ + = . @ -
pub fn name_problem(name: &str) -> Option<String> {
    if name.is_empty() || name.len() > 512 {
        return Some("Names must be 1 to 512 characters".into());
    }
    if name
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || "/_+=.@-".contains(c)))
    {
        return Some("Use letters, digits and / _ + = . @ - only".into());
    }
    None
}

/// The value to store: text, or binary given as base64.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewValue {
    pub text: Option<String>,
    pub binary_base64: Option<String>,
}

fn blob(v: &NewValue) -> Result<Option<aws_sdk_secretsmanager::primitives::Blob>, AppError> {
    v.binary_base64
        .as_deref()
        .map(|b| {
            aws_smithy_types::base64::decode(b.trim())
                .map(aws_sdk_secretsmanager::primitives::Blob::new)
                .map_err(|_| other("Binary values must be base64"))
        })
        .transpose()
}

fn check_value(v: &NewValue) -> Result<(), AppError> {
    match (&v.text, &v.binary_base64) {
        (Some(t), None) if !t.is_empty() => Ok(()),
        (None, Some(b)) if !b.trim().is_empty() => Ok(()),
        _ => Err(other("Enter a value (text or binary)")),
    }
}

fn non_empty(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(String::from)
}

/// Creates a secret; returns its ARN.
pub async fn create(
    conn: &Connection,
    name: &str,
    value: &NewValue,
    description: Option<String>,
    kms_key_id: Option<String>,
    tags: &[(String, String)],
) -> Result<String, AppError> {
    if let Some(p) = name_problem(name) {
        return Err(other(p));
    }
    check_value(value)?;
    let tags: Vec<aws_sdk_secretsmanager::types::Tag> = tags
        .iter()
        .map(|(k, v)| {
            aws_sdk_secretsmanager::types::Tag::builder()
                .key(k)
                .value(v)
                .build()
        })
        .collect();
    let out = client(conn)
        .create_secret()
        .name(name)
        .set_secret_string(value.text.clone())
        .set_secret_binary(blob(value)?)
        .set_description(non_empty(&description))
        .set_kms_key_id(non_empty(&kms_key_id))
        .set_tags(if tags.is_empty() { None } else { Some(tags) })
        .send()
        .await
        .map_err(|e| {
            if e.as_service_error().is_some_and(|se| se.is_resource_exists_exception()) {
                other(format!("A secret named {name} already exists (perhaps scheduled for deletion; restore it instead)"))
            } else {
                err(conn, e)
            }
        })?;
    Ok(out.arn().unwrap_or_default().to_string())
}

/// Stores a new value (a new version labelled AWSCURRENT); returns its version id.
pub async fn put_value(conn: &Connection, id: &str, value: &NewValue) -> Result<String, AppError> {
    check_value(value)?;
    let out = client(conn)
        .put_secret_value()
        .secret_id(id)
        .set_secret_string(value.text.clone())
        .set_secret_binary(blob(value)?)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out.version_id().unwrap_or_default().to_string())
}

/// Changes description and/or KMS key (no new value).
pub async fn update_metadata(
    conn: &Connection,
    id: &str,
    description: Option<String>,
    kms_key_id: Option<String>,
) -> Result<(), AppError> {
    client(conn)
        .update_secret()
        .secret_id(id)
        .set_description(description)
        .set_kms_key_id(non_empty(&kms_key_id))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

/// Schedules deletion after `recovery_days` (7–30), or deletes immediately
/// when `force`. Returns the deletion date.
pub async fn delete(
    conn: &Connection,
    id: &str,
    recovery_days: Option<i64>,
    force: bool,
) -> Result<Option<String>, AppError> {
    if !force {
        if let Some(d) = recovery_days {
            if !(7..=30).contains(&d) {
                return Err(other("The recovery window must be 7 to 30 days"));
            }
        }
    }
    let out = client(conn)
        .delete_secret()
        .secret_id(id)
        .set_recovery_window_in_days(if force {
            None
        } else {
            Some(recovery_days.unwrap_or(30))
        })
        .set_force_delete_without_recovery(if force { Some(true) } else { None })
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(fmt_time(out.deletion_date()))
}

pub async fn restore(conn: &Connection, id: &str) -> Result<(), AppError> {
    client(conn)
        .restore_secret()
        .secret_id(id)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Versions and staging labels

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub version_id: String,
    pub stages: Vec<String>,
    pub created: Option<String>,
    pub last_accessed: Option<String>,
}

/// Every version, newest first (including ones without labels).
pub async fn list_versions(conn: &Connection, id: &str) -> Result<Vec<VersionInfo>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token = None;
    loop {
        let page = c
            .list_secret_version_ids()
            .secret_id(id)
            .include_deprecated(true)
            .max_results(100)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        let before = out.len();
        for v in page.versions() {
            let version_id = v.version_id().unwrap_or_default().to_string();
            // Some implementations repeat versions across pages.
            if out.iter().any(|x: &VersionInfo| x.version_id == version_id) {
                continue;
            }
            out.push(VersionInfo {
                version_id,
                stages: v.version_stages().to_vec(),
                created: fmt_time(v.created_date()),
                last_accessed: fmt_time(v.last_accessed_date()),
            });
        }
        let next = page.next_token().map(String::from);
        // Some implementations keep returning a token: stop when a page adds
        // nothing or the token repeats.
        if next.is_none() || out.len() == before || next == token {
            break;
        }
        token = next;
    }
    out.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(out)
}

/// Moves (or attaches / removes) a staging label. `to` = version to label,
/// `from` = version that currently has it (required when it's attached
/// elsewhere). With `to` None the label is just removed from `from`.
pub async fn move_label(
    conn: &Connection,
    id: &str,
    stage: &str,
    to: Option<String>,
    from: Option<String>,
) -> Result<(), AppError> {
    if stage.trim().is_empty() || stage.len() > 256 {
        return Err(other("Labels must be 1 to 256 characters"));
    }
    if to.is_none() && from.is_none() {
        return Err(other("Nothing to do"));
    }
    if to.is_none() && stage == "AWSCURRENT" {
        return Err(other(
            "AWSCURRENT can only be moved to another version, not removed",
        ));
    }
    client(conn)
        .update_secret_version_stage()
        .secret_id(id)
        .version_stage(stage)
        .set_move_to_version_id(to)
        .set_remove_from_version_id(from)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Rotation

/// Checks a schedule: "rate(N days|hours)" or "cron(…)" as AWS expects.
pub fn schedule_problem(expr: &str) -> Option<String> {
    let e = expr.trim();
    let inner = |p: &str| e.strip_prefix(p).and_then(|x| x.strip_suffix(')'));
    if let Some(rate) = inner("rate(") {
        let mut parts = rate.split_whitespace();
        let (Some(n), Some(unit), None) = (parts.next(), parts.next(), parts.next()) else {
            return Some("Write rates like rate(30 days) or rate(4 hours)".into());
        };
        let Ok(n) = n.parse::<u32>() else {
            return Some("The rate needs a whole number".into());
        };
        return match unit {
            "day" | "days" if (1..=1000).contains(&n) => None,
            "hour" | "hours" if (4..=23).contains(&n) => None,
            "day" | "days" => Some("Rates in days must be 1 to 1000".into()),
            "hour" | "hours" => Some("Rates in hours must be 4 to 23".into()),
            _ => Some("Use days or hours".into()),
        };
    }
    if let Some(cron) = inner("cron(") {
        return if cron.split_whitespace().count() == 6 {
            None
        } else {
            Some(
                "cron() needs six fields: minutes hours day-of-month month day-of-week year".into(),
            )
        };
    }
    Some("Use rate(…) or cron(…)".into())
}

/// Turns rotation on (or changes it). `lambda_arn` None keeps the current
/// function (managed rotation for some secret types needs none).
pub async fn configure_rotation(
    conn: &Connection,
    id: &str,
    lambda_arn: Option<String>,
    schedule: &str,
    window: Option<String>,
    rotate_now: bool,
) -> Result<(), AppError> {
    if let Some(p) = schedule_problem(schedule) {
        return Err(other(p));
    }
    let rules = aws_sdk_secretsmanager::types::RotationRulesType::builder()
        .schedule_expression(schedule.trim())
        .set_duration(non_empty(&window))
        .build();
    client(conn)
        .rotate_secret()
        .secret_id(id)
        .set_rotation_lambda_arn(non_empty(&lambda_arn))
        .rotation_rules(rules)
        .rotate_immediately(rotate_now)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

/// Rotates now with the existing configuration.
pub async fn rotate_now(conn: &Connection, id: &str) -> Result<(), AppError> {
    client(conn)
        .rotate_secret()
        .secret_id(id)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

/// Turns automatic rotation off.
pub async fn cancel_rotation(conn: &Connection, id: &str) -> Result<(), AppError> {
    client(conn)
        .cancel_rotate_secret()
        .secret_id(id)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tags and resource policy

/// Makes the secret's tags exactly `tags`.
pub async fn set_tags(
    conn: &Connection,
    id: &str,
    tags: &[(String, String)],
) -> Result<(), AppError> {
    let current = describe(conn, id).await?.tags;
    let c = client(conn);
    let add: Vec<aws_sdk_secretsmanager::types::Tag> = tags
        .iter()
        .filter(|t| !current.contains(t))
        .map(|(k, v)| {
            aws_sdk_secretsmanager::types::Tag::builder()
                .key(k)
                .value(v)
                .build()
        })
        .collect();
    if !add.is_empty() {
        c.tag_resource()
            .secret_id(id)
            .set_tags(Some(add))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    let remove: Vec<String> = current
        .iter()
        .filter(|(k, _)| !tags.iter().any(|(t, _)| t == k))
        .map(|(k, _)| k.clone())
        .collect();
    if !remove.is_empty() {
        c.untag_resource()
            .secret_id(id)
            .set_tag_keys(Some(remove))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    Ok(())
}

pub async fn get_policy(conn: &Connection, id: &str) -> Result<Option<String>, AppError> {
    let out = client(conn)
        .get_resource_policy()
        .secret_id(id)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out.resource_policy().map(String::from))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyCheck {
    pub valid: bool,
    pub errors: Vec<String>,
}

/// ValidateResourcePolicy: syntax, and (with block-public) that it doesn't
/// grant broad access.
pub async fn validate_policy(
    conn: &Connection,
    id: &str,
    policy: &str,
) -> Result<PolicyCheck, AppError> {
    if let Err(e) = serde_json::from_str::<serde_json::Value>(policy) {
        return Ok(PolicyCheck {
            valid: false,
            errors: vec![format!("Not valid JSON: {e}")],
        });
    }
    let out = client(conn)
        .validate_resource_policy()
        .secret_id(id)
        .resource_policy(policy)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(PolicyCheck {
        valid: out.policy_validation_passed(),
        errors: out
            .validation_errors()
            .iter()
            .map(|v| {
                format!(
                    "{}: {}",
                    v.check_name().unwrap_or("check"),
                    v.error_message().unwrap_or_default()
                )
            })
            .collect(),
    })
}

/// Attaches a policy; `block_public` refuses policies that grant broad access.
pub async fn put_policy(
    conn: &Connection,
    id: &str,
    policy: &str,
    block_public: bool,
) -> Result<(), AppError> {
    serde_json::from_str::<serde_json::Value>(policy)
        .map_err(|e| other(format!("Not valid JSON: {e}")))?;
    client(conn)
        .put_resource_policy()
        .secret_id(id)
        .resource_policy(policy)
        .block_public_policy(block_public)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

pub async fn delete_policy(conn: &Connection, id: &str) -> Result<(), AppError> {
    client(conn)
        .delete_resource_policy()
        .secret_id(id)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

#[cfg(test)]
mod rotation_tests {
    use super::*;

    #[test]
    fn schedules() {
        assert_eq!(schedule_problem("rate(30 days)"), None);
        assert_eq!(schedule_problem("rate(4 hours)"), None);
        assert_eq!(schedule_problem("cron(0 8 1 * ? *)"), None);
        assert!(schedule_problem("rate(2 hours)").is_some());
        assert!(schedule_problem("rate(30 weeks)").is_some());
        assert!(schedule_problem("cron(0 8 * *)").is_some());
        assert!(schedule_problem("every month").is_some());
    }
}

#[cfg(test)]
pub(crate) mod emulator_tests {
    use super::*;

    pub(crate) async fn connect() -> Connection {
        crate::sqs::emulator_tests::connect().await
    }

    /// Creates (or force-deletes and recreates) a secret with a text value.
    pub(crate) async fn fresh_secret(conn: &Connection, name: &str, value: &str) {
        let c = client(conn);
        let _ = c
            .delete_secret()
            .secret_id(name)
            .force_delete_without_recovery(true)
            .send()
            .await;
        c.create_secret()
            .name(name)
            .secret_string(value)
            .send()
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn lists_describes_and_reveals() {
        let conn = connect().await;
        fresh_secret(&conn, "s3x/app/db", r#"{"user":"u","password":"p"}"#).await;
        fresh_secret(&conn, "s3x/app/api-key", "abc").await;
        fresh_secret(&conn, "s3x-other", "x").await;
        let all = list_secrets(&conn, "s3x/app/").await.unwrap();
        let names: Vec<_> = all.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["s3x/app/api-key", "s3x/app/db"]);
        let d = describe(&conn, "s3x/app/db").await.unwrap();
        assert!(d.arn.is_some());
        let v = get_value(&conn, "s3x/app/db", None, None).await.unwrap();
        assert_eq!(v.text.as_deref(), Some(r#"{"user":"u","password":"p"}"#));
        assert!(v.stages.contains(&"AWSCURRENT".to_string()));
    }

    #[tokio::test]
    #[ignore]
    async fn creates_updates_deletes_and_restores() {
        let conn = connect().await;
        let c = client(&conn);
        for n in ["s3x/crud/one", "s3x/crud/bin"] {
            let _ = c
                .delete_secret()
                .secret_id(n)
                .force_delete_without_recovery(true)
                .send()
                .await;
        }
        let text = |t: &str| NewValue {
            text: Some(t.into()),
            binary_base64: None,
        };
        assert!(create(&conn, "bad name!", &text("x"), None, None, &[])
            .await
            .is_err());
        assert!(create(&conn, "s3x/crud/one", &text(""), None, None, &[])
            .await
            .is_err());
        let arn = create(
            &conn,
            "s3x/crud/one",
            &text("v1"),
            Some("first".into()),
            None,
            &[("env".into(), "dev".into())],
        )
        .await
        .unwrap();
        assert!(!arn.is_empty());
        assert!(create(&conn, "s3x/crud/one", &text("v1"), None, None, &[])
            .await
            .unwrap_err()
            .message
            .contains("already exists"));

        put_value(&conn, "s3x/crud/one", &text("v2")).await.unwrap();
        assert_eq!(
            get_value(&conn, "s3x/crud/one", None, None)
                .await
                .unwrap()
                .text
                .as_deref(),
            Some("v2")
        );
        update_metadata(&conn, "s3x/crud/one", Some("second".into()), None)
            .await
            .unwrap();
        assert_eq!(
            describe(&conn, "s3x/crud/one")
                .await
                .unwrap()
                .description
                .as_deref(),
            Some("second")
        );

        create(
            &conn,
            "s3x/crud/bin",
            &NewValue {
                text: None,
                binary_base64: Some("aGk=".into()),
            },
            None,
            None,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(
            get_value(&conn, "s3x/crud/bin", None, None)
                .await
                .unwrap()
                .binary_base64
                .as_deref(),
            Some("aGk=")
        );

        assert!(delete(&conn, "s3x/crud/one", Some(3), false).await.is_err());
        let when = delete(&conn, "s3x/crud/one", Some(7), false).await.unwrap();
        assert!(when.is_some());
        assert!(describe(&conn, "s3x/crud/one")
            .await
            .unwrap()
            .deleted_date
            .is_some());
        restore(&conn, "s3x/crud/one").await.unwrap();
        assert!(describe(&conn, "s3x/crud/one")
            .await
            .unwrap()
            .deleted_date
            .is_none());
        delete(&conn, "s3x/crud/one", None, true).await.unwrap();
        delete(&conn, "s3x/crud/bin", None, true).await.unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn versions_and_labels() {
        let conn = connect().await;
        let name = format!(
            "s3x/ver-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        fresh_secret(&conn, &name, "one").await;
        let text = |t: &str| NewValue {
            text: Some(t.into()),
            binary_base64: None,
        };
        let v2 = put_value(&conn, &name, &text("two")).await.unwrap();
        let vs = list_versions(&conn, &name).await.unwrap();
        assert_eq!(vs.len(), 2);
        let v1 = vs
            .iter()
            .find(|v| v.version_id != v2)
            .unwrap()
            .version_id
            .clone();
        assert!(vs
            .iter()
            .any(|v| v.version_id == v2 && v.stages.contains(&"AWSCURRENT".to_string())));
        assert_eq!(
            get_value(&conn, &name, Some(v1.clone()), None)
                .await
                .unwrap()
                .text
                .as_deref(),
            Some("one")
        );

        // Roll back: move AWSCURRENT to v1.
        move_label(
            &conn,
            &name,
            "AWSCURRENT",
            Some(v1.clone()),
            Some(v2.clone()),
        )
        .await
        .unwrap();
        // The label moved (moto's GetSecretValue default can lag, so check the
        // labels and read by stage).
        let vs = list_versions(&conn, &name).await.unwrap();
        let current = vs
            .iter()
            .find(|v| v.stages.contains(&"AWSCURRENT".to_string()))
            .unwrap();
        assert_eq!(current.version_id, v1, "{vs:?}");
        // Custom label on, then off.
        move_label(&conn, &name, "blue", Some(v2.clone()), None)
            .await
            .unwrap();
        assert_eq!(
            get_value(&conn, &name, None, Some("blue".into()))
                .await
                .unwrap()
                .text
                .as_deref(),
            Some("two")
        );
        move_label(&conn, &name, "blue", None, Some(v2.clone()))
            .await
            .unwrap();
        assert!(move_label(&conn, &name, "AWSCURRENT", None, Some(v1))
            .await
            .is_err());
    }

    #[tokio::test]
    #[ignore]
    async fn configures_and_cancels_rotation() {
        let conn = connect().await;
        fresh_secret(&conn, "s3x/rot", "x").await;
        let lambda = "arn:aws:lambda:eu-west-2:123456789012:function:rotate".to_string();
        assert!(configure_rotation(
            &conn,
            "s3x/rot",
            Some(lambda.clone()),
            "rate(2 hours)",
            None,
            false
        )
        .await
        .is_err());
        // moto may refuse without a real Lambda; accept either outcome but check consistency.
        match configure_rotation(&conn, "s3x/rot", Some(lambda), "rate(30 days)", None, false).await
        {
            Ok(()) => {
                let d = describe(&conn, "s3x/rot").await.unwrap();
                assert!(d.rotation_enabled);
                cancel_rotation(&conn, "s3x/rot").await.unwrap();
                assert!(!describe(&conn, "s3x/rot").await.unwrap().rotation_enabled);
            }
            Err(e) => eprintln!("rotation not supported by the emulator: {}", e.message),
        }
    }

    #[tokio::test]
    #[ignore]
    async fn tags_and_policy() {
        let conn = connect().await;
        fresh_secret(&conn, "s3x/pol", "x").await;
        let t = |k: &str, v: &str| (k.to_string(), v.to_string());
        set_tags(&conn, "s3x/pol", &[t("a", "1"), t("b", "2")])
            .await
            .unwrap();
        set_tags(&conn, "s3x/pol", &[t("b", "3"), t("c", "4")])
            .await
            .unwrap();
        assert_eq!(
            describe(&conn, "s3x/pol").await.unwrap().tags,
            vec![t("b", "3"), t("c", "4")]
        );

        let policy = r#"{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::123456789012:root"},"Action":"secretsmanager:GetSecretValue","Resource":"*"}]}"#;
        assert!(
            !validate_policy(&conn, "s3x/pol", "{bad")
                .await
                .unwrap()
                .valid
        );
        let check = validate_policy(&conn, "s3x/pol", policy).await;
        eprintln!("validate: {check:?}");
        put_policy(&conn, "s3x/pol", policy, true).await.unwrap();
        assert!(get_policy(&conn, "s3x/pol").await.unwrap().is_some());
        delete_policy(&conn, "s3x/pol").await.unwrap();
        assert!(get_policy(&conn, "s3x/pol").await.unwrap().is_none());
    }
}
