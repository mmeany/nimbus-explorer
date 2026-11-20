//! Tags on any EC2 resource, and creating images (AMIs) and EBS snapshots.
//! Every caller (commands/ec2.rs) checks `ensure_writable` first.

use crate::ec2::{client, err, other};
use crate::ec2_actions::unsupported;
use crate::error::AppError;
use crate::s3::Connection;
use aws_sdk_ec2::types::{CopyTagsFromSource, InstanceSpecification, ResourceType, Tag, TagSpecification};
use serde::{Deserialize, Serialize};

/// AWS's limits: 50 user tags per resource, keys 1–128 characters (not
/// starting with "aws:"), values up to 256.
pub fn check_tags(tags: &[(String, String)]) -> Result<(), AppError> {
    if tags.len() > 50 {
        return Err(other("A resource can have at most 50 tags."));
    }
    let mut seen = std::collections::HashSet::new();
    for (k, v) in tags {
        if k.trim().is_empty() {
            return Err(other("Tag keys can't be empty."));
        }
        if k.chars().count() > 128 {
            return Err(other(format!("The tag key \"{k}\" is longer than 128 characters.")));
        }
        if k.to_ascii_lowercase().starts_with("aws:") {
            return Err(other(format!("\"{k}\": keys starting with aws: are reserved for AWS.")));
        }
        if v.chars().count() > 256 {
            return Err(other(format!("The value of \"{k}\" is longer than 256 characters.")));
        }
        if !seen.insert(k.as_str()) {
            return Err(other(format!("The tag key \"{k}\" is used twice.")));
        }
    }
    Ok(())
}

/// Brings a resource's user tags to `desired` (aws: tags are left alone):
/// sets new and changed ones, deletes the rest. Returns (set, deleted).
pub async fn set_tags(
    conn: &Connection,
    resource: &str,
    current: &[(String, String)],
    desired: &[(String, String)],
) -> Result<(usize, usize), AppError> {
    check_tags(desired)?;
    let c = client(conn);
    let changed: Vec<Tag> = desired
        .iter()
        .filter(|(k, v)| !current.iter().any(|(ck, cv)| ck == k && cv == v))
        .map(|(k, v)| Tag::builder().key(k).value(v).build())
        .collect();
    let removed: Vec<Tag> = current
        .iter()
        .filter(|(k, _)| !k.starts_with("aws:") && !desired.iter().any(|(dk, _)| dk == k))
        .map(|(k, _)| Tag::builder().key(k).build())
        .collect();
    let (n_set, n_del) = (changed.len(), removed.len());
    if !changed.is_empty() {
        c.create_tags()
            .resources(resource)
            .set_tags(Some(changed))
            .send()
            .await
            .map_err(|e| unsupported(conn, e, "CreateTags"))?;
    }
    if !removed.is_empty() {
        c.delete_tags()
            .resources(resource)
            .set_tags(Some(removed))
            .send()
            .await
            .map_err(|e| unsupported(conn, e, "DeleteTags"))?;
    }
    Ok((n_set, n_del))
}

/// AMI names: 3–128 characters of letters, digits and ( ) [ ] space . / - ' @ _
pub fn image_name_problem(name: &str) -> Option<String> {
    let n = name.chars().count();
    if !(3..=128).contains(&n) {
        return Some("Image names are 3 to 128 characters.".into());
    }
    if let Some(c) = name
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || "()[] ./-'@_".contains(*c)))
    {
        return Some(format!("Image names can't contain \"{c}\": use letters, digits, spaces and ( ) [ ] . / - ' @ _"));
    }
    None
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRequest {
    pub instance_id: String,
    pub name: String,
    pub description: Option<String>,
    /// Skip the reboot (the image may not be consistent).
    pub no_reboot: bool,
    /// Tags for the new image and its snapshots.
    pub tags: Vec<(String, String)>,
}

