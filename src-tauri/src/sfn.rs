//! Step Functions: state machines, executions and their event history.

use crate::ecs_taskdefs::CaptureBody;
use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use aws_sdk_sfn::types::ExecutionStatus;
use aws_sdk_sfn::Client;
use serde::Serialize;
use serde_json::Value;

/// DescribeStateMachine calls in flight at once for a page of the list.
const DESCRIBE_CONCURRENCY: usize = 8;

pub fn client(conn: &Connection) -> Client {
    Client::new(&conn.service_config())
}

pub(crate) fn err(conn: &Connection, e: impl std::error::Error) -> AppError {
    AppError::from_sdk(e, &conn.info.profile, conn.info.endpoint_url.as_deref())
}

pub(crate) fn other(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Other, msg)
}

pub(crate) fn iso(d: Option<&aws_smithy_types::DateTime>) -> Option<String> {
    d.and_then(|d| d.fmt(aws_smithy_types::date_time::Format::DateTime).ok())
}

/// "arn:aws:logs:eu-west-1:123:log-group:/aws/states/orders:*" → "/aws/states/orders".
pub fn log_group_name(arn: &str) -> Option<String> {
    let rest = arn.split_once(":log-group:")?.1;
    let name = rest.strip_suffix(":*").unwrap_or(rest);
    (!name.is_empty()).then(|| name.to_string())
}

/// A state machine as ListStateMachines returns it (cheap; every one is listed).
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MachineRef {
    pub name: String,
    pub arn: String,
    /// STANDARD or EXPRESS.
    pub kind: String,
    pub created: Option<String>,
}

/// Every state machine in the region (ListStateMachines, 1,000 per call), by name.
pub async fn list(conn: &Connection) -> Result<Vec<MachineRef>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .list_state_machines()
            .max_results(1000)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.state_machines().iter().map(|m| MachineRef {
            name: m.name().to_string(),
            arn: m.state_machine_arn().to_string(),
            kind: m.r#type().as_str().to_string(),
            created: iso(Some(m.creation_date())),
        }));
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Logging {
    /// ALL, ERROR, FATAL or OFF.
    pub level: String,
    pub include_execution_data: bool,
    pub log_group_arn: Option<String>,
    pub log_group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Encryption {
    /// AWS_OWNED_KEY or CUSTOMER_MANAGED_KMS_KEY.
    pub kind: String,
    pub kms_key_id: Option<String>,
    pub reuse_period_secs: Option<i32>,
}

/// One state machine (DescribeStateMachine). The list asks for these only for
/// its visible page; `error` is set when one couldn't be read.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MachineDetails {
    pub name: String,
    pub arn: String,
    pub kind: String,
    /// ACTIVE or DELETING.
    pub status: Option<String>,
    pub description: Option<String>,
    pub created: Option<String>,
    pub role_arn: Option<String>,
    pub revision_id: Option<String>,
    /// The ASL (JSON) as stored.
    pub definition: String,
    pub logging: Option<Logging>,
    pub tracing: bool,
    pub encryption: Option<Encryption>,
    /// Only filled by `describe` (one machine), not by `details_many`.
    pub tags: Vec<(String, String)>,
    pub error: Option<String>,
}

fn details_from(
    out: &aws_sdk_sfn::operation::describe_state_machine::DescribeStateMachineOutput,
) -> MachineDetails {
    let logging = out.logging_configuration().map(|l| {
        let arn = l
            .destinations()
            .iter()
            .find_map(|d| d.cloud_watch_logs_log_group()?.log_group_arn())
            .map(String::from);
        Logging {
            level: l
                .level()
                .map(|v| v.as_str().to_string())
                .unwrap_or_else(|| "OFF".into()),
            include_execution_data: l.include_execution_data(),
            log_group: arn.as_deref().and_then(log_group_name),
            log_group_arn: arn,
        }
    });
    MachineDetails {
        name: out.name().to_string(),
        arn: out.state_machine_arn().to_string(),
        kind: out.r#type().as_str().to_string(),
        status: out.status().map(|s| s.as_str().to_string()),
        description: out
            .description()
            .filter(|d| !d.is_empty())
            .map(String::from),
        created: iso(Some(out.creation_date())),
        role_arn: Some(out.role_arn().to_string()).filter(|r| !r.is_empty()),
        revision_id: out.revision_id().map(String::from),
        definition: out.definition().to_string(),
        logging,
        tracing: out
            .tracing_configuration()
            .map(|t| t.enabled())
            .unwrap_or(false),
        encryption: out.encryption_configuration().map(|e| Encryption {
            kind: e.r#type().as_str().to_string(),
            kms_key_id: e.kms_key_id().map(String::from),
            reuse_period_secs: e.kms_data_key_reuse_period_seconds(),
        }),
        tags: Vec::new(),
        error: None,
    }
}

