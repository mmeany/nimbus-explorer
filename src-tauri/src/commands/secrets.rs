//! Secrets Manager commands.

use super::AppState;
use crate::error::AppError;
use crate::secrets::{self, NewValue, PolicyCheck, SecretInfo, SecretValue, VersionInfo};
use tauri::State;

/// Secrets whose names begin with `prefix` ("" = all), including scheduled deletions.
#[tauri::command]
pub async fn sm_list(
    state: State<'_, AppState>,
    prefix: String,
) -> Result<Vec<SecretInfo>, AppError> {
    secrets::list_secrets(&*state.connection()?, &prefix).await
}

#[tauri::command]
pub async fn sm_describe(state: State<'_, AppState>, id: String) -> Result<SecretInfo, AppError> {
    secrets::describe(&*state.connection()?, &id).await
}

/// Decrypts on an explicit user action only; the value isn't kept here.
#[tauri::command]
pub async fn sm_get_value(
    state: State<'_, AppState>,
    id: String,
    version_id: Option<String>,
    stage: Option<String>,
) -> Result<SecretValue, AppError> {
    secrets::get_value(&*state.connection()?, &id, version_id, stage).await
}

#[tauri::command]
pub async fn sm_create(
    state: State<'_, AppState>,
    name: String,
    value: NewValue,
    description: Option<String>,
    kms_key_id: Option<String>,
    tags: Vec<(String, String)>,
) -> Result<String, AppError> {
    state.ensure_writable()?;
    secrets::create(
        &*state.connection()?,
        &name,
        &value,
        description,
        kms_key_id,
        &tags,
    )
    .await
}

/// New value → new version labelled AWSCURRENT; returns the version id.
#[tauri::command]
pub async fn sm_put_value(
    state: State<'_, AppState>,
    id: String,
    value: NewValue,
) -> Result<String, AppError> {
    state.ensure_writable()?;
    secrets::put_value(&*state.connection()?, &id, &value).await
}

#[tauri::command]
pub async fn sm_update_metadata(
    state: State<'_, AppState>,
    id: String,
    description: Option<String>,
    kms_key_id: Option<String>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    secrets::update_metadata(&*state.connection()?, &id, description, kms_key_id).await
}

/// Schedules deletion (7–30 days) or, with `force`, deletes immediately.
#[tauri::command]
pub async fn sm_delete(
    state: State<'_, AppState>,
    id: String,
    recovery_days: Option<i64>,
    force: bool,
) -> Result<Option<String>, AppError> {
    state.ensure_writable()?;
    secrets::delete(&*state.connection()?, &id, recovery_days, force).await
}

#[tauri::command]
pub async fn sm_restore(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.ensure_writable()?;
    secrets::restore(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn sm_list_versions(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<VersionInfo>, AppError> {
    secrets::list_versions(&*state.connection()?, &id).await
}

/// Moves / attaches / removes a staging label (e.g. AWSCURRENT to roll back).
#[tauri::command]
pub async fn sm_move_label(
    state: State<'_, AppState>,
    id: String,
    stage: String,
    to: Option<String>,
    from: Option<String>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    secrets::move_label(&*state.connection()?, &id, &stage, to, from).await
}

#[tauri::command]
pub async fn sm_configure_rotation(
    state: State<'_, AppState>,
    id: String,
    lambda_arn: Option<String>,
    schedule: String,
    window: Option<String>,
    rotate_now: bool,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    secrets::configure_rotation(
        &*state.connection()?,
        &id,
        lambda_arn,
        &schedule,
        window,
        rotate_now,
    )
    .await
}

#[tauri::command]
pub async fn sm_rotate_now(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.ensure_writable()?;
    secrets::rotate_now(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn sm_cancel_rotation(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.ensure_writable()?;
    secrets::cancel_rotation(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn sm_set_tags(
    state: State<'_, AppState>,
    id: String,
    tags: Vec<(String, String)>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    secrets::set_tags(&*state.connection()?, &id, &tags).await
}

#[tauri::command]
pub async fn sm_get_policy(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>, AppError> {
    secrets::get_policy(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn sm_validate_policy(
    state: State<'_, AppState>,
    id: String,
    policy: String,
) -> Result<PolicyCheck, AppError> {
    secrets::validate_policy(&*state.connection()?, &id, &policy).await
}

#[tauri::command]
pub async fn sm_put_policy(
    state: State<'_, AppState>,
    id: String,
    policy: String,
    block_public: bool,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    secrets::put_policy(&*state.connection()?, &id, &policy, block_public).await
}

#[tauri::command]
pub async fn sm_delete_policy(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.ensure_writable()?;
    secrets::delete_policy(&*state.connection()?, &id).await
}
