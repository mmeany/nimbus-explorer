//! Parameter Store (SSM) operations.
//!
//! Browsing treats "/"-separated names as folders. SSM has no delimiter
//! listing like S3, so a folder's sub-folders are derived from a recursive
//! metadata listing (DescribeParameters, which never returns values).
//! SecureString values are never fetched here; they are decrypted only by an
//! explicit Reveal/Copy (see `reveal`).

use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use aws_sdk_ssm::types::{ParameterMetadata, ParameterStringFilter};
use aws_sdk_ssm::Client;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// DescribeParameters page size (the API maximum).
const DESCRIBE_PAGE: i32 = 50;
/// GetParameters accepts at most 10 names per call.
const GET_BATCH: usize = 10;
/// In filtered (flat) views, values are loaded for at most this many parameters.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamInfo {
    pub name: String,
    /// "String" | "StringList" | "SecureString"
    pub param_type: String,
    pub version: i64,
    /// RFC 3339
    pub last_modified: Option<String>,
    pub last_modified_user: Option<String>,
    pub tier: Option<String>,
    pub data_type: Option<String>,
    pub description: Option<String>,
    pub key_id: Option<String>,
    pub allowed_pattern: Option<String>,
    pub policy_count: usize,
    pub policies: Vec<ParamPolicy>,
    /// Value for String / StringList (None for SecureString, or not loaded).
    pub value: Option<String>,
}

/// A parameter policy (Advanced tier): Expiration, ExpirationNotification,
/// NoChangeNotification.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamPolicy {
    pub policy_type: String,
    /// The policy JSON as stored.
    pub text: String,
    /// "Pending" | "Finished" | "Failed"
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Tag {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamListing {
    /// Sub-folder paths, each ending in "/".
    pub folders: Vec<String>,
    pub parameters: Vec<ParamInfo>,
}

pub fn client(conn: &Connection) -> Client {
    Client::new(&conn.service_config())
}

fn err(conn: &Connection, e: impl std::error::Error) -> AppError {
    AppError::from_sdk(e, &conn.info.profile, conn.info.endpoint_url.as_deref())
}

fn meta_to_info(m: &ParameterMetadata) -> ParamInfo {
    ParamInfo {
        name: m.name().unwrap_or_default().to_string(),
        param_type: m
            .r#type()
            .map(|t| t.as_str().to_string())
            .unwrap_or_default(),
        version: m.version(),
        last_modified: m.last_modified_date().and_then(|d| {
            d.fmt(aws_sdk_ssm::primitives::DateTimeFormat::DateTime)
                .ok()
        }),
        last_modified_user: m.last_modified_user().map(String::from),
        tier: m.tier().map(|t| t.as_str().to_string()),
        data_type: m.data_type().map(String::from),
        description: m.description().map(String::from),
        key_id: m.key_id().map(String::from),
        allowed_pattern: m.allowed_pattern().map(String::from),
        policy_count: m.policies().len(),
        policies: m
            .policies()
            .iter()
            .map(|p| ParamPolicy {
                policy_type: p.policy_type().unwrap_or_default().to_string(),
                text: p.policy_text().unwrap_or_default().to_string(),
                status: p.policy_status().unwrap_or_default().to_string(),
            })
            .collect(),
        value: None,
    }
}

/// Normalises a folder path to "/" or "/a/b/".
pub fn normalise_path(path: &str) -> String {
    let trimmed = path.trim().trim_matches('/');
    if trimmed.is_empty() {
        "/".into()
    } else {
        format!("/{trimmed}/")
    }
}

/// Splits recursive results under `path` into direct child parameters and
/// child folders. At the root, names without a leading "/" are top-level too.
pub fn split_children(
    path: &str,
    names: impl Iterator<Item = String>,
) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut params = BTreeSet::new();
    let mut folders = BTreeSet::new();
    for name in names {
        let rest = if path == "/" {
            match name.strip_prefix('/') {
                Some(r) => r.to_string(),
                None => {
                    // "plain" names (no leading slash) live at the root.
                    params.insert(name);
                    continue;
                }
            }
        } else {
            match name.strip_prefix(path) {
                Some(r) => r.to_string(),
                None => continue,
            }
        };
        match rest.find('/') {
            Some(i) => {
                folders.insert(format!("{path}{}/", &rest[..i]));
            }
            None => {
                params.insert(name);
            }
        }
    }
    (params, folders)
}

/// All parameter metadata matching `filters` (paginated).
async fn describe_all(
    conn: &Connection,
    client: &Client,
    filters: Option<Vec<ParameterStringFilter>>,
) -> Result<Vec<ParameterMetadata>, AppError> {
    let mut out = Vec::new();
    let mut token = None;
    loop {
        let page = client
            .describe_parameters()
            .set_parameter_filters(filters.clone())
            .max_results(DESCRIBE_PAGE)
            .set_next_token(token)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.parameters().iter().cloned());
        token = page.next_token().map(String::from);
        if token.is_none() {
            break;
        }
    }
    Ok(out)
}

fn filter(key: &str, option: &str, value: &str) -> Result<ParameterStringFilter, AppError> {
    ParameterStringFilter::builder()
        .key(key)
        .option(option)
        .values(value)
        .build()
        .map_err(|e| AppError::new(ErrorKind::Other, e.to_string()))
}

