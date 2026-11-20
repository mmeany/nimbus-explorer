//! ElastiCache actions on a replication group: reboot nodes (cluster mode off)
//! and test failover of a shard.

use crate::elasticache::{client, err, group_details, other, GroupDetails};
use crate::error::AppError;
use crate::s3::Connection;

/// Why the nodes can't be rebooted, if they can't (checked before calling AWS).
pub fn reboot_problem(g: &GroupDetails, cluster_ids: &[String]) -> Option<String> {
    if g.group.cluster_mode {
        return Some("Nodes of a cluster-mode group can't be rebooted from the API; AWS replaces failed nodes itself.".into());
    }
    if g.group.status.as_deref() != Some("available") {
        return Some(format!(
            "{} is {}; wait until it's available.",
            g.group.id,
            g.group.status.as_deref().unwrap_or("not available")
        ));
    }
    if cluster_ids.is_empty() {
        return Some("Choose at least one node".into());
    }
    let known: Vec<&str> = g
        .group
        .shards
        .iter()
        .flat_map(|s| s.members.iter())
        .map(|m| m.cluster_id.as_str())
        .collect();
    if let Some(bad) = cluster_ids.iter().find(|c| !known.contains(&c.as_str())) {
        return Some(format!("{bad} isn't a node of {}", g.group.id));
    }
    None
}

/// Reboots the given nodes (member clusters) one call each. Returns the ones rebooted.
pub async fn reboot_nodes(
    conn: &Connection,
    group_id: &str,
    cluster_ids: &[String],
) -> Result<Vec<String>, AppError> {
    let g = group_details(conn, group_id).await?;
    if let Some(p) = reboot_problem(&g, cluster_ids) {
        return Err(other(p));
    }
    let c = client(conn);
    let mut done = Vec::new();
    for id in cluster_ids {
        // Each member cluster of a Valkey / Redis OSS group has one node, "0001".
        let node = g
            .group
            .shards
            .iter()
            .flat_map(|s| s.members.iter())
            .find(|m| &m.cluster_id == id)
            .and_then(|m| m.node_id.clone())
            .unwrap_or_else(|| "0001".into());
        c.reboot_cache_cluster()
            .cache_cluster_id(id)
            .cache_node_ids_to_reboot(node)
            .send()
            .await
            .map_err(|e| {
                let mut a = err(conn, e);
                if !done.is_empty() {
                    a.message = format!(
                        "Rebooted {}, then {id} failed: {}",
                        done.join(", "),
                        a.message
                    );
                }
                a
            })?;
        done.push(id.clone());
    }
    Ok(done)
}

/// Why the shard can't be failed over, if it can't.
pub fn failover_problem(g: &GroupDetails, shard_id: &str) -> Option<String> {
    let Some(shard) = g.group.shards.iter().find(|s| s.id == shard_id) else {
        return Some(format!("{} has no shard {shard_id}", g.group.id));
    };
    if g.group.automatic_failover.as_deref() != Some("enabled") {
        return Some(
            "Automatic failover is off for this group, so there's nothing to test.".into(),
        );
    }
    if shard.members.len() < 2 {
        return Some(format!("Shard {shard_id} has no replica to promote."));
    }
    if g.group.status.as_deref() != Some("available") {
        return Some(format!(
            "{} is {}; wait until it's available.",
            g.group.id,
            g.group.status.as_deref().unwrap_or("not available")
        ));
    }
    None
}

/// Promotes a replica of the shard, as if its primary had failed.
pub async fn test_failover(
    conn: &Connection,
    group_id: &str,
    shard_id: &str,
) -> Result<(), AppError> {
    let g = group_details(conn, group_id).await?;
    if let Some(p) = failover_problem(&g, shard_id) {
        return Err(other(p));
    }
    client(conn)
        .test_failover()
        .replication_group_id(group_id)
        .node_group_id(shard_id)
        .send()
        .await
        .map_err(|e| {
            let s = format!("{e:?}");
            if s.contains("Unknown ElastiCache action") || s.contains("InvalidAction") {
                other("This endpoint doesn't support TestFailover. Emulators often leave it out; it works on AWS.")
            } else {
                err(conn, e)
            }
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::elasticache::{Group, Member, Shard};

    fn details(cluster_mode: bool, failover: &str, members: usize) -> GroupDetails {
        GroupDetails {
            group: Group {
                id: "g".into(),
                status: Some("available".into()),
                cluster_mode,
                automatic_failover: Some(failover.into()),
                shards: vec![Shard {
                    id: "0001".into(),
                    members: (1..=members)
                        .map(|i| Member {
                            cluster_id: format!("g-0001-00{i}"),
                            node_id: Some("0001".into()),
                            ..Default::default()
                        })
                        .collect(),
                    ..Default::default()
                }],
                ..Default::default()
            },
            settings: None,
            tags: Vec::new(),
        }
    }

    #[test]
    fn checks_reboots() {
        let g = details(false, "enabled", 2);
        assert_eq!(reboot_problem(&g, &["g-0001-002".into()]), None);
        assert!(reboot_problem(&g, &[]).is_some());
        assert!(reboot_problem(&g, &["other".into()])
            .unwrap()
            .contains("isn't a node"));
        assert!(
            reboot_problem(&details(true, "enabled", 2), &["g-0001-001".into()])
                .unwrap()
                .contains("cluster-mode")
        );
        let mut busy = details(false, "enabled", 2);
        busy.group.status = Some("modifying".into());
        assert!(reboot_problem(&busy, &["g-0001-001".into()])
            .unwrap()
            .contains("modifying"));
    }

    #[test]
    fn checks_failovers() {
        assert_eq!(
            failover_problem(&details(false, "enabled", 2), "0001"),
            None
        );
        assert!(failover_problem(&details(false, "disabled", 2), "0001")
            .unwrap()
            .contains("off"));
        assert!(failover_problem(&details(false, "enabled", 1), "0001")
            .unwrap()
            .contains("no replica"));
        assert!(failover_problem(&details(false, "enabled", 2), "0002")
            .unwrap()
            .contains("no shard"));
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::elasticache::emulator_tests::{connect, ensure_group};

    #[tokio::test]
    #[ignore]
    async fn reboots_a_replica_and_tries_a_failover() {
        let conn = connect().await;
        ensure_group(&conn, "s3x-ec-actions").await;
        let g = group_details(&conn, "s3x-ec-actions").await.unwrap();
        let replica = g.group.shards[0]
            .members
            .iter()
            .find(|m| m.role.as_deref() == Some("replica"))
            .unwrap()
            .cluster_id
            .clone();
        assert_eq!(
            reboot_nodes(&conn, "s3x-ec-actions", &[replica.clone()])
                .await
                .unwrap(),
            [replica]
        );
        assert!(reboot_nodes(&conn, "s3x-ec-actions", &["nope".into()])
            .await
            .is_err());
        // AWS promotes a replica; an emulator without the API gets a plain message.
        if let Err(e) = test_failover(&conn, "s3x-ec-actions", "0001").await {
            assert!(e.message.contains("TestFailover"), "{}", e.message);
        }
    }
}
