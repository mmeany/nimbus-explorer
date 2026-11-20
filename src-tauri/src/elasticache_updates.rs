//! ElastiCache service updates (engine and security patches AWS schedules)
//! for a replication group: list them, and apply one now.

use crate::elasticache::{client, err, iso, other};
use crate::error::AppError;
use crate::s3::Connection;
use aws_sdk_elasticache::types::UpdateAction;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub name: String,
    /// critical, important, medium or low.
    pub severity: Option<String>,
    /// security-update, …
    pub kind: Option<String>,
    /// available, cancelled or expired (the update itself).
    pub update_status: Option<String>,
    /// not-applied, waiting-to-start, in-progress, stopping, stopped, complete,
    /// scheduling, scheduled, not-applicable (this cache's progress).
    pub status: Option<String>,
    pub released: Option<String>,
    pub apply_by: Option<String>,
    pub available: Option<String>,
    pub status_changed: Option<String>,
    pub nodes_updated: Option<String>,
    /// yes, no or n/a: applied before the recommended date.
    pub sla_met: Option<String>,
    pub estimated_time: Option<String>,
    pub engine: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Updates {
    /// Most urgent first, then soonest apply-by date.
    pub items: Vec<Update>,
    /// The endpoint has no service update API (an emulator).
    pub unsupported: bool,
}

fn update(u: &UpdateAction) -> Update {
    Update {
        name: u.service_update_name().unwrap_or_default().to_string(),
        severity: u.service_update_severity().map(|v| v.as_str().to_string()),
        kind: u.service_update_type().map(|v| v.as_str().to_string()),
        update_status: u.service_update_status().map(|v| v.as_str().to_string()),
        status: u.update_action_status().map(|v| v.as_str().to_string()),
        released: iso(u.service_update_release_date()),
        apply_by: iso(u.service_update_recommended_apply_by_date()),
        available: iso(u.update_action_available_date()),
        status_changed: iso(u.update_action_status_modified_date()),
        nodes_updated: u.nodes_updated().map(String::from),
        sla_met: u.sla_met().map(|v| v.as_str().to_string()),
        estimated_time: u.estimated_update_time().map(String::from),
        engine: u.engine().map(String::from),
    }
}

fn rank(severity: Option<&str>) -> u8 {
    match severity {
        Some("critical") => 0,
        Some("important") => 1,
        Some("medium") => 2,
        Some("low") => 3,
        _ => 4,
    }
}

/// Most urgent first; within a severity, the soonest apply-by date first (none last).
pub fn order(mut items: Vec<Update>) -> Vec<Update> {
    items.sort_by(|a, b| {
        rank(a.severity.as_deref())
            .cmp(&rank(b.severity.as_deref()))
            .then_with(|| match (&a.apply_by, &b.apply_by) {
                (Some(x), Some(y)) => x.cmp(y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
            .then(a.name.cmp(&b.name))
    });
    items
}

fn unsupported(s: &str) -> bool {
    s.contains("Unknown ElastiCache action") || s.contains("InvalidAction")
}

/// Every update action for the replication group, any status.
pub async fn list(conn: &Connection, group: &str) -> Result<Updates, AppError> {
    let c = client(conn);
    let mut items = Vec::new();
    let mut marker: Option<String> = None;
    loop {
        let res = c
            .describe_update_actions()
            .replication_group_ids(group)
            .max_records(100)
            .set_marker(marker.clone())
            .send()
            .await;
        let page = match res {
            Ok(p) => p,
            Err(e) if unsupported(&format!("{e:?}")) => {
                return Ok(Updates {
                    items: Vec::new(),
                    unsupported: true,
                })
            }
            Err(e) => return Err(err(conn, e)),
        };
        items.extend(page.update_actions().iter().map(update));
        match page.marker() {
            Some(m) if !m.is_empty() && Some(m) != marker.as_deref() => {
                marker = Some(m.to_string())
            }
            _ => break,
        }
    }
    Ok(Updates {
        items: order(items),
        unsupported: false,
    })
}

/// Starts applying the update to the group now. Returns its new status.
pub async fn apply(
    conn: &Connection,
    group: &str,
    update: &str,
) -> Result<Option<String>, AppError> {
    if update.trim().is_empty() {
        return Err(other("Choose an update"));
    }
    let out = client(conn)
        .batch_apply_update_action()
        .replication_group_ids(group)
        .service_update_name(update)
        .send()
        .await
        .map_err(|e| {
            if unsupported(&format!("{e:?}")) {
                other("This endpoint doesn't support service updates. Emulators often leave them out; it works on AWS.")
            } else {
                err(conn, e)
            }
        })?;
    if let Some(u) = out.unprocessed_update_actions().first() {
        return Err(other(format!(
            "AWS didn't apply {update}: {}",
            u.error_message()
                .or(u.error_type())
                .unwrap_or("no reason given")
        )));
    }
    Ok(out
        .processed_update_actions()
        .first()
        .and_then(|p| p.update_action_status())
        .map(|s| s.as_str().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(name: &str, severity: Option<&str>, apply_by: Option<&str>) -> Update {
        Update {
            name: name.into(),
            severity: severity.map(String::from),
            apply_by: apply_by.map(String::from),
            ..Default::default()
        }
    }

    #[test]
    fn orders_by_urgency_then_apply_by() {
        let items = vec![
            u("low-1", Some("low"), Some("2026-01-01")),
            u("crit-late", Some("critical"), Some("2026-06-01")),
            u("crit-none", Some("critical"), None),
            u("crit-soon", Some("critical"), Some("2026-02-01")),
            u("odd", None, None),
            u("imp", Some("important"), None),
        ];
        assert_eq!(
            order(items)
                .iter()
                .map(|x| x.name.as_str())
                .collect::<Vec<_>>(),
            ["crit-soon", "crit-late", "crit-none", "imp", "low-1", "odd"]
        );
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::elasticache::emulator_tests::{connect, ensure_group};

    #[tokio::test]
    #[ignore]
    async fn lists_updates_or_says_unsupported() {
        let conn = connect().await;
        ensure_group(&conn, "s3x-ec-updates").await;
        let r = list(&conn, "s3x-ec-updates").await.unwrap();
        // MiniStack has no service update API; AWS lists the group's actions.
        assert!(r.unsupported || r.items.iter().all(|i| !i.name.is_empty()));
        if r.unsupported {
            let e = apply(&conn, "s3x-ec-updates", "elasticache-20260101-001")
                .await
                .unwrap_err();
            assert!(
                e.message.contains("doesn't support service updates"),
                "{}",
                e.message
            );
        }
    }
}
