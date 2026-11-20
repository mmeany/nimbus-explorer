//! ElastiCache parameter groups (read only): the group a cache uses and its
//! parameters, optionally only the ones changed from the defaults.

use crate::elasticache::{client, err, other};
use crate::error::AppError;
use crate::s3::Connection;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Parameter {
    pub name: String,
    pub value: Option<String>,
    pub description: Option<String>,
    /// "user" = changed from the default; "system" / "engine-default" otherwise.
    pub source: Option<String>,
    pub data_type: Option<String>,
    pub allowed_values: Option<String>,
    pub modifiable: Option<bool>,
    pub minimum_engine_version: Option<String>,
    /// immediate or requires-reboot.
    pub change_type: Option<String>,
    /// Values per node type, for parameters that depend on it (maxmemory, …).
    pub per_node_type: Vec<(String, String)>,
}

impl Parameter {
    pub fn changed(&self) -> bool {
        self.source.as_deref() == Some("user")
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ParameterGroup {
    pub name: String,
    pub family: Option<String>,
    pub description: Option<String>,
    pub arn: Option<String>,
    pub is_global: bool,
    /// By name.
    pub parameters: Vec<Parameter>,
}

/// Keeps changed parameters only when asked (some endpoints ignore the
/// Source filter), and sorts by name.
pub fn finish(mut params: Vec<Parameter>, changed_only: bool) -> Vec<Parameter> {
    if changed_only {
        params.retain(Parameter::changed);
    }
    params.sort_by(|a, b| a.name.cmp(&b.name));
    params.dedup_by(|a, b| a.name == b.name);
    params
}

pub async fn parameter_group(
    conn: &Connection,
    name: &str,
    changed_only: bool,
) -> Result<ParameterGroup, AppError> {
    let c = client(conn);
    let g = c
        .describe_cache_parameter_groups()
        .cache_parameter_group_name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let info = g
        .cache_parameter_groups()
        .first()
        .ok_or_else(|| other(format!("There's no parameter group called {name}.")))?;
    let mut params = Vec::new();
    let mut marker: Option<String> = None;
    loop {
        let mut req = c
            .describe_cache_parameters()
            .cache_parameter_group_name(name)
            .max_records(100)
            .set_marker(marker.clone());
        if changed_only {
            req = req.source("user");
        }
        let page = req.send().await.map_err(|e| err(conn, e))?;
        params.extend(page.parameters().iter().map(|p| Parameter {
            name: p.parameter_name().unwrap_or_default().to_string(),
            value: p.parameter_value().map(String::from),
            description: p.description().map(String::from),
            source: p.source().map(String::from),
            data_type: p.data_type().map(String::from),
            allowed_values: p.allowed_values().map(String::from),
            modifiable: p.is_modifiable(),
            minimum_engine_version: p.minimum_engine_version().map(String::from),
            change_type: p.change_type().map(|t| t.as_str().to_string()),
            per_node_type: Vec::new(),
        }));
        params.extend(page.cache_node_type_specific_parameters().iter().map(|p| {
            Parameter {
                name: p.parameter_name().unwrap_or_default().to_string(),
                value: None,
                description: p.description().map(String::from),
                source: p.source().map(String::from),
                data_type: p.data_type().map(String::from),
                allowed_values: p.allowed_values().map(String::from),
                modifiable: p.is_modifiable(),
                minimum_engine_version: p.minimum_engine_version().map(String::from),
                change_type: p.change_type().map(|t| t.as_str().to_string()),
                per_node_type: p
                    .cache_node_type_specific_values()
                    .iter()
                    .map(|v| {
                        (
                            v.cache_node_type().unwrap_or_default().to_string(),
                            v.value().unwrap_or_default().to_string(),
                        )
                    })
                    .collect(),
            }
        }));
        match page.marker() {
            Some(m) if !m.is_empty() && Some(m) != marker.as_deref() => {
                marker = Some(m.to_string())
            }
            _ => break,
        }
    }
    Ok(ParameterGroup {
        name: info
            .cache_parameter_group_name()
            .unwrap_or(name)
            .to_string(),
        family: info.cache_parameter_group_family().map(String::from),
        description: info
            .description()
            .filter(|d| !d.is_empty())
            .map(String::from),
        arn: info.arn().map(String::from),
        is_global: info.is_global().unwrap_or(false),
        parameters: finish(params, changed_only),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(name: &str, source: &str) -> Parameter {
        Parameter {
            name: name.into(),
            source: Some(source.into()),
            ..Default::default()
        }
    }

    #[test]
    fn keeps_only_changed_values_when_asked() {
        let all = vec![
            p("timeout", "system"),
            p("maxmemory-policy", "user"),
            p("databases", "engine-default"),
        ];
        assert_eq!(
            finish(all.clone(), false)
                .iter()
                .map(|x| x.name.as_str())
                .collect::<Vec<_>>(),
            ["databases", "maxmemory-policy", "timeout"]
        );
        assert_eq!(
            finish(all, true)
                .iter()
                .map(|x| x.name.as_str())
                .collect::<Vec<_>>(),
            ["maxmemory-policy"]
        );
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::elasticache::emulator_tests::connect;

    #[tokio::test]
    #[ignore]
    async fn reads_parameters_and_changed_ones() {
        let conn = connect().await;
        let c = client(&conn);
        if c.describe_cache_parameter_groups()
            .cache_parameter_group_name("s3x-ec-params")
            .send()
            .await
            .is_err()
        {
            c.create_cache_parameter_group()
                .cache_parameter_group_name("s3x-ec-params")
                .cache_parameter_group_family("valkey8")
                .description("test")
                .send()
                .await
                .unwrap();
        }
        c.modify_cache_parameter_group()
            .cache_parameter_group_name("s3x-ec-params")
            .parameter_name_values(
                aws_sdk_elasticache::types::ParameterNameValue::builder()
                    .parameter_name("maxmemory-policy")
                    .parameter_value("allkeys-lru")
                    .build(),
            )
            .send()
            .await
            .unwrap();
        let all = parameter_group(&conn, "s3x-ec-params", false)
            .await
            .unwrap();
        assert_eq!(all.family.as_deref(), Some("valkey8"));
        assert!(all.parameters.len() > 1);
        let changed = parameter_group(&conn, "s3x-ec-params", true).await.unwrap();
        assert_eq!(
            changed
                .parameters
                .iter()
                .map(|p| (p.name.as_str(), p.value.as_deref()))
                .collect::<Vec<_>>(),
            [("maxmemory-policy", Some("allkeys-lru"))]
        );
        assert!(parameter_group(&conn, "s3x-ec-missing", false)
            .await
            .is_err());
    }
}
