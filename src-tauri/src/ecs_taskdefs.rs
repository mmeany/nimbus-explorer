//! ECS task definitions: families and revisions.

use crate::ecs::{client, err, other, task_def_name};
use crate::error::AppError;
use crate::s3::Connection;
use aws_sdk_ecs::types::{
    SortOrder, TaskDefinitionFamilyStatus, TaskDefinitionField, TaskDefinitionStatus,
};
use aws_smithy_runtime_api::box_error::BoxError;
use aws_smithy_runtime_api::client::interceptors::context::AfterDeserializationInterceptorContextRef;
use aws_smithy_runtime_api::client::interceptors::Intercept;
use aws_smithy_runtime_api::client::runtime_components::RuntimeComponents;
use aws_smithy_types::body::SdkBody;
use aws_smithy_types::config_bag::ConfigBag;
use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};

/// Task definition families (ACTIVE ones, or INACTIVE ones that only have
/// deregistered revisions), whose names begin with `prefix`.
pub async fn families(
    conn: &Connection,
    prefix: &str,
    inactive: bool,
) -> Result<Vec<String>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .list_task_definition_families()
            .set_family_prefix(
                Some(prefix.trim())
                    .filter(|p| !p.is_empty())
                    .map(String::from),
            )
            .status(if inactive {
                TaskDefinitionFamilyStatus::Inactive
            } else {
                TaskDefinitionFamilyStatus::Active
            })
            .max_results(100)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.families().iter().cloned());
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// Revisions of one family ("family:rev"), newest first.
pub async fn revisions(
    conn: &Connection,
    family: &str,
    inactive: bool,
) -> Result<Vec<String>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .list_task_definitions()
            .family_prefix(family)
            .status(if inactive {
                TaskDefinitionStatus::Inactive
            } else {
                TaskDefinitionStatus::Active
            })
            .sort(SortOrder::Desc)
            .max_results(100)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        // The prefix also matches longer family names; keep this family only.
        out.extend(
            page.task_definition_arns()
                .iter()
                .map(|a| task_def_name(a))
                .filter(|n| n.rsplit_once(':').map(|(f, _)| f) == Some(family)),
        );
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort_by_key(|n| {
        std::cmp::Reverse(
            n.rsplit_once(':')
                .and_then(|(_, r)| r.parse::<u64>().ok())
                .unwrap_or(0),
        )
    });
    Ok(out)
}

// ---------------------------------------------------------------------------
// Task definitions as JSON. The SDK's types can't be serialised, and mapping
// every field by hand would silently drop the ones not mapped when saving a
// new revision. So, like the AWS CLI, the raw JSON AWS returns is shown and
// edited, and the edited JSON is sent back as the request body (through the
// SDK, so signing, retries and errors stay the same).

/// Keeps a copy of the raw response body (read after the SDK has loaded it).
#[derive(Debug, Clone, Default)]
struct CaptureBody(Arc<Mutex<Option<Vec<u8>>>>);

impl Intercept for CaptureBody {
    fn name(&self) -> &'static str {
        "CaptureBody"
    }

    fn read_after_deserialization(
        &self,
        ctx: &AfterDeserializationInterceptorContextRef<'_>,
        _rc: &RuntimeComponents,
        _cfg: &mut ConfigBag,
    ) -> Result<(), BoxError> {
        if let Some(b) = ctx.response().body().bytes() {
            *self.0.lock().unwrap() = Some(b.to_vec());
        }
        Ok(())
    }
}

/// Fields AWS sets itself; RegisterTaskDefinition refuses them.
const READ_ONLY_FIELDS: &[&str] = &[
    "taskDefinitionArn",
    "revision",
    "status",
    "requiresAttributes",
    "compatibilities",
    "registeredAt",
    "registeredBy",
    "deregisteredAt",
    "deleteRequested",
];

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskDefJson {
    /// "family:rev".
    pub name: String,
    pub arn: String,
    /// ACTIVE, INACTIVE or DELETE_IN_PROGRESS.
    pub status: String,
    /// The task definition as AWS returned it (pretty-printed, AWS's key order).
    pub json: String,
    /// The same, ready to register as a new revision (read-only fields removed, tags included).
    pub register_json: String,
}

/// `def` without the fields AWS sets, plus `tags` when there are any.
pub fn for_register(def: &Value, tags: Option<&Value>) -> Value {
    let mut v = def.clone();
    if let Some(o) = v.as_object_mut() {
        for k in READ_ONLY_FIELDS {
            o.remove(*k);
        }
        if let Some(t) = tags.filter(|t| t.as_array().is_some_and(|a| !a.is_empty())) {
            o.insert("tags".into(), t.clone());
        }
    }
    v
}

pub async fn describe(conn: &Connection, name: &str) -> Result<TaskDefJson, AppError> {
    let capture = CaptureBody::default();
    client(conn)
        .describe_task_definition()
        .task_definition(name)
        .include(TaskDefinitionField::Tags)
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
        .ok_or_else(|| other("AWS didn't return the task definition"))?;
    let v: Value = serde_json::from_slice(&body)
        .map_err(|e| other(format!("Couldn't read the task definition: {e}")))?;
    let def = v
        .get("taskDefinition")
        .ok_or_else(|| other("AWS didn't return the task definition"))?;
    let arn = def
        .get("taskDefinitionArn")
        .and_then(|a| a.as_str())
        .unwrap_or_default()
        .to_string();
    Ok(TaskDefJson {
        name: task_def_name(&arn),
        status: def
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or_default()
            .to_string(),
        json: serde_json::to_string_pretty(def).unwrap_or_default(),
        register_json: serde_json::to_string_pretty(&for_register(def, v.get("tags")))
            .unwrap_or_default(),
        arn,
    })
}

