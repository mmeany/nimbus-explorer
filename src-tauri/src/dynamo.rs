//! DynamoDB: tables and their descriptions.
//!
//! Items cross the boundary as DynamoDB JSON (`{"S": "x"}`, `{"N": "1"}`, …)
//! so no type information is lost; the UI converts to plain JSON for display
//! and editing (see `src/api/dynamo.ts`).

use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use aws_sdk_dynamodb::types::{
    KeySchemaElement, KeyType, Projection, ProvisionedThroughputDescription, TableDescription,
};
use aws_sdk_dynamodb::Client;
use serde::Serialize;

const DESCRIBE_CONCURRENCY: usize = 8;

pub fn client(conn: &Connection) -> Client {
    Client::new(&conn.service_config())
}

pub(crate) fn err(conn: &Connection, e: impl std::error::Error) -> AppError {
    AppError::from_sdk(e, &conn.info.profile, conn.info.endpoint_url.as_deref())
}

pub(crate) fn other(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Other, msg)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyDef {
    pub name: String,
    /// "S" | "N" | "B" (from AttributeDefinitions)
    pub attr_type: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    /// "GSI" | "LSI"
    pub kind: String,
    pub partition_key: Option<KeyDef>,
    pub sort_key: Option<KeyDef>,
    /// ALL | KEYS_ONLY | INCLUDE
    pub projection: String,
    pub non_key_attributes: Vec<String>,
    pub status: Option<String>,
    pub item_count: Option<i64>,
    pub size_bytes: Option<i64>,
    pub read_capacity: Option<i64>,
    pub write_capacity: Option<i64>,
    pub backfilling: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub arn: Option<String>,
    pub status: Option<String>,
    pub partition_key: Option<KeyDef>,
    pub sort_key: Option<KeyDef>,
    pub item_count: Option<i64>,
    pub size_bytes: Option<i64>,
    /// PAY_PER_REQUEST | PROVISIONED
    pub billing_mode: Option<String>,
    pub read_capacity: Option<i64>,
    pub write_capacity: Option<i64>,
    pub table_class: Option<String>,
    pub created: Option<String>,
    pub deletion_protection: bool,
    pub stream_enabled: bool,
    pub stream_view_type: Option<String>,
    pub stream_arn: Option<String>,
    pub sse: Option<String>,
    pub indexes: Vec<IndexInfo>,
    /// All attribute definitions (name → type).
    pub attribute_definitions: Vec<KeyDef>,
    /// Filled by `describe_table` (extra calls), None from listings.
    pub ttl_attribute: Option<String>,
    pub ttl_status: Option<String>,
    pub pitr_status: Option<String>,
    pub error: Option<String>,
}

fn fmt_time(d: Option<&aws_sdk_dynamodb::primitives::DateTime>) -> Option<String> {
    d.and_then(|d| {
        d.fmt(aws_sdk_dynamodb::primitives::DateTimeFormat::DateTime)
            .ok()
    })
}

fn keys(schema: &[KeySchemaElement], defs: &[KeyDef]) -> (Option<KeyDef>, Option<KeyDef>) {
    let find = |kt: KeyType| {
        schema.iter().find(|k| *k.key_type() == kt).map(|k| KeyDef {
            name: k.attribute_name().to_string(),
            attr_type: defs
                .iter()
                .find(|d| d.name == k.attribute_name())
                .map(|d| d.attr_type.clone())
                .unwrap_or_default(),
        })
    };
    (find(KeyType::Hash), find(KeyType::Range))
}

fn projection(p: Option<&Projection>) -> (String, Vec<String>) {
    match p {
        Some(p) => (
            p.projection_type()
                .map(|t| t.as_str().to_string())
                .unwrap_or_else(|| "ALL".into()),
            p.non_key_attributes().to_vec(),
        ),
        None => ("ALL".into(), Vec::new()),
    }
}

fn capacity(p: Option<&ProvisionedThroughputDescription>) -> (Option<i64>, Option<i64>) {
    match p {
        Some(p) => (
            p.read_capacity_units().filter(|n| *n > 0),
            p.write_capacity_units().filter(|n| *n > 0),
        ),
        None => (None, None),
    }
}

