//! Changing Lambda functions: configuration, concurrency, triggers on / off,
//! versions, aliases and deletes. Every command that calls these checks
//! read-only mode first.

use crate::error::AppError;
use crate::lambda::{client, err, other};
use crate::s3::Connection;
use aws_sdk_lambda::types::{AliasRoutingConfiguration, Environment};
use serde::Deserialize;
use std::collections::BTreeMap;

pub const MIN_MEMORY: i32 = 128;
pub const MAX_MEMORY: i32 = 10_240;
pub const MAX_TIMEOUT: i32 = 900;

/// Fields to change; None = leave as it is.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfigChange {
    pub description: Option<String>,
    pub memory_mb: Option<i32>,
    pub timeout_secs: Option<i32>,
    /// The complete new set of environment variables.
    pub env: Option<BTreeMap<String, String>>,
    /// The revision the edit started from; AWS refuses the change if the
    /// function changed meanwhile.
    pub revision_id: Option<String>,
}

pub fn env_key_problem(key: &str) -> Option<String> {
    let mut chars = key.chars();
    match chars.next() {
        None => Some("Environment variable names can't be empty".into()),
        Some(c) if !(c.is_ascii_alphabetic()) => Some(format!("{key}: names start with a letter")),
        _ if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') => {
            Some(format!("{key}: names use letters, digits and _ only"))
        }
        _ if key.starts_with("AWS_") => {
            Some(format!("{key}: names starting with AWS_ are reserved"))
        }
        _ => None,
    }
}

pub fn change_problem(c: &ConfigChange) -> Option<String> {
    if let Some(m) = c.memory_mb {
        if !(MIN_MEMORY..=MAX_MEMORY).contains(&m) {
            return Some(format!("Memory is {MIN_MEMORY} to {MAX_MEMORY} MB"));
        }
    }
    if let Some(t) = c.timeout_secs {
        if !(1..=MAX_TIMEOUT).contains(&t) {
            return Some(format!("Timeout is 1 to {MAX_TIMEOUT} seconds"));
        }
    }
    if let Some(d) = &c.description {
        if d.chars().count() > 256 {
            return Some("Descriptions are at most 256 characters".into());
        }
    }
    if let Some(env) = &c.env {
        if let Some(p) = env.keys().find_map(|k| env_key_problem(k)) {
            return Some(p);
        }
        // Lambda's limit is 4 KB for all variables together.
        let size: usize = env.iter().map(|(k, v)| k.len() + v.len()).sum();
        if size > 4096 {
            return Some("Environment variables are limited to 4 KB in total".into());
        }
    }
    None
}

