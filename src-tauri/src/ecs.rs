//! ECS: clusters, services and tasks (browse).

use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use aws_sdk_ecs::types::{DesiredStatus, ServiceField, TaskField};
use aws_sdk_ecs::Client;
use serde::Serialize;

pub fn client(conn: &Connection) -> Client {
    Client::new(&conn.service_config())
}

pub(crate) fn err(conn: &Connection, e: impl std::error::Error) -> AppError {
    AppError::from_sdk(e, &conn.info.profile, conn.info.endpoint_url.as_deref())
}

pub(crate) fn other(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Other, msg)
}

pub(crate) fn iso(d: Option<&aws_smithy_types::DateTime>) -> Option<String> {
    d.and_then(|d| d.fmt(aws_smithy_types::date_time::Format::DateTime).ok())
}

/// The last part of an ARN ("…:service/cluster/name" → "name").
pub fn short(arn: &str) -> String {
    arn.rsplit('/').next().unwrap_or(arn).to_string()
}

/// "arn:…:task-definition/web:12" → "web:12".
pub fn task_def_name(arn: &str) -> String {
    arn.rsplit_once("task-definition/")
        .map(|(_, n)| n.to_string())
        .unwrap_or_else(|| arn.to_string())
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Strategy {
    pub capacity_provider: String,
    pub weight: i32,
    pub base: i32,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClusterInfo {
    pub name: String,
    pub arn: String,
    pub status: Option<String>,
    pub active_services: i32,
    pub running_tasks: i32,
    pub pending_tasks: i32,
    pub container_instances: i32,
    pub capacity_providers: Vec<String>,
    pub default_strategy: Vec<Strategy>,
    /// "enabled", "enhanced" or "disabled".
    pub container_insights: Option<String>,
    pub tags: Vec<(String, String)>,
}

fn strategies(s: &[aws_sdk_ecs::types::CapacityProviderStrategyItem]) -> Vec<Strategy> {
    s.iter()
        .map(|x| Strategy {
            capacity_provider: x.capacity_provider().to_string(),
            weight: x.weight(),
            base: x.base(),
        })
        .collect()
}

fn tags(t: &[aws_sdk_ecs::types::Tag]) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = t
        .iter()
        .map(|t| {
            (
                t.key().unwrap_or_default().to_string(),
                t.value().unwrap_or_default().to_string(),
            )
        })
        .collect();
    v.sort();
    v
}

/// Every cluster with its counts (ListClusters, then DescribeClusters 100 at a time).
pub async fn list_clusters(conn: &Connection) -> Result<Vec<ClusterInfo>, AppError> {
    let c = client(conn);
    let mut arns = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .list_clusters()
            .max_results(100)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        arns.extend(page.cluster_arns().iter().cloned());
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    let mut out = Vec::new();
    for chunk in arns.chunks(100) {
        let page = c
            .describe_clusters()
            .set_clusters(Some(chunk.to_vec()))
            .include(aws_sdk_ecs::types::ClusterField::Settings)
            .include(aws_sdk_ecs::types::ClusterField::Tags)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.clusters().iter().map(|k| {
            ClusterInfo {
                name: k.cluster_name().unwrap_or_default().to_string(),
                arn: k.cluster_arn().unwrap_or_default().to_string(),
                status: k.status().map(String::from),
                active_services: k.active_services_count(),
                running_tasks: k.running_tasks_count(),
                pending_tasks: k.pending_tasks_count(),
                container_instances: k.registered_container_instances_count(),
                capacity_providers: k.capacity_providers().to_vec(),
                default_strategy: strategies(k.default_capacity_provider_strategy()),
                container_insights: k
                    .settings()
                    .iter()
                    .find(|s| s.name().map(|n| n.as_str()) == Some("containerInsights"))
                    .and_then(|s| s.value())
                    .map(String::from),
                tags: tags(k.tags()),
            }
        }));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Deployment {
    pub id: String,
    /// PRIMARY, ACTIVE (being replaced) or INACTIVE.
    pub status: Option<String>,
    pub task_definition: String,
    pub desired: i32,
    pub running: i32,
    pub pending: i32,
    pub failed: i32,
    /// IN_PROGRESS, COMPLETED or FAILED.
    pub rollout_state: Option<String>,
    pub rollout_reason: Option<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceEvent {
    pub id: String,
    pub created: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoadBalancer {
    pub target_group_arn: Option<String>,
    pub load_balancer_name: Option<String>,
    pub container_name: Option<String>,
    pub container_port: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub name: String,
    pub arn: String,
    pub cluster: String,
    pub status: Option<String>,
    pub desired: i32,
    pub running: i32,
    pub pending: i32,
    /// FARGATE, EC2, EXTERNAL; empty when a capacity provider strategy is used.
    pub launch_type: Option<String>,
    pub strategy: Vec<Strategy>,
    pub platform_version: Option<String>,
    pub task_definition: String,
    pub deployments: Vec<Deployment>,
    /// Newest first (ECS keeps the last 100).
    pub events: Vec<ServiceEvent>,
    pub load_balancers: Vec<LoadBalancer>,
    pub subnets: Vec<String>,
    pub security_groups: Vec<String>,
    pub public_ip: Option<bool>,
    /// REPLICA or DAEMON.
    pub scheduling: Option<String>,
    pub max_percent: Option<i32>,
    pub min_healthy_percent: Option<i32>,
    pub circuit_breaker: Option<bool>,
    pub circuit_breaker_rollback: Option<bool>,
    pub exec_enabled: bool,
    pub health_check_grace_secs: Option<i32>,
    pub created: Option<String>,
    pub role: Option<String>,
    pub registries: Vec<String>,
    pub tags: Vec<(String, String)>,
}

fn to_service(s: &aws_sdk_ecs::types::Service) -> ServiceInfo {
    let net = s
        .network_configuration()
        .and_then(|n| n.awsvpc_configuration());
    let dc = s.deployment_configuration();
    ServiceInfo {
        name: s.service_name().unwrap_or_default().to_string(),
        arn: s.service_arn().unwrap_or_default().to_string(),
        cluster: s.cluster_arn().map(short).unwrap_or_default(),
        status: s.status().map(String::from),
        desired: s.desired_count(),
        running: s.running_count(),
        pending: s.pending_count(),
        launch_type: s.launch_type().map(|l| l.as_str().to_string()),
        strategy: strategies(s.capacity_provider_strategy()),
        platform_version: s.platform_version().map(String::from),
        task_definition: s.task_definition().map(task_def_name).unwrap_or_default(),
        deployments: s
            .deployments()
            .iter()
            .map(|d| Deployment {
                id: d.id().unwrap_or_default().to_string(),
                status: d.status().map(String::from),
                task_definition: d.task_definition().map(task_def_name).unwrap_or_default(),
                desired: d.desired_count(),
                running: d.running_count(),
                pending: d.pending_count(),
                failed: d.failed_tasks(),
                rollout_state: d.rollout_state().map(|r| r.as_str().to_string()),
                rollout_reason: d.rollout_state_reason().map(String::from),
                created: iso(d.created_at()),
                updated: iso(d.updated_at()),
            })
            .collect(),
        events: s
            .events()
            .iter()
            .map(|e| ServiceEvent {
                id: e.id().unwrap_or_default().to_string(),
                created: iso(e.created_at()),
                message: e.message().unwrap_or_default().to_string(),
            })
            .collect(),
        load_balancers: s
            .load_balancers()
            .iter()
            .map(|l| LoadBalancer {
                target_group_arn: l.target_group_arn().map(String::from),
                load_balancer_name: l.load_balancer_name().map(String::from),
                container_name: l.container_name().map(String::from),
                container_port: l.container_port(),
            })
            .collect(),
        subnets: net.map(|n| n.subnets().to_vec()).unwrap_or_default(),
        security_groups: net
            .map(|n| n.security_groups().to_vec())
            .unwrap_or_default(),
        public_ip: net
            .and_then(|n| n.assign_public_ip())
            .map(|a| a.as_str() == "ENABLED"),
        scheduling: s.scheduling_strategy().map(|x| x.as_str().to_string()),
        max_percent: dc.and_then(|d| d.maximum_percent()),
        min_healthy_percent: dc.and_then(|d| d.minimum_healthy_percent()),
        circuit_breaker: dc
            .and_then(|d| d.deployment_circuit_breaker())
            .map(|c| c.enable()),
        circuit_breaker_rollback: dc
            .and_then(|d| d.deployment_circuit_breaker())
            .map(|c| c.rollback()),
        exec_enabled: s.enable_execute_command(),
        health_check_grace_secs: s.health_check_grace_period_seconds(),
        created: iso(s.created_at()),
        role: s.role_arn().map(String::from),
        registries: s
            .service_registries()
            .iter()
            .filter_map(|r| r.registry_arn().map(String::from))
            .collect(),
        tags: tags(s.tags()),
    }
}

/// Every service ARN in a cluster, sorted by name (ListServices, 100 per call).
pub async fn list_service_arns(conn: &Connection, cluster: &str) -> Result<Vec<String>, AppError> {
    let c = client(conn);
    let mut arns = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .list_services()
            .cluster(cluster)
            .max_results(100)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        arns.extend(page.service_arns().iter().cloned());
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    arns.sort_by_key(|a| short(a));
    Ok(arns)
}

/// Details of the given services (the visible page; DescribeServices takes 10 at a time).
pub async fn services(
    conn: &Connection,
    cluster: &str,
    names: &[String],
) -> Result<Vec<ServiceInfo>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    for chunk in names.chunks(10) {
        let page = c
            .describe_services()
            .cluster(cluster)
            .set_services(Some(chunk.to_vec()))
            .include(ServiceField::Tags)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.services().iter().map(to_service));
    }
    // Keep the order asked for.
    out.sort_by_key(|s| {
        names
            .iter()
            .position(|n| n == &s.name || n == &s.arn)
            .unwrap_or(usize::MAX)
    });
    Ok(out)
}

pub async fn service(
    conn: &Connection,
    cluster: &str,
    name: &str,
) -> Result<ServiceInfo, AppError> {
    services(conn, cluster, &[name.to_string()])
        .await?
        .into_iter()
        .find(|s| s.status.as_deref() != Some("INACTIVE") || s.name == name)
        .ok_or_else(|| other(format!("Service {name} doesn't exist in {cluster}")))
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub name: String,
    pub image: Option<String>,
    pub last_status: Option<String>,
    pub health: Option<String>,
    pub exit_code: Option<i32>,
    pub reason: Option<String>,
    pub runtime_id: Option<String>,
    pub ports: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    /// The task id (last part of the ARN).
    pub id: String,
    pub arn: String,
    pub cluster: String,
    pub task_definition: String,
    pub last_status: Option<String>,
    pub desired_status: Option<String>,
    pub health: Option<String>,
    pub launch_type: Option<String>,
    pub capacity_provider: Option<String>,
    pub cpu: Option<String>,
    pub memory: Option<String>,
    pub created: Option<String>,
    pub started: Option<String>,
    pub stopped: Option<String>,
    pub stopped_reason: Option<String>,
    pub stop_code: Option<String>,
    /// "service:name" for service tasks, "family:…" for standalone ones.
    pub group: Option<String>,
    pub availability_zone: Option<String>,
    pub private_ip: Option<String>,
    pub platform_version: Option<String>,
    pub exec_enabled: bool,
    pub containers: Vec<ContainerInfo>,
    pub tags: Vec<(String, String)>,
}

fn to_task(t: &aws_sdk_ecs::types::Task) -> TaskInfo {
    let eni_ip = t
        .attachments()
        .iter()
        .flat_map(|a| a.details())
        .find(|d| d.name() == Some("privateIPv4Address"))
        .and_then(|d| d.value())
        .map(String::from);
    let container_ip = t
        .containers()
        .iter()
        .flat_map(|c| c.network_interfaces())
        .find_map(|n| n.private_ipv4_address())
        .map(String::from);
    TaskInfo {
        id: t.task_arn().map(short).unwrap_or_default(),
        arn: t.task_arn().unwrap_or_default().to_string(),
        cluster: t.cluster_arn().map(short).unwrap_or_default(),
        task_definition: t
            .task_definition_arn()
            .map(task_def_name)
            .unwrap_or_default(),
        last_status: t.last_status().map(String::from),
        desired_status: t.desired_status().map(String::from),
        health: t.health_status().map(|h| h.as_str().to_string()),
        launch_type: t.launch_type().map(|l| l.as_str().to_string()),
        capacity_provider: t.capacity_provider_name().map(String::from),
        cpu: t.cpu().map(String::from),
        memory: t.memory().map(String::from),
        created: iso(t.created_at()),
        started: iso(t.started_at()),
        stopped: iso(t.stopped_at()),
        stopped_reason: t.stopped_reason().map(String::from),
        stop_code: t.stop_code().map(|s| s.as_str().to_string()),
        group: t.group().map(String::from),
        availability_zone: t.availability_zone().map(String::from),
        private_ip: eni_ip.or(container_ip),
        platform_version: t.platform_version().map(String::from),
        exec_enabled: t.enable_execute_command(),
        containers: t
            .containers()
            .iter()
            .map(|c| ContainerInfo {
                name: c.name().unwrap_or_default().to_string(),
                image: c.image().map(String::from),
                last_status: c.last_status().map(String::from),
                health: c.health_status().map(|h| h.as_str().to_string()),
                exit_code: c.exit_code(),
                reason: c.reason().map(String::from),
                runtime_id: c.runtime_id().map(String::from),
                ports: c
                    .network_bindings()
                    .iter()
                    .map(|b| {
                        format!(
                            "{}→{}",
                            b.host_port().map(|p| p.to_string()).unwrap_or_default(),
                            b.container_port()
                                .map(|p| p.to_string())
                                .unwrap_or_default()
                        )
                    })
                    .collect(),
            })
            .collect(),
        tags: tags(t.tags()),
    }
}

/// Tasks of a cluster (or one service), running or recently stopped (ECS
/// keeps stopped tasks for about an hour). Newest first.
pub async fn list_tasks(
    conn: &Connection,
    cluster: &str,
    service: Option<&str>,
    stopped: bool,
) -> Result<Vec<TaskInfo>, AppError> {
    let c = client(conn);
    let mut arns = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .list_tasks()
            .cluster(cluster)
            .set_service_name(service.map(String::from))
            .desired_status(if stopped {
                DesiredStatus::Stopped
            } else {
                DesiredStatus::Running
            })
            .max_results(100)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        arns.extend(page.task_arns().iter().cloned());
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
        // A cluster can run thousands of tasks; the newest 1,000 are plenty to browse.
        if arns.len() >= 1000 {
            break;
        }
    }
    let mut out = Vec::new();
    for chunk in arns.chunks(100) {
        let page = c
            .describe_tasks()
            .cluster(cluster)
            .set_tasks(Some(chunk.to_vec()))
            .include(TaskField::Tags)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.tasks().iter().map(to_task));
    }
    out.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(out)
}

