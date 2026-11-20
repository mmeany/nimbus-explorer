//! ElastiCache: Redis / Valkey replication groups (shards and nodes) and
//! serverless caches. Memcached clusters are out of scope and not listed.

use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use aws_sdk_elasticache::types::{Endpoint as SdkEndpoint, ReplicationGroup, ServerlessCache};
use aws_sdk_elasticache::Client;
use aws_smithy_runtime_api::client::http::{
    HttpClient, HttpConnector, HttpConnectorFuture, HttpConnectorSettings, SharedHttpClient,
    SharedHttpConnector,
};
use aws_smithy_runtime_api::client::orchestrator::HttpRequest;
use aws_smithy_runtime_api::client::result::ConnectorError;
use aws_smithy_runtime_api::client::runtime_components::RuntimeComponents;
use aws_smithy_types::body::SdkBody;
use aws_smithy_types::byte_stream::ByteStream;
use serde::Serialize;

pub fn client(conn: &Connection) -> Client {
    let cfg = conn.service_config();
    // Emulators (custom endpoints only) may send dates as epoch numbers in
    // their XML, which the SDK refuses; real AWS responses pass through as is.
    match (&conn.info.endpoint_url, cfg.http_client()) {
        (Some(_), Some(http)) => Client::from_conf(
            aws_sdk_elasticache::config::Builder::from(&cfg)
                .http_client(EpochDatesClient(http))
                .build(),
        ),
        _ => Client::new(&cfg),
    }
}

/// An HTTP client that rewrites epoch-number dates in responses (see `fix_epoch_dates`).
#[derive(Debug)]
struct EpochDatesClient(SharedHttpClient);

impl HttpClient for EpochDatesClient {
    fn http_connector(
        &self,
        settings: &HttpConnectorSettings,
        components: &RuntimeComponents,
    ) -> SharedHttpConnector {
        SharedHttpConnector::new(EpochDatesConnector(
            self.0.http_connector(settings, components),
        ))
    }
}

#[derive(Debug)]
struct EpochDatesConnector(SharedHttpConnector);

impl HttpConnector for EpochDatesConnector {
    fn call(&self, request: HttpRequest) -> HttpConnectorFuture {
        let inner = self.0.call(request);
        HttpConnectorFuture::new(async move {
            let mut resp = inner.await?;
            let body = resp.take_body();
            let bytes = ByteStream::new(body)
                .collect()
                .await
                .map_err(|e| ConnectorError::io(e.into()))?
                .into_bytes();
            *resp.body_mut() = SdkBody::from(fix_epoch_dates(&bytes));
            Ok(resp)
        })
    }
}

/// In XML, `<SomethingTime>1795044334.83</SomethingTime>` (or `…Date`) becomes
/// an ISO date. Anything else, including non-UTF-8 bodies, is left alone.
pub fn fix_epoch_dates(body: &[u8]) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(body) else {
        return body.to_vec();
    };
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        rest = &rest[open..];
        let Some(gt) = rest.find('>') else { break };
        let tag = &rest[1..gt];
        let simple = !tag.is_empty() && tag.chars().all(|c| c.is_ascii_alphanumeric());
        if simple && (tag.ends_with("Time") || tag.ends_with("Date")) {
            let after = &rest[gt + 1..];
            let close = format!("</{tag}>");
            if let Some(end) = after.find(&close) {
                let value = &after[..end];
                let numeric = !value.is_empty()
                    && value.chars().all(|c| c.is_ascii_digit() || c == '.')
                    && value.chars().filter(|c| *c == '.').count() <= 1;
                if numeric {
                    if let Some(iso) = value
                        .parse::<f64>()
                        .ok()
                        .and_then(|s| iso(Some(&aws_smithy_types::DateTime::from_secs_f64(s))))
                    {
                        out.push_str(&format!("<{tag}>{iso}{close}"));
                        rest = &after[end + close.len()..];
                        continue;
                    }
                }
            }
        }
        out.push_str(&rest[..=gt]);
        rest = &rest[gt + 1..];
    }
    out.push_str(rest);
    out.into_bytes()
}

#[cfg(test)]
mod epoch_tests {
    use super::fix_epoch_dates;

