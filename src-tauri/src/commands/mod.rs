//! Tauri commands: the only surface the UI can call. Kept thin; logic lives in
//! the service modules. App-level commands are here; each service has its own
//! submodule (s3, …).

pub mod dynamo;
pub mod ecs;
pub mod lambda;
pub mod logs;
pub mod rds;
pub mod s3;
pub mod secrets;
pub mod sns;
pub mod sqs;
pub mod ssm;

use crate::error::AppError;
use crate::profiles::{self, ProfileInfo};
use crate::s3::{Connection, ConnectionInfo};
use crate::settings::{ConnectionOverride, Settings, SettingsStore, ThemePref};
use crate::transfers::Transfers;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};
use tokio::sync::oneshot;

pub struct AppState {
    pub settings: SettingsStore,
    pub conn: Mutex<Option<Arc<Connection>>>,
    pub transfers: Arc<Transfers>,
    pub sync_plans: crate::sync::PlanStore,
    /// Latest Parameter Store import preview (values stay in the backend).
    pub ssm_imports: crate::ssm_io::ImportStore,
    /// Read-only mode for the connected profile. Write commands check this,
    /// so it holds even if the UI were to offer a write by mistake.
    pub read_only: std::sync::atomic::AtomicBool,
}

impl AppState {
    fn is_read_only(&self) -> bool {
        self.read_only.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Call at the start of every command that changes anything in AWS.
    fn ensure_writable(&self) -> Result<(), AppError> {
        if self.is_read_only() {
            Err(AppError::read_only())
        } else {
            Ok(())
        }
    }

    /// Connection details as the UI needs them (region + read-only).
    fn info(&self, conn: &Connection) -> ConnectionInfo {
        ConnectionInfo {
            read_only: self.is_read_only(),
            ..conn.current_info()
        }
    }

    fn connection(&self) -> Result<Arc<Connection>, AppError> {
        self.conn
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(AppError::not_connected)
    }
}

#[tauri::command]
pub fn list_profiles() -> Vec<ProfileInfo> {
    profiles::list_profiles()
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.load()
}

/// Sets (or clears, when `value` is null) the connection override for a profile.
#[tauri::command]
pub fn set_connection_override(
    state: State<'_, AppState>,
    profile: String,
    value: Option<ConnectionOverride>,
) -> Result<Settings, AppError> {
    let value = value.filter(|v| *v != ConnectionOverride::default());
    Ok(state.settings.update(|s| match value {
        Some(v) => {
            s.overrides.insert(profile, v);
        }
        None => {
            s.overrides.remove(&profile);
        }
    })?)
}

#[tauri::command]
pub fn set_theme(state: State<'_, AppState>, theme: ThemePref) -> Result<Settings, AppError> {
    Ok(state.settings.update(|s| s.theme = theme)?)
}

/// Switches the active connection to `profile` and remembers it.
#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    profile: String,
) -> Result<ConnectionInfo, AppError> {
    let info = profiles::list_profiles()
        .into_iter()
        .find(|p| p.name == profile)
        .unwrap_or(ProfileInfo {
            name: profile.clone(),
            ..Default::default()
        });
    let settings = state.settings.load();
    let conn = Connection::new(&info, settings.overrides.get(&profile)).await?;
    if let Some(region) = settings.regions.get(&profile) {
        conn.set_service_region(region);
    }
    // Every connection starts read-only; changes must be allowed each time.
    state
        .read_only
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let result = state.info(&conn);
    *state.conn.lock().unwrap() = Some(Arc::new(conn));
    // Remembering the profile is best-effort; a failed save shouldn't block connecting.
    let _ = state.settings.update(|s| s.last_profile = Some(profile));
    Ok(result)
}

/// Region names are lowercase letters, digits and hyphens (e.g. eu-west-2).
fn valid_region(r: &str) -> bool {
    !r.is_empty()
        && r.len() <= 32
        && r.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !r.starts_with('-')
        && !r.ends_with('-')
}

/// Selects the region for the regional services and remembers it for the profile.
#[tauri::command]
pub fn set_region(state: State<'_, AppState>, region: String) -> Result<ConnectionInfo, AppError> {
    let region = region.trim().to_string();
    if !valid_region(&region) {
        return Err(AppError::new(
            crate::error::ErrorKind::Other,
            format!("'{region}' isn't a valid region name (e.g. eu-west-2)"),
        ));
    }
    let conn = state.connection()?;
    conn.set_service_region(&region);
    let profile = conn.info.profile.clone();
    let _ = state.settings.update(|s| {
        s.regions.insert(profile, region);
    });
    Ok(state.info(&conn))
}

