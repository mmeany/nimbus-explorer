//! EC2 networking: security groups with their rules flattened to one row per
//! source (referenced groups named where they can be looked up).

use crate::ec2::tags;
use aws_sdk_ec2::types::{IpPermission, SecurityGroup as SdkGroup};
use aws_sdk_ec2::Client;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    /// "All", "TCP", "UDP", "ICMP", "ICMPv6" or the protocol number.
    pub protocol: String,
    /// "22", "8000-8080", "All", or ICMP "type 8" / "type 3 code 4".
    pub ports: String,
    /// "cidr", "cidr6", "prefixList" or "group".
    pub source_kind: String,
    pub source: String,
    /// A referenced group's name.
    pub source_name: Option<String>,
    /// A referenced group's account, when it's not the group's own.
    pub source_account: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecurityGroup {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub vpc_id: Option<String>,
    pub owner_id: Option<String>,
    pub inbound: Vec<Rule>,
    pub outbound: Vec<Rule>,
    pub tags: Vec<(String, String)>,
}

pub fn protocol_label(p: &str) -> String {
    match p.to_ascii_lowercase().as_str() {
        "-1" | "all" => "All".into(),
        "6" | "tcp" => "TCP".into(),
        "17" | "udp" => "UDP".into(),
        "1" | "icmp" => "ICMP".into(),
        "58" | "icmpv6" => "ICMPv6".into(),
        other => other.to_string(),
    }
}

pub fn ports_label(protocol: &str, from: Option<i32>, to: Option<i32>) -> String {
    match protocol {
        "All" => "All".into(),
        "ICMP" | "ICMPv6" => match (from, to) {
            (None, _) | (Some(-1), _) => "All".into(),
            (Some(t), None) | (Some(t), Some(-1)) => format!("type {t}"),
            (Some(t), Some(c)) => format!("type {t} code {c}"),
        },
        _ => match (from, to) {
            (None, None) => "All".into(),
            (Some(0), Some(65535)) | (Some(-1), _) => "All".into(),
            (Some(a), Some(b)) if a == b => a.to_string(),
            (Some(a), Some(b)) => format!("{a}-{b}"),
            (Some(a), None) | (None, Some(a)) => a.to_string(),
        },
    }
}

/// One rule per source of each permission.
pub fn rules(perms: &[IpPermission], own_account: Option<&str>) -> Vec<Rule> {
    let mut out = Vec::new();
    for p in perms {
        let protocol = protocol_label(p.ip_protocol().unwrap_or("-1"));
        let ports = ports_label(&protocol, p.from_port(), p.to_port());
        let rule = |kind: &str, source: &str, description: Option<&str>| Rule {
            protocol: protocol.clone(),
            ports: ports.clone(),
            source_kind: kind.into(),
            source: source.into(),
            source_name: None,
            source_account: None,
            description: description.filter(|d| !d.is_empty()).map(String::from),
        };
        for r in p.ip_ranges() {
            out.push(rule("cidr", r.cidr_ip().unwrap_or_default(), r.description()));
        }
        for r in p.ipv6_ranges() {
            out.push(rule("cidr6", r.cidr_ipv6().unwrap_or_default(), r.description()));
        }
        for r in p.prefix_list_ids() {
            out.push(rule("prefixList", r.prefix_list_id().unwrap_or_default(), r.description()));
        }
        for g in p.user_id_group_pairs() {
            let mut x = rule("group", g.group_id().unwrap_or_default(), g.description());
            x.source_name = g.group_name().map(String::from);
            x.source_account = g
                .user_id()
                .filter(|u| Some(*u) != own_account)
                .map(String::from);
            out.push(x);
        }
    }
    out
}

pub(crate) fn group(g: &SdkGroup) -> SecurityGroup {
    let owner = g.owner_id();
    SecurityGroup {
        id: g.group_id().unwrap_or_default().to_string(),
        name: g.group_name().unwrap_or_default().to_string(),
        description: g.description().filter(|d| !d.is_empty()).map(String::from),
        vpc_id: g.vpc_id().map(String::from),
        owner_id: owner.map(String::from),
        inbound: rules(g.ip_permissions(), owner),
        outbound: rules(g.ip_permissions_egress(), owner),
        tags: tags(g.tags()),
    }
}

