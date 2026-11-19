//! Instance actions: start, stop (hibernate / force), reboot, terminate,
//! change instance type and termination / stop protection. Every caller
//! (commands/ec2.rs) checks `ensure_writable` first.

use crate::ec2::{client, err, filter, get_instance, other};
use crate::error::AppError;
use crate::s3::Connection;
use aws_sdk_ec2::types::{AttributeBooleanValue, AttributeValue, InstanceStateChange, LocationType};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StateChange {
    pub id: String,
    pub previous: Option<String>,
    pub current: Option<String>,
}

fn changes(list: &[InstanceStateChange]) -> Vec<StateChange> {
    list.iter()
        .map(|c| StateChange {
            id: c.instance_id().unwrap_or_default().to_string(),
            previous: c.previous_state().and_then(|s| s.name()).map(|n| n.as_str().to_string()),
            current: c.current_state().and_then(|s| s.name()).map(|n| n.as_str().to_string()),
        })
        .collect()
}

fn check_ids(ids: &[String]) -> Result<(), AppError> {
    if ids.is_empty() {
        return Err(other("No instances were chosen."));
    }
    if ids.len() > 100 {
        return Err(other("Choose at most 100 instances at a time."));
    }
    if let Some(bad) = ids.iter().find(|i| !i.starts_with("i-")) {
        return Err(other(format!("{bad} isn't an instance ID.")));
    }
    Ok(())
}

/// An endpoint (usually an emulator) that doesn't know the operation.
pub(crate) fn unsupported(conn: &Connection, e: impl std::error::Error + std::fmt::Debug, op: &str) -> AppError {
    let text = format!("{e:?}");
    if text.contains("InvalidAction") || text.contains("Unknown EC2 action") || text.contains("not implemented") {
        return other(format!("This endpoint doesn't support {op}."));
    }
    err(conn, e)
}

/// AWS's refusals that deserve a plain sentence.
fn explain(conn: &Connection, e: impl std::error::Error + std::fmt::Debug, action: &str) -> AppError {
    let text = format!("{e:?}");
    if text.contains("OperationNotPermitted") && text.contains("disableApiTermination") {
        return other(format!("Termination protection is on, so AWS won't {action} it. Turn the protection off first."));
    }
    if text.contains("OperationNotPermitted") && text.contains("disableApiStop") {
        return other(format!("Stop protection is on, so AWS won't {action} it. Turn the protection off first."));
    }
    if text.contains("IncorrectInstanceState") {
        return other(format!("An instance is in a state that doesn't allow it to {action}. Refresh and try again."));
    }
    if text.contains("UnsupportedHibernationConfiguration") || text.contains("hibernation") && text.contains("not enabled") {
        return other("This instance can't hibernate: hibernation must be configured when the instance is launched.");
    }
    if text.contains("InsufficientInstanceCapacity") {
        return other("AWS has no capacity for this instance type in its availability zone right now. Try again later, or change the instance type.");
    }
    err(conn, e)
}

pub async fn start(conn: &Connection, ids: &[String]) -> Result<Vec<StateChange>, AppError> {
    check_ids(ids)?;
    let out = client(conn)
        .start_instances()
        .set_instance_ids(Some(ids.to_vec()))
        .send()
        .await
        .map_err(|e| explain(conn, e, "start"))?;
    Ok(changes(out.starting_instances()))
}

pub async fn stop(conn: &Connection, ids: &[String], hibernate: bool, force: bool) -> Result<Vec<StateChange>, AppError> {
    check_ids(ids)?;
    let mut req = client(conn).stop_instances().set_instance_ids(Some(ids.to_vec()));
    if hibernate {
        req = req.hibernate(true);
    }
    if force {
        req = req.force(true);
    }
    let out = req.send().await.map_err(|e| explain(conn, e, "stop"))?;
    Ok(changes(out.stopping_instances()))
}

pub async fn reboot(conn: &Connection, ids: &[String]) -> Result<(), AppError> {
    check_ids(ids)?;
    client(conn)
        .reboot_instances()
        .set_instance_ids(Some(ids.to_vec()))
        .send()
        .await
        .map_err(|e| explain(conn, e, "reboot"))?;
    Ok(())
}

