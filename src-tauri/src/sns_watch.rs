//! Watch a topic: a temporary SQS queue subscribed to it, polled while the
//! topic is open, then unsubscribed and deleted.
//!
//! Active watches are kept here (with their connection) so they can be
//! stopped even if read-only mode is switched on meanwhile, and cleaned up
//! when the app exits.

use crate::error::AppError;
use crate::s3::Connection;
use crate::sns::{self, other};
use crate::sqs;
use aws_sdk_sqs::types::{MessageSystemAttributeName, QueueAttributeName};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Arc, LazyLock, Mutex};

/// Queue names start with this, so leftovers can be found.
pub const PREFIX: &str = "s3x-watch-";
/// Tag on every watch queue (leftover cleanup only deletes queues with it).
const TAG: (&str, &str) = ("created-by", "nimbus-explorer-watch");
/// The same tag's value from before the rename to Nimbus Explorer.
const OLD_TAG_VALUE: &str = "aws-explorer-watch";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchInfo {
    pub id: String,
    pub topic_arn: String,
    pub queue_url: String,
    pub queue_arn: String,
    pub subscription_arn: String,
    pub raw: bool,
}

struct Active {
    info: WatchInfo,
    conn: Arc<Connection>,
}

static WATCHES: LazyLock<Mutex<BTreeMap<String, Active>>> = LazyLock::new(Default::default);

fn get(id: &str) -> Result<(WatchInfo, Arc<Connection>), AppError> {
    let w = WATCHES.lock().unwrap();
    let a = w
        .get(id)
        .ok_or_else(|| other("This watch has already stopped"))?;
    Ok((a.info.clone(), a.conn.clone()))
}

/// A queue name for watching `topic_name`: at most 80 characters, ".fifo"
/// kept for FIFO topics.
pub fn queue_name(topic_name: &str, suffix: &str) -> String {
    let (base, fifo) = match topic_name.strip_suffix(".fifo") {
        Some(b) => (b, ".fifo"),
        None => (topic_name, ""),
    };
    let room = 80 - PREFIX.len() - suffix.len() - 1 - fifo.len();
    let base: String = base.chars().take(room).collect();
    format!("{PREFIX}{base}-{suffix}{fifo}")
}

fn random_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{:08x}",
        (nanos as u64 ^ (std::process::id() as u64).rotate_left(32)) & 0xffff_ffff
    )
}

