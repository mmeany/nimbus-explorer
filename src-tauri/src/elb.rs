//! Elastic Load Balancing (v2): application, network and gateway load
//! balancers with their listeners and rules; target groups with target
//! health; registering and deregistering targets (callers check
//! `ensure_writable`).

use crate::ec2::{iso, other};
use crate::error::AppError;
use crate::s3::Connection;
use aws_sdk_elasticloadbalancingv2::types::{Action, LoadBalancer as SdkLb, RuleCondition, TargetDescription, TargetGroup as SdkTg};
use aws_sdk_elasticloadbalancingv2::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub fn client(conn: &Connection) -> Client {
    Client::new(&conn.service_config())
}

fn err(conn: &Connection, e: impl std::error::Error) -> AppError {
    AppError::from_sdk(e, &conn.info.profile, conn.info.endpoint_url.as_deref())
}

/// Tags for up to 20 resources per call, keyed by ARN (best effort).
async fn tags_of(c: &Client, arns: &[String]) -> HashMap<String, Vec<(String, String)>> {
    let mut out = HashMap::new();
    for chunk in arns.chunks(20) {
        if let Ok(o) = c.describe_tags().set_resource_arns(Some(chunk.to_vec())).send().await {
            for d in o.tag_descriptions() {
                let mut t: Vec<(String, String)> = d
                    .tags()
                    .iter()
                    .map(|t| (t.key().unwrap_or_default().to_string(), t.value().unwrap_or_default().to_string()))
                    .collect();
                t.sort();
                out.insert(d.resource_arn().unwrap_or_default().to_string(), t);
            }
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Zone {
    pub zone: String,
    pub subnet_id: Option<String>,
    pub addresses: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoadBalancer {
    pub name: String,
    pub arn: String,
    /// application, network or gateway.
    pub lb_type: Option<String>,
    /// internet-facing or internal.
    pub scheme: Option<String>,
    pub state: Option<String>,
    pub state_reason: Option<String>,
    pub dns_name: Option<String>,
    pub vpc_id: Option<String>,
    pub zones: Vec<Zone>,
    pub security_groups: Vec<String>,
    pub ip_type: Option<String>,
    pub created: Option<String>,
}

fn lb(l: &SdkLb) -> LoadBalancer {
    LoadBalancer {
        name: l.load_balancer_name().unwrap_or_default().to_string(),
        arn: l.load_balancer_arn().unwrap_or_default().to_string(),
        lb_type: l.r#type().map(|t| t.as_str().to_string()),
        scheme: l.scheme().map(|s| s.as_str().to_string()),
        state: l.state().and_then(|s| s.code()).map(|c| c.as_str().to_string()),
        state_reason: l.state().and_then(|s| s.reason()).map(String::from),
        dns_name: l.dns_name().map(String::from),
        vpc_id: l.vpc_id().map(String::from),
        zones: l
            .availability_zones()
            .iter()
            .map(|z| Zone {
                zone: z.zone_name().unwrap_or_default().to_string(),
                subnet_id: z.subnet_id().map(String::from),
                addresses: z.load_balancer_addresses().iter().filter_map(|a| a.ip_address()).map(String::from).collect(),
            })
            .collect(),
        security_groups: l.security_groups().to_vec(),
        ip_type: l.ip_address_type().map(|t| t.as_str().to_string()),
        created: iso(l.created_time()),
    }
}

pub async fn list_load_balancers(conn: &Connection) -> Result<Vec<LoadBalancer>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut marker: Option<String> = None;
    loop {
        let page = c
            .describe_load_balancers()
            .page_size(400)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.load_balancers().iter().map(lb));
        match page.next_marker() {
            Some(m) if !m.is_empty() && Some(m) != marker.as_deref() => marker = Some(m.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuleAction {
    /// forward, redirect, fixed-response, authenticate-oidc, authenticate-cognito.
    pub kind: String,
    /// A sentence for the UI ("forward to web-tg", "redirect to https://#{host}:443/#{path}").
    pub text: String,
    /// Target group names (with weight when several) for forward actions.
    pub target_groups: Vec<(String, Option<i32>)>,
}

fn tg_name(arn: &str) -> String {
    // arn:aws:elasticloadbalancing:region:acct:targetgroup/<name>/<id>
    arn.split(':').next_back().and_then(|r| r.split('/').nth(1)).unwrap_or(arn).to_string()
}

pub fn action_text(a: &Action) -> RuleAction {
    let kind = a.r#type().map(|t| t.as_str().to_string()).unwrap_or_default();
    match kind.as_str() {
        "forward" => {
            let mut groups: Vec<(String, Option<i32>)> = a
                .forward_config()
                .map(|f| f.target_groups().iter().map(|t| (tg_name(t.target_group_arn().unwrap_or_default()), t.weight())).collect())
                .unwrap_or_default();
            if groups.is_empty() {
                if let Some(arn) = a.target_group_arn() {
                    groups.push((tg_name(arn), None));
                }
            }
            let text = if groups.len() > 1 {
                format!(
                    "forward to {}",
                    groups.iter().map(|(n, w)| format!("{n} ({})", w.unwrap_or(1))).collect::<Vec<_>>().join(", ")
                )
            } else {
                format!("forward to {}", groups.first().map(|g| g.0.as_str()).unwrap_or("?"))
            };
            RuleAction { kind, text, target_groups: groups }
        }
        "redirect" => {
            let r = a.redirect_config();
            let text = r
                .map(|r| {
                    format!(
                        "redirect ({}) to {}://{}:{}{}{}",
                        r.status_code().map(|s| s.as_str().trim_start_matches("HTTP_")).unwrap_or("?"),
                        r.protocol().unwrap_or("#{protocol}").to_lowercase(),
                        r.host().unwrap_or("#{host}"),
                        r.port().unwrap_or("#{port}"),
                        r.path().unwrap_or("/#{path}"),
                        r.query().map(|q| format!("?{q}")).unwrap_or_default()
                    )
                })
                .unwrap_or_else(|| "redirect".into());
            RuleAction { kind, text, target_groups: vec![] }
        }
        "fixed-response" => {
            let f = a.fixed_response_config();
            let text = format!(
                "respond {}{}",
                f.and_then(|f| f.status_code()).unwrap_or("?"),
                f.and_then(|f| f.content_type()).map(|t| format!(" ({t})")).unwrap_or_default()
            );
            RuleAction { kind, text, target_groups: vec![] }
        }
        "authenticate-oidc" => RuleAction { text: "sign in with OIDC first".into(), kind, target_groups: vec![] },
        "authenticate-cognito" => RuleAction { text: "sign in with Cognito first".into(), kind, target_groups: vec![] },
        _ => RuleAction { text: kind.clone(), kind, target_groups: vec![] },
    }
}

pub fn condition_text(c: &RuleCondition) -> String {
    let field = c.field().unwrap_or("?");
    let vals = |v: Vec<String>| if v.len() == 1 { v[0].clone() } else { format!("one of {}", v.join(", ")) };
    match field {
        "path-pattern" => format!("path is {}", vals(c.path_pattern_config().map(|p| p.values().to_vec()).filter(|v| !v.is_empty()).unwrap_or_else(|| c.values().to_vec()))),
        "host-header" => format!("host is {}", vals(c.host_header_config().map(|p| p.values().to_vec()).filter(|v| !v.is_empty()).unwrap_or_else(|| c.values().to_vec()))),
        "http-request-method" => format!("method is {}", vals(c.http_request_method_config().map(|p| p.values().to_vec()).unwrap_or_default())),
        "source-ip" => format!("source IP in {}", vals(c.source_ip_config().map(|p| p.values().to_vec()).unwrap_or_default())),
        "http-header" => {
            let h = c.http_header_config();
            format!(
                "header {} is {}",
                h.and_then(|h| h.http_header_name()).unwrap_or("?"),
                vals(h.map(|h| h.values().to_vec()).unwrap_or_default())
            )
        }
        "query-string" => format!(
            "query has {}",
            c.query_string_config()
                .map(|q| q.values().iter().map(|kv| format!("{}={}", kv.key().unwrap_or("*"), kv.value().unwrap_or("?"))).collect::<Vec<_>>().join(" or "))
                .unwrap_or_default()
        ),
        other => format!("{other}: {}", c.values().join(", ")),
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub priority: String,
    pub is_default: bool,
    pub conditions: Vec<String>,
    pub actions: Vec<RuleAction>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Listener {
    pub arn: String,
    pub port: Option<i32>,
    pub protocol: Option<String>,
    pub ssl_policy: Option<String>,
    pub certificates: Vec<String>,
    pub default_actions: Vec<RuleAction>,
    /// Application load balancers only; default rule last.
    pub rules: Vec<Rule>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoadBalancerDetails {
    #[serde(flatten)]
    pub lb: LoadBalancer,
    pub listeners: Vec<Listener>,
    /// Selected attributes as (key, value).
    pub attributes: Vec<(String, String)>,
    pub tags: Vec<(String, String)>,
}

pub async fn load_balancer(conn: &Connection, name: &str) -> Result<LoadBalancerDetails, AppError> {
    let c = client(conn);
    let out = c.describe_load_balancers().names(name).send().await.map_err(|e| {
        if format!("{e:?}").contains("LoadBalancerNotFound") {
            other(format!("There's no load balancer called {name} in this region."))
        } else {
            err(conn, e)
        }
    })?;
    let l = out
        .load_balancers()
        .first()
        .map(lb)
        .ok_or_else(|| other(format!("There's no load balancer called {name} in this region.")))?;
    let mut listeners = Vec::new();
    if let Ok(o) = c.describe_listeners().load_balancer_arn(&l.arn).send().await {
        for li in o.listeners() {
            let arn = li.listener_arn().unwrap_or_default().to_string();
            let mut rules = Vec::new();
            if l.lb_type.as_deref() == Some("application") {
                if let Ok(r) = c.describe_rules().listener_arn(&arn).send().await {
                    for ru in r.rules() {
                        rules.push(Rule {
                            priority: ru.priority().unwrap_or_default().to_string(),
                            is_default: ru.is_default().unwrap_or(false),
                            conditions: ru.conditions().iter().map(condition_text).collect(),
                            actions: ru.actions().iter().map(action_text).collect(),
                        });
                    }
                }
                rules.sort_by_key(|r| (r.is_default, r.priority.parse::<i64>().unwrap_or(i64::MAX)));
            }
            listeners.push(Listener {
                arn,
                port: li.port(),
                protocol: li.protocol().map(|p| p.as_str().to_string()),
                ssl_policy: li.ssl_policy().map(String::from),
                certificates: li.certificates().iter().filter_map(|c| c.certificate_arn()).map(String::from).collect(),
                default_actions: li.default_actions().iter().map(action_text).collect(),
                rules,
            });
        }
    }
    listeners.sort_by_key(|l| l.port.unwrap_or(0));
    const WANTED: [&str; 6] = [
        "deletion_protection.enabled",
        "idle_timeout.timeout_seconds",
        "access_logs.s3.enabled",
        "access_logs.s3.bucket",
        "load_balancing.cross_zone.enabled",
        "routing.http2.enabled",
    ];
    let attributes = c
        .describe_load_balancer_attributes()
        .load_balancer_arn(&l.arn)
        .send()
        .await
        .map(|o| {
            o.attributes()
                .iter()
                .filter_map(|a| Some((a.key()?.to_string(), a.value()?.to_string())))
                .filter(|(k, v)| WANTED.contains(&k.as_str()) && !v.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let tags = tags_of(&c, &[l.arn.clone()]).await.remove(&l.arn).unwrap_or_default();
    Ok(LoadBalancerDetails { lb: l, listeners, attributes, tags })
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheck {
    pub protocol: Option<String>,
    pub port: Option<String>,
    pub path: Option<String>,
    pub interval: Option<i32>,
    pub timeout: Option<i32>,
    pub healthy_threshold: Option<i32>,
    pub unhealthy_threshold: Option<i32>,
    pub matcher: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TargetGroup {
    pub name: String,
    pub arn: String,
    pub protocol: Option<String>,
    pub port: Option<i32>,
    /// instance, ip, lambda or alb.
    pub target_type: Option<String>,
    pub vpc_id: Option<String>,
    pub health_check: HealthCheck,
    /// Load balancer names.
    pub load_balancers: Vec<String>,
}

fn lb_name(arn: &str) -> String {
    // …:loadbalancer/app/<name>/<id>
    arn.split(":loadbalancer/").nth(1).and_then(|r| r.split('/').nth(1)).unwrap_or(arn).to_string()
}

fn tg(t: &SdkTg) -> TargetGroup {
    TargetGroup {
        name: t.target_group_name().unwrap_or_default().to_string(),
        arn: t.target_group_arn().unwrap_or_default().to_string(),
        protocol: t.protocol().map(|p| p.as_str().to_string()),
        port: t.port(),
        target_type: t.target_type().map(|p| p.as_str().to_string()),
        vpc_id: t.vpc_id().map(String::from),
        health_check: HealthCheck {
            protocol: t.health_check_protocol().map(|p| p.as_str().to_string()),
            port: t.health_check_port().map(String::from),
            path: t.health_check_path().map(String::from),
            interval: t.health_check_interval_seconds(),
            timeout: t.health_check_timeout_seconds(),
            healthy_threshold: t.healthy_threshold_count(),
            unhealthy_threshold: t.unhealthy_threshold_count(),
            matcher: t.matcher().and_then(|m| m.http_code().or(m.grpc_code())).map(String::from),
        },
        load_balancers: t.load_balancer_arns().iter().map(|a| lb_name(a)).collect(),
    }
}

pub async fn list_target_groups(conn: &Connection) -> Result<Vec<TargetGroup>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut marker: Option<String> = None;
    loop {
        let page = c
            .describe_target_groups()
            .page_size(400)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.target_groups().iter().map(tg));
        match page.next_marker() {
            Some(m) if !m.is_empty() && Some(m) != marker.as_deref() => marker = Some(m.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TargetHealth {
    pub id: String,
    pub port: Option<i32>,
    pub az: Option<String>,
    /// initial, healthy, unhealthy, unused, draining, unavailable.
    pub state: Option<String>,
    pub reason: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TargetGroupDetails {
    #[serde(flatten)]
    pub group: TargetGroup,
    pub targets: Vec<TargetHealth>,
    pub attributes: Vec<(String, String)>,
    pub tags: Vec<(String, String)>,
}

async fn tg_by_name(conn: &Connection, c: &Client, name: &str) -> Result<TargetGroup, AppError> {
    let out = c.describe_target_groups().names(name).send().await.map_err(|e| {
        if format!("{e:?}").contains("TargetGroupNotFound") {
            other(format!("There's no target group called {name} in this region."))
        } else {
            err(conn, e)
        }
    })?;
    out.target_groups()
        .first()
        .map(tg)
        .ok_or_else(|| other(format!("There's no target group called {name} in this region.")))
}

pub async fn target_group(conn: &Connection, name: &str) -> Result<TargetGroupDetails, AppError> {
    let c = client(conn);
    let g = tg_by_name(conn, &c, name).await?;
    let targets = c
        .describe_target_health()
        .target_group_arn(&g.arn)
        .send()
        .await
        .map(|o| {
            o.target_health_descriptions()
                .iter()
                .map(|d| TargetHealth {
                    id: d.target().and_then(|t| t.id()).unwrap_or_default().to_string(),
                    port: d.target().and_then(|t| t.port()),
                    az: d.target().and_then(|t| t.availability_zone()).map(String::from),
                    state: d.target_health().and_then(|h| h.state()).map(|s| s.as_str().to_string()),
                    reason: d.target_health().and_then(|h| h.reason()).map(|r| r.as_str().to_string()),
                    description: d.target_health().and_then(|h| h.description()).map(String::from),
                })
                .collect()
        })
        .map_err(|e| err(conn, e))?;
    const WANTED: [&str; 4] = ["deregistration_delay.timeout_seconds", "stickiness.enabled", "stickiness.type", "load_balancing.algorithm.type"];
    let attributes = c
        .describe_target_group_attributes()
        .target_group_arn(&g.arn)
        .send()
        .await
        .map(|o| {
            o.attributes()
                .iter()
                .filter_map(|a| Some((a.key()?.to_string(), a.value()?.to_string())))
                .filter(|(k, v)| WANTED.contains(&k.as_str()) && !v.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let tags = tags_of(&c, &[g.arn.clone()]).await.remove(&g.arn).unwrap_or_default();
    Ok(TargetGroupDetails { group: g, targets, attributes, tags })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetRef {
    pub id: String,
    pub port: Option<i32>,
}

fn descriptions(targets: &[TargetRef]) -> Result<Vec<TargetDescription>, AppError> {
    if targets.is_empty() {
        return Err(other("No targets were chosen."));
    }
    if targets.len() > 100 {
        return Err(other("Choose at most 100 targets at a time."));
    }
    targets
        .iter()
        .map(|t| {
            if let Some(p) = t.port {
                if !(1..=65535).contains(&p) {
                    return Err(other(format!("Port {p} isn't between 1 and 65535.")));
                }
            }
            Ok(TargetDescription::builder().id(t.id.trim()).set_port(t.port).build())
        })
        .collect()
}

/// Registers targets with a target group (by name).
pub async fn register(conn: &Connection, group: &str, targets: &[TargetRef]) -> Result<(), AppError> {
    let d = descriptions(targets)?;
    let c = client(conn);
    let g = tg_by_name(conn, &c, group).await?;
    c.register_targets()
        .target_group_arn(&g.arn)
        .set_targets(Some(d))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

/// Deregisters targets (connections drain for the group's deregistration delay).
pub async fn deregister(conn: &Connection, group: &str, targets: &[TargetRef]) -> Result<(), AppError> {
    let d = descriptions(targets)?;
    let c = client(conn);
    let g = tg_by_name(conn, &c, group).await?;
    c.deregister_targets()
        .target_group_arn(&g.arn)
        .set_targets(Some(d))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_elasticloadbalancingv2::types::{ActionTypeEnum, ForwardActionConfig, PathPatternConditionConfig, RedirectActionConfig, RedirectActionStatusCodeEnum, TargetGroupTuple};

    #[test]
    fn names_from_arns() {
        assert_eq!(tg_name("arn:aws:elasticloadbalancing:eu-west-2:1:targetgroup/web-tg/abc"), "web-tg");
        assert_eq!(lb_name("arn:aws:elasticloadbalancing:eu-west-2:1:loadbalancer/app/web-alb/abc"), "web-alb");
        assert_eq!(lb_name("arn:aws:elasticloadbalancing:eu-west-2:1:loadbalancer/net/nlb/abc"), "nlb");
    }

    #[test]
    fn describes_actions_and_conditions() {
        let fwd = Action::builder()
            .r#type(ActionTypeEnum::Forward)
            .forward_config(
                ForwardActionConfig::builder()
                    .target_groups(TargetGroupTuple::builder().target_group_arn("arn:x:targetgroup/a/1").weight(80).build())
                    .target_groups(TargetGroupTuple::builder().target_group_arn("arn:x:targetgroup/b/2").weight(20).build())
                    .build(),
            )
            .build();
        let a = action_text(&fwd);
        assert_eq!(a.text, "forward to a (80), b (20)");
        assert_eq!(a.target_groups, vec![("a".to_string(), Some(80)), ("b".to_string(), Some(20))]);
        let one = Action::builder().r#type(ActionTypeEnum::Forward).target_group_arn("arn:x:targetgroup/web/1").build();
        assert_eq!(action_text(&one).text, "forward to web");
        let red = Action::builder()
            .r#type(ActionTypeEnum::Redirect)
            .redirect_config(RedirectActionConfig::builder().protocol("HTTPS").port("443").status_code(RedirectActionStatusCodeEnum::Http301).build())
            .build();
        assert_eq!(action_text(&red).text, "redirect (301) to https://#{host}:443/#{path}");
        let cond = RuleCondition::builder().field("path-pattern").path_pattern_config(PathPatternConditionConfig::builder().values("/api/*").build()).build();
        assert_eq!(condition_text(&cond), "path is /api/*");
    }

    #[test]
    fn checks_targets() {
        assert!(descriptions(&[]).is_err());
        assert!(descriptions(&[TargetRef { id: "i-1".into(), port: Some(70000) }]).is_err());
        assert_eq!(descriptions(&[TargetRef { id: "i-1".into(), port: Some(80) }]).unwrap().len(), 1);
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::ec2::emulator_tests::{connect, ensure_instance};
    use aws_sdk_elasticloadbalancingv2::types::{ActionTypeEnum, ProtocolEnum};

    #[tokio::test]
    #[ignore]
    async fn browses_load_balancers_and_registers_targets() {
        let conn = connect().await;
        let inst = ensure_instance(&conn, "s3x-ec2-elb").await;
        let i = crate::ec2::get_instance(&conn, &inst).await.unwrap();
        let c = client(&conn);
        let ec2 = crate::ec2::client(&conn);
        let subnets: Vec<String> = ec2
            .describe_subnets()
            .send()
            .await
            .unwrap()
            .subnets()
            .iter()
            .filter(|s| s.vpc_id() == i.vpc_id.as_deref())
            .filter_map(|s| s.subnet_id())
            .map(String::from)
            .take(2)
            .collect();
        let tg_arn = match c
            .create_target_group()
            .name("s3x-tg")
            .protocol(ProtocolEnum::Http)
            .port(80)
            .set_vpc_id(i.vpc_id.clone())
            .send()
            .await
        {
            Ok(o) => o.target_groups()[0].target_group_arn().unwrap().to_string(),
            Err(_) => c.describe_target_groups().names("s3x-tg").send().await.unwrap().target_groups()[0].target_group_arn().unwrap().to_string(),
        };
        let lb_arn = match c.create_load_balancer().name("s3x-alb").set_subnets(Some(subnets)).send().await {
            Ok(o) => o.load_balancers()[0].load_balancer_arn().unwrap().to_string(),
            Err(_) => c.describe_load_balancers().names("s3x-alb").send().await.unwrap().load_balancers()[0].load_balancer_arn().unwrap().to_string(),
        };
        let _ = c
            .create_listener()
            .load_balancer_arn(&lb_arn)
            .protocol(ProtocolEnum::Http)
            .port(80)
            .default_actions(Action::builder().r#type(ActionTypeEnum::Forward).target_group_arn(&tg_arn).build())
            .send()
            .await;

        assert!(list_load_balancers(&conn).await.unwrap().iter().any(|l| l.name == "s3x-alb"));
        let d = load_balancer(&conn, "s3x-alb").await.unwrap();
        assert_eq!(d.lb.arn, lb_arn);
        assert!(load_balancer(&conn, "s3x-missing").await.is_err());
        assert!(list_target_groups(&conn).await.unwrap().iter().any(|t| t.name == "s3x-tg"));

        let t = [TargetRef { id: inst.clone(), port: None }];
        register(&conn, "s3x-tg", &t).await.unwrap();
        let g = target_group(&conn, "s3x-tg").await.unwrap();
        assert!(g.targets.iter().any(|x| x.id == inst));
        deregister(&conn, "s3x-tg", &t).await.unwrap();
    }
}