/// Fills in names of referenced groups that the rules don't name, from
/// `known` and then one DescribeSecurityGroups for the rest (best effort:
/// groups in other accounts can't be described).
pub(crate) async fn name_sources(c: &Client, groups: &mut [SecurityGroup]) {
    let mut names: HashMap<String, String> = groups.iter().map(|g| (g.id.clone(), g.name.clone())).collect();
    let missing: BTreeSet<String> = groups
        .iter()
        .flat_map(|g| g.inbound.iter().chain(g.outbound.iter()))
        .filter(|r| r.source_kind == "group" && r.source_name.is_none() && r.source_account.is_none())
        .map(|r| r.source.clone())
        .filter(|id| !names.contains_key(id))
        .collect();
    if !missing.is_empty() {
        if let Ok(o) = c
            .describe_security_groups()
            .set_group_ids(Some(missing.into_iter().collect()))
            .send()
            .await
        {
            for g in o.security_groups() {
                if let (Some(id), Some(name)) = (g.group_id(), g.group_name()) {
                    names.insert(id.to_string(), name.to_string());
                }
            }
        }
    }
    for g in groups.iter_mut() {
        for r in g.inbound.iter_mut().chain(g.outbound.iter_mut()) {
            if r.source_kind == "group" && r.source_name.is_none() {
                r.source_name = names.get(&r.source).cloned();
            }
        }
    }
}

/// The groups with these ids, in that order; empty if they can't be read.
pub(crate) async fn groups_best_effort(c: Client, ids: Vec<String>) -> Vec<SecurityGroup> {
    if ids.is_empty() {
        return Vec::new();
    }
    let Ok(o) = c
        .describe_security_groups()
        .set_group_ids(Some(ids.clone()))
        .send()
        .await
    else {
        return Vec::new();
    };
    let mut out: Vec<SecurityGroup> = o.security_groups().iter().map(group).collect();
    out.sort_by_key(|g| ids.iter().position(|x| *x == g.id).unwrap_or(usize::MAX));
    name_sources(&c, &mut out).await;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_ec2::types::{IpRange, UserIdGroupPair};

    #[test]
    fn labels_protocols_and_ports() {
        assert_eq!(protocol_label("-1"), "All");
        assert_eq!(protocol_label("tcp"), "TCP");
        assert_eq!(protocol_label("17"), "UDP");
        assert_eq!(protocol_label("50"), "50");
        assert_eq!(ports_label("TCP", Some(22), Some(22)), "22");
        assert_eq!(ports_label("TCP", Some(8000), Some(8080)), "8000-8080");
        assert_eq!(ports_label("UDP", Some(0), Some(65535)), "All");
        assert_eq!(ports_label("All", None, None), "All");
        assert_eq!(ports_label("ICMP", Some(-1), Some(-1)), "All");
        assert_eq!(ports_label("ICMP", Some(8), Some(-1)), "type 8");
        assert_eq!(ports_label("ICMP", Some(3), Some(4)), "type 3 code 4");
    }

    #[test]
    fn flattens_rules_per_source() {
        let p = IpPermission::builder()
            .ip_protocol("tcp")
            .from_port(443)
            .to_port(443)
            .ip_ranges(IpRange::builder().cidr_ip("0.0.0.0/0").description("web").build())
            .user_id_group_pairs(UserIdGroupPair::builder().group_id("sg-1").user_id("111").build())
            .user_id_group_pairs(UserIdGroupPair::builder().group_id("sg-2").user_id("222").build())
            .build();
        let r = rules(&[p], Some("111"));
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].source, "0.0.0.0/0");
        assert_eq!(r[0].description.as_deref(), Some("web"));
        assert_eq!(r[0].ports, "443");
        assert_eq!(r[1].source_kind, "group");
        assert_eq!(r[1].source_account, None);
        assert_eq!(r[2].source_account.as_deref(), Some("222"));
    }
}

