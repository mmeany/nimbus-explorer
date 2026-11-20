//! Step Functions: publish and delete versions, create / update / delete aliases.

use crate::error::AppError;
use crate::s3::Connection;
use crate::sfn::{client, err, other};
use aws_sdk_sfn::types::RoutingConfigurationListItem;
use serde::Deserialize;

/// Publishes the machine's current definition as a version. With
/// `revision_id`, AWS refuses if the machine changed since it was read.
pub async fn publish(
    conn: &Connection,
    machine_arn: &str,
    description: Option<&str>,
    revision_id: Option<&str>,
) -> Result<String, AppError> {
    let description = description.map(str::trim).filter(|d| !d.is_empty());
    if description.is_some_and(|d| d.chars().count() > 256) {
        return Err(other("The description is at most 256 characters"));
    }
    let out = client(conn)
        .publish_state_machine_version()
        .state_machine_arn(machine_arn)
        .set_description(description.map(String::from))
        .set_revision_id(revision_id.map(String::from))
        .send()
        .await
        .map_err(|e| {
            if format!("{e:?}").contains("revisionId has changed") {
                other("The state machine changed since this view loaded it; refresh and check the definition before publishing.")
            } else {
                err(conn, e)
            }
        })?;
    Ok(out.state_machine_version_arn().to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub version_arn: String,
    /// 0 to 100; the routes add up to 100.
    pub weight: i32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasRequest {
    pub machine_arn: String,
    pub name: String,
    pub description: Option<String>,
    /// One version, or two with weights.
    pub routing: Vec<Route>,
}

/// Why AWS would refuse an alias name, if it would: 1–80 letters, digits,
/// "-", "_" or ".", and not only digits (that would look like a version).
pub fn alias_name_problem(name: &str) -> Option<String> {
    if name.is_empty() || name.chars().count() > 80 {
        return Some("Alias names are 1 to 80 characters".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Some("Alias names use letters, digits, -, _ and .".into());
    }
    if name.chars().all(|c| c.is_ascii_digit()) {
        return Some("An alias name can't be only digits (it would look like a version)".into());
    }
    None
}

pub fn routing_problem(routing: &[Route]) -> Option<String> {
    match routing {
        [] => Some("Choose a version".into()),
        [_] => None,
        [a, b] => {
            if a.version_arn == b.version_arn {
                Some("Choose two different versions".into())
            } else if !(0..=100).contains(&a.weight)
                || !(0..=100).contains(&b.weight)
                || a.weight + b.weight != 100
            {
                Some("The two weights are 0 to 100 and add up to 100".into())
            } else {
                None
            }
        }
        _ => Some("An alias routes to at most two versions".into()),
    }
}

fn routing_config(routing: &[Route]) -> Result<Vec<RoutingConfigurationListItem>, AppError> {
    // A single route always carries all the traffic.
    let single = routing.len() == 1;
    routing
        .iter()
        .map(|r| {
            RoutingConfigurationListItem::builder()
                .state_machine_version_arn(&r.version_arn)
                .weight(if single { 100 } else { r.weight })
                .build()
                .map_err(|e| other(e.to_string()))
        })
        .collect()
}

pub async fn create_alias(conn: &Connection, r: &AliasRequest) -> Result<String, AppError> {
    let name = r.name.trim();
    if let Some(p) = alias_name_problem(name).or_else(|| routing_problem(&r.routing)) {
        return Err(other(p));
    }
    let out = client(conn)
        .create_state_machine_alias()
        .name(name)
        .set_description(r.description.clone().filter(|d| !d.trim().is_empty()))
        .set_routing_configuration(Some(routing_config(&r.routing)?))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out.state_machine_alias_arn().to_string())
}

/// Updates the alias. The routing is always sent in full, so a split can be removed.
pub async fn update_alias(conn: &Connection, r: &AliasRequest) -> Result<(), AppError> {
    if let Some(p) = routing_problem(&r.routing) {
        return Err(other(p));
    }
    client(conn)
        .update_state_machine_alias()
        .state_machine_alias_arn(format!("{}:{}", r.machine_arn, r.name.trim()))
        .description(r.description.clone().unwrap_or_default())
        .set_routing_configuration(Some(routing_config(&r.routing)?))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

pub async fn delete_alias(conn: &Connection, alias_arn: &str) -> Result<(), AppError> {
    client(conn)
        .delete_state_machine_alias()
        .state_machine_alias_arn(alias_arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

/// Deletes a version, refusing (before asking AWS) while an alias routes to it.
pub async fn delete_version(conn: &Connection, version_arn: &str) -> Result<(), AppError> {
    let machine_arn = version_arn
        .rsplit_once(':')
        .map(|(m, _)| m)
        .unwrap_or(version_arn);
    let v = crate::sfn::versions(conn, machine_arn).await?;
    let users: Vec<&str> = v
        .aliases
        .iter()
        .filter(|a| a.routing.iter().any(|r| r.version_arn == version_arn))
        .map(|a| a.name.as_str())
        .collect();
    if !users.is_empty() {
        return Err(other(format!(
            "Alias {} uses this version; point {} at another version first.",
            users.join(", "),
            if users.len() == 1 { "it" } else { "them" }
        )));
    }
    client(conn)
        .delete_state_machine_version()
        .state_machine_version_arn(version_arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(v: &str, w: i32) -> Route {
        Route {
            version_arn: v.into(),
            weight: w,
        }
    }

    #[test]
    fn checks_alias_names() {
        assert_eq!(alias_name_problem("live"), None);
        assert_eq!(alias_name_problem("prod-v2.1_b"), None);
        assert!(alias_name_problem("").is_some());
        assert!(alias_name_problem("12").unwrap().contains("only digits"));
        assert!(alias_name_problem("a b").is_some());
        assert!(alias_name_problem(&"a".repeat(81)).is_some());
    }

    #[test]
    fn checks_routing() {
        assert!(routing_problem(&[]).is_some());
        assert_eq!(routing_problem(&[route("v1", 0)]), None);
        assert_eq!(routing_problem(&[route("v1", 90), route("v2", 10)]), None);
        assert!(routing_problem(&[route("v1", 90), route("v1", 10)])
            .unwrap()
            .contains("different"));
        assert!(routing_problem(&[route("v1", 90), route("v2", 20)])
            .unwrap()
            .contains("100"));
        assert!(routing_problem(&[route("a", 50), route("b", 25), route("c", 25)]).is_some());
        // One route always carries everything, whatever weight the UI sent.
        let one = routing_config(&[route("v1", 37)]).unwrap();
        assert_eq!(one[0].weight(), 100);
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::sfn::emulator_tests::{connect, fresh_machine};

    #[tokio::test]
    #[ignore]
    async fn publishes_and_routes_versions() {
        let conn = connect().await;
        let arn = fresh_machine(&conn, "s3x-sfn-versions").await;
        let rev = crate::sfn::describe(&conn, &arn).await.unwrap().revision_id;
        let v1 = publish(&conn, &arn, Some("first"), rev.as_deref())
            .await
            .unwrap();
        assert!(v1.ends_with(":1"));
        // A stale revision is refused with a plain message.
        if rev.is_some() {
            client(&conn)
                .update_state_machine()
                .state_machine_arn(&arn)
                .definition(r#"{"StartAt":"B","States":{"B":{"Type":"Pass","End":true}}}"#)
                .send()
                .await
                .unwrap();
            let stale = publish(&conn, &arn, None, rev.as_deref())
                .await
                .unwrap_err();
            assert!(stale.message.contains("changed since"), "{}", stale.message);
        }
        let v2 = publish(&conn, &arn, None, None).await.unwrap();

        let req = AliasRequest {
            machine_arn: arn.clone(),
            name: "live".into(),
            description: Some("prod".into()),
            routing: vec![
                Route {
                    version_arn: v1.clone(),
                    weight: 80,
                },
                Route {
                    version_arn: v2.clone(),
                    weight: 20,
                },
            ],
        };
        let alias = create_alias(&conn, &req).await.unwrap();
        assert!(alias.ends_with(":live"));
        let v = crate::sfn::versions(&conn, &arn).await.unwrap();
        let live = v.aliases.iter().find(|a| a.name == "live").unwrap();
        assert_eq!(live.routing.len(), 2);

        // Removing the split sends the full (single) routing.
        update_alias(
            &conn,
            &AliasRequest {
                routing: vec![Route {
                    version_arn: v2.clone(),
                    weight: 100,
                }],
                ..req.clone()
            },
        )
        .await
        .unwrap();
        let v = crate::sfn::versions(&conn, &arn).await.unwrap();
        let live = v.aliases.iter().find(|a| a.name == "live").unwrap();
        assert_eq!(
            live.routing
                .iter()
                .map(|r| (r.version.as_str(), r.weight))
                .collect::<Vec<_>>(),
            [("2", 100)]
        );

        // v2 is in use: refused before reaching AWS. v1 isn't any more.
        assert!(delete_version(&conn, &v2)
            .await
            .unwrap_err()
            .message
            .contains("live"));
        delete_version(&conn, &v1).await.unwrap();
        delete_alias(&conn, &alias).await.unwrap();
        delete_version(&conn, &v2).await.unwrap();
        let v = crate::sfn::versions(&conn, &arn).await.unwrap();
        assert!(v.versions.is_empty() && v.aliases.is_empty());
    }
}
