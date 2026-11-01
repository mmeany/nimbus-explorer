//! Parameter Store export (JSON / .env) and import with a preview.
//!
//! Decrypted SecureString values are written to an export only when the user
//! explicitly asks (off by default). An import plan, including any values from
//! the file, stays in the backend (`ImportStore`) so secrets never travel to the
//! UI; the UI only sees names and actions and then runs the plan by id.

use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use crate::ssm::{self, PutParam, Tag};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Json,
    Env,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub exported: usize,
    /// SecureStrings written without their value.
    pub secrets_omitted: usize,
}

/// One parameter as written to / read from an export file.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportedParam {
    pub name: String,
    #[serde(rename = "type")]
    pub param_type: String,
    /// None for a SecureString exported without values.
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<Tag>,
}

/// .env variable name for `name` relative to `folder` ("/app/dev/db/host"
/// from "/app/dev/" → "DB_HOST").
pub fn env_key(name: &str, folder: &str) -> String {
    let rel = ssm::rebase(name, folder, "");
    let mut k: String = rel
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    if k.starts_with(|c: char| c.is_ascii_digit()) {
        k.insert(0, '_');
    }
    k
}

/// Double-quoted .env value with \\ \" \n \r escaped.
pub fn env_quote(v: &str) -> String {
    let mut out = String::with_capacity(v.len() + 2);
    out.push('"');
    for c in v.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Parses .env text into (key, value) pairs: `KEY=value`, optional `export `,
/// '#' comments, single quotes (literal) or double quotes (with escapes).
pub fn parse_env(text: &str) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((k, v)) = line.split_once('=') else {
            return Err(format!("Line {}: expected KEY=value", i + 1));
        };
        let k = k.trim();
        if k.is_empty() {
            return Err(format!("Line {}: missing key", i + 1));
        }
        let v = v.trim();
        let value = if let Some(inner) = v.strip_prefix('"').and_then(|x| x.strip_suffix('"')) {
            let mut s = String::new();
            let mut chars = inner.chars();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    match chars.next() {
                        Some('n') => s.push('\n'),
                        Some('r') => s.push('\r'),
                        Some(o) => s.push(o),
                        None => s.push('\\'),
                    }
                } else {
                    s.push(c);
                }
            }
            s
        } else if let Some(inner) = v.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')) {
            inner.to_string()
        } else {
            // Unquoted: drop a trailing " # comment".
            match v.find(" #") {
                Some(i) => v[..i].trim_end().to_string(),
                None => v.to_string(),
            }
        };
        out.push((k.to_string(), value));
    }
    Ok(out)
}

/// Writes every parameter under `folder` to `dest`.
pub async fn export(
    conn: &Connection,
    folder: &str,
    format: ExportFormat,
    include_secrets: bool,
    dest: &str,
) -> Result<ExportResult, AppError> {
    let folder = ssm::normalise_path(folder);
    let infos = ssm::describe_under(conn, &folder).await?;
    let mut params = Vec::with_capacity(infos.len());
    let mut omitted = 0;
    for info in infos {
        let secure = info.param_type == "SecureString";
        let value = if secure && !include_secrets {
            omitted += 1;
            None
        } else {
            Some(ssm::get_value(conn, &info.name, secure).await?)
        };
        let tags = if format == ExportFormat::Json {
            ssm::list_tags(conn, &info.name).await?
        } else {
            Vec::new()
        };
        params.push(ExportedParam {
            name: info.name,
            param_type: info.param_type,
            value,
            description: info.description,
            key_id: info.key_id,
            allowed_pattern: info.allowed_pattern,
            data_type: info.data_type,
            tier: info.tier,
            tags,
        });
    }
    let text = match format {
        ExportFormat::Json => {
            let now = aws_sdk_ssm::primitives::DateTime::from(std::time::SystemTime::now())
                .fmt(aws_sdk_ssm::primitives::DateTimeFormat::DateTime)
                .unwrap_or_default();
            let doc = json!({
                "format": "nimbus-explorer/parameter-store",
                "version": 1,
                "path": folder,
                "region": conn.service_region(),
                "exportedAt": now,
                "includesSecrets": include_secrets,
                "parameters": params,
            });
            serde_json::to_string_pretty(&doc)
                .map_err(|e| AppError::new(ErrorKind::Other, e.to_string()))?
                + "\n"
        }
        ExportFormat::Env => {
            let mut s = format!("# Parameter Store export of {folder}\n");
            for p in &params {
                let key = env_key(&p.name, &folder);
                match &p.value {
                    Some(v) => s.push_str(&format!("{key}={}\n", env_quote(v))),
                    None => s.push_str(&format!("# {key}: SecureString {} not exported\n", p.name)),
                }
            }
            s
        }
    };
    tokio::fs::write(dest, text)
        .await
        .map_err(|e| AppError::new(ErrorKind::Other, format!("Couldn't write {dest}: {e}")))?;
    Ok(ExportResult {
        path: dest.to_string(),
        exported: params.len(),
        secrets_omitted: omitted,
    })
}

