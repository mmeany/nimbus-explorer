//! ECS actions: scale / redeploy / change a service's task definition, stop
//! and run tasks. Commands calling these check read-only mode first.

use crate::ecs::{client, err, other, short};
use crate::error::AppError;
use crate::s3::Connection;
use aws_sdk_ecs::types::{
    AssignPublicIp, AwsVpcConfiguration, CapacityProviderStrategyItem, ContainerOverride,
    KeyValuePair, LaunchType, NetworkConfiguration, TaskOverride,
};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceChange {
    pub desired: Option<i32>,
    /// "family:rev" (or a full ARN) to deploy.
    pub task_definition: Option<String>,
    /// Replace every task even if nothing else changes (e.g. to pull a new image for the same tag).
    pub force_new_deployment: bool,
}

pub fn change_problem(c: &ServiceChange) -> Option<String> {
    if let Some(d) = c.desired {
        if !(0..=5000).contains(&d) {
            return Some("The desired count is 0 to 5,000".into());
        }
    }
    if c.desired.is_none() && c.task_definition.is_none() && !c.force_new_deployment {
        return Some("Nothing to change".into());
    }
    None
}

pub async fn update_service(
    conn: &Connection,
    cluster: &str,
    service: &str,
    c: &ServiceChange,
) -> Result<(), AppError> {
    if let Some(p) = change_problem(c) {
        return Err(other(p));
    }
    client(conn)
        .update_service()
        .cluster(cluster)
        .service(service)
        .set_desired_count(c.desired)
        .set_task_definition(c.task_definition.clone().filter(|t| !t.is_empty()))
        .force_new_deployment(c.force_new_deployment)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

pub async fn stop_task(
    conn: &Connection,
    cluster: &str,
    task: &str,
    reason: &str,
) -> Result<(), AppError> {
    let reason = if reason.trim().is_empty() {
        "Stopped from Nimbus Explorer"
    } else {
        reason.trim()
    };
    client(conn)
        .stop_task()
        .cluster(cluster)
        .task(task)
        .reason(reason.chars().take(255).collect::<String>())
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskRequest {
    pub cluster: String,
    pub task_definition: String,
    pub count: i32,
    /// FARGATE / EC2; None with `capacity_provider` set uses that provider;
    /// both None use the cluster's default strategy.
    pub launch_type: Option<String>,
    pub capacity_provider: Option<String>,
    /// For awsvpc networking (always on Fargate).
    #[serde(default)]
    pub subnets: Vec<String>,
    #[serde(default)]
    pub security_groups: Vec<String>,
    pub public_ip: bool,
    /// Override one container's command and / or environment.
    pub container: Option<String>,
    pub command: Option<Vec<String>>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub exec: bool,
}

pub fn run_problem(r: &RunTaskRequest) -> Option<String> {
    if r.task_definition.trim().is_empty() {
        return Some("Choose a task definition".into());
    }
    if !(1..=10).contains(&r.count) {
        return Some("Run 1 to 10 tasks at a time".into());
    }
    if r.launch_type.as_deref() == Some("FARGATE") && r.subnets.is_empty() {
        return Some("Fargate tasks need at least one subnet".into());
    }
    if (r.command.is_some() || !r.env.is_empty()) && r.container.as_deref().unwrap_or("").is_empty()
    {
        return Some("Choose the container the override applies to".into());
    }
    None
}

/// Starts tasks; returns their ids. Failures ECS reports (e.g. no capacity)
/// come back as an error naming them.
pub async fn run_task(conn: &Connection, r: &RunTaskRequest) -> Result<Vec<String>, AppError> {
    if let Some(p) = run_problem(r) {
        return Err(other(p));
    }
    let mut req = client(conn)
        .run_task()
        .cluster(&r.cluster)
        .task_definition(&r.task_definition)
        .count(r.count)
        .started_by("nimbus-explorer")
        .enable_execute_command(r.exec);
    match (r.launch_type.as_deref(), r.capacity_provider.as_deref()) {
        (Some(lt), _) => req = req.launch_type(LaunchType::from(lt)),
        (None, Some(cp)) if !cp.is_empty() => {
            req = req.capacity_provider_strategy(
                CapacityProviderStrategyItem::builder()
                    .capacity_provider(cp)
                    .weight(1)
                    .build()
                    .map_err(|e| other(e.to_string()))?,
            )
        }
        _ => {}
    }
    if !r.subnets.is_empty() {
        let vpc = AwsVpcConfiguration::builder()
            .set_subnets(Some(r.subnets.clone()))
            .set_security_groups(Some(r.security_groups.clone()).filter(|s| !s.is_empty()))
            .assign_public_ip(if r.public_ip {
                AssignPublicIp::Enabled
            } else {
                AssignPublicIp::Disabled
            })
            .build()
            .map_err(|e| other(e.to_string()))?;
        req = req.network_configuration(
            NetworkConfiguration::builder()
                .awsvpc_configuration(vpc)
                .build(),
        );
    }
    if let Some(name) = r.container.as_ref().filter(|n| !n.is_empty()) {
        if r.command.is_some() || !r.env.is_empty() {
            let co = ContainerOverride::builder()
                .name(name)
                .set_command(r.command.clone())
                .set_environment(
                    Some(
                        r.env
                            .iter()
                            .map(|(k, v)| KeyValuePair::builder().name(k).value(v).build())
                            .collect(),
                    )
                    .filter(|v: &Vec<_>| !v.is_empty()),
                )
                .build();
            req = req.overrides(TaskOverride::builder().container_overrides(co).build());
        }
    }
    let out = req.send().await.map_err(|e| err(conn, e))?;
    let ids: Vec<String> = out
        .tasks()
        .iter()
        .filter_map(|t| t.task_arn())
        .map(short)
        .collect();
    if ids.is_empty() {
        let why: Vec<String> = out
            .failures()
            .iter()
            .map(|f| {
                format!(
                    "{}{}",
                    f.reason().unwrap_or("failed"),
                    f.detail().map(|d| format!(" ({d})")).unwrap_or_default()
                )
            })
            .collect();
        return Err(other(if why.is_empty() {
            "ECS didn't start any tasks".to_string()
        } else {
            format!("ECS didn't start the task: {}", why.join("; "))
        }));
    }
    Ok(ids)
}

/// Splits a command line into words, honouring "double" and 'single' quotes.
pub fn split_command(s: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in s.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                started = true;
            }
            (None, c) if c.is_whitespace() => {
                if started {
                    out.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            (None, c) => {
                cur.push(c);
                started = true;
            }
        }
    }
    if quote.is_some() {
        return Err("A quote isn't closed".into());
    }
    if started {
        out.push(cur);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_commands() {
        assert_eq!(
            split_command("python manage.py migrate").unwrap(),
            ["python", "manage.py", "migrate"]
        );
        assert_eq!(
            split_command(r#"sh -c "echo hi && sleep 5""#).unwrap(),
            ["sh", "-c", "echo hi && sleep 5"]
        );
        assert_eq!(split_command("echo ''").unwrap(), ["echo", ""]);
        assert!(split_command("echo \"oops").is_err());
    }

    #[test]
    fn checks_requests() {
        assert!(change_problem(&ServiceChange::default()).is_some());
        assert!(change_problem(&ServiceChange {
            desired: Some(-1),
            ..Default::default()
        })
        .is_some());
        assert!(change_problem(&ServiceChange {
            force_new_deployment: true,
            ..Default::default()
        })
        .is_none());
        let ok = RunTaskRequest {
            cluster: "c".into(),
            task_definition: "web:3".into(),
            count: 1,
            launch_type: Some("FARGATE".into()),
            subnets: vec!["subnet-1".into()],
            ..Default::default()
        };
        assert!(run_problem(&ok).is_none());
        assert!(run_problem(&RunTaskRequest {
            subnets: vec![],
            ..ok.clone()
        })
        .unwrap()
        .contains("subnet"));
        assert!(run_problem(&RunTaskRequest {
            count: 11,
            ..ok.clone()
        })
        .is_some());
        assert!(run_problem(&RunTaskRequest {
            command: Some(vec!["x".into()]),
            ..ok
        })
        .unwrap()
        .contains("container"));
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::ecs::emulator_tests::{connect, fixtures};

    #[tokio::test]
    #[ignore]
    async fn acts_on_services_and_tasks() {
        let conn = connect().await;
        fixtures(&conn).await;
        update_service(
            &conn,
            "s3x-ecs",
            "web",
            &ServiceChange {
                desired: Some(3),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            crate::ecs::service(&conn, "s3x-ecs", "web")
                .await
                .unwrap()
                .desired,
            3
        );
        let revs = crate::ecs_taskdefs::revisions(&conn, "s3x-web", false)
            .await
            .unwrap();
        let older = revs.last().unwrap().clone();
        update_service(
            &conn,
            "s3x-ecs",
            "web",
            &ServiceChange {
                task_definition: Some(older.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            crate::ecs::service(&conn, "s3x-ecs", "web")
                .await
                .unwrap()
                .task_definition,
            older
        );

        let ids = run_task(
            &conn,
            &RunTaskRequest {
                cluster: "s3x-ecs".into(),
                task_definition: "s3x-web".into(),
                count: 2,
                launch_type: Some("FARGATE".into()),
                subnets: vec!["subnet-1".into()],
                container: Some("web".into()),
                command: Some(vec!["echo".into(), "hi".into()]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(ids.len(), 2);
        stop_task(&conn, "s3x-ecs", &ids[0], "").await.unwrap();
        let t = crate::ecs::task(&conn, "s3x-ecs", &ids[0]).await.unwrap();
        assert_eq!(t.desired_status.as_deref(), Some("STOPPED"));
    }
}