pub async fn task(conn: &Connection, cluster: &str, id: &str) -> Result<TaskInfo, AppError> {
    let page = client(conn)
        .describe_tasks()
        .cluster(cluster)
        .tasks(id)
        .include(TaskField::Tags)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    page.tasks().first().map(to_task).ok_or_else(|| {
        other(format!(
            "Task {id} wasn't found (stopped tasks disappear after about an hour)"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_from_arns() {
        assert_eq!(short("arn:aws:ecs:eu-west-2:1:service/prod/web"), "web");
        assert_eq!(short("arn:aws:ecs:eu-west-2:1:task/prod/0a1b2c"), "0a1b2c");
        assert_eq!(
            task_def_name("arn:aws:ecs:eu-west-2:1:task-definition/web:12"),
            "web:12"
        );
        assert_eq!(task_def_name("web:3"), "web:3");
    }
}

#[cfg(test)]
pub(crate) mod emulator_tests {
    use super::*;
    use aws_sdk_ecs::types::{ContainerDefinition, LaunchType, NetworkMode};

    pub(crate) async fn connect() -> Connection {
        crate::sqs::emulator_tests::connect().await
    }

    /// Cluster s3x-ecs with task definition s3x-web (2 revisions), service web (2 tasks).
    pub(crate) async fn fixtures(conn: &Connection) {
        let c = client(conn);
        c.create_cluster()
            .cluster_name("s3x-ecs")
            .send()
            .await
            .unwrap();
        let mut latest = String::new();
        for image in ["nginx:1.25", "nginx:1.27"] {
            let out = c
                .register_task_definition()
                .family("s3x-web")
                .network_mode(NetworkMode::Bridge)
                .container_definitions(
                    ContainerDefinition::builder()
                        .name("web")
                        .image(image)
                        .memory(256)
                        .essential(true)
                        .log_configuration(
                            aws_sdk_ecs::types::LogConfiguration::builder()
                                .log_driver(aws_sdk_ecs::types::LogDriver::Awslogs)
                                .options("awslogs-group", "/ecs/s3x-web")
                                .options("awslogs-stream-prefix", "app")
                                .options("awslogs-region", "eu-west-2")
                                .build()
                                .unwrap(),
                        )
                        .build(),
                )
                .send()
                .await
                .unwrap();
            latest = out
                .task_definition()
                .and_then(|t| t.task_definition_arn())
                .unwrap()
                .to_string();
        }
        let existing = c
            .describe_services()
            .cluster("s3x-ecs")
            .services("web")
            .send()
            .await
            .unwrap();
        if !existing
            .services()
            .iter()
            .any(|s| s.status() == Some("ACTIVE"))
        {
            c.create_service()
                .cluster("s3x-ecs")
                .service_name("web")
                .task_definition(&latest)
                .desired_count(2)
                .launch_type(LaunchType::Ec2)
                .send()
                .await
                .unwrap();
        } else {
            // Other tests change the service; start each one from the same state.
            c.update_service()
                .cluster("s3x-ecs")
                .service("web")
                .desired_count(2)
                .task_definition("s3x-web")
                .send()
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    #[ignore]
    async fn browses_clusters_services_and_tasks() {
        let conn = connect().await;
        fixtures(&conn).await;
        let clusters = list_clusters(&conn).await.unwrap();
        assert!(clusters.iter().any(|k| k.name == "s3x-ecs"));
        let arns = list_service_arns(&conn, "s3x-ecs").await.unwrap();
        assert!(arns.iter().any(|a| short(a) == "web"));
        let svc = service(&conn, "s3x-ecs", "web").await.unwrap();
        assert_eq!(svc.desired, 2);
        // moto echoes the task definition string it was given (sometimes just
        // the family); real AWS always returns the full revision ARN.
        assert!(svc.task_definition.starts_with("s3x-web"));

        // Standalone task, then it shows in the list and can be described.
        let run = client(&conn)
            .run_task()
            .cluster("s3x-ecs")
            .task_definition("s3x-web")
            .launch_type(LaunchType::Fargate)
            .send()
            .await
            .unwrap();
        let id = short(run.tasks()[0].task_arn().unwrap());
        let tasks = list_tasks(&conn, "s3x-ecs", None, false).await.unwrap();
        assert!(tasks.iter().any(|t| t.id == id));
        let t = task(&conn, "s3x-ecs", &id).await.unwrap();
        assert_eq!(t.containers[0].name, "web");
    }
}