// ---------------------------------------------------------------------------
// Lists and views (17.7)

use crate::ec2::{client, err, filter, interface, other, tag, GroupRef, Interface};
use crate::error::AppError;
use crate::s3::Connection;

/// "Not found" errors as a plain sentence.
fn missing(conn: &Connection, e: impl std::error::Error + std::fmt::Debug, what: &str, id: &str) -> AppError {
    let text = format!("{e:?}");
    if text.contains("NotFound") || text.contains(".Malformed") {
        return other(format!("There's no {what} {id} in this region."));
    }
    err(conn, e)
}

/// Every security group in the region (rules included, referenced groups named), by name.
pub async fn list_security_groups(conn: &Connection) -> Result<Vec<SecurityGroup>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .describe_security_groups()
            .max_results(1000)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.security_groups().iter().map(group));
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    name_sources(&c, &mut out).await;
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.id.cmp(&b.id)));
    Ok(out)
}

/// What uses a security group: a network interface (and through it an
/// instance, load balancer, Lambda function, …).
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GroupUser {
    pub interface_id: String,
    pub interface_type: Option<String>,
    pub description: Option<String>,
    pub instance_id: Option<String>,
    pub private_ip: Option<String>,
    /// The service that manages the interface (amazon-elb, …).
    pub requester: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GroupDetails {
    #[serde(flatten)]
    pub group: SecurityGroup,
    pub used_by: Vec<GroupUser>,
    /// Groups whose rules name this one.
    pub referenced_by: Vec<GroupRef>,
}

pub async fn security_group(conn: &Connection, id: &str) -> Result<GroupDetails, AppError> {
    let c = client(conn);
    let out = c
        .describe_security_groups()
        .group_ids(id)
        .send()
        .await
        .map_err(|e| missing(conn, e, "security group", id))?;
    let mut groups: Vec<SecurityGroup> = out.security_groups().iter().map(group).collect();
    if groups.is_empty() {
        return Err(other(format!("There's no security group {id} in this region.")));
    }
    name_sources(&c, &mut groups).await;
    let used_by = c
        .describe_network_interfaces()
        .filters(filter("group-id", &[id]))
        .send()
        .await
        .map(|o| {
            o.network_interfaces()
                .iter()
                .map(|n| GroupUser {
                    interface_id: n.network_interface_id().unwrap_or_default().to_string(),
                    interface_type: n.interface_type().map(|t| t.as_str().to_string()),
                    description: n.description().filter(|d| !d.is_empty()).map(String::from),
                    instance_id: n.attachment().and_then(|a| a.instance_id()).map(String::from),
                    private_ip: n.private_ip_address().map(String::from),
                    requester: n.requester_id().map(String::from),
                })
                .collect()
        })
        .unwrap_or_default();
    let mut referenced_by: Vec<GroupRef> = Vec::new();
    for f in ["ip-permission.group-id", "egress.ip-permission.group-id"] {
        if let Ok(o) = c.describe_security_groups().filters(filter(f, &[id])).send().await {
            for g in o.security_groups() {
                let r = GroupRef {
                    id: g.group_id().unwrap_or_default().to_string(),
                    name: g.group_name().map(String::from),
                };
                if r.id != id && !referenced_by.contains(&r) {
                    referenced_by.push(r);
                }
            }
        }
    }
    Ok(GroupDetails {
        group: groups.remove(0),
        used_by,
        referenced_by,
    })
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Vpc {
    pub id: String,
    pub name: Option<String>,
    pub cidrs: Vec<String>,
    pub ipv6_cidrs: Vec<String>,
    pub state: Option<String>,
    pub is_default: bool,
    pub tenancy: Option<String>,
    pub dhcp_options: Option<String>,
    pub owner_id: Option<String>,
    pub tags: Vec<(String, String)>,
}

fn vpc(v: &aws_sdk_ec2::types::Vpc) -> Vpc {
    let mut cidrs: Vec<String> = v
        .cidr_block_association_set()
        .iter()
        .filter(|a| a.cidr_block_state().and_then(|s| s.state()).map(|s| s.as_str() == "associated").unwrap_or(true))
        .filter_map(|a| a.cidr_block())
        .map(String::from)
        .collect();
    if cidrs.is_empty() {
        cidrs.extend(v.cidr_block().map(String::from));
    }
    Vpc {
        id: v.vpc_id().unwrap_or_default().to_string(),
        name: tag(v.tags(), "Name").map(String::from),
        cidrs,
        ipv6_cidrs: v
            .ipv6_cidr_block_association_set()
            .iter()
            .filter_map(|a| a.ipv6_cidr_block())
            .map(String::from)
            .collect(),
        state: v.state().map(|s| s.as_str().to_string()),
        is_default: v.is_default().unwrap_or(false),
        tenancy: v.instance_tenancy().map(|t| t.as_str().to_string()),
        dhcp_options: v.dhcp_options_id().map(String::from),
        owner_id: v.owner_id().map(String::from),
        tags: tags(v.tags()),
    }
}

pub async fn list_vpcs(conn: &Connection) -> Result<Vec<Vpc>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .describe_vpcs()
            .max_results(1000)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.vpcs().iter().map(vpc));
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| b.is_default.cmp(&a.is_default).then(a.name.cmp(&b.name)).then(a.id.cmp(&b.id)));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Subnet {
    pub id: String,
    pub name: Option<String>,
    pub vpc_id: Option<String>,
    pub az: Option<String>,
    pub cidr: Option<String>,
    pub ipv6_cidrs: Vec<String>,
    pub available_ips: Option<i32>,
    pub default_for_az: bool,
    pub public_ip_on_launch: bool,
    pub state: Option<String>,
    pub tags: Vec<(String, String)>,
}

