//! RDS: DB instances and clusters (Aurora and Multi-AZ DB clusters).
//! DescribeDBInstances / DescribeDBClusters also return Neptune and DocumentDB
//! resources; those are left out (other engines, other tools).

use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use aws_sdk_rds::Client;
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

/// Engines this view handles (RDS and Aurora); Neptune / DocumentDB are skipped.
pub fn is_rds_engine(engine: &str) -> bool {
    !(engine.starts_with("neptune") || engine.starts_with("docdb"))
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NameStatus {
    pub name: String,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbInstance {
    pub id: String,
    pub arn: String,
    pub engine: String,
    pub engine_version: Option<String>,
    pub class: Option<String>,
    pub status: Option<String>,
    /// Member of this cluster (Aurora / Multi-AZ DB cluster).
    pub cluster_id: Option<String>,
    pub endpoint: Option<String>,
    pub port: Option<i32>,
    pub allocated_storage_gb: Option<i32>,
    pub max_allocated_storage_gb: Option<i32>,
    pub storage_type: Option<String>,
    pub iops: Option<i32>,
    pub multi_az: bool,
    pub availability_zone: Option<String>,
    pub secondary_az: Option<String>,
    pub publicly_accessible: bool,
    pub vpc_id: Option<String>,
    pub subnet_group: Option<String>,
    pub security_groups: Vec<NameStatus>,
    pub encrypted: bool,
    pub kms_key: Option<String>,
    pub iam_auth: bool,
    pub backup_retention_days: Option<i32>,
    pub backup_window: Option<String>,
    pub maintenance_window: Option<String>,
    pub deletion_protection: bool,
    pub parameter_groups: Vec<NameStatus>,
    pub option_groups: Vec<NameStatus>,
    pub master_username: Option<String>,
    /// Secrets Manager secret holding the master password, when RDS manages it.
    pub master_secret_arn: Option<String>,
    pub db_name: Option<String>,
    pub created: Option<String>,
    pub ca_certificate: Option<String>,
    pub performance_insights: bool,
    pub latest_restorable_time: Option<String>,
    /// Changes waiting for the next maintenance window ("class: db.t3.large").
    pub pending_changes: Vec<String>,
    pub read_replica_of: Option<String>,
    pub read_replicas: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClusterMember {
    pub id: String,
    pub writer: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbCluster {
    pub id: String,
    pub arn: String,
    pub engine: String,
    pub engine_version: Option<String>,
    /// "provisioned", "serverless" (v1), …
    pub engine_mode: Option<String>,
    pub status: Option<String>,
    pub endpoint: Option<String>,
    pub reader_endpoint: Option<String>,
    pub port: Option<i32>,
    pub members: Vec<ClusterMember>,
    pub multi_az: bool,
    pub encrypted: bool,
    pub kms_key: Option<String>,
    pub iam_auth: bool,
    /// RDS Data API enabled.
    pub data_api: bool,
    pub backup_retention_days: Option<i32>,
    pub backup_window: Option<String>,
    pub maintenance_window: Option<String>,
    pub deletion_protection: bool,
    pub parameter_group: Option<String>,
    pub subnet_group: Option<String>,
    pub security_groups: Vec<NameStatus>,
    pub master_username: Option<String>,
    pub master_secret_arn: Option<String>,
    pub database_name: Option<String>,
    /// Serverless v2 capacity range in ACUs.
    pub serverless_min_acu: Option<f64>,
    pub serverless_max_acu: Option<f64>,
    /// Multi-AZ DB clusters (non-Aurora) have a class and storage of their own.
    pub class: Option<String>,
    pub allocated_storage_gb: Option<i32>,
    pub storage_type: Option<String>,
    pub created: Option<String>,
    pub latest_restorable_time: Option<String>,
    pub pending_changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PendingAction {
    pub action: String,
    pub description: Option<String>,
    pub auto_applied_after: Option<String>,
    pub forced_apply: Option<String>,
    pub current_apply_date: Option<String>,
    pub opt_in_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RdsListing {
    pub clusters: Vec<DbCluster>,
    pub instances: Vec<DbInstance>,
}

fn sgs(v: &[aws_sdk_rds::types::VpcSecurityGroupMembership]) -> Vec<NameStatus> {
    v.iter()
        .map(|g| NameStatus {
            name: g.vpc_security_group_id().unwrap_or_default().to_string(),
            status: g.status().map(String::from),
        })
        .collect()
}

fn pending_instance(p: Option<&aws_sdk_rds::types::PendingModifiedValues>) -> Vec<String> {
    let Some(p) = p else { return Vec::new() };
    let mut out = Vec::new();
    if let Some(v) = p.db_instance_class() {
        out.push(format!("Instance class: {v}"));
    }
    if let Some(v) = p.allocated_storage() {
        out.push(format!("Storage: {v} GB"));
    }
    if let Some(v) = p.engine_version() {
        out.push(format!("Engine version: {v}"));
    }
    if let Some(v) = p.backup_retention_period() {
        out.push(format!("Backup retention: {v} days"));
    }
    if let Some(v) = p.multi_az() {
        out.push(format!("Multi-AZ: {}", if v { "on" } else { "off" }));
    }
    if let Some(v) = p.storage_type() {
        out.push(format!("Storage type: {v}"));
    }
    if let Some(v) = p.iops() {
        out.push(format!("IOPS: {v}"));
    }
    if let Some(v) = p.ca_certificate_identifier() {
        out.push(format!("CA certificate: {v}"));
    }
    if p.master_user_password().is_some() {
        out.push("Master password change".into());
    }
    out
}

pub fn to_instance(d: &aws_sdk_rds::types::DbInstance) -> DbInstance {
    DbInstance {
        id: d.db_instance_identifier().unwrap_or_default().to_string(),
        arn: d.db_instance_arn().unwrap_or_default().to_string(),
        engine: d.engine().unwrap_or_default().to_string(),
        engine_version: d.engine_version().map(String::from),
        class: d.db_instance_class().map(String::from),
        status: d.db_instance_status().map(String::from),
        cluster_id: d.db_cluster_identifier().map(String::from),
        endpoint: d.endpoint().and_then(|e| e.address()).map(String::from),
        port: d.endpoint().and_then(|e| e.port()),
        allocated_storage_gb: d.allocated_storage(),
        max_allocated_storage_gb: d.max_allocated_storage(),
        storage_type: d.storage_type().map(String::from),
        iops: d.iops(),
        multi_az: d.multi_az().unwrap_or(false),
        availability_zone: d.availability_zone().map(String::from),
        secondary_az: d.secondary_availability_zone().map(String::from),
        publicly_accessible: d.publicly_accessible().unwrap_or(false),
        vpc_id: d
            .db_subnet_group()
            .and_then(|g| g.vpc_id())
            .map(String::from),
        subnet_group: d
            .db_subnet_group()
            .and_then(|g| g.db_subnet_group_name())
            .map(String::from),
        security_groups: sgs(d.vpc_security_groups()),
        encrypted: d.storage_encrypted().unwrap_or(false),
        kms_key: d.kms_key_id().map(String::from),
        iam_auth: d.iam_database_authentication_enabled().unwrap_or(false),
        backup_retention_days: d.backup_retention_period(),
        backup_window: d.preferred_backup_window().map(String::from),
        maintenance_window: d.preferred_maintenance_window().map(String::from),
        deletion_protection: d.deletion_protection().unwrap_or(false),
        parameter_groups: d
            .db_parameter_groups()
            .iter()
            .map(|g| NameStatus {
                name: g.db_parameter_group_name().unwrap_or_default().to_string(),
                status: g.parameter_apply_status().map(String::from),
            })
            .collect(),
        option_groups: d
            .option_group_memberships()
            .iter()
            .map(|g| NameStatus {
                name: g.option_group_name().unwrap_or_default().to_string(),
                status: g.status().map(String::from),
            })
            .collect(),
        master_username: d.master_username().map(String::from),
        master_secret_arn: d
            .master_user_secret()
            .and_then(|s| s.secret_arn())
            .map(String::from),
        db_name: d.db_name().map(String::from),
        created: iso(d.instance_create_time()),
        ca_certificate: d.ca_certificate_identifier().map(String::from),
        performance_insights: d.performance_insights_enabled().unwrap_or(false),
        latest_restorable_time: iso(d.latest_restorable_time()),
        pending_changes: pending_instance(d.pending_modified_values()),
        read_replica_of: d
            .read_replica_source_db_instance_identifier()
            .map(String::from),
        read_replicas: d.read_replica_db_instance_identifiers().to_vec(),
    }
}

pub fn to_cluster(c: &aws_sdk_rds::types::DbCluster) -> DbCluster {
    let mut pending = Vec::new();
    if let Some(p) = c.pending_modified_values() {
        if let Some(v) = p.engine_version() {
            pending.push(format!("Engine version: {v}"));
        }
        if let Some(v) = p.backup_retention_period() {
            pending.push(format!("Backup retention: {v} days"));
        }
        if let Some(v) = p.db_cluster_identifier() {
            pending.push(format!("Identifier: {v}"));
        }
        if p.master_user_password().is_some() {
            pending.push("Master password change".into());
        }
    }
    DbCluster {
        id: c.db_cluster_identifier().unwrap_or_default().to_string(),
        arn: c.db_cluster_arn().unwrap_or_default().to_string(),
        engine: c.engine().unwrap_or_default().to_string(),
        engine_version: c.engine_version().map(String::from),
        engine_mode: c.engine_mode().map(String::from),
        status: c.status().map(String::from),
        endpoint: c.endpoint().map(String::from),
        reader_endpoint: c.reader_endpoint().map(String::from),
        port: c.port(),
        members: c
            .db_cluster_members()
            .iter()
            .map(|m| ClusterMember {
                id: m.db_instance_identifier().unwrap_or_default().to_string(),
                writer: m.is_cluster_writer().unwrap_or(false),
            })
            .collect(),
        multi_az: c.multi_az().unwrap_or(false),
        encrypted: c.storage_encrypted().unwrap_or(false),
        kms_key: c.kms_key_id().map(String::from),
        iam_auth: c.iam_database_authentication_enabled().unwrap_or(false),
        data_api: c.http_endpoint_enabled().unwrap_or(false),
        backup_retention_days: c.backup_retention_period(),
        backup_window: c.preferred_backup_window().map(String::from),
        maintenance_window: c.preferred_maintenance_window().map(String::from),
        deletion_protection: c.deletion_protection().unwrap_or(false),
        parameter_group: c.db_cluster_parameter_group().map(String::from),
        subnet_group: c.db_subnet_group().map(String::from),
        security_groups: sgs(c.vpc_security_groups()),
        master_username: c.master_username().map(String::from),
        master_secret_arn: c
            .master_user_secret()
            .and_then(|s| s.secret_arn())
            .map(String::from),
        database_name: c.database_name().map(String::from),
        serverless_min_acu: c
            .serverless_v2_scaling_configuration()
            .and_then(|s| s.min_capacity()),
        serverless_max_acu: c
            .serverless_v2_scaling_configuration()
            .and_then(|s| s.max_capacity()),
        class: c.db_cluster_instance_class().map(String::from),
        allocated_storage_gb: c.allocated_storage(),
        storage_type: c.storage_type().map(String::from),
        created: iso(c.cluster_create_time()),
        latest_restorable_time: iso(c.latest_restorable_time()),
        pending_changes: pending,
    }
}

pub async fn list_instances(conn: &Connection) -> Result<Vec<DbInstance>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut marker: Option<String> = None;
    loop {
        let page = c
            .describe_db_instances()
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(
            page.db_instances()
                .iter()
                .filter(|d| is_rds_engine(d.engine().unwrap_or_default()))
                .map(to_instance),
        );
        match page.marker() {
            Some(m) if Some(m) != marker.as_deref() && !m.is_empty() => {
                marker = Some(m.to_string())
            }
            _ => break,
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

pub async fn list_clusters(conn: &Connection) -> Result<Vec<DbCluster>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut marker: Option<String> = None;
    loop {
        let page = c
            .describe_db_clusters()
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(
            page.db_clusters()
                .iter()
                .filter(|d| is_rds_engine(d.engine().unwrap_or_default()))
                .map(to_cluster),
        );
        match page.marker() {
            Some(m) if Some(m) != marker.as_deref() && !m.is_empty() => {
                marker = Some(m.to_string())
            }
            _ => break,
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Everything for the tree and list. (One after the other: `tokio::join!`
/// needs tokio's `macros` feature, which only the tests enable.)
pub async fn list_all(conn: &Connection) -> Result<RdsListing, AppError> {
    Ok(RdsListing {
        clusters: list_clusters(conn).await?,
        instances: list_instances(conn).await?,
    })
}

pub async fn describe_instance(conn: &Connection, id: &str) -> Result<DbInstance, AppError> {
    let out = client(conn)
        .describe_db_instances()
        .db_instance_identifier(id)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    out.db_instances()
        .first()
        .map(to_instance)
        .ok_or_else(|| other(format!("No DB instance named {id}")))
}

pub async fn describe_cluster(conn: &Connection, id: &str) -> Result<DbCluster, AppError> {
    let out = client(conn)
        .describe_db_clusters()
        .db_cluster_identifier(id)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    out.db_clusters()
        .first()
        .map(to_cluster)
        .ok_or_else(|| other(format!("No DB cluster named {id}")))
}

/// Pending maintenance actions for one resource (empty when the endpoint
/// doesn't support the call, e.g. some emulators).
pub async fn pending_maintenance(
    conn: &Connection,
    arn: &str,
) -> Result<Vec<PendingAction>, AppError> {
    let res = client(conn)
        .describe_pending_maintenance_actions()
        .resource_identifier(arn)
        .send()
        .await;
    let out = match res {
        Ok(o) => o,
        Err(e) => {
            let e = err(conn, e);
            if e.kind == ErrorKind::Other {
                return Ok(Vec::new());
            }
            return Err(e);
        }
    };
    Ok(out
        .pending_maintenance_actions()
        .iter()
        .flat_map(|r| r.pending_maintenance_action_details())
        .map(|a| PendingAction {
            action: a.action().unwrap_or_default().to_string(),
            description: a.description().map(String::from),
            auto_applied_after: iso(a.auto_applied_after_date()),
            forced_apply: iso(a.forced_apply_date()),
            current_apply_date: iso(a.current_apply_date()),
            opt_in_status: a.opt_in_status().map(String::from),
        })
        .collect())
}

pub async fn list_tags(conn: &Connection, arn: &str) -> Result<Vec<(String, String)>, AppError> {
    let out = client(conn)
        .list_tags_for_resource()
        .resource_name(arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let mut tags: Vec<(String, String)> = out
        .tag_list()
        .iter()
        .map(|t| {
            (
                t.key().unwrap_or_default().to_string(),
                t.value().unwrap_or_default().to_string(),
            )
        })
        .collect();
    tags.sort();
    Ok(tags)
}

// ---------------------------------------------------------------------------
// Actions

/// RDS identifiers (instances, clusters, snapshots): 1–63 (snapshots 255)
/// letters, digits and hyphens; starts with a letter; no "--"; no trailing "-".
pub fn identifier_problem(id: &str, what: &str, max: usize) -> Option<String> {
    if id.is_empty() || id.len() > max {
        return Some(format!("{what} names are 1 to {max} characters"));
    }
    if !id.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return Some(format!("{what} names start with a letter"));
    }
    if id.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '-')) {
        return Some("Use letters, digits and hyphens only".into());
    }
    if id.contains("--") || id.ends_with('-') {
        return Some("No two hyphens in a row, and no hyphen at the end".into());
    }
    None
}

pub async fn start(conn: &Connection, kind: &str, id: &str) -> Result<(), AppError> {
    let c = client(conn);
    match kind {
        "cluster" => c
            .start_db_cluster()
            .db_cluster_identifier(id)
            .send()
            .await
            .map(|_| ())
            .map_err(|e| err(conn, e)),
        _ => c
            .start_db_instance()
            .db_instance_identifier(id)
            .send()
            .await
            .map(|_| ())
            .map_err(|e| err(conn, e)),
    }
}

pub async fn stop(conn: &Connection, kind: &str, id: &str) -> Result<(), AppError> {
    let c = client(conn);
    match kind {
        "cluster" => c
            .stop_db_cluster()
            .db_cluster_identifier(id)
            .send()
            .await
            .map(|_| ())
            .map_err(|e| err(conn, e)),
        _ => c
            .stop_db_instance()
            .db_instance_identifier(id)
            .send()
            .await
            .map(|_| ())
            .map_err(|e| err(conn, e)),
    }
}

/// Reboots an instance (optionally failing over to the standby, Multi-AZ only),
/// or a Multi-AZ DB cluster.
pub async fn reboot(
    conn: &Connection,
    kind: &str,
    id: &str,
    force_failover: bool,
) -> Result<(), AppError> {
    let c = client(conn);
    match kind {
        "cluster" => c
            .reboot_db_cluster()
            .db_cluster_identifier(id)
            .send()
            .await
            .map(|_| ())
            .map_err(|e| err(conn, e)),
        _ => c
            .reboot_db_instance()
            .db_instance_identifier(id)
            .set_force_failover(force_failover.then_some(true))
            .send()
            .await
            .map(|_| ())
            .map_err(|e| err(conn, e)),
    }
}

/// Promotes a reader of an Aurora cluster (a chosen one, or any) to writer.
pub async fn failover(
    conn: &Connection,
    cluster_id: &str,
    target: Option<&str>,
) -> Result<(), AppError> {
    client(conn)
        .failover_db_cluster()
        .db_cluster_identifier(cluster_id)
        .set_target_db_instance_identifier(target.filter(|t| !t.is_empty()).map(String::from))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

#[derive(Debug, Clone, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModifyRequest {
    /// Instances only.
    pub class: Option<String>,
    pub backup_retention_days: Option<i32>,
    pub deletion_protection: Option<bool>,
    /// false = at the next maintenance window.
    pub apply_immediately: bool,
}

pub fn modify_problem(kind: &str, m: &ModifyRequest) -> Option<String> {
    if let Some(cls) = &m.class {
        if kind == "cluster" {
            return Some("Change the class on each instance of the cluster".into());
        }
        if !cls.starts_with("db.") || cls.len() < 6 || cls.contains(char::is_whitespace) {
            return Some("Instance classes look like db.t3.medium".into());
        }
    }
    if let Some(d) = m.backup_retention_days {
        let min = if kind == "cluster" { 1 } else { 0 };
        if !(min..=35).contains(&d) {
            return Some(format!("Backup retention is {min} to 35 days"));
        }
    }
    if m.class.is_none() && m.backup_retention_days.is_none() && m.deletion_protection.is_none() {
        return Some("Nothing to change".into());
    }
    None
}

pub async fn modify(
    conn: &Connection,
    kind: &str,
    id: &str,
    m: &ModifyRequest,
) -> Result<(), AppError> {
    if let Some(p) = modify_problem(kind, m) {
        return Err(other(p));
    }
    let c = client(conn);
    if kind == "cluster" {
        c.modify_db_cluster()
            .db_cluster_identifier(id)
            .set_backup_retention_period(m.backup_retention_days)
            .set_deletion_protection(m.deletion_protection)
            .apply_immediately(m.apply_immediately)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    } else {
        c.modify_db_instance()
            .db_instance_identifier(id)
            .set_db_instance_class(m.class.clone())
            .set_backup_retention_period(m.backup_retention_days)
            .set_deletion_protection(m.deletion_protection)
            .apply_immediately(m.apply_immediately)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DeleteRequest {
    /// None = no final snapshot.
    pub final_snapshot_id: Option<String>,
    /// Instances only: also delete the automated backups (default keeps them).
    pub delete_automated_backups: bool,
}

pub async fn delete(
    conn: &Connection,
    kind: &str,
    id: &str,
    d: &DeleteRequest,
) -> Result<(), AppError> {
    let snap = d
        .final_snapshot_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(s) = snap {
        if let Some(p) = identifier_problem(s, "Snapshot", 255) {
            return Err(other(p));
        }
    }
    let c = client(conn);
    if kind == "cluster" {
        c.delete_db_cluster()
            .db_cluster_identifier(id)
            .skip_final_snapshot(snap.is_none())
            .set_final_db_snapshot_identifier(snap.map(String::from))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    } else {
        // Aurora members can't take a final snapshot of their own (the cluster's backups cover them).
        let member = describe_instance(conn, id)
            .await
            .map(|i| i.cluster_id.is_some())
            .unwrap_or(false);
        let mut req = c
            .delete_db_instance()
            .db_instance_identifier(id)
            .delete_automated_backups(d.delete_automated_backups);
        if !member {
            req = req
                .skip_final_snapshot(snap.is_none())
                .set_final_db_snapshot_identifier(snap.map(String::from));
        }
        req.send().await.map_err(|e| err(conn, e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engines() {
        assert!(is_rds_engine("aurora-postgresql"));
        assert!(!is_rds_engine("neptune"));
        assert!(!is_rds_engine("docdb"));
        assert_eq!(identifier_problem("orders-db-1", "Instance", 63), None);
        assert!(identifier_problem("1abc", "Instance", 63).is_some());
        assert!(identifier_problem("a--b", "Instance", 63).is_some());
        assert!(identifier_problem("ab-", "Instance", 63).is_some());
        assert!(identifier_problem("a_b", "Instance", 63).is_some());
        assert!(identifier_problem(&"a".repeat(64), "Instance", 63).is_some());
        let m = |class: Option<&str>, days: Option<i32>| ModifyRequest {
            class: class.map(String::from),
            backup_retention_days: days,
            ..Default::default()
        };
        assert_eq!(
            modify_problem("instance", &m(Some("db.t3.medium"), None)),
            None
        );
        assert!(modify_problem("instance", &m(Some("t3.medium"), None)).is_some());
        assert!(modify_problem("cluster", &m(Some("db.r6g.large"), None)).is_some());
        assert_eq!(modify_problem("instance", &m(None, Some(0))), None);
        assert!(modify_problem("cluster", &m(None, Some(0))).is_some());
        assert!(modify_problem("instance", &m(None, Some(36))).is_some());
        assert!(modify_problem("instance", &m(None, None)).is_some());
    }
}

#[cfg(test)]
pub(crate) mod emulator_tests {
    use super::*;

    pub async fn connect() -> Connection {
        crate::sqs::emulator_tests::connect().await
    }

    /// Creates (if missing) an Aurora PostgreSQL cluster with one writer, and a
    /// standalone PostgreSQL instance.
    pub async fn fixtures(conn: &Connection) {
        let c = client(conn);
        let _ = c
            .create_db_cluster()
            .db_cluster_identifier("s3x-aurora")
            .engine("aurora-postgresql")
            .engine_version("16.1")
            .master_username("admin_user")
            .master_user_password("secret-password-1")
            .database_name("app")
            .enable_http_endpoint(true)
            .send()
            .await;
        let _ = c
            .create_db_instance()
            .db_instance_identifier("s3x-aurora-1")
            .db_cluster_identifier("s3x-aurora")
            .engine("aurora-postgresql")
            .db_instance_class("db.r6g.large")
            .send()
            .await;
        let _ = c
            .create_db_instance()
            .db_instance_identifier("s3x-pg")
            .engine("postgres")
            .engine_version("16.3")
            .db_instance_class("db.t3.micro")
            .allocated_storage(20)
            .master_username("pgadmin")
            .master_user_password("secret-password-2")
            .db_name("shop")
            .backup_retention_period(7)
            .send()
            .await;
    }

    #[tokio::test]
    #[ignore]
    async fn lists_clusters_and_instances() {
        let conn = connect().await;
        fixtures(&conn).await;
        let all = list_all(&conn).await.unwrap();
        let cl = all
            .clusters
            .iter()
            .find(|c| c.id == "s3x-aurora")
            .expect("cluster listed");
        assert_eq!(cl.engine, "aurora-postgresql");
        assert!(cl.members.iter().any(|m| m.id == "s3x-aurora-1"));
        let pg = all
            .instances
            .iter()
            .find(|i| i.id == "s3x-pg")
            .expect("instance listed");
        assert_eq!(pg.allocated_storage_gb, Some(20));
        assert_eq!(pg.db_name.as_deref(), Some("shop"));
        assert!(pg.endpoint.is_some());
        let member = all
            .instances
            .iter()
            .find(|i| i.id == "s3x-aurora-1")
            .unwrap();
        assert_eq!(member.cluster_id.as_deref(), Some("s3x-aurora"));
        assert_eq!(
            describe_instance(&conn, "s3x-pg").await.unwrap().id,
            "s3x-pg"
        );
        assert_eq!(
            describe_cluster(&conn, "s3x-aurora").await.unwrap().id,
            "s3x-aurora"
        );
        assert!(describe_instance(&conn, "nope-nope").await.is_err());
        let _ = pending_maintenance(&conn, &pg.arn).await.unwrap();
        let _ = list_tags(&conn, &pg.arn).await.unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn acts_on_instances_and_clusters() {
        let conn = connect().await;
        fixtures(&conn).await;
        let c = client(&conn);
        let _ = c
            .create_db_instance()
            .db_instance_identifier("s3x-act")
            .engine("mysql")
            .db_instance_class("db.t3.micro")
            .allocated_storage(20)
            .master_username("u")
            .master_user_password("password-123")
            .send()
            .await;
        stop(&conn, "instance", "s3x-act").await.unwrap();
        assert_eq!(
            describe_instance(&conn, "s3x-act")
                .await
                .unwrap()
                .status
                .as_deref(),
            Some("stopped")
        );
        start(&conn, "instance", "s3x-act").await.unwrap();
        assert_eq!(
            describe_instance(&conn, "s3x-act")
                .await
                .unwrap()
                .status
                .as_deref(),
            Some("available")
        );
        reboot(&conn, "instance", "s3x-act", false).await.unwrap();
        let m = ModifyRequest {
            class: Some("db.t3.small".into()),
            backup_retention_days: Some(3),
            deletion_protection: Some(true),
            apply_immediately: true,
        };
        modify(&conn, "instance", "s3x-act", &m).await.unwrap();
        let i = describe_instance(&conn, "s3x-act").await.unwrap();
        assert!(i.deletion_protection);
        assert_eq!(i.backup_retention_days, Some(3));
        // Deletion protection blocks the delete until it's turned off.
        assert!(
            delete(&conn, "instance", "s3x-act", &DeleteRequest::default())
                .await
                .is_err()
        );
        let off = ModifyRequest {
            deletion_protection: Some(false),
            apply_immediately: true,
            ..Default::default()
        };
        modify(&conn, "instance", "s3x-act", &off).await.unwrap();
        assert!(delete(
            &conn,
            "instance",
            "s3x-act",
            &DeleteRequest {
                final_snapshot_id: Some("bad--name".into()),
                ..Default::default()
            }
        )
        .await
        .is_err());
        delete(
            &conn,
            "instance",
            "s3x-act",
            &DeleteRequest {
                final_snapshot_id: Some("s3x-act-final".into()),
                delete_automated_backups: true,
            },
        )
        .await
        .unwrap();
        assert!(!list_instances(&conn)
            .await
            .unwrap()
            .iter()
            .any(|i| i.id == "s3x-act" && i.status.as_deref() == Some("available")));

        let cm = ModifyRequest {
            backup_retention_days: Some(5),
            apply_immediately: true,
            ..Default::default()
        };
        modify(&conn, "cluster", "s3x-aurora", &cm).await.unwrap();
        assert_eq!(
            describe_cluster(&conn, "s3x-aurora")
                .await
                .unwrap()
                .backup_retention_days,
            Some(5)
        );
        stop(&conn, "cluster", "s3x-aurora").await.unwrap();
        start(&conn, "cluster", "s3x-aurora").await.unwrap();
        let _ = c
            .delete_db_snapshot()
            .db_snapshot_identifier("s3x-act-final")
            .send()
            .await;
    }
}