pub async fn terminate(conn: &Connection, ids: &[String]) -> Result<Vec<StateChange>, AppError> {
    check_ids(ids)?;
    let out = client(conn)
        .terminate_instances()
        .set_instance_ids(Some(ids.to_vec()))
        .send()
        .await
        .map_err(|e| explain(conn, e, "terminate"))?;
    Ok(changes(out.terminating_instances()))
}

pub fn valid_type(t: &str) -> bool {
    let parts: Vec<&str> = t.split('.').collect();
    parts.len() == 2
        && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
}

/// Changes a stopped instance's type.
pub async fn set_type(conn: &Connection, id: &str, instance_type: &str) -> Result<(), AppError> {
    if !valid_type(instance_type) {
        return Err(other("Instance types look like t3.micro."));
    }
    let i = get_instance(conn, id).await?;
    if i.state.as_deref() != Some("stopped") {
        return Err(other(format!(
            "The instance must be stopped to change its type (it's {}).",
            i.state.as_deref().unwrap_or("in an unknown state")
        )));
    }
    if i.instance_type.as_deref() == Some(instance_type) {
        return Err(other(format!("The instance is already {instance_type}.")));
    }
    client(conn)
        .modify_instance_attribute()
        .instance_id(id)
        .instance_type(AttributeValue::builder().value(instance_type).build())
        .send()
        .await
        .map_err(|e| {
            let text = format!("{e:?}");
            if text.contains("InvalidAction") {
                unsupported(conn, e, "ModifyInstanceAttribute")
            } else if text.contains("not supported") || text.contains("Unsupported") {
                other(format!("{instance_type} doesn't support this instance's image or settings (architecture, virtualization or network adapter)."))
            } else {
                err(conn, e)
            }
        })?;
    Ok(())
}

