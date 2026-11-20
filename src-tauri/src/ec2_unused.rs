//! The unused resources report: unattached volumes, unassociated Elastic
//! IPs, security groups no network interface uses, snapshots whose volume
//! is gone (and no image uses), and images no instance uses. Exported to
//! CSV or JSON as shown.

use crate::ec2::{other, Volume};
use crate::ec2_network::{list_addresses, list_interfaces, list_security_groups, Address, SecurityGroup};
use crate::ec2_storage::{list_images, list_snapshots, list_volumes, Image, Snapshot};
use crate::error::AppError;
use crate::s3::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnusedItem {
    /// volumes, addresses, securityGroups, snapshots or images (the EC2 list kind).
    pub kind: String,
    pub id: String,
    pub name: Option<String>,
    /// Why it counts as unused, plus anything to check before deleting it.
    pub reason: String,
    pub size_gib: Option<i32>,
    pub created: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UnusedReport {
    pub items: Vec<UnusedItem>,
    /// Parts that couldn't be checked (e.g. "snapshots: access denied").
    pub skipped: Vec<String>,
}

/// The report from already-loaded lists (pure, so it can be tested).
pub fn compute(
    volumes: Option<&[Volume]>,
    addresses: Option<&[Address]>,
    groups: Option<&[SecurityGroup]>,
    used_groups: Option<&HashSet<String>>,
    snapshots: Option<&[Snapshot]>,
    images: Option<&[Image]>,
    image_users: Option<&HashSet<String>>,
) -> Vec<UnusedItem> {
    let mut out = Vec::new();
    if let Some(vols) = volumes {
        for v in vols.iter().filter(|v| v.state.as_deref() == Some("available")) {
            out.push(UnusedItem {
                kind: "volumes".into(),
                id: v.id.clone(),
                name: v.name.clone(),
                reason: "Not attached to any instance".into(),
                size_gib: v.size_gib,
                created: v.created.clone(),
            });
        }
    }
    if let Some(addrs) = addresses {
        for a in addrs.iter().filter(|a| a.association_id.is_none() && a.instance_id.is_none()) {
            out.push(UnusedItem {
                kind: "addresses".into(),
                id: a.id.clone(),
                name: a.name.clone().or(a.public_ip.clone()),
                reason: format!("Elastic IP {} isn't associated with anything", a.public_ip.as_deref().unwrap_or("?")),
                size_gib: None,
                created: None,
            });
        }
    }
    if let (Some(groups), Some(used)) = (groups, used_groups) {
        let referenced: HashSet<&str> = groups
            .iter()
            .flat_map(|g| g.inbound.iter().chain(g.outbound.iter()))
            .filter(|r| r.source_kind == "group")
            .map(|r| r.source.as_str())
            .collect();
        for g in groups.iter().filter(|g| g.name != "default" && !used.contains(&g.id)) {
            out.push(UnusedItem {
                kind: "securityGroups".into(),
                id: g.id.clone(),
                name: Some(g.name.clone()),
                reason: if referenced.contains(g.id.as_str()) {
                    "No network interface uses it (other groups' rules refer to it)".into()
                } else {
                    "No network interface uses it".into()
                },
                size_gib: None,
                created: None,
            });
        }
    }
    let image_snaps: HashSet<String> = images
        .map(|imgs| imgs.iter().flat_map(|i| i.devices.iter().filter_map(|d| d.snapshot_id.clone())).collect())
        .unwrap_or_default();
    if let (Some(snaps), Some(vols)) = (snapshots, volumes) {
        let live: HashSet<&str> = vols.iter().map(|v| v.id.as_str()).collect();
        for s in snaps {
            let gone = s.volume_id.as_deref().map(|v| !live.contains(v)).unwrap_or(false);
            if gone && !image_snaps.contains(&s.id) {
                out.push(UnusedItem {
                    kind: "snapshots".into(),
                    id: s.id.clone(),
                    name: s.name.clone().or(s.description.clone()),
                    reason: format!("Its volume {} no longer exists and none of your images use it", s.volume_id.as_deref().unwrap_or("?")),
                    size_gib: s.size_gib,
                    created: s.started.clone(),
                });
            }
        }
    }
    if let (Some(imgs), Some(users)) = (images, image_users) {
        for i in imgs.iter().filter(|i| !users.contains(&i.id)) {
            out.push(UnusedItem {
                kind: "images".into(),
                id: i.id.clone(),
                name: i.name.clone(),
                reason: "No instance in this region was launched from it (launch templates or Auto Scaling may still refer to it)".into(),
                size_gib: Some(i.devices.iter().filter_map(|d| d.size_gib).sum()).filter(|s| *s > 0),
                created: i.created.clone(),
            });
        }
    }
    out
}

pub async fn report(conn: &Connection) -> Result<UnusedReport, AppError> {
    let mut skipped = Vec::new();
    let mut note = |what: &str, e: &AppError| skipped.push(format!("{what}: {}", e.message));
    let volumes = match list_volumes(conn).await {
        Ok(v) => Some(v),
        Err(e) => {
            note("volumes and snapshots", &e);
            None
        }
    };
    let addresses = list_addresses(conn).await.map_err(|e| note("Elastic IPs", &e)).ok();
    let groups = list_security_groups(conn).await.map_err(|e| note("security groups", &e)).ok();
    let used_groups: Option<HashSet<String>> = list_interfaces(conn)
        .await
        .map(|l| l.into_iter().flat_map(|n| n.groups.into_iter().map(|g| g.id)).collect())
        .map_err(|e| note("security group use (network interfaces)", &e))
        .ok();
    let snapshots = list_snapshots(conn).await.map_err(|e| note("snapshots", &e)).ok();
    let images = list_images(conn, "mine").await.map_err(|e| note("images", &e)).ok();
    let image_users: Option<HashSet<String>> = crate::ec2::list_instances(conn)
        .await
        .map(|l| l.into_iter().filter(|i| i.state.as_deref() != Some("terminated")).filter_map(|i| i.image_id).collect())
        .map_err(|e| note("image use (instances)", &e))
        .ok();
    if volumes.is_none() && addresses.is_none() && groups.is_none() && snapshots.is_none() && images.is_none() {
        return Err(other(format!("Nothing could be checked: {}", skipped.join("; "))));
    }
    let items = compute(
        volumes.as_deref(),
        addresses.as_deref(),
        groups.as_deref(),
        used_groups.as_ref(),
        snapshots.as_deref(),
        images.as_deref(),
        image_users.as_ref(),
    );
    Ok(UnusedReport { items, skipped })
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

pub fn to_csv(items: &[UnusedItem]) -> String {
    let mut out = String::from("kind,id,name,size_gib,created,reason\r\n");
    for i in items {
        out.push_str(
            &[
                csv_field(&i.kind),
                csv_field(&i.id),
                csv_field(i.name.as_deref().unwrap_or("")),
                i.size_gib.map(|s| s.to_string()).unwrap_or_default(),
                csv_field(i.created.as_deref().unwrap_or("")),
                csv_field(&i.reason),
            ]
            .join(","),
        );
        out.push_str("\r\n");
    }
    out
}

/// Writes the rows to `dest` (`.s3x-part`, renamed when complete); returns the row count.
pub async fn export(items: &[UnusedItem], dest: &str, format: &str) -> Result<usize, AppError> {
    let text = match format {
        "csv" => to_csv(items),
        "json" => serde_json::to_string_pretty(items).map_err(|e| other(e.to_string()))?,
        _ => return Err(other("Export as csv or json.")),
    };
    let part = format!("{dest}.s3x-part");
    tokio::fs::write(&part, text)
        .await
        .map_err(|e| other(format!("Couldn't write {part}: {e}")))?;
    if let Err(e) = tokio::fs::rename(&part, dest).await {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(other(format!("Couldn't save {dest}: {e}")));
    }
    Ok(items.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ec2_network::Rule;
    use crate::ec2_storage::ImageDevice;

    fn vol(id: &str, state: &str) -> Volume {
        Volume { id: id.into(), state: Some(state.into()), size_gib: Some(8), ..Default::default() }
    }

    #[test]
    fn finds_unused_resources() {
        let vols = vec![vol("vol-a", "available"), vol("vol-b", "in-use")];
        let addrs = vec![
            Address { id: "eipalloc-1".into(), public_ip: Some("1.2.3.4".into()), ..Default::default() },
            Address { id: "eipalloc-2".into(), association_id: Some("x".into()), ..Default::default() },
        ];
        let groups = vec![
            SecurityGroup { id: "sg-default".into(), name: "default".into(), ..Default::default() },
            SecurityGroup { id: "sg-used".into(), name: "web".into(), ..Default::default() },
            SecurityGroup {
                id: "sg-idle".into(),
                name: "idle".into(),
                inbound: vec![Rule { source_kind: "group".into(), source: "sg-ref".into(), ..Default::default() }],
                ..Default::default()
            },
            SecurityGroup { id: "sg-ref".into(), name: "ref".into(), ..Default::default() },
        ];
        let used: HashSet<String> = ["sg-used".to_string()].into();
        let snaps = vec![
            Snapshot { id: "snap-gone".into(), volume_id: Some("vol-z".into()), ..Default::default() },
            Snapshot { id: "snap-live".into(), volume_id: Some("vol-b".into()), ..Default::default() },
            Snapshot { id: "snap-ami".into(), volume_id: Some("vol-y".into()), ..Default::default() },
            Snapshot { id: "snap-copy".into(), volume_id: None, ..Default::default() },
        ];
        let images = vec![
            Image { id: "ami-used".into(), ..Default::default() },
            Image {
                id: "ami-idle".into(),
                devices: vec![ImageDevice { snapshot_id: Some("snap-ami".into()), size_gib: Some(8), ..Default::default() }],
                ..Default::default()
            },
        ];
        let users: HashSet<String> = ["ami-used".to_string()].into();
        let r = compute(Some(&vols), Some(&addrs), Some(&groups), Some(&used), Some(&snaps), Some(&images), Some(&users));
        let ids: Vec<&str> = r.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["vol-a", "eipalloc-1", "sg-idle", "sg-ref", "snap-gone", "ami-idle"]);
        assert!(r[3].reason.contains("refer to it"));
        assert_eq!(r[5].size_gib, Some(8));
        // A part that couldn't load is left out, not reported as unused.
        assert!(compute(None, None, Some(&groups), None, None, None, None).is_empty());
    }

    #[test]
    fn writes_csv() {
        let items = vec![UnusedItem { kind: "volumes".into(), id: "vol-1".into(), name: Some("a,\"b\"".into()), reason: "x".into(), size_gib: Some(8), created: None }];
        assert_eq!(to_csv(&items), "kind,id,name,size_gib,created,reason\r\nvolumes,vol-1,\"a,\"\"b\"\"\",8,,x\r\n");
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::ec2::emulator_tests::connect;

    #[tokio::test]
    #[ignore]
    async fn reports_unused_resources() {
        let conn = connect().await;
        let c = crate::ec2::client(&conn);
        let vol = c
            .create_volume()
            .availability_zone("eu-west-2a")
            .size(1)
            .send()
            .await
            .unwrap()
            .volume_id()
            .unwrap()
            .to_string();
        let r = report(&conn).await.unwrap();
        assert!(r.items.iter().any(|i| i.id == vol && i.kind == "volumes"));
        let dir = std::env::temp_dir().join(format!("s3x-unused-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("unused.csv");
        let n = export(&r.items, dest.to_str().unwrap(), "csv").await.unwrap();
        assert_eq!(n, r.items.len());
        assert!(std::fs::read_to_string(&dest).unwrap().starts_with("kind,id"));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = c.delete_volume().volume_id(&vol).send().await;
    }
}
