//! RDS snapshots (instance and cluster): list, create, copy, delete, restore
//! from a snapshot, restore to a point in time.

use crate::error::AppError;
use crate::rds::{self, client, err, identifier_problem, iso, other};
use crate::s3::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    pub arn: String,
    /// "instance" or "cluster".
    pub kind: String,
    pub db_id: String,
    /// manual, automated, shared, public, awsbackup.
    pub snapshot_type: Option<String>,
    pub status: Option<String>,
    pub engine: String,
    pub engine_version: Option<String>,
    pub created: Option<String>,
    pub size_gb: Option<i32>,
    pub encrypted: bool,
    pub kms_key: Option<String>,
    pub percent_progress: Option<i32>,
    pub vpc_id: Option<String>,
    pub port: Option<i32>,
}

fn from_instance(s: &aws_sdk_rds::types::DbSnapshot) -> SnapshotInfo {
    SnapshotInfo {
        id: s.db_snapshot_identifier().unwrap_or_default().to_string(),
        arn: s.db_snapshot_arn().unwrap_or_default().to_string(),
        kind: "instance".into(),
        db_id: s.db_instance_identifier().unwrap_or_default().to_string(),
        snapshot_type: s.snapshot_type().map(String::from),
        status: s.status().map(String::from),
        engine: s.engine().unwrap_or_default().to_string(),
        engine_version: s.engine_version().map(String::from),
        created: iso(s.snapshot_create_time()),
        size_gb: s.allocated_storage(),
        encrypted: s.encrypted().unwrap_or(false),
        kms_key: s.kms_key_id().map(String::from),
        percent_progress: s.percent_progress(),
        vpc_id: s.vpc_id().map(String::from),
        port: s.port(),
    }
}

fn from_cluster(s: &aws_sdk_rds::types::DbClusterSnapshot) -> SnapshotInfo {
    SnapshotInfo {
        id: s
            .db_cluster_snapshot_identifier()
            .unwrap_or_default()
            .to_string(),
        arn: s.db_cluster_snapshot_arn().unwrap_or_default().to_string(),
        kind: "cluster".into(),
        db_id: s.db_cluster_identifier().unwrap_or_default().to_string(),
        snapshot_type: s.snapshot_type().map(String::from),
        status: s.status().map(String::from),
        engine: s.engine().unwrap_or_default().to_string(),
        engine_version: s.engine_version().map(String::from),
        created: iso(s.snapshot_create_time()),
        size_gb: s.allocated_storage(),
        encrypted: s.storage_encrypted().unwrap_or(false),
        kms_key: s.kms_key_id().map(String::from),
        percent_progress: s.percent_progress(),
        vpc_id: s.vpc_id().map(String::from),
        port: s.port(),
    }
}

/// Snapshots of one database, or (db_id None) every instance and cluster
/// snapshot in the region, newest first.
pub async fn list(
    conn: &Connection,
    kind: Option<&str>,
    db_id: Option<&str>,
) -> Result<Vec<SnapshotInfo>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    if kind != Some("cluster") {
        let mut marker: Option<String> = None;
        loop {
            let page = c
                .describe_db_snapshots()
                .set_db_instance_identifier(db_id.map(String::from))
                .set_marker(marker.clone())
                .send()
                .await
                .map_err(|e| err(conn, e))?;
            out.extend(
                page.db_snapshots()
                    .iter()
                    .filter(|s| rds::is_rds_engine(s.engine().unwrap_or_default()))
                    .map(from_instance),
            );
            match page.marker() {
                Some(m) if Some(m) != marker.as_deref() && !m.is_empty() => {
                    marker = Some(m.to_string())
                }
                _ => break,
            }
        }
    }
    if kind != Some("instance") {
        let mut marker: Option<String> = None;
        loop {
            let page = c
                .describe_db_cluster_snapshots()
                .set_db_cluster_identifier(db_id.map(String::from))
                .set_marker(marker.clone())
                .send()
                .await
                .map_err(|e| err(conn, e))?;
            out.extend(
                page.db_cluster_snapshots()
                    .iter()
                    .filter(|s| rds::is_rds_engine(s.engine().unwrap_or_default()))
                    .map(from_cluster),
            );
            match page.marker() {
                Some(m) if Some(m) != marker.as_deref() && !m.is_empty() => {
                    marker = Some(m.to_string())
                }
                _ => break,
            }
        }
    }
    out.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

