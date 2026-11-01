//! Lambda: functions, their configuration, triggers, versions and aliases.

use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use aws_sdk_lambda::types::FunctionConfiguration;
use aws_sdk_lambda::Client;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

pub fn client(conn: &Connection) -> Client {
    Client::new(&conn.service_config())
}

pub(crate) fn err(conn: &Connection, e: impl std::error::Error) -> AppError {
    AppError::from_sdk(e, &conn.info.profile, conn.info.endpoint_url.as_deref())
}

pub(crate) fn other(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Other, msg)
}

/// True for "this resource isn't there" (no policy, no function URL, …).
fn not_found<E: std::fmt::Debug>(e: &aws_sdk_lambda::error::SdkError<E>) -> bool {
    format!("{e:?}").contains("ResourceNotFoundException")
}

/// Lambda dates look like "2026-10-01T10:00:00.000+0000"; browsers want "+00:00".
pub fn normalise_date(s: &str) -> String {
    let b = s.as_bytes();
    if b.len() > 5
        && (b[b.len() - 5] == b'+' || b[b.len() - 5] == b'-')
        && s[s.len() - 4..].bytes().all(|c| c.is_ascii_digit())
    {
        format!("{}:{}", &s[..s.len() - 2], &s[s.len() - 2..])
    } else {
        s.to_string()
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FunctionSummary {
    pub name: String,
    pub arn: String,
    pub runtime: Option<String>,
    pub handler: Option<String>,
    pub memory_mb: Option<i32>,
    pub timeout_secs: Option<i32>,
    pub architecture: Option<String>,
    /// Zip or Image.
    pub package_type: Option<String>,
    pub code_size: i64,
    pub last_modified: Option<String>,
    pub description: Option<String>,
    pub state: Option<String>,
}

fn summary(f: &FunctionConfiguration) -> FunctionSummary {
    FunctionSummary {
        name: f.function_name().unwrap_or_default().to_string(),
        arn: f.function_arn().unwrap_or_default().to_string(),
        runtime: f.runtime().map(|r| r.as_str().to_string()),
        handler: f.handler().map(String::from),
        memory_mb: f.memory_size(),
        timeout_secs: f.timeout(),
        architecture: f.architectures().first().map(|a| a.as_str().to_string()),
        package_type: f.package_type().map(|p| p.as_str().to_string()),
        code_size: f.code_size(),
        last_modified: f.last_modified().map(normalise_date),
        description: f.description().filter(|d| !d.is_empty()).map(String::from),
        state: f.state().map(|s| s.as_str().to_string()),
    }
}

/// Every function in the region (ListFunctions, 50 per call), by name.
pub async fn list(conn: &Connection) -> Result<Vec<FunctionSummary>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut marker: Option<String> = None;
    loop {
        let page = c
            .list_functions()
            .max_items(50)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.functions().iter().map(summary));
        match page.next_marker() {
            Some(m) if !m.is_empty() && Some(m) != marker.as_deref() => {
                marker = Some(m.to_string())
            }
            _ => break,
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub arn: String,
    pub code_size: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Vpc {
    pub vpc_id: Option<String>,
    pub subnets: Vec<String>,
    pub security_groups: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FunctionUrl {
    pub url: String,
    /// NONE (public) or AWS_IAM.
    pub auth_type: String,
    pub invoke_mode: Option<String>,
    pub cors: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InvokeConfig {
    pub max_retries: Option<i32>,
    pub max_age_secs: Option<i32>,
    pub on_success: Option<String>,
    pub on_failure: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FunctionDetails {
    #[serde(flatten)]
    pub summary: FunctionSummary,
    pub role: Option<String>,
    /// Names only; values come from `env_values` on Reveal.
    pub env_keys: Vec<String>,
    pub env_error: Option<String>,
    pub layers: Vec<Layer>,
    pub vpc: Option<Vpc>,
    pub dead_letter_target: Option<String>,
    pub kms_key: Option<String>,
    pub tracing: Option<String>,
    pub ephemeral_storage_mb: Option<i32>,
    pub snap_start: Option<String>,
    pub log_group: String,
    pub log_format: Option<String>,
    pub state_reason: Option<String>,
    pub last_update_status: Option<String>,
    pub last_update_reason: Option<String>,
    pub version: Option<String>,
    pub revision_id: Option<String>,
    pub code_sha256: Option<String>,
    pub image_uri: Option<String>,
    pub tags: Vec<(String, String)>,
    pub reserved_concurrency: Option<i32>,
    pub url: Option<FunctionUrl>,
    pub invoke_config: Option<InvokeConfig>,
}

fn details_from(f: &FunctionConfiguration) -> FunctionDetails {
    let name = f.function_name().unwrap_or_default().to_string();
    let mut env_keys: Vec<String> = f
        .environment()
        .and_then(|e| e.variables())
        .map(|v| v.keys().cloned().collect())
        .unwrap_or_default();
    env_keys.sort();
    FunctionDetails {
        summary: summary(f),
        role: f.role().map(String::from),
        env_keys,
        env_error: f
            .environment()
            .and_then(|e| e.error())
            .and_then(|e| e.message())
            .map(String::from),
        layers: f
            .layers()
            .iter()
            .map(|l| Layer {
                arn: l.arn().unwrap_or_default().to_string(),
                code_size: l.code_size(),
            })
            .collect(),
        vpc: f
            .vpc_config()
            .filter(|v| !v.subnet_ids().is_empty())
            .map(|v| Vpc {
                vpc_id: v.vpc_id().filter(|s| !s.is_empty()).map(String::from),
                subnets: v.subnet_ids().to_vec(),
                security_groups: v.security_group_ids().to_vec(),
            }),
        dead_letter_target: f
            .dead_letter_config()
            .and_then(|d| d.target_arn())
            .map(String::from),
        kms_key: f.kms_key_arn().map(String::from),
        tracing: f
            .tracing_config()
            .and_then(|t| t.mode())
            .map(|m| m.as_str().to_string()),
        ephemeral_storage_mb: f.ephemeral_storage().map(|e| e.size()),
        snap_start: f
            .snap_start()
            .and_then(|s| s.apply_on())
            .map(|a| a.as_str().to_string())
            .filter(|a| a != "None"),
        log_group: f
            .logging_config()
            .and_then(|l| l.log_group())
            .map(String::from)
            .unwrap_or_else(|| format!("/aws/lambda/{name}")),
        log_format: f
            .logging_config()
            .and_then(|l| l.log_format())
            .map(|x| x.as_str().to_string()),
        state_reason: f.state_reason().map(String::from),
        last_update_status: f.last_update_status().map(|s| s.as_str().to_string()),
        last_update_reason: f.last_update_status_reason().map(String::from),
        version: f.version().map(String::from),
        revision_id: f.revision_id().map(String::from),
        code_sha256: f.code_sha256().map(String::from),
        ..Default::default()
    }
}

/// Everything the details tab shows. Optional parts (URL, async invoke
/// settings) are None when the function doesn't have them.
pub async fn get(conn: &Connection, name: &str) -> Result<FunctionDetails, AppError> {
    let c = client(conn);
    let out = c
        .get_function()
        .function_name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let cfg = out
        .configuration()
        .ok_or_else(|| other(format!("No configuration for {name}")))?;
    let mut d = details_from(cfg);
    d.image_uri = out.code().and_then(|c| c.image_uri()).map(String::from);
    let mut tags: Vec<(String, String)> = out
        .tags()
        .map(|t| t.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    tags.sort();
    d.tags = tags;
    d.reserved_concurrency = out
        .concurrency()
        .and_then(|c| c.reserved_concurrent_executions());
    match c.get_function_url_config().function_name(name).send().await {
        Ok(u) => {
            d.url = Some(FunctionUrl {
                url: u.function_url().to_string(),
                auth_type: u.auth_type().as_str().to_string(),
                invoke_mode: u.invoke_mode().map(|m| m.as_str().to_string()),
                cors: u.cors().map(|c| {
                    serde_json::json!({
                        "allowOrigins": c.allow_origins(),
                        "allowMethods": c.allow_methods(),
                        "allowHeaders": c.allow_headers(),
                        "exposeHeaders": c.expose_headers(),
                        "allowCredentials": c.allow_credentials(),
                        "maxAge": c.max_age(),
                    })
                }),
            })
        }
        Err(e) if not_found(&e) => {}
        // Emulators may not implement it; the URL section just stays empty.
        Err(_) => {}
    }
    if let Ok(ic) = c
        .get_function_event_invoke_config()
        .function_name(name)
        .send()
        .await
    {
        let dest = ic.destination_config();
        d.invoke_config = Some(InvokeConfig {
            max_retries: ic.maximum_retry_attempts(),
            max_age_secs: ic.maximum_event_age_in_seconds(),
            on_success: dest
                .and_then(|d| d.on_success())
                .and_then(|s| s.destination())
                .map(String::from),
            on_failure: dest
                .and_then(|d| d.on_failure())
                .and_then(|s| s.destination())
                .map(String::from),
        });
    }
    Ok(d)
}

/// Environment variable values (on Reveal only; never cached).
pub async fn env_values(
    conn: &Connection,
    name: &str,
) -> Result<BTreeMap<String, String>, AppError> {
    let out = client(conn)
        .get_function_configuration()
        .function_name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out
        .environment()
        .and_then(|e| e.variables())
        .map(|v| v.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EventSourceMapping {
    pub uuid: String,
    pub source_arn: Option<String>,
    /// Enabled, Disabled, Creating, Updating, …
    pub state: Option<String>,
    pub batch_size: Option<i32>,
    pub batching_window_secs: Option<i32>,
    pub starting_position: Option<String>,
    pub last_result: Option<String>,
    pub last_modified: Option<String>,
    pub report_batch_item_failures: bool,
    pub filters: Vec<String>,
}

/// Who may invoke the function, from its resource policy.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Invoker {
    pub sid: String,
    /// e.g. "s3.amazonaws.com", an account / role ARN, or "*".
    pub principal: String,
    pub source_arn: Option<String>,
    pub source_account: Option<String>,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Triggers {
    pub mappings: Vec<EventSourceMapping>,
    pub invokers: Vec<Invoker>,
    pub policy: Option<String>,
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

/// The resource policy's statements as invokers.
pub fn invokers_from_policy(policy: &str) -> Vec<Invoker> {
    let Ok(doc) = serde_json::from_str::<Value>(policy) else {
        return Vec::new();
    };
    let statements = match doc.get("Statement") {
        Some(Value::Array(a)) => a.clone(),
        Some(o @ Value::Object(_)) => vec![o.clone()],
        _ => Vec::new(),
    };
    let cond = |s: &Value, key: &str| -> Option<String> {
        let c = s.get("Condition")?.as_object()?;
        c.values().find_map(|ops| {
            ops.as_object().and_then(|o| {
                o.iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(key))
                    .and_then(|(_, v)| strings(Some(v)).into_iter().next())
            })
        })
    };
    statements
        .iter()
        .map(|s| {
            let principal = match s.get("Principal") {
                Some(Value::String(p)) => p.clone(),
                Some(Value::Object(o)) => o
                    .values()
                    .flat_map(|v| strings(Some(v)))
                    .collect::<Vec<_>>()
                    .join(", "),
                _ => String::new(),
            };
            Invoker {
                sid: s
                    .get("Sid")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                principal,
                source_arn: cond(s, "AWS:SourceArn"),
                source_account: cond(s, "AWS:SourceAccount"),
                action: strings(s.get("Action")).join(", "),
            }
        })
        .collect()
}

/// Event source mappings (SQS, DynamoDB / Kinesis streams, Kafka, MQ) and the
/// resource policy (S3, SNS, API Gateway, EventBridge … invoke through it).
pub async fn triggers(conn: &Connection, name: &str) -> Result<Triggers, AppError> {
    let c = client(conn);
    let mut out = Triggers::default();
    let mut marker: Option<String> = None;
    loop {
        let page = c
            .list_event_source_mappings()
            .function_name(name)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.mappings
            .extend(page.event_source_mappings().iter().map(|m| {
                EventSourceMapping {
                    uuid: m.uuid().unwrap_or_default().to_string(),
                    source_arn: m.event_source_arn().map(String::from),
                    state: m.state().map(String::from),
                    batch_size: m.batch_size(),
                    batching_window_secs: m.maximum_batching_window_in_seconds(),
                    starting_position: m.starting_position().map(|p| p.as_str().to_string()),
                    last_result: m.last_processing_result().map(String::from),
                    last_modified: m
                        .last_modified()
                        .and_then(|d| d.fmt(aws_smithy_types::date_time::Format::DateTime).ok()),
                    report_batch_item_failures: m
                        .function_response_types()
                        .iter()
                        .any(|t| t.as_str() == "ReportBatchItemFailures"),
                    filters: m
                        .filter_criteria()
                        .map(|f| {
                            f.filters()
                                .iter()
                                .filter_map(|x| x.pattern().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default(),
                }
            }));
        match page.next_marker() {
            Some(m) if !m.is_empty() && Some(m) != marker.as_deref() => {
                marker = Some(m.to_string())
            }
            _ => break,
        }
    }
    match c.get_policy().function_name(name).send().await {
        Ok(p) => {
            if let Some(doc) = p.policy() {
                out.invokers = invokers_from_policy(doc);
                out.policy = Some(doc.to_string());
            }
        }
        Err(e) if not_found(&e) => {}
        Err(e) => return Err(err(conn, e)),
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub version: String,
    pub description: Option<String>,
    pub last_modified: Option<String>,
    pub code_sha256: Option<String>,
    pub runtime: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Alias {
    pub name: String,
    pub arn: String,
    pub version: String,
    pub description: Option<String>,
    /// Extra versions and the share of traffic (0–1) each gets.
    pub routing: Vec<(String, f64)>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Provisioned {
    pub qualifier: String,
    pub requested: Option<i32>,
    pub allocated: Option<i32>,
    pub available: Option<i32>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Versions {
    pub versions: Vec<Version>,
    pub aliases: Vec<Alias>,
    pub provisioned: Vec<Provisioned>,
}

pub async fn versions(conn: &Connection, name: &str) -> Result<Versions, AppError> {
    let c = client(conn);
    let mut out = Versions::default();
    let mut marker: Option<String> = None;
    loop {
        let page = c
            .list_versions_by_function()
            .function_name(name)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.versions.extend(page.versions().iter().map(|v| Version {
            version: v.version().unwrap_or_default().to_string(),
            description: v.description().filter(|d| !d.is_empty()).map(String::from),
            last_modified: v.last_modified().map(normalise_date),
            code_sha256: v.code_sha256().map(String::from),
            runtime: v.runtime().map(|r| r.as_str().to_string()),
        }));
        match page.next_marker() {
            Some(m) if !m.is_empty() && Some(m) != marker.as_deref() => {
                marker = Some(m.to_string())
            }
            _ => break,
        }
    }
    // $LATEST first, then newest numbered version first.
    out.versions.sort_by_key(|v| {
        if v.version == "$LATEST" {
            i64::MIN
        } else {
            -v.version.parse::<i64>().unwrap_or(0)
        }
    });
    let mut marker: Option<String> = None;
    loop {
        let page = c
            .list_aliases()
            .function_name(name)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.aliases.extend(page.aliases().iter().map(|a| {
            let mut routing: Vec<(String, f64)> = a
                .routing_config()
                .and_then(|r| r.additional_version_weights())
                .map(|w| w.iter().map(|(k, v)| (k.clone(), *v)).collect())
                .unwrap_or_default();
            routing.sort_by(|x, y| x.0.cmp(&y.0));
            Alias {
                name: a.name().unwrap_or_default().to_string(),
                arn: a.alias_arn().unwrap_or_default().to_string(),
                version: a.function_version().unwrap_or_default().to_string(),
                description: a.description().filter(|d| !d.is_empty()).map(String::from),
                routing,
            }
        }));
        match page.next_marker() {
            Some(m) if !m.is_empty() && Some(m) != marker.as_deref() => {
                marker = Some(m.to_string())
            }
            _ => break,
        }
    }
    out.aliases.sort_by(|a, b| a.name.cmp(&b.name));
    // Not every emulator has provisioned concurrency; leave it empty then.
    if let Ok(p) = c
        .list_provisioned_concurrency_configs()
        .function_name(name)
        .send()
        .await
    {
        out.provisioned = p
            .provisioned_concurrency_configs()
            .iter()
            .map(|x| Provisioned {
                qualifier: x
                    .function_arn()
                    .and_then(|a| a.rsplit(':').next())
                    .unwrap_or_default()
                    .to_string(),
                requested: x.requested_provisioned_concurrent_executions(),
                allocated: x.allocated_provisioned_concurrent_executions(),
                available: x.available_provisioned_concurrent_executions(),
                status: x.status().map(|s| s.as_str().to_string()),
            })
            .collect();
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_dates() {
        assert_eq!(
            normalise_date("2026-10-01T10:00:00.000+0000"),
            "2026-10-01T10:00:00.000+00:00"
        );
        assert_eq!(
            normalise_date("2026-10-01T10:00:00.000-0130"),
            "2026-10-01T10:00:00.000-01:30"
        );
        assert_eq!(
            normalise_date("2026-10-01T10:00:00Z"),
            "2026-10-01T10:00:00Z"
        );
    }

    #[test]
    fn reads_policy_invokers() {
        let policy = r#"{"Version":"2012-10-17","Statement":[
            {"Sid":"s3","Effect":"Allow","Principal":{"Service":"s3.amazonaws.com"},"Action":"lambda:InvokeFunction",
             "Resource":"arn:aws:lambda:eu-west-2:1:function:f","Condition":{"StringEquals":{"AWS:SourceAccount":"123"},"ArnLike":{"AWS:SourceArn":"arn:aws:s3:::uploads"}}},
            {"Sid":"any","Effect":"Allow","Principal":"*","Action":["lambda:InvokeFunctionUrl"]}]}"#;
        let inv = invokers_from_policy(policy);
        assert_eq!(inv.len(), 2);
        assert_eq!(inv[0].principal, "s3.amazonaws.com");
        assert_eq!(inv[0].source_arn.as_deref(), Some("arn:aws:s3:::uploads"));
        assert_eq!(inv[0].source_account.as_deref(), Some("123"));
        assert_eq!(
            inv[1],
            Invoker {
                sid: "any".into(),
                principal: "*".into(),
                source_arn: None,
                source_account: None,
                action: "lambda:InvokeFunctionUrl".into()
            }
        );
        assert!(invokers_from_policy("not json").is_empty());
    }
}

#[cfg(test)]
pub(crate) mod emulator_tests {
    use super::*;
    use std::io::{Read, Write};

    pub(crate) async fn connect() -> Connection {
        crate::sqs::emulator_tests::connect().await
    }

    /// A raw query-API call to the emulator (for services the app has no SDK
    /// for). The emulator routes by the signature's service, so a dummy one
    /// with the tests' access key is enough.
    pub(crate) fn emulator_post(service: &str, body: &str) -> String {
        let mut s = std::net::TcpStream::connect("127.0.0.1:4566").unwrap();
        write!(
            s,
            "POST / HTTP/1.1\r\nHost: localhost:4566\r\nAuthorization: AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/{service}/aws4_request, SignedHeaders=host, Signature=0\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut resp = String::new();
        let _ = s.read_to_string(&mut resp);
        resp
    }

    /// The emulator's account id (from a role it creates for Lambda).
    pub(crate) fn lambda_role() -> String {
        let policy = "%7B%22Version%22%3A%222012-10-17%22%2C%22Statement%22%3A%5B%5D%7D";
        let resp = emulator_post("iam", &format!("Action=CreateRole&Version=2010-05-08&RoleName=s3x-lambda-role&AssumeRolePolicyDocument={policy}"));
        let resp = if resp.contains("<Arn>") {
            resp
        } else {
            emulator_post(
                "iam",
                "Action=GetRole&Version=2010-05-08&RoleName=s3x-lambda-role",
            )
        };
        let start = resp.find("<Arn>").expect("role ARN") + 5;
        let end = resp[start..].find("</Arn>").unwrap() + start;
        resp[start..end].to_string()
    }

    /// An empty but valid zip archive.
    pub(crate) const EMPTY_ZIP: &[u8] = &[
        0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ];

    pub(crate) async fn fresh_function(conn: &Connection, name: &str) -> String {
        let c = client(conn);
        let _ = c.delete_function().function_name(name).send().await;
        let role = lambda_role();
        let out = c
            .create_function()
            .function_name(name)
            .runtime(aws_sdk_lambda::types::Runtime::Python312)
            .role(role)
            .handler("app.handler")
            .memory_size(256)
            .timeout(15)
            .description("test function")
            .environment(
                aws_sdk_lambda::types::Environment::builder()
                    .variables("API_KEY", "s3cret")
                    .variables("STAGE", "dev")
                    .build(),
            )
            .tags("team", "platform")
            .code(
                aws_sdk_lambda::types::FunctionCode::builder()
                    .zip_file(aws_smithy_types::Blob::new(EMPTY_ZIP))
                    .build(),
            )
            .send()
            .await
            .unwrap();
        out.function_arn().unwrap().to_string()
    }

    #[tokio::test]
    #[ignore]
    async fn browses_functions() {
        let conn = connect().await;
        let arn = fresh_function(&conn, "s3x-fn-orders").await;
        let all = list(&conn).await.unwrap();
        let f = all
            .iter()
            .find(|f| f.name == "s3x-fn-orders")
            .expect("listed");
        assert_eq!(f.runtime.as_deref(), Some("python3.12"));
        assert_eq!(f.memory_mb, Some(256));

        let d = get(&conn, "s3x-fn-orders").await.unwrap();
        assert_eq!(d.summary.arn, arn);
        assert_eq!(d.env_keys, ["API_KEY", "STAGE"]);
        assert_eq!(d.log_group, "/aws/lambda/s3x-fn-orders");
        assert!(d
            .tags
            .contains(&("team".to_string(), "platform".to_string())));
        let env = env_values(&conn, "s3x-fn-orders").await.unwrap();
        assert_eq!(env.get("API_KEY").map(String::as_str), Some("s3cret"));

        let c = client(&conn);
        c.add_permission()
            .function_name("s3x-fn-orders")
            .statement_id("from-s3")
            .action("lambda:InvokeFunction")
            .principal("s3.amazonaws.com")
            .source_arn("arn:aws:s3:::s3x-uploads")
            .send()
            .await
            .unwrap();
        let t = triggers(&conn, "s3x-fn-orders").await.unwrap();
        assert!(t.invokers.iter().any(|i| i.principal == "s3.amazonaws.com"
            && i.source_arn.as_deref() == Some("arn:aws:s3:::s3x-uploads")));

        c.publish_version()
            .function_name("s3x-fn-orders")
            .send()
            .await
            .unwrap();
        c.create_alias()
            .function_name("s3x-fn-orders")
            .name("live")
            .function_version("1")
            .send()
            .await
            .unwrap();
        let v = versions(&conn, "s3x-fn-orders").await.unwrap();
        assert_eq!(
            v.versions.first().map(|x| x.version.as_str()),
            Some("$LATEST")
        );
        assert!(v.versions.iter().any(|x| x.version == "1"));
        assert_eq!(
            v.aliases
                .iter()
                .map(|a| (a.name.as_str(), a.version.as_str()))
                .collect::<Vec<_>>(),
            [("live", "1")]
        );
    }
}
