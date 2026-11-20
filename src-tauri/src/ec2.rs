//! EC2 instances: the region's instances (listed in full) and one instance's
//! details with its volumes, network interfaces, security groups (rules
//! resolved), protection flags and IAM role.

use crate::ec2_network::{self, SecurityGroup};
use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use aws_sdk_ec2::types::{
    Filter, Instance as SdkInstance, InstanceAttributeName, NetworkInterface, Tag, Volume as SdkVolume,
};
use aws_sdk_ec2::Client;
use serde::Serialize;

pub fn client(conn: &Connection) -> Client {
    Client::new(&conn.service_config())
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

pub(crate) fn filter(name: &str, values: &[&str]) -> Filter {
    Filter::builder()
        .name(name)
        .set_values(Some(values.iter().map(|v| v.to_string()).collect()))
        .build()
}

/// Tags sorted by key.
pub(crate) fn tags(t: &[Tag]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = t
        .iter()
        .map(|t| {
            (
                t.key().unwrap_or_default().to_string(),
                t.value().unwrap_or_default().to_string(),
            )
        })
        .collect();
    out.sort();
    out
}

pub(crate) fn tag<'a>(t: &'a [Tag], key: &str) -> Option<&'a str> {
    t.iter()
        .find(|t| t.key() == Some(key))
        .and_then(|t| t.value())
        .filter(|v| !v.is_empty())
}

/// A security group as an instance or interface names it.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupRef {
    pub id: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BlockDevice {
    pub device: String,
    pub volume_id: Option<String>,
    pub status: Option<String>,
    pub delete_on_termination: Option<bool>,
    pub attached: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    /// The Name tag.
    pub name: Option<String>,
    pub state: Option<String>,
    pub state_reason: Option<String>,
    pub state_transition_reason: Option<String>,
    pub instance_type: Option<String>,
    pub az: Option<String>,
    pub tenancy: Option<String>,
    pub private_ip: Option<String>,
    pub private_dns: Option<String>,
    pub public_ip: Option<String>,
    pub public_dns: Option<String>,
    pub ipv6: Option<String>,
    pub launched: Option<String>,
    /// "Linux/UNIX", "Windows", …
    pub platform: Option<String>,
    pub windows: bool,
    pub architecture: Option<String>,
    pub vpc_id: Option<String>,
    pub subnet_id: Option<String>,
    pub key_name: Option<String>,
    pub image_id: Option<String>,
    pub security_groups: Vec<GroupRef>,
    pub iam_profile_arn: Option<String>,
    /// From the aws:autoscaling:groupName tag.
    pub auto_scaling_group: Option<String>,
    /// "spot" or "scheduled"; None = on demand.
    pub lifecycle: Option<String>,
    pub monitoring: Option<String>,
    pub ebs_optimized: Option<bool>,
    pub root_device: Option<String>,
    pub root_device_type: Option<String>,
    pub block_devices: Vec<BlockDevice>,
    pub interface_count: usize,
    pub hibernation: bool,
    /// "required" = IMDSv2 only.
    pub metadata_tokens: Option<String>,
    pub metadata_endpoint: Option<String>,
    pub metadata_hop_limit: Option<i32>,
    pub cpu_cores: Option<i32>,
    pub threads_per_core: Option<i32>,
    pub boot_mode: Option<String>,
    pub virtualization: Option<String>,
    pub ena_support: Option<bool>,
    pub source_dest_check: Option<bool>,
    pub owner_id: Option<String>,
    pub tags: Vec<(String, String)>,
}