/// Values of the named parameters (the visible page), GetParameters without
/// decryption, 10 per call. SecureString parameters are left out (without
/// decryption GetParameters would return their ciphertext), as are names
/// that no longer exist.
pub async fn values(
    conn: &Connection,
    names: &[String],
) -> Result<BTreeMap<String, String>, AppError> {
    let client = client(conn);
    let mut unique: Vec<&String> = names.iter().collect();
    unique.sort();
    unique.dedup();
    let mut out = BTreeMap::new();
    for chunk in unique.chunks(GET_BATCH) {
        let res = client
            .get_parameters()
            .set_names(Some(chunk.iter().map(|s| s.to_string()).collect()))
            .with_decryption(false)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        for p in res.parameters() {
            if p.r#type().is_some_and(|t| t.as_str() == "SecureString") {
                continue;
            }
            if let (Some(n), Some(v)) = (p.name(), p.value()) {
                out.insert(n.to_string(), v.to_string());
            }
        }
    }
    Ok(out)
}

async fn load_values(conn: &Connection, params: &mut [ParamInfo]) -> Result<(), AppError> {
    let wanted: Vec<String> = params
        .iter()
        .filter(|p| p.param_type != "SecureString")
        .map(|p| p.name.clone())
        .collect();
    let mut found = values(conn, &wanted).await?;
    for p in params.iter_mut() {
        if p.param_type != "SecureString" {
            p.value = found.remove(&p.name);
        }
    }
    Ok(())
}

/// Folder view of `path`: direct child parameters (with values for
/// String/StringList when `with_values`) and child folders.
pub async fn list_path(
    conn: &Connection,
    path: &str,
    with_values: bool,
) -> Result<ParamListing, AppError> {
    let client = client(conn);
    let path = normalise_path(path);
    let filters = if path == "/" {
        None // everything; split_children sorts out the top level
    } else {
        Some(vec![filter(
            "Path",
            "Recursive",
            path.trim_end_matches('/'),
        )?])
    };
    let all = describe_all(conn, &client, filters).await?;
    let (direct, folders) =
        split_children(&path, all.iter().filter_map(|m| m.name().map(String::from)));
    let mut parameters: Vec<ParamInfo> = all
        .iter()
        .filter(|m| m.name().is_some_and(|n| direct.contains(n)))
        .map(meta_to_info)
        .collect();
    parameters.sort_by(|a, b| a.name.cmp(&b.name));
    if with_values {
        load_values(conn, &mut parameters).await?;
    }
    Ok(ParamListing {
        folders: folders.into_iter().collect(),
        parameters,
    })
}

/// Flat view of every parameter whose name begins with `prefix` (server-side
/// filter), without values: the UI loads values for the visible page.
pub async fn list_prefix(conn: &Connection, prefix: &str) -> Result<ParamListing, AppError> {
    let client = client(conn);
    let prefix = prefix.trim();
    if prefix.is_empty() {
        return Err(AppError::new(
            ErrorKind::Other,
            "Enter a prefix to filter by",
        ));
    }
    let all = describe_all(
        conn,
        &client,
        Some(vec![filter("Name", "BeginsWith", prefix)?]),
    )
    .await?;
    let mut parameters: Vec<ParamInfo> = all.iter().map(meta_to_info).collect();
    parameters.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(ParamListing {
        folders: Vec::new(),
        parameters,
    })
}

/// Fields for creating or overwriting a parameter.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutParam {
    pub name: String,
    pub value: String,
    pub param_type: String,
    pub description: Option<String>,
    /// KMS key for SecureString (None = the account default, alias/aws/ssm).
    pub key_id: Option<String>,
    pub allowed_pattern: Option<String>,
    /// "text" (default), "aws:ec2:image" or "aws:ssm:integration".
    pub data_type: Option<String>,
    /// "Standard" | "Advanced" | "Intelligent-Tiering"; None keeps the default.
    pub tier: Option<String>,
    /// Policies JSON array (Advanced tier); "[]" removes them; None leaves them.
    #[serde(default)]
    pub policies: Option<String>,
    /// Replace an existing parameter (creates a new version).
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamDeleteFailure {
    pub name: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamDeleteResult {
    pub deleted: Vec<String>,
    pub failed: Vec<ParamDeleteFailure>,
}

fn non_empty(v: &Option<String>) -> Option<String> {
    v.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Checks a parameter name against SSM's rules; returns a message if invalid.
pub fn name_problem(name: &str) -> Option<String> {
    if name.is_empty() {
        return Some("Enter a name".into());
    }
    if name.len() > 1011 {
        return Some("Names can be at most 1011 characters".into());
    }
    if let Some(c) = name
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || "_.-/".contains(*c)))
    {
        let what = if c == ' ' {
            "Spaces aren't".to_string()
        } else {
            format!("\"{c}\" isn't")
        };
        return Some(format!("{what} allowed; use letters, digits, _ . - and /"));
    }
    if name.contains('/') && !name.starts_with('/') {
        return Some("Hierarchical names must begin with /".into());
    }
    if name.ends_with('/') || name.contains("//") {
        return Some("Names can't end with / or contain empty segments".into());
    }
    let first = name.trim_start_matches('/').to_ascii_lowercase();
    if first.starts_with("aws") || first.starts_with("ssm") {
        return Some("Names can't begin with \"aws\" or \"ssm\"".into());
    }
    if name.matches('/').count() > 15 {
        return Some("At most 15 levels of hierarchy".into());
    }
    None
}

