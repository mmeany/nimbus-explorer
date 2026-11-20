//! Bookmark commands (see `crate::bookmarks`). Local files only, so every
//! command works in read-only mode.

use super::AppState;
use crate::bookmarks::{self, BookmarkFile};
use crate::error::{AppError, ErrorKind};
use crate::settings::Settings;
use std::path::PathBuf;
use tauri::State;

fn other(e: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Other, e.into())
}

#[tauri::command]
pub fn bookmarks_load(state: State<'_, AppState>) -> Result<BookmarkFile, AppError> {
    bookmarks::load(&state.settings.dir()).map_err(other)
}

/// Saves the whole set. `reason` is only for the activity history ("import").
#[tauri::command]
pub fn bookmarks_save(
    state: State<'_, AppState>,
    file: BookmarkFile,
    reason: Option<String>,
) -> Result<BookmarkFile, AppError> {
    let _ = reason;
    bookmarks::save(&state.settings.dir(), file).map_err(other)
}

#[tauri::command]
pub fn bookmarks_export(file: BookmarkFile, dest: String) -> Result<usize, AppError> {
    bookmarks::export(file, &PathBuf::from(dest)).map_err(other)
}

#[tauri::command]
pub fn bookmarks_read_import(path: String) -> Result<BookmarkFile, AppError> {
    bookmarks::read_import(&PathBuf::from(path)).map_err(other)
}

#[tauri::command]
pub fn set_bookmarks_bar(state: State<'_, AppState>, visible: bool) -> Result<Settings, AppError> {
    state
        .settings
        .update(|s| s.hide_bookmarks_bar = !visible)
        .map_err(other)
}
