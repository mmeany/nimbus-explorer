//! IAM policy simulator (SimulatePrincipalPolicy): what a user, group or role
//! may do. Simulating changes nothing. Matched statements are resolved to the
//! policy they're in (the principal's own, its groups', managed ones, or the
//! pasted extra policy) so the UI can show them in place.

use crate::error::{AppError, ErrorKind};
use crate::iam::{self, client, err};
use crate::s3::Connection;
use aws_sdk_iam::types::{ContextEntry, ContextKeyTypeEnum};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const MAX_ACTIONS: usize = 100;
pub const MAX_RESOURCES: usize = 100;
const CONTEXT_TYPES: [&str; 12] = [
    "string",
    "stringList",
    "numeric",
    "numericList",
    "boolean",
    "booleanList",
    "ip",
    "ipList",
    "binary",
    "binaryList",
    "date",
    "dateList",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextIn {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimRequest {
    /// "users", "groups" or "roles".
    pub kind: String,
    pub name: String,
    pub arn: String,
    pub actions: Vec<String>,
    /// Empty = "*".
    pub resources: Vec<String>,
    pub context: Vec<ContextIn>,
    /// A policy to add to the principal's for this simulation.
    pub extra_policy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Matched {
    pub source_id: String,
    pub source_type: Option<String>,
    /// Which policy, in words ("ci-deploy (customer managed)").
    pub policy: Option<String>,
    /// That policy's document, as stored, when it could be found.
    pub document: Option<String>,
    /// 1-based line and column of the statement in `document`.
    pub start: Option<(i32, i32)>,
    pub end: Option<(i32, i32)>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SimResult {
    pub action: String,
    pub resource: String,
    /// "allowed", "explicitDeny" or "implicitDeny".
    pub decision: String,
    pub matched: Vec<Matched>,
    pub missing_context: Vec<String>,
    pub boundary_allowed: Option<bool>,
    pub organizations_allowed: Option<bool>,
    /// Decision per policy type, when AWS gives one.
    pub details: Vec<(String, String)>,
}

/// One action name: "service:Action", no wildcards (the API refuses them).
pub fn check_action(a: &str) -> Result<(), String> {
    if a.contains('*') || a.contains('?') {
        return Err(format!(
            "{a}: the simulator needs exact action names; wildcards aren't supported."
        ));
    }
    let ok = a.split_once(':').is_some_and(|(s, n)| {
        !s.is_empty()
            && !n.is_empty()
            && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            && n.chars().all(|c| c.is_ascii_alphanumeric())
    });
    if ok {
        Ok(())
    } else {
        Err(format!(
            "{a}: actions look like service:Action, for example s3:GetObject."
        ))
    }
}

pub fn validate(r: &SimRequest) -> Result<(), String> {
    if r.actions.is_empty() {
        return Err("Enter at least one action.".into());
    }
    if r.actions.len() > MAX_ACTIONS {
        return Err(format!("At most {MAX_ACTIONS} actions at a time."));
    }
    for a in &r.actions {
        check_action(a)?;
    }
    if r.resources.len() > MAX_RESOURCES {
        return Err(format!("At most {MAX_RESOURCES} resources at a time."));
    }
    if r.resources.iter().any(|x| x.trim().is_empty()) {
        return Err("Resource ARNs can't be empty.".into());
    }
    for c in &r.context {
        if c.key.trim().is_empty() || !c.key.contains(':') {
            return Err(format!(
                "Context key \"{}\" should look like aws:SourceIp.",
                c.key
            ));
        }
        if !CONTEXT_TYPES.contains(&c.kind.as_str()) {
            return Err(format!("Unknown context key type {}.", c.kind));
        }
        if c.values.is_empty() {
            return Err(format!("Context key {} needs a value.", c.key));
        }
    }
    if let Some(p) = &r.extra_policy {
        serde_json::from_str::<serde_json::Value>(p)
            .map_err(|e| format!("The extra policy isn't valid JSON: {e}"))?;
    }
    Ok(())
}

/// Does a matched statement's SourcePolicyId name this policy? AWS's format
/// varies by source (a name, an ARN, or a name with a principal prefix).
pub fn matches_source(id: &str, name: &str, arn: Option<&str>) -> bool {
    id == name
        || arn == Some(id)
        || id.ends_with(&format!("_{name}"))
        || id.ends_with(&format!("/{name}"))
}

/// A policy a matched statement may come from.
struct Candidate {
    /// "managed", "inline" or "input".
    kind: &'static str,
    name: String,
    arn: Option<String>,
    label: String,
    document: Option<String>,
}

async fn candidates(conn: &Connection, r: &SimRequest, need_groups: bool) -> Vec<Candidate> {
    let mut out = Vec::new();
    if let Some(p) = &r.extra_policy {
        out.push(Candidate {
            kind: "input",
            name: "PolicyInputList.1".into(),
            arn: None,
            label: "The extra policy (pasted)".into(),
            document: Some(p.clone()),
        });
    }
    let add = |out: &mut Vec<Candidate>,
                   owner: &str,
                   attached: Vec<iam::Attached>,
                   inline: Vec<iam::Inline>| {
        for a in attached {
            out.push(Candidate {
                kind: "managed",
                label: format!(
                    "{} ({})",
                    a.name,
                    if a.aws_managed {
                        "AWS managed"
                    } else {
                        "customer managed"
                    }
                ),
                name: a.name,
                arn: Some(a.arn),
                document: None,
            });
        }
        for i in inline {
            out.push(Candidate {
                kind: "inline",
                label: format!("{} (inline, {owner})", i.name),
                name: i.name,
                arn: None,
                document: i.document,
            });
        }
    };
    match r.kind.as_str() {
        "users" => {
            if let Ok(u) = iam::user(conn, &r.name).await {
                let groups = u.groups.clone();
                add(&mut out, &format!("user {}", r.name), u.attached, u.inline);
                if need_groups {
                    for g in groups {
                        if let Ok(d) = iam::group(conn, &g.name).await {
                            add(&mut out, &format!("group {}", g.name), d.attached, d.inline);
                        }
                    }
                }
            }
        }
        "groups" => {
            if let Ok(g) = iam::group(conn, &r.name).await {
                add(&mut out, &format!("group {}", r.name), g.attached, g.inline);
            }
        }
        _ => {
            if let Ok(x) = iam::role(conn, &r.name).await {
                add(&mut out, &format!("role {}", r.name), x.attached, x.inline);
            }
        }
    }
    out
}

/// A managed policy's default version document.
async fn managed_document(conn: &Connection, arn: &str) -> Option<String> {
    let p = client(conn)
        .get_policy()
        .policy_arn(arn)
        .send()
        .await
        .ok()?;
    let v = p.policy()?.default_version_id()?.to_string();
    iam::policy_version(conn, arn, &v).await.ok()
}

fn pos(p: Option<&aws_sdk_iam::types::Position>) -> Option<(i32, i32)> {
    p.map(|p| (p.line(), p.column()))
}

pub async fn simulate(conn: &Connection, r: &SimRequest) -> Result<Vec<SimResult>, AppError> {
    validate(r).map_err(|m| AppError::new(ErrorKind::Other, m))?;
    let c = client(conn);
    let context: Vec<ContextEntry> = r
        .context
        .iter()
        .map(|x| {
            ContextEntry::builder()
                .context_key_name(x.key.trim())
                .set_context_key_values(Some(x.values.clone()))
                .context_key_type(ContextKeyTypeEnum::from(x.kind.as_str()))
                .build()
        })
        .collect();
    let mut out = Vec::new();
    let mut marker: Option<String> = None;
    loop {
        let o = c
            .simulate_principal_policy()
            .policy_source_arn(&r.arn)
            .set_action_names(Some(r.actions.clone()))
            .set_resource_arns((!r.resources.is_empty()).then(|| r.resources.clone()))
            .set_context_entries((!context.is_empty()).then(|| context.clone()))
            .set_policy_input_list(r.extra_policy.clone().map(|p| vec![p]))
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        for e in o.evaluation_results() {
            let mut details: Vec<(String, String)> = e
                .eval_decision_details()
                .map(|m| {
                    m.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().to_string()))
                        .collect()
                })
                .unwrap_or_default();
            details.sort();
            out.push(SimResult {
                action: e.eval_action_name().to_string(),
                resource: e.eval_resource_name().unwrap_or("*").to_string(),
                decision: e.eval_decision().as_str().to_string(),
                matched: e
                    .matched_statements()
                    .iter()
                    .map(|s| Matched {
                        source_id: s.source_policy_id().unwrap_or_default().to_string(),
                        source_type: s.source_policy_type().map(|t| t.as_str().to_string()),
                        start: pos(s.start_position()),
                        end: pos(s.end_position()),
                        ..Default::default()
                    })
                    .collect(),
                missing_context: e.missing_context_values().to_vec(),
                boundary_allowed: e
                    .permissions_boundary_decision_detail()
                    .map(|d| d.allowed_by_permissions_boundary()),
                organizations_allowed: e
                    .organizations_decision_detail()
                    .map(|d| d.allowed_by_organizations()),
                details,
            });
        }
        match o
            .marker()
            .filter(|m| o.is_truncated() && !m.is_empty() && Some(*m) != marker.as_deref())
        {
            Some(m) => marker = Some(m.to_string()),
            None => break,
        }
    }
    resolve(conn, r, &mut out).await;
    Ok(out)
}

/// Fills in each matched statement's policy name and document.
async fn resolve(conn: &Connection, r: &SimRequest, results: &mut [SimResult]) {
    let any = results.iter().any(|x| !x.matched.is_empty());
    if !any {
        return;
    }
    let need_groups = results
        .iter()
        .flat_map(|x| &x.matched)
        .any(|m| m.source_type.as_deref() == Some("group"));
    let mut cands = candidates(conn, r, need_groups).await;
    let mut managed_docs: HashMap<String, Option<String>> = HashMap::new();
    for res in results.iter_mut() {
        for m in res.matched.iter_mut() {
            let want = match m.source_type.as_deref() {
                Some("aws-managed" | "user-managed") => Some("managed"),
                Some("user" | "group" | "role") => Some("inline"),
                Some("none") if m.source_id.starts_with("PolicyInputList") => Some("input"),
                _ => None,
            };
            let Some(c) = cands.iter_mut().find(|c| {
                want.is_none_or(|w| w == c.kind)
                    && matches_source(&m.source_id, &c.name, c.arn.as_deref())
            }) else {
                continue;
            };
            if c.kind == "managed" && c.document.is_none() {
                let arn = c.arn.clone().unwrap_or_default();
                if !managed_docs.contains_key(&arn) {
                    let d = managed_document(conn, &arn).await;
                    managed_docs.insert(arn.clone(), d);
                }
                c.document = managed_docs.get(&arn).cloned().flatten();
            }
            m.policy = Some(c.label.clone());
            m.document = c.document.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> SimRequest {
        SimRequest {
            kind: "users".into(),
            name: "u".into(),
            arn: "arn:aws:iam::123456789012:user/u".into(),
            actions: vec!["s3:GetObject".into()],
            resources: vec![],
            context: vec![],
            extra_policy: None,
        }
    }

    #[test]
    fn checks_actions() {
        assert!(check_action("s3:GetObject").is_ok());
        assert!(check_action("execute-api:Invoke").is_ok());
        assert!(check_action("s3:*").unwrap_err().contains("wildcards"));
        assert!(check_action("s3:Get*").is_err());
        assert!(check_action("GetObject").is_err());
        assert!(check_action("s3:").is_err());
    }

    #[test]
    fn validates_requests() {
        assert!(validate(&req()).is_ok());
        let mut r = req();
        r.actions.clear();
        assert!(validate(&r).is_err());
        let mut r = req();
        r.extra_policy = Some("{nope".into());
        assert!(validate(&r).unwrap_err().contains("JSON"));
        let mut r = req();
        r.context = vec![ContextIn {
            key: "aws:SourceIp".into(),
            kind: "ip".into(),
            values: vec![],
        }];
        assert!(validate(&r).is_err());
        r.context[0].values = vec!["10.0.0.1".into()];
        assert!(validate(&r).is_ok());
        r.context[0].kind = "colour".into();
        assert!(validate(&r).is_err());
    }

    #[test]
    fn matches_policy_sources() {
        assert!(matches_source("ci-deploy", "ci-deploy", None));
        assert!(matches_source("user_alice_read", "read", None));
        assert!(matches_source(
            "arn:aws:iam::aws:policy/ReadOnlyAccess",
            "ReadOnlyAccess",
            Some("arn:aws:iam::aws:policy/ReadOnlyAccess")
        ));
        assert!(!matches_source("unread", "read", None));
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;

    /// MiniStack answers SimulatePrincipalPolicy without evaluating (always an
    /// implicit deny), so this checks the call and its shape only.
    #[tokio::test]
    #[ignore]
    async fn simulates_a_principal() {
        let conn = crate::sqs::emulator_tests::connect().await;
        let _ = client(&conn)
            .create_user()
            .user_name("s3x-iam-user")
            .send()
            .await;
        let u = iam::user(&conn, "s3x-iam-user").await.unwrap();
        let mut r = SimRequest {
            kind: "users".into(),
            name: "s3x-iam-user".into(),
            arn: u.summary.arn.clone(),
            actions: vec!["s3:GetObject".into(), "s3:PutObject".into()],
            resources: vec!["arn:aws:s3:::b/k".into()],
            context: vec![ContextIn { key: "aws:SourceIp".into(), kind: "ip".into(), values: vec!["10.0.0.1".into()] }],
            extra_policy: Some(r#"{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:PutObject","Resource":"*"}]}"#.into()),
        };
        let out = simulate(&conn, &r).await.unwrap();
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|x| !x.decision.is_empty()));
        r.actions = vec!["s3:*".into()];
        assert!(simulate(&conn, &r).await.is_err());
    }
}
