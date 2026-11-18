//! ElastiCache events of a replication group (with its member clusters) or a
//! serverless cache, newest first, for up to 14 days.

use crate::elasticache::{client, err, group_details, iso};
use crate::elasticache_snapshots::Kind;
use crate::error::AppError;
use crate::s3::Connection;
use aws_sdk_elasticache::types::SourceType;
use serde::Serialize;

/// DescribeEvents goes back at most 14 days.
pub const MAX_MINUTES: i32 = 14 * 24 * 60;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub date: Option<String>,
    /// The group, node (member cluster) or serverless cache.
    pub source: String,
    /// replication-group, cache-cluster, serverless-cache, …
    pub source_type: String,
    pub message: String,
}

async fn events_of(
    conn: &Connection,
    source_type: SourceType,
    id: Option<&str>,
    minutes: i32,
) -> Result<Vec<Event>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut marker: Option<String> = None;
    loop {
        let page = c
            .describe_events()
            .source_type(source_type.clone())
            .set_source_identifier(id.map(String::from))
            .duration(minutes)
            .max_records(100)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.events().iter().map(|e| {
            Event {
                date: iso(e.date()),
                source: e.source_identifier().unwrap_or_default().to_string(),
                source_type: e
                    .source_type()
                    .map(|t| t.as_str().to_string())
                    .unwrap_or_default(),
                message: e.message().unwrap_or_default().to_string(),
            }
        }));
        match page.marker() {
            Some(m) if !m.is_empty() && Some(m) != marker.as_deref() => {
                marker = Some(m.to_string())
            }
            _ => break,
        }
    }
    Ok(out)
}

/// Keeps only events of `members`, merges and sorts newest first.
pub fn merge(mut own: Vec<Event>, members_events: Vec<Event>, members: &[String]) -> Vec<Event> {
    own.extend(
        members_events
            .into_iter()
            .filter(|e| members.contains(&e.source)),
    );
    own.sort_by(|a, b| b.date.cmp(&a.date).then(a.source.cmp(&b.source)));
    own.dedup();
    own
}

/// Events of the cache for the last `minutes` (1 minute to 14 days).
pub async fn events(
    conn: &Connection,
    kind: Kind,
    id: &str,
    minutes: i32,
) -> Result<Vec<Event>, AppError> {
    let minutes = minutes.clamp(1, MAX_MINUTES);
    match kind {
        Kind::Serverless => {
            let mut v = events_of(conn, SourceType::ServerlessCache, Some(id), minutes).await?;
            v.sort_by(|a, b| b.date.cmp(&a.date));
            Ok(v)
        }
        Kind::Group => {
            let g = group_details(conn, id).await?;
            let members: Vec<String> = g
                .group
                .shards
                .iter()
                .flat_map(|s| s.members.iter().map(|m| m.cluster_id.clone()))
                .collect();
            let own = events_of(conn, SourceType::ReplicationGroup, Some(id), minutes).await?;
            // One call for every node's events (filtered here), not one per node.
            let nodes = if members.is_empty() {
                Vec::new()
            } else {
                events_of(conn, SourceType::CacheCluster, None, minutes).await?
            };
            Ok(merge(own, nodes, &members))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(date: &str, source: &str, msg: &str) -> Event {
        Event {
            date: Some(date.into()),
            source: source.into(),
            source_type: "cache-cluster".into(),
            message: msg.into(),
        }
    }

    #[test]
    fn merges_member_events_newest_first() {
        let own = vec![ev("2026-01-01T10:00:00Z", "g", "created")];
        let nodes = vec![
            ev("2026-01-01T11:00:00Z", "g-0001-001", "rebooted"),
            ev("2026-01-01T12:00:00Z", "other-0001-001", "not ours"),
            ev("2026-01-01T09:00:00Z", "g-0001-002", "added"),
        ];
        let out = merge(own, nodes, &["g-0001-001".into(), "g-0001-002".into()]);
        assert_eq!(
            out.iter().map(|e| e.message.as_str()).collect::<Vec<_>>(),
            ["rebooted", "created", "added"]
        );
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::elasticache::emulator_tests::{connect, ensure_group};

    #[tokio::test]
    #[ignore]
    async fn lists_group_and_node_events() {
        let conn = connect().await;
        ensure_group(&conn, "s3x-ec-events").await;
        let g = group_details(&conn, "s3x-ec-events").await.unwrap();
        let node = g.group.shards[0].members[0].cluster_id.clone();
        client(&conn)
            .reboot_cache_cluster()
            .cache_cluster_id(&node)
            .cache_node_ids_to_reboot("0001")
            .send()
            .await
            .unwrap();
        let v = events(&conn, Kind::Group, "s3x-ec-events", 60)
            .await
            .unwrap();
        assert!(v.iter().any(|e| e.source == node), "{v:?}");
        assert!(v.iter().all(|e| e.source == "s3x-ec-events"
            || g.group.shards[0]
                .members
                .iter()
                .any(|m| m.cluster_id == e.source)));
        assert!(v.windows(2).all(|w| w[0].date >= w[1].date));
    }
}