fn subnet(s: &aws_sdk_ec2::types::Subnet) -> Subnet {
    Subnet {
        id: s.subnet_id().unwrap_or_default().to_string(),
        name: tag(s.tags(), "Name").map(String::from),
        vpc_id: s.vpc_id().map(String::from),
        az: s.availability_zone().map(String::from),
        cidr: s.cidr_block().map(String::from),
        ipv6_cidrs: s
            .ipv6_cidr_block_association_set()
            .iter()
            .filter_map(|a| a.ipv6_cidr_block())
            .map(String::from)
            .collect(),
        available_ips: s.available_ip_address_count(),
        default_for_az: s.default_for_az().unwrap_or(false),
        public_ip_on_launch: s.map_public_ip_on_launch().unwrap_or(false),
        state: s.state().map(|x| x.as_str().to_string()),
        tags: tags(s.tags()),
    }
}

pub async fn list_subnets(conn: &Connection, vpc_id: Option<&str>) -> Result<Vec<Subnet>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut req = c.describe_subnets().max_results(1000).set_next_token(token.clone());
        if let Some(v) = vpc_id {
            req = req.filters(filter("vpc-id", &[v]));
        }
        let page = req.send().await.map_err(|e| err(conn, e))?;
        out.extend(page.subnets().iter().map(subnet));
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| a.vpc_id.cmp(&b.vpc_id).then(a.az.cmp(&b.az)).then(a.cidr.cmp(&b.cidr)));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub destination: String,
    /// igw-…, nat-…, local, pcx-…, tgw-…, vpce-…, eni-…, i-…
    pub target: String,
    pub state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RouteTable {
    pub id: String,
    pub name: Option<String>,
    /// The VPC's main table (used by subnets without their own).
    pub main: bool,
    pub routes: Vec<Route>,
}

