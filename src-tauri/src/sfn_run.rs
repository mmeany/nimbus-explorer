//! Step Functions: start, stop and redrive executions, and saved inputs.

use crate::error::AppError;
use crate::s3::Connection;
use crate::sfn::{client, err, other};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

/// StartExecution's input limit (256 KiB, UTF-8).
pub const MAX_INPUT: usize = 256 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub machine_arn: String,
    /// A version number or alias name; None runs the latest definition.
    pub qualifier: Option<String>,
    /// None lets AWS pick a unique name.
    pub name: Option<String>,
    pub input: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub execution_arn: String,
    pub name: String,
    pub start: Option<String>,
}

/// Why an execution name would be refused (AWS's rules), if it would.
pub fn name_problem(name: &str) -> Option<String> {
    if name.is_empty() || name.chars().count() > 80 {
        return Some("Execution names are 1 to 80 characters".into());
    }
    const BAD: &str = "<>{}[]?*\"#%\\^|~`$&,;:/";
    if let Some(c) = name
        .chars()
        .find(|c| c.is_whitespace() || c.is_control() || BAD.contains(*c))
    {
        return Some(format!(
            "Execution names can't contain {}",
            if c.is_whitespace() {
                "spaces".to_string()
            } else {
                format!("\"{c}\"")
            }
        ));
    }
    None
}

/// Why an input would be refused, if it would.
pub fn input_problem(input: &str) -> Option<String> {
    if input.len() > MAX_INPUT {
        return Some(format!(
            "The input is {} KB; Step Functions accepts at most 256 KB",
            input.len() / 1024
        ));
    }
    if let Err(e) = serde_json::from_str::<serde_json::Value>(input) {
        return Some(format!("The input isn't valid JSON: {e}"));
    }
    None
}

/// The ARN to start: the machine, one of its versions ("…:orders:3") or an alias ("…:orders:live").
pub fn target_arn(machine_arn: &str, qualifier: Option<&str>) -> String {
    match qualifier.map(str::trim).filter(|q| !q.is_empty()) {
        Some(q) => format!("{machine_arn}:{q}"),
        None => machine_arn.to_string(),
    }
}

pub async fn start(conn: &Connection, r: &StartRequest) -> Result<Started, AppError> {
    let input = if r.input.trim().is_empty() {
        "{}"
    } else {
        r.input.as_str()
    };
    if let Some(p) = input_problem(input) {
        return Err(other(p));
    }
    let name = r.name.as_deref().map(str::trim).filter(|n| !n.is_empty());
    if let Some(p) = name.and_then(name_problem) {
        return Err(other(p));
    }
    let out = client(conn)
        .start_execution()
        .state_machine_arn(target_arn(&r.machine_arn, r.qualifier.as_deref()))
        .set_name(name.map(String::from))
        .input(input)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let arn = out.execution_arn().to_string();
    Ok(Started {
        name: arn.rsplit(':').next().unwrap_or(&arn).to_string(),
        start: crate::sfn::iso(Some(out.start_date())),
        execution_arn: arn,
    })
}