/// Checks JSON meant for RegisterTaskDefinition; returns it cleaned (read-only
/// fields dropped, so pasting a DescribeTaskDefinition result works).
pub fn register_problem(json: &str) -> Result<(String, Value), String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("Not valid JSON: {e}"))?;
    let v = match v.get("taskDefinition") {
        Some(inner) if inner.is_object() => for_register(inner, v.get("tags")),
        _ => for_register(&v, None),
    };
    let family = v
        .get("family")
        .and_then(|f| f.as_str())
        .filter(|f| !f.is_empty())
        .ok_or("The JSON needs a \"family\"")?
        .to_string();
    if !family
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        || family.len() > 255
    {
        return Err("Family names use letters, digits, - and _ (up to 255)".into());
    }
    match v.get("containerDefinitions").and_then(|c| c.as_array()) {
        Some(a) if !a.is_empty() => {}
        _ => return Err("The JSON needs at least one entry in \"containerDefinitions\"".into()),
    }
    Ok((family, v))
}

/// Registers `json` as a new revision of its family; returns "family:rev".
pub async fn register(conn: &Connection, json: &str) -> Result<String, AppError> {
    let (family, v) = register_problem(json).map_err(other)?;
    let body = serde_json::to_vec(&v).map_err(|e| other(e.to_string()))?;
    let out = client(conn)
        .register_task_definition()
        // Placeholders so the SDK's own checks pass; the body below replaces them.
        .family(&family)
        .set_container_definitions(Some(Vec::new()))
        .customize()
        .mutate_request(move |req| {
            req.headers_mut()
                .insert("content-length", body.len().to_string());
            *req.body_mut() = SdkBody::from(body.clone());
        })
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out
        .task_definition()
        .and_then(|t| t.task_definition_arn())
        .map(task_def_name)
        .unwrap_or(family))
}

/// Deregisters one revision: running tasks and services keep it, but nothing
/// new can start from it.
pub async fn deregister(conn: &Connection, name: &str) -> Result<(), AppError> {
    client(conn)
        .deregister_task_definition()
        .task_definition(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prepares_json_for_register() {
        let def = json!({"taskDefinitionArn": "arn:x:task-definition/web:3", "family": "web", "revision": 3, "status": "ACTIVE", "containerDefinitions": [{"name": "web", "image": "nginx"}], "compatibilities": ["EC2"], "registeredAt": 1});
        let r = for_register(&def, Some(&json!([{"key": "team", "value": "a"}])));
        assert_eq!(
            r,
            json!({"family": "web", "containerDefinitions": [{"name": "web", "image": "nginx"}], "tags": [{"key": "team", "value": "a"}]})
        );
        assert!(for_register(&def, Some(&json!([]))).get("tags").is_none());
        // A pasted DescribeTaskDefinition result is unwrapped and cleaned.
        let (f, v) =
            register_problem(&json!({"taskDefinition": def, "tags": []}).to_string()).unwrap();
        assert_eq!(f, "web");
        assert!(v.get("revision").is_none());
        assert!(register_problem("{}").unwrap_err().contains("family"));
        assert!(
            register_problem(r#"{"family": "web", "containerDefinitions": []}"#)
                .unwrap_err()
                .contains("containerDefinitions")
        );
        assert!(register_problem(r#"{"family": "a b", "containerDefinitions": [{}]}"#).is_err());
        assert!(register_problem("{nope").unwrap_err().contains("JSON"));
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::ecs::emulator_tests::{connect, fixtures};

    #[tokio::test]
    #[ignore]
    async fn lists_families_and_revisions() {
        let conn = connect().await;
        fixtures(&conn).await;
        assert!(families(&conn, "s3x-", false)
            .await
            .unwrap()
            .contains(&"s3x-web".to_string()));
        let revs = revisions(&conn, "s3x-web", false).await.unwrap();
        assert!(revs.len() >= 2);
        let n = |s: &str| s.rsplit_once(':').unwrap().1.parse::<u64>().unwrap();
        assert!(n(&revs[0]) > n(&revs[1]), "newest first");

        // Raw JSON round trip: describe, change the image, register a new revision.
        let d = describe(&conn, &revs[0]).await.unwrap();
        assert_eq!(d.name, revs[0]);
        let mut v: Value = serde_json::from_str(&d.register_json).unwrap();
        assert!(v.get("revision").is_none());
        v["containerDefinitions"][0]["image"] = Value::String("nginx:1.29".into());
        let new = register(&conn, &v.to_string()).await.unwrap();
        assert_eq!(n(&new), n(&revs[0]) + 1);
        let back = describe(&conn, &new).await.unwrap();
        assert!(back.json.contains("nginx:1.29"));
        assert!(
            back.json.contains("awslogs-stream-prefix"),
            "fields not modelled by hand survive"
        );
        deregister(&conn, &new).await.unwrap();
        assert!(!revisions(&conn, "s3x-web", false)
            .await
            .unwrap()
            .contains(&new));
        assert!(revisions(&conn, "s3x-web", true)
            .await
            .unwrap()
            .contains(&new));
    }
}
