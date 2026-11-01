//! Invoking Lambda functions, and the test events saved per function.

use crate::error::AppError;
use crate::lambda::{client, err, other};
use crate::s3::Connection;
use aws_sdk_lambda::types::{InvocationType, LogType};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

/// Largest synchronous payload Lambda accepts (6 MB).
const MAX_PAYLOAD: usize = 6 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvokeRequest {
    pub name: String,
    /// Version or alias; None = $LATEST.
    pub qualifier: Option<String>,
    /// JSON text ("" = {}).
    pub payload: String,
    /// Event (asynchronous) instead of RequestResponse.
    pub asynchronous: bool,
}

/// Figures from the REPORT line Lambda writes at the end of each invocation.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub request_id: Option<String>,
    pub duration_ms: Option<f64>,
    pub billed_ms: Option<f64>,
    pub memory_mb: Option<f64>,
    pub max_memory_used_mb: Option<f64>,
    pub init_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InvokeResult {
    pub status_code: i32,
    /// "Unhandled" / "Handled" when the function threw.
    pub function_error: Option<String>,
    pub payload: String,
    /// Last 4 KB of the function's log (synchronous calls).
    pub log_tail: Option<String>,
    pub executed_version: Option<String>,
    pub report: Option<Report>,
    pub elapsed_ms: u64,
}

/// Parses "REPORT RequestId: …\tDuration: 12.3 ms\tBilled Duration: 13 ms\t…".
pub fn parse_report(log: &str) -> Option<Report> {
    let line = log.lines().rev().find(|l| l.starts_with("REPORT "))?;
    let mut r = Report::default();
    for part in line.trim_start_matches("REPORT ").split('\t') {
        let Some((k, v)) = part.split_once(':') else {
            continue;
        };
        let v = v.trim();
        let num = || {
            v.split_whitespace()
                .next()
                .and_then(|n| n.parse::<f64>().ok())
        };
        match k.trim() {
            "RequestId" => r.request_id = Some(v.to_string()),
            "Duration" => r.duration_ms = num(),
            "Billed Duration" => r.billed_ms = num(),
            "Memory Size" => r.memory_mb = num(),
            "Max Memory Used" => r.max_memory_used_mb = num(),
            "Init Duration" => r.init_ms = num(),
            _ => {}
        }
    }
    Some(r)
}

