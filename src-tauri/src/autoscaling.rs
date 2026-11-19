//! EC2 Auto Scaling groups: details, instances, activities, instance
//! refreshes; capacity, suspend / resume processes, start / cancel an
//! instance refresh (callers check `ensure_writable`).

use crate::ec2::{iso, other};
use crate::error::AppError;
use crate::s3::Connection;
use aws_sdk_autoscaling::types::{AutoScalingGroup, RefreshPreferences};
use aws_sdk_autoscaling::Client;
use serde::Serialize;

pub fn client(conn: &Connection) -> Client {
    Client::new(&conn.service_config())
}

fn err(conn: &Connection, e: impl std::error::Error) -> AppError {
    AppError::from_sdk(e, &conn.info.profile, conn.info.endpoint_url.as_deref())
}

/// The processes Auto Scaling can suspend.
pub const PROCESSES: [&str; 9] = [
    "Launch",
    "Terminate",
    "AddToLoadBalancer",
    "AlarmNotification",
    "AZRebalance",
    "HealthCheck",
    "InstanceRefresh",
    "ReplaceUnhealthy",
    "ScheduledActions",
];

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GroupInstance {
    pub id: String,
    pub az: Option<String>,
    /// InService, Pending, Terminating, Standby, …
    pub lifecycle: Option<String>,
    /// Healthy or Unhealthy.
    pub health: Option<String>,
    pub instance_type: Option<String>,
    pub protected: bool,
    /// "lt-…:3", "config-name" (launch configuration), or None.
    pub launched_from: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub name: String,
    pub arn: Option<String>,
    pub min: i32,
    pub max: i32,
    pub desired: i32,
    /// "web-template (lt-…) version $Latest", "launch configuration x", "mixed instances: …".
    pub launch_source: Option<String>,
    pub launch_template_id: Option<String>,
    pub subnets: Vec<String>,
    pub zones: Vec<String>,
    /// Target group names.
    pub target_groups: Vec<String>,
    pub classic_load_balancers: Vec<String>,
    pub health_check_type: Option<String>,
    pub health_check_grace: Option<i32>,
    pub status: Option<String>,
    pub suspended: Vec<String>,
    pub created: Option<String>,
    pub instances: Vec<GroupInstance>,
    pub tags: Vec<(String, String)>,
}

fn tg_name(arn: &str) -> String {
    arn.split(':').next_back().and_then(|r| r.split('/').nth(1)).unwrap_or(arn).to_string()
}

fn group(g: &AutoScalingGroup) -> Group {
    let lt = g.launch_template();
    let mixed = g.mixed_instances_policy().and_then(|m| m.launch_template()).and_then(|l| l.launch_template_specification());
    let spec = lt.or(mixed);
    let launch_source = if let Some(s) = spec {
        Some(format!(
            "{}{} version {}{}",
            s.launch_template_name().unwrap_or_default(),
            s.launch_template_id().map(|i| format!(" ({i})")).unwrap_or_default(),
            s.version().unwrap_or("$Default"),
            if lt.is_none() { " (mixed instances policy)" } else { "" }
        ))
    } else {
        g.launch_configuration_name().map(|c| format!("launch configuration {c}"))
    };
    let mut tags: Vec<(String, String)> = g
        .tags()
        .iter()
        .map(|t| (t.key().unwrap_or_default().to_string(), t.value().unwrap_or_default().to_string()))
        .collect();
    tags.sort();
    Group {
        name: g.auto_scaling_group_name().unwrap_or_default().to_string(),
        arn: g.auto_scaling_group_arn().map(String::from),
        min: g.min_size().unwrap_or_default(),
        max: g.max_size().unwrap_or_default(),
        desired: g.desired_capacity().unwrap_or_default(),
        launch_source,
        launch_template_id: spec.and_then(|s| s.launch_template_id()).map(String::from),
        subnets: g
            .vpc_zone_identifier()
            .map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default(),
        zones: g.availability_zones().to_vec(),
        target_groups: g.target_group_arns().iter().map(|a| tg_name(a)).collect(),
        classic_load_balancers: g.load_balancer_names().to_vec(),
        health_check_type: g.health_check_type().map(String::from),
        health_check_grace: g.health_check_grace_period(),
        status: g.status().map(String::from),
        suspended: g
            .suspended_processes()
            .iter()
            .filter_map(|p| p.process_name())
            .map(String::from)
            .collect(),
        created: iso(g.created_time()),
        instances: g
            .instances()
            .iter()
            .map(|i| GroupInstance {
                id: i.instance_id().unwrap_or_default().to_string(),
                az: i.availability_zone().map(String::from),
                lifecycle: i.lifecycle_state().map(|s| s.as_str().to_string()),
                health: i.health_status().map(String::from),
                instance_type: i.instance_type().map(String::from),
                protected: i.protected_from_scale_in().unwrap_or(false),
                launched_from: i
                    .launch_template()
                    .map(|t| format!("{}:{}", t.launch_template_id().or(t.launch_template_name()).unwrap_or("?"), t.version().unwrap_or("?")))
                    .or_else(|| i.launch_configuration_name().map(String::from)),
            })
            .collect(),
        tags,
    }
}