    #[test]
    fn rewrites_epoch_dates_only() {
        let xml = b"<A><SnapshotCreateTime>1767225600.5</SnapshotCreateTime><Name>123</Name><CreateTime>2026-01-01T00:00:00Z</CreateTime><Port>6379</Port><StartTime>1767225600</StartTime></A>";
        let out = String::from_utf8(fix_epoch_dates(xml)).unwrap();
        assert_eq!(
            out,
            "<A><SnapshotCreateTime>2026-01-01T00:00:00.5Z</SnapshotCreateTime><Name>123</Name><CreateTime>2026-01-01T00:00:00Z</CreateTime><Port>6379</Port><StartTime>2026-01-01T00:00:00Z</StartTime></A>"
        );
        assert_eq!(fix_epoch_dates(b"no tags"), b"no tags");
        assert_eq!(fix_epoch_dates(&[0xff, 0xfe]), vec![0xff, 0xfe]);
        assert_eq!(
            fix_epoch_dates(b"<a>1.2.3</a><xTime>1.2.3</xTime><unclosed"),
            b"<a>1.2.3</a><xTime>1.2.3</xTime><unclosed"
        );
    }
}

pub(crate) fn err(conn: &Connection, e: impl std::error::Error) -> AppError {
    AppError::from_sdk(e, &conn.info.profile, conn.info.endpoint_url.as_deref())
}

pub(crate) fn other(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Other, msg)
}

pub(crate) fn iso(d: Option<&aws_smithy_types::DateTime>) -> Option<String> {
    d.and_then(|d| d.fmt(aws_smithy_types::date_time::Format::DateTime).ok())
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub address: String,
    pub port: Option<i32>,
}

fn endpoint(e: Option<&SdkEndpoint>) -> Option<Endpoint> {
    let e = e?;
    Some(Endpoint {
        address: e.address()?.to_string(),
        port: e.port(),
    })
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub cluster_id: String,
    pub node_id: Option<String>,
    /// primary or replica (cluster mode off only).
    pub role: Option<String>,
    pub az: Option<String>,
    pub endpoint: Option<Endpoint>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Shard {
    pub id: String,
    pub status: Option<String>,
    /// Hash slots, e.g. "0-5461" (cluster mode on).
    pub slots: Option<String>,
    pub primary_endpoint: Option<Endpoint>,
    pub reader_endpoint: Option<Endpoint>,
    pub members: Vec<Member>,
}

/// A replication group as DescribeReplicationGroups returns it (enough for the
/// list and the tree; details add the member clusters' settings and tags).
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub arn: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    /// redis or valkey.
    pub engine: Option<String>,
    pub node_type: Option<String>,
    pub cluster_mode: bool,
    pub shards: Vec<Shard>,
    pub member_count: usize,
    pub automatic_failover: Option<String>,
    pub multi_az: Option<String>,
    /// Cluster mode on.
    pub configuration_endpoint: Option<Endpoint>,
    pub transit_encryption: bool,
    pub transit_encryption_mode: Option<String>,
    pub at_rest_encryption: bool,
    pub kms_key_id: Option<String>,
    pub auth_token: bool,
    pub auth_token_last_modified: Option<String>,
    pub user_group_ids: Vec<String>,
    pub snapshot_retention: Option<i32>,
    pub snapshot_window: Option<String>,
    pub snapshotting_cluster: Option<String>,
    pub data_tiering: Option<String>,
    pub network_type: Option<String>,
    pub ip_discovery: Option<String>,
    pub auto_minor_version_upgrade: Option<bool>,
    pub global_datastore: Option<String>,
    pub global_datastore_role: Option<String>,
    pub created: Option<String>,
    /// Logs delivered: "slow-log → cloudwatch-logs (active)".
    pub log_delivery: Vec<String>,
    /// Changes waiting to apply, as "what: value".
    pub pending: Vec<String>,
}

