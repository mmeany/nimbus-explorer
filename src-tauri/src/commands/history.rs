//! Activity history commands (see `crate::history`). History is a local file,
//! so every command here works in read-only mode.

use super::AppState;
use crate::error::{AppError, ErrorKind};
use crate::history::{self, Cursor, ExportFormat, HistorySettings, NewEntry, Page, Query};
use crate::settings::Settings;
use std::path::PathBuf;
use tauri::State;

fn other(e: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Other, e.into())
}

fn root(state: &AppState) -> PathBuf {
    state.settings.dir().join("history")
}

/// Records one action for the connected profile. Best-effort: without a
/// connection, or with history switched off, nothing is written.
#[tauri::command]
pub fn history_record(state: State<'_, AppState>, entry: NewEntry) -> Result<(), AppError> {
    let settings = state.settings.load().history;
    if !settings.enabled {
        return Ok(());
    }
    let Ok(conn) = state.connection() else {
        return Ok(());
    };
    let region = if entry.service == "s3" || entry.service == "iam" || entry.service == "app" {
        String::new()
    } else {
        conn.service_region()
    };
    let ms = history::now_ms();
    let entry = entry.into_entry(ms, &conn.info.profile, &region);
    history::append(&root(&state), &settings, &entry, ms).map_err(other)
}

#[tauri::command]
pub fn history_page(
    state: State<'_, AppState>,
    query: Query,
    cursor: Option<Cursor>,
    limit: usize,
) -> Page {
    history::page(&root(&state), &query, cursor.as_ref(), limit)
}

/// Profiles that have recorded history.
#[tauri::command]
pub fn history_profiles(state: State<'_, AppState>) -> Vec<String> {
    history::profiles(&root(&state))
}

#[tauri::command]
pub fn history_export(
    state: State<'_, AppState>,
    query: Query,
    format: ExportFormat,
    dest: String,
) -> Result<usize, AppError> {
    history::export(&root(&state), &query, format, &PathBuf::from(dest)).map_err(other)
}

#[tauri::command]
pub fn history_clear(state: State<'_, AppState>, profile: String) -> Result<(), AppError> {
    history::clear(&root(&state), &profile).map_err(other)
}

/// Opens the profile's history folder (or the history root) in the file manager.
#[tauri::command]
pub fn history_open_folder(state: State<'_, AppState>, profile: Option<String>) -> Result<(), AppError> {
    let root = root(&state);
    let mut dir = match profile {
        Some(p) => history::profile_dir(&root, &p),
        None => root.clone(),
    };
    if !dir.exists() {
        dir = root;
    }
    std::fs::create_dir_all(&dir).map_err(|e| other(e.to_string()))?;
    #[cfg(windows)]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| other(format!("Couldn't open {}: {e}", dir.display())))
}

/// Saves the history settings and applies the file limit straight away.
#[tauri::command]
pub fn set_history_settings(
    state: State<'_, AppState>,
    value: HistorySettings,
) -> Result<Settings, AppError> {
    if value.max_file_mb > 1024 || value.keep_files > 10_000 {
        return Err(other("File size is at most 1,024 MB and files kept at most 10,000"));
    }
    let keep = value.keep_files;
    let s = state.settings.update(|s| s.history = value).map_err(other)?;
    history::prune_all(&root(&state), keep);
    Ok(s)
}