// ---------------------------------------------------------------------------
// Import

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    pub path: String,
    /// Where relative names go (.env keys, plain JSON keys), and where an
    /// export's base path is moved to. None keeps names as in the file.
    pub target_folder: Option<String>,
    /// Type for .env / plain JSON entries: "String" or "SecureString".
    pub default_type: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportAction {
    Create,
    Overwrite,
    Unchanged,
    Skip,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRow {
    pub name: String,
    pub param_type: String,
    pub action: ImportAction,
    /// Why (for skip / overwrite), e.g. "value differs", "type changes".
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub plan_id: u64,
    pub rows: Vec<ImportRow>,
    pub creates: usize,
    pub overwrites: usize,
    pub unchanged: usize,
    pub skips: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub created: usize,
    pub overwritten: usize,
    pub failed: Vec<ssm::ParamDeleteFailure>,
}

struct ImportItem {
    param: ExportedParam,
    action: ImportAction,
}

/// Keeps the latest import plan; a plan runs at most once.
#[derive(Default)]
pub struct ImportStore {
    current: Mutex<Option<(u64, Vec<ImportItem>)>>,
    next: Mutex<u64>,
}

impl ImportStore {
    fn put(&self, items: Vec<ImportItem>) -> u64 {
        let mut n = self.next.lock().unwrap();
        *n += 1;
        *self.current.lock().unwrap() = Some((*n, items));
        *n
    }
    fn take(&self, id: u64) -> Option<Vec<ImportItem>> {
        let mut cur = self.current.lock().unwrap();
        match cur.as_ref() {
            Some((cid, _)) if *cid == id => cur.take().map(|(_, v)| v),
            _ => None,
        }
    }
}

fn join(folder: &str, rel: &str) -> String {
    format!(
        "{}{}",
        ssm::normalise_path(folder),
        rel.trim_start_matches('/')
    )
}

/// Reads an import file: our JSON export, a plain {"name": "value"} object, or .env.
pub fn read_import(text: &str, opts: &ImportOptions) -> Result<Vec<ExportedParam>, String> {
    let trimmed = text.trim_start();
    let default_type = if opts.default_type == "SecureString" {
        "SecureString"
    } else {
        "String"
    };
    let relative = |key: &str| -> Result<String, String> {
        match &opts.target_folder {
            Some(f) => Ok(join(f, key)),
            None if key.starts_with('/') => Ok(key.to_string()),
            None => Err(format!(
                "\"{key}\" is a relative name; choose a target folder"
            )),
        }
    };
    if trimmed.starts_with('{') {
        let v: Value = serde_json::from_str(text).map_err(|e| format!("Not valid JSON: {e}"))?;
        if let Some(list) = v.get("parameters").and_then(|p| p.as_array()) {
            let base = v
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("/")
                .to_string();
            let mut out = Vec::new();
            for item in list {
                let mut p: ExportedParam = serde_json::from_value(item.clone())
                    .map_err(|e| format!("Bad parameter entry: {e}"))?;
                if p.param_type.is_empty() {
                    p.param_type = "String".into();
                }
                if let Some(f) = &opts.target_folder {
                    p.name = ssm::rebase(
                        &p.name,
                        &ssm::normalise_path(&base),
                        &ssm::normalise_path(f),
                    );
                }
                out.push(p);
            }
            return Ok(out);
        }
        let obj = v.as_object().ok_or("Expected a JSON object")?;
        return obj
            .iter()
            .map(|(k, v)| {
                let value = match v {
                    Value::String(s) => s.clone(),
                    Value::Null => return Err(format!("\"{k}\" has no value")),
                    other => other.to_string(), // numbers, bools, nested JSON as text
                };
                Ok(ExportedParam {
                    name: relative(k)?,
                    param_type: default_type.into(),
                    value: Some(value),
                    ..Default::default()
                })
            })
            .collect();
    }
    parse_env(text)?
        .into_iter()
        .map(|(k, v)| {
            Ok(ExportedParam {
                name: relative(&k)?,
                param_type: default_type.into(),
                value: Some(v),
                ..Default::default()
            })
        })
        .collect()
}

/// Reads the file and compares it with what's there now.
pub async fn plan_import(
    conn: &Connection,
    store: &ImportStore,
    opts: &ImportOptions,
) -> Result<ImportPreview, AppError> {
    let text = tokio::fs::read_to_string(&opts.path).await.map_err(|e| {
        AppError::new(
            ErrorKind::Other,
            format!("Couldn't read {}: {e}", opts.path),
        )
    })?;
    let params = read_import(&text, opts).map_err(|e| AppError::new(ErrorKind::Other, e))?;
    // Current state of everything under the common folder, in one listing.
    let common = params
        .iter()
        .map(|p| ssm::parent_folder(&p.name))
        .reduce(|a, b| {
            let n = a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
            ssm::parent_folder(&format!("{}x", &a[..n]))
        })
        .unwrap_or_else(|| "/".into());
    let current: BTreeMap<String, ssm::ParamInfo> = ssm::describe_under(conn, &common)
        .await?
        .into_iter()
        .map(|i| (i.name.clone(), i))
        .collect();
    let mut items = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for p in params {
        let (action, note) = if !seen.insert(p.name.clone()) {
            (
                ImportAction::Skip,
                Some("Duplicate name in the file".to_string()),
            )
        } else if let Some(problem) = ssm::name_problem(&p.name) {
            (ImportAction::Skip, Some(problem))
        } else if !["String", "StringList", "SecureString"].contains(&p.param_type.as_str()) {
            (
                ImportAction::Skip,
                Some(format!("Unknown type {}", p.param_type)),
            )
        } else if p.value.as_deref().unwrap_or("").is_empty() {
            (ImportAction::Skip, Some("No value in the file".to_string()))
        } else if let Some(cur) = current.get(&p.name) {
            // Compare in memory only (decrypting a SecureString to compare).
            let now = ssm::get_value(conn, &p.name, cur.param_type == "SecureString").await?;
            if cur.param_type != p.param_type {
                (
                    ImportAction::Overwrite,
                    Some(format!("Type changes from {}", cur.param_type)),
                )
            } else if Some(now.as_str()) != p.value.as_deref() {
                (ImportAction::Overwrite, Some("Value differs".to_string()))
            } else {
                (ImportAction::Unchanged, None)
            }
        } else {
            (ImportAction::Create, None)
        };
        items.push((ImportItem { param: p, action }, note));
    }
    let rows: Vec<ImportRow> = items
        .iter()
        .map(|(i, note)| ImportRow {
            name: i.param.name.clone(),
            param_type: i.param.param_type.clone(),
            action: i.action,
            note: note.clone(),
        })
        .collect();
    let count = |a: ImportAction| rows.iter().filter(|r| r.action == a).count();
    let preview_counts = (
        count(ImportAction::Create),
        count(ImportAction::Overwrite),
        count(ImportAction::Unchanged),
        count(ImportAction::Skip),
    );
    let plan_id = store.put(items.into_iter().map(|(i, _)| i).collect());
    Ok(ImportPreview {
        plan_id,
        rows,
        creates: preview_counts.0,
        overwrites: preview_counts.1,
        unchanged: preview_counts.2,
        skips: preview_counts.3,
    })
}

/// Runs a previewed plan. `include_overwrites: false` only creates.
pub async fn run_import(
    conn: &Connection,
    store: &ImportStore,
    plan_id: u64,
    include_overwrites: bool,
) -> Result<ImportResult, AppError> {
    let items = store.take(plan_id).ok_or_else(|| {
        AppError::new(
            ErrorKind::Other,
            "This preview has expired; preview the import again",
        )
    })?;
    let mut res = ImportResult {
        created: 0,
        overwritten: 0,
        failed: Vec::new(),
    };
    for item in items {
        let overwrite = match item.action {
            ImportAction::Create => false,
            ImportAction::Overwrite if include_overwrites => true,
            _ => continue,
        };
        let p = item.param;
        let r = async {
            ssm::put(
                conn,
                &PutParam {
                    name: p.name.clone(),
                    value: p.value.clone().unwrap_or_default(),
                    param_type: p.param_type.clone(),
                    description: p.description.clone(),
                    key_id: p.key_id.clone(),
                    allowed_pattern: p.allowed_pattern.clone(),
                    data_type: p.data_type.clone(),
                    tier: p.tier.clone(),
                    policies: None,
                    overwrite,
                },
            )
            .await?;
            if !p.tags.is_empty() {
                ssm::set_tags(conn, &p.name, &p.tags).await?;
            }
            Ok::<(), AppError>(())
        }
        .await;
        match r {
            Ok(()) if overwrite => res.overwritten += 1,
            Ok(()) => res.created += 1,
            Err(e) => res.failed.push(ssm::ParamDeleteFailure {
                name: p.name,
                message: e.message,
            }),
        }
    }
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_round_trip() {
        assert_eq!(env_key("/app/dev/db/host", "/app/dev/"), "DB_HOST");
        assert_eq!(env_key("/app/dev/1st-key", "/app/dev/"), "_1ST_KEY");
        assert_eq!(env_key("/top.level", "/"), "TOP_LEVEL");
        let v = "multi\nline \"quoted\" back\\slash";
        let text = format!(
            "# c\nexport A={}\nB=plain value # comment\nC='lit\\n'\n\nD=\n",
            env_quote(v)
        );
        let parsed = parse_env(&text).unwrap();
        assert_eq!(
            parsed,
            vec![
                ("A".into(), v.to_string()),
                ("B".into(), "plain value".into()),
                ("C".into(), "lit\\n".into()),
                ("D".into(), "".into()),
            ]
        );
        assert!(parse_env("nonsense").is_err());
    }

    #[test]
    fn reads_import_formats() {
        let opts = |t: Option<&str>| ImportOptions {
            path: String::new(),
            target_folder: t.map(String::from),
            default_type: "String".into(),
        };
        let export = r#"{"path":"/app/dev/","parameters":[
            {"name":"/app/dev/db/host","type":"String","value":"h","tags":[{"key":"k","value":"v"}]},
            {"name":"/app/dev/pw","type":"SecureString","value":null}]}"#;
        let same = read_import(export, &opts(None)).unwrap();
        assert_eq!(same[0].name, "/app/dev/db/host");
        assert_eq!(same[0].tags.len(), 1);
        assert_eq!(same[1].value, None);
        let moved = read_import(export, &opts(Some("/app/test"))).unwrap();
        assert_eq!(moved[0].name, "/app/test/db/host");

        let plain = r#"{"db/host":"h","port":5432,"flags":{"a":true}}"#;
        assert!(
            read_import(plain, &opts(None)).is_err(),
            "relative names need a folder"
        );
        let p = read_import(plain, &opts(Some("/x/"))).unwrap();
        let names: Vec<_> = p
            .iter()
            .map(|p| (p.name.as_str(), p.value.as_deref().unwrap()))
            .collect();
        assert_eq!(
            names,
            vec![
                ("/x/db/host", "h"),
                ("/x/port", "5432"),
                ("/x/flags", r#"{"a":true}"#)
            ]
        );

        let env = read_import("DB_HOST=h\n", &opts(Some("/svc"))).unwrap();
        assert_eq!(env[0].name, "/svc/DB_HOST");
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::ssm::emulator_tests::{connect, put};

    #[tokio::test]
    #[ignore]
    async fn exports_and_imports() {
        let conn = connect().await;
        conn.set_service_region("eu-west-2");
        for n in ssm::describe_under(&conn, "/s3x/io/").await.unwrap() {
            let _ = ssm::delete(&conn, &[n.name]).await;
        }
        put(&conn, "/s3x/io/src/host", "h1", "String").await;
        put(&conn, "/s3x/io/src/pw", "secret", "SecureString").await;
        let dir = std::env::temp_dir().join("s3x-ssm-io");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("export.json").to_string_lossy().into_owned();

        let r = export(&conn, "/s3x/io/src", ExportFormat::Json, false, &file)
            .await
            .unwrap();
        assert_eq!((r.exported, r.secrets_omitted), (2, 1));
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(!text.contains("secret"), "secrets are omitted by default");

        let env_file = dir.join("export.env").to_string_lossy().into_owned();
        export(&conn, "/s3x/io/src", ExportFormat::Env, true, &env_file)
            .await
            .unwrap();
        let env = std::fs::read_to_string(&env_file).unwrap();
        assert!(
            env.contains("HOST=\"h1\"") && env.contains("PW=\"secret\""),
            "{env}"
        );

        // Import the JSON export into another folder: host is created, pw skipped.
        let store = ImportStore::default();
        let opts = ImportOptions {
            path: file.clone(),
            target_folder: Some("/s3x/io/dst".into()),
            default_type: "String".into(),
        };
        let pv = plan_import(&conn, &store, &opts).await.unwrap();
        assert_eq!((pv.creates, pv.skips), (1, 1));
        let res = run_import(&conn, &store, pv.plan_id, true).await.unwrap();
        assert_eq!(res.created, 1);
        assert!(
            run_import(&conn, &store, pv.plan_id, true).await.is_err(),
            "runs once"
        );

        // .env import: keys go under the target folder as-is; host exists (as String).
        let opts = ImportOptions {
            path: env_file.clone(),
            target_folder: Some("/s3x/io/dst".into()),
            default_type: "SecureString".into(),
        };
        std::fs::write(&env_file, "host=h1\nPW=changed\n").unwrap();
        let pv = plan_import(&conn, &store, &opts).await.unwrap();
        let acts: Vec<_> = pv
            .rows
            .iter()
            .map(|r| (r.name.as_str(), r.action))
            .collect();
        assert_eq!(
            acts,
            vec![
                ("/s3x/io/dst/host", ImportAction::Overwrite),
                ("/s3x/io/dst/PW", ImportAction::Create)
            ]
        );
        assert_eq!(pv.rows[0].note.as_deref(), Some("Type changes from String"));
        run_import(&conn, &store, pv.plan_id, false).await.unwrap();
        assert_eq!(
            ssm::get_value(&conn, "/s3x/io/dst/PW", true).await.unwrap(),
            "changed"
        );
        assert_eq!(
            ssm::describe_one(&conn, "/s3x/io/dst/host")
                .await
                .unwrap()
                .unwrap()
                .param_type,
            "String",
            "overwrites skipped when not included"
        );
        for n in ssm::describe_under(&conn, "/s3x/io/").await.unwrap() {
            let _ = ssm::delete(&conn, &[n.name]).await;
        }
    }
}