/// Turns termination and / or stop protection on or off.
pub async fn set_protection(conn: &Connection, id: &str, termination: Option<bool>, stop: Option<bool>) -> Result<(), AppError> {
    if termination.is_none() && stop.is_none() {
        return Err(other("Nothing to change."));
    }
    let c = client(conn);
    // One attribute per call: ModifyInstanceAttribute takes one at a time.
    if let Some(v) = termination {
        c.modify_instance_attribute()
            .instance_id(id)
            .disable_api_termination(AttributeBooleanValue::builder().value(v).build())
            .send()
            .await
            .map_err(|e| unsupported(conn, e, "ModifyInstanceAttribute"))?;
    }
    if let Some(v) = stop {
        c.modify_instance_attribute()
            .instance_id(id)
            .disable_api_stop(AttributeBooleanValue::builder().value(v).build())
            .send()
            .await
            .map_err(|e| unsupported(conn, e, "ModifyInstanceAttribute"))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TypeInfo {
    pub name: String,
    pub vcpus: Option<i32>,
    pub memory_mib: Option<i64>,
    pub current_generation: Option<bool>,
}

/// Sorts "t3.micro" < "t3.small" < "t3.2xlarge" < "t3a.micro": family, then size.
pub fn type_order(name: &str) -> (String, usize, u32, String) {
    const SIZES: [&str; 9] = ["nano", "micro", "small", "medium", "large", "xlarge", "metal", "", ""];
    let (family, size) = name.split_once('.').unwrap_or((name, ""));
    let digits: String = size.chars().take_while(|c| c.is_ascii_digit()).collect();
    let rest = &size[digits.len()..];
    let mult: u32 = digits.parse().unwrap_or(if rest == "xlarge" { 1 } else { 0 });
    let rank = SIZES.iter().position(|s| *s == rest).unwrap_or(7);
    let rank = if rest.starts_with("metal") { 6 } else { rank };
    (family.to_string(), rank, mult, size.to_string())
}

/// Instance types offered in `az` for `architecture` (x86_64 / arm64), with vCPUs and memory.
pub async fn instance_types(conn: &Connection, az: &str, architecture: Option<&str>) -> Result<Vec<TypeInfo>, AppError> {
    let c = client(conn);
    let mut offered = std::collections::HashSet::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .describe_instance_type_offerings()
            .location_type(LocationType::AvailabilityZone)
            .filters(filter("location", &[az]))
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        offered.extend(
            page.instance_type_offerings()
                .iter()
                .filter_map(|o| o.instance_type())
                .map(|t| t.as_str().to_string()),
        );
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut req = c.describe_instance_types().max_results(100).set_next_token(token.clone());
        if let Some(a) = architecture {
            req = req.filters(filter("processor-info.supported-architecture", &[a]));
        }
        let page = match req.send().await {
            Ok(p) => p,
            // Without type details, the names alone still make a usable list.
            Err(_) if out.is_empty() => break,
            Err(e) => return Err(err(conn, e)),
        };
        for t in page.instance_types() {
            let Some(name) = t.instance_type().map(|x| x.as_str().to_string()) else { continue };
            if offered.is_empty() || offered.contains(&name) {
                out.push(TypeInfo {
                    name,
                    vcpus: t.v_cpu_info().and_then(|v| v.default_v_cpus()),
                    memory_mib: t.memory_info().and_then(|m| m.size_in_mib()),
                    current_generation: t.current_generation(),
                });
            }
        }
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    if out.is_empty() {
        out = offered.into_iter().map(|name| TypeInfo { name, ..Default::default() }).collect();
    }
    out.sort_by_key(|t| type_order(&t.name));
    out.dedup_by(|a, b| a.name == b.name);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_types_and_ids() {
        assert!(valid_type("t3.micro"));
        assert!(valid_type("m7i-flex.large"));
        assert!(!valid_type("t3"));
        assert!(!valid_type("T3.micro"));
        assert!(!valid_type("t3.micro.x"));
        assert!(check_ids(&[]).is_err());
        assert!(check_ids(&["vol-1".into()]).is_err());
        assert!(check_ids(&["i-1".into()]).is_ok());
    }

    #[test]
    fn orders_types_by_family_then_size() {
        let mut v = vec!["t3.2xlarge", "t3a.micro", "t3.micro", "t3.xlarge", "t3.large", "t3.small", "t3.nano", "m5.metal", "m5.24xlarge"];
        v.sort_by_key(|t| type_order(t));
        assert_eq!(v, vec!["m5.24xlarge", "m5.metal", "t3.nano", "t3.micro", "t3.small", "t3.large", "t3.xlarge", "t3.2xlarge", "t3a.micro"]);
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::ec2::emulator_tests::{connect, ensure_instance};

    #[tokio::test]
    #[ignore]
    async fn stops_retypes_protects_and_starts() {
        let conn = connect().await;
        let id = ensure_instance(&conn, "s3x-ec2-actions").await;
        let ids = vec![id.clone()];
        stop(&conn, &ids, false, false).await.unwrap();
        // Emulators stop at once; real AWS takes a while.
        for _ in 0..20 {
            if get_instance(&conn, &id).await.unwrap().state.as_deref() == Some("stopped") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        let target = if get_instance(&conn, &id).await.unwrap().instance_type.as_deref() == Some("t3.small") { "t3.micro" } else { "t3.small" };
        assert!(set_type(&conn, &id, "nonsense").await.is_err());
        // MiniStack has no ModifyInstanceAttribute: accept its refusal.
        match set_type(&conn, &id, target).await {
            Ok(()) => {
                assert_eq!(get_instance(&conn, &id).await.unwrap().instance_type.as_deref(), Some(target));
                set_protection(&conn, &id, Some(true), None).await.unwrap();
                let d = crate::ec2::instance_details(&conn, &id).await.unwrap();
                if d.termination_protection.is_some() {
                    assert_eq!(d.termination_protection, Some(true));
                }
                set_protection(&conn, &id, Some(false), None).await.unwrap();
            }
            Err(e) => assert!(e.message.contains("doesn't support"), "{}", e.message),
        }

        start(&conn, &ids).await.unwrap();
        reboot(&conn, &ids).await.unwrap();
        // Type listing may not exist on an emulator; it must not panic.
        let _ = instance_types(&conn, "eu-west-2a", Some("x86_64")).await;
    }
}