pub(crate) fn instance(i: &SdkInstance, owner: Option<&str>) -> Instance {
    let ts = i.tags();
    Instance {
        id: i.instance_id().unwrap_or_default().to_string(),
        name: tag(ts, "Name").map(String::from),
        state: i
            .state()
            .and_then(|s| s.name())
            .map(|n| n.as_str().to_string()),
        state_reason: i.state_reason().and_then(|r| r.message()).map(String::from),
        state_transition_reason: i
            .state_transition_reason()
            .filter(|s| !s.is_empty())
            .map(String::from),
        instance_type: i.instance_type().map(|t| t.as_str().to_string()),
        az: i
            .placement()
            .and_then(|p| p.availability_zone())
            .map(String::from),
        tenancy: i
            .placement()
            .and_then(|p| p.tenancy())
            .map(|t| t.as_str().to_string()),
        private_ip: i.private_ip_address().map(String::from),
        private_dns: i
            .private_dns_name()
            .filter(|s| !s.is_empty())
            .map(String::from),
        public_ip: i.public_ip_address().map(String::from),
        public_dns: i
            .public_dns_name()
            .filter(|s| !s.is_empty())
            .map(String::from),
        ipv6: i.ipv6_address().map(String::from),
        launched: iso(i.launch_time()),
        platform: i.platform_details().map(String::from),
        windows: i.platform().map(|p| p.as_str() == "windows").unwrap_or(false),
        architecture: i.architecture().map(|a| a.as_str().to_string()),
        vpc_id: i.vpc_id().map(String::from),
        subnet_id: i.subnet_id().map(String::from),
        key_name: i.key_name().map(String::from),
        image_id: i.image_id().map(String::from),
        security_groups: i
            .security_groups()
            .iter()
            .map(|g| GroupRef {
                id: g.group_id().unwrap_or_default().to_string(),
                name: g.group_name().map(String::from),
            })
            .collect(),
        iam_profile_arn: i.iam_instance_profile().and_then(|p| p.arn()).map(String::from),
        auto_scaling_group: tag(ts, "aws:autoscaling:groupName").map(String::from),
        lifecycle: i.instance_lifecycle().map(|l| l.as_str().to_string()),
        monitoring: i
            .monitoring()
            .and_then(|m| m.state())
            .map(|s| s.as_str().to_string()),
        ebs_optimized: i.ebs_optimized(),
        root_device: i.root_device_name().map(String::from),
        root_device_type: i.root_device_type().map(|t| t.as_str().to_string()),
        block_devices: i
            .block_device_mappings()
            .iter()
            .map(|b| BlockDevice {
                device: b.device_name().unwrap_or_default().to_string(),
                volume_id: b.ebs().and_then(|e| e.volume_id()).map(String::from),
                status: b.ebs().and_then(|e| e.status()).map(|s| s.as_str().to_string()),
                delete_on_termination: b.ebs().and_then(|e| e.delete_on_termination()),
                attached: iso(b.ebs().and_then(|e| e.attach_time())),
            })
            .collect(),
        interface_count: i.network_interfaces().len(),
        hibernation: i
            .hibernation_options()
            .and_then(|h| h.configured())
            .unwrap_or(false),
        metadata_tokens: i
            .metadata_options()
            .and_then(|m| m.http_tokens())
            .map(|t| t.as_str().to_string()),
        metadata_endpoint: i
            .metadata_options()
            .and_then(|m| m.http_endpoint())
            .map(|t| t.as_str().to_string()),
        metadata_hop_limit: i
            .metadata_options()
            .and_then(|m| m.http_put_response_hop_limit()),
        cpu_cores: i.cpu_options().and_then(|c| c.core_count()),
        threads_per_core: i.cpu_options().and_then(|c| c.threads_per_core()),
        boot_mode: i
            .current_instance_boot_mode()
            .map(|b| b.as_str().to_string()),
        virtualization: i
            .virtualization_type()
            .map(|v| v.as_str().to_string()),
        ena_support: i.ena_support(),
        source_dest_check: i.source_dest_check(),
        owner_id: owner.map(String::from),
        tags: tags(ts),
    }
}

/// Every instance in the region (terminated ones included while AWS still
/// lists them), 1,000 per call, newest launch first.
pub async fn list_instances(conn: &Connection) -> Result<Vec<Instance>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .describe_instances()
            .max_results(1000)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        for r in page.reservations() {
            out.extend(r.instances().iter().map(|i| instance(i, r.owner_id())));
        }
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| b.launched.cmp(&a.launched).then(a.id.cmp(&b.id)));
    Ok(out)
}

