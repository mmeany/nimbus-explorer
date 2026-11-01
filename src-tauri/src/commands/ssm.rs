//! Parameter Store commands.

use super::AppState;
use crate::error::AppError;
use crate::ssm::{
    self, CopyPair, CopyResult, ParamDeleteResult, ParamInfo, ParamListing, ParamVersion, PutParam,
    Tag,
};
use crate::ssm_io;
use tauri::State;

/// Folder view of a path ("/" for the root). `with_values: false` skips loading
/// values (used when expanding tree nodes).
#[tauri::command]
pub async fn ssm_list_path(
    state: State<'_, AppState>,
    path: String,
    with_values: Option<bool>,
) -> Result<ParamListing, AppError> {
    ssm::list_path(&*state.connection()?, &path, with_values.unwrap_or(true)).await
}

/// Values of the parameters on the visible page (never SecureString).
#[tauri::command]
pub async fn ssm_values(
    state: State<'_, AppState>,
    names: Vec<String>,
) -> Result<std::collections::BTreeMap<String, String>, AppError> {
    ssm::values(&*state.connection()?, &names).await
}

/// Flat, recursive view of parameters whose names begin with `prefix`.
#[tauri::command]
pub async fn ssm_list_prefix(
    state: State<'_, AppState>,
    prefix: String,
) -> Result<ParamListing, AppError> {
    ssm::list_prefix(&*state.connection()?, &prefix).await
}

/// Current metadata for one parameter (None if it doesn't exist).
#[tauri::command]
pub async fn ssm_describe(
    state: State<'_, AppState>,
    name: String,
) -> Result<Option<ParamInfo>, AppError> {
    ssm::describe_one(&*state.connection()?, &name).await
}

/// One parameter's value; `decrypt` is set only on an explicit user action.
#[tauri::command]
pub async fn ssm_get_value(
    state: State<'_, AppState>,
    name: String,
    decrypt: bool,
) -> Result<String, AppError> {
    ssm::get_value(&*state.connection()?, &name, decrypt).await
}

/// Creates or overwrites a parameter; returns the new version.
#[tauri::command]
pub async fn ssm_put(state: State<'_, AppState>, param: PutParam) -> Result<i64, AppError> {
    state.ensure_writable()?;
    ssm::put(&*state.connection()?, &param).await
}

#[tauri::command]
pub async fn ssm_delete(
    state: State<'_, AppState>,
    names: Vec<String>,
) -> Result<ParamDeleteResult, AppError> {
    state.ensure_writable()?;
    ssm::delete(&*state.connection()?, &names).await
}

#[tauri::command]
pub async fn ssm_history(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<ParamVersion>, AppError> {
    ssm::history(&*state.connection()?, &name).await
}

#[tauri::command]
pub async fn ssm_label(
    state: State<'_, AppState>,
    name: String,
    version: i64,
    labels: Vec<String>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    ssm::label_version(&*state.connection()?, &name, version, &labels).await
}

#[tauri::command]
pub async fn ssm_unlabel(
    state: State<'_, AppState>,
    name: String,
    version: i64,
    labels: Vec<String>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    ssm::unlabel_version(&*state.connection()?, &name, version, &labels).await
}

/// Saves an old version's value as a new version; returns the new version.
#[tauri::command]
pub async fn ssm_restore(
    state: State<'_, AppState>,
    name: String,
    version: i64,
) -> Result<i64, AppError> {
    state.ensure_writable()?;
    ssm::restore_version(&*state.connection()?, &name, version).await
}

#[tauri::command]
pub async fn ssm_list_tags(state: State<'_, AppState>, name: String) -> Result<Vec<Tag>, AppError> {
    ssm::list_tags(&*state.connection()?, &name).await
}

/// Replaces the parameter's tags with `tags`.
#[tauri::command]
pub async fn ssm_set_tags(
    state: State<'_, AppState>,
    name: String,
    tags: Vec<Tag>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    ssm::set_tags(&*state.connection()?, &name, &tags).await
}

/// Changes tier and/or policies (creates a new version); returns it.
#[tauri::command]
pub async fn ssm_update_tier_policies(
    state: State<'_, AppState>,
    name: String,
    tier: Option<String>,
    policies: Option<String>,
) -> Result<i64, AppError> {
    state.ensure_writable()?;
    ssm::update_tier_policies(&*state.connection()?, &name, tier, policies).await
}

/// What copying `items` into `dest_folder` (or renaming one item to
/// `rename_to`) would do, with collisions marked.
#[tauri::command]
pub async fn ssm_plan_copy(
    state: State<'_, AppState>,
    items: Vec<String>,
    dest_folder: String,
    rename_to: Option<String>,
) -> Result<Vec<CopyPair>, AppError> {
    ssm::plan_copy(
        &*state.connection()?,
        &items,
        &dest_folder,
        rename_to.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn ssm_copy(
    state: State<'_, AppState>,
    pairs: Vec<CopyPair>,
    overwrite: bool,
    remove_source: bool,
) -> Result<CopyResult, AppError> {
    state.ensure_writable()?;
    ssm::copy_params(&*state.connection()?, &pairs, overwrite, remove_source).await
}

/// Writes every parameter under `folder` to `dest` (JSON or .env). Decrypted
/// SecureString values only with `include_secrets` (asked each time in the UI).
#[tauri::command]
pub async fn ssm_export(
    state: State<'_, AppState>,
    folder: String,
    format: ssm_io::ExportFormat,
    include_secrets: bool,
    dest: String,
) -> Result<ssm_io::ExportResult, AppError> {
    ssm_io::export(
        &*state.connection()?,
        &folder,
        format,
        include_secrets,
        &dest,
    )
    .await
}

/// Reads an import file and compares it with the current parameters.
#[tauri::command]
pub async fn ssm_plan_import(
    state: State<'_, AppState>,
    options: ssm_io::ImportOptions,
) -> Result<ssm_io::ImportPreview, AppError> {
    ssm_io::plan_import(&*state.connection()?, &state.ssm_imports, &options).await
}

/// Runs the previewed import (once).
#[tauri::command]
pub async fn ssm_run_import(
    state: State<'_, AppState>,
    plan_id: u64,
    include_overwrites: bool,
) -> Result<ssm_io::ImportResult, AppError> {
    state.ensure_writable()?;
    ssm_io::run_import(
        &*state.connection()?,
        &state.ssm_imports,
        plan_id,
        include_overwrites,
    )
    .await
}
