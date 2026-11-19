//! IAM (view only): users, groups and roles with their policies, keys and
//! trust. IAM is global, so the selected region only decides which endpoint
//! the SDK resolves (the same one for every commercial region). Secrets
//! (passwords, secret access keys) are never returned by AWS.

use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use aws_sdk_iam::Client;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

/// Per-row calls for the visible page at once.
const EXTRAS_CONCURRENCY: usize = 6;

pub fn client(conn: &Connection) -> Client {
    Client::new(&conn.service_config())
}

pub(crate) fn err(conn: &Connection, e: impl std::error::Error) -> AppError {
    AppError::from_sdk(e, &conn.info.profile, conn.info.endpoint_url.as_deref())
}

pub(crate) fn iso(d: Option<&aws_smithy_types::DateTime>) -> Option<String> {
    d.and_then(|d| d.fmt(aws_smithy_types::date_time::Format::DateTime).ok())
}

fn tags(t: &[aws_sdk_iam::types::Tag]) -> Vec<(String, String)> {
    let mut v: Vec<_> = t
        .iter()
        .map(|t| (t.key().to_string(), t.value().to_string()))
        .collect();
    v.sort();
    v
}

// ---------------------------------------------------------------------------
// Lists

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserSummary {
    pub name: String,
    pub id: String,
    pub arn: String,
    pub path: String,
    pub created: Option<String>,
    pub password_last_used: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GroupSummary {
    pub name: String,
    pub id: String,
    pub arn: String,
    pub path: String,
    pub created: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoleSummary {
    pub name: String,
    pub id: String,
    pub arn: String,
    pub path: String,
    pub created: Option<String>,
    pub description: Option<String>,
    pub max_session_secs: Option<i32>,
    /// Created and managed by an AWS service (path /aws-service-role/).
    pub service_linked: bool,
}

fn user_summary(u: &aws_sdk_iam::types::User) -> UserSummary {
    UserSummary {
        name: u.user_name().to_string(),
        id: u.user_id().to_string(),
        arn: u.arn().to_string(),
        path: u.path().to_string(),
        created: iso(Some(u.create_date())),
        password_last_used: iso(u.password_last_used()),
    }
}

fn group_summary(g: &aws_sdk_iam::types::Group) -> GroupSummary {
    GroupSummary {
        name: g.group_name().to_string(),
        id: g.group_id().to_string(),
        arn: g.arn().to_string(),
        path: g.path().to_string(),
        created: iso(Some(g.create_date())),
    }
}

fn role_summary(r: &aws_sdk_iam::types::Role) -> RoleSummary {
    RoleSummary {
        name: r.role_name().to_string(),
        id: r.role_id().to_string(),
        arn: r.arn().to_string(),
        path: r.path().to_string(),
        created: iso(Some(r.create_date())),
        description: r.description().filter(|d| !d.is_empty()).map(String::from),
        max_session_secs: r.max_session_duration(),
        service_linked: r.path().starts_with("/aws-service-role/"),
    }
}

/// Next marker, or None when the listing is complete (also stops on a
/// repeated marker, which some emulators send).
fn next(truncated: bool, marker: Option<&str>, prev: &Option<String>) -> Option<String> {
    match marker {
        Some(m) if truncated && !m.is_empty() && Some(m) != prev.as_deref() => Some(m.to_string()),
        _ => None,
    }
}

pub async fn list_users(conn: &Connection) -> Result<Vec<UserSummary>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut marker = None;
    loop {
        let page = c
            .list_users()
            .max_items(1000)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.users().iter().map(user_summary));
        match next(page.is_truncated(), page.marker(), &marker) {
            Some(m) => marker = Some(m),
            None => break,
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

pub async fn list_groups(conn: &Connection) -> Result<Vec<GroupSummary>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut marker = None;
    loop {
        let page = c
            .list_groups()
            .max_items(1000)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.groups().iter().map(group_summary));
        match next(page.is_truncated(), page.marker(), &marker) {
            Some(m) => marker = Some(m),
            None => break,
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

pub async fn list_roles(conn: &Connection) -> Result<Vec<RoleSummary>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut marker = None;
    loop {
        let page = c
            .list_roles()
            .max_items(1000)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.roles().iter().map(role_summary));
        match next(page.is_truncated(), page.marker(), &marker) {
            Some(m) => marker = Some(m),
            None => break,
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Per-row extras for the visible page

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserExtras {
    pub name: String,
    pub access_keys: usize,
    pub active_keys: usize,
    /// Newest last use of any of the user's keys.
    pub key_last_used: Option<String>,
    pub mfa_devices: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoleExtras {
    pub name: String,
    pub last_used: Option<String>,
    pub last_used_region: Option<String>,
    pub error: Option<String>,
}

async fn user_extras_one(
    conn: &Connection,
    c: &Client,
    name: &str,
) -> Result<UserExtras, AppError> {
    let keys = c
        .list_access_keys()
        .user_name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let mut x = UserExtras {
        name: name.to_string(),
        access_keys: keys.access_key_metadata().len(),
        active_keys: keys
            .access_key_metadata()
            .iter()
            .filter(|k| k.status().map(|s| s.as_str()) == Some("Active"))
            .count(),
        ..Default::default()
    };
    for k in keys.access_key_metadata() {
        let Some(id) = k.access_key_id() else {
            continue;
        };
        if let Ok(u) = c.get_access_key_last_used().access_key_id(id).send().await {
            let used = u
                .access_key_last_used()
                .and_then(|l| iso(l.last_used_date()));
            if used.is_some() && used > x.key_last_used {
                x.key_last_used = used;
            }
        }
    }
    x.mfa_devices = c
        .list_mfa_devices()
        .user_name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?
        .mfa_devices()
        .len();
    Ok(x)
}

pub async fn user_extras(conn: Arc<Connection>, names: Vec<String>) -> Vec<UserExtras> {
    let c = client(&conn);
    let sem = Arc::new(tokio::sync::Semaphore::new(EXTRAS_CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    for (i, name) in names.iter().enumerate() {
        let (c, sem, conn, name) = (c.clone(), sem.clone(), conn.clone(), name.clone());
        set.spawn(async move {
            let _p = sem.acquire().await;
            let r = user_extras_one(&conn, &c, &name)
                .await
                .unwrap_or_else(|e| UserExtras {
                    name: name.clone(),
                    error: Some(e.message),
                    ..Default::default()
                });
            (i, r)
        });
    }
    let mut out: Vec<Option<UserExtras>> = vec![None; names.len()];
    while let Some(Ok((i, r))) = set.join_next().await {
        out[i] = Some(r);
    }
    out.into_iter().flatten().collect()
}

pub async fn role_extras(conn: Arc<Connection>, names: Vec<String>) -> Vec<RoleExtras> {
    let c = client(&conn);
    let sem = Arc::new(tokio::sync::Semaphore::new(EXTRAS_CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    for (i, name) in names.iter().enumerate() {
        let (c, sem, conn, name) = (c.clone(), sem.clone(), conn.clone(), name.clone());
        set.spawn(async move {
            let _p = sem.acquire().await;
            let r = match c.get_role().role_name(&name).send().await {
                Ok(o) => {
                    let last = o.role().and_then(|r| r.role_last_used());
                    RoleExtras {
                        name: name.clone(),
                        last_used: last.and_then(|l| iso(l.last_used_date())),
                        last_used_region: last.and_then(|l| l.region()).map(String::from),
                        error: None,
                    }
                }
                Err(e) => RoleExtras {
                    name: name.clone(),
                    error: Some(err(&conn, e).message),
                    ..Default::default()
                },
            };
            (i, r)
        });
    }
    let mut out: Vec<Option<RoleExtras>> = vec![None; names.len()];
    while let Some(Ok((i, r))) = set.join_next().await {
        out[i] = Some(r);
    }
    out.into_iter().flatten().collect()
}

// ---------------------------------------------------------------------------
// Policies attached to a principal

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Attached {
    pub name: String,
    pub arn: String,
    /// An AWS managed policy (arn:…:iam::aws:policy/…).
    pub aws_managed: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Inline {
    pub name: String,
    /// Decoded JSON text.
    pub document: Option<String>,
    pub error: Option<String>,
}

fn attached(p: &aws_sdk_iam::types::AttachedPolicy) -> Attached {
    let arn = p.policy_arn().unwrap_or_default().to_string();
    Attached {
        name: p.policy_name().unwrap_or_default().to_string(),
        aws_managed: arn.contains(":iam::aws:policy/"),
        arn,
    }
}

/// Policy documents come URL-encoded (RFC 3986). Some emulators send plain
/// JSON, which is left alone.
pub fn decode_document(s: &str) -> String {
    if s.trim_start().starts_with('{') {
        return s.to_string();
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// A principal's kind, for the inline / attached policy calls.
#[derive(Clone, Copy)]
enum Who {
    User,
    Group,
    Role,
}

async fn attached_for(
    conn: &Connection,
    c: &Client,
    who: Who,
    name: &str,
) -> Result<Vec<Attached>, AppError> {
    let mut out = Vec::new();
    let mut marker: Option<String> = None;
    loop {
        let (items, truncated, m) = match who {
            Who::User => {
                let o = c
                    .list_attached_user_policies()
                    .user_name(name)
                    .set_marker(marker.clone())
                    .send()
                    .await
                    .map_err(|e| err(conn, e))?;
                (
                    o.attached_policies()
                        .iter()
                        .map(attached)
                        .collect::<Vec<_>>(),
                    o.is_truncated(),
                    o.marker().map(String::from),
                )
            }
            Who::Group => {
                let o = c
                    .list_attached_group_policies()
                    .group_name(name)
                    .set_marker(marker.clone())
                    .send()
                    .await
                    .map_err(|e| err(conn, e))?;
                (
                    o.attached_policies().iter().map(attached).collect(),
                    o.is_truncated(),
                    o.marker().map(String::from),
                )
            }
            Who::Role => {
                let o = c
                    .list_attached_role_policies()
                    .role_name(name)
                    .set_marker(marker.clone())
                    .send()
                    .await
                    .map_err(|e| err(conn, e))?;
                (
                    o.attached_policies().iter().map(attached).collect(),
                    o.is_truncated(),
                    o.marker().map(String::from),
                )
            }
        };
        out.extend(items);
        match next(truncated, m.as_deref(), &marker) {
            Some(m) => marker = Some(m),
            None => break,
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

async fn inline_for(
    conn: &Connection,
    c: &Client,
    who: Who,
    name: &str,
) -> Result<Vec<Inline>, AppError> {
    let mut names = Vec::new();
    let mut marker: Option<String> = None;
    loop {
        let (items, truncated, m) = match who {
            Who::User => {
                let o = c
                    .list_user_policies()
                    .user_name(name)
                    .set_marker(marker.clone())
                    .send()
                    .await
                    .map_err(|e| err(conn, e))?;
                (
                    o.policy_names().to_vec(),
                    o.is_truncated(),
                    o.marker().map(String::from),
                )
            }
            Who::Group => {
                let o = c
                    .list_group_policies()
                    .group_name(name)
                    .set_marker(marker.clone())
                    .send()
                    .await
                    .map_err(|e| err(conn, e))?;
                (
                    o.policy_names().to_vec(),
                    o.is_truncated(),
                    o.marker().map(String::from),
                )
            }
            Who::Role => {
                let o = c
                    .list_role_policies()
                    .role_name(name)
                    .set_marker(marker.clone())
                    .send()
                    .await
                    .map_err(|e| err(conn, e))?;
                (
                    o.policy_names().to_vec(),
                    o.is_truncated(),
                    o.marker().map(String::from),
                )
            }
        };
        names.extend(items);
        match next(truncated, m.as_deref(), &marker) {
            Some(m) => marker = Some(m),
            None => break,
        }
    }
    names.sort_by_key(|n| n.to_lowercase());
    let mut out = Vec::new();
    for p in names {
        let doc = match who {
            Who::User => c
                .get_user_policy()
                .user_name(name)
                .policy_name(&p)
                .send()
                .await
                .map(|o| o.policy_document().to_string())
                .map_err(|e| err(conn, e)),
            Who::Group => c
                .get_group_policy()
                .group_name(name)
                .policy_name(&p)
                .send()
                .await
                .map(|o| o.policy_document().to_string())
                .map_err(|e| err(conn, e)),
            Who::Role => c
                .get_role_policy()
                .role_name(name)
                .policy_name(&p)
                .send()
                .await
                .map(|o| o.policy_document().to_string())
                .map_err(|e| err(conn, e)),
        };
        out.push(match doc {
            Ok(d) => Inline {
                name: p,
                document: Some(decode_document(&d)),
                error: None,
            },
            Err(e) => Inline {
                name: p,
                document: None,
                error: Some(e.message),
            },
        });
    }
    Ok(out)
}

fn is_no_such_entity(detail: &str) -> bool {
    detail.contains("NoSuchEntity")
}

// ---------------------------------------------------------------------------
// One user

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccessKey {
    pub id: String,
    pub status: Option<String>,
    pub created: Option<String>,
    pub last_used: Option<String>,
    pub last_service: Option<String>,
    pub last_region: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Mfa {
    pub serial: String,
    pub enabled: Option<String>,
    /// A virtual (app) device; otherwise hardware or a passkey / security key.
    pub virtual_device: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoginProfile {
    pub created: Option<String>,
    pub reset_required: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserDetails {
    #[serde(flatten)]
    pub summary: UserSummary,
    pub boundary: Option<String>,
    pub tags: Vec<(String, String)>,
    pub groups: Vec<GroupSummary>,
    pub attached: Vec<Attached>,
    pub inline: Vec<Inline>,
    /// Console password: None when the user has none.
    pub login: Option<LoginProfile>,
    pub access_keys: Vec<AccessKey>,
    pub mfa: Vec<Mfa>,
}

pub async fn user(conn: &Connection, name: &str) -> Result<UserDetails, AppError> {
    let c = client(conn);
    let u = c
        .get_user()
        .user_name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let Some(u) = u.user() else {
        return Err(AppError::new(
            ErrorKind::Other,
            format!("User {name} not found."),
        ));
    };
    let mut d = UserDetails {
        summary: user_summary(u),
        boundary: u
            .permissions_boundary()
            .and_then(|b| b.permissions_boundary_arn())
            .map(String::from),
        tags: tags(u.tags()),
        ..Default::default()
    };
    // Groups.
    let mut marker: Option<String> = None;
    loop {
        let o = c
            .list_groups_for_user()
            .user_name(name)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        d.groups.extend(o.groups().iter().map(group_summary));
        match next(o.is_truncated(), o.marker(), &marker) {
            Some(m) => marker = Some(m),
            None => break,
        }
    }
    d.groups
        .sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    d.attached = attached_for(conn, &c, Who::User, name).await?;
    d.inline = inline_for(conn, &c, Who::User, name).await?;
    d.login = match c.get_login_profile().user_name(name).send().await {
        Ok(o) => o.login_profile().map(|p| LoginProfile {
            created: iso(Some(p.create_date())),
            reset_required: p.password_reset_required(),
        }),
        Err(e) => {
            let detail = aws_smithy_types::error::display::DisplayErrorContext(&e).to_string();
            if is_no_such_entity(&detail) {
                None
            } else {
                return Err(err(conn, e));
            }
        }
    };
    let keys = c
        .list_access_keys()
        .user_name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    for k in keys.access_key_metadata() {
        let Some(id) = k.access_key_id() else {
            continue;
        };
        let mut key = AccessKey {
            id: id.to_string(),
            status: k.status().map(|s| s.as_str().to_string()),
            created: iso(k.create_date()),
            ..Default::default()
        };
        if let Ok(o) = c.get_access_key_last_used().access_key_id(id).send().await {
            if let Some(l) = o.access_key_last_used() {
                key.last_used = iso(l.last_used_date());
                // AWS reports "N/A" for keys never used.
                key.last_service =
                    Some(l.service_name().to_string()).filter(|s| !s.is_empty() && s != "N/A");
                key.last_region =
                    Some(l.region().to_string()).filter(|s| !s.is_empty() && s != "N/A");
            }
        }
        d.access_keys.push(key);
    }
    d.access_keys.sort_by(|a, b| a.created.cmp(&b.created));
    let mfa = c
        .list_mfa_devices()
        .user_name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    d.mfa = mfa
        .mfa_devices()
        .iter()
        .map(|m| Mfa {
            serial: m.serial_number().to_string(),
            enabled: iso(Some(m.enable_date())),
            virtual_device: m.serial_number().contains(":mfa/"),
        })
        .collect();
    Ok(d)
}

// ---------------------------------------------------------------------------
// One group

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GroupDetails {
    #[serde(flatten)]
    pub summary: GroupSummary,
    pub members: Vec<UserSummary>,
    pub attached: Vec<Attached>,
    pub inline: Vec<Inline>,
}

pub async fn group(conn: &Connection, name: &str) -> Result<GroupDetails, AppError> {
    let c = client(conn);
    let mut d = GroupDetails::default();
    let mut marker: Option<String> = None;
    loop {
        let o = c
            .get_group()
            .group_name(name)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        if let Some(g) = o.group() {
            d.summary = group_summary(g);
        }
        d.members.extend(o.users().iter().map(user_summary));
        match next(o.is_truncated(), o.marker(), &marker) {
            Some(m) => marker = Some(m),
            None => break,
        }
    }
    d.members
        .sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    d.attached = attached_for(conn, &c, Who::Group, name).await?;
    d.inline = inline_for(conn, &c, Who::Group, name).await?;
    Ok(d)
}

// ---------------------------------------------------------------------------
// One role

/// Who a trust policy lets assume the role: one row per principal.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trust {
    /// Allow or Deny.
    pub effect: String,
    /// Service, AWS, Federated, CanonicalUser, or "*" (anyone).
    pub kind: String,
    pub principal: String,
    pub actions: Vec<String>,
    /// The statement has a Condition block (shown in the document).
    pub conditions: bool,
    /// Statement Sid, if any.
    pub sid: Option<String>,
}

fn strings(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect(),
        _ => Vec::new(),
    }
}

/// Parses a trust (assume role) policy into who may assume the role.
pub fn trust_of(document: &str) -> Vec<Trust> {
    let Ok(doc) = serde_json::from_str::<Value>(document) else {
        return Vec::new();
    };
    let statements = match doc.get("Statement") {
        Some(Value::Array(a)) => a.clone(),
        Some(s @ Value::Object(_)) => vec![s.clone()],
        _ => Vec::new(),
    };
    let mut out = Vec::new();
    for s in &statements {
        let effect = s
            .get("Effect")
            .and_then(|e| e.as_str())
            .unwrap_or("Allow")
            .to_string();
        let actions = strings(s.get("Action"));
        let conditions = s
            .get("Condition")
            .map(|c| c.as_object().map(|o| !o.is_empty()).unwrap_or(true))
            .unwrap_or(false);
        let sid = s
            .get("Sid")
            .and_then(|x| x.as_str())
            .filter(|x| !x.is_empty())
            .map(String::from);
        let mut push = |kind: &str, principal: String| {
            out.push(Trust {
                effect: effect.clone(),
                kind: kind.to_string(),
                principal,
                actions: actions.clone(),
                conditions,
                sid: sid.clone(),
            })
        };
        match s.get("Principal") {
            Some(Value::String(p)) => push("*", p.clone()),
            Some(Value::Object(m)) => {
                for (kind, v) in m {
                    for p in strings(Some(v)) {
                        push(kind, p);
                    }
                }
            }
            _ => {}
        }
        if s.get("NotPrincipal").is_some() {
            push("NotPrincipal", s["NotPrincipal"].to_string());
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoleDetails {
    #[serde(flatten)]
    pub summary: RoleSummary,
    /// Decoded JSON text.
    pub trust_policy: Option<String>,
    pub trusted: Vec<Trust>,
    pub boundary: Option<String>,
    pub last_used: Option<String>,
    pub last_used_region: Option<String>,
    pub tags: Vec<(String, String)>,
    pub attached: Vec<Attached>,
    pub inline: Vec<Inline>,
    pub instance_profiles: Vec<String>,
}

pub async fn role(conn: &Connection, name: &str) -> Result<RoleDetails, AppError> {
    let c = client(conn);
    let o = c
        .get_role()
        .role_name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let Some(r) = o.role() else {
        return Err(AppError::new(
            ErrorKind::Other,
            format!("Role {name} not found."),
        ));
    };
    let trust = r.assume_role_policy_document().map(decode_document);
    let mut d = RoleDetails {
        summary: role_summary(r),
        trusted: trust.as_deref().map(trust_of).unwrap_or_default(),
        trust_policy: trust,
        boundary: r
            .permissions_boundary()
            .and_then(|b| b.permissions_boundary_arn())
            .map(String::from),
        last_used: r.role_last_used().and_then(|l| iso(l.last_used_date())),
        last_used_region: r
            .role_last_used()
            .and_then(|l| l.region())
            .map(String::from),
        tags: tags(r.tags()),
        ..Default::default()
    };
    d.attached = attached_for(conn, &c, Who::Role, name).await?;
    d.inline = inline_for(conn, &c, Who::Role, name).await?;
    let mut marker: Option<String> = None;
    loop {
        let o = c
            .list_instance_profiles_for_role()
            .role_name(name)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        d.instance_profiles.extend(
            o.instance_profiles()
                .iter()
                .map(|p| p.instance_profile_name().to_string()),
        );
        match next(o.is_truncated(), o.marker(), &marker) {
            Some(m) => marker = Some(m),
            None => break,
        }
    }
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_url_encoded_documents() {
        assert_eq!(
            decode_document("%7B%22Version%22%3A%222012-10-17%22%7D"),
            r#"{"Version":"2012-10-17"}"#
        );
        // Plain JSON (emulators) stays as it is, including a literal %.
        assert_eq!(decode_document(r#"{"a":"50%"}"#), r#"{"a":"50%"}"#);
        // Broken escapes are kept.
        assert_eq!(decode_document("%7Bx%zz%4"), "{x%zz%4");
        assert_eq!(decode_document("%E2%9C%93"), "✓");
    }

    #[test]
    fn parses_trust_policies() {
        let doc = r#"{"Version":"2012-10-17","Statement":[
          {"Effect":"Allow","Principal":{"Service":["lambda.amazonaws.com","states.amazonaws.com"]},"Action":"sts:AssumeRole"},
          {"Sid":"x","Effect":"Allow","Principal":{"AWS":"arn:aws:iam::123456789012:root"},"Action":["sts:AssumeRole","sts:TagSession"],"Condition":{"Bool":{"aws:MultiFactorAuthPresent":"true"}}},
          {"Effect":"Allow","Principal":{"Federated":"cognito-identity.amazonaws.com"},"Action":"sts:AssumeRoleWithWebIdentity"},
          {"Effect":"Deny","Principal":"*","Action":"sts:AssumeRole"}]}"#;
        let t = trust_of(doc);
        assert_eq!(t.len(), 5);
        assert_eq!(
            (t[0].kind.as_str(), t[0].principal.as_str()),
            ("Service", "lambda.amazonaws.com")
        );
        assert_eq!(t[1].principal, "states.amazonaws.com");
        assert!(!t[0].conditions);
        assert_eq!(t[2].kind, "AWS");
        assert!(t[2].conditions);
        assert_eq!(t[2].sid.as_deref(), Some("x"));
        assert_eq!(t[2].actions, ["sts:AssumeRole", "sts:TagSession"]);
        assert_eq!(t[3].kind, "Federated");
        assert_eq!((t[4].effect.as_str(), t[4].kind.as_str()), ("Deny", "*"));
        // A single statement object and junk.
        assert_eq!(trust_of(r#"{"Statement":{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}}"#).len(), 1);
        assert!(trust_of("not json").is_empty());
    }

    #[test]
    fn markers_stop_when_complete_or_repeated() {
        assert_eq!(next(true, Some("a"), &None), Some("a".to_string()));
        assert_eq!(next(false, Some("a"), &None), None);
        assert_eq!(next(true, Some("a"), &Some("a".into())), None);
        assert_eq!(next(true, Some(""), &None), None);
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;

    async fn connect() -> Connection {
        crate::sqs::emulator_tests::connect().await
    }

    const TRUST: &str = r#"{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"states.amazonaws.com"},"Action":"sts:AssumeRole"}]}"#;
    const POLICY: &str = r#"{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"*"}]}"#;

    /// A user in a group with an inline policy, and a role trusting Step Functions.
    async fn ensure_principals(conn: &Connection) {
        let c = client(conn);
        let _ = c
            .create_user()
            .user_name("s3x-iam-user")
            .path("/s3x/")
            .send()
            .await;
        let _ = c.create_group().group_name("s3x-iam-group").send().await;
        let _ = c
            .add_user_to_group()
            .group_name("s3x-iam-group")
            .user_name("s3x-iam-user")
            .send()
            .await;
        let _ = c
            .put_user_policy()
            .user_name("s3x-iam-user")
            .policy_name("read")
            .policy_document(POLICY)
            .send()
            .await;
        let _ = c
            .create_role()
            .role_name("s3x-iam-role")
            .assume_role_policy_document(TRUST)
            .send()
            .await;
        let _ = c
            .attach_role_policy()
            .role_name("s3x-iam-role")
            .policy_arn("arn:aws:iam::aws:policy/ReadOnlyAccess")
            .send()
            .await;
    }

    #[tokio::test]
    #[ignore]
    async fn lists_and_describes_principals() {
        let conn = Arc::new(connect().await);
        ensure_principals(&conn).await;
        let users = list_users(&conn).await.unwrap();
        assert!(users
            .iter()
            .any(|u| u.name == "s3x-iam-user" && u.path == "/s3x/"));
        assert!(list_groups(&conn)
            .await
            .unwrap()
            .iter()
            .any(|g| g.name == "s3x-iam-group"));
        assert!(list_roles(&conn)
            .await
            .unwrap()
            .iter()
            .any(|r| r.name == "s3x-iam-role"));

        let u = user(&conn, "s3x-iam-user").await.unwrap();
        assert!(u.groups.iter().any(|g| g.name == "s3x-iam-group"));
        let read = u
            .inline
            .iter()
            .find(|p| p.name == "read")
            .expect("inline policy");
        assert!(read
            .document
            .as_deref()
            .unwrap_or_default()
            .contains("s3:GetObject"));
        assert!(u.login.is_none());

        let g = group(&conn, "s3x-iam-group").await.unwrap();
        assert!(g.members.iter().any(|m| m.name == "s3x-iam-user"));

        let r = role(&conn, "s3x-iam-role").await.unwrap();
        assert_eq!(
            r.trusted.first().map(|t| t.principal.as_str()),
            Some("states.amazonaws.com")
        );
        assert!(r
            .attached
            .iter()
            .any(|p| p.name == "ReadOnlyAccess" && p.aws_managed));

        let x = user_extras(conn.clone(), vec!["s3x-iam-user".into()]).await;
        assert_eq!(x.len(), 1);
        assert!(x[0].error.is_none(), "{:?}", x[0].error);
        let rx = role_extras(conn.clone(), vec!["s3x-iam-role".into()]).await;
        assert!(rx[0].error.is_none(), "{:?}", rx[0].error);
    }
}