pub async fn get_instance(conn: &Connection, id: &str) -> Result<Instance, AppError> {
    let out = client(conn)
        .describe_instances()
        .instance_ids(id)
        .send()
        .await
        .map_err(|e| {
            if format!("{e:?}").contains("InvalidInstanceID") {
                other(format!("There's no instance {id} in this region."))
            } else {
                err(conn, e)
            }
        })?;
    out.reservations()
        .iter()
        .find_map(|r| r.instances().first().map(|i| instance(i, r.owner_id())))
        .ok_or_else(|| other(format!("There's no instance {id} in this region.")))
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VolumeAttachment {
    pub instance_id: Option<String>,
    pub device: Option<String>,
    pub state: Option<String>,
    pub delete_on_termination: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub id: String,
    pub name: Option<String>,
    pub size_gib: Option<i32>,
    pub volume_type: Option<String>,
    pub iops: Option<i32>,
    pub throughput: Option<i32>,
    pub encrypted: bool,
    pub kms_key_id: Option<String>,
    pub state: Option<String>,
    pub az: Option<String>,
    pub snapshot_id: Option<String>,
    pub created: Option<String>,
    pub multi_attach: bool,
    pub attachments: Vec<VolumeAttachment>,
    pub tags: Vec<(String, String)>,
}

pub(crate) fn volume(v: &SdkVolume) -> Volume {
    Volume {
        id: v.volume_id().unwrap_or_default().to_string(),
        name: tag(v.tags(), "Name").map(String::from),
        size_gib: v.size(),
        volume_type: v.volume_type().map(|t| t.as_str().to_string()),
        iops: v.iops(),
        throughput: v.throughput(),
        encrypted: v.encrypted().unwrap_or(false),
        kms_key_id: v.kms_key_id().map(String::from),
        state: v.state().map(|s| s.as_str().to_string()),
        az: v.availability_zone().map(String::from),
        snapshot_id: v.snapshot_id().filter(|s| !s.is_empty()).map(String::from),
        created: iso(v.create_time()),
        multi_attach: v.multi_attach_enabled().unwrap_or(false),
        attachments: v
            .attachments()
            .iter()
            .map(|a| VolumeAttachment {
                instance_id: a.instance_id().map(String::from),
                device: a.device().map(String::from),
                state: a.state().map(|s| s.as_str().to_string()),
                delete_on_termination: a.delete_on_termination(),
            })
            .collect(),
        tags: tags(v.tags()),
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrivateIp {
    pub address: String,
    pub primary: bool,
    pub public_ip: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Interface {
    pub id: String,
    pub description: Option<String>,
    pub interface_type: Option<String>,
    pub status: Option<String>,
    pub vpc_id: Option<String>,
    pub subnet_id: Option<String>,
    pub az: Option<String>,
    pub mac: Option<String>,
    pub private_ip: Option<String>,
    pub private_dns: Option<String>,
    pub private_ips: Vec<PrivateIp>,
    pub public_ip: Option<String>,
    pub public_dns: Option<String>,
    /// "amazon" for an auto-assigned address, else the owner of the Elastic IP.
    pub public_ip_owner: Option<String>,
    pub ipv6: Vec<String>,
    pub groups: Vec<GroupRef>,
    pub instance_id: Option<String>,
    pub device_index: Option<i32>,
    pub attachment_status: Option<String>,
    pub delete_on_termination: Option<bool>,
    pub source_dest_check: Option<bool>,
    /// Managed by a service (load balancers, NAT gateways, Lambda, …).
    pub requester_managed: bool,
    pub requester: Option<String>,
    pub tags: Vec<(String, String)>,
}

pub(crate) fn interface(n: &NetworkInterface) -> Interface {
    Interface {
        id: n.network_interface_id().unwrap_or_default().to_string(),
        description: n.description().filter(|s| !s.is_empty()).map(String::from),
        interface_type: n.interface_type().map(|t| t.as_str().to_string()),
        status: n.status().map(|s| s.as_str().to_string()),
        vpc_id: n.vpc_id().map(String::from),
        subnet_id: n.subnet_id().map(String::from),
        az: n.availability_zone().map(String::from),
        mac: n.mac_address().map(String::from),
        private_ip: n.private_ip_address().map(String::from),
        private_dns: n.private_dns_name().filter(|s| !s.is_empty()).map(String::from),
        private_ips: n
            .private_ip_addresses()
            .iter()
            .map(|p| PrivateIp {
                address: p.private_ip_address().unwrap_or_default().to_string(),
                primary: p.primary().unwrap_or(false),
                public_ip: p.association().and_then(|a| a.public_ip()).map(String::from),
            })
            .collect(),
        public_ip: n.association().and_then(|a| a.public_ip()).map(String::from),
        public_dns: n
            .association()
            .and_then(|a| a.public_dns_name())
            .filter(|s| !s.is_empty())
            .map(String::from),
        public_ip_owner: n.association().and_then(|a| a.ip_owner_id()).map(String::from),
        ipv6: n
            .ipv6_addresses()
            .iter()
            .filter_map(|a| a.ipv6_address())
            .map(String::from)
            .collect(),
        groups: n
            .groups()
            .iter()
            .map(|g| GroupRef {
                id: g.group_id().unwrap_or_default().to_string(),
                name: g.group_name().map(String::from),
            })
            .collect(),
        instance_id: n.attachment().and_then(|a| a.instance_id()).map(String::from),
        device_index: n.attachment().and_then(|a| a.device_index()),
        attachment_status: n
            .attachment()
            .and_then(|a| a.status())
            .map(|s| s.as_str().to_string()),
        delete_on_termination: n.attachment().and_then(|a| a.delete_on_termination()),
        source_dest_check: n.source_dest_check(),
        requester_managed: n.requester_managed().unwrap_or(false),
        requester: n.requester_id().map(String::from),
        tags: tags(n.tag_set()),
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstanceDetails {
    #[serde(flatten)]
    pub instance: Instance,
    pub volumes: Vec<Volume>,
    pub interfaces: Vec<Interface>,
    pub groups: Vec<SecurityGroup>,
    /// None = couldn't be read (permissions, emulator).
    pub termination_protection: Option<bool>,
    pub stop_protection: Option<bool>,
    pub shutdown_behavior: Option<String>,
    /// The role in the instance profile (needs iam:GetInstanceProfile).
    pub role_arn: Option<String>,
}

/// One instance with what its views need. Only the instance itself must load;
/// the rest is best effort (run concurrently), so missing permissions leave
/// gaps, not an error.
pub async fn instance_details(conn: &Connection, id: &str) -> Result<InstanceDetails, AppError> {
    let i = get_instance(conn, id).await?;
    let c = client(conn);
    let volume_ids: Vec<String> = i.block_devices.iter().filter_map(|b| b.volume_id.clone()).collect();
    let group_ids: Vec<String> = i.security_groups.iter().map(|g| g.id.clone()).collect();
    let profile_name = i
        .iam_profile_arn
        .as_deref()
        .and_then(|a| a.rsplit('/').next())
        .map(String::from);

    let volumes = {
        let (c, ids) = (c.clone(), volume_ids.clone());
        tokio::spawn(async move {
            if ids.is_empty() {
                return Vec::new();
            }
            c.describe_volumes()
                .set_volume_ids(Some(ids))
                .send()
                .await
                .map(|o| o.volumes().iter().map(volume).collect())
                .unwrap_or_default()
        })
    };
    let interfaces = {
        let (c, id) = (c.clone(), id.to_string());
        tokio::spawn(async move {
            c.describe_network_interfaces()
                .filters(filter("attachment.instance-id", &[&id]))
                .send()
                .await
                .map(|o| {
                    let mut v: Vec<Interface> = o.network_interfaces().iter().map(interface).collect();
                    v.sort_by_key(|n| n.device_index.unwrap_or(i32::MAX));
                    v
                })
                .unwrap_or_default()
        })
    };
    let groups = tokio::spawn(ec2_network::groups_best_effort(c.clone(), group_ids));
    let attribute = |name: InstanceAttributeName| {
        let (c, id) = (c.clone(), id.to_string());
        tokio::spawn(async move { c.describe_instance_attribute().instance_id(id).attribute(name).send().await.ok() })
    };
    let termination = attribute(InstanceAttributeName::DisableApiTermination);
    let stop = attribute(InstanceAttributeName::DisableApiStop);
    let shutdown = attribute(InstanceAttributeName::InstanceInitiatedShutdownBehavior);
    let role = {
        let iam = crate::iam::client(conn);
        tokio::spawn(async move {
            let name = profile_name?;
            iam.get_instance_profile()
                .instance_profile_name(name)
                .send()
                .await
                .ok()?
                .instance_profile()?
                .roles()
                .first()
                .map(|r| r.arn().to_string())
        })
    };

    let mut volumes = volumes.await.unwrap_or_default();
    // In the order the instance lists its devices.
    volumes.sort_by_key(|v| volume_ids.iter().position(|x| *x == v.id).unwrap_or(usize::MAX));
    Ok(InstanceDetails {
        instance: i,
        volumes,
        interfaces: interfaces.await.unwrap_or_default(),
        groups: groups.await.unwrap_or_default(),
        termination_protection: termination
            .await
            .ok()
            .flatten()
            .and_then(|o| o.disable_api_termination().and_then(|v| v.value())),
        stop_protection: stop
            .await
            .ok()
            .flatten()
            .and_then(|o| o.disable_api_stop().and_then(|v| v.value())),
        shutdown_behavior: shutdown.await.ok().flatten().and_then(|o| {
            o.instance_initiated_shutdown_behavior()
                .and_then(|v| v.value())
                .map(String::from)
        }),
        role_arn: role.await.ok().flatten(),
    })
}

#[cfg(test)]
pub(crate) mod emulator_tests {
    use super::*;

    pub(crate) async fn connect() -> Connection {
        crate::sqs::emulator_tests::connect().await
    }

    /// A running instance tagged Name=`name`, launched if there isn't one.
    pub(crate) async fn ensure_instance(conn: &Connection, name: &str) -> String {
        let c = client(conn);
        let found = c
            .describe_instances()
            .filters(filter("tag:Name", &[name]))
            .filters(filter("instance-state-name", &["pending", "running", "stopped", "stopping"]))
            .send()
            .await
            .unwrap();
        if let Some(id) = found
            .reservations()
            .iter()
            .flat_map(|r| r.instances())
            .find_map(|i| i.instance_id())
        {
            return id.to_string();
        }
        let out = c
            .run_instances()
            .image_id("ami-12345678")
            .instance_type(aws_sdk_ec2::types::InstanceType::T3Micro)
            .min_count(1)
            .max_count(1)
            .tag_specifications(
                aws_sdk_ec2::types::TagSpecification::builder()
                    .resource_type(aws_sdk_ec2::types::ResourceType::Instance)
                    .tags(Tag::builder().key("Name").value(name).build())
                    .build(),
            )
            .send()
            .await
            .unwrap();
        out.instances()[0].instance_id().unwrap().to_string()
    }

    #[tokio::test]
    #[ignore]
    async fn lists_and_describes_instances() {
        let conn = connect().await;
        let id = ensure_instance(&conn, "s3x-ec2-browse").await;
        let all = list_instances(&conn).await.unwrap();
        let i = all.iter().find(|i| i.id == id).expect("listed");
        assert_eq!(i.name.as_deref(), Some("s3x-ec2-browse"));
        assert!(i.state.is_some());
        assert!(i.instance_type.is_some());

        let d = instance_details(&conn, &id).await.unwrap();
        assert_eq!(d.instance.id, id);
        assert!(instance_details(&conn, "i-0000000000000dead").await.is_err());
    }
}