pub async fn create(
    conn: &Connection,
    kind: &str,
    db_id: &str,
    snapshot_id: &str,
) -> Result<(), AppError> {
    if let Some(p) = identifier_problem(snapshot_id, "Snapshot", 255) {
        return Err(other(p));
    }
    let c = client(conn);
    if kind == "cluster" {
        c.create_db_cluster_snapshot()
            .db_cluster_identifier(db_id)
            .db_cluster_snapshot_identifier(snapshot_id)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    } else {
        c.create_db_snapshot()
            .db_instance_identifier(db_id)
            .db_snapshot_identifier(snapshot_id)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    Ok(())
}

/// Copies a snapshot (automated ones become manual copies that you keep).
pub async fn copy(
    conn: &Connection,
    kind: &str,
    source: &str,
    target: &str,
) -> Result<(), AppError> {
    if let Some(p) = identifier_problem(target, "Snapshot", 255) {
        return Err(other(p));
    }
    let c = client(conn);
    if kind == "cluster" {
        c.copy_db_cluster_snapshot()
            .source_db_cluster_snapshot_identifier(source)
            .target_db_cluster_snapshot_identifier(target)
            .copy_tags(true)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    } else {
        c.copy_db_snapshot()
            .source_db_snapshot_identifier(source)
            .target_db_snapshot_identifier(target)
            .copy_tags(true)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    Ok(())
}

pub async fn delete(conn: &Connection, kind: &str, snapshot_id: &str) -> Result<(), AppError> {
    let c = client(conn);
    if kind == "cluster" {
        c.delete_db_cluster_snapshot()
            .db_cluster_snapshot_identifier(snapshot_id)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    } else {
        c.delete_db_snapshot()
            .db_snapshot_identifier(snapshot_id)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RestoreRequest {
    /// Snapshot id / ARN, for a restore from a snapshot.
    pub snapshot_id: Option<String>,
    /// Source database, for a point-in-time restore (and to copy network settings from).
    pub source_db_id: Option<String>,
    /// ISO time; None with a source database = latest restorable time.
    pub restore_time: Option<String>,
    pub new_id: String,
    /// Instance class (for clusters: the class of the instance created in the
    /// restored cluster; "db.serverless" for Serverless v2).
    pub class: Option<String>,
    pub serverless_min_acu: Option<f64>,
    pub serverless_max_acu: Option<f64>,
}

/// Network settings of a database that still exists (copied into restores).
struct Network {
    subnet_group: Option<String>,
    security_groups: Vec<String>,
    public: Option<bool>,
    engine: Option<String>,
}

async fn network_of(conn: &Connection, kind: &str, id: &str) -> Option<Network> {
    if kind == "cluster" {
        let c = rds::describe_cluster(conn, id).await.ok()?;
        Some(Network {
            subnet_group: c.subnet_group,
            security_groups: c.security_groups.into_iter().map(|g| g.name).collect(),
            public: None,
            engine: Some(c.engine),
        })
    } else {
        let i = rds::describe_instance(conn, id).await.ok()?;
        Some(Network {
            subnet_group: i.subnet_group,
            security_groups: i.security_groups.into_iter().map(|g| g.name).collect(),
            public: Some(i.publicly_accessible),
            engine: Some(i.engine),
        })
    }
}

fn parse_time(t: &str) -> Result<aws_smithy_types::DateTime, AppError> {
    aws_smithy_types::DateTime::from_str(t, aws_smithy_types::date_time::Format::DateTime)
        .map_err(|_| other(format!("Not a valid time: {t}")))
}

pub fn restore_problem(kind: &str, r: &RestoreRequest) -> Option<String> {
    if let Some(p) = identifier_problem(
        r.new_id.trim(),
        if kind == "cluster" {
            "Cluster"
        } else {
            "Instance"
        },
        63,
    ) {
        return Some(p);
    }
    if r.snapshot_id.is_none() && r.source_db_id.is_none() {
        return Some("Choose a snapshot or a source database".into());
    }
    if let Some(c) = &r.class {
        if !c.starts_with("db.") {
            return Some("Instance classes look like db.t3.medium (or db.serverless)".into());
        }
    }
    if kind == "cluster" && r.class.is_none() {
        return Some("Choose a class for the cluster's instance".into());
    }
    if r.class.as_deref() == Some("db.serverless") {
        match (r.serverless_min_acu, r.serverless_max_acu) {
            (Some(min), Some(max)) if (0.0..=256.0).contains(&min) && (1.0..=256.0).contains(&max) && min <= max => {}
            _ => return Some("Serverless capacity: minimum 0 to 256 ACU, maximum 1 to 256 and not below the minimum".into()),
        }
    }
    None
}

/// Restores into a new database; returns its identifier. For clusters, also
/// creates one instance in the restored cluster (a restored cluster has none).
pub async fn restore(
    conn: &Connection,
    kind: &str,
    r: &RestoreRequest,
) -> Result<String, AppError> {
    if let Some(p) = restore_problem(kind, r) {
        return Err(other(p));
    }
    let new_id = r.new_id.trim().to_string();
    let c = client(conn);
    // Copy the source's network so the restore lands where the original lived.
    let source = match (&r.source_db_id, &r.snapshot_id) {
        (Some(s), _) => Some(s.clone()),
        (None, Some(snap)) => list(conn, Some(kind), None)
            .await
            .ok()
            .and_then(|all| all.into_iter().find(|s| &s.id == snap || &s.arn == snap))
            .map(|s| s.db_id),
        _ => None,
    };
    let net = match &source {
        Some(s) => network_of(conn, kind, s).await,
        None => None,
    };
    let sgs = net
        .as_ref()
        .map(|n| n.security_groups.clone())
        .filter(|v| !v.is_empty());
    let subnet = net.as_ref().and_then(|n| n.subnet_group.clone());

    if kind == "cluster" {
        let serverless = (r.class.as_deref() == Some("db.serverless")).then(|| {
            aws_sdk_rds::types::ServerlessV2ScalingConfiguration::builder()
                .set_min_capacity(r.serverless_min_acu)
                .set_max_capacity(r.serverless_max_acu)
                .build()
        });
        let engine = if let Some(snap) = &r.snapshot_id {
            let snaps = list(conn, Some("cluster"), None).await?;
            let s = snaps
                .iter()
                .find(|s| &s.id == snap || &s.arn == snap)
                .ok_or_else(|| other(format!("Snapshot {snap} wasn't found")))?;
            c.restore_db_cluster_from_snapshot()
                .db_cluster_identifier(&new_id)
                .snapshot_identifier(snap)
                .engine(&s.engine)
                .set_db_subnet_group_name(subnet)
                .set_vpc_security_group_ids(sgs)
                .set_serverless_v2_scaling_configuration(serverless)
                .send()
                .await
                .map_err(|e| err(conn, e))?;
            s.engine.clone()
        } else {
            let src = r.source_db_id.clone().unwrap_or_default();
            let mut req = c
                .restore_db_cluster_to_point_in_time()
                .db_cluster_identifier(&new_id)
                .source_db_cluster_identifier(&src)
                .restore_type("full-copy")
                .set_db_subnet_group_name(subnet)
                .set_vpc_security_group_ids(sgs)
                .set_serverless_v2_scaling_configuration(serverless);
            req = match &r.restore_time {
                Some(t) => req.restore_to_time(parse_time(t)?),
                None => req.use_latest_restorable_time(true),
            };
            req.send().await.map_err(|e| err(conn, e))?;
            net.as_ref()
                .and_then(|n| n.engine.clone())
                .unwrap_or_default()
        };
        c.create_db_instance()
            .db_instance_identifier(format!("{new_id}-1"))
            .db_cluster_identifier(&new_id)
            .engine(engine)
            .db_instance_class(r.class.clone().unwrap_or_default())
            .send()
            .await
            .map_err(|e| other(format!("The cluster {new_id} is being restored, but its instance couldn't be created: {}", err(conn, e).message)))?;
    } else if let Some(snap) = &r.snapshot_id {
        c.restore_db_instance_from_db_snapshot()
            .db_instance_identifier(&new_id)
            .db_snapshot_identifier(snap)
            .set_db_instance_class(r.class.clone())
            .set_db_subnet_group_name(subnet)
            .set_vpc_security_group_ids(sgs)
            .set_publicly_accessible(net.as_ref().and_then(|n| n.public))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    } else {
        let mut req = c
            .restore_db_instance_to_point_in_time()
            .target_db_instance_identifier(&new_id)
            .source_db_instance_identifier(r.source_db_id.clone().unwrap_or_default())
            .set_db_instance_class(r.class.clone())
            .set_db_subnet_group_name(subnet)
            .set_vpc_security_group_ids(sgs)
            .set_publicly_accessible(net.as_ref().and_then(|n| n.public));
        req = match &r.restore_time {
            Some(t) => req.restore_time(parse_time(t)?),
            None => req.use_latest_restorable_time(true),
        };
        req.send().await.map_err(|e| err(conn, e))?;
    }
    Ok(new_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_checks() {
        let r = |id: &str, snap: Option<&str>, class: Option<&str>| RestoreRequest {
            new_id: id.into(),
            snapshot_id: snap.map(String::from),
            class: class.map(String::from),
            ..Default::default()
        };
        assert_eq!(
            restore_problem("instance", &r("copy-1", Some("s"), None)),
            None
        );
        assert!(restore_problem("instance", &r("1copy", Some("s"), None)).is_some());
        assert!(restore_problem("instance", &r("copy", None, None)).is_some());
        assert!(restore_problem("cluster", &r("copy", Some("s"), None)).is_some());
        assert_eq!(
            restore_problem("cluster", &r("copy", Some("s"), Some("db.r6g.large"))),
            None
        );
        let mut sl = r("copy", Some("s"), Some("db.serverless"));
        assert!(restore_problem("cluster", &sl).is_some());
        sl.serverless_min_acu = Some(0.5);
        sl.serverless_max_acu = Some(8.0);
        assert_eq!(restore_problem("cluster", &sl), None);
        assert!(parse_time("2026-10-29T10:00:00Z").is_ok());
        assert!(parse_time("yesterday").is_err());
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::rds::emulator_tests::{connect, fixtures};

    #[tokio::test]
    #[ignore]
    async fn snapshots_round_trip() {
        let conn = connect().await;
        fixtures(&conn).await;
        let c = client(&conn);
        for id in ["s3x-snap-1", "s3x-snap-copy", "s3x-csnap"] {
            let _ = c
                .delete_db_snapshot()
                .db_snapshot_identifier(id)
                .send()
                .await;
            let _ = c
                .delete_db_cluster_snapshot()
                .db_cluster_snapshot_identifier(id)
                .send()
                .await;
        }
        for id in ["s3x-pg-restored", "s3x-pg-pitr"] {
            let _ = c
                .delete_db_instance()
                .db_instance_identifier(id)
                .skip_final_snapshot(true)
                .send()
                .await;
        }
        assert!(create(&conn, "instance", "s3x-pg", "bad--id")
            .await
            .is_err());
        create(&conn, "instance", "s3x-pg", "s3x-snap-1")
            .await
            .unwrap();
        copy(&conn, "instance", "s3x-snap-1", "s3x-snap-copy")
            .await
            .unwrap();
        let mine = list(&conn, Some("instance"), Some("s3x-pg")).await.unwrap();
        assert!(mine
            .iter()
            .any(|s| s.id == "s3x-snap-1" && s.db_id == "s3x-pg"));
        assert!(mine.iter().any(|s| s.id == "s3x-snap-copy"));

        create(&conn, "cluster", "s3x-aurora", "s3x-csnap")
            .await
            .unwrap();
        let all = list(&conn, None, None).await.unwrap();
        assert!(all
            .iter()
            .any(|s| s.id == "s3x-csnap" && s.kind == "cluster"));

        let req = RestoreRequest {
            snapshot_id: Some("s3x-snap-1".into()),
            new_id: "s3x-pg-restored".into(),
            ..Default::default()
        };
        assert_eq!(
            restore(&conn, "instance", &req).await.unwrap(),
            "s3x-pg-restored"
        );
        assert!(rds::describe_instance(&conn, "s3x-pg-restored")
            .await
            .is_ok());
        // Point in time: the emulator may not support it; if it does, it must work.
        let pitr = RestoreRequest {
            source_db_id: Some("s3x-pg".into()),
            new_id: "s3x-pg-pitr".into(),
            ..Default::default()
        };
        if restore(&conn, "instance", &pitr).await.is_ok() {
            assert!(rds::describe_instance(&conn, "s3x-pg-pitr").await.is_ok());
        }

        delete(&conn, "instance", "s3x-snap-copy").await.unwrap();
        delete(&conn, "cluster", "s3x-csnap").await.unwrap();
        assert!(!list(&conn, None, None)
            .await
            .unwrap()
            .iter()
            .any(|s| s.id == "s3x-snap-copy" || s.id == "s3x-csnap"));
    }
}