/// Metadata for one parameter (None if it doesn't exist). Never loads a value.
pub async fn describe_one(conn: &Connection, name: &str) -> Result<Option<ParamInfo>, AppError> {
    let client = client(conn);
    let all = describe_all(conn, &client, Some(vec![filter("Name", "Equals", name)?])).await?;
    Ok(all
        .iter()
        .find(|m| m.name() == Some(name))
        .map(meta_to_info))
}

/// One parameter's value. `decrypt` only on an explicit user action (Reveal,
/// Copy, Edit); the plaintext is returned to the UI and never stored here.
pub async fn get_value(conn: &Connection, name: &str, decrypt: bool) -> Result<String, AppError> {
    let out = client(conn)
        .get_parameter()
        .name(name)
        .with_decryption(decrypt)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out
        .parameter()
        .and_then(|p| p.value())
        .unwrap_or_default()
        .to_string())
}

/// Creates or overwrites a parameter; returns the new version.
pub async fn put(conn: &Connection, p: &PutParam) -> Result<i64, AppError> {
    if let Some(problem) = name_problem(&p.name) {
        return Err(AppError::new(ErrorKind::Other, problem));
    }
    if p.value.is_empty() {
        return Err(AppError::new(ErrorKind::Other, "A value is required"));
    }
    let secure = p.param_type == "SecureString";
    let req = client(conn)
        .put_parameter()
        .name(&p.name)
        .value(&p.value)
        .r#type(p.param_type.as_str().into())
        .overwrite(p.overwrite)
        .set_description(non_empty(&p.description))
        .set_key_id(if secure { non_empty(&p.key_id) } else { None })
        .set_allowed_pattern(non_empty(&p.allowed_pattern))
        .set_data_type(non_empty(&p.data_type))
        .set_tier(non_empty(&p.tier).map(|t| t.as_str().into()))
        .set_policies(non_empty(&p.policies));
    match req.send().await {
        Ok(out) => Ok(out.version()),
        Err(e) => {
            if e.as_service_error()
                .is_some_and(|se| se.is_parameter_already_exists())
            {
                return Err(AppError::new(
                    ErrorKind::Other,
                    format!("{} already exists", p.name),
                ));
            }
            Err(err(conn, e))
        }
    }
}

/// Deletes parameters (DeleteParameters, 10 names per call).
pub async fn delete(conn: &Connection, names: &[String]) -> Result<ParamDeleteResult, AppError> {
    let client = client(conn);
    let mut result = ParamDeleteResult {
        deleted: Vec::new(),
        failed: Vec::new(),
    };
    for chunk in names.chunks(GET_BATCH) {
        match client
            .delete_parameters()
            .set_names(Some(chunk.to_vec()))
            .send()
            .await
        {
            Ok(out) => {
                result
                    .deleted
                    .extend(out.deleted_parameters().iter().cloned());
                result
                    .failed
                    .extend(out.invalid_parameters().iter().map(|n| ParamDeleteFailure {
                        name: n.clone(),
                        message: "Not found".into(),
                    }));
            }
            Err(e) => {
                let e = err(conn, e);
                if result.deleted.is_empty() && result.failed.is_empty() {
                    return Err(e); // nothing happened yet: report the error itself
                }
                result
                    .failed
                    .extend(chunk.iter().map(|n| ParamDeleteFailure {
                        name: n.clone(),
                        message: e.message.clone(),
                    }));
            }
        }
    }
    Ok(result)
}

/// One entry of a parameter's history (GetParameterHistory).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamVersion {
    pub version: i64,
    pub param_type: String,
    pub last_modified: Option<String>,
    pub last_modified_user: Option<String>,
    pub labels: Vec<String>,
    pub description: Option<String>,
    pub tier: Option<String>,
    pub key_id: Option<String>,
    pub data_type: Option<String>,
    /// Value for String / StringList; None for SecureString (decrypt on demand).
    pub value: Option<String>,
}

/// Every version of a parameter, oldest first. Never decrypts.
pub async fn history(conn: &Connection, name: &str) -> Result<Vec<ParamVersion>, AppError> {
    let client = client(conn);
    let mut out = Vec::new();
    let mut token = None;
    loop {
        let page = client
            .get_parameter_history()
            .name(name)
            .with_decryption(false)
            .max_results(DESCRIBE_PAGE)
            .set_next_token(token)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        for h in page.parameters() {
            let param_type = h
                .r#type()
                .map(|t| t.as_str().to_string())
                .unwrap_or_default();
            let secure = param_type == "SecureString";
            out.push(ParamVersion {
                version: h.version(),
                last_modified: h.last_modified_date().and_then(|d| {
                    d.fmt(aws_sdk_ssm::primitives::DateTimeFormat::DateTime)
                        .ok()
                }),
                last_modified_user: h.last_modified_user().map(String::from),
                labels: h.labels().to_vec(),
                description: h.description().map(String::from),
                tier: h.tier().map(|t| t.as_str().to_string()),
                key_id: h.key_id().map(String::from),
                data_type: h.data_type().map(String::from),
                value: if secure {
                    None
                } else {
                    h.value().map(String::from)
                },
                param_type,
            });
        }
        token = page.next_token().map(String::from);
        if token.is_none() {
            break;
        }
    }
    out.sort_by_key(|v| v.version);
    Ok(out)
}

