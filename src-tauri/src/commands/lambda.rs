//! Lambda commands.

use super::AppState;
use crate::error::AppError;
use crate::lambda::{self, FunctionDetails, FunctionSummary, Triggers, Versions};
use crate::lambda_admin::{self as admin, AliasRequest, ConfigChange};
use crate::lambda_code::{self as code, UploadRequest, UploadResult};
use crate::lambda_invoke::{self as inv, InvokeRequest, InvokeResult, TestEvent};
use std::collections::BTreeMap;
use tauri::State;

/// Every function in the region.
#[tauri::command]
pub async fn lambda_list(state: State<'_, AppState>) -> Result<Vec<FunctionSummary>, AppError> {
    lambda::list(&*state.connection()?).await
}

#[tauri::command]
pub async fn lambda_get(
    state: State<'_, AppState>,
    name: String,
) -> Result<FunctionDetails, AppError> {
    lambda::get(&*state.connection()?, &name).await
}

/// Environment variable values, on Reveal only (never cached).
#[tauri::command]
pub async fn lambda_env_values(
    state: State<'_, AppState>,
    name: String,
) -> Result<BTreeMap<String, String>, AppError> {
    lambda::env_values(&*state.connection()?, &name).await
}

#[tauri::command]
pub async fn lambda_triggers(
    state: State<'_, AppState>,
    name: String,
) -> Result<Triggers, AppError> {
    lambda::triggers(&*state.connection()?, &name).await
}

#[tauri::command]
pub async fn lambda_versions(
    state: State<'_, AppState>,
    name: String,
) -> Result<Versions, AppError> {
    lambda::versions(&*state.connection()?, &name).await
}

/// Runs the function (a write: it can change things, so read-only mode refuses it).
#[tauri::command]
pub async fn lambda_invoke(
    state: State<'_, AppState>,
    request: InvokeRequest,
) -> Result<InvokeResult, AppError> {
    state.ensure_writable()?;
    inv::invoke(&*state.connection()?, &request).await
}

/// Saved test events for `key` ("profile|region|function").
#[tauri::command]
pub fn lambda_test_events(state: State<'_, AppState>, key: String) -> Vec<TestEvent> {
    inv::list_events(&state.settings.dir(), &key)
}

#[tauri::command]
pub fn lambda_save_test_event(
    state: State<'_, AppState>,
    key: String,
    name: String,
    payload: String,
) -> Result<Vec<TestEvent>, AppError> {
    inv::save_event(&state.settings.dir(), &key, &name, &payload)
}

#[tauri::command]
pub fn lambda_delete_test_event(
    state: State<'_, AppState>,
    key: String,
    name: String,
) -> Result<Vec<TestEvent>, AppError> {
    inv::delete_event(&state.settings.dir(), &key, &name)
}

#[tauri::command]
pub async fn lambda_update_config(
    state: State<'_, AppState>,
    name: String,
    change: ConfigChange,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    admin::update_config(&*state.connection()?, &name, &change).await
}

/// Some(n) reserves n; None removes the reservation.
#[tauri::command]
pub async fn lambda_set_concurrency(
    state: State<'_, AppState>,
    name: String,
    reserved: Option<i32>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    admin::set_reserved_concurrency(&*state.connection()?, &name, reserved).await
}

#[tauri::command]
pub async fn lambda_set_mapping_enabled(
    state: State<'_, AppState>,
    uuid: String,
    enabled: bool,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    admin::set_mapping_enabled(&*state.connection()?, &uuid, enabled).await
}

#[tauri::command]
pub async fn lambda_publish_version(
    state: State<'_, AppState>,
    name: String,
    description: String,
) -> Result<String, AppError> {
    state.ensure_writable()?;
    admin::publish_version(&*state.connection()?, &name, &description).await
}

/// Creates the alias, or updates it when `update`.
#[tauri::command]
pub async fn lambda_save_alias(
    state: State<'_, AppState>,
    name: String,
    alias: AliasRequest,
    update: bool,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    let conn = state.connection()?;
    if update {
        admin::update_alias(&conn, &name, &alias).await
    } else {
        admin::create_alias(&conn, &name, &alias).await
    }
}

#[tauri::command]
pub async fn lambda_delete_alias(
    state: State<'_, AppState>,
    name: String,
    alias: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    admin::delete_alias(&*state.connection()?, &name, &alias).await
}

#[tauri::command]
pub async fn lambda_delete_version(
    state: State<'_, AppState>,
    name: String,
    version: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    admin::delete_version(&*state.connection()?, &name, &version).await
}

#[tauri::command]
pub async fn lambda_delete_function(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    admin::delete_function(&*state.connection()?, &name).await
}

/// Saves the deployment package (a local write; allowed in read-only mode).
#[tauri::command]
pub async fn lambda_download_code(
    state: State<'_, AppState>,
    name: String,
    qualifier: Option<String>,
    dest: String,
) -> Result<u64, AppError> {
    code::download(&*state.connection()?, &name, qualifier.as_deref(), &dest).await
}

#[tauri::command]
pub async fn lambda_upload_code(
    state: State<'_, AppState>,
    request: UploadRequest,
) -> Result<UploadResult, AppError> {
    state.ensure_writable()?;
    code::upload(&*state.connection()?, &request).await
}
