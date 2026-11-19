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