/// Checks a version label against SSM's rules.
pub fn label_problem(label: &str) -> Option<String> {
    if label.is_empty() {
        return Some("Enter a label".into());
    }
    if label.len() > 100 {
        return Some("Labels can be at most 100 characters".into());
    }
    if label
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || "_.-".contains(c)))
    {
        return Some("Use letters, digits, _ . and - only".into());
    }
    if label.starts_with(|c: char| c.is_ascii_digit()) {
        return Some("Labels can't begin with a digit".into());
    }
    let l = label.to_ascii_lowercase();
    if l.starts_with("aws") || l.starts_with("ssm") {
        return Some("Labels can't begin with \"aws\" or \"ssm\"".into());
    }
    None
}

/// Attaches labels to a version. A label already on another version moves here.
pub async fn label_version(
    conn: &Connection,
    name: &str,
    version: i64,
    labels: &[String],
) -> Result<(), AppError> {
    if let Some(p) = labels.iter().find_map(|l| label_problem(l)) {
        return Err(AppError::new(ErrorKind::Other, p));
    }
    let out = client(conn)
        .label_parameter_version()
        .name(name)
        .parameter_version(version)
        .set_labels(Some(labels.to_vec()))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    if !out.invalid_labels().is_empty() {
        return Err(AppError::new(
            ErrorKind::Other,
            format!("Rejected labels: {}", out.invalid_labels().join(", ")),
        ));
    }
    Ok(())
}

pub async fn unlabel_version(
    conn: &Connection,
    name: &str,
    version: i64,
    labels: &[String],
) -> Result<(), AppError> {
    client(conn)
        .unlabel_parameter_version()
        .name(name)
        .parameter_version(version)
        .set_labels(Some(labels.to_vec()))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

/// Writes an old version's value (and type / KMS key) as a new version.
/// The plaintext only passes through memory here.
pub async fn restore_version(conn: &Connection, name: &str, version: i64) -> Result<i64, AppError> {
    let old = history(conn, name)
        .await?
        .into_iter()
        .find(|v| v.version == version)
        .ok_or_else(|| AppError::new(ErrorKind::Other, format!("Version {version} not found")))?;
    let value = get_value(conn, &format!("{name}:{version}"), true).await?;
    let current = describe_one(conn, name).await?;
    put(
        conn,
        &PutParam {
            name: name.to_string(),
            value,
            param_type: old.param_type,
            description: old.description,
            key_id: old.key_id,
            allowed_pattern: current.and_then(|c| c.allowed_pattern),
            data_type: old.data_type,
            tier: None,
            policies: None,
            overwrite: true,
        },
    )
    .await
}

fn tag_err(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorKind::Other, e.to_string())
}

