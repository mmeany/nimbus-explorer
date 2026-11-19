//! AMIs (yours, and those shared with you), EBS volumes and EBS snapshots.

use crate::ec2::{client, err, filter, iso, other, tag, tags, volume, Volume};
use crate::error::AppError;
use crate::s3::Connection;
use aws_sdk_ec2::types::{Image as SdkImage, Snapshot as SdkSnapshot};
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImageDevice {
    pub device: String,
    pub snapshot_id: Option<String>,
    pub size_gib: Option<i32>,
    pub volume_type: Option<String>,
    pub encrypted: Option<bool>,
    pub delete_on_termination: Option<bool>,
    /// An instance store disk ("ephemeral0") rather than EBS.
    pub virtual_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub id: String,
    /// The image's own name (not a tag).
    pub name: Option<String>,
    pub name_tag: Option<String>,
    pub description: Option<String>,
    pub state: Option<String>,
    pub state_reason: Option<String>,
    pub created: Option<String>,
    pub deprecation: Option<String>,
    pub owner_id: Option<String>,
    pub owner_alias: Option<String>,
    pub public: bool,
    pub architecture: Option<String>,
    pub platform: Option<String>,
    pub root_device: Option<String>,
    pub root_device_type: Option<String>,
    pub virtualization: Option<String>,
    pub ena_support: Option<bool>,
    pub boot_mode: Option<String>,
    pub imds_support: Option<String>,
    pub location: Option<String>,
    pub devices: Vec<ImageDevice>,
    pub tags: Vec<(String, String)>,
}

fn image(i: &SdkImage) -> Image {
    Image {
        id: i.image_id().unwrap_or_default().to_string(),
        name: i.name().map(String::from),
        name_tag: tag(i.tags(), "Name").map(String::from),
        description: i.description().filter(|d| !d.is_empty()).map(String::from),
        state: i.state().map(|s| s.as_str().to_string()),
        state_reason: i.state_reason().and_then(|r| r.message()).map(String::from),
        created: i.creation_date().map(String::from),
        deprecation: i.deprecation_time().map(String::from),
        owner_id: i.owner_id().map(String::from),
        owner_alias: i.image_owner_alias().map(String::from),
        public: i.public().unwrap_or(false),
        architecture: i.architecture().map(|a| a.as_str().to_string()),
        platform: i.platform_details().map(String::from),
        root_device: i.root_device_name().map(String::from),
        root_device_type: i.root_device_type().map(|t| t.as_str().to_string()),
        virtualization: i.virtualization_type().map(|v| v.as_str().to_string()),
        ena_support: i.ena_support(),
        boot_mode: i.boot_mode().map(|b| b.as_str().to_string()),
        imds_support: i.imds_support().map(|b| b.as_str().to_string()),
        location: i.image_location().map(String::from),
        devices: i
            .block_device_mappings()
            .iter()
            .map(|b| ImageDevice {
                device: b.device_name().unwrap_or_default().to_string(),
                snapshot_id: b.ebs().and_then(|e| e.snapshot_id()).map(String::from),
                size_gib: b.ebs().and_then(|e| e.volume_size()),
                volume_type: b.ebs().and_then(|e| e.volume_type()).map(|t| t.as_str().to_string()),
                encrypted: b.ebs().and_then(|e| e.encrypted()),
                delete_on_termination: b.ebs().and_then(|e| e.delete_on_termination()),
                virtual_name: b.virtual_name().map(String::from),
            })
            .collect(),
        tags: tags(i.tags()),
    }
}

async fn describe_images(conn: &Connection, mine: bool) -> Result<Vec<Image>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut req = c.describe_images().max_results(1000).set_next_token(token.clone());
        req = if mine { req.owners("self") } else { req.executable_users("self") };
        let page = req.send().await.map_err(|e| err(conn, e))?;
        out.extend(page.images().iter().map(image));
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    Ok(out)
}

/// Your images ("mine"), or images shared with your account by others ("shared"), newest first.
pub async fn list_images(conn: &Connection, scope: &str) -> Result<Vec<Image>, AppError> {
    let mut out = match scope {
        "mine" => describe_images(conn, true).await?,
        "shared" => {
            // ExecutableUsers=self can include your own images; leave those out.
            let own: HashSet<String> = describe_images(conn, true).await?.into_iter().map(|i| i.id).collect();
            describe_images(conn, false)
                .await?
                .into_iter()
                .filter(|i| !own.contains(&i.id))
                .collect()
        }
        _ => return Err(other("Choose mine or shared images.")),
    };
    out.sort_by(|a, b| b.created.cmp(&a.created).then(a.id.cmp(&b.id)));
    Ok(out)
}

/// One image by ID (any owner, as long as you can see it).
pub async fn get_image(conn: &Connection, id: &str) -> Result<Image, AppError> {
    let out = client(conn)
        .describe_images()
        .image_ids(id)
        .send()
        .await
        .map_err(|e| missing(conn, e, "image", id))?;
    out.images()
        .first()
        .map(image)
        .ok_or_else(|| other(format!("There's no image {id} in this region, or you can't see it.")))
}

/// "Not found" errors as a plain sentence.
fn missing(conn: &Connection, e: impl std::error::Error + std::fmt::Debug, what: &str, id: &str) -> AppError {
    let text = format!("{e:?}");
    if text.contains(".NotFound") || text.contains(".Malformed") || text.contains("InvalidParameterValue") {
        return other(format!("There's no {what} {id} in this region."));
    }
    err(conn, e)
}

