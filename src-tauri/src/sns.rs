//! SNS: topics and subscriptions.

use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use aws_sdk_sns::Client;
use serde::Serialize;
use std::collections::BTreeMap;

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

/// Topic name from an ARN (last ':' segment).
pub fn name_from_arn(arn: &str) -> String {
    arn.rsplit(':').next().unwrap_or(arn).to_string()
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TopicInfo {
    pub name: String,
    pub arn: String,
    pub fifo: bool,
    pub display_name: Option<String>,
    pub confirmed: Option<i64>,
    pub pending: Option<i64>,
    pub deleted: Option<i64>,
    pub kms_key: Option<String>,
    pub content_based_dedup: bool,
    pub attributes: BTreeMap<String, String>,
    pub error: Option<String>,
}

pub fn apply_attributes(t: &mut TopicInfo, attrs: BTreeMap<String, String>) {
    let num = |k: &str| attrs.get(k).and_then(|v| v.parse::<i64>().ok());
    t.fifo = attrs.get("FifoTopic").is_some_and(|v| v == "true") || t.name.ends_with(".fifo");
    t.display_name = attrs.get("DisplayName").filter(|v| !v.is_empty()).cloned();
    t.confirmed = num("SubscriptionsConfirmed");
    t.pending = num("SubscriptionsPending");
    t.deleted = num("SubscriptionsDeleted");
    t.kms_key = attrs
        .get("KmsMasterKeyId")
        .filter(|v| !v.is_empty())
        .cloned();
    t.content_based_dedup = attrs
        .get("ContentBasedDeduplication")
        .is_some_and(|v| v == "true");
    t.attributes = attrs;
}

async fn topic_arns(conn: &Connection, c: &Client) -> Result<Vec<String>, AppError> {
    let mut out = Vec::new();
    let mut token = None;
    loop {
        let page = c
            .list_topics()
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        let before = out.len();
        out.extend(
            page.topics()
                .iter()
                .filter_map(|t| t.topic_arn().map(String::from)),
        );
        let next = page.next_token().map(String::from);
        if next.is_none() || out.len() == before || next == token {
            break;
        }
        token = next;
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// Every topic with its attributes (tests only; the UI pages with details_many).
#[cfg(test)]
pub async fn list_topics(conn: &Connection) -> Result<Vec<TopicInfo>, AppError> {
    let arns = list_topic_arns(conn).await?;
    details_many(conn, &arns).await
}

/// Every topic ARN, sorted by name (ListTopics returns 100 per call).
pub async fn list_topic_arns(conn: &Connection) -> Result<Vec<String>, AppError> {
    let mut arns = topic_arns(conn, &client(conn)).await?;
    arns.sort_by_key(|a| name_from_arn(a));
    Ok(arns)
}

/// Attributes for the given topics (the visible page), 8 at a time, in the
/// order given. A topic that can't be read gets `error` set.
pub async fn details_many(conn: &Connection, arns: &[String]) -> Result<Vec<TopicInfo>, AppError> {
    let c = client(conn);
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(ATTR_CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    for (i, arn) in arns.iter().enumerate() {
        let (c, arn, sem) = (c.clone(), arn.clone(), sem.clone());
        let (profile, endpoint) = (conn.info.profile.clone(), conn.info.endpoint_url.clone());
        set.spawn(async move {
            let _p = sem.acquire().await;
            let r = c
                .get_topic_attributes()
                .topic_arn(&arn)
                .send()
                .await
                .map(|o| {
                    o.attributes()
                        .map(|m| {
                            m.iter()
                                .map(|(k, v)| (k.clone(), v.clone()))
                                .collect::<BTreeMap<_, _>>()
                        })
                        .unwrap_or_default()
                })
                .map_err(|e| AppError::from_sdk(e, &profile, endpoint.as_deref()));
            (i, r)
        });
    }
    let mut topics: Vec<TopicInfo> = arns
        .iter()
        .map(|a| TopicInfo {
            name: name_from_arn(a),
            arn: a.clone(),
            ..Default::default()
        })
        .collect();
    while let Some(j) = set.join_next().await {
        let Ok((i, r)) = j else { continue };
        match r {
            Ok(attrs) => apply_attributes(&mut topics[i], attrs),
            Err(e) => topics[i].error = Some(e.message),
        }
    }
    Ok(topics)
}

pub async fn topic_details(conn: &Connection, arn: &str) -> Result<TopicInfo, AppError> {
    let out = client(conn)
        .get_topic_attributes()
        .topic_arn(arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let mut t = TopicInfo {
        name: name_from_arn(arn),
        arn: arn.to_string(),
        ..Default::default()
    };
    apply_attributes(
        &mut t,
        out.attributes()
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default(),
    );
    Ok(t)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionInfo {
    /// "PendingConfirmation" until confirmed.
    pub arn: String,
    pub topic_arn: String,
    pub protocol: String,
    pub endpoint: String,
    pub owner: Option<String>,
    pub pending: bool,
}

/// Subscriptions of one topic, or of the whole account (`topic_arn` None).
pub async fn list_subscriptions(
    conn: &Connection,
    topic_arn: Option<&str>,
) -> Result<Vec<SubscriptionInfo>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let (subs, next) = match topic_arn {
            Some(t) => {
                let p = c
                    .list_subscriptions_by_topic()
                    .topic_arn(t)
                    .set_next_token(token.clone())
                    .send()
                    .await
                    .map_err(|e| err(conn, e))?;
                (p.subscriptions().to_vec(), p.next_token().map(String::from))
            }
            None => {
                let p = c
                    .list_subscriptions()
                    .set_next_token(token.clone())
                    .send()
                    .await
                    .map_err(|e| err(conn, e))?;
                (p.subscriptions().to_vec(), p.next_token().map(String::from))
            }
        };
        let before = out.len();
        out.extend(subs.iter().map(|s| {
            let arn = s.subscription_arn().unwrap_or_default().to_string();
            SubscriptionInfo {
                pending: !arn.starts_with("arn:"),
                arn,
                topic_arn: s.topic_arn().unwrap_or_default().to_string(),
                protocol: s.protocol().unwrap_or_default().to_string(),
                endpoint: s.endpoint().unwrap_or_default().to_string(),
                owner: s.owner().map(String::from),
            }
        }));
        if next.is_none() || out.len() == before || next == token {
            break;
        }
        token = next;
    }
    Ok(out)
}

pub async fn list_tags(conn: &Connection, arn: &str) -> Result<Vec<(String, String)>, AppError> {
    let out = client(conn)
        .list_tags_for_resource()
        .resource_arn(arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let mut tags: Vec<(String, String)> = out
        .tags()
        .iter()
        .map(|t| (t.key().to_string(), t.value().to_string()))
        .collect();
    tags.sort();
    Ok(tags)
}

// ---------------------------------------------------------------------------
// Topics: create / edit / delete

/// Topic names: 1–256 letters, digits, '-' or '_'; FIFO names end in ".fifo".
pub fn topic_name_problem(name: &str, fifo: bool) -> Option<String> {
    let base = match (fifo, name.strip_suffix(".fifo")) {
        (true, Some(b)) => b,
        (true, None) => return Some("FIFO topic names must end in .fifo".into()),
        (false, Some(_)) => return Some("Only FIFO topics can end in .fifo".into()),
        (false, None) => name,
    };
    if base.is_empty() || name.len() > 256 {
        return Some("Topic names must be 1 to 256 characters".into());
    }
    if base
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return Some("Use letters, digits, - and _ only".into());
    }
    None
}

/// Creates a topic; returns its ARN.
pub async fn create_topic(
    conn: &Connection,
    name: &str,
    attributes: &BTreeMap<String, String>,
    tags: &[(String, String)],
) -> Result<String, AppError> {
    let fifo = attributes.get("FifoTopic").is_some_and(|v| v == "true");
    if let Some(p) = topic_name_problem(name, fifo) {
        return Err(other(p));
    }
    let tags: Vec<aws_sdk_sns::types::Tag> = tags
        .iter()
        .map(|(k, v)| {
            aws_sdk_sns::types::Tag::builder()
                .key(k)
                .value(v)
                .build()
                .map_err(|e| other(e.to_string()))
        })
        .collect::<Result<_, _>>()?;
    let attrs: std::collections::HashMap<String, String> = attributes
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let out = client(conn)
        .create_topic()
        .name(name)
        .set_attributes(if attrs.is_empty() { None } else { Some(attrs) })
        .set_tags(if tags.is_empty() { None } else { Some(tags) })
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out.topic_arn().unwrap_or_default().to_string())
}

/// Sets attributes one by one (SetTopicAttributes takes one at a time).
pub async fn set_topic_attributes(
    conn: &Connection,
    arn: &str,
    attributes: &BTreeMap<String, String>,
) -> Result<(), AppError> {
    let c = client(conn);
    for (k, v) in attributes {
        c.set_topic_attributes()
            .topic_arn(arn)
            .attribute_name(k)
            .attribute_value(v)
            .send()
            .await
            .map_err(|e| other(format!("{k}: {}", err(conn, e).message)))?;
    }
    Ok(())
}

/// Makes the resource's tags exactly `tags`.
pub async fn set_tags(
    conn: &Connection,
    arn: &str,
    tags: &[(String, String)],
) -> Result<(), AppError> {
    let current = list_tags(conn, arn).await?;
    let c = client(conn);
    let add: Vec<aws_sdk_sns::types::Tag> = tags
        .iter()
        .filter(|t| !current.contains(t))
        .map(|(k, v)| {
            aws_sdk_sns::types::Tag::builder()
                .key(k)
                .value(v)
                .build()
                .map_err(|e| other(e.to_string()))
        })
        .collect::<Result<_, _>>()?;
    if !add.is_empty() {
        c.tag_resource()
            .resource_arn(arn)
            .set_tags(Some(add))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    let remove: Vec<String> = current
        .iter()
        .filter(|(k, _)| !tags.iter().any(|(t, _)| t == k))
        .map(|(k, _)| k.clone())
        .collect();
    if !remove.is_empty() {
        c.untag_resource()
            .resource_arn(arn)
            .set_tag_keys(Some(remove))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    Ok(())
}

pub async fn get_data_protection_policy(
    conn: &Connection,
    arn: &str,
) -> Result<Option<String>, AppError> {
    let out = client(conn)
        .get_data_protection_policy()
        .resource_arn(arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out
        .data_protection_policy()
        .filter(|p| !p.is_empty())
        .map(String::from))
}

pub async fn put_data_protection_policy(
    conn: &Connection,
    arn: &str,
    policy: &str,
) -> Result<(), AppError> {
    serde_json::from_str::<serde_json::Value>(policy)
        .map_err(|e| other(format!("Not valid JSON: {e}")))?;
    client(conn)
        .put_data_protection_policy()
        .resource_arn(arn)
        .data_protection_policy(policy)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

pub async fn delete_topic(conn: &Connection, arn: &str) -> Result<(), AppError> {
    client(conn)
        .delete_topic()
        .topic_arn(arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Subscriptions

pub const PROTOCOLS: &[&str] = &[
    "sqs",
    "lambda",
    "http",
    "https",
    "email",
    "email-json",
    "sms",
    "firehose",
    "application",
];

/// Basic endpoint checks per protocol (SNS does the rest).
pub fn endpoint_problem(protocol: &str, endpoint: &str) -> Option<String> {
    let e = endpoint.trim();
    if e.is_empty() {
        return Some("Enter an endpoint".into());
    }
    match protocol {
        "sqs" | "lambda" | "firehose" | "application" if !e.starts_with("arn:") => {
            Some(format!("A {protocol} endpoint is an ARN (arn:aws:…)"))
        }
        "http" if !e.starts_with("http://") => Some("HTTP endpoints start with http://".into()),
        "https" if !e.starts_with("https://") => Some("HTTPS endpoints start with https://".into()),
        "email" | "email-json" if !e.contains('@') => Some("Enter an email address".into()),
        "sms" if !e.starts_with('+') => {
            Some("Phone numbers use E.164 format, e.g. +447700900123".into())
        }
        p if !PROTOCOLS.contains(&p) => Some(format!("Unknown protocol {p}")),
        _ => None,
    }
}

/// Subscribes; returns the subscription ARN ("pending confirmation" until the
/// endpoint confirms, for protocols that need it).
pub async fn subscribe(
    conn: &Connection,
    topic_arn: &str,
    protocol: &str,
    endpoint: &str,
    attributes: &BTreeMap<String, String>,
) -> Result<String, AppError> {
    if let Some(p) = endpoint_problem(protocol, endpoint) {
        return Err(other(p));
    }
    let attrs: std::collections::HashMap<String, String> = attributes
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let out = client(conn)
        .subscribe()
        .topic_arn(topic_arn)
        .protocol(protocol)
        .endpoint(endpoint.trim())
        .set_attributes(if attrs.is_empty() { None } else { Some(attrs) })
        .return_subscription_arn(true)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out.subscription_arn().unwrap_or_default().to_string())
}

pub async fn confirm_subscription(
    conn: &Connection,
    topic_arn: &str,
    token: &str,
    authenticate_unsubscribe: bool,
) -> Result<String, AppError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(other("Paste the token from the confirmation message"));
    }
    let out = client(conn)
        .confirm_subscription()
        .topic_arn(topic_arn)
        .token(token)
        .set_authenticate_on_unsubscribe(authenticate_unsubscribe.then(|| "true".to_string()))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out.subscription_arn().unwrap_or_default().to_string())
}

pub async fn unsubscribe(conn: &Connection, arn: &str) -> Result<(), AppError> {
    if !arn.starts_with("arn:") {
        return Err(other(
            "Pending subscriptions can't be removed; they expire after 3 days if not confirmed",
        ));
    }
    client(conn)
        .unsubscribe()
        .subscription_arn(arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

pub async fn subscription_attributes(
    conn: &Connection,
    arn: &str,
) -> Result<BTreeMap<String, String>, AppError> {
    let out = client(conn)
        .get_subscription_attributes()
        .subscription_arn(arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out
        .attributes()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default())
}

/// Sets attributes one by one (SetSubscriptionAttributes takes one at a time).
pub async fn set_subscription_attributes(
    conn: &Connection,
    arn: &str,
    attributes: &BTreeMap<String, String>,
) -> Result<(), AppError> {
    let c = client(conn);
    for (k, v) in attributes {
        c.set_subscription_attributes()
            .subscription_arn(arn)
            .attribute_name(k)
            .attribute_value(v)
            .send()
            .await
            .map_err(|e| other(format!("{k}: {}", err(conn, e).message)))?;
    }
    Ok(())
}

/// Adds (if missing) a statement to an SQS queue's policy letting the topic
/// send to it. Returns false if an equivalent statement was already there.
pub async fn allow_topic_on_queue(
    conn: &Connection,
    queue_arn: &str,
    topic_arn: &str,
) -> Result<bool, AppError> {
    // arn:aws:sqs:region:account:name
    let parts: Vec<&str> = queue_arn.split(':').collect();
    if parts.len() != 6 || parts[2] != "sqs" {
        return Err(other(format!("Not an SQS queue ARN: {queue_arn}")));
    }
    let sqs = crate::sqs::client(conn);
    let url = sqs
        .get_queue_url()
        .queue_name(parts[5])
        .queue_owner_aws_account_id(parts[4])
        .send()
        .await
        .map_err(|e| crate::sqs::err(conn, e))?
        .queue_url()
        .unwrap_or_default()
        .to_string();
    let attrs = sqs
        .get_queue_attributes()
        .queue_url(&url)
        .attribute_names(aws_sdk_sqs::types::QueueAttributeName::Policy)
        .send()
        .await
        .map_err(|e| crate::sqs::err(conn, e))?;
    let current = attrs
        .attributes()
        .and_then(|m| m.get(&aws_sdk_sqs::types::QueueAttributeName::Policy))
        .cloned()
        .unwrap_or_default();
    let Some(policy) = add_topic_statement(&current, queue_arn, topic_arn)? else {
        return Ok(false);
    };
    sqs.set_queue_attributes()
        .queue_url(&url)
        .attributes(aws_sdk_sqs::types::QueueAttributeName::Policy, policy)
        .send()
        .await
        .map_err(|e| crate::sqs::err(conn, e))?;
    Ok(true)
}

/// The queue policy with a statement allowing the topic, or None if one
/// already allows it.
pub fn add_topic_statement(
    current: &str,
    queue_arn: &str,
    topic_arn: &str,
) -> Result<Option<String>, AppError> {
    use serde_json::{json, Value};
    let mut policy: Value = if current.trim().is_empty() {
        json!({"Version": "2012-10-17", "Statement": []})
    } else {
        serde_json::from_str(current)
            .map_err(|e| other(format!("The queue's policy isn't valid JSON: {e}")))?
    };
    let statements = match policy.get_mut("Statement") {
        Some(Value::Array(a)) => a,
        Some(single) => {
            let one = single.take();
            policy["Statement"] = Value::Array(vec![one]);
            policy["Statement"].as_array_mut().unwrap()
        }
        None => {
            policy["Statement"] = json!([]);
            policy["Statement"].as_array_mut().unwrap()
        }
    };
    let allows = |st: &Value| {
        st.get("Effect").and_then(Value::as_str) == Some("Allow")
            && st
                .pointer("/Condition/ArnEquals/aws:SourceArn")
                .and_then(Value::as_str)
                == Some(topic_arn)
    };
    if statements.iter().any(allows) {
        return Ok(None);
    }
    statements.push(json!({
        "Sid": format!("AllowSNS-{}", name_from_arn(topic_arn)),
        "Effect": "Allow",
        "Principal": {"Service": "sns.amazonaws.com"},
        "Action": "sqs:SendMessage",
        "Resource": queue_arn,
        "Condition": {"ArnEquals": {"aws:SourceArn": topic_arn}}
    }));
    Ok(Some(policy.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_names() {
        assert_eq!(topic_name_problem("orders_1-a", false), None);
        assert_eq!(topic_name_problem("orders.fifo", true), None);
        assert!(topic_name_problem("orders", true).is_some());
        assert!(topic_name_problem("orders.fifo", false).is_some());
        assert!(topic_name_problem("a b", false).is_some());
        assert!(topic_name_problem("", false).is_some());
        assert_eq!(name_from_arn("arn:aws:sns:eu-west-2:1:orders"), "orders");
    }

    #[test]
    fn endpoints() {
        assert_eq!(endpoint_problem("sqs", "arn:aws:sqs:r:1:q"), None);
        assert!(endpoint_problem("sqs", "q").is_some());
        assert!(endpoint_problem("https", "http://x").is_some());
        assert_eq!(endpoint_problem("email", "a@b.c"), None);
        assert!(endpoint_problem("sms", "07700").is_some());
        assert!(endpoint_problem("carrier-pigeon", "x").is_some());
    }

    #[test]
    fn queue_policy_statement() {
        let q = "arn:aws:sqs:r:1:q";
        let t = "arn:aws:sns:r:1:t";
        let p = add_topic_statement("", q, t).unwrap().unwrap();
        assert!(p.contains("sns.amazonaws.com") && p.contains(t));
        assert_eq!(add_topic_statement(&p, q, t).unwrap(), None);
        let other_topic = add_topic_statement(&p, q, "arn:aws:sns:r:1:u")
            .unwrap()
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&other_topic).unwrap();
        assert_eq!(v["Statement"].as_array().unwrap().len(), 2);
        // A single statement object becomes an array.
        let single = r#"{"Version":"2012-10-17","Statement":{"Effect":"Deny","Principal":"*","Action":"sqs:*","Resource":"x"}}"#;
        let v: serde_json::Value =
            serde_json::from_str(&add_topic_statement(single, q, t).unwrap().unwrap()).unwrap();
        assert_eq!(v["Statement"].as_array().unwrap().len(), 2);
        assert!(add_topic_statement("{oops", q, t).is_err());
    }
}

#[cfg(test)]
pub(crate) mod emulator_tests {
    use super::*;

    pub(crate) async fn connect() -> Connection {
        crate::sqs::emulator_tests::connect().await
    }

    pub(crate) async fn fresh_topic(
        conn: &Connection,
        name: &str,
        attrs: &[(&str, &str)],
    ) -> String {
        let c = client(conn);
        let mut req = c.create_topic().name(name);
        for (k, v) in attrs {
            req = req.attributes(*k, *v);
        }
        let arn = req.send().await.unwrap().topic_arn().unwrap().to_string();
        for s in list_subscriptions(conn, Some(&arn)).await.unwrap() {
            if !s.pending {
                let _ = c.unsubscribe().subscription_arn(&s.arn).send().await;
            }
        }
        arn
    }

    #[tokio::test]
    #[ignore]
    async fn lists_topics_and_subscriptions() {
        let conn = connect().await;
        let a = fresh_topic(&conn, "s3x-sns-orders", &[("DisplayName", "Orders")]).await;
        fresh_topic(&conn, "s3x-sns-events.fifo", &[("FifoTopic", "true")]).await;
        let q = crate::sqs::emulator_tests::fresh_queue(&conn, "s3x-sns-sub", &[]).await;
        let qarn = crate::sqs::queue_details(&conn, &q)
            .await
            .unwrap()
            .arn
            .unwrap();
        client(&conn)
            .subscribe()
            .topic_arn(&a)
            .protocol("sqs")
            .endpoint(&qarn)
            .send()
            .await
            .unwrap();

        let arns = list_topic_arns(&conn).await.unwrap();
        let names: Vec<String> = arns.iter().map(|a| name_from_arn(a)).collect();
        assert!(names.windows(2).all(|w| w[0] <= w[1]));
        let some = details_many(&conn, &arns[..1]).await.unwrap();
        assert_eq!(some.len(), 1);
        assert_eq!(some[0].arn, arns[0]);
        let all = list_topics(&conn).await.unwrap();
        let t = all.iter().find(|t| t.name == "s3x-sns-orders").unwrap();
        assert_eq!(t.display_name.as_deref(), Some("Orders"));
        assert!(all
            .iter()
            .any(|t| t.name == "s3x-sns-events.fifo" && t.fifo));
        let subs = list_subscriptions(&conn, Some(&a)).await.unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].protocol, "sqs");
        assert!(list_subscriptions(&conn, None)
            .await
            .unwrap()
            .iter()
            .any(|s| s.topic_arn == a));
        assert_eq!(
            topic_details(&conn, &a).await.unwrap().name,
            "s3x-sns-orders"
        );
        assert!(list_tags(&conn, &a).await.unwrap().is_empty());
    }

    #[tokio::test]
    #[ignore]
    async fn creates_edits_and_deletes_topics() {
        let conn = connect().await;
        let attrs: BTreeMap<String, String> =
            [("DisplayName".to_string(), "First".to_string())].into();
        assert!(create_topic(&conn, "bad name", &attrs, &[]).await.is_err());
        let arn = create_topic(
            &conn,
            "s3x-sns-crud",
            &attrs,
            &[("env".into(), "dev".into())],
        )
        .await
        .unwrap();
        set_topic_attributes(
            &conn,
            &arn,
            &[("DisplayName".to_string(), "Second".to_string())].into(),
        )
        .await
        .unwrap();
        assert_eq!(
            topic_details(&conn, &arn)
                .await
                .unwrap()
                .display_name
                .as_deref(),
            Some("Second")
        );
        set_tags(&conn, &arn, &[("team".into(), "a".into())])
            .await
            .unwrap();
        assert_eq!(
            list_tags(&conn, &arn).await.unwrap(),
            vec![("team".to_string(), "a".to_string())]
        );
        let dpp = r#"{"Name":"p","Description":"","Version":"2021-06-01","Statement":[]}"#;
        if put_data_protection_policy(&conn, &arn, dpp).await.is_ok() {
            let _ = get_data_protection_policy(&conn, &arn).await;
        }
        delete_topic(&conn, &arn).await.unwrap();
        assert!(!list_topics(&conn)
            .await
            .unwrap()
            .iter()
            .any(|t| t.arn == arn));
    }

    #[tokio::test]
    #[ignore]
    async fn subscribes_edits_and_unsubscribes() {
        let conn = connect().await;
        let topic = fresh_topic(&conn, "s3x-sns-subs", &[]).await;
        let sqs = crate::sqs::client(&conn);
        let url = sqs
            .create_queue()
            .queue_name("s3x-sns-subs-q")
            .send()
            .await
            .unwrap()
            .queue_url()
            .unwrap()
            .to_string();
        let qarn = crate::sqs::queue_details(&conn, &url)
            .await
            .unwrap()
            .arn
            .unwrap();
        assert!(
            subscribe(&conn, &topic, "sqs", "not-an-arn", &BTreeMap::new())
                .await
                .is_err()
        );
        let attrs: BTreeMap<String, String> =
            [("RawMessageDelivery".to_string(), "true".to_string())].into();
        let sub = subscribe(&conn, &topic, "sqs", &qarn, &attrs)
            .await
            .unwrap();
        assert!(sub.starts_with("arn:"));
        assert!(allow_topic_on_queue(&conn, &qarn, &topic).await.unwrap());
        assert!(!allow_topic_on_queue(&conn, &qarn, &topic).await.unwrap());
        let filter = r#"{"kind":["order"]}"#;
        set_subscription_attributes(
            &conn,
            &sub,
            &[("FilterPolicy".to_string(), filter.to_string())].into(),
        )
        .await
        .unwrap();
        let got = subscription_attributes(&conn, &sub).await.unwrap();
        assert_eq!(
            got.get("RawMessageDelivery").map(String::as_str),
            Some("true")
        );
        assert!(got.get("FilterPolicy").is_some_and(|f| f.contains("order")));
        assert_eq!(
            list_subscriptions(&conn, Some(&topic)).await.unwrap().len(),
            1
        );
        assert!(confirm_subscription(&conn, &topic, "", false)
            .await
            .is_err());
        unsubscribe(&conn, &sub).await.unwrap();
        assert!(list_subscriptions(&conn, Some(&topic))
            .await
            .unwrap()
            .is_empty());
        let _ = sqs.delete_queue().queue_url(&url).send().await;
    }
}