/// Stops a running execution, optionally with an error code and cause.
pub async fn stop(
    conn: &Connection,
    arn: &str,
    error: Option<&str>,
    cause: Option<&str>,
) -> Result<(), AppError> {
    let error = error.map(str::trim).filter(|e| !e.is_empty());
    let cause = cause.map(str::trim).filter(|c| !c.is_empty());
    if error.is_some_and(|e| e.chars().count() > 256) {
        return Err(other("The error is at most 256 characters"));
    }
    if cause.is_some_and(|c| c.chars().count() > 32_768) {
        return Err(other("The cause is at most 32,768 characters"));
    }
    client(conn)
        .stop_execution()
        .execution_arn(arn)
        .set_error(error.map(String::from))
        .set_cause(cause.map(String::from))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

/// Restarts a failed, aborted or timed-out Standard execution from where it stopped.
pub async fn redrive(conn: &Connection, arn: &str) -> Result<Option<String>, AppError> {
    let out = client(conn)
        .redrive_execution()
        .execution_arn(arn)
        .send()
        .await
        .map_err(|e| {
            if unsupported(&e) {
                other("This endpoint doesn't support redriving executions (RedriveExecution). Emulators often leave it out; it works on AWS.")
            } else {
                err(conn, e)
            }
        })?;
    Ok(crate::sfn::iso(Some(out.redrive_date())))
}

/// The endpoint doesn't know the operation (emulators answer "Unknown action").
fn unsupported<E: std::fmt::Debug>(e: &aws_sdk_sfn::error::SdkError<E>) -> bool {
    let s = format!("{e:?}");
    s.contains("Unknown action") || s.contains("InvalidAction") || s.contains("UnknownOperation")
}

// ---------------------------------------------------------------------------
// Saved inputs: `<settings dir>/sfn-inputs.json`, keyed by
// "profile|region|machine". Local only (not AWS), so allowed in read-only mode.

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedInput {
    pub name: String,
    pub input: String,
}

type InputFile = BTreeMap<String, Vec<SavedInput>>;
static FILE_LOCK: Mutex<()> = Mutex::new(());
const FILE: &str = "sfn-inputs.json";

fn read(dir: &Path) -> InputFile {
    std::fs::read_to_string(dir.join(FILE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write(dir: &Path, f: &InputFile) -> Result<(), AppError> {
    std::fs::create_dir_all(dir).map_err(|e| other(e.to_string()))?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    std::fs::write(
        &tmp,
        serde_json::to_string_pretty(f).map_err(|e| other(e.to_string()))?,
    )
    .map_err(|e| other(e.to_string()))?;
    std::fs::rename(&tmp, dir.join(FILE)).map_err(|e| other(e.to_string()))
}

pub fn list_inputs(dir: &Path, key: &str) -> Vec<SavedInput> {
    let _g = FILE_LOCK.lock().unwrap();
    read(dir).remove(key).unwrap_or_default()
}

/// Adds or replaces the input called `name`; returns the machine's inputs (by name).
pub fn save_input(
    dir: &Path,
    key: &str,
    name: &str,
    input: &str,
) -> Result<Vec<SavedInput>, AppError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(other("Names are 1 to 100 characters"));
    }
    if let Some(p) = input_problem(input) {
        return Err(other(p));
    }
    let _g = FILE_LOCK.lock().unwrap();
    let mut f = read(dir);
    let list = f.entry(key.to_string()).or_default();
    list.retain(|e| e.name != name);
    list.push(SavedInput {
        name: name.to_string(),
        input: input.to_string(),
    });
    list.sort_by_key(|e| e.name.to_lowercase());
    let out = list.clone();
    write(dir, &f)?;
    Ok(out)
}

pub fn delete_input(dir: &Path, key: &str, name: &str) -> Result<Vec<SavedInput>, AppError> {
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
    fn checks_names_like_aws() {
        assert_eq!(name_problem("order-42_retry"), None);
        assert!(name_problem("").is_some());
        assert!(name_problem(&"x".repeat(81)).is_some());
        assert_eq!(
            name_problem("a b").as_deref(),
            Some("Execution names can't contain spaces")
        );
        assert_eq!(
            name_problem("a:b").as_deref(),
            Some("Execution names can't contain \":\"")
        );
        assert!(name_problem("a/b").is_some());
    }

    #[test]
    fn checks_inputs() {
        assert_eq!(input_problem(r#"{"a":1}"#), None);
        assert_eq!(input_problem("[1,2]"), None);
        assert!(input_problem("{nope").unwrap().contains("isn't valid JSON"));
        let big = format!("\"{}\"", "x".repeat(MAX_INPUT));
        assert!(input_problem(&big).unwrap().contains("256 KB"));
    }

    #[test]
    fn qualifiers_go_on_the_arn() {
        let m = "arn:aws:states:eu-west-1:1:stateMachine:orders";
        assert_eq!(target_arn(m, None), m);
        assert_eq!(target_arn(m, Some(" ")), m);
        assert_eq!(target_arn(m, Some("live")), format!("{m}:live"));
        assert_eq!(target_arn(m, Some("3")), format!("{m}:3"));
    }

    #[test]
    fn saves_inputs_per_machine() {
        let dir = std::env::temp_dir().join(format!("s3x-sfn-inputs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(list_inputs(&dir, "p|r|m").is_empty());
        save_input(&dir, "p|r|m", "small", r#"{"n":1}"#).unwrap();
        let after = save_input(&dir, "p|r|m", "Big", r#"{"n":2}"#).unwrap();
        assert_eq!(
            after.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["Big", "small"]
        );
        save_input(&dir, "p|r|m", "small", r#"{"n":3}"#).unwrap();
        assert_eq!(
            list_inputs(&dir, "p|r|m")
                .iter()
                .find(|e| e.name == "small")
                .unwrap()
                .input,
            r#"{"n":3}"#
        );
        assert!(list_inputs(&dir, "p|r|other").is_empty());
        assert!(save_input(&dir, "p|r|m", "bad", "{").is_err());
        assert!(save_input(&dir, "p|r|m", " ", "{}").is_err());
        delete_input(&dir, "p|r|m", "Big").unwrap();
        assert_eq!(
            delete_input(&dir, "p|r|m", "small").unwrap(),
            Vec::<SavedInput>::new()
        );
        assert!(!std::fs::read_to_string(dir.join(FILE))
            .unwrap()
            .contains("p|r|m"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::sfn::emulator_tests::{connect, fresh_machine};

    #[tokio::test]
    #[ignore]
    async fn starts_and_stops_executions() {
        let conn = connect().await;
        let c = client(&conn);
        let wait =
            r#"{"StartAt":"Hold","States":{"Hold":{"Type":"Wait","Seconds":300,"End":true}}}"#;
        let arn = fresh_machine(&conn, "s3x-sfn-run").await;
        c.update_state_machine()
            .state_machine_arn(&arn)
            .definition(wait)
            .send()
            .await
            .unwrap();

        let started = start(
            &conn,
            &StartRequest {
                machine_arn: arn.clone(),
                qualifier: None,
                name: Some("held-1".into()),
                input: r#"{"order":7}"#.into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(started.name, "held-1");
        let d = crate::sfn::execution(&conn, &started.execution_arn)
            .await
            .unwrap();
        assert_eq!(d.summary.status, "RUNNING");
        assert_eq!(d.input.as_deref(), Some(r#"{"order":7}"#));

        stop(
            &conn,
            &started.execution_arn,
            Some("Manual.Stop"),
            Some("from the test"),
        )
        .await
        .unwrap();
        let d = crate::sfn::execution(&conn, &started.execution_arn)
            .await
            .unwrap();
        assert_eq!(d.summary.status, "ABORTED");

        // Bad names and inputs never reach AWS.
        let bad = StartRequest {
            machine_arn: arn.clone(),
            qualifier: None,
            name: Some("a b".into()),
            input: "{}".into(),
        };
        assert!(start(&conn, &bad)
            .await
            .unwrap_err()
            .message
            .contains("spaces"));
        let bad = StartRequest {
            machine_arn: arn.clone(),
            qualifier: None,
            name: None,
            input: "{".into(),
        };
        assert!(start(&conn, &bad)
            .await
            .unwrap_err()
            .message
            .contains("JSON"));

        // An empty input is sent as {} and AWS names the execution.
        let auto = start(
            &conn,
            &StartRequest {
                machine_arn: arn.clone(),
                qualifier: None,
                name: None,
                input: " ".into(),
            },
        )
        .await
        .unwrap();
        assert!(!auto.name.is_empty());
        stop(&conn, &auto.execution_arn, None, None).await.unwrap();

        // An aborted execution can be redriven; emulators without the API get a plain message.
        match redrive(&conn, &started.execution_arn).await {
            Ok(_) => {}
            Err(e) => assert!(
                e.message.contains("RedriveExecution") || e.message.contains("redriv"),
                "{}",
                e.message
            ),
        }
    }
}
