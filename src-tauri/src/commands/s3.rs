//! S3 commands: browsing, transfers, file operations, preview, sync.

use super::AppState;
use crate::error::AppError;
use crate::s3::{
    BucketInfo, DeleteResult, FolderList, ItemCount, ListPage, ListingResult, ObjectProperties,
    PreviewResult, ShareLink,
};
use crate::transfers::CopyPair;
use std::path::PathBuf;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn list_buckets(state: State<'_, AppState>) -> Result<Vec<BucketInfo>, AppError> {
    state.connection()?.list_buckets().await
}

/// One page of the folder view of `prefix` in `bucket`.
#[tauri::command]
pub async fn list_objects(
    state: State<'_, AppState>,
    bucket: String,
    prefix: String,
    token: Option<String>,
    page_size: Option<i32>,
    recursive: Option<bool>,
) -> Result<ListPage, AppError> {
    state
        .connection()?
        .list_page_with(
            &bucket,
            &prefix,
            token,
            page_size.unwrap_or(1000),
            recursive.unwrap_or(false),
        )
        .await
}

/// Which of `keys` already exist (for overwrite warnings).
#[tauri::command]
pub async fn existing_keys(
    state: State<'_, AppState>,
    bucket: String,
    keys: Vec<String>,
) -> Result<Vec<String>, AppError> {
    state.connection()?.existing_keys(&bucket, &keys).await
}

/// Sub-folders of `prefix`, for expanding a tree node.
#[tauri::command]
pub async fn list_folders(
    state: State<'_, AppState>,
    bucket: String,
    prefix: String,
) -> Result<FolderList, AppError> {
    state.connection()?.list_folders(&bucket, &prefix).await
}

/// Uploads local files/folders into `prefix`. Returns transfer ids.
#[tauri::command]
pub fn upload_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    bucket: String,
    prefix: String,
    paths: Vec<String>,
) -> Result<Vec<u64>, AppError> {
    state.ensure_writable()?;
    let conn = state.connection()?;
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    Ok(state
        .transfers
        .upload_paths(&app, &conn, &bucket, &prefix, &paths))
}

/// Downloads one object to an exact path chosen in a Save dialog.
#[tauri::command]
pub fn download_file(
    app: AppHandle,
    state: State<'_, AppState>,
    bucket: String,
    key: String,
    dest: String,
) -> Result<u64, AppError> {
    let conn = state.connection()?;
    Ok(state
        .transfers
        .download_to_file(&app, &conn, &bucket, &key, PathBuf::from(dest)))
}

/// Downloads objects and folder prefixes into a local folder.
#[tauri::command]
pub async fn download_to_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    bucket: String,
    items: Vec<String>,
    dest: String,
) -> Result<Vec<u64>, AppError> {
    let conn = state.connection()?;
    state
        .transfers
        .download_to_folder(&app, &conn, &bucket, &items, &PathBuf::from(dest))
        .await
}

/// Creates an empty folder (`prefix` must end in "/").
#[tauri::command]
pub async fn create_folder(
    state: State<'_, AppState>,
    bucket: String,
    prefix: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    state.connection()?.create_folder(&bucket, &prefix).await
}

/// Counts objects/bytes that deleting `items` would remove (folders recursively).
#[tauri::command]
pub async fn count_items(
    state: State<'_, AppState>,
    bucket: String,
    items: Vec<String>,
) -> Result<ItemCount, AppError> {
    state.connection()?.count_items(&bucket, &items).await
}

/// Deletes objects and folders (recursively).
#[tauri::command]
pub async fn delete_items(
    state: State<'_, AppState>,
    bucket: String,
    items: Vec<String>,
) -> Result<DeleteResult, AppError> {
    state.ensure_writable()?;
    state.connection()?.delete_items(&bucket, &items).await
}

/// Copies or moves objects server-side (progress via `transfer` events).
#[tauri::command]
pub fn copy_items(
    app: AppHandle,
    state: State<'_, AppState>,
    src_bucket: String,
    dst_bucket: String,
    pairs: Vec<CopyPair>,
    is_move: bool,
) -> Result<Vec<u64>, AppError> {
    state.ensure_writable()?;
    let conn = state.connection()?;
    Ok(state
        .transfers
        .copy_items(&app, &conn, &src_bucket, &dst_bucket, &pairs, is_move))
}

#[tauri::command]
pub async fn preview_object(
    state: State<'_, AppState>,
    bucket: String,
    key: String,
) -> Result<PreviewResult, AppError> {
    state.connection()?.preview(&bucket, &key).await
}

/// Presigned download link valid for `expires_secs` (max 7 days).
#[tauri::command]
pub async fn share_link(
    state: State<'_, AppState>,
    bucket: String,
    key: String,
    expires_secs: u64,
) -> Result<ShareLink, AppError> {
    state
        .connection()?
        .share_link(&bucket, &key, expires_secs)
        .await
}

#[tauri::command]
pub async fn object_properties(
    state: State<'_, AppState>,
    bucket: String,
    key: String,
) -> Result<ObjectProperties, AppError> {
    state.connection()?.properties(&bucket, &key).await
}

/// Compares a local folder with an S3 folder and stores the plan. Changes
/// nothing: this is the dry run. Returns totals plus the first 100 actions.
#[tauri::command]
pub async fn plan_sync(
    state: State<'_, AppState>,
    request: crate::sync::SyncRequest,
) -> Result<crate::sync::SyncSummary, AppError> {
    let conn = state.connection()?;
    let plan = crate::sync::plan(&conn, request).await?;
    let summary_plan = plan.clone();
    let id = state.sync_plans.put(plan);
    Ok(summary_plan.summary(id))
}

/// Executes exactly the plan that was previewed (each plan runs once).
#[tauri::command]
pub async fn run_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    plan_id: u64,
) -> Result<crate::sync::SyncRunResult, AppError> {
    let conn = state.connection()?;
    let plan = state.sync_plans.take(plan_id).ok_or_else(|| {
        AppError::new(
            crate::error::ErrorKind::Other,
            "This sync preview is out of date. Run the dry run again.",
        )
    })?;
    // Upload syncs change S3; download syncs only change local files.
    if plan.request.direction == crate::sync::SyncDirection::Upload {
        state.ensure_writable()?;
    }
    crate::sync::run(&app, &conn, &state.transfers, plan).await
}

/// Saves a recursive listing of `prefix` to a text file (aws s3 ls format).
#[tauri::command]
pub async fn export_listing(
    state: State<'_, AppState>,
    bucket: String,
    prefix: String,
    dest: String,
) -> Result<ListingResult, AppError> {
    state
        .connection()?
        .write_listing(&bucket, &prefix, &PathBuf::from(dest))
        .await
}
