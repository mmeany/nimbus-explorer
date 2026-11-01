//! Discovers AWS profile names from the shared config and credentials files.
//!
//! This only reads names plus the few settings the UI displays (region,
//! endpoint_url, sso_session). Actual credential resolution is left entirely to the AWS SDK.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub name: String,
    pub region: Option<String>,
    pub endpoint_url: Option<String>,
    /// The profile's `sso_session` (the name of an `[sso-session …]` section).
    pub sso_session: Option<String>,
}

/// Lists profiles from `~/.aws/config` and `~/.aws/credentials`
/// (or the files named by `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE`).
pub fn list_profiles() -> Vec<ProfileInfo> {
    profiles_from(
        read_file("AWS_CONFIG_FILE", "config").as_deref(),
        read_file("AWS_SHARED_CREDENTIALS_FILE", "credentials").as_deref(),
    )
}

/// Profiles from the text of the config and credentials files, by name.
fn profiles_from(config: Option<&str>, credentials: Option<&str>) -> Vec<ProfileInfo> {
    let mut profiles: BTreeMap<String, ProfileInfo> = BTreeMap::new();

    if let Some(text) = config {
        for (section, values) in parse_ini(text) {
            // In the config file, profiles are "[default]" or "[profile name]".
            let name = if section == "default" {
                "default".to_string()
            } else if let Some(rest) = section.strip_prefix("profile ") {
                rest.trim().to_string()
            } else {
                continue; // sso-session, services, etc.
            };
            let entry = profiles.entry(name.clone()).or_insert_with(|| ProfileInfo {
                name,
                ..Default::default()
            });
            entry.region = values.get("region").cloned().or(entry.region.take());
            entry.endpoint_url = values
                .get("endpoint_url")
                .cloned()
                .or(entry.endpoint_url.take());
            entry.sso_session = values
                .get("sso_session")
                .cloned()
                .or(entry.sso_session.take());
        }
    }

    if let Some(text) = credentials {
        for (section, _) in parse_ini(text) {
            profiles
                .entry(section.clone())
                .or_insert_with(|| ProfileInfo {
                    name: section,
                    ..Default::default()
                });
        }
    }

    profiles.into_values().collect()
}

fn read_file(env_var: &str, default_name: &str) -> Option<String> {
    let path = match std::env::var(env_var) {
        Ok(p) if !p.trim().is_empty() => expand_home(p.trim()),
        _ => std::env::home_dir()?.join(".aws").join(default_name),
    };
    std::fs::read_to_string(path).ok()
}

fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        if let Some(home) = std::env::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(p)
}

/// Minimal INI parser: returns (section name, key/value map) in file order.
/// Indented lines (nested sub-properties such as `s3 =\n  key = value`) are skipped.
fn parse_ini(text: &str) -> Vec<(String, BTreeMap<String, String>)> {
    let mut out: Vec<(String, BTreeMap<String, String>)> = Vec::new();
    for raw in text.lines() {
        if raw.starts_with(' ') || raw.starts_with('\t') {
            continue;
        }
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            let name = line[1..line.len() - 1].trim().to_string();
            out.push((name, BTreeMap::new()));
        } else if let Some((k, v)) = line.split_once('=') {
            if let Some((_, map)) = out.last_mut() {
                let v = v.trim();
                if !v.is_empty() {
                    map.insert(k.trim().to_ascii_lowercase(), v.to_string());
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sections_and_values() {
        let text = "[default]\nregion = eu-west-2\n\n[profile localstack]\nregion=us-east-1\nendpoint_url = http://localhost:4566\ns3 =\n  addressing_style = path\n[sso-session corp]\nsso_region = eu-west-1\n";
        let parsed = parse_ini(text);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].0, "default");
        assert_eq!(parsed[1].0, "profile localstack");
        assert_eq!(
            parsed[1].1.get("endpoint_url").map(String::as_str),
            Some("http://localhost:4566")
        );
        assert!(!parsed[1].1.contains_key("addressing_style"));
    }

    #[test]
    fn reads_sso_session() {
        let config = "[sso-session my-sso]\nsso_region = eu-west-1\n[profile dev-admin]\nsso_session = my-sso\nsso_account_id = 1\n[profile legacy]\nsso_start_url = https://x\n[default]\nregion = eu-west-2\n";
        let creds = "[keys]\naws_access_key_id = x\n";
        let p = profiles_from(Some(config), Some(creds));
        let names: Vec<&str> = p.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, ["default", "dev-admin", "keys", "legacy"]);
        assert_eq!(p[1].sso_session.as_deref(), Some("my-sso"));
        assert!(p[0].sso_session.is_none() && p[2].sso_session.is_none() && p[3].sso_session.is_none());
    }
}