pub async fn create_image(conn: &Connection, r: &ImageRequest) -> Result<String, AppError> {
    if let Some(p) = image_name_problem(&r.name) {
        return Err(other(p));
    }
    if r.description.as_deref().map(|d| d.chars().count() > 255).unwrap_or(false) {
        return Err(other("Descriptions are at most 255 characters."));
    }
    check_tags(&r.tags)?;
    let mut req = client(conn)
        .create_image()
        .instance_id(&r.instance_id)
        .name(&r.name)
        .set_description(r.description.clone().filter(|d| !d.is_empty()))
        .no_reboot(r.no_reboot);
    if !r.tags.is_empty() {
        let tags: Vec<Tag> = r.tags.iter().map(|(k, v)| Tag::builder().key(k).value(v).build()).collect();
        for rt in [ResourceType::Image, ResourceType::Snapshot] {
            req = req.tag_specifications(TagSpecification::builder().resource_type(rt).set_tags(Some(tags.clone())).build());
        }
    }
    let out = req.send().await.map_err(|e| {
        if format!("{e:?}").contains("InvalidAMIName.Duplicate") {
            other(format!("You already have an image called \"{}\" in this region.", r.name))
        } else {
            unsupported(conn, e, "CreateImage")
        }
    })?;
    out.image_id()
        .map(String::from)
        .ok_or_else(|| other("AWS didn't return the new image's ID."))
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreatedSnapshot {
    pub snapshot_id: String,
    pub volume_id: Option<String>,
}

/// One snapshot of a volume.
pub async fn snapshot_volume(
    conn: &Connection,
    volume_id: &str,
    description: Option<&str>,
    tags: &[(String, String)],
) -> Result<CreatedSnapshot, AppError> {
    check_tags(tags)?;
    let mut req = client(conn)
        .create_snapshot()
        .volume_id(volume_id)
        .set_description(description.filter(|d| !d.is_empty()).map(String::from));
    if !tags.is_empty() {
        req = req.tag_specifications(
            TagSpecification::builder()
                .resource_type(ResourceType::Snapshot)
                .set_tags(Some(tags.iter().map(|(k, v)| Tag::builder().key(k).value(v).build()).collect()))
                .build(),
        );
    }
    let out = req.send().await.map_err(|e| err(conn, e))?;
    Ok(CreatedSnapshot {
        snapshot_id: out.snapshot_id().unwrap_or_default().to_string(),
        volume_id: out.volume_id().map(String::from),
    })
}

/// Crash-consistent snapshots of all an instance's volumes (optionally not
/// the root volume), each tagged like its volume.
pub async fn snapshot_instance(
    conn: &Connection,
    instance_id: &str,
    description: Option<&str>,
    exclude_root: bool,
) -> Result<Vec<CreatedSnapshot>, AppError> {
    let out = client(conn)
        .create_snapshots()
        .instance_specification(
            InstanceSpecification::builder()
                .instance_id(instance_id)
                .exclude_boot_volume(exclude_root)
                .build(),
        )
        .set_description(description.filter(|d| !d.is_empty()).map(String::from))
        .copy_tags_from_source(CopyTagsFromSource::Volume)
        .send()
        .await
        .map_err(|e| unsupported(conn, e, "CreateSnapshots"))?;
    Ok(out
        .snapshots()
        .iter()
        .map(|s| CreatedSnapshot {
            snapshot_id: s.snapshot_id().unwrap_or_default().to_string(),
            volume_id: s.volume_id().map(String::from),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(k: &str, v: &str) -> (String, String) {
        (k.into(), v.into())
    }

    #[test]
    fn checks_tags() {
        assert!(check_tags(&[t("Name", "web"), t("env", "")]).is_ok());
        assert!(check_tags(&[t("", "x")]).is_err());
        assert!(check_tags(&[t("aws:cloudformation", "x")]).is_err());
        assert!(check_tags(&[t("a", "1"), t("a", "2")]).is_err());
        assert!(check_tags(&[t(&"k".repeat(129), "")]).is_err());
        assert!(check_tags(&[t("k", &"v".repeat(257))]).is_err());
    }

    #[test]
    fn checks_image_names() {
        assert_eq!(image_name_problem("web-2026-11-19 (before upgrade)"), None);
        assert!(image_name_problem("ab").is_some());
        assert!(image_name_problem("bad*name").is_some());
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::ec2::emulator_tests::{connect, ensure_instance};
    use crate::ec2::get_instance;

    #[tokio::test]
    #[ignore]
    async fn tags_images_and_snapshots() {
        let conn = connect().await;
        let id = ensure_instance(&conn, "s3x-ec2-tags").await;
        let before = get_instance(&conn, &id).await.unwrap().tags;
        let mut want = before.clone();
        want.retain(|(k, _)| k != "s3x-test");
        want.push(("s3x-test".into(), "1".into()));
        set_tags(&conn, &id, &before, &want).await.unwrap();
        let after = get_instance(&conn, &id).await.unwrap().tags;
        assert!(after.iter().any(|(k, v)| k == "s3x-test" && v == "1"));
        set_tags(&conn, &id, &after, &before).await.unwrap();
        assert!(!get_instance(&conn, &id).await.unwrap().tags.iter().any(|(k, _)| k == "s3x-test"));

        let name = format!("s3x-image-{}", std::process::id());
        // MiniStack has no CreateImage: accept its refusal.
        match create_image(&conn, &ImageRequest { instance_id: id.clone(), name, description: None, no_reboot: true, tags: vec![] }).await {
            Ok(image) => assert!(image.starts_with("ami-")),
            Err(e) => assert!(e.message.contains("doesn't support"), "{}", e.message),
        }

        // Snapshots: per volume always; per instance where the endpoint has CreateSnapshots.
        let vol = crate::ec2::instance_details(&conn, &id).await.unwrap().instance.block_devices.into_iter().find_map(|b| b.volume_id);
        if let Some(v) = vol {
            let s = snapshot_volume(&conn, &v, Some("test"), &[]).await.unwrap();
            assert!(s.snapshot_id.starts_with("snap-"));
        }
        let _ = snapshot_instance(&conn, &id, None, false).await;
    }
}