/// Converts the SDK description into our shape.
pub fn table_info(t: &TableDescription) -> TableInfo {
    let defs: Vec<KeyDef> = t
        .attribute_definitions()
        .iter()
        .map(|d| KeyDef {
            name: d.attribute_name().to_string(),
            attr_type: d.attribute_type().as_str().to_string(),
        })
        .collect();
    let (pk, sk) = keys(t.key_schema(), &defs);
    let (rcu, wcu) = capacity(t.provisioned_throughput());
    let mut indexes = Vec::new();
    for g in t.global_secondary_indexes() {
        let (pk, sk) = keys(g.key_schema(), &defs);
        let (proj, nka) = projection(g.projection());
        let (r, w) = capacity(g.provisioned_throughput());
        indexes.push(IndexInfo {
            name: g.index_name().unwrap_or_default().to_string(),
            kind: "GSI".into(),
            partition_key: pk,
            sort_key: sk,
            projection: proj,
            non_key_attributes: nka,
            status: g.index_status().map(|s| s.as_str().to_string()),
            item_count: g.item_count(),
            size_bytes: g.index_size_bytes(),
            read_capacity: r,
            write_capacity: w,
            backfilling: g.backfilling().unwrap_or(false),
        });
    }
    for l in t.local_secondary_indexes() {
        let (pk, sk) = keys(l.key_schema(), &defs);
        let (proj, nka) = projection(l.projection());
        indexes.push(IndexInfo {
            name: l.index_name().unwrap_or_default().to_string(),
            kind: "LSI".into(),
            partition_key: pk,
            sort_key: sk,
            projection: proj,
            non_key_attributes: nka,
            item_count: l.item_count(),
            size_bytes: l.index_size_bytes(),
            ..Default::default()
        });
    }
    let billing = t
        .billing_mode_summary()
        .and_then(|b| b.billing_mode())
        .map(|b| b.as_str().to_string())
        .or_else(|| {
            Some(if rcu.is_some() {
                "PROVISIONED".into()
            } else {
                "PAY_PER_REQUEST".into()
            })
        });
    TableInfo {
        name: t.table_name().unwrap_or_default().to_string(),
        arn: t.table_arn().map(String::from),
        status: t.table_status().map(|s| s.as_str().to_string()),
        partition_key: pk,
        sort_key: sk,
        item_count: t.item_count(),
        size_bytes: t.table_size_bytes(),
        billing_mode: billing,
        read_capacity: rcu,
        write_capacity: wcu,
        table_class: t
            .table_class_summary()
            .and_then(|c| c.table_class())
            .map(|c| c.as_str().to_string()),
        created: fmt_time(t.creation_date_time()),
        deletion_protection: t.deletion_protection_enabled().unwrap_or(false),
        stream_enabled: t.stream_specification().is_some_and(|s| s.stream_enabled()),
        stream_view_type: t
            .stream_specification()
            .and_then(|s| s.stream_view_type())
            .map(|v| v.as_str().to_string()),
        stream_arn: t.latest_stream_arn().map(String::from),
        sse: t.sse_description().map(|s| {
            let ty = s
                .sse_type()
                .map(|t| t.as_str().to_string())
                .unwrap_or_else(|| "KMS".into());
            match s.kms_master_key_arn() {
                Some(k) => format!("{ty} ({k})"),
                None => ty,
            }
        }),
        indexes,
        attribute_definitions: defs,
        ..Default::default()
    }
}

/// All table names (paginated).
pub async fn list_table_names(conn: &Connection) -> Result<Vec<String>, AppError> {
    let client = client(conn);
    let mut names = Vec::new();
    let mut start = None;
    loop {
        let out = client
            .list_tables()
            .set_exclusive_start_table_name(start)
            .limit(100)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        names.extend(out.table_names().iter().cloned());
        start = out.last_evaluated_table_name().map(String::from);
        if start.is_none() {
            break;
        }
    }
    Ok(names)
}

/// Tables with their descriptions (tests only; the UI pages with details_many).
#[cfg(test)]
pub async fn list_tables(conn: &Connection) -> Result<Vec<TableInfo>, AppError> {
    let names = list_table_names(conn).await?;
    details_many(conn, &names).await
}

