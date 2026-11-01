//! SQS operations.
//!
//! Queues are identified by URL in the backend; the UI navigates by name and
//! resolves names to URLs from the listing (or `queue_url`).

use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use aws_sdk_sqs::types::QueueAttributeName;
use aws_sdk_sqs::Client;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// Parallel GetQueueAttributes calls when listing.
const ATTR_CONCURRENCY: usize = 8;

pub fn client(conn: &Connection) -> Client {
    Client::new(&conn.service_config())
}

pub(crate) fn err(conn: &Connection, e: impl std::error::Error) -> AppError {
    AppError::from_sdk(e, &conn.info.profile, conn.info.endpoint_url.as_deref())
}

pub(crate) fn other(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Other, msg)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueueInfo {
    pub name: String,
    pub url: String,
    pub arn: Option<String>,
    pub fifo: bool,
    /// ApproximateNumberOfMessages
    pub visible: Option<i64>,
    /// ApproximateNumberOfMessagesNotVisible
    pub in_flight: Option<i64>,
    /// ApproximateNumberOfMessagesDelayed
    pub delayed: Option<i64>,
    /// RFC 3339
    pub created: Option<String>,
    pub modified: Option<String>,
    /// Dead-letter queue this queue sends to (from RedrivePolicy).
    pub dlq_arn: Option<String>,
    pub max_receive_count: Option<i64>,
    /// Some other listed queue uses this one as its dead-letter queue.
    pub is_dlq: bool,
    /// Every attribute as returned (for the details view).
    pub attributes: BTreeMap<String, String>,
    /// Attributes couldn't be read (e.g. access denied); counts unknown.
    pub error: Option<String>,
}

/// Queue name from a URL (last path segment).
pub fn name_from_url(url: &str) -> String {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(url)
        .to_string()
}

fn epoch_to_rfc3339(s: &str) -> Option<String> {
    let secs: i64 = s.parse().ok()?;
    aws_sdk_sqs::primitives::DateTime::from_secs(secs)
        .fmt(aws_sdk_sqs::primitives::DateTimeFormat::DateTime)
        .ok()
}

/// Fills the parsed fields from the raw attribute map.
pub fn apply_attributes(q: &mut QueueInfo, attrs: BTreeMap<String, String>) {
    let num = |k: &str| attrs.get(k).and_then(|v| v.parse::<i64>().ok());
    q.arn = attrs.get("QueueArn").cloned();
    q.fifo = attrs.get("FifoQueue").is_some_and(|v| v == "true") || q.name.ends_with(".fifo");
    q.visible = num("ApproximateNumberOfMessages");
    q.in_flight = num("ApproximateNumberOfMessagesNotVisible");
    q.delayed = num("ApproximateNumberOfMessagesDelayed");
    q.created = attrs
        .get("CreatedTimestamp")
        .and_then(|v| epoch_to_rfc3339(v));
    q.modified = attrs
        .get("LastModifiedTimestamp")
        .and_then(|v| epoch_to_rfc3339(v));
    if let Some(rp) = attrs.get("RedrivePolicy") {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(rp) {
            q.dlq_arn = v
                .get("deadLetterTargetArn")
                .and_then(|x| x.as_str())
                .map(String::from);
            q.max_receive_count = v.get("maxReceiveCount").and_then(|x| {
                x.as_i64()
                    .or_else(|| x.as_str().and_then(|s| s.parse().ok()))
            });
        }
    }
    q.attributes = attrs;
}

async fn attributes(
    conn: &Connection,
    client: &Client,
    url: &str,
) -> Result<BTreeMap<String, String>, AppError> {
    let out = client
        .get_queue_attributes()
        .queue_url(url)
        .attribute_names(QueueAttributeName::All)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out
        .attributes()
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.as_str().to_string(), v.clone()))
                .collect()
        })
        .unwrap_or_default())
}

