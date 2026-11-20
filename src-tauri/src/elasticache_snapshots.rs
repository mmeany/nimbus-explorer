//! ElastiCache snapshots of replication groups and serverless caches: list
//! (region-wide or per cache), create, copy, delete (manual only) and restore
//! to a new cache.

use crate::elasticache::{client, err, group_details, iso, other, serverless_details};
use crate::error::AppError;
use crate::s3::Connection;
use aws_sdk_elasticache::types::{ServerlessCacheSnapshot, Snapshot as SdkSnapshot};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Group,
    Serverless,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub name: String,
    pub arn: Option<String>,
    /// "group" or "serverless".
    pub kind: String,
    /// manual or automated.
    pub source: String,
    /// The replication group or serverless cache it was taken of.
    pub cache: Option<String>,
    pub status: Option<String>,
    pub created: Option<String>,
    /// As AWS reports it ("12 MB"; serverless: bytes used).
    pub size: Option<String>,
    pub engine: Option<String>,
    pub engine_version: Option<String>,
    pub node_type: Option<String>,
    pub shards: Option<i32>,
    pub kms_key_id: Option<String>,
    /// Serverless automated snapshots expire.
    pub expires: Option<String>,
}

/// The endpoint doesn't know the operation (emulators answer "Unknown action").
fn unsupported(s: &str) -> bool {
    s.contains("Unknown ElastiCache action")
        || s.contains("InvalidAction")
        || s.contains("UnknownOperation")
}

fn group_snapshot(s: &SdkSnapshot) -> Snapshot {
    let created = s
        .node_snapshots()
        .iter()
        .filter_map(|n| iso(n.snapshot_create_time()))
        .min();
    let sizes: Vec<&str> = s
        .node_snapshots()
        .iter()
        .filter_map(|n| n.cache_size())
        .collect();
    Snapshot {
        name: s.snapshot_name().unwrap_or_default().to_string(),
        arn: s.arn().map(String::from),
        kind: "group".into(),
        source: match s.snapshot_source() {
            Some("manual") => "manual".into(),
            Some(_) => "automated".into(),
            None => "manual".into(),
        },
        cache: s
            .replication_group_id()
            .filter(|g| !g.is_empty())
            .or(s.cache_cluster_id().filter(|c| !c.is_empty()))
            .map(String::from),
        status: s.snapshot_status().map(String::from),
        created,
        size: (!sizes.is_empty()).then(|| sizes.join(" + ")),
        engine: s.engine().map(String::from),
        engine_version: s.engine_version().map(String::from),
        node_type: s.cache_node_type().map(String::from),
        shards: s.num_node_groups(),
        kms_key_id: s.kms_key_id().map(String::from),
        expires: None,
    }
}