fn route_table(t: &aws_sdk_ec2::types::RouteTable) -> RouteTable {
    RouteTable {
        id: t.route_table_id().unwrap_or_default().to_string(),
        name: tag(t.tags(), "Name").map(String::from),
        main: t.associations().iter().any(|a| a.main().unwrap_or(false)),
        routes: t
            .routes()
            .iter()
            .map(|r| Route {
                destination: r
                    .destination_cidr_block()
                    .or(r.destination_ipv6_cidr_block())
                    .or(r.destination_prefix_list_id())
                    .unwrap_or("?")
                    .to_string(),
                target: r
                    .gateway_id()
                    .or(r.nat_gateway_id())
                    .or(r.transit_gateway_id())
                    .or(r.vpc_peering_connection_id())
                    .or(r.network_interface_id())
                    .or(r.instance_id())
                    .or(r.egress_only_internet_gateway_id())
                    .or(r.local_gateway_id())
                    .or(r.carrier_gateway_id())
                    .unwrap_or("?")
                    .to_string(),
                state: r.state().map(|s| s.as_str().to_string()),
            })
            .collect(),
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Gateway {
    pub id: String,
    pub name: Option<String>,
    /// internet, nat.
    pub kind: String,
    pub state: Option<String>,
    pub subnet_id: Option<String>,
    pub public_ip: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VpcDetails {
    #[serde(flatten)]
    pub vpc: Vpc,
    pub subnets: Vec<Subnet>,
    pub route_tables: Vec<RouteTable>,
    pub gateways: Vec<Gateway>,
}

pub async fn vpc_details(conn: &Connection, id: &str) -> Result<VpcDetails, AppError> {
    let c = client(conn);
    let out = c
        .describe_vpcs()
        .vpc_ids(id)
        .send()
        .await
        .map_err(|e| missing(conn, e, "VPC", id))?;
    let v = out
        .vpcs()
        .first()
        .map(vpc)
        .ok_or_else(|| other(format!("There's no VPC {id} in this region.")))?;
    let subnets = list_subnets(conn, Some(id)).await.unwrap_or_default();
    let route_tables = c
        .describe_route_tables()
        .filters(filter("vpc-id", &[id]))
        .send()
        .await
        .map(|o| o.route_tables().iter().map(route_table).collect())
        .unwrap_or_default();
    let mut gateways: Vec<Gateway> = c
        .describe_internet_gateways()
        .filters(filter("attachment.vpc-id", &[id]))
        .send()
        .await
        .map(|o| {
            o.internet_gateways()
                .iter()
                .map(|g| Gateway {
                    id: g.internet_gateway_id().unwrap_or_default().to_string(),
                    name: tag(g.tags(), "Name").map(String::from),
                    kind: "internet".into(),
                    state: g.attachments().first().and_then(|a| a.state()).map(|s| s.as_str().to_string()),
                    subnet_id: None,
                    public_ip: None,
                })
                .collect()
        })
        .unwrap_or_default();
    if let Ok(o) = c.describe_nat_gateways().filter(filter("vpc-id", &[id])).send().await {
        gateways.extend(o.nat_gateways().iter().map(|g| Gateway {
            id: g.nat_gateway_id().unwrap_or_default().to_string(),
            name: tag(g.tags(), "Name").map(String::from),
            kind: "nat".into(),
            state: g.state().map(|s| s.as_str().to_string()),
            subnet_id: g.subnet_id().map(String::from),
            public_ip: g.nat_gateway_addresses().first().and_then(|a| a.public_ip()).map(String::from),
        }));
    }
    Ok(VpcDetails { vpc: v, subnets, route_tables, gateways })
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubnetDetails {
    #[serde(flatten)]
    pub subnet: Subnet,
    /// The table that applies: the subnet's own, else the VPC's main one.
    pub route_table: Option<RouteTable>,
    /// It has a route to an internet gateway.
    pub public: Option<bool>,
}

pub async fn subnet_details(conn: &Connection, id: &str) -> Result<SubnetDetails, AppError> {
    let c = client(conn);
    let out = c
        .describe_subnets()
        .subnet_ids(id)
        .send()
        .await
        .map_err(|e| missing(conn, e, "subnet", id))?;
    let s = out
        .subnets()
        .first()
        .map(subnet)
        .ok_or_else(|| other(format!("There's no subnet {id} in this region.")))?;
    let own = c
        .describe_route_tables()
        .filters(filter("association.subnet-id", &[id]))
        .send()
        .await
        .ok()
        .and_then(|o| o.route_tables().first().map(route_table));
    let table = match own {
        Some(t) => Some(t),
        None => match &s.vpc_id {
            Some(v) => c
                .describe_route_tables()
                .filters(filter("vpc-id", &[v]))
                .filters(filter("association.main", &["true"]))
                .send()
                .await
                .ok()
                .and_then(|o| o.route_tables().first().map(route_table)),
            None => None,
        },
    };
    let public = table.as_ref().map(|t| t.routes.iter().any(|r| r.target.starts_with("igw-")));
    Ok(SubnetDetails { subnet: s, route_table: table, public })
}

/// Every network interface in the region.
pub async fn list_interfaces(conn: &Connection) -> Result<Vec<Interface>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .describe_network_interfaces()
            .max_results(1000)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.network_interfaces().iter().map(interface));
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| a.vpc_id.cmp(&b.vpc_id).then(a.id.cmp(&b.id)));
    Ok(out)
}

pub async fn get_interface(conn: &Connection, id: &str) -> Result<Interface, AppError> {
    let out = client(conn)
        .describe_network_interfaces()
        .network_interface_ids(id)
        .send()
        .await
        .map_err(|e| missing(conn, e, "network interface", id))?;
    out.network_interfaces()
        .first()
        .map(interface)
        .ok_or_else(|| other(format!("There's no network interface {id} in this region.")))
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Address {
    /// The allocation ID (eipalloc-…), used as the address's key.
    pub id: String,
    pub name: Option<String>,
    pub public_ip: Option<String>,
    pub association_id: Option<String>,
    pub instance_id: Option<String>,
    pub interface_id: Option<String>,
    pub private_ip: Option<String>,
    pub domain: Option<String>,
    pub border_group: Option<String>,
    pub pool: Option<String>,
    pub tags: Vec<(String, String)>,
}

pub async fn list_addresses(conn: &Connection) -> Result<Vec<Address>, AppError> {
    let out = client(conn)
        .describe_addresses()
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let mut list: Vec<Address> = out
        .addresses()
        .iter()
        .map(|a| Address {
            id: a
                .allocation_id()
                .or(a.public_ip())
                .unwrap_or_default()
                .to_string(),
            name: tag(a.tags(), "Name").map(String::from),
            public_ip: a.public_ip().map(String::from),
            association_id: a.association_id().map(String::from),
            instance_id: a.instance_id().filter(|i| !i.is_empty()).map(String::from),
            interface_id: a.network_interface_id().map(String::from),
            private_ip: a.private_ip_address().map(String::from),
            domain: a.domain().map(|d| d.as_str().to_string()),
            border_group: a.network_border_group().map(String::from),
            pool: a.public_ipv4_pool().map(String::from),
            tags: tags(a.tags()),
        })
        .collect();
    list.sort_by(|a, b| a.public_ip.cmp(&b.public_ip));
    Ok(list)
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::ec2::emulator_tests::{connect, ensure_instance};

    #[tokio::test]
    #[ignore]
    async fn lists_and_describes_networking() {
        let conn = connect().await;
        let id = ensure_instance(&conn, "s3x-ec2-network").await;
        let inst = crate::ec2::get_instance(&conn, &id).await.unwrap();

        let groups = list_security_groups(&conn).await.unwrap();
        assert!(!groups.is_empty());
        let g = security_group(&conn, &groups[0].id).await.unwrap();
        assert_eq!(g.group.id, groups[0].id);
        assert!(security_group(&conn, "sg-0000000000000dead").await.is_err());

        let vpcs = list_vpcs(&conn).await.unwrap();
        assert!(!vpcs.is_empty());
        let v = vpc_details(&conn, &vpcs[0].id).await.unwrap();
        assert_eq!(v.vpc.id, vpcs[0].id);

        let subnets = list_subnets(&conn, None).await.unwrap();
        if let Some(s) = subnets.first() {
            let d = subnet_details(&conn, &s.id).await.unwrap();
            assert_eq!(d.subnet.id, s.id);
        }
        let enis = list_interfaces(&conn).await.unwrap();
        if let Some(n) = enis.first() {
            assert_eq!(get_interface(&conn, &n.id).await.unwrap().id, n.id);
        }
        let _ = list_addresses(&conn).await.unwrap();
        assert!(inst.id.starts_with("i-"));
    }
}