pub fn payload_problem(payload: &str) -> Option<String> {
    if payload.len() > MAX_PAYLOAD {
        return Some("The event is larger than Lambda's 6 MB limit".into());
    }
    if payload.trim().is_empty() {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(payload)
        .err()
        .map(|e| format!("The event isn't valid JSON: {e}"))
}

pub async fn invoke(conn: &Connection, r: &InvokeRequest) -> Result<InvokeResult, AppError> {
    if let Some(p) = payload_problem(&r.payload) {
        return Err(other(p));
    }
    let body = if r.payload.trim().is_empty() {
        "{}".to_string()
    } else {
        r.payload.clone()
    };
    let started = std::time::Instant::now();
    let mut req = client(conn)
        .invoke()
        .function_name(&r.name)
        .set_qualifier(r.qualifier.clone().filter(|q| !q.is_empty()))
        .payload(aws_smithy_types::Blob::new(body.into_bytes()));
    req = if r.asynchronous {
        req.invocation_type(InvocationType::Event)
    } else {
        req.invocation_type(InvocationType::RequestResponse)
            .log_type(LogType::Tail)
    };
    let out = req.send().await.map_err(|e| err(conn, e))?;
    let log_tail = out
        .log_result()
        .and_then(|b| aws_smithy_types::base64::decode(b).ok())
        .map(|b| String::from_utf8_lossy(&b).into_owned());
    Ok(InvokeResult {
        status_code: out.status_code(),
        function_error: out.function_error().map(String::from),
        payload: out
            .payload()
            .map(|p| String::from_utf8_lossy(p.as_ref()).into_owned())
            .unwrap_or_default(),
        report: log_tail.as_deref().and_then(parse_report),
        log_tail,
        executed_version: out.executed_version().map(String::from),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

// ---------------------------------------------------------------------------
// Saved test events: `<settings dir>/lambda-test-events.json`, keyed by
// "profile|region|function". Local only (not AWS), so allowed in read-only mode.

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TestEvent {
    pub name: String,
    pub payload: String,
}

type EventFile = BTreeMap<String, Vec<TestEvent>>;
static FILE_LOCK: Mutex<()> = Mutex::new(());
const FILE: &str = "lambda-test-events.json";

fn read(dir: &Path) -> EventFile {
    std::fs::read_to_string(dir.join(FILE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write(dir: &Path, f: &EventFile) -> Result<(), AppError> {
    std::fs::create_dir_all(dir).map_err(|e| other(e.to_string()))?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    std::fs::write(
        &tmp,
        serde_json::to_string_pretty(f).map_err(|e| other(e.to_string()))?,
    )
    .map_err(|e| other(e.to_string()))?;
    std::fs::rename(&tmp, dir.join(FILE)).map_err(|e| other(e.to_string()))
}

pub fn list_events(dir: &Path, key: &str) -> Vec<TestEvent> {
    let _g = FILE_LOCK.lock().unwrap();
    read(dir).remove(key).unwrap_or_default()
}

/// Adds or replaces the event called `name`; returns the function's events (by name).
pub fn save_event(
    dir: &Path,
    key: &str,
    name: &str,
    payload: &str,
) -> Result<Vec<TestEvent>, AppError> {
    let name = name.trim();
    if name.is_empty() || name.len() > 100 {
        return Err(other("Event names are 1 to 100 characters"));
    }
    if let Some(p) = payload_problem(payload) {
        return Err(other(p));
    }
    let _g = FILE_LOCK.lock().unwrap();
    let mut f = read(dir);
    let list = f.entry(key.to_string()).or_default();
    list.retain(|e| e.name != name);
    list.push(TestEvent {
        name: name.to_string(),
        payload: payload.to_string(),
    });
    list.sort_by_key(|e| e.name.to_lowercase());
    let out = list.clone();
    write(dir, &f)?;
    Ok(out)
}

pub fn delete_event(dir: &Path, key: &str, name: &str) -> Result<Vec<TestEvent>, AppError> {
    let _g = FILE_LOCK.lock().unwrap();
    let mut f = read(dir);
    let out = match f.get_mut(key) {
        Some(list) => {
            list.retain(|e| e.name != name);
            list.clone()
        }
        None => Vec::new(),
    };
    if out.is_empty() {
        f.remove(key);
    }
    write(dir, &f)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_reports() {
        let log = "START RequestId: abc Version: $LATEST\nhello\nEND RequestId: abc\nREPORT RequestId: abc\tDuration: 12.34 ms\tBilled Duration: 13 ms\tMemory Size: 128 MB\tMax Memory Used: 70 MB\tInit Duration: 150.12 ms\t\n";
        assert_eq!(
            parse_report(log),
            Some(Report {
                request_id: Some("abc".into()),
                duration_ms: Some(12.34),
                billed_ms: Some(13.0),
                memory_mb: Some(128.0),
                max_memory_used_mb: Some(70.0),
                init_ms: Some(150.12)
            })
        );
        assert_eq!(parse_report("no report here"), None);
    }

    #[test]
    fn checks_payloads() {
        assert!(payload_problem("").is_none());
        assert!(payload_problem(r#"{"a": 1}"#).is_none());
        assert!(payload_problem("{oops").unwrap().contains("valid JSON"));
    }

    #[test]
    fn saves_events_per_function() {
        let dir = std::env::temp_dir().join(format!("s3x-events-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(list_events(&dir, "p|r|f").is_empty());
        save_event(&dir, "p|r|f", "order", r#"{"id": 1}"#).unwrap();
        let after = save_event(&dir, "p|r|f", "Big order", r#"{"id": 2}"#).unwrap();
        assert_eq!(
            after.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["Big order", "order"]
        );
        // Same name replaces.
        save_event(&dir, "p|r|f", "order", r#"{"id": 3}"#).unwrap();
        let l = list_events(&dir, "p|r|f");
        assert_eq!(l.len(), 2);
        assert_eq!(l[1].payload, r#"{"id": 3}"#);
        assert!(list_events(&dir, "p|r|other").is_empty());
        assert!(save_event(&dir, "p|r|f", "bad", "{x").is_err());
        assert!(save_event(&dir, "p|r|f", "  ", "{}").is_err());
        delete_event(&dir, "p|r|f", "order").unwrap();
        assert_eq!(list_events(&dir, "p|r|f").len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