/// Remembers a filter (newest first, last 10) and returns the updated history.
#[tauri::command]
pub fn remember_filter(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<Vec<String>, AppError> {
    let s = state.settings.update(|s| s.remember_filter(&key, &value))?;
    Ok(s.filter_history.get(&key).cloned().unwrap_or_default())
}

/// Removes one filter from the history, or all of them when `value` is null.
#[tauri::command]
pub fn forget_filter(
    state: State<'_, AppState>,
    key: String,
    value: Option<String>,
) -> Result<Vec<String>, AppError> {
    let s = state.settings.update(|s| match &value {
        Some(v) => s.forget_filter(&key, v),
        None => {
            s.filter_history.remove(&key);
        }
    })?;
    Ok(s.filter_history.get(&key).cloned().unwrap_or_default())
}

/// Turns read-only mode on or off for this connection only (not remembered:
/// the next connect starts read-only again).
#[tauri::command]
pub fn set_read_only(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<ConnectionInfo, AppError> {
    let conn = state.connection()?;
    state
        .read_only
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
    Ok(state.info(&conn))
}

#[cfg(test)]
mod tests {
    use super::{valid_region, AppState};
    use crate::error::ErrorKind;

    #[test]
    fn read_only_guard_refuses_writes() {
        let state = AppState {
            settings: crate::settings::SettingsStore::new(std::env::temp_dir().join("s3x-ro-test")),
            conn: std::sync::Mutex::new(None),
            transfers: Default::default(),
            sync_plans: Default::default(),
            ssm_imports: Default::default(),
            read_only: Default::default(),
        };
        assert!(state.ensure_writable().is_ok());
        state
            .read_only
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let err = state.ensure_writable().unwrap_err();
        assert_eq!(err.kind, ErrorKind::ReadOnly);
    }

    #[test]
    fn region_names() {
        assert!(valid_region("eu-west-2"));
        assert!(valid_region("us-gov-west-1"));
        assert!(!valid_region("EU-WEST-2"));
        assert!(!valid_region("eu west"));
        assert!(!valid_region(""));
        assert!(!valid_region("-x"));
    }
}

// ---------------------------------------------------------------------------
// Native dialogs (opened from Rust so the UI needs no extra plugin/permissions)

fn dialog(app: &AppHandle, title: &str) -> FileDialogBuilder<tauri::Wry> {
    let mut d = app.dialog().file().set_title(title);
    if let Some(win) = app.get_webview_window("main") {
        d = d.set_parent(&win);
    }
    d
}

/// Multi-select file picker. Empty when cancelled.
#[tauri::command]
pub async fn pick_upload_files(app: AppHandle) -> Vec<String> {
    let (tx, rx) = oneshot::channel();
    dialog(&app, "Upload files").pick_files(move |f| {
        let _ = tx.send(f);
    });
    rx.await
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Folder picker. None when cancelled.
#[tauri::command]
pub async fn pick_folder(app: AppHandle, title: String) -> Option<String> {
    let (tx, rx) = oneshot::channel();
    dialog(&app, &title).pick_folder(move |f| {
        let _ = tx.send(f);
    });
    rx.await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Single-file open dialog filtered to `extensions` (plus "All files").
#[tauri::command]
pub async fn pick_open_file(
    app: AppHandle,
    title: String,
    filter_name: String,
    extensions: Vec<String>,
) -> Option<String> {
    let (tx, rx) = oneshot::channel();
    let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
    dialog(&app, &title)
        .add_filter(&filter_name, &exts)
        .add_filter("All files", &["*"])
        .pick_file(move |f| {
            let _ = tx.send(f);
        });
    rx.await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Save dialog with a title (asks about overwriting itself). None when cancelled.
#[tauri::command]
pub async fn pick_save_as(app: AppHandle, title: String, default_name: String) -> Option<String> {
    let (tx, rx) = oneshot::channel();
    dialog(&app, &title)
        .set_file_name(crate::transfers::safe_segment(&default_name))
        .save_file(move |f| {
            let _ = tx.send(f);
        });
    rx.await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Save-as dialog (asks about overwriting itself). None when cancelled.
#[tauri::command]
pub async fn pick_save_file(app: AppHandle, default_name: String) -> Option<String> {
    let (tx, rx) = oneshot::channel();
    dialog(&app, "Download as")
        .set_file_name(crate::transfers::safe_segment(&default_name))
        .save_file(move |f| {
            let _ = tx.send(f);
        });
    rx.await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Transfers (progress arrives as `transfer` events)

#[tauri::command]
pub fn cancel_transfer(state: State<'_, AppState>, id: u64) {
    state.transfers.cancel(id);
}

#[tauri::command]
pub fn cancel_all_transfers(state: State<'_, AppState>) {
    state.transfers.cancel_all();
}

// ---------------------------------------------------------------------------
// Inspect

/// Parses YAML text (from a preview) into one JSON value per document, for the tree view.
#[tauri::command]
pub fn parse_yaml(text: String) -> Result<Vec<serde_json::Value>, AppError> {
    crate::yaml::parse(&text).map_err(|e| AppError::new(crate::error::ErrorKind::Other, e))
}
