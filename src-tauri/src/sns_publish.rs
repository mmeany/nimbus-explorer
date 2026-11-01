//! SNS publish: one message, a batch, or every message in a file.

use crate::error::AppError;
use crate::s3::Connection;
use crate::sns::{client, err, other};
use crate::sqs_messages::{
    parse_values, BatchFailure, BatchReport, FilePreview, MsgAttribute, SendResult,
};
use aws_sdk_sns::types::{MessageAttributeValue, PublishBatchRequestEntry};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// PublishBatch takes at most 10 entries.
const BATCH: usize = 10;
/// SNS messages (body + attributes) can be at most 256 KiB.
pub const MAX_BYTES: usize = 262_144;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PubMessage {
    pub body: String,
    /// Email subject (also in the JSON envelope other protocols get).
    pub subject: Option<String>,
    /// "json": body is {"default": …, "<protocol>": …} with a message per protocol.
    pub message_structure: Option<String>,
    /// Data types: String, String.Array, Number, Binary.
    pub attributes: Vec<MsgAttribute>,
    /// FIFO only.
    pub group_id: Option<String>,
    /// FIFO only (optional with content-based deduplication).
    pub dedup_id: Option<String>,
}

fn non_empty(v: &Option<String>) -> Option<String> {
    v.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
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
        if a.data_type == "String.Array"
            && !serde_json::from_str::<Value>(&a.value).is_ok_and(|v| v.is_array())
        {
            return Err(other(format!(
                "Attribute {}: String.Array values are a JSON array",
                a.name
            )));
        }
        b.string_value(&a.value)
    };
    b.build().map_err(|e| other(e.to_string()))
}

type AttrMap = Option<std::collections::HashMap<String, MessageAttributeValue>>;