/// Creates the queue (policy letting the topic send, 1-hour retention),
/// subscribes it and registers the watch.
pub async fn start(
    conn: Arc<Connection>,
    topic_arn: &str,
    raw: bool,
) -> Result<WatchInfo, AppError> {
    let topic_name = sns::name_from_arn(topic_arn);
    let fifo = topic_name.ends_with(".fifo");
    let name = queue_name(&topic_name, &random_suffix());
    let c = sqs::client(&conn);
    let mut create = c
        .create_queue()
        .queue_name(&name)
        .attributes(QueueAttributeName::MessageRetentionPeriod, "3600")
        .tags(TAG.0, TAG.1);
    if fifo {
        create = create
            .attributes(QueueAttributeName::FifoQueue, "true")
            .attributes(QueueAttributeName::ContentBasedDeduplication, "true");
    }
    let url = create
        .send()
        .await
        .map_err(|e| sqs::err(&conn, e))?
        .queue_url()
        .unwrap_or_default()
        .to_string();

    // From here on, undo what was made if a later step fails.
    let result = async {
        let arn = sqs::queue_details(&conn, &url)
            .await?
            .arn
            .ok_or_else(|| other("The new queue has no ARN"))?;
        let policy = sns::add_topic_statement("", &arn, topic_arn)?.unwrap_or_default();
        c.set_queue_attributes()
            .queue_url(&url)
            .attributes(QueueAttributeName::Policy, policy)
            .send()
            .await
            .map_err(|e| sqs::err(&conn, e))?;
        let attrs: BTreeMap<String, String> = if raw {
            [("RawMessageDelivery".to_string(), "true".to_string())].into()
        } else {
            BTreeMap::new()
        };
        let sub = sns::subscribe(&conn, topic_arn, "sqs", &arn, &attrs).await?;
        Ok::<_, AppError>((arn, sub))
    }
    .await;
    let (queue_arn, subscription_arn) = match result {
        Ok(v) => v,
        Err(e) => {
            let _ = c.delete_queue().queue_url(&url).send().await;
            return Err(e);
        }
    };
    let info = WatchInfo {
        id: name.clone(),
        topic_arn: topic_arn.to_string(),
        queue_url: url,
        queue_arn,
        subscription_arn,
        raw,
    };
    WATCHES.lock().unwrap().insert(
        name,
        Active {
            info: info.clone(),
            conn,
        },
    );
    Ok(info)
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchedMessage {
    /// The SNS message ID (the SQS one with raw delivery).
    pub message_id: String,
    /// When SNS published it (ISO 8601), or when it reached the queue.
    pub timestamp: Option<String>,
    pub subject: Option<String>,
    pub body: String,
    /// (name, type, value)
    pub attributes: Vec<(String, String, String)>,
    /// The full SNS JSON envelope (not with raw delivery).
    pub envelope: Option<String>,
}

/// Unpacks an SQS message body delivered by SNS.
pub fn unpack(body: &str, raw: bool) -> WatchedMessage {
    if !raw {
        if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(body) {
            if o.get("Type").and_then(Value::as_str) == Some("Notification") {
                let s = |k: &str| o.get(k).and_then(Value::as_str).map(String::from);
                let attributes = o
                    .get("MessageAttributes")
                    .and_then(Value::as_object)
                    .map(|m| {
                        m.iter()
                            .map(|(k, v)| {
                                let f = |n: &str| {
                                    v.get(n)
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_string()
                                };
                                (k.clone(), f("Type"), f("Value"))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                return WatchedMessage {
                    message_id: s("MessageId").unwrap_or_default(),
                    timestamp: s("Timestamp"),
                    subject: s("Subject"),
                    body: s("Message").unwrap_or_default(),
                    attributes,
                    envelope: Some(body.to_string()),
                };
            }
        }
    }
    WatchedMessage {
        body: body.to_string(),
        ..Default::default()
    }
}

/// Long-polls the watch queue once (up to `wait` seconds) and deletes what
/// it got: the queue only exists for this view.
pub async fn poll(id: &str, wait: i32) -> Result<Vec<WatchedMessage>, AppError> {
    let (info, conn) = get(id)?;
    let c = sqs::client(&conn);
    let out = c
        .receive_message()
        .queue_url(&info.queue_url)
        .max_number_of_messages(10)
        .wait_time_seconds(wait.clamp(0, 20))
        .message_attribute_names("All")
        .message_system_attribute_names(MessageSystemAttributeName::SentTimestamp)
        .send()
        .await
        .map_err(|e| sqs::err(&conn, e))?;
    let mut got = Vec::new();
    let mut handles = Vec::new();
    for m in out.messages() {
        let mut w = unpack(m.body().unwrap_or_default(), info.raw);
        if info.raw {
            w.message_id = m.message_id().unwrap_or_default().to_string();
            w.attributes = m
                .message_attributes()
                .map(|a| {
                    a.iter()
                        .map(|(k, v)| {
                            let value = v.string_value().map(String::from).unwrap_or_else(|| {
                                v.binary_value()
                                    .map(|b| aws_smithy_types::base64::encode(b.as_ref()))
                                    .unwrap_or_default()
                            });
                            (k.clone(), v.data_type().to_string(), value)
                        })
                        .collect()
                })
                .unwrap_or_default();
            w.attributes.sort();
        }
        if w.timestamp.is_none() {
            w.timestamp = m
                .attributes()
                .and_then(|a| a.get(&MessageSystemAttributeName::SentTimestamp))
                .and_then(|t| t.parse::<i64>().ok())
                .and_then(|ms| {
                    aws_smithy_types::DateTime::from_millis(ms)
                        .fmt(aws_smithy_types::date_time::Format::DateTime)
                        .ok()
                });
        }
        got.push(w);
        if let Some(h) = m.receipt_handle() {
            handles.push(h.to_string());
        }
    }
    if !handles.is_empty() {
        let _ = crate::sqs_messages::delete_messages(&conn, &info.queue_url, &handles).await;
    }
    Ok(got)
}

/// Unsubscribes and deletes the queue. Errors are reported, but the watch is
/// forgotten either way (leftovers can be cleaned up later).
pub async fn stop(id: &str) -> Result<(), AppError> {
    let Some(active) = WATCHES.lock().unwrap().remove(id) else {
        return Ok(());
    };
    teardown(
        &active.conn,
        &active.info.subscription_arn,
        &active.info.queue_url,
    )
    .await
}

async fn teardown(
    conn: &Connection,
    subscription_arn: &str,
    queue_url: &str,
) -> Result<(), AppError> {
    let unsub = if subscription_arn.starts_with("arn:") {
        sns::unsubscribe(conn, subscription_arn).await
    } else {
        Ok(())
    };
    let del = sqs::client(conn)
        .delete_queue()
        .queue_url(queue_url)
        .send()
        .await
        .map_err(|e| sqs::err(conn, e));
    unsub.and(del.map(|_| ()))
}

/// Stops every active watch (on exit).
pub async fn stop_all() {
    let ids: Vec<String> = WATCHES.lock().unwrap().keys().cloned().collect();
    for id in ids {
        let _ = stop(&id).await;
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Leftover {
    pub queue_url: String,
    pub queue_arn: String,
    pub subscription_arns: Vec<String>,
}

/// Watch queues (by name prefix and tag) not active in this app, e.g. after a crash.
pub async fn find_leftovers(conn: &Connection) -> Result<Vec<Leftover>, AppError> {
    let active: Vec<String> = WATCHES
        .lock()
        .unwrap()
        .values()
        .map(|a| a.info.queue_url.clone())
        .collect();
    let queues = sqs::list_queues(conn, PREFIX).await?;
    let c = sqs::client(conn);
    let mut found = Vec::new();
    for q in queues {
        if active.contains(&q.url) {
            continue;
        }
        let tags = c
            .list_queue_tags()
            .queue_url(&q.url)
            .send()
            .await
            .map_err(|e| sqs::err(conn, e))?;
        let created_by = tags.tags().and_then(|t| t.get(TAG.0)).map(String::as_str);
        if created_by != Some(TAG.1) && created_by != Some(OLD_TAG_VALUE) {
            continue;
        }
        found.push(Leftover {
            queue_url: q.url,
            queue_arn: q.arn.unwrap_or_default(),
            subscription_arns: Vec::new(),
        });
    }
    if !found.is_empty() {
        for s in sns::list_subscriptions(conn, None).await? {
            if let Some(l) = found.iter_mut().find(|l| l.queue_arn == s.endpoint) {
                l.subscription_arns.push(s.arn);
            }
        }
    }
    Ok(found)
}

/// Deletes leftover watch queues and their subscriptions; returns how many queues.
pub async fn clean_leftovers(conn: &Connection) -> Result<usize, AppError> {
    let found = find_leftovers(conn).await?;
    for l in &found {
        for s in &l.subscription_arns {
            if s.starts_with("arn:") {
                sns::unsubscribe(conn, s).await?;
            }
        }
        teardown(conn, "", &l.queue_url).await?;
    }
    Ok(found.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_names() {
        assert_eq!(queue_name("orders", "ab12"), "s3x-watch-orders-ab12");
        assert_eq!(queue_name("pay.fifo", "ab12"), "s3x-watch-pay-ab12.fifo");
        let long = queue_name(&format!("{}.fifo", "x".repeat(300)), "ab12cd34");
        assert_eq!(long.len(), 80);
        assert!(long.ends_with("-ab12cd34.fifo"));
    }

    #[test]
    fn unpacks_envelopes() {
        let env = r#"{"Type":"Notification","MessageId":"m1","TopicArn":"t","Subject":"S","Message":"{\"a\":1}","Timestamp":"2026-10-25T10:00:00.000Z","MessageAttributes":{"kind":{"Type":"String","Value":"order"}}}"#;
        let w = unpack(env, false);
        assert_eq!(w.message_id, "m1");
        assert_eq!(w.subject.as_deref(), Some("S"));
        assert_eq!(w.body, "{\"a\":1}");
        assert_eq!(
            w.attributes,
            vec![("kind".into(), "String".into(), "order".into())]
        );
        assert!(w.envelope.is_some());
        let raw = unpack(env, true);
        assert_eq!(raw.body, env);
        assert!(raw.envelope.is_none());
        assert_eq!(unpack("plain", false).body, "plain");
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::sns::emulator_tests::{connect, fresh_topic};
    use crate::sns_publish::{publish, PubMessage};
    use crate::sqs_messages::MsgAttribute;

    async fn poll_until(id: &str, n: usize) -> Vec<WatchedMessage> {
        let mut got = Vec::new();
        for _ in 0..10 {
            got.extend(poll(id, 1).await.unwrap());
            if got.len() >= n {
                break;
            }
        }
        got
    }

    #[tokio::test]
    #[ignore]
    async fn watches_a_topic_and_cleans_up() {
        let conn = Arc::new(connect().await);
        let _ = clean_leftovers(&conn).await;
        let topic = fresh_topic(&conn, "s3x-sns-watch", &[]).await;
        for raw in [false, true] {
            let w = start(conn.clone(), &topic, raw).await.unwrap();
            assert!(w.queue_url.contains(PREFIX));
            let m = PubMessage {
                body: format!("hello {raw}"),
                subject: Some("Hi".into()),
                attributes: vec![MsgAttribute {
                    name: "kind".into(),
                    data_type: "String".into(),
                    value: "order".into(),
                }],
                ..Default::default()
            };
            publish(&conn, &topic, &m).await.unwrap();
            let got = poll_until(&w.id, 1).await;
            assert_eq!(got.len(), 1, "raw={raw}");
            assert_eq!(got[0].body, format!("hello {raw}"));
            assert_eq!(got[0].attributes[0].2, "order");
            assert_eq!(got[0].envelope.is_some(), !raw);
            assert!(got[0].timestamp.is_some());
            stop(&w.id).await.unwrap();
            assert!(poll(&w.id, 0).await.is_err());
            assert!(sns::list_subscriptions(&conn, Some(&topic))
                .await
                .unwrap()
                .is_empty());
            assert!(!sqs::list_queues(&conn, PREFIX)
                .await
                .unwrap()
                .iter()
                .any(|q| q.url == w.queue_url));
        }

        // A watch the app forgot about (e.g. a crash) shows up as a leftover.
        let w = start(conn.clone(), &topic, false).await.unwrap();
        WATCHES.lock().unwrap().remove(&w.id);
        let found = find_leftovers(&conn).await.unwrap();
        assert!(found
            .iter()
            .any(|l| l.queue_url == w.queue_url && l.subscription_arns.len() == 1));
        assert!(clean_leftovers(&conn).await.unwrap() >= 1);
        assert!(sns::list_subscriptions(&conn, Some(&topic))
            .await
            .unwrap()
            .is_empty());
    }
}
