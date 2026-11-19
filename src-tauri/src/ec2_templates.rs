//! Key pairs (names, type, fingerprint; never key material) and launch
//! templates with their versions. A version's data is mapped to JSON with
//! the AWS CLI's field names; user data is never decoded (size only).

use crate::ec2::{client, err, iso, other, tags};
use crate::error::AppError;
use crate::s3::Connection;
use aws_sdk_ec2::types::ResponseLaunchTemplateData;
use serde::Serialize;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyPair {
    /// key-… (or the name, where an endpoint has no IDs).
    pub id: String,
    pub name: String,
    /// rsa or ed25519.
    pub key_type: Option<String>,
    pub fingerprint: Option<String>,
    pub created: Option<String>,
    pub tags: Vec<(String, String)>,
}

pub async fn list_key_pairs(conn: &Connection) -> Result<Vec<KeyPair>, AppError> {
    let out = client(conn).describe_key_pairs().send().await.map_err(|e| err(conn, e))?;
    let mut list: Vec<KeyPair> = out
        .key_pairs()
        .iter()
        .map(|k| {
            let name = k.key_name().unwrap_or_default().to_string();
            KeyPair {
                id: k.key_pair_id().map(String::from).unwrap_or_else(|| name.clone()),
                name,
                key_type: k.key_type().map(|t| t.as_str().to_string()),
                fingerprint: k.key_fingerprint().map(String::from),
                created: iso(k.create_time()),
                tags: tags(k.tags()),
            }
        })
        .collect();
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(list)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LaunchTemplate {
    pub id: String,
    pub name: String,
    pub default_version: Option<i64>,
    pub latest_version: Option<i64>,
    pub created: Option<String>,
    pub created_by: Option<String>,
    pub tags: Vec<(String, String)>,
}

fn template(t: &aws_sdk_ec2::types::LaunchTemplate) -> LaunchTemplate {
    LaunchTemplate {
        id: t.launch_template_id().unwrap_or_default().to_string(),
        name: t.launch_template_name().unwrap_or_default().to_string(),
        default_version: t.default_version_number(),
        latest_version: t.latest_version_number(),
        created: iso(t.create_time()),
        created_by: t.created_by().map(String::from),
        tags: tags(t.tags()),
    }
}

pub async fn list_templates(conn: &Connection) -> Result<Vec<LaunchTemplate>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .describe_launch_templates()
            .max_results(200)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.launch_templates().iter().map(template));
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TemplateVersion {
    pub version: i64,
    pub description: Option<String>,
    pub created: Option<String>,
    pub created_by: Option<String>,
    pub default: bool,
    /// The launch settings as JSON (AWS CLI field names; user data as its size only).
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDetails {
    #[serde(flatten)]
    pub template: LaunchTemplate,
    /// Newest first.
    pub versions: Vec<TemplateVersion>,
}

/// Adds `key: value` when the value isn't null / empty.
fn put(m: &mut Map<String, Value>, key: &str, v: Value) {
    let empty = match &v {
        Value::Null => true,
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        _ => false,
    };
    if !empty {
        m.insert(key.to_string(), v);
    }
}

fn s(v: Option<&str>) -> Value {
    v.map(|x| Value::String(x.to_string())).unwrap_or(Value::Null)
}

fn e<T: AsRef<str>>(v: Option<T>) -> Value {
    v.map(|x| Value::String(x.as_ref().to_string())).unwrap_or(Value::Null)
}

fn b(v: Option<bool>) -> Value {
    v.map(Value::Bool).unwrap_or(Value::Null)
}

fn n(v: Option<i32>) -> Value {
    v.map(|x| json!(x)).unwrap_or(Value::Null)
}

fn obj(f: impl FnOnce(&mut Map<String, Value>)) -> Value {
    let mut m = Map::new();
    f(&mut m);
    Value::Object(m)
}

/// The launch template data the console and CLI show, in the CLI's shape.
pub fn data_json(d: &ResponseLaunchTemplateData) -> Value {
    obj(|m| {
        put(m, "ImageId", s(d.image_id()));
        put(m, "InstanceType", e(d.instance_type().map(|t| t.as_str())));
        put(m, "KeyName", s(d.key_name()));
        put(m, "SecurityGroupIds", json!(d.security_group_ids()));
        put(m, "SecurityGroups", json!(d.security_groups()));
        put(
            m,
            "IamInstanceProfile",
            obj(|p| {
                if let Some(x) = d.iam_instance_profile() {
                    put(p, "Arn", s(x.arn()));
                    put(p, "Name", s(x.name()));
                }
            }),
        );
        put(
            m,
            "NetworkInterfaces",
            Value::Array(
                d.network_interfaces()
                    .iter()
                    .map(|i| {
                        obj(|o| {
                            put(o, "DeviceIndex", n(i.device_index()));
                            put(o, "NetworkInterfaceId", s(i.network_interface_id()));
                            put(o, "SubnetId", s(i.subnet_id()));
                            put(o, "Groups", json!(i.groups()));
                            put(o, "AssociatePublicIpAddress", b(i.associate_public_ip_address()));
                            put(o, "DeleteOnTermination", b(i.delete_on_termination()));
                            put(o, "Description", s(i.description()));
                            put(o, "PrivateIpAddress", s(i.private_ip_address()));
                            put(o, "Ipv6AddressCount", n(i.ipv6_address_count()));
                            put(o, "InterfaceType", s(i.interface_type()));
                        })
                    })
                    .collect(),
            ),
        );
        put(
            m,
            "BlockDeviceMappings",
            Value::Array(
                d.block_device_mappings()
                    .iter()
                    .map(|bd| {
                        obj(|o| {
                            put(o, "DeviceName", s(bd.device_name()));
                            put(o, "VirtualName", s(bd.virtual_name()));
                            put(o, "NoDevice", s(bd.no_device()));
                            put(
                                o,
                                "Ebs",
                                obj(|x| {
                                    if let Some(ebs) = bd.ebs() {
                                        put(x, "VolumeSize", n(ebs.volume_size()));
                                        put(x, "VolumeType", e(ebs.volume_type().map(|t| t.as_str())));
                                        put(x, "Iops", n(ebs.iops()));
                                        put(x, "Throughput", n(ebs.throughput()));
                                        put(x, "Encrypted", b(ebs.encrypted()));
                                        put(x, "KmsKeyId", s(ebs.kms_key_id()));
                                        put(x, "SnapshotId", s(ebs.snapshot_id()));
                                        put(x, "DeleteOnTermination", b(ebs.delete_on_termination()));
                                    }
                                }),
                            );
                        })
                    })
                    .collect(),
            ),
        );
        put(
            m,
            "UserData",
            match d.user_data() {
                Some(u) if !u.is_empty() => Value::String(format!("(hidden: {} characters of base64)", u.len())),
                _ => Value::Null,
            },
        );
        put(
            m,
            "TagSpecifications",
            Value::Array(
                d.tag_specifications()
                    .iter()
                    .map(|t| {
                        obj(|o| {
                            put(o, "ResourceType", e(t.resource_type().map(|r| r.as_str())));
                            put(
                                o,
                                "Tags",
                                Value::Array(
                                    t.tags()
                                        .iter()
                                        .map(|x| json!({ "Key": x.key().unwrap_or_default(), "Value": x.value().unwrap_or_default() }))
                                        .collect(),
                                ),
                            );
                        })
                    })
                    .collect(),
            ),
        );
        put(
            m,
            "MetadataOptions",
            obj(|o| {
                if let Some(x) = d.metadata_options() {
                    put(o, "HttpTokens", e(x.http_tokens().map(|t| t.as_str())));
                    put(o, "HttpEndpoint", e(x.http_endpoint().map(|t| t.as_str())));
                    put(o, "HttpPutResponseHopLimit", n(x.http_put_response_hop_limit()));
                    put(o, "InstanceMetadataTags", e(x.instance_metadata_tags().map(|t| t.as_str())));
                }
            }),
        );
        put(m, "Monitoring", obj(|o| put(o, "Enabled", b(d.monitoring().and_then(|x| x.enabled())))));
        put(
            m,
            "Placement",
            obj(|o| {
                if let Some(p) = d.placement() {
                    put(o, "AvailabilityZone", s(p.availability_zone()));
                    put(o, "GroupName", s(p.group_name()));
                    put(o, "Tenancy", e(p.tenancy().map(|t| t.as_str())));
                }
            }),
        );
        put(
            m,
            "InstanceMarketOptions",
            obj(|o| {
                if let Some(x) = d.instance_market_options() {
                    put(o, "MarketType", e(x.market_type().map(|t| t.as_str())));
                    put(
                        o,
                        "SpotOptions",
                        obj(|so| {
                            if let Some(sp) = x.spot_options() {
                                put(so, "MaxPrice", s(sp.max_price()));
                                put(so, "SpotInstanceType", e(sp.spot_instance_type().map(|t| t.as_str())));
                                put(so, "InstanceInterruptionBehavior", e(sp.instance_interruption_behavior().map(|t| t.as_str())));
                            }
                        }),
                    );
                }
            }),
        );
        put(m, "CreditSpecification", obj(|o| put(o, "CpuCredits", s(d.credit_specification().and_then(|c| c.cpu_credits())))));
        put(
            m,
            "CpuOptions",
            obj(|o| {
                if let Some(c) = d.cpu_options() {
                    put(o, "CoreCount", n(c.core_count()));
                    put(o, "ThreadsPerCore", n(c.threads_per_core()));
                }
            }),
        );
        put(m, "EbsOptimized", b(d.ebs_optimized()));
        put(m, "DisableApiTermination", b(d.disable_api_termination()));
        put(m, "DisableApiStop", b(d.disable_api_stop()));
        put(m, "InstanceInitiatedShutdownBehavior", e(d.instance_initiated_shutdown_behavior().map(|t| t.as_str())));
        put(m, "HibernationOptions", obj(|o| put(o, "Configured", b(d.hibernation_options().and_then(|h| h.configured())))));
        put(m, "RamDiskId", s(d.ram_disk_id()));
        put(m, "KernelId", s(d.kernel_id()));
        if d.instance_requirements().is_some() {
            m.insert("InstanceRequirements".into(), Value::String("(attribute-based instance types: see the AWS console)".into()));
        }
    })
}

pub async fn template_details(conn: &Connection, id: &str) -> Result<TemplateDetails, AppError> {
    let c = client(conn);
    let out = c
        .describe_launch_templates()
        .launch_template_ids(id)
        .send()
        .await
        .map_err(|e| {
            if format!("{e:?}").contains("NotFound") || format!("{e:?}").contains("Malformed") {
                other(format!("There's no launch template {id} in this region."))
            } else {
                err(conn, e)
            }
        })?;
    let t = out
        .launch_templates()
        .first()
        .map(template)
        .ok_or_else(|| other(format!("There's no launch template {id} in this region.")))?;
    let mut versions = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .describe_launch_template_versions()
            .launch_template_id(id)
            .max_results(200)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        versions.extend(page.launch_template_versions().iter().map(|v| TemplateVersion {
            version: v.version_number().unwrap_or_default(),
            description: v.version_description().filter(|d| !d.is_empty()).map(String::from),
            created: iso(v.create_time()),
            created_by: v.created_by().map(String::from),
            default: v.default_version().unwrap_or(false),
            data: v.launch_template_data().map(data_json).unwrap_or(Value::Null),
        }));
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    versions.sort_by(|a, b| b.version.cmp(&a.version));
    versions.dedup_by_key(|v| v.version);
    Ok(TemplateDetails { template: t, versions })
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_ec2::types::{InstanceType, LaunchTemplateInstanceMetadataOptions, LaunchTemplateHttpTokensState};

    #[test]
    fn maps_template_data_and_hides_user_data() {
        let d = ResponseLaunchTemplateData::builder()
            .image_id("ami-1")
            .instance_type(InstanceType::T3Micro)
            .security_group_ids("sg-1")
            .user_data("IyEvYmluL2Jhc2gKZWNobyBzZWNyZXQ=")
            .metadata_options(LaunchTemplateInstanceMetadataOptions::builder().http_tokens(LaunchTemplateHttpTokensState::Required).build())
            .build();
        let v = data_json(&d);
        assert_eq!(v["ImageId"], "ami-1");
        assert_eq!(v["InstanceType"], "t3.micro");
        assert_eq!(v["SecurityGroupIds"][0], "sg-1");
        assert_eq!(v["MetadataOptions"]["HttpTokens"], "required");
        assert!(v["UserData"].as_str().unwrap().starts_with("(hidden"));
        assert!(!v.to_string().contains("ZWNobyBzZWNyZXQ"));
        // Empty parts are left out.
        assert!(v.get("NetworkInterfaces").is_none());
        assert!(v.get("Placement").is_none());
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::ec2::emulator_tests::connect;
    use aws_sdk_ec2::types::{InstanceType, RequestLaunchTemplateData};

    #[tokio::test]
    #[ignore]
    async fn lists_key_pairs_and_templates() {
        let conn = connect().await;
        let c = client(&conn);
        let _ = c.create_key_pair().key_name("s3x-key").send().await;
        let keys = list_key_pairs(&conn).await.unwrap();
        assert!(keys.iter().any(|k| k.name == "s3x-key"));

        let name = format!("s3x-lt-{}", std::process::id());
        let created = c
            .create_launch_template()
            .launch_template_name(&name)
            .launch_template_data(RequestLaunchTemplateData::builder().image_id("ami-12345678").instance_type(InstanceType::T3Micro).build())
            .send()
            .await;
        let Ok(created) = created else { return }; // emulator without launch templates
        let id = created.launch_template().unwrap().launch_template_id().unwrap().to_string();
        let _ = c
            .create_launch_template_version()
            .launch_template_id(&id)
            .launch_template_data(RequestLaunchTemplateData::builder().instance_type(InstanceType::T3Small).build())
            .send()
            .await;
        assert!(list_templates(&conn).await.unwrap().iter().any(|t| t.id == id));
        let d = template_details(&conn, &id).await.unwrap();
        assert!(!d.versions.is_empty());
        let _ = c.delete_launch_template().launch_template_id(&id).send().await;
    }
}
