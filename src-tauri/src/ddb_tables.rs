//! DynamoDB table management: create / delete, GSIs, settings, backups.

use crate::dynamo::{client, err, other};
use crate::error::AppError;
use crate::s3::Connection;
use aws_sdk_dynamodb::types::{
    AttributeDefinition, BillingMode, CreateGlobalSecondaryIndexAction,
    DeleteGlobalSecondaryIndexAction, GlobalSecondaryIndex, GlobalSecondaryIndexUpdate,
    KeySchemaElement, KeyType, LocalSecondaryIndex, PointInTimeRecoverySpecification, Projection,
    ProjectionType, ProvisionedThroughput, ScalarAttributeType, StreamSpecification,
    StreamViewType, TableClass, Tag, TimeToLiveSpecification,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeySpec {
    pub name: String,
    /// "S" | "N" | "B"
    pub attr_type: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSpec {
    pub name: String,
    /// GSI partition key (ignored for LSIs, which share the table's).
    pub partition_key: Option<KeySpec>,
    pub sort_key: Option<KeySpec>,
    /// ALL | KEYS_ONLY | INCLUDE
    pub projection: String,
    #[serde(default)]
    pub non_key_attributes: Vec<String>,
    pub read_capacity: Option<i64>,
    pub write_capacity: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTableSpec {
    pub name: String,
    pub partition_key: KeySpec,
    pub sort_key: Option<KeySpec>,
    /// PAY_PER_REQUEST | PROVISIONED
    pub billing_mode: String,
    pub read_capacity: Option<i64>,
    pub write_capacity: Option<i64>,
    #[serde(default)]
    pub gsis: Vec<IndexSpec>,
    #[serde(default)]
    pub lsis: Vec<IndexSpec>,
    pub table_class: Option<String>,
    #[serde(default)]
    pub deletion_protection: bool,
    /// None = no stream.
    pub stream_view_type: Option<String>,
    #[serde(default)]
    pub tags: BTreeMap<String, String>,
}

/// Table / index names: 3–255 of letters, digits, '_', '-', '.'.
pub fn name_problem(name: &str, what: &str) -> Option<String> {
    if name.len() < 3 || name.len() > 255 {
        return Some(format!("{what} names must be 3 to 255 characters"));
    }
    if name
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || "_-.".contains(c)))
    {
        return Some(format!(
            "{what} names can use letters, digits, _ - and . only"
        ));
    }
    None
}

fn scalar(t: &str) -> Result<ScalarAttributeType, AppError> {
    match t {
        "S" => Ok(ScalarAttributeType::S),
        "N" => Ok(ScalarAttributeType::N),
        "B" => Ok(ScalarAttributeType::B),
        _ => Err(other(format!("Key type must be S, N or B (not {t})"))),
    }
}

fn key(name: &str, kt: KeyType) -> Result<KeySchemaElement, AppError> {
    KeySchemaElement::builder()
        .attribute_name(name)
        .key_type(kt)
        .build()
        .map_err(|e| other(e.to_string()))
}

fn schema(pk: &KeySpec, sk: Option<&KeySpec>) -> Result<Vec<KeySchemaElement>, AppError> {
    let mut v = vec![key(&pk.name, KeyType::Hash)?];
    if let Some(sk) = sk {
        v.push(key(&sk.name, KeyType::Range)?);
    }
    Ok(v)
}

fn projection(i: &IndexSpec) -> Projection {
    let t = match i.projection.as_str() {
        "KEYS_ONLY" => ProjectionType::KeysOnly,
        "INCLUDE" => ProjectionType::Include,
        _ => ProjectionType::All,
    };
    Projection::builder()
        .projection_type(t.clone())
        .set_non_key_attributes(if t == ProjectionType::Include {
            Some(i.non_key_attributes.clone())
        } else {
            None
        })
        .build()
}

fn throughput(r: Option<i64>, w: Option<i64>) -> Result<ProvisionedThroughput, AppError> {
    ProvisionedThroughput::builder()
        .read_capacity_units(r.unwrap_or(5).max(1))
        .write_capacity_units(w.unwrap_or(5).max(1))
        .build()
        .map_err(|e| other(e.to_string()))
}

/// Collects attribute definitions for every key, checking type conflicts.
fn definitions(keys: &[&KeySpec]) -> Result<Vec<AttributeDefinition>, AppError> {
    let mut seen: BTreeMap<String, String> = BTreeMap::new();
    for k in keys {
        if k.name.trim().is_empty() {
            return Err(other("Every key needs an attribute name"));
        }
        if let Some(t) = seen.get(&k.name) {
            if *t != k.attr_type {
                return Err(other(format!(
                    "\"{}\" is used as both {} and {}",
                    k.name, t, k.attr_type
                )));
            }
        }
        seen.insert(k.name.clone(), k.attr_type.clone());
    }
    seen.iter()
        .map(|(n, t)| {
            AttributeDefinition::builder()
                .attribute_name(n)
                .attribute_type(scalar(t)?)
                .build()
                .map_err(|e| other(e.to_string()))
        })
        .collect()
}

pub async fn create_table(conn: &Connection, s: &CreateTableSpec) -> Result<(), AppError> {
    if let Some(p) = name_problem(&s.name, "Table") {
        return Err(other(p));
    }
    let provisioned = s.billing_mode == "PROVISIONED";
    let mut keys: Vec<&KeySpec> = vec![&s.partition_key];
    keys.extend(s.sort_key.iter());
    let mut gsis = Vec::new();
    for g in &s.gsis {
        if let Some(p) = name_problem(&g.name, "Index") {
            return Err(other(p));
        }
        let pk = g
            .partition_key
            .as_ref()
            .ok_or_else(|| other(format!("Index {} needs a partition key", g.name)))?;
        keys.push(pk);
        keys.extend(g.sort_key.iter());
        gsis.push(
            GlobalSecondaryIndex::builder()
                .index_name(&g.name)
                .set_key_schema(Some(schema(pk, g.sort_key.as_ref())?))
                .projection(projection(g))
                .set_provisioned_throughput(if provisioned {
                    Some(throughput(g.read_capacity, g.write_capacity)?)
                } else {
                    None
                })
                .build()
                .map_err(|e| other(e.to_string()))?,
        );
    }
    let mut lsis = Vec::new();
    for l in &s.lsis {
        if let Some(p) = name_problem(&l.name, "Index") {
            return Err(other(p));
        }
        if s.sort_key.is_none() {
            return Err(other(
                "Local secondary indexes need a table with a sort key",
            ));
        }
        let sk = l
            .sort_key
            .as_ref()
            .ok_or_else(|| other(format!("Index {} needs a sort key", l.name)))?;
        keys.push(sk);
        lsis.push(
            LocalSecondaryIndex::builder()
                .index_name(&l.name)
                .set_key_schema(Some(schema(&s.partition_key, Some(sk))?))
                .projection(projection(l))
                .build()
                .map_err(|e| other(e.to_string()))?,
        );
    }
    let stream = match &s.stream_view_type {
        Some(v) => Some(
            StreamSpecification::builder()
                .stream_enabled(true)
                .stream_view_type(StreamViewType::from(v.as_str()))
                .build()
                .map_err(|e| other(e.to_string()))?,
        ),
        None => None,
    };
    let tags = s
        .tags
        .iter()
        .map(|(k, v)| {
            Tag::builder()
                .key(k)
                .value(v)
                .build()
                .map_err(|e| other(e.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    client(conn)
        .create_table()
        .table_name(&s.name)
        .set_key_schema(Some(schema(&s.partition_key, s.sort_key.as_ref())?))
        .set_attribute_definitions(Some(definitions(&keys)?))
        .billing_mode(if provisioned {
            BillingMode::Provisioned
        } else {
            BillingMode::PayPerRequest
        })
        .set_provisioned_throughput(if provisioned {
            Some(throughput(s.read_capacity, s.write_capacity)?)
        } else {
            None
        })
        .set_global_secondary_indexes(if gsis.is_empty() { None } else { Some(gsis) })
        .set_local_secondary_indexes(if lsis.is_empty() { None } else { Some(lsis) })
        .set_table_class(s.table_class.as_deref().map(TableClass::from))
        .deletion_protection_enabled(s.deletion_protection)
        .set_stream_specification(stream)
        .set_tags(if tags.is_empty() { None } else { Some(tags) })
        .send()
        .await
        .map_err(|e| {
            if e.as_service_error()
                .is_some_and(|se| se.is_resource_in_use_exception())
            {
                other(format!("A table named {} already exists", s.name))
            } else {
                err(conn, e)
            }
        })?;
    Ok(())
}

pub async fn delete_table(conn: &Connection, name: &str) -> Result<(), AppError> {
    let t = crate::dynamo::describe_table(conn, name).await?;
    if t.deletion_protection {
        return Err(other(
            "Deletion protection is on for this table. Turn it off in the table's settings first.",
        ));
    }
    client(conn)
        .delete_table()
        .table_name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

/// Adds a global secondary index (it builds in the background).
pub async fn add_gsi(conn: &Connection, table: &str, g: &IndexSpec) -> Result<(), AppError> {
    if let Some(p) = name_problem(&g.name, "Index") {
        return Err(other(p));
    }
    let t = crate::dynamo::describe_table(conn, table).await?;
    let pk = g
        .partition_key
        .as_ref()
        .ok_or_else(|| other("The index needs a partition key"))?;
    let provisioned = t.billing_mode.as_deref() == Some("PROVISIONED");
    // Definitions must include the new keys (and agree with existing ones).
    let existing: Vec<KeySpec> = t
        .attribute_definitions
        .iter()
        .map(|d| KeySpec {
            name: d.name.clone(),
            attr_type: d.attr_type.clone(),
        })
        .collect();
    let mut keys: Vec<&KeySpec> = existing.iter().collect();
    keys.push(pk);
    keys.extend(g.sort_key.iter());
    let action = CreateGlobalSecondaryIndexAction::builder()
        .index_name(&g.name)
        .set_key_schema(Some(schema(pk, g.sort_key.as_ref())?))
        .projection(projection(g))
        .set_provisioned_throughput(if provisioned {
            Some(throughput(g.read_capacity, g.write_capacity)?)
        } else {
            None
        })
        .build()
        .map_err(|e| other(e.to_string()))?;
    client(conn)
        .update_table()
        .table_name(table)
        .set_attribute_definitions(Some(definitions(&keys)?))
        .global_secondary_index_updates(
            GlobalSecondaryIndexUpdate::builder().create(action).build(),
        )
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

pub async fn delete_gsi(conn: &Connection, table: &str, index: &str) -> Result<(), AppError> {
    client(conn)
        .update_table()
        .table_name(table)
        .global_secondary_index_updates(
            GlobalSecondaryIndexUpdate::builder()
                .delete(
                    DeleteGlobalSecondaryIndexAction::builder()
                        .index_name(index)
                        .build()
                        .map_err(|e| other(e.to_string()))?,
                )
                .build(),
        )
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

/// Settings changes; only fields that are Some are applied.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    /// PAY_PER_REQUEST | PROVISIONED (with capacities)
    pub billing_mode: Option<String>,
    pub read_capacity: Option<i64>,
    pub write_capacity: Option<i64>,
    pub deletion_protection: Option<bool>,
    pub table_class: Option<String>,
    /// Some("") turns the stream off; Some(view) turns it on / changes it.
    pub stream_view_type: Option<String>,
    /// Some("") turns TTL off (needs the current attribute); Some(attr) on.
    pub ttl_attribute: Option<String>,
    pub pitr: Option<bool>,
    /// Replaces all tags.
    pub tags: Option<BTreeMap<String, String>>,
}

pub async fn update_settings(
    conn: &Connection,
    table: &str,
    p: &SettingsPatch,
) -> Result<(), AppError> {
    let c = client(conn);
    let current = crate::dynamo::describe_table(conn, table).await?;
    // UpdateTable can change one thing per call for some combinations
    // (streams especially), so apply changes one by one.
    if let Some(mode) = &p.billing_mode {
        let provisioned = mode == "PROVISIONED";
        c.update_table()
            .table_name(table)
            .billing_mode(if provisioned {
                BillingMode::Provisioned
            } else {
                BillingMode::PayPerRequest
            })
            .set_provisioned_throughput(if provisioned {
                Some(throughput(p.read_capacity, p.write_capacity)?)
            } else {
                None
            })
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    if let Some(dp) = p.deletion_protection {
        c.update_table()
            .table_name(table)
            .deletion_protection_enabled(dp)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    if let Some(tc) = &p.table_class {
        c.update_table()
            .table_name(table)
            .table_class(TableClass::from(tc.as_str()))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    if let Some(view) = &p.stream_view_type {
        if current.stream_enabled {
            // Changing the view type means turning the stream off first.
            c.update_table()
                .table_name(table)
                .stream_specification(
                    StreamSpecification::builder()
                        .stream_enabled(false)
                        .build()
                        .map_err(|e| other(e.to_string()))?,
                )
                .send()
                .await
                .map_err(|e| err(conn, e))?;
        }
        if !view.is_empty() {
            c.update_table()
                .table_name(table)
                .stream_specification(
                    StreamSpecification::builder()
                        .stream_enabled(true)
                        .stream_view_type(StreamViewType::from(view.as_str()))
                        .build()
                        .map_err(|e| other(e.to_string()))?,
                )
                .send()
                .await
                .map_err(|e| err(conn, e))?;
        }
    }
    if let Some(attr) = &p.ttl_attribute {
        let (enabled, name) = if attr.is_empty() {
            (
                false,
                current
                    .ttl_attribute
                    .clone()
                    .ok_or_else(|| other("TTL isn't on"))?,
            )
        } else {
            (true, attr.clone())
        };
        c.update_time_to_live()
            .table_name(table)
            .time_to_live_specification(
                TimeToLiveSpecification::builder()
                    .enabled(enabled)
                    .attribute_name(name)
                    .build()
                    .map_err(|e| other(e.to_string()))?,
            )
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    if let Some(on) = p.pitr {
        c.update_continuous_backups()
            .table_name(table)
            .point_in_time_recovery_specification(
                PointInTimeRecoverySpecification::builder()
                    .point_in_time_recovery_enabled(on)
                    .build()
                    .map_err(|e| other(e.to_string()))?,
            )
            .send()
            .await
            .map_err(|e| err(conn, e))?;
    }
    if let Some(tags) = &p.tags {
        let arn = current.arn.clone().ok_or_else(|| other("No table ARN"))?;
        let now: BTreeMap<String, String> = crate::dynamo::list_tags(conn, &arn)
            .await?
            .into_iter()
            .collect();
        let add: Vec<Tag> = tags
            .iter()
            .filter(|(k, v)| now.get(*k) != Some(v))
            .map(|(k, v)| {
                Tag::builder()
                    .key(k)
                    .value(v)
                    .build()
                    .map_err(|e| other(e.to_string()))
            })
            .collect::<Result<_, _>>()?;
        if !add.is_empty() {
            c.tag_resource()
                .resource_arn(&arn)
                .set_tags(Some(add))
                .send()
                .await
                .map_err(|e| err(conn, e))?;
        }
        let remove: Vec<String> = now
            .keys()
            .filter(|k| !tags.contains_key(*k))
            .cloned()
            .collect();
        if !remove.is_empty() {
            c.untag_resource()
                .resource_arn(&arn)
                .set_tag_keys(Some(remove))
                .send()
                .await
                .map_err(|e| err(conn, e))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Backups

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub arn: String,
    pub name: String,
    /// CREATING | AVAILABLE | DELETED
    pub status: Option<String>,
    /// USER | SYSTEM | AWS_BACKUP
    pub kind: Option<String>,
    pub created: Option<String>,
    pub size_bytes: Option<i64>,
}

pub async fn list_backups(conn: &Connection, table: &str) -> Result<Vec<BackupInfo>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut start = None;
    loop {
        let page = c
            .list_backups()
            .table_name(table)
            .set_exclusive_start_backup_arn(start)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.backup_summaries().iter().map(|b| BackupInfo {
            arn: b.backup_arn().unwrap_or_default().to_string(),
            name: b.backup_name().unwrap_or_default().to_string(),
            status: b.backup_status().map(|s| s.as_str().to_string()),
            kind: b.backup_type().map(|s| s.as_str().to_string()),
            created: b.backup_creation_date_time().and_then(|d| {
                d.fmt(aws_sdk_dynamodb::primitives::DateTimeFormat::DateTime)
                    .ok()
            }),
            size_bytes: b.backup_size_bytes(),
        }));
        start = page.last_evaluated_backup_arn().map(String::from);
        if start.is_none() {
            break;
        }
    }
    out.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(out)
}

pub async fn create_backup(conn: &Connection, table: &str, name: &str) -> Result<String, AppError> {
    if let Some(p) = name_problem(name, "Backup") {
        return Err(other(p));
    }
    let out = client(conn)
        .create_backup()
        .table_name(table)
        .backup_name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out
        .backup_details()
        .map(|d| d.backup_arn().to_string())
        .unwrap_or_default())
}

pub async fn restore_backup(
    conn: &Connection,
    backup_arn: &str,
    target: &str,
) -> Result<(), AppError> {
    if let Some(p) = name_problem(target, "Table") {
        return Err(other(p));
    }
    client(conn)
        .restore_table_from_backup()
        .backup_arn(backup_arn)
        .target_table_name(target)
        .send()
        .await
        .map_err(|e| {
            if e.as_service_error()
                .is_some_and(|se| se.is_table_already_exists_exception())
            {
                other(format!("A table named {target} already exists"))
            } else {
                err(conn, e)
            }
        })?;
    Ok(())
}

pub async fn delete_backup(conn: &Connection, backup_arn: &str) -> Result<(), AppError> {
    client(conn)
        .delete_backup()
        .backup_arn(backup_arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_definitions() {
        assert_eq!(name_problem("orders", "Table"), None);
        assert!(name_problem("ab", "Table").is_some());
        assert!(name_problem("a b c", "Table").is_some());
        let pk = KeySpec {
            name: "id".into(),
            attr_type: "S".into(),
        };
        let clash = KeySpec {
            name: "id".into(),
            attr_type: "N".into(),
        };
        assert!(definitions(&[&pk, &clash]).is_err());
        assert_eq!(definitions(&[&pk, &pk]).unwrap().len(), 1);
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::dynamo::emulator_tests::connect;

    fn k(n: &str, t: &str) -> KeySpec {
        KeySpec {
            name: n.into(),
            attr_type: t.into(),
        }
    }

    #[tokio::test]
    #[ignore]
    async fn manages_tables_indexes_settings_and_backups() {
        let conn = connect().await;
        for t in ["s3x-ddb-mgmt", "s3x-ddb-restored"] {
            let _ = client(&conn).delete_table().table_name(t).send().await;
        }
        let spec = CreateTableSpec {
            name: "s3x-ddb-mgmt".into(),
            partition_key: k("id", "S"),
            sort_key: Some(k("ts", "N")),
            billing_mode: "PAY_PER_REQUEST".into(),
            read_capacity: None,
            write_capacity: None,
            gsis: vec![IndexSpec {
                name: "byEmail".into(),
                partition_key: Some(k("email", "S")),
                sort_key: None,
                projection: "KEYS_ONLY".into(),
                non_key_attributes: vec![],
                read_capacity: None,
                write_capacity: None,
            }],
            lsis: vec![IndexSpec {
                name: "byStatus".into(),
                partition_key: None,
                sort_key: Some(k("status", "S")),
                projection: "ALL".into(),
                non_key_attributes: vec![],
                read_capacity: None,
                write_capacity: None,
            }],
            table_class: None,
            deletion_protection: true,
            stream_view_type: Some("NEW_IMAGE".into()),
            tags: [("env".to_string(), "dev".to_string())].into(),
        };
        create_table(&conn, &spec).await.unwrap();
        let t = crate::dynamo::describe_table(&conn, "s3x-ddb-mgmt")
            .await
            .unwrap();
        assert_eq!(t.indexes.len(), 2);
        assert!(t.deletion_protection);
        assert!(t.stream_enabled);
        assert!(create_table(&conn, &spec)
            .await
            .unwrap_err()
            .message
            .contains("already exists"));

        // Deletion protection blocks delete.
        assert!(delete_table(&conn, "s3x-ddb-mgmt")
            .await
            .unwrap_err()
            .message
            .contains("Deletion protection"));

        // Add and remove a GSI.
        add_gsi(
            &conn,
            "s3x-ddb-mgmt",
            &IndexSpec {
                name: "byCity".into(),
                partition_key: Some(k("city", "S")),
                sort_key: None,
                projection: "ALL".into(),
                non_key_attributes: vec![],
                read_capacity: None,
                write_capacity: None,
            },
        )
        .await
        .unwrap();
        let t = crate::dynamo::describe_table(&conn, "s3x-ddb-mgmt")
            .await
            .unwrap();
        assert!(t.indexes.iter().any(|i| i.name == "byCity"));
        delete_gsi(&conn, "s3x-ddb-mgmt", "byCity").await.unwrap();

        // Settings.
        update_settings(
            &conn,
            "s3x-ddb-mgmt",
            &SettingsPatch {
                ttl_attribute: Some("expiresAt".into()),
                pitr: Some(true),
                tags: Some([("team".to_string(), "a".to_string())].into()),
                deletion_protection: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let t = crate::dynamo::describe_table(&conn, "s3x-ddb-mgmt")
            .await
            .unwrap();
        assert_eq!(t.ttl_attribute.as_deref(), Some("expiresAt"));
        assert_eq!(t.pitr_status.as_deref(), Some("ENABLED"));
        assert!(!t.deletion_protection);
        assert_eq!(
            crate::dynamo::list_tags(&conn, t.arn.as_ref().unwrap())
                .await
                .unwrap(),
            vec![("team".to_string(), "a".to_string())]
        );

        // Backups.
        let arn = create_backup(&conn, "s3x-ddb-mgmt", "s3x-backup-1")
            .await
            .unwrap();
        assert!(list_backups(&conn, "s3x-ddb-mgmt")
            .await
            .unwrap()
            .iter()
            .any(|b| b.arn == arn));
        restore_backup(&conn, &arn, "s3x-ddb-restored")
            .await
            .unwrap();
        assert!(crate::dynamo::describe_table(&conn, "s3x-ddb-restored")
            .await
            .is_ok());
        delete_backup(&conn, &arn).await.unwrap();

        delete_table(&conn, "s3x-ddb-mgmt").await.unwrap();
        let _ = delete_table(&conn, "s3x-ddb-restored").await;
    }
}