/// All queue URLs whose names begin with `prefix` (paginated).
async fn list_urls(
    conn: &Connection,
    client: &Client,
    prefix: &str,
) -> Result<Vec<String>, AppError> {
    let mut urls = Vec::new();
    let mut token = None;
    loop {
        let out = client
            .list_queues()
            .set_queue_name_prefix(
                Some(prefix.trim())
                    .filter(|p| !p.is_empty())
                    .map(String::from),
            )
            .max_results(1000)
            .set_next_token(token)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        urls.extend(out.queue_urls().iter().cloned());
        token = out.next_token().map(String::from);
        if token.is_none() {
            break;
        }
    }
    Ok(urls)
}

/// Queues (with attributes and counts) whose names begin with `prefix`.
pub async fn list_queues(conn: &Connection, prefix: &str) -> Result<Vec<QueueInfo>, AppError> {
    let client = client(conn);
    let urls = list_urls(conn, &client, prefix).await?;
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(ATTR_CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    for (i, url) in urls.iter().enumerate() {
        let client = client.clone();
        let url = url.clone();
        let sem = sem.clone();
        let profile = conn.info.profile.clone();
        let endpoint = conn.info.endpoint_url.clone();
        set.spawn(async move {
            let _permit = sem.acquire().await;
            let r = client
                .get_queue_attributes()
                .queue_url(&url)
                .attribute_names(QueueAttributeName::All)
                .send()
                .await
                .map(|out| {
                    out.attributes()
                        .map(|m| {
                            m.iter()
                                .map(|(k, v)| (k.as_str().to_string(), v.clone()))
                                .collect::<BTreeMap<_, _>>()
                        })
                        .unwrap_or_default()
                })
                .map_err(|e| AppError::from_sdk(e, &profile, endpoint.as_deref()));
            (i, r)
        });
    }
    let mut queues: Vec<QueueInfo> = urls
        .iter()
        .map(|u| QueueInfo {
            name: name_from_url(u),
            url: u.clone(),
            ..Default::default()
        })
        .collect();
    while let Some(joined) = set.join_next().await {
        let Ok((i, r)) = joined else { continue };
        match r {
            Ok(attrs) => apply_attributes(&mut queues[i], attrs),
            Err(e) => queues[i].error = Some(e.message),
        }
    }
    mark_dlqs(&mut queues);
    queues.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(queues)
}

/// A queue without its attributes: what the paged list needs for every queue.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueueRef {
    pub name: String,
    pub url: String,
    /// Worked out from the URL (no extra call).
    pub arn: String,
}

/// `arn:<partition>:sqs:<region>:<account>:<name>` from a queue URL. Real AWS
/// URLs carry the region in the host; emulator URLs use `region`.
pub fn arn_from_url(url: &str, region: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let mut parts = rest.trim_end_matches('/').split('/');
    let host = parts.next().unwrap_or("");
    let segs: Vec<&str> = parts.collect();
    let (account, name) = match segs.as_slice() {
        [.., a, n] => (*a, *n),
        [n] => ("", *n),
        [] => ("", ""),
    };
    let labels: Vec<&str> = host.split('.').collect();
    let host_region = match labels.as_slice() {
        ["sqs", r, ..] if r.contains('-') => Some(*r),
        [r, "queue", ..] if r.contains('-') => Some(*r),
        _ => None,
    };
    let region = host_region.unwrap_or(region);
    let partition = if host.ends_with(".cn") || region.starts_with("cn-") {
        "aws-cn"
    } else if region.starts_with("us-gov-") {
        "aws-us-gov"
    } else {
        "aws"
    };
    format!("arn:{partition}:sqs:{region}:{account}:{name}")
}