pub async fn list_tags(conn: &Connection, name: &str) -> Result<Vec<Tag>, AppError> {
    let out = client(conn)
        .list_tags_for_resource()
        .resource_type(aws_sdk_ssm::types::ResourceTypeForTagging::Parameter)
        .resource_id(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let mut tags: Vec<Tag> = out
        .tag_list()
        .iter()
        .map(|t| Tag {
            key: t.key().to_string(),
            value: t.value().to_string(),
        })
        .collect();
    tags.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(tags)
}

/// Makes the parameter's tags exactly `tags` (adds/updates, then removes the rest).
pub async fn set_tags(conn: &Connection, name: &str, tags: &[Tag]) -> Result<(), AppError> {
    let current = list_tags(conn, name).await?;
    let client = client(conn);
    let changed: Vec<aws_sdk_ssm::types::Tag> = tags
        .iter()
        .filter(|t| !current.contains(t))
        .map(|t| {
            aws_sdk_ssm::types::Tag::builder()
                .key(&t.key)
                .value(&t.value)
                .build()
                .map_err(tag_err)
        })
        .collect::<Result<_, _>>()?;
    if !changed.is_empty() {
        client
            .add_tags_to_resource()
            .resource_type(aws_sdk_ssm::types::ResourceTypeForTagging::Parameter)
            .resource_id(name)
            .set_tags(Some(changed))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    let removed: Vec<String> = current
        .iter()
        .filter(|c| !tags.iter().any(|t| t.key == c.key))
        .map(|c| c.key.clone())
        .collect();
    if !removed.is_empty() {
        client
            .remove_tags_from_resource()
            .resource_type(aws_sdk_ssm::types::ResourceTypeForTagging::Parameter)
            .resource_id(name)
            .set_tag_keys(Some(removed))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    Ok(())
}

/// Changes tier and/or policies. SSM only changes these through PutParameter,
/// which needs the value, so the current value is re-written unchanged (in
/// memory only) and a new version results. Returns the new version.
pub async fn update_tier_policies(
    conn: &Connection,
    name: &str,
    tier: Option<String>,
    policies: Option<String>,
) -> Result<i64, AppError> {
    let cur = describe_one(conn, name)
        .await?
        .ok_or_else(|| AppError::new(ErrorKind::Other, format!("{name} no longer exists")))?;
    if cur.tier.as_deref() == Some("Advanced") && tier.as_deref() == Some("Standard") {
        return Err(AppError::new(
            ErrorKind::Other,
            "Advanced parameters can't be changed back to Standard",
        ));
    }
    let value = get_value(conn, name, cur.param_type == "SecureString").await?;
    put(
        conn,
        &PutParam {
            name: name.to_string(),
            value,
            param_type: cur.param_type,
            description: cur.description,
            key_id: cur.key_id,
            allowed_pattern: cur.allowed_pattern,
            data_type: cur.data_type,
            tier: tier.or(cur.tier),
            policies,
            overwrite: true,
        },
    )
    .await
}

// ---------------------------------------------------------------------------
// Copy / move / rename

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyPair {
    pub from: String,
    pub to: String,
    /// The destination already exists (planning only).
    #[serde(default)]
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    pub copied: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<ParamDeleteFailure>,
}

/// Destination name for `name` copied from under `from_folder` into `to_folder`
/// (both "/"-terminated; "/" is the root).
pub fn rebase(name: &str, from_folder: &str, to_folder: &str) -> String {
    let rest = if from_folder == "/" {
        name.trim_start_matches('/')
    } else {
        name.strip_prefix(from_folder).unwrap_or(name)
    };
    format!("{to_folder}{rest}")
}

/// Parent folder of a name ("/a/b" → "/a/", "b" → "/").
pub(crate) fn parent_folder(name: &str) -> String {
    match name.rfind('/') {
        Some(i) if i > 0 => name[..=i].to_string(),
        _ => "/".into(),
    }
}

/// Metadata of all parameters under a folder ("/" = everything), by name.
pub(crate) async fn describe_under(
    conn: &Connection,
    folder: &str,
) -> Result<Vec<ParamInfo>, AppError> {
    let client = client(conn);
    let filters = if folder == "/" {
        None
    } else {
        Some(vec![filter("Name", "BeginsWith", folder)?])
    };
    let mut v: Vec<ParamInfo> = describe_all(conn, &client, filters)
        .await?
        .iter()
        .map(meta_to_info)
        .collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(v)
}

/// Names of all parameters under a folder ("/" = everything).
async fn names_under(
    conn: &Connection,
    client: &Client,
    folder: &str,
) -> Result<Vec<String>, AppError> {
    let filters = if folder == "/" {
        None
    } else {
        Some(vec![filter("Name", "BeginsWith", folder)?])
    };
    let mut names: Vec<String> = describe_all(conn, client, filters)
        .await?
        .iter()
        .filter_map(|m| m.name().map(String::from))
        .collect();
    names.sort();
    Ok(names)
}

/// Works out what copying `items` (parameter names, or folders ending in "/")
/// into `dest_folder` means, or — with `rename_to` — renaming the single item.
/// Each pair says whether its destination already exists.
pub async fn plan_copy(
    conn: &Connection,
    items: &[String],
    dest_folder: &str,
    rename_to: Option<&str>,
) -> Result<Vec<CopyPair>, AppError> {
    let client = client(conn);
    let mut pairs: Vec<CopyPair> = Vec::new();
    if let Some(to) = rename_to {
        let [from] = items else {
            return Err(AppError::new(ErrorKind::Other, "Rename one item at a time"));
        };
        if from.ends_with('/') {
            let to = normalise_path(to);
            if to.starts_with(from.as_str()) {
                return Err(AppError::new(
                    ErrorKind::Other,
                    "A folder can't be moved inside itself",
                ));
            }
            for n in names_under(conn, &client, from).await? {
                pairs.push(CopyPair {
                    to: rebase(&n, from, &to),
                    from: n,
                    exists: false,
                });
            }
        } else {
            pairs.push(CopyPair {
                from: from.clone(),
                to: to.trim().to_string(),
                exists: false,
            });
        }
    } else {
        let dest = normalise_path(dest_folder);
        for item in items {
            if item.ends_with('/') {
                // The folder itself goes inside dest: /a/b/ → dest/b/…
                let base = parent_folder(item.trim_end_matches('/'));
                if dest.starts_with(item.as_str()) {
                    return Err(AppError::new(
                        ErrorKind::Other,
                        "A folder can't be copied inside itself",
                    ));
                }
                for n in names_under(conn, &client, item).await? {
                    pairs.push(CopyPair {
                        to: rebase(&n, &base, &dest),
                        from: n,
                        exists: false,
                    });
                }
            } else {
                let base = parent_folder(item);
                pairs.push(CopyPair {
                    from: item.clone(),
                    to: rebase(item, &base, &dest),
                    exists: false,
                });
            }
        }
    }
    pairs.retain(|p| p.from != p.to);
    pairs.sort_by(|a, b| a.from.cmp(&b.from));
    pairs.dedup_by(|a, b| a.from == b.from);
    if let Some(bad) = pairs
        .iter()
        .find_map(|p| name_problem(&p.to).map(|e| format!("{}: {e}", p.to)))
    {
        return Err(AppError::new(ErrorKind::Other, bad));
    }
    // Which destinations exist: one listing per destination folder.
    let mut existing = BTreeSet::new();
    let folders: BTreeSet<String> = pairs.iter().map(|p| parent_folder(&p.to)).collect();
    for f in folders {
        let filters = if f == "/" {
            None
        } else {
            Some(vec![filter("Path", "OneLevel", f.trim_end_matches('/'))?])
        };
        for m in describe_all(conn, &client, filters).await? {
            if let Some(n) = m.name() {
                existing.insert(n.to_string());
            }
        }
    }
    for p in &mut pairs {
        p.exists = existing.contains(&p.to);
    }
    Ok(pairs)
}

/// Copies each pair (value, type, KMS key, description, pattern, data type,
/// tier and tags), skipping existing destinations unless `overwrite`. With
/// `remove_source`, each source is deleted after its copy succeeded (= move).
pub async fn copy_params(
    conn: &Connection,
    pairs: &[CopyPair],
    overwrite: bool,
    remove_source: bool,
) -> Result<CopyResult, AppError> {
    let mut res = CopyResult {
        copied: Vec::new(),
        skipped: Vec::new(),
        failed: Vec::new(),
    };
    let mut to_delete = Vec::new();
    for pair in pairs {
        let outcome: Result<bool, AppError> = async {
            let src = describe_one(conn, &pair.from)
                .await?
                .ok_or_else(|| AppError::new(ErrorKind::Other, "Source no longer exists"))?;
            let value = get_value(conn, &pair.from, src.param_type == "SecureString").await?;
            let tags = list_tags(conn, &pair.from).await?;
            let put_res = put(
                conn,
                &PutParam {
                    name: pair.to.clone(),
                    value,
                    param_type: src.param_type,
                    description: src.description,
                    key_id: src.key_id,
                    allowed_pattern: src.allowed_pattern,
                    data_type: src.data_type,
                    tier: src.tier,
                    policies: None,
                    overwrite,
                },
            )
            .await;
            match put_res {
                Ok(_) => {}
                Err(e) if !overwrite && e.message.ends_with("already exists") => return Ok(false),
                Err(e) => return Err(e),
            }
            set_tags(conn, &pair.to, &tags).await?;
            Ok(true)
        }
        .await;
        match outcome {
            Ok(true) => {
                res.copied.push(pair.to.clone());
                if remove_source {
                    to_delete.push(pair.from.clone());
                }
            }
            Ok(false) => res.skipped.push(pair.to.clone()),
            Err(e) => res.failed.push(ParamDeleteFailure {
                name: pair.from.clone(),
                message: e.message,
            }),
        }
    }
    if !to_delete.is_empty() {
        let d = delete(conn, &to_delete).await?;
        for f in d.failed {
            res.failed.push(ParamDeleteFailure {
                message: format!(
                    "Copied, but the original couldn't be deleted: {}",
                    f.message
                ),
                name: f.name,
            });
        }
    }
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_children() {
        assert_eq!(normalise_path(""), "/");
        assert_eq!(normalise_path("/"), "/");
        assert_eq!(normalise_path("/app/dev"), "/app/dev/");
        assert_eq!(normalise_path("app/dev/"), "/app/dev/");

        let names = [
            "/app/dev/db/host",
            "/app/dev/db/port",
            "/app/dev/key",
            "/app/prod/key",
            "/top",
            "plain",
        ];
        let (p, f) = split_children("/", names.iter().map(|s| s.to_string()));
        assert_eq!(p.into_iter().collect::<Vec<_>>(), vec!["/top", "plain"]);
        assert_eq!(f.into_iter().collect::<Vec<_>>(), vec!["/app/"]);

        let (p, f) = split_children("/app/dev/", names.iter().map(|s| s.to_string()));
        assert_eq!(p.into_iter().collect::<Vec<_>>(), vec!["/app/dev/key"]);
        assert_eq!(f.into_iter().collect::<Vec<_>>(), vec!["/app/dev/db/"]);
    }

    #[test]
    fn names() {
        assert_eq!(name_problem("/app/dev/key"), None);
        assert_eq!(name_problem("plain.name-1_x"), None);
        assert!(name_problem("").is_some());
        assert!(name_problem("app/key").is_some());
        assert!(name_problem("/app/").is_some());
        assert!(name_problem("/a//b").is_some());
        assert!(name_problem("/app/k y").is_some());
        assert!(name_problem("/AWS/x").is_some());
        assert!(name_problem("ssm-thing").is_some());
        assert!(name_problem(&"/a".repeat(16)).is_some());
    }

    #[test]
    fn rebasing() {
        assert_eq!(rebase("/a/b/k", "/a/", "/x/"), "/x/b/k");
        assert_eq!(rebase("/a/k", "/a/", "/"), "/k");
        assert_eq!(rebase("/k", "/", "/x/"), "/x/k");
        assert_eq!(rebase("plain", "/", "/x/"), "/x/plain");
        assert_eq!(parent_folder("/a/b"), "/a/");
        assert_eq!(parent_folder("/b"), "/");
        assert_eq!(parent_folder("b"), "/");
    }

    #[test]
    fn labels() {
        assert_eq!(label_problem("live"), None);
        assert_eq!(label_problem("v1.2-rc_1"), None);
        assert!(label_problem("").is_some());
        assert!(label_problem("1st").is_some());
        assert!(label_problem("has space").is_some());
        assert!(label_problem("awsLive").is_some());
        assert!(label_problem(&"x".repeat(101)).is_some());
    }
}

#[cfg(test)]
pub(crate) mod emulator_tests {
    //! Needs an emulator on localhost:4566 (`moto_server -p 4566` or LocalStack).
    use super::*;
    use crate::profiles::ProfileInfo;

    pub(crate) async fn connect() -> Connection {
        // SAFETY: tests run single-threaded (--test-threads=1).
        unsafe {
            std::env::set_var("AWS_ACCESS_KEY_ID", "test");
            std::env::set_var("AWS_SECRET_ACCESS_KEY", "test");
        }
        let profile = ProfileInfo {
            name: "s3x-ssm-test".into(),
            region: Some("eu-west-2".into()),
            endpoint_url: None,
            sso_session: None,
        };
        let ovr = crate::settings::ConnectionOverride {
            endpoint_url: Some("http://localhost:4566".into()),
            path_style: None,
        };
        Connection::new(&profile, Some(&ovr)).await.unwrap()
    }

    pub(crate) async fn put(conn: &Connection, name: &str, value: &str, t: &str) {
        client(conn)
            .put_parameter()
            .name(name)
            .value(value)
            .r#type(t.into())
            .overwrite(true)
            .send()
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn browses_folders_and_filters_by_prefix() {
        let conn = connect().await;
        conn.set_service_region("eu-west-2");
        put(&conn, "/s3x/app/dev/db/host", "localhost", "String").await;
        put(&conn, "/s3x/app/dev/db/port", "5432", "String").await;
        put(&conn, "/s3x/app/dev/api_key", "secret!", "SecureString").await;
        put(&conn, "/s3x/app/dev/hosts", "a,b,c", "StringList").await;
        put(
            &conn,
            "/s3x/app/prod/api_key",
            "prod-secret",
            "SecureString",
        )
        .await;

        let dev = list_path(&conn, "/s3x/app/dev", true).await.unwrap();
        assert_eq!(dev.folders, vec!["/s3x/app/dev/db/"]);
        let names: Vec<_> = dev.parameters.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["/s3x/app/dev/api_key", "/s3x/app/dev/hosts"]);
        let key = &dev.parameters[0];
        assert_eq!(key.param_type, "SecureString");
        assert!(
            key.value.is_none(),
            "SecureString values are never loaded by listing"
        );
        assert_eq!(dev.parameters[1].value.as_deref(), Some("a,b,c"));

        let app = list_path(&conn, "/s3x/app/", false).await.unwrap();
        assert_eq!(app.folders, vec!["/s3x/app/dev/", "/s3x/app/prod/"]);
        assert!(app.parameters.is_empty());

        let flat = list_prefix(&conn, "/s3x/app/dev/db").await.unwrap();
        let names: Vec<_> = flat.parameters.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["/s3x/app/dev/db/host", "/s3x/app/dev/db/port"]);
        assert!(flat.parameters[1].value.is_none(), "values load per page");
        assert!(list_prefix(&conn, "  ").await.is_err());

        // Page values: secure ones and missing names are left out.
        let wanted = [
            "/s3x/app/dev/db/port",
            "/s3x/app/dev/api_key",
            "/s3x/app/dev/nope",
            "/s3x/app/dev/db/port",
        ]
        .map(String::from);
        let v = values(&conn, &wanted).await.unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(
            v.get("/s3x/app/dev/db/port").map(String::as_str),
            Some("5432")
        );
    }

    #[tokio::test]
    #[ignore]
    async fn creates_edits_and_deletes() {
        let conn = connect().await;
        conn.set_service_region("eu-west-2");
        let mut p = PutParam {
            name: "/s3x/crud/one".into(),
            value: "v1".into(),
            param_type: "String".into(),
            description: Some("first".into()),
            key_id: None,
            allowed_pattern: None,
            data_type: None,
            tier: None,
            policies: None,
            overwrite: false,
        };
        let _ = delete(&conn, &["/s3x/crud/one".into(), "/s3x/crud/two".into()]).await;
        assert_eq!(super::put(&conn, &p).await.unwrap(), 1);
        let e = super::put(&conn, &p).await.unwrap_err();
        assert!(e.message.contains("already exists"), "{}", e.message);
        p.value = "v2".into();
        p.overwrite = true;
        assert_eq!(super::put(&conn, &p).await.unwrap(), 2);
        assert_eq!(
            get_value(&conn, "/s3x/crud/one", false).await.unwrap(),
            "v2"
        );
        let info = describe_one(&conn, "/s3x/crud/one").await.unwrap().unwrap();
        assert_eq!(info.description.as_deref(), Some("first"));
        assert!(describe_one(&conn, "/s3x/crud/none")
            .await
            .unwrap()
            .is_none());

        p.name = "/s3x/crud/two".into();
        p.param_type = "SecureString".into();
        p.value = "hush".into();
        super::put(&conn, &p).await.unwrap();
        assert_ne!(
            get_value(&conn, "/s3x/crud/two", false).await.unwrap(),
            "hush"
        );
        assert_eq!(
            get_value(&conn, "/s3x/crud/two", true).await.unwrap(),
            "hush"
        );

        let r = delete(
            &conn,
            &[
                "/s3x/crud/one".into(),
                "/s3x/crud/two".into(),
                "/s3x/crud/none".into(),
            ],
        )
        .await
        .unwrap();
        assert_eq!(r.deleted.len(), 2);
        assert_eq!(r.failed.len(), 1);
        assert_eq!(r.failed[0].name, "/s3x/crud/none");
    }

    #[tokio::test]
    #[ignore]
    async fn history_labels_and_restore() {
        let conn = connect().await;
        conn.set_service_region("eu-west-2");
        let name = "/s3x/hist/key";
        let _ = delete(&conn, &[name.to_string()]).await;
        for v in ["one", "two", "three"] {
            put(&conn, name, v, "String").await;
        }
        let h = history(&conn, name).await.unwrap();
        assert_eq!(
            h.iter().map(|v| v.version).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(h[0].value.as_deref(), Some("one"));

        label_version(&conn, name, 1, &["stable".into()])
            .await
            .unwrap();
        assert!(label_version(&conn, name, 1, &["1bad".into()])
            .await
            .is_err());
        // Moving a label: attach it to another version.
        label_version(&conn, name, 2, &["stable".into()])
            .await
            .unwrap();
        let h = history(&conn, name).await.unwrap();
        assert!(h[0].labels.is_empty());
        assert_eq!(h[1].labels, vec!["stable"]);
        assert_eq!(
            get_value(&conn, &format!("{name}:stable"), false)
                .await
                .unwrap(),
            "two"
        );
        unlabel_version(&conn, name, 2, &["stable".into()])
            .await
            .unwrap();
        assert!(history(&conn, name).await.unwrap()[1].labels.is_empty());

        assert_eq!(restore_version(&conn, name, 1).await.unwrap(), 4);
        assert_eq!(get_value(&conn, name, false).await.unwrap(), "one");
        let _ = delete(&conn, &[name.to_string()]).await;
    }

    #[tokio::test]
    #[ignore]
    async fn copies_moves_and_renames() {
        let conn = connect().await;
        conn.set_service_region("eu-west-2");
        let all = |p: &str| {
            let conn = &conn;
            let p = p.to_string();
            async move { names_under(conn, &client(conn), &p).await.unwrap() }
        };
        for n in all("/s3x/cp/").await {
            let _ = delete(&conn, &[n]).await;
        }
        put(&conn, "/s3x/cp/src/a", "1", "String").await;
        put(&conn, "/s3x/cp/src/deep/b", "2", "SecureString").await;
        set_tags(
            &conn,
            "/s3x/cp/src/a",
            &[Tag {
                key: "k".into(),
                value: "v".into(),
            }],
        )
        .await
        .unwrap();
        put(&conn, "/s3x/cp/dst/src/a", "old", "String").await;

        // Copy the folder into /s3x/cp/dst/ → /s3x/cp/dst/src/…; one collision.
        let plan = plan_copy(&conn, &["/s3x/cp/src/".into()], "/s3x/cp/dst", None)
            .await
            .unwrap();
        let tos: Vec<_> = plan.iter().map(|p| (p.to.as_str(), p.exists)).collect();
        assert_eq!(
            tos,
            vec![
                ("/s3x/cp/dst/src/a", true),
                ("/s3x/cp/dst/src/deep/b", false)
            ]
        );
        let r = copy_params(&conn, &plan, false, false).await.unwrap();
        assert_eq!(r.copied, vec!["/s3x/cp/dst/src/deep/b"]);
        assert_eq!(r.skipped, vec!["/s3x/cp/dst/src/a"]);
        assert_eq!(
            get_value(&conn, "/s3x/cp/dst/src/deep/b", true)
                .await
                .unwrap(),
            "2"
        );
        let b = describe_one(&conn, "/s3x/cp/dst/src/deep/b")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(b.param_type, "SecureString");
        let r = copy_params(&conn, &plan, true, false).await.unwrap();
        assert_eq!(r.copied.len(), 2);
        assert_eq!(
            get_value(&conn, "/s3x/cp/dst/src/a", false).await.unwrap(),
            "1"
        );
        assert_eq!(
            list_tags(&conn, "/s3x/cp/dst/src/a").await.unwrap().len(),
            1
        );

        // Rename one parameter (a move).
        let plan = plan_copy(
            &conn,
            &["/s3x/cp/src/a".into()],
            "",
            Some("/s3x/cp/src/renamed"),
        )
        .await
        .unwrap();
        copy_params(&conn, &plan, false, true).await.unwrap();
        assert_eq!(
            all("/s3x/cp/src/").await,
            vec!["/s3x/cp/src/deep/b", "/s3x/cp/src/renamed"]
        );

        // Rename (move) a folder.
        let plan = plan_copy(&conn, &["/s3x/cp/src/".into()], "", Some("/s3x/cp/moved"))
            .await
            .unwrap();
        copy_params(&conn, &plan, false, true).await.unwrap();
        assert!(all("/s3x/cp/src/").await.is_empty());
        assert_eq!(
            all("/s3x/cp/moved/").await,
            vec!["/s3x/cp/moved/deep/b", "/s3x/cp/moved/renamed"]
        );
        assert!(plan_copy(
            &conn,
            &["/s3x/cp/moved/".into()],
            "/s3x/cp/moved/deep",
            None
        )
        .await
        .is_err());

        for n in all("/s3x/cp/").await {
            let _ = delete(&conn, &[n]).await;
        }
    }

    #[tokio::test]
    #[ignore]
    async fn tags_tier_and_policies() {
        let conn = connect().await;
        conn.set_service_region("eu-west-2");
        let name = "/s3x/settings/key";
        let _ = delete(&conn, &[name.to_string()]).await;
        put(&conn, name, "keep-me", "String").await;
        let t = |k: &str, v: &str| Tag {
            key: k.into(),
            value: v.into(),
        };
        set_tags(&conn, name, &[t("env", "dev"), t("team", "a")])
            .await
            .unwrap();
        assert_eq!(
            list_tags(&conn, name).await.unwrap(),
            vec![t("env", "dev"), t("team", "a")]
        );
        set_tags(&conn, name, &[t("env", "prod"), t("owner", "me")])
            .await
            .unwrap();
        assert_eq!(
            list_tags(&conn, name).await.unwrap(),
            vec![t("env", "prod"), t("owner", "me")]
        );

        let policy = r#"[{"Type":"Expiration","Version":"1.0","Attributes":{"Timestamp":"2030-01-01T00:00:00.000Z"}}]"#;
        let v = update_tier_policies(&conn, name, Some("Advanced".into()), Some(policy.into()))
            .await
            .unwrap();
        assert_eq!(v, 2);
        let info = describe_one(&conn, name).await.unwrap().unwrap();
        assert_eq!(info.tier.as_deref(), Some("Advanced"));
        assert_eq!(get_value(&conn, name, false).await.unwrap(), "keep-me");
        assert!(
            update_tier_policies(&conn, name, Some("Standard".into()), None)
                .await
                .is_err()
        );
        let _ = delete(&conn, &[name.to_string()]).await;
    }
}