fn serverless_snapshot(s: &ServerlessCacheSnapshot) -> Snapshot {
    let cfg = s.serverless_cache_configuration();
    Snapshot {
        name: s
            .serverless_cache_snapshot_name()
            .unwrap_or_default()
            .to_string(),
        arn: s.arn().map(String::from),
        kind: "serverless".into(),
        source: s
            .snapshot_type()
            .map(|t| t.to_lowercase())
            .unwrap_or_else(|| "manual".into()),
        cache: cfg
            .and_then(|c| c.serverless_cache_name())
            .map(String::from),
        status: s.status().map(String::from),
        created: iso(s.create_time()),
        size: s.bytes_used_for_cache().map(String::from),
        engine: cfg.and_then(|c| c.engine()).map(String::from),
        engine_version: cfg.and_then(|c| c.major_engine_version()).map(String::from),
        node_type: None,
        shards: None,
        kms_key_id: s.kms_key_id().map(String::from),
        expires: iso(s.expiry_time()),
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotList {
    /// Newest first.
    pub items: Vec<Snapshot>,
    /// The endpoint has no serverless snapshot API (an emulator).
    pub serverless_unsupported: bool,
}

/// Snapshots in the region, or of one cache (`cache` = kind + id).
pub async fn list(
    conn: &Connection,
    cache: Option<(Kind, String)>,
) -> Result<SnapshotList, AppError> {
    let c = client(conn);
    let mut out = SnapshotList::default();
    if !matches!(cache, Some((Kind::Serverless, _))) {
        let mut marker: Option<String> = None;
        loop {
            let mut req = c
                .describe_snapshots()
                .max_records(50)
                .set_marker(marker.clone());
            if let Some((Kind::Group, id)) = &cache {
                req = req.replication_group_id(id);
            }
            let page = req.send().await.map_err(|e| err(conn, e))?;
            out.items
                .extend(page.snapshots().iter().map(group_snapshot));
            match page.marker() {
                Some(m) if !m.is_empty() && Some(m) != marker.as_deref() => {
                    marker = Some(m.to_string())
                }
                _ => break,
            }
        }
    }
    if !matches!(cache, Some((Kind::Group, _))) {
        let mut token: Option<String> = None;
        loop {
            let mut req = c
                .describe_serverless_cache_snapshots()
                .max_results(50)
                .set_next_token(token.clone());
            if let Some((Kind::Serverless, name)) = &cache {
                req = req.serverless_cache_name(name);
            }
            match req.send().await {
                Ok(page) => {
                    out.items.extend(
                        page.serverless_cache_snapshots()
                            .iter()
                            .map(serverless_snapshot),
                    );
                    match page.next_token() {
                        Some(t) if !t.is_empty() && Some(t) != token.as_deref() => {
                            token = Some(t.to_string())
                        }
                        _ => break,
                    }
                }
                Err(e) if unsupported(&format!("{e:?}")) => {
                    out.serverless_unsupported = true;
                    break;
                }
                Err(e) => return Err(err(conn, e)),
            }
        }
    }
    out.items
        .sort_by(|a, b| b.created.cmp(&a.created).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// Why AWS would refuse a snapshot name, if it would: 1–255 letters, digits
/// and hyphens, starting with a letter, no "--", not ending with "-".
pub fn name_problem(name: &str) -> Option<String> {
    if name.is_empty() || name.len() > 255 {
        return Some("Snapshot names are 1 to 255 characters".into());
    }
    if !name.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return Some("Snapshot names start with a letter".into());
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Some("Snapshot names use letters, digits and hyphens".into());
    }
    if name.contains("--") || name.ends_with('-') {
        return Some("Snapshot names can't contain two hyphens in a row or end with one".into());
    }
    None
}

fn refused(conn: &Connection, what: &str, e: impl std::error::Error + std::fmt::Debug) -> AppError {
    if unsupported(&format!("{e:?}")) {
        other(format!(
            "This endpoint doesn't support {what}. Emulators often leave it out; it works on AWS."
        ))
    } else {
        err(conn, e)
    }
}

pub async fn create(
    conn: &Connection,
    kind: Kind,
    cache: &str,
    name: &str,
) -> Result<Snapshot, AppError> {
    let name = name.trim();
    if let Some(p) = name_problem(name) {
        return Err(other(p));
    }
    let c = client(conn);
    match kind {
        Kind::Group => {
            let out = c
                .create_snapshot()
                .replication_group_id(cache)
                .snapshot_name(name)
                .send()
                .await
                .map_err(|e| err(conn, e))?;
            out.snapshot()
                .map(group_snapshot)
                .ok_or_else(|| other("AWS didn't return the snapshot"))
        }
        Kind::Serverless => {
            let out = c
                .create_serverless_cache_snapshot()
                .serverless_cache_name(cache)
                .serverless_cache_snapshot_name(name)
                .send()
                .await
                .map_err(|e| refused(conn, "serverless snapshots", e))?;
            out.serverless_cache_snapshot()
                .map(serverless_snapshot)
                .ok_or_else(|| other("AWS didn't return the snapshot"))
        }
    }
}

/// Copies a snapshot (an automated one becomes a manual copy that doesn't expire).
pub async fn copy(
    conn: &Connection,
    kind: Kind,
    source: &str,
    target: &str,
) -> Result<(), AppError> {
    let target = target.trim();
    if let Some(p) = name_problem(target) {
        return Err(other(p));
    }
    let c = client(conn);
    match kind {
        Kind::Group => {
            c.copy_snapshot()
                .source_snapshot_name(source)
                .target_snapshot_name(target)
                .send()
                .await
                .map_err(|e| refused(conn, "copying snapshots", e))?;
        }
        Kind::Serverless => {
            c.copy_serverless_cache_snapshot()
                .source_serverless_cache_snapshot_name(source)
                .target_serverless_cache_snapshot_name(target)
                .send()
                .await
                .map_err(|e| refused(conn, "serverless snapshots", e))?;
        }
    }
    Ok(())
}

/// Deletes a manual snapshot (automated ones expire on their own; AWS refuses them).
pub async fn delete(conn: &Connection, kind: Kind, name: &str) -> Result<(), AppError> {
    let c = client(conn);
    match kind {
        Kind::Group => {
            let found = c
                .describe_snapshots()
                .snapshot_name(name)
                .send()
                .await
                .map_err(|e| err(conn, e))?;
            if found
                .snapshots()
                .first()
                .map(group_snapshot)
                .is_some_and(|s| s.source != "manual")
            {
                return Err(other("Automated snapshots can't be deleted; they expire after the retention period. Copy one to keep it."));
            }
            c.delete_snapshot()
                .snapshot_name(name)
                .send()
                .await
                .map_err(|e| err(conn, e))?;
        }
        Kind::Serverless => {
            c.delete_serverless_cache_snapshot()
                .serverless_cache_snapshot_name(name)
                .send()
                .await
                .map_err(|e| refused(conn, "serverless snapshots", e))?;
        }
    }
    Ok(())
}

/// Why a cache name would be refused (replication group ids and serverless
/// names: 1–40 letters, digits and hyphens, starting with a letter).
pub fn cache_name_problem(name: &str) -> Option<String> {
    if name.is_empty() || name.len() > 40 {
        return Some("Cache names are 1 to 40 characters".into());
    }
    if !name.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return Some("Cache names start with a letter".into());
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        || name.contains("--")
        || name.ends_with('-')
    {
        return Some(
            "Cache names use letters, digits and single hyphens, and don't end with one".into(),
        );
    }
    None
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreRequest {
    pub kind: Kind,
    pub snapshot: String,
    pub name: String,
    pub description: Option<String>,
    /// Groups: node type (default: the snapshot's).
    pub node_type: Option<String>,
    /// Groups: replicas per shard (0–5).
    #[serde(default)]
    pub replicas: i32,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub name: String,
    /// What was copied from the cache the snapshot came from (network, encryption).
    pub copied_from_source: bool,
}

/// Restores into a new cache. Network settings (subnet group / subnets and
/// security groups) and encryption in transit come from the source cache when
/// it still exists; otherwise AWS's defaults apply.
pub async fn restore(conn: &Connection, r: &RestoreRequest) -> Result<Restored, AppError> {
    let name = r.name.trim();
    if let Some(p) = cache_name_problem(name) {
        return Err(other(p));
    }
    let c = client(conn);
    match r.kind {
        Kind::Group => {
            if !(0..=5).contains(&r.replicas) {
                return Err(other("Replicas per shard are 0 to 5"));
            }
            let found = c
                .describe_snapshots()
                .snapshot_name(&r.snapshot)
                .send()
                .await
                .map_err(|e| err(conn, e))?;
            let snap = found
                .snapshots()
                .first()
                .ok_or_else(|| other(format!("There's no snapshot called {}.", r.snapshot)))?;
            let source = match snap.replication_group_id().filter(|g| !g.is_empty()) {
                Some(id) => group_details(conn, id).await.ok(),
                None => None,
            };
            let shards = snap.num_node_groups().unwrap_or(1).max(1);
            let cluster_mode = shards > 1 || source.as_ref().is_some_and(|s| s.group.cluster_mode);
            let mut req = c
                .create_replication_group()
                .replication_group_id(name)
                .replication_group_description(
                    r.description
                        .clone()
                        .filter(|d| !d.trim().is_empty())
                        .unwrap_or_else(|| format!("Restored from {}", r.snapshot)),
                )
                .snapshot_name(&r.snapshot)
                .set_engine(snap.engine().map(String::from))
                .set_cache_node_type(
                    r.node_type
                        .clone()
                        .filter(|t| !t.trim().is_empty())
                        .or(snap.cache_node_type().map(String::from)),
                )
                .automatic_failover_enabled(r.replicas > 0);
            req = if cluster_mode {
                req.num_node_groups(shards)
                    .replicas_per_node_group(r.replicas)
            } else {
                req.num_cache_clusters(1 + r.replicas)
            };
            if let Some(src) = &source {
                if let Some(s) = &src.settings {
                    req = req
                        .set_cache_subnet_group_name(s.subnet_group.clone())
                        .set_security_group_ids(
                            (!s.security_groups.is_empty()).then(|| s.security_groups.clone()),
                        );
                }
                req = req.transit_encryption_enabled(src.group.transit_encryption);
            }
            req.send().await.map_err(|e| err(conn, e))?;
            Ok(Restored {
                name: name.to_string(),
                copied_from_source: source.is_some(),
            })
        }
        Kind::Serverless => {
            let found = c
                .describe_serverless_cache_snapshots()
                .serverless_cache_snapshot_name(&r.snapshot)
                .send()
                .await
                .map_err(|e| refused(conn, "serverless snapshots", e))?;
            let snap = found
                .serverless_cache_snapshots()
                .first()
                .ok_or_else(|| other(format!("There's no snapshot called {}.", r.snapshot)))?;
            let cfg = snap.serverless_cache_configuration();
            let source = match cfg.and_then(|c| c.serverless_cache_name()) {
                Some(n) => serverless_details(conn, n).await.ok(),
                None => None,
            };
            let mut req = c
                .create_serverless_cache()
                .serverless_cache_name(name)
                .set_description(r.description.clone().filter(|d| !d.trim().is_empty()))
                .set_engine(cfg.and_then(|c| c.engine()).map(String::from))
                .set_major_engine_version(
                    cfg.and_then(|c| c.major_engine_version()).map(String::from),
                )
                .set_snapshot_arns_to_restore(snap.arn().map(|a| vec![a.to_string()]));
            if let Some(src) = &source {
                req = req
                    .set_subnet_ids((!src.subnets.is_empty()).then(|| src.subnets.clone()))
                    .set_security_group_ids(
                        (!src.security_groups.is_empty()).then(|| src.security_groups.clone()),
                    );
            }
            req.send().await.map_err(|e| err(conn, e))?;
            Ok(Restored {
                name: name.to_string(),
                copied_from_source: source.is_some(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_names() {
        assert_eq!(name_problem("nightly-2026-11-18"), None);
        assert!(name_problem("1st").is_some());
        assert!(name_problem("a_b").is_some());
        assert!(name_problem("a--b").is_some());
        assert!(name_problem("ends-").is_some());
        assert_eq!(cache_name_problem("orders-restored"), None);
        assert!(cache_name_problem(&"a".repeat(41)).is_some());
        assert!(cache_name_problem("9lives").is_some());
    }

    #[test]
    fn spots_unsupported_operations() {
        assert!(unsupported("Error { code: \"InvalidAction\", message: \"Unknown ElastiCache action: CopySnapshot\" }"));
        assert!(!unsupported("SnapshotNotFoundFault"));
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::elasticache::emulator_tests::{connect, ensure_group};

    #[tokio::test]
    #[ignore]
    async fn creates_restores_and_deletes_group_snapshots() {
        let conn = connect().await;
        ensure_group(&conn, "s3x-ec-snap").await;
        let c = client(&conn);
        let _ = c
            .delete_snapshot()
            .snapshot_name("s3x-ec-snap-1")
            .send()
            .await;
        let _ = c
            .delete_replication_group()
            .replication_group_id("s3x-ec-snap-r")
            .send()
            .await;

        assert!(create(&conn, Kind::Group, "s3x-ec-snap", "bad_name")
            .await
            .is_err());
        let s = create(&conn, Kind::Group, "s3x-ec-snap", "s3x-ec-snap-1")
            .await
            .unwrap();
        assert_eq!((s.kind.as_str(), s.source.as_str()), ("group", "manual"));
        assert_eq!(s.cache.as_deref(), Some("s3x-ec-snap"));

        let all = list(&conn, None).await.unwrap();
        assert!(all.items.iter().any(|x| x.name == "s3x-ec-snap-1"));
        let mine = list(&conn, Some((Kind::Group, "s3x-ec-snap".into())))
            .await
            .unwrap();
        assert!(mine
            .items
            .iter()
            .all(|x| x.cache.as_deref() == Some("s3x-ec-snap")));

        // Copy and serverless snapshots may not exist on the emulator: plain messages then.
        if let Err(e) = copy(&conn, Kind::Group, "s3x-ec-snap-1", "s3x-ec-snap-copy").await {
            assert!(e.message.contains("copying snapshots"), "{}", e.message);
        } else {
            delete(&conn, Kind::Group, "s3x-ec-snap-copy")
                .await
                .unwrap();
        }

        let r = restore(
            &conn,
            &RestoreRequest {
                kind: Kind::Group,
                snapshot: "s3x-ec-snap-1".into(),
                name: "s3x-ec-snap-r".into(),
                description: None,
                node_type: None,
                replicas: 1,
            },
        )
        .await
        .unwrap();
        assert!(r.copied_from_source);
        let g = group_details(&conn, "s3x-ec-snap-r").await.unwrap();
        assert_eq!(g.group.member_count, 2);
        c.delete_replication_group()
            .replication_group_id("s3x-ec-snap-r")
            .send()
            .await
            .unwrap();

        delete(&conn, Kind::Group, "s3x-ec-snap-1").await.unwrap();
        assert!(!list(&conn, None)
            .await
            .unwrap()
            .items
            .iter()
            .any(|x| x.name == "s3x-ec-snap-1" && x.status.as_deref() == Some("available")));
    }
}