pub async fn update_config(
    conn: &Connection,
    name: &str,
    c: &ConfigChange,
) -> Result<(), AppError> {
    if let Some(p) = change_problem(c) {
        return Err(other(p));
    }
    client(conn)
        .update_function_configuration()
        .function_name(name)
        .set_description(c.description.clone())
        .set_memory_size(c.memory_mb)
        .set_timeout(c.timeout_secs)
        .set_environment(c.env.as_ref().map(|e| {
            Environment::builder()
                .set_variables(Some(e.clone().into_iter().collect()))
                .build()
        }))
        .set_revision_id(c.revision_id.clone())
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

/// Some(n) reserves n (0 stops the function running); None removes the reservation.
pub async fn set_reserved_concurrency(
    conn: &Connection,
    name: &str,
    reserved: Option<i32>,
) -> Result<(), AppError> {
    let c = client(conn);
    match reserved {
        Some(n) if n < 0 => return Err(other("Reserved concurrency can't be negative")),
        Some(n) => {
            c.put_function_concurrency()
                .function_name(name)
                .reserved_concurrent_executions(n)
                .send()
                .await
                .map_err(|e| err(conn, e))?;
        }
        None => {
            c.delete_function_concurrency()
                .function_name(name)
                .send()
                .await
                .map_err(|e| err(conn, e))?;
        }
    }
    Ok(())
}

pub async fn set_mapping_enabled(
    conn: &Connection,
    uuid: &str,
    enabled: bool,
) -> Result<(), AppError> {
    client(conn)
        .update_event_source_mapping()
        .uuid(uuid)
        .enabled(enabled)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

/// Publishes $LATEST as a new numbered version; returns its number.
pub async fn publish_version(
    conn: &Connection,
    name: &str,
    description: &str,
) -> Result<String, AppError> {
    let out = client(conn)
        .publish_version()
        .function_name(name)
        .set_description(Some(description.trim().to_string()).filter(|d| !d.is_empty()))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out.version().unwrap_or_default().to_string())
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AliasRequest {
    pub alias: String,
    pub version: String,
    pub description: Option<String>,
    /// A second version and the share of traffic (0 < w < 1) it gets.
    pub extra: Option<(String, f64)>,
}

pub fn alias_problem(a: &AliasRequest) -> Option<String> {
    let n = a.alias.trim();
    if n.is_empty() || n.len() > 128 {
        return Some("Alias names are 1 to 128 characters".into());
    }
    if !n
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        || n.chars().all(|c| c.is_ascii_digit())
    {
        return Some("Alias names use letters, digits, - and _ (and can't be only digits)".into());
    }
    if a.version.trim().is_empty() {
        return Some("Choose a version".into());
    }
    if let Some((v, w)) = &a.extra {
        if v == &a.version {
            return Some("The second version must differ from the first".into());
        }
        if v == "$LATEST" || a.version == "$LATEST" {
            return Some("Traffic can only be split between published versions".into());
        }
        if !(*w > 0.0 && *w < 1.0) {
            return Some("The second version's share is between 0 and 100%".into());
        }
    }
    None
}

fn routing(a: &AliasRequest) -> Option<AliasRoutingConfiguration> {
    Some(
        AliasRoutingConfiguration::builder()
            .set_additional_version_weights(Some(
                a.extra.iter().map(|(v, w)| (v.clone(), *w)).collect(),
            ))
            .build(),
    )
}

pub async fn create_alias(conn: &Connection, name: &str, a: &AliasRequest) -> Result<(), AppError> {
    if let Some(p) = alias_problem(a) {
        return Err(other(p));
    }
    client(conn)
        .create_alias()
        .function_name(name)
        .name(a.alias.trim())
        .function_version(&a.version)
        .set_description(a.description.clone())
        .set_routing_config(if a.extra.is_some() { routing(a) } else { None })
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

pub async fn update_alias(conn: &Connection, name: &str, a: &AliasRequest) -> Result<(), AppError> {
    if let Some(p) = alias_problem(a) {
        return Err(other(p));
    }
    client(conn)
        .update_alias()
        .function_name(name)
        .name(a.alias.trim())
        .function_version(&a.version)
        .description(a.description.clone().unwrap_or_default())
        // An empty weights map removes a previous split.
        .set_routing_config(routing(a))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

pub async fn delete_alias(conn: &Connection, name: &str, alias: &str) -> Result<(), AppError> {
    client(conn)
        .delete_alias()
        .function_name(name)
        .name(alias)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

/// Deletes one published version (not $LATEST; aliases must not point at it).
pub async fn delete_version(conn: &Connection, name: &str, version: &str) -> Result<(), AppError> {
    if version == "$LATEST" || version.parse::<u64>().is_err() {
        return Err(other(
            "Only published (numbered) versions can be deleted on their own",
        ));
    }
    client(conn)
        .delete_function()
        .function_name(name)
        .qualifier(version)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

/// Deletes the function with all its versions and aliases.
pub async fn delete_function(conn: &Connection, name: &str) -> Result<(), AppError> {
    client(conn)
        .delete_function()
        .function_name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_changes() {
        assert!(change_problem(&ConfigChange {
            memory_mb: Some(64),
            ..Default::default()
        })
        .is_some());
        assert!(change_problem(&ConfigChange {
            timeout_secs: Some(901),
            ..Default::default()
        })
        .is_some());
        assert!(change_problem(&ConfigChange {
            memory_mb: Some(1769),
            timeout_secs: Some(30),
            ..Default::default()
        })
        .is_none());
        let env = |k: &str| ConfigChange {
            env: Some([(k.to_string(), "v".to_string())].into()),
            ..Default::default()
        };
        assert!(change_problem(&env("STAGE")).is_none());
        assert!(change_problem(&env("1ABC")).is_some());
        assert!(change_problem(&env("A-B")).is_some());
        assert!(change_problem(&env("AWS_REGION")).is_some());
        let big = ConfigChange {
            env: Some([("BIG".to_string(), "x".repeat(5000))].into()),
            ..Default::default()
        };
        assert!(change_problem(&big).unwrap().contains("4 KB"));
    }

    #[test]
    fn checks_aliases() {
        let ok = AliasRequest {
            alias: "live".into(),
            version: "3".into(),
            description: None,
            extra: Some(("4".into(), 0.1)),
        };
        assert!(alias_problem(&ok).is_none());
        assert!(alias_problem(&AliasRequest {
            alias: "123".into(),
            ..ok.clone()
        })
        .is_some());
        assert!(alias_problem(&AliasRequest {
            alias: "a b".into(),
            ..ok.clone()
        })
        .is_some());
        assert!(alias_problem(&AliasRequest {
            extra: Some(("3".into(), 0.5)),
            ..ok.clone()
        })
        .is_some());
        assert!(alias_problem(&AliasRequest {
            extra: Some(("4".into(), 1.0)),
            ..ok.clone()
        })
        .is_some());
        assert!(alias_problem(&AliasRequest {
            version: "$LATEST".into(),
            ..ok
        })
        .is_some());
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::lambda::emulator_tests::{connect, fresh_function};

    #[tokio::test]
    #[ignore]
    async fn changes_functions() {
        let conn = connect().await;
        fresh_function(&conn, "s3x-fn-admin").await;
        let before = crate::lambda::get(&conn, "s3x-fn-admin").await.unwrap();
        update_config(
            &conn,
            "s3x-fn-admin",
            &ConfigChange {
                memory_mb: Some(512),
                timeout_secs: Some(60),
                env: Some([("STAGE".to_string(), "prod".to_string())].into()),
                revision_id: before.revision_id.clone(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let after = crate::lambda::get(&conn, "s3x-fn-admin").await.unwrap();
        assert_eq!(after.summary.memory_mb, Some(512));
        assert_eq!(after.summary.timeout_secs, Some(60));
        assert_eq!(after.env_keys, ["STAGE"]);

        set_reserved_concurrency(&conn, "s3x-fn-admin", Some(5))
            .await
            .unwrap();
        assert_eq!(
            crate::lambda::get(&conn, "s3x-fn-admin")
                .await
                .unwrap()
                .reserved_concurrency,
            Some(5)
        );
        set_reserved_concurrency(&conn, "s3x-fn-admin", None)
            .await
            .unwrap();

        let v = publish_version(&conn, "s3x-fn-admin", "first")
            .await
            .unwrap();
        assert_eq!(v, "1");
        let a = AliasRequest {
            alias: "live".into(),
            version: "1".into(),
            description: Some("prod".into()),
            extra: None,
        };
        create_alias(&conn, "s3x-fn-admin", &a).await.unwrap();
        let vs = crate::lambda::versions(&conn, "s3x-fn-admin")
            .await
            .unwrap();
        assert_eq!(vs.aliases[0].version, "1");
        delete_alias(&conn, "s3x-fn-admin", "live").await.unwrap();
        assert!(delete_version(&conn, "s3x-fn-admin", "$LATEST")
            .await
            .is_err());
        delete_version(&conn, "s3x-fn-admin", "1").await.unwrap();
        delete_function(&conn, "s3x-fn-admin").await.unwrap();
        assert!(crate::lambda::get(&conn, "s3x-fn-admin").await.is_err());
    }
}