pub async fn list_groups(conn: &Connection) -> Result<Vec<Group>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .describe_auto_scaling_groups()
            .max_records(100)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.auto_scaling_groups().iter().map(group));
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub description: Option<String>,
    pub cause: Option<String>,
    pub status: Option<String>,
    pub status_message: Option<String>,
    pub started: Option<String>,
    pub ended: Option<String>,
    pub progress: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Refresh {
    pub id: String,
    /// Pending, InProgress, Successful, Failed, Cancelling, Cancelled, RollbackInProgress, …
    pub status: Option<String>,
    pub status_reason: Option<String>,
    pub percentage: Option<i32>,
    pub instances_to_update: Option<i32>,
    pub started: Option<String>,
    pub ended: Option<String>,
    pub min_healthy: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GroupDetails {
    #[serde(flatten)]
    pub group: Group,
    /// Newest first (up to 50).
    pub activities: Vec<Activity>,
    /// Newest first.
    pub refreshes: Vec<Refresh>,
    /// "name (type)" of scaling policies.
    pub policies: Vec<String>,
}

pub async fn group_details(conn: &Connection, name: &str) -> Result<GroupDetails, AppError> {
    let c = client(conn);
    let out = c
        .describe_auto_scaling_groups()
        .auto_scaling_group_names(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let g = out
        .auto_scaling_groups()
        .first()
        .map(group)
        .ok_or_else(|| other(format!("There's no Auto Scaling group called {name} in this region.")))?;
    let activities = c
        .describe_scaling_activities()
        .auto_scaling_group_name(name)
        .max_records(50)
        .send()
        .await
        .map(|o| {
            o.activities()
                .iter()
                .map(|a| Activity {
                    description: a.description().map(String::from),
                    cause: a.cause().map(String::from),
                    status: a.status_code().map(|s| s.as_str().to_string()),
                    status_message: a.status_message().filter(|m| !m.is_empty()).map(String::from),
                    started: iso(a.start_time()),
                    ended: iso(a.end_time()),
                    progress: a.progress(),
                })
                .collect()
        })
        .unwrap_or_default();
    let refreshes = c
        .describe_instance_refreshes()
        .auto_scaling_group_name(name)
        .send()
        .await
        .map(|o| {
            o.instance_refreshes()
                .iter()
                .map(|r| Refresh {
                    id: r.instance_refresh_id().unwrap_or_default().to_string(),
                    status: r.status().map(|s| s.as_str().to_string()),
                    status_reason: r.status_reason().map(String::from),
                    percentage: r.percentage_complete(),
                    instances_to_update: r.instances_to_update(),
                    started: iso(r.start_time()),
                    ended: iso(r.end_time()),
                    min_healthy: r.preferences().and_then(|p| p.min_healthy_percentage()),
                })
                .collect()
        })
        .unwrap_or_default();
    let policies = c
        .describe_policies()
        .auto_scaling_group_name(name)
        .send()
        .await
        .map(|o| {
            o.scaling_policies()
                .iter()
                .map(|p| format!("{} ({})", p.policy_name().unwrap_or("?"), p.policy_type().unwrap_or("?")))
                .collect()
        })
        .unwrap_or_default();
    Ok(GroupDetails { group: g, activities, refreshes, policies })
}

pub fn check_capacity(min: i32, max: i32, desired: i32) -> Result<(), AppError> {
    if min < 0 || max < 0 || desired < 0 {
        return Err(other("Sizes can't be negative."));
    }
    if min > max {
        return Err(other("Minimum can't be more than maximum."));
    }
    if desired < min || desired > max {
        return Err(other("Desired capacity must be between the minimum and maximum."));
    }
    Ok(())
}

pub async fn set_capacity(conn: &Connection, name: &str, min: i32, max: i32, desired: i32) -> Result<(), AppError> {
    check_capacity(min, max, desired)?;
    client(conn)
        .update_auto_scaling_group()
        .auto_scaling_group_name(name)
        .min_size(min)
        .max_size(max)
        .desired_capacity(desired)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

fn check_processes(processes: &[String]) -> Result<(), AppError> {
    if processes.is_empty() {
        return Err(other("Choose at least one process."));
    }
    if let Some(bad) = processes.iter().find(|p| !PROCESSES.contains(&p.as_str())) {
        return Err(other(format!("{bad} isn't an Auto Scaling process.")));
    }
    Ok(())
}

/// Suspends (`suspend`) or resumes processes.
pub async fn set_processes(conn: &Connection, name: &str, processes: &[String], suspend: bool) -> Result<(), AppError> {
    check_processes(processes)?;
    let c = client(conn);
    if suspend {
        c.suspend_processes()
            .auto_scaling_group_name(name)
            .set_scaling_processes(Some(processes.to_vec()))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    } else {
        c.resume_processes()
            .auto_scaling_group_name(name)
            .set_scaling_processes(Some(processes.to_vec()))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    Ok(())
}

/// Starts replacing the group's instances; returns the refresh ID.
pub async fn start_refresh(conn: &Connection, name: &str, min_healthy: i32, warmup: Option<i32>, skip_matching: bool) -> Result<String, AppError> {
    if !(0..=100).contains(&min_healthy) {
        return Err(other("Minimum healthy is a percentage, 0 to 100."));
    }
    if warmup.map(|w| w < 0).unwrap_or(false) {
        return Err(other("Warm-up can't be negative."));
    }
    let prefs = RefreshPreferences::builder()
        .min_healthy_percentage(min_healthy)
        .set_instance_warmup(warmup)
        .skip_matching(skip_matching)
        .build();
    let out = client(conn)
        .start_instance_refresh()
        .auto_scaling_group_name(name)
        .preferences(prefs)
        .send()
        .await
        .map_err(|e| {
            if format!("{e:?}").contains("InstanceRefreshInProgress") {
                other("An instance refresh is already running for this group.")
            } else {
                err(conn, e)
            }
        })?;
    Ok(out.instance_refresh_id().unwrap_or_default().to_string())
}

pub async fn cancel_refresh(conn: &Connection, name: &str) -> Result<(), AppError> {
    client(conn)
        .cancel_instance_refresh()
        .auto_scaling_group_name(name)
        .send()
        .await
        .map_err(|e| {
            if format!("{e:?}").contains("ActiveInstanceRefreshNotFound") {
                other("No instance refresh is running for this group.")
            } else {
                err(conn, e)
            }
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_capacity_and_processes() {
        assert!(check_capacity(1, 3, 2).is_ok());
        assert!(check_capacity(0, 0, 0).is_ok());
        assert!(check_capacity(3, 1, 2).is_err());
        assert!(check_capacity(1, 3, 4).is_err());
        assert!(check_capacity(-1, 3, 0).is_err());
        assert!(check_processes(&["Launch".into()]).is_ok());
        assert!(check_processes(&[]).is_err());
        assert!(check_processes(&["Explode".into()]).is_err());
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::ec2::emulator_tests::connect;
    use aws_sdk_ec2::types::{InstanceType, RequestLaunchTemplateData};

    #[tokio::test]
    #[ignore]
    async fn manages_auto_scaling_groups() {
        let conn = connect().await;
        let ec2 = crate::ec2::client(&conn);
        let lt = match ec2
            .create_launch_template()
            .launch_template_name("s3x-asg-lt")
            .launch_template_data(RequestLaunchTemplateData::builder().image_id("ami-12345678").instance_type(InstanceType::T3Micro).build())
            .send()
            .await
        {
            Ok(o) => o.launch_template().unwrap().launch_template_id().unwrap().to_string(),
            Err(_) => ec2
                .describe_launch_templates()
                .launch_template_names("s3x-asg-lt")
                .send()
                .await
                .unwrap()
                .launch_templates()[0]
                .launch_template_id()
                .unwrap()
                .to_string(),
        };
        let c = client(&conn);
        let _ = c
            .create_auto_scaling_group()
            .auto_scaling_group_name("s3x-asg")
            .min_size(0)
            .max_size(2)
            .desired_capacity(0)
            .availability_zones("eu-west-2a")
            .launch_template(aws_sdk_autoscaling::types::LaunchTemplateSpecification::builder().launch_template_id(&lt).build())
            .send()
            .await;
        assert!(list_groups(&conn).await.unwrap().iter().any(|g| g.name == "s3x-asg"));
        let d = group_details(&conn, "s3x-asg").await.unwrap();
        assert_eq!(d.group.max, 2);

        set_capacity(&conn, "s3x-asg", 0, 3, 1).await.unwrap();
        assert_eq!(group_details(&conn, "s3x-asg").await.unwrap().group.max, 3);
        set_capacity(&conn, "s3x-asg", 0, 2, 0).await.unwrap();
        assert!(set_capacity(&conn, "s3x-asg", 2, 1, 1).await.is_err());

        // Processes and refreshes may be missing on an emulator; they must fail cleanly.
        if set_processes(&conn, "s3x-asg", &["AZRebalance".into()], true).await.is_ok() {
            let _ = set_processes(&conn, "s3x-asg", &["AZRebalance".into()], false).await;
        }
        if start_refresh(&conn, "s3x-asg", 90, None, true).await.is_ok() {
            let _ = cancel_refresh(&conn, "s3x-asg").await;
        }
        assert!(group_details(&conn, "s3x-missing").await.is_err());
    }
}