fn group(g: &ReplicationGroup) -> Group {
    let shards: Vec<Shard> = g
        .node_groups()
        .iter()
        .map(|n| Shard {
            id: n.node_group_id().unwrap_or_default().to_string(),
            status: n.status().map(String::from),
            slots: n.slots().map(String::from),
            primary_endpoint: endpoint(n.primary_endpoint()),
            reader_endpoint: endpoint(n.reader_endpoint()),
            members: n
                .node_group_members()
                .iter()
                .map(|m| Member {
                    cluster_id: m.cache_cluster_id().unwrap_or_default().to_string(),
                    node_id: m.cache_node_id().map(String::from),
                    role: m.current_role().map(String::from),
                    az: m.preferred_availability_zone().map(String::from),
                    endpoint: endpoint(m.read_endpoint()),
                })
                .collect(),
        })
        .collect();
    let mut pending = Vec::new();
    if let Some(p) = g.pending_modified_values() {
        if let Some(v) = p.primary_cluster_id() {
            pending.push(format!("primary: {v}"));
        }
        if let Some(v) = p.automatic_failover_status() {
            pending.push(format!("automatic failover: {}", v.as_str()));
        }
        if p.resharding().is_some() {
            pending.push("resharding in progress".into());
        }
        if let Some(v) = p.auth_token_status() {
            pending.push(format!("auth token: {}", v.as_str()));
        }
        if p.user_groups().is_some() {
            pending.push("user groups".into());
        }
        if let Some(v) = p.transit_encryption_mode() {
            pending.push(format!("transit encryption: {}", v.as_str()));
        }
        if let Some(v) = p.cluster_mode() {
            pending.push(format!("cluster mode: {}", v.as_str()));
        }
    }
    Group {
        id: g.replication_group_id().unwrap_or_default().to_string(),
        arn: g.arn().map(String::from),
        description: g.description().filter(|d| !d.is_empty()).map(String::from),
        status: g.status().map(String::from),
        engine: g.engine().map(String::from),
        node_type: g.cache_node_type().map(String::from),
        cluster_mode: g.cluster_enabled().unwrap_or(false),
        member_count: g.member_clusters().len(),
        shards,
        automatic_failover: g.automatic_failover().map(|v| v.as_str().to_string()),
        multi_az: g.multi_az().map(|v| v.as_str().to_string()),
        configuration_endpoint: endpoint(g.configuration_endpoint()),
        transit_encryption: g.transit_encryption_enabled().unwrap_or(false),
        transit_encryption_mode: g.transit_encryption_mode().map(|v| v.as_str().to_string()),
        at_rest_encryption: g.at_rest_encryption_enabled().unwrap_or(false),
        kms_key_id: g.kms_key_id().map(String::from),
        auth_token: g.auth_token_enabled().unwrap_or(false),
        auth_token_last_modified: iso(g.auth_token_last_modified_date()),
        user_group_ids: g.user_group_ids().to_vec(),
        snapshot_retention: g.snapshot_retention_limit(),
        snapshot_window: g.snapshot_window().map(String::from),
        snapshotting_cluster: g.snapshotting_cluster_id().map(String::from),
        data_tiering: g.data_tiering().map(|v| v.as_str().to_string()),
        network_type: g.network_type().map(|v| v.as_str().to_string()),
        ip_discovery: g.ip_discovery().map(|v| v.as_str().to_string()),
        auto_minor_version_upgrade: g.auto_minor_version_upgrade(),
        global_datastore: g
            .global_replication_group_info()
            .and_then(|i| i.global_replication_group_id())
            .map(String::from),
        global_datastore_role: g
            .global_replication_group_info()
            .and_then(|i| i.global_replication_group_member_role())
            .map(String::from),
        created: iso(g.replication_group_create_time()),
        log_delivery: g
            .log_delivery_configurations()
            .iter()
            .map(|l| {
                format!(
                    "{} → {}{}",
                    l.log_type().map(|t| t.as_str()).unwrap_or("log"),
                    l.destination_type().map(|t| t.as_str()).unwrap_or("?"),
                    l.status()
                        .map(|s| format!(" ({})", s.as_str()))
                        .unwrap_or_default()
                )
            })
            .collect(),
        pending,
    }
}

