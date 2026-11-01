//! SQS messages: send (single, batch, from a file).

use crate::error::AppError;
use crate::s3::Connection;
use crate::sqs::{client, err, other};
use aws_sdk_sqs::types::{
    ChangeMessageVisibilityBatchRequestEntry, DeleteMessageBatchRequestEntry,
    MessageAttributeValue, MessageSystemAttributeName, SendMessageBatchRequestEntry,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// SendMessageBatch takes at most 10 entries.
const BATCH: usize = 10;
/// Most messages a file send will take.
const MAX_FILE_MESSAGES: usize = 100_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MsgAttribute {
    pub name: String,
    /// "String", "Number" or "Binary", optionally with a ".label" suffix.
    pub data_type: String,
    /// Text for String/Number; base64 for Binary.
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct OutMessage {
    pub body: String,
    pub attributes: Vec<MsgAttribute>,
    pub delay_seconds: Option<i32>,
    /// FIFO only.
    pub group_id: Option<String>,
    /// FIFO only (optional with content-based deduplication).
    pub dedup_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub message_id: String,
    pub sequence_number: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFailure {
    /// 0-based position in the input.
    pub index: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchReport {
    pub sent: usize,
    pub failed: Vec<BatchFailure>,
}

fn attr_value(a: &MsgAttribute) -> Result<MessageAttributeValue, AppError> {
    let b = MessageAttributeValue::builder().data_type(&a.data_type);
    let b = if a.data_type.starts_with("Binary") {
        let bytes = aws_smithy_types::base64::decode(a.value.trim()).map_err(|_| {
            other(format!(
                "Attribute {}: Binary values must be base64",
                a.name
            ))
        })?;
        b.binary_value(aws_smithy_types::Blob::new(bytes))
    } else {
        b.string_value(&a.value)
    };
    b.build().map_err(|e| other(e.to_string()))
}

fn attr_map(
    attrs: &[MsgAttribute],
) -> Result<Option<std::collections::HashMap<String, MessageAttributeValue>>, AppError> {
    if attrs.is_empty() {
        return Ok(None);
    }
    if attrs.len() > 10 {
        return Err(other("At most 10 message attributes"));
    }
    attrs
        .iter()
        .map(|a| Ok((a.name.clone(), attr_value(a)?)))
        .collect::<Result<_, AppError>>()
        .map(Some)
}

fn non_empty(v: &Option<String>) -> Option<String> {
    v.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

pub async fn send(conn: &Connection, url: &str, m: &OutMessage) -> Result<SendResult, AppError> {
    if m.body.is_empty() {
        return Err(other("The message body can't be empty"));
    }
    let out = client(conn)
        .send_message()
        .queue_url(url)
        .message_body(&m.body)
        .set_message_attributes(attr_map(&m.attributes)?)
        .set_delay_seconds(m.delay_seconds.filter(|d| *d > 0))
        .set_message_group_id(non_empty(&m.group_id))
        .set_message_deduplication_id(non_empty(&m.dedup_id))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(SendResult {
        message_id: out.message_id().unwrap_or_default().to_string(),
        sequence_number: out.sequence_number().map(String::from),
    })
}

/// Sends messages 10 per SendMessageBatch call; reports failures by position.
pub async fn send_batch(
    conn: &Connection,
    url: &str,
    msgs: &[OutMessage],
) -> Result<BatchReport, AppError> {
    let client = client(conn);
    let mut report = BatchReport {
        sent: 0,
        failed: Vec::new(),
    };
    for (chunk_no, chunk) in msgs.chunks(BATCH).enumerate() {
        let base = chunk_no * BATCH;
        let mut entries = Vec::new();
        for (i, m) in chunk.iter().enumerate() {
            let entry = (|| {
                if m.body.is_empty() {
                    return Err(other("Empty body"));
                }
                SendMessageBatchRequestEntry::builder()
                    .id(format!("m{}", base + i))
                    .message_body(&m.body)
                    .set_message_attributes(attr_map(&m.attributes)?)
                    .set_delay_seconds(m.delay_seconds.filter(|d| *d > 0))
                    .set_message_group_id(non_empty(&m.group_id))
                    .set_message_deduplication_id(non_empty(&m.dedup_id))
                    .build()
                    .map_err(|e| other(e.to_string()))
            })();
            match entry {
                Ok(e) => entries.push(e),
                Err(e) => report.failed.push(BatchFailure {
                    index: base + i,
                    message: e.message,
                }),
            }
        }
        if entries.is_empty() {
            continue;
        }
        let ids: Vec<usize> = entries
            .iter()
            .map(|e| e.id()[1..].parse().unwrap_or(0))
            .collect();
        match client
            .send_message_batch()
            .queue_url(url)
            .set_entries(Some(entries))
            .send()
            .await
        {
            Ok(out) => {
                report.sent += out.successful().len();
                for f in out.failed() {
                    report.failed.push(BatchFailure {
                        index: f.id()[1..].parse().unwrap_or(0),
                        message: f.message().unwrap_or(f.code()).to_string(),
                    });
                }
            }
            Err(e) => {
                let e = err(conn, e);
                if report.sent == 0 && report.failed.is_empty() && chunk_no == 0 {
                    return Err(e); // e.g. access denied: nothing was sent
                }
                for index in ids {
                    report.failed.push(BatchFailure {
                        index,
                        message: e.message.clone(),
                    });
                }
            }
        }
    }
    report.failed.sort_by_key(|f| f.index);
    Ok(report)
}

/// Turns a JSON value into a message: as the body, or (envelope) an object
/// with body / attributes / groupId / dedupId / delaySeconds.
fn to_message(v: Value, envelope: bool) -> Result<OutMessage, String> {
    if envelope {
        let m: OutMessage = match &v {
            Value::Object(o) => {
                let mut o = o.clone();
                let body = match o.remove("body") {
                    Some(Value::String(s)) => s,
                    Some(other) => other.to_string(),
                    None => return Err("missing \"body\"".into()),
                };
                let mut m: OutMessage =
                    serde_json::from_value(Value::Object(o)).map_err(|e| e.to_string())?;
                m.body = body;
                m
            }
            _ => return Err("expected an object with \"body\"".into()),
        };
        Ok(m)
    } else {
        Ok(OutMessage {
            body: match v {
                Value::String(s) => s,
                other => other.to_string(),
            },
            ..Default::default()
        })
    }
}

/// Reads a JSON array or JSON-lines text into values.
pub fn parse_values(text: &str) -> Result<Vec<Value>, String> {
    let t = text.trim_start();
    let values: Vec<Value> = if t.starts_with('[') {
        serde_json::from_str(t).map_err(|e| format!("Not a valid JSON array: {e}"))?
    } else {
        t.lines()
            .enumerate()
            .filter(|(_, l)| !l.trim().is_empty())
            .map(|(i, l)| serde_json::from_str(l).map_err(|e| format!("Line {}: {e}", i + 1)))
            .collect::<Result<_, _>>()?
    };
    if values.len() > MAX_FILE_MESSAGES {
        return Err(format!("At most {MAX_FILE_MESSAGES} messages per file"));
    }
    Ok(values)
}

/// Reads a JSON array or JSON-lines file into messages.
pub fn parse_messages(text: &str, envelope: bool) -> Result<Vec<OutMessage>, String> {
    parse_values(text)?
        .into_iter()
        .enumerate()
        .map(|(i, v)| to_message(v, envelope).map_err(|e| format!("Message {}: {e}", i + 1)))
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub count: usize,
    /// First few bodies (truncated).
    pub samples: Vec<String>,
}

async fn read_file(path: &str, envelope: bool) -> Result<Vec<OutMessage>, AppError> {
    let text = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| other(format!("Couldn't read {path}: {e}")))?;
    parse_messages(&text, envelope).map_err(other)
}

pub async fn preview_file(path: &str, envelope: bool) -> Result<FilePreview, AppError> {
    let msgs = read_file(path, envelope).await?;
    Ok(FilePreview {
        count: msgs.len(),
        samples: msgs
            .iter()
            .take(5)
            .map(|m| {
                let mut s: String = m.body.chars().take(200).collect();
                if m.body.chars().count() > 200 {
                    s.push('…');
                }
                s
            })
            .collect(),
    })
}

/// Sends every message in a file. `group_id` fills in a missing FIFO group.
pub async fn send_file(
    conn: &Connection,
    url: &str,
    path: &str,
    envelope: bool,
    group_id: Option<String>,
) -> Result<BatchReport, AppError> {
    let mut msgs = read_file(path, envelope).await?;
    if let Some(g) = non_empty(&group_id) {
        for m in &mut msgs {
            if non_empty(&m.group_id).is_none() {
                m.group_id = Some(g.clone());
            }
        }
    }
    send_batch(conn, url, &msgs).await
}

// ---------------------------------------------------------------------------
// Receive (peek / hold), delete, release, export

/// Most messages one "Get messages" fetches.
const MAX_RECEIVE: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InMessage {
    pub message_id: String,
    pub receipt_handle: String,
    pub body: String,
    pub md5_of_body: Option<String>,
    /// System attributes: SentTimestamp, ApproximateReceiveCount,
    /// ApproximateFirstReceiveTimestamp, SenderId, MessageGroupId, …
    pub system: std::collections::BTreeMap<String, String>,
    pub attributes: Vec<MsgAttribute>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiveOptions {
    /// How many messages to try to get (1..=500).
    pub max: usize,
    /// 0 = peek (messages stay visible); otherwise hidden for this long.
    pub visibility_timeout: i32,
    /// Long-poll wait for the first call (0..=20).
    pub wait_seconds: i32,
}

fn to_in_message(m: &aws_sdk_sqs::types::Message) -> InMessage {
    let mut attributes: Vec<MsgAttribute> = m
        .message_attributes()
        .map(|a| {
            a.iter()
                .map(|(name, val)| MsgAttribute {
                    name: name.clone(),
                    data_type: val.data_type().to_string(),
                    value: match val.binary_value() {
                        Some(b) => aws_smithy_types::base64::encode(b.as_ref()),
                        None => val.string_value().unwrap_or_default().to_string(),
                    },
                })
                .collect()
        })
        .unwrap_or_default();
    attributes.sort_by(|a, b| a.name.cmp(&b.name));
    InMessage {
        message_id: m.message_id().unwrap_or_default().to_string(),
        receipt_handle: m.receipt_handle().unwrap_or_default().to_string(),
        body: m.body().unwrap_or_default().to_string(),
        md5_of_body: m.md5_of_body().map(String::from),
        system: m
            .attributes()
            .map(|a| {
                a.iter()
                    .map(|(k, v)| (k.as_str().to_string(), v.clone()))
                    .collect()
            })
            .unwrap_or_default(),
        attributes,
    }
}

/// While peeking, messages are hidden this long so later calls return the
/// next ones; all are released (visibility 0) as soon as collection ends.
const PEEK_HOLD_SECONDS: i32 = 20;

/// Receives up to `max` messages, 10 per call. Peek (`visibility_timeout` 0)
/// holds them briefly while collecting and then releases them all, so they're
/// visible again straight away. Results are de-duplicated by message ID
/// (keeping the newest receipt handle); fetching stops after two calls that
/// bring nothing new.
pub async fn receive(
    conn: &Connection,
    url: &str,
    opts: &ReceiveOptions,
) -> Result<Vec<InMessage>, AppError> {
    let max = opts.max.clamp(1, MAX_RECEIVE);
    let peek = opts.visibility_timeout <= 0;
    let visibility = if peek {
        PEEK_HOLD_SECONDS
    } else {
        opts.visibility_timeout.min(43200)
    };
    let client = client(conn);
    let mut out: Vec<InMessage> = Vec::new();
    let mut idle = 0;
    let mut first = true;
    while out.len() < max && idle < 2 {
        let want = (max - out.len()).min(10) as i32;
        let res = client
            .receive_message()
            .queue_url(url)
            .max_number_of_messages(want)
            .visibility_timeout(visibility)
            .wait_time_seconds(if first {
                opts.wait_seconds.clamp(0, 20)
            } else {
                0
            })
            .message_system_attribute_names(MessageSystemAttributeName::All)
            .message_attribute_names("All")
            .send()
            .await;
        let res = match res {
            Ok(r) => r,
            Err(e) => {
                let e = err(conn, e);
                if peek {
                    release(conn, url, &out).await;
                }
                return Err(e);
            }
        };
        first = false;
        let mut new = 0;
        for m in res.messages() {
            let im = to_in_message(m);
            match out.iter_mut().find(|x| x.message_id == im.message_id) {
                Some(existing) => *existing = im,
                None => {
                    out.push(im);
                    new += 1;
                }
            }
        }
        if new == 0 {
            idle += 1;
        } else {
            idle = 0;
        }
    }
    if peek {
        release(conn, url, &out).await;
    }
    out.truncate(max);
    Ok(out)
}

/// Best-effort: makes received messages visible again.
async fn release(conn: &Connection, url: &str, msgs: &[InMessage]) {
    let handles: Vec<String> = msgs.iter().map(|m| m.receipt_handle.clone()).collect();
    let _ = change_visibility(conn, url, &handles, 0).await;
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandleReport {
    pub done: usize,
    /// Positions (in the handles given) that failed.
    pub failed: Vec<BatchFailure>,
}

/// Deletes messages by receipt handle (10 per call).
pub async fn delete_messages(
    conn: &Connection,
    url: &str,
    handles: &[String],
) -> Result<HandleReport, AppError> {
    let client = client(conn);
    let mut rep = HandleReport {
        done: 0,
        failed: Vec::new(),
    };
    for (c, chunk) in handles.chunks(BATCH).enumerate() {
        let entries = chunk
            .iter()
            .enumerate()
            .map(|(i, h)| {
                DeleteMessageBatchRequestEntry::builder()
                    .id(format!("d{}", c * BATCH + i))
                    .receipt_handle(h)
                    .build()
                    .map_err(|e| other(e.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let out = client
            .delete_message_batch()
            .queue_url(url)
            .set_entries(Some(entries))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        rep.done += out.successful().len();
        rep.failed.extend(out.failed().iter().map(|f| BatchFailure {
            index: f.id()[1..].parse().unwrap_or(0),
            message: f.message().unwrap_or(f.code()).to_string(),
        }));
    }
    Ok(rep)
}

/// Sets the visibility timeout of received messages (0 = release now).
pub async fn change_visibility(
    conn: &Connection,
    url: &str,
    handles: &[String],
    seconds: i32,
) -> Result<HandleReport, AppError> {
    let client = client(conn);
    let mut rep = HandleReport {
        done: 0,
        failed: Vec::new(),
    };
    for (c, chunk) in handles.chunks(BATCH).enumerate() {
        let entries = chunk
            .iter()
            .enumerate()
            .map(|(i, h)| {
                ChangeMessageVisibilityBatchRequestEntry::builder()
                    .id(format!("v{}", c * BATCH + i))
                    .receipt_handle(h)
                    .visibility_timeout(seconds.clamp(0, 43200))
                    .build()
                    .map_err(|e| other(e.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let out = client
            .change_message_visibility_batch()
            .queue_url(url)
            .set_entries(Some(entries))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        rep.done += out.successful().len();
        rep.failed.extend(out.failed().iter().map(|f| BatchFailure {
            index: f.id()[1..].parse().unwrap_or(0),
            message: f.message().unwrap_or(f.code()).to_string(),
        }));
    }
    Ok(rep)
}

/// Writes messages as JSON lines (one object per message, receipt handles left out).
pub async fn export_messages(path: &str, messages: &[InMessage]) -> Result<usize, AppError> {
    let mut text = String::new();
    for m in messages {
        let line = serde_json::json!({
            "messageId": m.message_id,
            "body": m.body,
            "attributes": m.attributes,
            "system": m.system,
        });
        text.push_str(&line.to_string());
        text.push('\n');
    }
    tokio::fs::write(path, text)
        .await
        .map_err(|e| other(format!("Couldn't write {path}: {e}")))?;
    Ok(messages.len())
}

/// Moves up to `max` messages from one queue to another by receiving,
/// re-sending (body, attributes, FIFO group) and deleting each one only after
/// it was sent. Used when StartMessageMoveTask isn't available (emulators) or
/// for moving between arbitrary queues. Returns how many moved.
pub async fn move_messages(
    conn: &Connection,
    from_url: &str,
    to_url: &str,
    to_fifo: bool,
    max: usize,
) -> Result<BatchReport, AppError> {
    let mut report = BatchReport {
        sent: 0,
        failed: Vec::new(),
    };
    let mut idle = 0;
    while report.sent < max && idle < 2 {
        let want = (max - report.sent).min(10);
        let got = receive(
            conn,
            from_url,
            &ReceiveOptions {
                max: want,
                visibility_timeout: 60,
                wait_seconds: 0,
            },
        )
        .await?;
        if got.is_empty() {
            idle += 1;
            continue;
        }
        idle = 0;
        let out: Vec<OutMessage> = got
            .iter()
            .map(|m| OutMessage {
                body: m.body.clone(),
                attributes: m.attributes.clone(),
                delay_seconds: None,
                group_id: to_fifo.then(|| {
                    m.system
                        .get("MessageGroupId")
                        .cloned()
                        .unwrap_or_else(|| "redrive".into())
                }),
                dedup_id: to_fifo.then(|| m.message_id.clone()),
            })
            .collect();
        let sent = send_batch(conn, to_url, &out).await?;
        let failed: std::collections::BTreeSet<usize> =
            sent.failed.iter().map(|f| f.index).collect();
        let done: Vec<String> = got
            .iter()
            .enumerate()
            .filter(|(i, _)| !failed.contains(i))
            .map(|(_, m)| m.receipt_handle.clone())
            .collect();
        // Messages that failed to send go back to the source straight away.
        let back: Vec<String> = failed
            .iter()
            .filter_map(|i| got.get(*i))
            .map(|m| m.receipt_handle.clone())
            .collect();
        if !back.is_empty() {
            let _ = change_visibility(conn, from_url, &back, 0).await;
        }
        delete_messages(conn, from_url, &done).await?;
        report.sent += done.len();
        report
            .failed
            .extend(sent.failed.into_iter().map(|f| BatchFailure {
                index: report.sent + f.index,
                message: f.message,
            }));
        if !back.is_empty() && done.is_empty() {
            break; // nothing is getting through; stop rather than loop
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_files() {
        let arr = parse_messages(r#"["a", {"x": 1}, 5]"#, false).unwrap();
        let bodies: Vec<_> = arr.iter().map(|m| m.body.as_str()).collect();
        assert_eq!(bodies, vec!["a", r#"{"x":1}"#, "5"]);

        let jl = parse_messages("{\"x\":1}\n\n\"b\"\n", false).unwrap();
        assert_eq!(jl.len(), 2);
        assert!(parse_messages("{bad\n", false)
            .unwrap_err()
            .starts_with("Line 1"));

        let env = parse_messages(
            r#"[{"body": {"id": 7}, "groupId": "g1", "attributes": [{"name": "k", "dataType": "String", "value": "v"}]}]"#,
            true,
        )
        .unwrap();
        assert_eq!(env[0].body, r#"{"id":7}"#);
        assert_eq!(env[0].group_id.as_deref(), Some("g1"));
        assert_eq!(env[0].attributes[0].name, "k");
        assert!(parse_messages(r#"[{"nobody": 1}]"#, true).is_err());
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::sqs::emulator_tests::{connect, fresh_queue};
    use crate::sqs::queue_details;

    #[tokio::test]
    #[ignore]
    async fn sends_single_batch_and_file() {
        let conn = connect().await;
        let url = fresh_queue(&conn, "s3x-send", &[]).await;
        let r = send(
            &conn,
            &url,
            &OutMessage {
                body: "{\"a\":1}".into(),
                attributes: vec![
                    MsgAttribute {
                        name: "s".into(),
                        data_type: "String".into(),
                        value: "x".into(),
                    },
                    MsgAttribute {
                        name: "n".into(),
                        data_type: "Number".into(),
                        value: "42".into(),
                    },
                    MsgAttribute {
                        name: "b".into(),
                        data_type: "Binary".into(),
                        value: "aGk=".into(),
                    },
                ],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(!r.message_id.is_empty());

        let msgs: Vec<OutMessage> = (0..23)
            .map(|i| OutMessage {
                body: if i == 5 {
                    String::new()
                } else {
                    format!("m{i}")
                },
                ..Default::default()
            })
            .collect();
        let rep = send_batch(&conn, &url, &msgs).await.unwrap();
        assert_eq!(rep.sent, 22);
        assert_eq!(rep.failed.len(), 1);
        assert_eq!(rep.failed[0].index, 5);

        let dir = std::env::temp_dir().join("s3x-sqs-send");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("m.jsonl");
        std::fs::write(&file, "{\"n\":1}\n{\"n\":2}\n").unwrap();
        let path = file.to_string_lossy().into_owned();
        assert_eq!(preview_file(&path, false).await.unwrap().count, 2);
        let rep = send_file(&conn, &url, &path, false, None).await.unwrap();
        assert_eq!(rep.sent, 2);
        assert_eq!(queue_details(&conn, &url).await.unwrap().visible, Some(25));

        // FIFO: group id filled in from the default.
        let f = fresh_queue(
            &conn,
            "s3x-send.fifo",
            &[("FifoQueue", "true"), ("ContentBasedDeduplication", "true")],
        )
        .await;
        let rep = send_file(&conn, &f, &path, false, Some("g".into()))
            .await
            .unwrap();
        assert_eq!(rep.sent, 2);
    }

    #[tokio::test]
    #[ignore]
    async fn peeks_holds_releases_and_deletes() {
        let conn = connect().await;
        let url = fresh_queue(&conn, "s3x-recv", &[]).await;
        let msgs: Vec<OutMessage> = (0..15)
            .map(|i| OutMessage {
                body: format!("{{\"n\":{i}}}"),
                attributes: vec![MsgAttribute {
                    name: "k".into(),
                    data_type: "String".into(),
                    value: format!("v{i}"),
                }],
                ..Default::default()
            })
            .collect();
        send_batch(&conn, &url, &msgs).await.unwrap();

        // Peek: visible afterwards, receive count rises.
        let peek = ReceiveOptions {
            max: 50,
            visibility_timeout: 0,
            wait_seconds: 0,
        };
        let got = receive(&conn, &url, &peek).await.unwrap();
        assert_eq!(got.len(), 15);
        assert!(got[0].system.contains_key("ApproximateReceiveCount"));
        assert_eq!(got[0].attributes[0].name, "k");
        assert_eq!(queue_details(&conn, &url).await.unwrap().visible, Some(15));

        // Hold 5: hidden until released.
        let hold = ReceiveOptions {
            max: 5,
            visibility_timeout: 300,
            wait_seconds: 0,
        };
        let held = receive(&conn, &url, &hold).await.unwrap();
        assert_eq!(held.len(), 5);
        let q = queue_details(&conn, &url).await.unwrap();
        assert_eq!((q.visible, q.in_flight), (Some(10), Some(5)));
        let handles: Vec<String> = held.iter().map(|m| m.receipt_handle.clone()).collect();
        let rep = change_visibility(&conn, &url, &handles[..2], 0)
            .await
            .unwrap();
        assert_eq!(rep.done, 2);
        let rep = delete_messages(&conn, &url, &handles[2..]).await.unwrap();
        assert_eq!(rep.done, 3);
        let q = queue_details(&conn, &url).await.unwrap();
        assert_eq!((q.visible, q.in_flight), (Some(12), Some(0)));

        let dir = std::env::temp_dir().join("s3x-sqs-recv");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.jsonl").to_string_lossy().into_owned();
        assert_eq!(export_messages(&path, &held).await.unwrap(), 5);
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 5);
        assert!(!text.contains("receiptHandle"));
    }

    #[tokio::test]
    #[ignore]
    async fn moves_messages_between_queues() {
        let conn = connect().await;
        let from = fresh_queue(&conn, "s3x-mv-from", &[]).await;
        let to = fresh_queue(&conn, "s3x-mv-to.fifo", &[("FifoQueue", "true")]).await;
        let msgs: Vec<OutMessage> = (0..13)
            .map(|i| OutMessage {
                body: format!("m{i}"),
                ..Default::default()
            })
            .collect();
        send_batch(&conn, &from, &msgs).await.unwrap();
        let rep = move_messages(&conn, &from, &to, true, 100).await.unwrap();
        assert_eq!(rep.sent, 13);
        assert_eq!(queue_details(&conn, &from).await.unwrap().visible, Some(0));
        assert_eq!(queue_details(&conn, &to).await.unwrap().visible, Some(13));
    }
}