/// Descriptions of the given tables (the visible page), DescribeTable 8 at a
/// time, in the order given. A table that can't be read gets `error` set.
pub async fn details_many(conn: &Connection, names: &[String]) -> Result<Vec<TableInfo>, AppError> {
    let client = client(conn);
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(DESCRIBE_CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    for (i, name) in names.iter().enumerate() {
        let (client, name, sem) = (client.clone(), name.clone(), sem.clone());
        let (profile, endpoint) = (conn.info.profile.clone(), conn.info.endpoint_url.clone());
        set.spawn(async move {
            let _permit = sem.acquire().await;
            let r = client
                .describe_table()
                .table_name(&name)
                .send()
                .await
                .map_err(|e| AppError::from_sdk(e, &profile, endpoint.as_deref()));
            (i, r.map(|o| o.table().map(table_info)))
        });
    }
    let mut out: Vec<TableInfo> = names
        .iter()
        .map(|n| TableInfo {
            name: n.clone(),
            ..Default::default()
        })
        .collect();
    while let Some(joined) = set.join_next().await {
        let Ok((i, r)) = joined else { continue };
        match r {
            Ok(Some(t)) => out[i] = t,
            Ok(None) => {}
            Err(e) => out[i].error = Some(e.message),
        }
    }
    Ok(out)
}

/// Full description of one table, including TTL and point-in-time recovery.
pub async fn describe_table(conn: &Connection, name: &str) -> Result<TableInfo, AppError> {
    let client = client(conn);
    let out = client
        .describe_table()
        .table_name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let mut t = out
        .table()
        .map(table_info)
        .ok_or_else(|| other(format!("No description for {name}")))?;
    // These two can fail on emulators or without permission; leave them blank then.
    if let Ok(ttl) = client.describe_time_to_live().table_name(name).send().await {
        if let Some(d) = ttl.time_to_live_description() {
            t.ttl_status = d.time_to_live_status().map(|s| s.as_str().to_string());
            t.ttl_attribute = d.attribute_name().map(String::from);
        }
    }
    if let Ok(cb) = client
        .describe_continuous_backups()
        .table_name(name)
        .send()
        .await
    {
        t.pitr_status = cb
            .continuous_backups_description()
            .and_then(|c| c.point_in_time_recovery_description())
            .and_then(|p| p.point_in_time_recovery_status())
            .map(|s| s.as_str().to_string());
    }
    Ok(t)
}

pub async fn list_tags(conn: &Connection, arn: &str) -> Result<Vec<(String, String)>, AppError> {
    let client = client(conn);
    let mut tags = Vec::new();
    let mut token = None;
    loop {
        let out = client
            .list_tags_of_resource()
            .resource_arn(arn)
            .set_next_token(token)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        tags.extend(
            out.tags()
                .iter()
                .map(|t| (t.key().to_string(), t.value().to_string())),
        );
        token = out.next_token().map(String::from);
        if token.is_none() {
            break;
        }
    }
    tags.sort();
    Ok(tags)
}

#[cfg(test)]
pub(crate) mod emulator_tests {
    use super::*;
    use aws_sdk_dynamodb::types::{
        AttributeDefinition, BillingMode, GlobalSecondaryIndex, ProjectionType, ScalarAttributeType,
    };

    pub(crate) async fn connect() -> Connection {
        crate::sqs::emulator_tests::connect().await
    }

    /// Fresh table `name` with pk (S) + sk (N) and a GSI "byStatus" on status (S).
    pub(crate) async fn fresh_table(conn: &Connection, name: &str) {
        let c = client(conn);
        let _ = c.delete_table().table_name(name).send().await;
        let ks = |n: &str, t: KeyType| {
            KeySchemaElement::builder()
                .attribute_name(n)
                .key_type(t)
                .build()
                .unwrap()
        };
        let ad = |n: &str, t: ScalarAttributeType| {
            AttributeDefinition::builder()
                .attribute_name(n)
                .attribute_type(t)
                .build()
                .unwrap()
        };
        c.create_table()
            .table_name(name)
            .billing_mode(BillingMode::PayPerRequest)
            .key_schema(ks("pk", KeyType::Hash))
            .key_schema(ks("sk", KeyType::Range))
            .attribute_definitions(ad("pk", ScalarAttributeType::S))
            .attribute_definitions(ad("sk", ScalarAttributeType::N))
            .attribute_definitions(ad("status", ScalarAttributeType::S))
            .global_secondary_indexes(
                GlobalSecondaryIndex::builder()
                    .index_name("byStatus")
                    .key_schema(ks("status", KeyType::Hash))
                    .projection(
                        Projection::builder()
                            .projection_type(ProjectionType::All)
                            .build(),
                    )
                    .build()
                    .unwrap(),
            )
            .send()
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn lists_and_describes_tables() {
        let conn = connect().await;
        fresh_table(&conn, "s3x-ddb-orders").await;
        let names = list_table_names(&conn).await.unwrap();
        assert!(names.contains(&"s3x-ddb-orders".to_string()));
        let one = details_many(&conn, &["s3x-ddb-orders".to_string()])
            .await
            .unwrap();
        assert_eq!(one[0].partition_key.as_ref().unwrap().name, "pk");
        let all = list_tables(&conn).await.unwrap();
        let t = all
            .iter()
            .find(|t| t.name == "s3x-ddb-orders")
            .expect("listed");
        assert_eq!(t.partition_key.as_ref().unwrap().name, "pk");
        assert_eq!(t.partition_key.as_ref().unwrap().attr_type, "S");
        assert_eq!(t.sort_key.as_ref().unwrap().attr_type, "N");
        assert_eq!(t.billing_mode.as_deref(), Some("PAY_PER_REQUEST"));
        assert_eq!(t.indexes.len(), 1);
        assert_eq!(t.indexes[0].kind, "GSI");
        assert_eq!(t.indexes[0].partition_key.as_ref().unwrap().name, "status");
        let d = describe_table(&conn, "s3x-ddb-orders").await.unwrap();
        assert!(d.arn.is_some());
        assert!(list_tags(&conn, d.arn.as_ref().unwrap())
            .await
            .unwrap()
            .is_empty());
    }
}