/// Every Redis / Valkey replication group in the region (100 per call), by id.
pub async fn list_groups(conn: &Connection) -> Result<Vec<Group>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut marker: Option<String> = None;
    loop {
        let page = c
            .describe_replication_groups()
            .max_records(100)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.replication_groups().iter().map(group));
        match page.marker() {
            Some(m) if !m.is_empty() && Some(m) != marker.as_deref() => {
                marker = Some(m.to_string())
            }
            _ => break,
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub storage_min: Option<i32>,
    pub storage_max: Option<i32>,
    /// GB.
    pub storage_unit: Option<String>,
    pub ecpu_min: Option<i32>,
    pub ecpu_max: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Serverless {
    pub name: String,
    pub arn: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub engine: Option<String>,
    pub engine_version: Option<String>,
    pub endpoint: Option<Endpoint>,
    pub reader_endpoint: Option<Endpoint>,
    pub limits: Option<Limits>,
    pub security_groups: Vec<String>,
    pub subnets: Vec<String>,
    pub kms_key_id: Option<String>,
    pub user_group_id: Option<String>,
    pub snapshot_retention: Option<i32>,
    pub daily_snapshot_time: Option<String>,
    pub network_type: Option<String>,
    pub created: Option<String>,
    /// Only from `serverless_details`.
    pub tags: Vec<(String, String)>,
}

fn serverless(s: &ServerlessCache) -> Serverless {
    Serverless {
        name: s.serverless_cache_name().unwrap_or_default().to_string(),
        arn: s.arn().map(String::from),
        description: s.description().filter(|d| !d.is_empty()).map(String::from),
        status: s.status().map(String::from),
        engine: s.engine().map(String::from),
        engine_version: s
            .full_engine_version()
            .or(s.major_engine_version())
            .map(String::from),
        endpoint: endpoint(s.endpoint()),
        reader_endpoint: endpoint(s.reader_endpoint()),
        limits: s.cache_usage_limits().map(|l| Limits {
            storage_min: l.data_storage().and_then(|d| d.minimum()),
            storage_max: l.data_storage().and_then(|d| d.maximum()),
            storage_unit: l
                .data_storage()
                .and_then(|d| d.unit())
                .map(|u| u.as_str().to_string()),
            ecpu_min: l.ecpu_per_second().and_then(|e| e.minimum()),
            ecpu_max: l.ecpu_per_second().and_then(|e| e.maximum()),
        }),
        security_groups: s.security_group_ids().to_vec(),
        subnets: s.subnet_ids().to_vec(),
        kms_key_id: s.kms_key_id().map(String::from),
        user_group_id: s.user_group_id().map(String::from),
        snapshot_retention: s.snapshot_retention_limit(),
        daily_snapshot_time: s.daily_snapshot_time().map(String::from),
        network_type: s.network_type().map(|v| v.as_str().to_string()),
        created: iso(s.create_time()),
        tags: Vec::new(),
    }
}

/// Every serverless cache in the region (Memcached ones included; they're
/// serverless, so nothing to manage per node), by name.
pub async fn list_serverless(conn: &Connection) -> Result<Vec<Serverless>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .describe_serverless_caches()
            .max_results(50)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.serverless_caches().iter().map(serverless));
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Settings that live on the member clusters (the same on every member).
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemberSettings {
    pub engine_version: Option<String>,
    pub parameter_group: Option<String>,
    pub parameter_status: Option<String>,
    pub subnet_group: Option<String>,
    pub security_groups: Vec<String>,
    pub maintenance_window: Option<String>,
    pub notification_topic: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GroupDetails {
    #[serde(flatten)]
    pub group: Group,
    pub settings: Option<MemberSettings>,
    pub tags: Vec<(String, String)>,
}

async fn tags(c: &Client, arn: Option<&str>) -> Vec<(String, String)> {
    let Some(arn) = arn else { return Vec::new() };
    // Not every emulator has tags; the details are still useful without them.
    let Ok(out) = c.list_tags_for_resource().resource_name(arn).send().await else {
        return Vec::new();
    };
    let mut t: Vec<(String, String)> = out
        .tag_list()
        .iter()
        .map(|t| {
            (
                t.key().unwrap_or_default().to_string(),
                t.value().unwrap_or_default().to_string(),
            )
        })
        .collect();
    t.sort();
    t
}

pub async fn group_details(conn: &Connection, id: &str) -> Result<GroupDetails, AppError> {
    let c = client(conn);
    let out = c
        .describe_replication_groups()
        .replication_group_id(id)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let g = out
        .replication_groups()
        .first()
        .map(group)
        .ok_or_else(|| other(format!("There's no replication group called {id}.")))?;
    // Engine version, parameter group, subnet group and so on are per member
    // cluster (and the same on all of them): read one.
    let first = g
        .shards
        .iter()
        .flat_map(|s| s.members.iter())
        .next()
        .map(|m| m.cluster_id.clone());
    let mut settings = None;
    if let Some(cluster) = first {
        if let Ok(cc) = c
            .describe_cache_clusters()
            .cache_cluster_id(&cluster)
            .send()
            .await
        {
            settings = cc.cache_clusters().first().map(|m| MemberSettings {
                engine_version: m.engine_version().map(String::from),
                parameter_group: m
                    .cache_parameter_group()
                    .and_then(|p| p.cache_parameter_group_name())
                    .map(String::from),
                parameter_status: m
                    .cache_parameter_group()
                    .and_then(|p| p.parameter_apply_status())
                    .map(String::from),
                subnet_group: m.cache_subnet_group_name().map(String::from),
                security_groups: m
                    .security_groups()
                    .iter()
                    .filter_map(|s| s.security_group_id())
                    .map(String::from)
                    .collect(),
                maintenance_window: m.preferred_maintenance_window().map(String::from),
                notification_topic: m
                    .notification_configuration()
                    .and_then(|n| n.topic_arn())
                    .map(String::from),
            });
        }
    }
    let tags = tags(&c, g.arn.as_deref()).await;
    Ok(GroupDetails {
        group: g,
        settings,
        tags,
    })
}

pub async fn serverless_details(conn: &Connection, name: &str) -> Result<Serverless, AppError> {
    let c = client(conn);
    let out = c
        .describe_serverless_caches()
        .serverless_cache_name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let mut s = out
        .serverless_caches()
        .first()
        .map(serverless)
        .ok_or_else(|| other(format!("There's no serverless cache called {name}.")))?;
    s.tags = tags(&c, s.arn.as_deref()).await;
    Ok(s)
}

#[cfg(test)]
pub(crate) mod emulator_tests {
    use super::*;

    pub(crate) async fn connect() -> Connection {
        crate::sqs::emulator_tests::connect().await
    }

    /// A small cluster-mode-off group (primary + one replica), created if missing.
    pub(crate) async fn ensure_group(conn: &Connection, id: &str) {
        let c = client(conn);
        if c.describe_replication_groups()
            .replication_group_id(id)
            .send()
            .await
            .is_ok()
        {
            return;
        }
        c.create_replication_group()
            .replication_group_id(id)
            .replication_group_description("test group")
            .engine("valkey")
            .cache_node_type("cache.t4g.micro")
            .num_cache_clusters(2)
            .automatic_failover_enabled(true)
            .send()
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn browses_groups_and_serverless_caches() {
        let conn = connect().await;
        ensure_group(&conn, "s3x-ec-browse").await;
        let c = client(&conn);
        if c.describe_serverless_caches()
            .serverless_cache_name("s3x-ec-sl")
            .send()
            .await
            .is_err()
        {
            c.create_serverless_cache()
                .serverless_cache_name("s3x-ec-sl")
                .engine("valkey")
                .send()
                .await
                .unwrap();
        }

        let groups = list_groups(&conn).await.unwrap();
        let g = groups
            .iter()
            .find(|g| g.id == "s3x-ec-browse")
            .expect("listed");
        assert!(!g.cluster_mode);
        assert_eq!(g.shards.len(), 1);
        assert_eq!(g.member_count, 2);
        assert!(g.shards[0]
            .members
            .iter()
            .any(|m| m.role.as_deref() == Some("primary")));

        let d = group_details(&conn, "s3x-ec-browse").await.unwrap();
        assert!(d
            .settings
            .as_ref()
            .and_then(|s| s.engine_version.as_ref())
            .is_some());
        assert!(group_details(&conn, "s3x-ec-missing").await.is_err());

        let sl = list_serverless(&conn).await.unwrap();
        assert!(sl.iter().any(|s| s.name == "s3x-ec-sl"));
        let s = serverless_details(&conn, "s3x-ec-sl").await.unwrap();
        assert_eq!(s.engine.as_deref(), Some("valkey"));
    }
}
