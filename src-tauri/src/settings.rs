//! Non-secret app settings, stored as JSON in the OS app-config folder
//! (on Windows: %APPDATA%\<identifier>\settings.json).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Per-profile connection override, set from the Connection settings dialog.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionOverride {
    /// Endpoint to use instead of the profile's `endpoint_url`. None = use the profile's.
    pub endpoint_url: Option<String>,
    /// Force path-style addressing. None = automatic (on for custom endpoints).
    pub path_style: Option<bool>,
}

/// Colour theme preference. `System` follows the OS (dark if the OS can't say).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ThemePref {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub last_profile: Option<String>,
    pub theme: ThemePref,
    pub overrides: BTreeMap<String, ConnectionOverride>,
    /// profile -> region selected in the toolbar for the regional services.
    pub regions: BTreeMap<String, String>,
    /// Remembered filters, newest first, keyed by "<service>|<profile>|<region>".
    pub filter_history: BTreeMap<String, Vec<String>>,
}

/// Filters remembered per key.
pub const FILTER_HISTORY_LEN: usize = 10;

impl Settings {
    /// Records a filter as most recent (deduplicated, capped).
    pub fn remember_filter(&mut self, key: &str, value: &str) {
        let value = value.trim();
        if value.is_empty() {
            return;
        }
        let list = self.filter_history.entry(key.to_string()).or_default();
        list.retain(|v| v != value);
        list.insert(0, value.to_string());
        list.truncate(FILTER_HISTORY_LEN);
    }

    pub fn forget_filter(&mut self, key: &str, value: &str) {
        if let Some(list) = self.filter_history.get_mut(key) {
            list.retain(|v| v != value);
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            path: dir.join("settings.json"),
        }
    }

    /// The folder settings live in (other app files go beside them).
    pub fn dir(&self) -> PathBuf {
        self.path.parent().map(PathBuf::from).unwrap_or_default()
    }

    /// Loads settings; a missing or unreadable file yields defaults.
    pub fn load(&self) -> Settings {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, settings: &Settings) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
        // Write to a temp file then rename, so a crash can't leave a half-written file.
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }

    pub fn update(&self, f: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
        let mut s = self.load();
        f(&mut s);
        self.save(&s)?;
        Ok(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_read_only_entries_are_ignored() {
        // Settings files from before "always start read-only" have a readOnly map.
        let s: Settings = serde_json::from_str(r#"{"readOnly":{"dev":false},"lastProfile":"dev"}"#).unwrap();
        assert_eq!(s.last_profile.as_deref(), Some("dev"));
        let out = serde_json::to_string(&s).unwrap();
        assert!(!out.contains("readOnly"));
    }

    #[test]
    fn filter_history_is_newest_first_deduped_and_capped() {
        let mut s = Settings::default();
        for i in 0..12 {
            s.remember_filter("k", &format!("/f{i}"));
        }
        s.remember_filter("k", "/f5");
        s.remember_filter("k", "   ");
        let h = &s.filter_history["k"];
        assert_eq!(h.len(), FILTER_HISTORY_LEN);
        assert_eq!(h[0], "/f5");
        assert_eq!(h[1], "/f11");
        assert_eq!(h.iter().filter(|v| *v == "/f5").count(), 1);
        s.forget_filter("k", "/f5");
        assert_eq!(s.filter_history["k"][0], "/f11");
    }
}