/// Details for the given machines (the visible page), 8 at a time, in the order given.
pub async fn details_many(
    conn: &Connection,
    arns: &[String],
) -> Result<Vec<MachineDetails>, AppError> {
    let c = client(conn);
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(DESCRIBE_CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    for (i, arn) in arns.iter().enumerate() {
        let (c, arn, sem) = (c.clone(), arn.clone(), sem.clone());
        let (profile, endpoint) = (conn.info.profile.clone(), conn.info.endpoint_url.clone());
        set.spawn(async move {
            let _permit = sem.acquire().await;
            let r = c
                .describe_state_machine()
                .state_machine_arn(&arn)
                .send()
                .await
                .map_err(|e| AppError::from_sdk(e, &profile, endpoint.as_deref()));
            (i, r.map(|o| details_from(&o)))
        });
    }
    let mut out: Vec<MachineDetails> = arns
        .iter()
        .map(|a| MachineDetails {
            name: a.rsplit(':').next().unwrap_or(a).to_string(),
            arn: a.clone(),
            ..Default::default()
        })
        .collect();
    while let Some(joined) = set.join_next().await {
        let Ok((i, r)) = joined else { continue };
        match r {
            Ok(d) => out[i] = d,
            Err(e) => out[i].error = Some(e.message),
        }
    }
    Ok(out)
}

/// One machine with its tags.
pub async fn describe(conn: &Connection, arn: &str) -> Result<MachineDetails, AppError> {
    let c = client(conn);
    let out = c
        .describe_state_machine()
        .state_machine_arn(arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let mut d = details_from(&out);
    // Not every emulator has tags; the details are still useful without them.
    if let Ok(t) = c.list_tags_for_resource().resource_arn(arn).send().await {
        d.tags = t
            .tags()
            .iter()
            .map(|t| {
                (
                    t.key().unwrap_or_default().to_string(),
                    t.value().unwrap_or_default().to_string(),
                )
            })
            .collect();
        d.tags.sort();
    }
    Ok(d)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionSummary {
    pub name: String,
    pub arn: String,
    /// RUNNING, SUCCEEDED, FAILED, TIMED_OUT, ABORTED or PENDING_REDRIVE.
    pub status: String,
    pub start: Option<String>,
    pub stop: Option<String>,
    pub version_arn: Option<String>,
    pub alias_arn: Option<String>,
    pub map_run_arn: Option<String>,
    pub redrive_count: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionPage {
    pub items: Vec<ExecutionSummary>,
    pub next_token: Option<String>,
}

/// One page of a Standard machine's executions, newest first.
pub async fn executions(
    conn: &Connection,
    machine_arn: &str,
    status: Option<&str>,
    token: Option<String>,
    page_size: i32,
) -> Result<ExecutionPage, AppError> {
    let out = client(conn)
        .list_executions()
        .state_machine_arn(machine_arn)
        .set_status_filter(status.filter(|s| !s.is_empty()).map(ExecutionStatus::from))
        .max_results(page_size.clamp(1, 1000))
        .set_next_token(token)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(ExecutionPage {
        items: out
            .executions()
            .iter()
            .map(|e| ExecutionSummary {
                name: e.name().to_string(),
                arn: e.execution_arn().to_string(),
                status: e.status().as_str().to_string(),
                start: iso(Some(e.start_date())),
                stop: iso(e.stop_date()),
                version_arn: e.state_machine_version_arn().map(String::from),
                alias_arn: e.state_machine_alias_arn().map(String::from),
                map_run_arn: e.map_run_arn().map(String::from),
                redrive_count: e.redrive_count(),
            })
            .collect(),
        next_token: out.next_token().filter(|t| !t.is_empty()).map(String::from),
    })
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionDetails {
    #[serde(flatten)]
    pub summary: ExecutionSummary,
    pub machine_arn: String,
    /// None when AWS left it out (too large, or the execution data isn't logged).
    pub input: Option<String>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub cause: Option<String>,
    pub redrive_status: Option<String>,
    pub redrive_status_reason: Option<String>,
    pub trace_header: Option<String>,
}

pub async fn execution(conn: &Connection, arn: &str) -> Result<ExecutionDetails, AppError> {
    let e = client(conn)
        .describe_execution()
        .execution_arn(arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(ExecutionDetails {
        summary: ExecutionSummary {
            name: e.name().unwrap_or_default().to_string(),
            arn: e.execution_arn().to_string(),
            status: e.status().as_str().to_string(),
            start: iso(Some(e.start_date())),
            stop: iso(e.stop_date()),
            version_arn: e.state_machine_version_arn().map(String::from),
            alias_arn: e.state_machine_alias_arn().map(String::from),
            map_run_arn: e.map_run_arn().map(String::from),
            redrive_count: e.redrive_count(),
        },
        machine_arn: e.state_machine_arn().to_string(),
        input: e.input().map(String::from),
        output: e.output().map(String::from),
        error: e.error().map(String::from),
        cause: e.cause().map(String::from),
        redrive_status: e.redrive_status().map(|s| s.as_str().to_string()),
        redrive_status_reason: e.redrive_status_reason().map(String::from),
        trace_header: e.trace_header().map(String::from),
    })
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    /// Events as AWS returned them (every `…EventDetails` kept), with
    /// `timestamp` turned into an ISO date.
    pub events: Vec<Value>,
    pub next_token: Option<String>,
}

/// Seconds since the epoch (as the JSON protocol sends dates) → ISO date.
fn epoch_to_iso(v: &Value) -> Option<String> {
    let secs = v.as_f64()?;
    iso(Some(&aws_smithy_types::DateTime::from_secs_f64(secs)))
}

/// Turns GetExecutionHistory's raw response into a page.
fn history_page(body: &[u8]) -> Result<HistoryPage, AppError> {
    let v: Value = serde_json::from_slice(body)
        .map_err(|e| other(format!("Couldn't read the execution history: {e}")))?;
    let mut events: Vec<Value> = v
        .get("events")
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();
    for ev in &mut events {
        if let Some(obj) = ev.as_object_mut() {
            if let Some(ts) = obj.get("timestamp").and_then(epoch_to_iso) {
                obj.insert("timestamp".into(), Value::String(ts));
            }
        }
    }
    Ok(HistoryPage {
        events,
        next_token: v
            .get("nextToken")
            .and_then(|t| t.as_str())
            .filter(|t| !t.is_empty())
            .map(String::from),
    })
}

/// One page of an execution's events, oldest first. The SDK's event types
/// can't be serialised, so the raw response body is kept (as for ECS task
/// definitions) and every event detail survives as AWS sent it.
pub async fn history(
    conn: &Connection,
    arn: &str,
    token: Option<String>,
    page_size: i32,
) -> Result<HistoryPage, AppError> {
    let capture = CaptureBody::default();
    client(conn)
        .get_execution_history()
        .execution_arn(arn)
        .max_results(page_size.clamp(1, 1000))
        .include_execution_data(true)
        .set_next_token(token)
        .customize()
        .interceptor(capture.clone())
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let body = capture
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| other("AWS didn't return the execution history"))?;
    history_page(&body)
}

/// Most events read for an execution's graph (25 pages of 1,000).
pub const HISTORY_LIMIT: usize = 25_000;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FullHistory {
    pub events: Vec<Value>,
    /// More events exist than were read (see HISTORY_LIMIT).
    pub truncated: bool,
}

/// Every event of an execution, oldest first, up to `limit` (for the graph).
pub async fn history_all(
    conn: &Connection,
    arn: &str,
    limit: usize,
) -> Result<FullHistory, AppError> {
    let mut events = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = history(conn, arn, token.take(), 1000).await?;
        events.extend(page.events);
        match page.next_token {
            Some(t) if events.len() < limit => token = Some(t),
            Some(_) => {
                events.truncate(limit);
                return Ok(FullHistory {
                    events,
                    truncated: true,
                });
            }
            None => {
                return Ok(FullHistory {
                    events,
                    truncated: false,
                })
            }
        }
    }
}

/// The definition the execution ran with (its version may be older than the machine's).
pub async fn execution_definition(conn: &Connection, arn: &str) -> Result<String, AppError> {
    let out = client(conn)
        .describe_state_machine_for_execution()
        .execution_arn(arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out.definition().to_string())
}

/// Writes an exported graph: to `<dest>.s3x-part`, renamed when complete.
pub async fn save_svg(dest: &str, svg: &str) -> Result<(), AppError> {
    if !svg.trim_start().starts_with("<?xml") && !svg.trim_start().starts_with("<svg") {
        return Err(other("That isn't an SVG document."));
    }
    let part = format!("{dest}.s3x-part");
    tokio::fs::write(&part, svg)
        .await
        .map_err(|e| other(format!("Couldn't save {dest}: {e}")))?;
    if let Err(e) = tokio::fs::rename(&part, dest).await {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(other(format!("Couldn't save {dest}: {e}")));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub arn: String,
    /// "3" from "…:orders:3".
    pub version: String,
    pub created: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RouteInfo {
    pub version_arn: String,
    pub version: String,
    pub weight: i32,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AliasInfo {
    pub name: String,
    pub arn: String,
    pub description: Option<String>,
    pub created: Option<String>,
    pub routing: Vec<RouteInfo>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Versions {
    /// Newest first.
    pub versions: Vec<VersionInfo>,
    pub aliases: Vec<AliasInfo>,
}

fn version_of(arn: &str) -> String {
    arn.rsplit(':').next().unwrap_or(arn).to_string()
}

/// Published versions and aliases (with their routing).
pub async fn versions(conn: &Connection, machine_arn: &str) -> Result<Versions, AppError> {
    let c = client(conn);
    let mut versions = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .list_state_machine_versions()
            .state_machine_arn(machine_arn)
            .max_results(1000)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        versions.extend(page.state_machine_versions().iter().map(|v| VersionInfo {
            arn: v.state_machine_version_arn().to_string(),
            version: version_of(v.state_machine_version_arn()),
            created: iso(Some(v.creation_date())),
        }));
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    versions.sort_by_key(|v| std::cmp::Reverse(v.version.parse::<u64>().unwrap_or(0)));

    let mut alias_arns = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .list_state_machine_aliases()
            .state_machine_arn(machine_arn)
            .max_results(100)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        alias_arns.extend(
            page.state_machine_aliases()
                .iter()
                .map(|a| a.state_machine_alias_arn().to_string()),
        );
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    let mut aliases = Vec::new();
    for arn in alias_arns {
        let a = c
            .describe_state_machine_alias()
            .state_machine_alias_arn(&arn)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        aliases.push(AliasInfo {
            name: a
                .name()
                .map(String::from)
                .unwrap_or_else(|| version_of(&arn)),
            description: a.description().filter(|d| !d.is_empty()).map(String::from),
            created: iso(a.creation_date()),
            routing: a
                .routing_configuration()
                .iter()
                .map(|r| RouteInfo {
                    version_arn: r.state_machine_version_arn().to_string(),
                    version: version_of(r.state_machine_version_arn()),
                    weight: r.weight(),
                })
                .collect(),
            arn,
        });
    }
    aliases.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Versions { versions, aliases })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_group_names_come_from_arns() {
        assert_eq!(
            log_group_name(
                "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/vendedlogs/states/orders:*"
            )
            .as_deref(),
            Some("/aws/vendedlogs/states/orders")
        );
        assert_eq!(
            log_group_name("arn:aws:logs:eu-west-1:1:log-group:plain").as_deref(),
            Some("plain")
        );
        assert_eq!(log_group_name("not-an-arn"), None);
    }

    #[test]
    fn history_keeps_every_detail_and_formats_dates() {
        let body = br#"{"events":[
            {"timestamp":1767225600.5,"type":"ExecutionStarted","id":1,"previousEventId":0,
             "executionStartedEventDetails":{"input":"{}","roleArn":"arn:aws:iam::1:role/r","someNewField":true}},
            {"timestamp":1767225601,"type":"PassStateEntered","id":2,"previousEventId":1,
             "stateEnteredEventDetails":{"name":"First","input":"{}"}}
        ],"nextToken":"abc"}"#;
        let p = history_page(body).unwrap();
        assert_eq!(p.next_token.as_deref(), Some("abc"));
        assert_eq!(p.events.len(), 2);
        assert_eq!(p.events[0]["timestamp"], "2026-01-01T00:00:00.5Z");
        assert_eq!(
            p.events[0]["executionStartedEventDetails"]["someNewField"],
            true
        );
        assert_eq!(p.events[1]["stateEnteredEventDetails"]["name"], "First");
        assert_eq!(history_page(br#"{"events":[]}"#).unwrap().next_token, None);
    }

    #[tokio::test]
    async fn saves_svg_and_refuses_other_text() {
        let dir = std::env::temp_dir().join(format!("s3x-sfn-svg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("graph.svg").to_string_lossy().into_owned();
        save_svg(&dest, "<?xml version=\"1.0\"?><svg/>")
            .await
            .unwrap();
        assert!(std::fs::read_to_string(&dest).unwrap().contains("<svg/>"));
        assert!(!std::path::Path::new(&format!("{dest}.s3x-part")).exists());
        assert!(save_svg(&dest, "hello").await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn version_numbers_from_arns() {
        assert_eq!(
            version_of("arn:aws:states:eu-west-1:1:stateMachine:orders:12"),
            "12"
        );
    }
}

#[cfg(test)]
pub(crate) mod emulator_tests {
    use super::*;

    pub(crate) async fn connect() -> Connection {
        crate::sqs::emulator_tests::connect().await
    }

    pub(crate) const PASS_DEFINITION: &str = r#"{"Comment":"test","StartAt":"Hello","States":{"Hello":{"Type":"Pass","Result":{"ok":true},"End":true}}}"#;

    /// The machine's ARN, created afresh (an IAM role is made for it, as for Lambda).
    pub(crate) async fn fresh_machine(conn: &Connection, name: &str) -> String {
        let c = client(conn);
        if let Ok(all) = list(conn).await {
            for m in all.iter().filter(|m| m.name == name) {
                let _ = c
                    .delete_state_machine()
                    .state_machine_arn(&m.arn)
                    .send()
                    .await;
            }
        }
        let role = crate::lambda::emulator_tests::lambda_role();
        c.create_state_machine()
            .name(name)
            .definition(PASS_DEFINITION)
            .role_arn(role)
            .tags(
                aws_sdk_sfn::types::Tag::builder()
                    .key("team")
                    .value("platform")
                    .build(),
            )
            .send()
            .await
            .unwrap()
            .state_machine_arn()
            .to_string()
    }

    #[tokio::test]
    #[ignore]
    async fn browses_machines_and_executions() {
        let conn = connect().await;
        let arn = fresh_machine(&conn, "s3x-sfn-orders").await;
        let all = list(&conn).await.unwrap();
        let m = all
            .iter()
            .find(|m| m.name == "s3x-sfn-orders")
            .expect("listed");
        assert_eq!(m.kind, "STANDARD");

        let page = details_many(&conn, &[arn.clone()]).await.unwrap();
        assert_eq!(page[0].name, "s3x-sfn-orders");
        assert!(page[0].error.is_none());
        let d = describe(&conn, &arn).await.unwrap();
        assert!(d.definition.contains("\"Hello\""));
        assert!(d
            .tags
            .contains(&("team".to_string(), "platform".to_string())));

        let c = client(&conn);
        let exec_arn = c
            .start_execution()
            .state_machine_arn(&arn)
            .name("run-1")
            .input(r#"{"order":42}"#)
            .send()
            .await
            .unwrap()
            .execution_arn()
            .to_string();
        // A Pass machine finishes almost at once; give the emulator a moment.
        let mut details = execution(&conn, &exec_arn).await.unwrap();
        for _ in 0..20 {
            if details.summary.status != "RUNNING" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            details = execution(&conn, &exec_arn).await.unwrap();
        }
        assert_eq!(details.summary.name, "run-1");
        assert_eq!(details.input.as_deref(), Some(r#"{"order":42}"#));

        let listed = executions(&conn, &arn, None, None, 100).await.unwrap();
        assert!(listed.items.iter().any(|e| e.arn == exec_arn));
        let h = history(&conn, &exec_arn, None, 100).await.unwrap();
        assert_eq!(
            h.events.first().and_then(|e| e["type"].as_str()),
            Some("ExecutionStarted")
        );
        assert!(h.events[0]["timestamp"].is_string());

        let all_events = history_all(&conn, &exec_arn, HISTORY_LIMIT).await.unwrap();
        assert!(!all_events.truncated);
        assert_eq!(all_events.events.len(), h.events.len());
        let def = execution_definition(&conn, &exec_arn).await.unwrap();
        assert!(def.contains("\"Hello\""));

        // Every machine has $LATEST only until a version is published.
        let v = versions(&conn, &arn).await.unwrap();
        assert!(v.aliases.is_empty());
    }
}