/// Every EBS volume in the region, newest first.
pub async fn list_volumes(conn: &Connection) -> Result<Vec<Volume>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .describe_volumes()
            .max_results(500)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.volumes().iter().map(volume));
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| b.created.cmp(&a.created).then(a.id.cmp(&b.id)));
    Ok(out)
}

pub async fn get_volume(conn: &Connection, id: &str) -> Result<Volume, AppError> {
    let out = client(conn)
        .describe_volumes()
        .volume_ids(id)
        .send()
        .await
        .map_err(|e| missing(conn, e, "volume", id))?;
    out.volumes()
        .first()
        .map(volume)
        .ok_or_else(|| other(format!("There's no volume {id} in this region.")))
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub volume_id: Option<String>,
    pub size_gib: Option<i32>,
    pub state: Option<String>,
    pub state_message: Option<String>,
    pub progress: Option<String>,
    pub started: Option<String>,
    pub completed: Option<String>,
    pub encrypted: bool,
    pub kms_key_id: Option<String>,
    pub owner_id: Option<String>,
    /// standard or archive.
    pub storage_tier: Option<String>,
    pub tags: Vec<(String, String)>,
}

fn snapshot(s: &SdkSnapshot) -> Snapshot {
    Snapshot {
        id: s.snapshot_id().unwrap_or_default().to_string(),
        name: tag(s.tags(), "Name").map(String::from),
        description: s.description().filter(|d| !d.is_empty()).map(String::from),
        // AWS uses vol-ffffffff for snapshots copied from another snapshot.
        volume_id: s.volume_id().filter(|v| *v != "vol-ffffffff").map(String::from),
        size_gib: s.volume_size(),
        state: s.state().map(|x| x.as_str().to_string()),
        state_message: s.state_message().filter(|m| !m.is_empty()).map(String::from),
        progress: s.progress().filter(|p| !p.is_empty()).map(String::from),
        started: iso(s.start_time()),
        completed: iso(s.completion_time()),
        encrypted: s.encrypted().unwrap_or(false),
        kms_key_id: s.kms_key_id().map(String::from),
        owner_id: s.owner_id().map(String::from),
        storage_tier: s.storage_tier().map(|t| t.as_str().to_string()),
        tags: tags(s.tags()),
    }
}

/// Your snapshots, newest first.
pub async fn list_snapshots(conn: &Connection) -> Result<Vec<Snapshot>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .describe_snapshots()
            .owner_ids("self")
            .max_results(1000)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.snapshots().iter().map(snapshot));
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| b.started.cmp(&a.started).then(a.id.cmp(&b.id)));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDetails {
    #[serde(flatten)]
    pub snapshot: Snapshot,
    /// Whether the source volume still exists (None = couldn't tell).
    pub volume_exists: Option<bool>,
    /// Your images that use this snapshot.
    pub images: Vec<String>,
}

pub async fn get_snapshot(conn: &Connection, id: &str) -> Result<SnapshotDetails, AppError> {
    let c = client(conn);
    let out = c
        .describe_snapshots()
        .snapshot_ids(id)
        .send()
        .await
        .map_err(|e| missing(conn, e, "snapshot", id))?;
    let s = out
        .snapshots()
        .first()
        .map(snapshot)
        .ok_or_else(|| other(format!("There's no snapshot {id} in this region.")))?;
    let volume_exists = match &s.volume_id {
        None => Some(false),
        Some(v) => match c.describe_volumes().volume_ids(v).send().await {
            Ok(o) => Some(!o.volumes().is_empty()),
            Err(e) if format!("{e:?}").contains("NotFound") => Some(false),
            Err(_) => None,
        },
    };
    let images = c
        .describe_images()
        .owners("self")
        .filters(filter("block-device-mapping.snapshot-id", &[id]))
        .send()
        .await
        .map(|o| o.images().iter().filter_map(|i| i.image_id()).map(String::from).collect())
        .unwrap_or_default();
    Ok(SnapshotDetails { snapshot: s, volume_exists, images })
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::ec2::emulator_tests::{connect, ensure_instance};

    #[tokio::test]
    #[ignore]
    async fn lists_images_volumes_and_snapshots() {
        let conn = connect().await;
        let id = ensure_instance(&conn, "s3x-ec2-storage").await;
        let vol = crate::ec2::instance_details(&conn, &id).await.unwrap().instance.block_devices.into_iter().find_map(|b| b.volume_id);

        let vols = list_volumes(&conn).await.unwrap();
        if let Some(v) = &vol {
            assert!(vols.iter().any(|x| &x.id == v));
            assert_eq!(&get_volume(&conn, v).await.unwrap().id, v);
            let snap = crate::ec2_tags::snapshot_volume(&conn, v, Some("storage test"), &[]).await.unwrap();
            let snaps = list_snapshots(&conn).await.unwrap();
            assert!(snaps.iter().any(|s| s.id == snap.snapshot_id));
            let d = get_snapshot(&conn, &snap.snapshot_id).await.unwrap();
            assert_eq!(d.snapshot.volume_id.as_deref(), Some(v.as_str()));
        }
        assert!(get_volume(&conn, "vol-0000000000000dead").await.is_err());
        // Image listing must work (possibly empty); shared may be unsupported by emulators.
        list_images(&conn, "mine").await.unwrap();
        let _ = list_images(&conn, "shared").await;
        assert!(list_images(&conn, "bogus").await.is_err());
    }
}