fn attr_map(attrs: &[MsgAttribute]) -> Result<AttrMap, AppError> {
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

/// Checks the parts SNS would reject with a less helpful message.
pub fn message_problem(m: &PubMessage) -> Option<String> {
    if m.body.is_empty() {
        return Some("The message can't be empty".into());
    }
    if let Some(s) = non_empty(&m.subject) {
        if s.chars().count() > 100 || s.chars().any(|c| c.is_control()) {
            return Some("The subject must be under 100 characters, on one line".into());
        }
    }
    if m.message_structure.as_deref() == Some("json") {
        match serde_json::from_str::<Value>(&m.body) {
            Ok(Value::Object(o)) => {
                if !o.get("default").is_some_and(Value::is_string) {
                    return Some("A per-protocol message needs a \"default\" message".into());
                }
                if let Some((k, _)) = o.iter().find(|(_, v)| !v.is_string()) {
                    return Some(format!("The \"{k}\" message must be a string"));
                }
            }
            _ => return Some("A per-protocol message is a JSON object of strings".into()),
        }
    }
    let size = m.body.len()
        + m.attributes
            .iter()
            .map(|a| a.name.len() + a.data_type.len() + a.value.len())
            .sum::<usize>();
    if size > MAX_BYTES {
        return Some(format!(
            "The message is {size} bytes; SNS allows {MAX_BYTES}"
        ));
    }
    None
}

pub async fn publish(
    conn: &Connection,
    topic_arn: &str,
    m: &PubMessage,
) -> Result<SendResult, AppError> {
    if let Some(p) = message_problem(m) {
        return Err(other(p));
    }
    let out = client(conn)
        .publish()
        .topic_arn(topic_arn)
        .message(&m.body)
        .set_subject(non_empty(&m.subject))
        .set_message_structure(non_empty(&m.message_structure))
        .set_message_attributes(attr_map(&m.attributes)?)
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

/// Publishes 10 per PublishBatch call; reports failures by position.
pub async fn publish_batch(
    conn: &Connection,
    topic_arn: &str,
    msgs: &[PubMessage],
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
                if let Some(p) = message_problem(m) {
                    return Err(other(p));
                }
                PublishBatchRequestEntry::builder()
                    .id(format!("m{}", base + i))
                    .message(&m.body)
                    .set_subject(non_empty(&m.subject))
                    .set_message_structure(non_empty(&m.message_structure))
                    .set_message_attributes(attr_map(&m.attributes)?)
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
            .publish_batch()
            .topic_arn(topic_arn)
            .set_publish_batch_request_entries(Some(entries))
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
                    return Err(e); // e.g. access denied: nothing was published
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

/// A JSON value as a message: the body, or (envelope) an object with body /
/// subject / messageStructure / attributes / groupId / dedupId.
fn to_message(v: Value, envelope: bool) -> Result<PubMessage, String> {
    let text = |v: Value| match v {
        Value::String(s) => s,
        other => other.to_string(),
    };
    if !envelope {
        return Ok(PubMessage {
            body: text(v),
            ..Default::default()
        });
    }
    let Value::Object(mut o) = v else {
        return Err("expected an object with \"body\"".into());
    };
    let body = o.remove("body").ok_or("missing \"body\"")?;
    let mut m: PubMessage = serde_json::from_value(Value::Object(o)).map_err(|e| e.to_string())?;
    m.body = text(body);
    Ok(m)
}

pub fn parse_messages(text: &str, envelope: bool) -> Result<Vec<PubMessage>, String> {
    parse_values(text)?
        .into_iter()
        .enumerate()
        .map(|(i, v)| to_message(v, envelope).map_err(|e| format!("Message {}: {e}", i + 1)))
        .collect()
}

async fn read_file(path: &str, envelope: bool) -> Result<Vec<PubMessage>, AppError> {
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

/// Publishes every message in a file. `group_id` fills in a missing FIFO group;
/// `subject` a missing subject.
pub async fn publish_file(
    conn: &Connection,
    topic_arn: &str,
    path: &str,
    envelope: bool,
    group_id: Option<String>,
    subject: Option<String>,
) -> Result<BatchReport, AppError> {
    let mut msgs = read_file(path, envelope).await?;
    for m in &mut msgs {
        if non_empty(&m.group_id).is_none() {
            m.group_id = non_empty(&group_id);
        }
        if non_empty(&m.subject).is_none() {
            m.subject = non_empty(&subject);
        }
    }
    publish_batch(conn, topic_arn, &msgs).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(body: &str) -> PubMessage {
        PubMessage {
            body: body.into(),
            ..Default::default()
        }
    }

    #[test]
    fn checks_messages() {
        assert_eq!(message_problem(&msg("hi")), None);
        assert!(message_problem(&msg("")).is_some());
        let mut m = msg(r#"{"default":"d","sqs":"q"}"#);
        m.message_structure = Some("json".into());
        assert_eq!(message_problem(&m), None);
        m.body = r#"{"sqs":"q"}"#.into();
        assert!(message_problem(&m).unwrap().contains("default"));
        m.body = r#"{"default":"d","sqs":{"a":1}}"#.into();
        assert!(message_problem(&m).unwrap().contains("sqs"));
        let mut m = msg("x");
        m.subject = Some("two\nlines".into());
        assert!(message_problem(&m).is_some());
        assert!(message_problem(&msg(&"x".repeat(MAX_BYTES + 1))).is_some());
    }

    #[test]
    fn parses_files() {
        let m = parse_messages("{\"a\":1}\n\"plain\"\n", false).unwrap();
        assert_eq!(m[0].body, "{\"a\":1}");
        assert_eq!(m[1].body, "plain");
        let m = parse_messages(
            r#"[{"body":{"a":1},"subject":"S","groupId":"g","attributes":[{"name":"k","dataType":"String","value":"v"}]}]"#,
            true,
        )
        .unwrap();
        assert_eq!(m[0].body, "{\"a\":1}");
        assert_eq!(m[0].subject.as_deref(), Some("S"));
        assert_eq!(m[0].attributes.len(), 1);
        assert!(parse_messages(r#"[{"subject":"x"}]"#, true)
            .unwrap_err()
            .contains("body"));
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::sns::emulator_tests::{connect, fresh_topic};

    #[tokio::test]
    #[ignore]
    async fn publishes_single_batch_and_file() {
        let conn = connect().await;
        let topic = fresh_topic(&conn, "s3x-sns-pub", &[]).await;
        let mut m = msg_with_attrs("hello");
        m.subject = Some("Hi".into());
        assert!(!publish(&conn, &topic, &m)
            .await
            .unwrap()
            .message_id
            .is_empty());

        let mut per = PubMessage {
            body: r#"{"default":"d","email":"e"}"#.into(),
            ..Default::default()
        };
        per.message_structure = Some("json".into());
        publish(&conn, &topic, &per).await.unwrap();

        let msgs: Vec<PubMessage> = (0..12)
            .map(|i| msg_with_attrs(&format!("m{i}")))
            .chain([PubMessage::default()])
            .collect();
        let r = publish_batch(&conn, &topic, &msgs).await.unwrap();
        assert_eq!(r.sent, 12);
        assert_eq!(r.failed.len(), 1);
        assert_eq!(r.failed[0].index, 12);

        let dir = std::env::temp_dir().join("s3x-sns-pub.jsonl");
        tokio::fs::write(&dir, "\"a\"\n\"b\"\n").await.unwrap();
        let p = dir.to_string_lossy().to_string();
        assert_eq!(preview_file(&p, false).await.unwrap().count, 2);
        assert_eq!(
            publish_file(&conn, &topic, &p, false, None, Some("S".into()))
                .await
                .unwrap()
                .sent,
            2
        );
        let _ = tokio::fs::remove_file(&dir).await;
    }

    fn msg_with_attrs(body: &str) -> PubMessage {
        PubMessage {
            body: body.into(),
            attributes: vec![
                MsgAttribute {
                    name: "kind".into(),
                    data_type: "String".into(),
                    value: "order".into(),
                },
                MsgAttribute {
                    name: "tags".into(),
                    data_type: "String.Array".into(),
                    value: r#"["a","b"]"#.into(),
                },
            ],
            ..Default::default()
        }
    }
}