/// Every queue whose name begins with `prefix`, by name: one call per 1,000.
pub async fn list_refs(conn: &Connection, prefix: &str) -> Result<Vec<QueueRef>, AppError> {
    let urls = list_urls(conn, &client(conn), prefix).await?;
    let region = conn.service_region();
    let mut out: Vec<QueueRef> = urls
        .into_iter()
        .map(|url| QueueRef {
            name: name_from_url(&url),
            arn: arn_from_url(&url, &region),
            url,
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Attributes, counts and "is a dead-letter queue" for the given queues (the
/// visible page), 8 at a time. A queue that can't be read gets `error` set.
pub async fn details_many(conn: &Connection, urls: &[String]) -> Result<Vec<QueueInfo>, AppError> {
    let client = client(conn);
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(ATTR_CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    for (i, url) in urls.iter().enumerate() {
        let (client, url, sem) = (client.clone(), url.clone(), sem.clone());
        let (profile, endpoint) = (conn.info.profile.clone(), conn.info.endpoint_url.clone());
        set.spawn(async move {
            let _permit = sem.acquire().await;
            let attrs = client
                .get_queue_attributes()
                .queue_url(&url)
                .attribute_names(QueueAttributeName::All)
                .send()
                .await
                .map(|out| {
                    out.attributes()
                        .map(|m| {
                            m.iter()
                                .map(|(k, v)| (k.as_str().to_string(), v.clone()))
                                .collect::<BTreeMap<_, _>>()
                        })
                        .unwrap_or_default()
                })
                .map_err(|e| AppError::from_sdk(e, &profile, endpoint.as_deref()));
            // Not every emulator implements this; treat failures as "not a DLQ".
            let is_dlq = match &attrs {
                Ok(_) => client
                    .list_dead_letter_source_queues()
                    .queue_url(&url)
                    .max_results(1)
                    .send()
                    .await
                    .map(|o| !o.queue_urls().is_empty())
                    .unwrap_or(false),
                Err(_) => false,
            };
            (i, attrs, is_dlq)
        });
    }
    let mut out: Vec<QueueInfo> = urls
        .iter()
        .map(|u| QueueInfo {
            name: name_from_url(u),
            url: u.clone(),
            ..Default::default()
        })
        .collect();
    while let Some(joined) = set.join_next().await {
        let Ok((i, r, is_dlq)) = joined else { continue };
        match r {
            Ok(attrs) => {
                apply_attributes(&mut out[i], attrs);
                out[i].is_dlq = is_dlq;
            }
            Err(e) => out[i].error = Some(e.message),
        }
    }
    Ok(out)
}

/// Marks queues that another listed queue uses as its dead-letter queue.
pub fn mark_dlqs(queues: &mut [QueueInfo]) {
    let targets: BTreeSet<String> = queues.iter().filter_map(|q| q.dlq_arn.clone()).collect();
    for q in queues.iter_mut() {
        q.is_dlq = q.arn.as_ref().is_some_and(|a| targets.contains(a));
    }
}

/// One queue with attributes; `is_dlq` from ListDeadLetterSourceQueues.
pub async fn queue_details(conn: &Connection, url: &str) -> Result<QueueInfo, AppError> {
    let client = client(conn);
    let mut q = QueueInfo {
        name: name_from_url(url),
        url: url.to_string(),
        ..Default::default()
    };
    apply_attributes(&mut q, attributes(conn, &client, url).await?);
    // Not every emulator implements this; treat failures as "not a DLQ".
    if let Ok(out) = client
        .list_dead_letter_source_queues()
        .queue_url(url)
        .max_results(1)
        .send()
        .await
    {
        q.is_dlq = !out.queue_urls().is_empty();
    }
    Ok(q)
}

/// Queues that send their failed messages to this one.
pub async fn dlq_sources(conn: &Connection, url: &str) -> Result<Vec<String>, AppError> {
    let client = client(conn);
    let mut urls = Vec::new();
    let mut token = None;
    loop {
        let out = client
            .list_dead_letter_source_queues()
            .queue_url(url)
            .max_results(1000)
            .set_next_token(token)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        urls.extend(out.queue_urls().iter().cloned());
        token = out.next_token().map(String::from);
        if token.is_none() {
            break;
        }
    }
    Ok(urls)
}

pub async fn queue_url(conn: &Connection, name: &str) -> Result<String, AppError> {
    let out = client(conn)
        .get_queue_url()
        .queue_name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    out.queue_url()
        .map(String::from)
        .ok_or_else(|| other(format!("No URL for queue {name}")))
}

pub async fn list_tags(conn: &Connection, url: &str) -> Result<BTreeMap<String, String>, AppError> {
    let out = client(conn)
        .list_queue_tags()
        .queue_url(url)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out
        .tags()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default())
}

/// Checks a queue name: 1–80 letters, digits, '-' or '_', plus ".fifo" for FIFO.
pub fn queue_name_problem(name: &str, fifo: bool) -> Option<String> {
    let base = if fifo {
        match name.strip_suffix(".fifo") {
            Some(b) => b,
            None => return Some("FIFO queue names must end in .fifo".into()),
        }
    } else {
        if name.ends_with(".fifo") {
            return Some("Only FIFO queues can end in .fifo".into());
        }
        name
    };
    if name.is_empty() || base.is_empty() {
        return Some("Enter a name".into());
    }
    if name.len() > 80 {
        return Some("Queue names can be at most 80 characters".into());
    }
    if base
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return Some("Use letters, digits, - and _ only".into());
    }
    None
}

fn attr_map(
    attrs: &BTreeMap<String, String>,
) -> std::collections::HashMap<QueueAttributeName, String> {
    attrs
        .iter()
        .map(|(k, v)| (QueueAttributeName::from(k.as_str()), v.clone()))
        .collect()
}

/// Creates a queue with attributes and tags; returns its URL.
pub async fn create_queue(
    conn: &Connection,
    name: &str,
    attributes: &BTreeMap<String, String>,
    tags: &BTreeMap<String, String>,
) -> Result<String, AppError> {
    let fifo = attributes.get("FifoQueue").is_some_and(|v| v == "true");
    if let Some(p) = queue_name_problem(name, fifo) {
        return Err(other(p));
    }
    let tag_map: std::collections::HashMap<String, String> =
        tags.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let out = client(conn)
        .create_queue()
        .queue_name(name)
        .set_attributes(Some(attr_map(attributes)).filter(|m| !m.is_empty()))
        .set_tags(Some(tag_map).filter(|m| !m.is_empty()))
        .send()
        .await
        .map_err(|e| {
            if e.as_service_error().is_some_and(|se| se.is_queue_deleted_recently()) {
                other("A queue with this name was deleted less than 60 seconds ago; wait a minute and try again")
            } else if e.as_service_error().is_some_and(|se| se.is_queue_name_exists()) {
                other(format!("A queue named {name} already exists with different settings"))
            } else {
                err(conn, e)
            }
        })?;
    out.queue_url()
        .map(String::from)
        .ok_or_else(|| other("No queue URL returned"))
}

/// Changes attributes (only those given). "" clears RedrivePolicy / Policy.
pub async fn set_attributes(
    conn: &Connection,
    url: &str,
    attributes: &BTreeMap<String, String>,
) -> Result<(), AppError> {
    if attributes.is_empty() {
        return Ok(());
    }
    client(conn)
        .set_queue_attributes()
        .queue_url(url)
        .set_attributes(Some(attr_map(attributes)))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

/// Makes the queue's tags exactly `tags`.
pub async fn set_tags(
    conn: &Connection,
    url: &str,
    tags: &BTreeMap<String, String>,
) -> Result<(), AppError> {
    let current = list_tags(conn, url).await?;
    let client = client(conn);
    let changed: std::collections::HashMap<String, String> = tags
        .iter()
        .filter(|(k, v)| current.get(*k) != Some(v))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if !changed.is_empty() {
        client
            .tag_queue()
            .queue_url(url)
            .set_tags(Some(changed))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    let removed: Vec<String> = current
        .keys()
        .filter(|k| !tags.contains_key(*k))
        .cloned()
        .collect();
    if !removed.is_empty() {
        client
            .untag_queue()
            .queue_url(url)
            .set_tag_keys(Some(removed))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    Ok(())
}

pub async fn delete_queue(conn: &Connection, url: &str) -> Result<(), AppError> {
    client(conn)
        .delete_queue()
        .queue_url(url)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

/// Deletes every message in the queue (SQS allows one purge per 60 s).
pub async fn purge(conn: &Connection, url: &str) -> Result<(), AppError> {
    client(conn)
        .purge_queue()
        .queue_url(url)
        .send()
        .await
        .map_err(|e| {
            if e.as_service_error().is_some_and(|se| se.is_purge_queue_in_progress()) {
                other("This queue was purged less than 60 seconds ago; SQS allows one purge a minute. Try again shortly.")
            } else {
                err(conn, e)
            }
        })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Dead-letter redrive (message move tasks)

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveTask {
    pub task_handle: Option<String>,
    /// RUNNING | COMPLETED | CANCELLING | CANCELLED | FAILED
    pub status: String,
    pub source_arn: String,
    pub destination_arn: Option<String>,
    pub moved: i64,
    pub to_move: Option<i64>,
    pub max_per_second: Option<i32>,
    pub failure_reason: Option<String>,
    /// RFC 3339
    pub started: Option<String>,
}

/// Starts moving messages out of a dead-letter queue: back to their source
/// queues (no destination) or to `destination_arn`. Returns the task handle.
pub async fn start_redrive(
    conn: &Connection,
    dlq_arn: &str,
    destination_arn: Option<String>,
    max_per_second: Option<i32>,
) -> Result<String, AppError> {
    let out = client(conn)
        .start_message_move_task()
        .source_arn(dlq_arn)
        .set_destination_arn(destination_arn.filter(|d| !d.trim().is_empty()))
        .set_max_number_of_messages_per_second(max_per_second.filter(|n| *n > 0))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out.task_handle().unwrap_or_default().to_string())
}

/// Recent move tasks for a dead-letter queue (newest first; up to 10).
pub async fn list_redrives(conn: &Connection, dlq_arn: &str) -> Result<Vec<MoveTask>, AppError> {
    let out = client(conn)
        .list_message_move_tasks()
        .source_arn(dlq_arn)
        .max_results(10)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out
        .results()
        .iter()
        .map(|t| MoveTask {
            task_handle: t.task_handle().map(String::from),
            status: t.status().unwrap_or_default().to_string(),
            source_arn: t.source_arn().unwrap_or_default().to_string(),
            destination_arn: t.destination_arn().map(String::from),
            moved: t.approximate_number_of_messages_moved(),
            to_move: t.approximate_number_of_messages_to_move(),
            max_per_second: t.max_number_of_messages_per_second(),
            failure_reason: t.failure_reason().map(String::from),
            started: aws_sdk_sqs::primitives::DateTime::from_millis(t.started_timestamp())
                .fmt(aws_sdk_sqs::primitives::DateTimeFormat::DateTime)
                .ok(),
        })
        .collect())
}

/// Cancels a running move task; returns how many messages had moved.
pub async fn cancel_redrive(conn: &Connection, task_handle: &str) -> Result<i64, AppError> {
    let out = client(conn)
        .cancel_message_move_task()
        .task_handle(task_handle)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out.approximate_number_of_messages_moved())
}

#[cfg(test)]
mod tests {
    #[test]
    fn arns_from_urls() {
        use super::arn_from_url;
        assert_eq!(
            arn_from_url(
                "https://sqs.eu-west-2.amazonaws.com/123456789012/orders",
                "us-east-1"
            ),
            "arn:aws:sqs:eu-west-2:123456789012:orders"
        );
        assert_eq!(
            arn_from_url("https://sqs.cn-north-1.amazonaws.com.cn/123/q.fifo", "x"),
            "arn:aws-cn:sqs:cn-north-1:123:q.fifo"
        );
        assert_eq!(
            arn_from_url("http://localhost:4566/000000000000/jobs", "eu-west-2"),
            "arn:aws:sqs:eu-west-2:000000000000:jobs"
        );
        assert_eq!(
            arn_from_url(
                "http://sqs.eu-west-2.localhost.localstack.cloud:4566/000000000000/jobs",
                "us-east-1"
            ),
            "arn:aws:sqs:eu-west-2:000000000000:jobs"
        );
    }
    use super::*;

    #[test]
    fn parses_attributes() {
        let mut q = QueueInfo {
            name: "orders".into(),
            ..Default::default()
        };
        let attrs: BTreeMap<String, String> = [
            ("QueueArn", "arn:aws:sqs:eu-west-2:1:orders"),
            ("ApproximateNumberOfMessages", "5"),
            ("ApproximateNumberOfMessagesNotVisible", "2"),
            ("ApproximateNumberOfMessagesDelayed", "0"),
            ("CreatedTimestamp", "1700000000"),
            ("RedrivePolicy", r#"{"deadLetterTargetArn":"arn:aws:sqs:eu-west-2:1:orders-dlq","maxReceiveCount":"3"}"#),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        apply_attributes(&mut q, attrs);
        assert_eq!(
            (q.visible, q.in_flight, q.delayed),
            (Some(5), Some(2), Some(0))
        );
        assert_eq!(q.created.as_deref(), Some("2023-11-14T22:13:20Z"));
        assert_eq!(
            q.dlq_arn.as_deref(),
            Some("arn:aws:sqs:eu-west-2:1:orders-dlq")
        );
        assert_eq!(q.max_receive_count, Some(3));
        assert!(!q.fifo);

        let mut dlq = QueueInfo {
            name: "orders-dlq".into(),
            arn: Some("arn:aws:sqs:eu-west-2:1:orders-dlq".into()),
            ..Default::default()
        };
        dlq.fifo = false;
        let mut all = vec![q, dlq];
        mark_dlqs(&mut all);
        assert!(!all[0].is_dlq && all[1].is_dlq);
        assert_eq!(
            name_from_url("http://localhost:4566/000000000000/a.fifo"),
            "a.fifo"
        );
    }

    #[test]
    fn queue_names() {
        assert_eq!(queue_name_problem("orders-1_a", false), None);
        assert_eq!(queue_name_problem("orders.fifo", true), None);
        assert!(queue_name_problem("orders", true).is_some());
        assert!(queue_name_problem("orders.fifo", false).is_some());
        assert!(queue_name_problem("", false).is_some());
        assert!(queue_name_problem(".fifo", true).is_some());
        assert!(queue_name_problem("a b", false).is_some());
        assert!(queue_name_problem(&"a".repeat(81), false).is_some());
    }
}

#[cfg(test)]
pub(crate) mod emulator_tests {
    use super::*;

    pub(crate) async fn connect() -> Connection {
        let c = crate::ssm::emulator_tests::connect().await;
        c.set_service_region("eu-west-2");
        c
    }

    pub(crate) async fn fresh_queue(
        conn: &Connection,
        name: &str,
        attrs: &[(&str, &str)],
    ) -> String {
        let client = client(conn);
        if let Ok(url) = queue_url(conn, name).await {
            let _ = client.delete_queue().queue_url(url).send().await;
        }
        let mut req = client.create_queue().queue_name(name);
        for (k, v) in attrs {
            req = req.attributes(QueueAttributeName::from(*k), *v);
        }
        req.send().await.unwrap().queue_url().unwrap().to_string()
    }

    #[tokio::test]
    #[ignore]
    async fn lists_queues_with_counts_and_dlqs() {
        let conn = connect().await;
        let dlq = fresh_queue(&conn, "s3x-list-dlq", &[]).await;
        let dlq_arn = queue_details(&conn, &dlq).await.unwrap().arn.unwrap();
        let policy = format!(r#"{{"deadLetterTargetArn":"{dlq_arn}","maxReceiveCount":"2"}}"#);
        let main = fresh_queue(&conn, "s3x-list-main", &[("RedrivePolicy", &policy)]).await;
        fresh_queue(&conn, "s3x-list-f.fifo", &[("FifoQueue", "true")]).await;
        client(&conn)
            .send_message()
            .queue_url(&main)
            .message_body("hi")
            .send()
            .await
            .unwrap();

        // Paged list: names first, details for chosen queues.
        let refs = list_refs(&conn, "s3x-list-").await.unwrap();
        assert_eq!(
            refs.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            ["s3x-list-dlq", "s3x-list-f.fifo", "s3x-list-main"]
        );
        assert!(
            refs[2].arn.ends_with(":s3x-list-main")
                && refs[2].arn.starts_with("arn:aws:sqs:eu-west-2:")
        );
        let urls: Vec<String> = vec![refs[0].url.clone(), refs[2].url.clone()];
        let page = details_many(&conn, &urls).await.unwrap();
        assert!(page[0].is_dlq && !page[1].is_dlq);
        assert_eq!(page[1].visible, Some(1));
        assert_eq!(
            Some(page[0].arn.clone().unwrap()),
            Some(refs[0].arn.clone())
        );

        let qs = list_queues(&conn, "s3x-list-").await.unwrap();
        let names: Vec<_> = qs.iter().map(|q| q.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["s3x-list-dlq", "s3x-list-f.fifo", "s3x-list-main"]
        );
        assert!(qs[0].is_dlq);
        assert!(qs[1].fifo);
        assert_eq!(qs[2].visible, Some(1));
        assert_eq!(qs[2].max_receive_count, Some(2));
        assert_eq!(queue_url(&conn, "s3x-list-main").await.unwrap(), main);
        let d = queue_details(&conn, &dlq).await.unwrap();
        assert!(d.is_dlq);
        assert_eq!(dlq_sources(&conn, &dlq).await.unwrap(), vec![main]);
    }

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[tokio::test]
    #[ignore]
    async fn creates_configures_and_deletes() {
        let conn = connect().await;
        if let Ok(u) = queue_url(&conn, "s3x-crud.fifo").await {
            delete_queue(&conn, &u).await.unwrap();
        }
        let attrs = map(&[
            ("FifoQueue", "true"),
            ("ContentBasedDeduplication", "true"),
            ("VisibilityTimeout", "45"),
        ]);
        let tags = map(&[("env", "dev")]);
        assert!(
            create_queue(&conn, "s3x-crud", &attrs, &tags)
                .await
                .is_err(),
            "needs .fifo"
        );
        let url = create_queue(&conn, "s3x-crud.fifo", &attrs, &tags)
            .await
            .unwrap();
        let q = queue_details(&conn, &url).await.unwrap();
        assert!(q.fifo);
        assert_eq!(
            q.attributes.get("VisibilityTimeout").map(String::as_str),
            Some("45")
        );

        set_attributes(
            &conn,
            &url,
            &map(&[("VisibilityTimeout", "60"), ("DelaySeconds", "5")]),
        )
        .await
        .unwrap();
        let q = queue_details(&conn, &url).await.unwrap();
        assert_eq!(
            q.attributes.get("VisibilityTimeout").map(String::as_str),
            Some("60")
        );
        assert_eq!(
            q.attributes.get("DelaySeconds").map(String::as_str),
            Some("5")
        );

        set_tags(&conn, &url, &map(&[("team", "a")])).await.unwrap();
        assert_eq!(list_tags(&conn, &url).await.unwrap(), map(&[("team", "a")]));

        delete_queue(&conn, &url).await.unwrap();
        assert!(queue_url(&conn, "s3x-crud.fifo").await.is_err());
    }

    #[tokio::test]
    #[ignore]
    async fn purges() {
        let conn = connect().await;
        let url = fresh_queue(&conn, "s3x-purge", &[]).await;
        for i in 0..3 {
            client(&conn)
                .send_message()
                .queue_url(&url)
                .message_body(format!("m{i}"))
                .send()
                .await
                .unwrap();
        }
        assert_eq!(queue_details(&conn, &url).await.unwrap().visible, Some(3));
        purge(&conn, &url).await.unwrap();
        assert_eq!(queue_details(&conn, &url).await.unwrap().visible, Some(0));
    }

    #[tokio::test]
    #[ignore]
    async fn redrives_from_a_dlq() {
        let conn = connect().await;
        let dlq = fresh_queue(&conn, "s3x-rd-dlq", &[]).await;
        let dlq_arn = queue_details(&conn, &dlq).await.unwrap().arn.unwrap();
        let policy = format!(r#"{{"deadLetterTargetArn":"{dlq_arn}","maxReceiveCount":"1"}}"#);
        let src = fresh_queue(&conn, "s3x-rd-src", &[("RedrivePolicy", &policy)]).await;
        for i in 0..3 {
            client(&conn)
                .send_message()
                .queue_url(&dlq)
                .message_body(format!("m{i}"))
                .send()
                .await
                .unwrap();
        }
        match start_redrive(&conn, &dlq_arn, None, None).await {
            Ok(handle) => {
                assert!(!handle.is_empty());
                let tasks = list_redrives(&conn, &dlq_arn).await.unwrap();
                assert!(!tasks.is_empty());
                let _ = cancel_redrive(&conn, &handle).await;
            }
            // Some emulators don't implement message move tasks.
            Err(e) => eprintln!("redrive not supported by the emulator: {}", e.message),
        }
        let _ = src;
    }
}
