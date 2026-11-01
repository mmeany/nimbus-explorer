//! RDS commands.

use super::AppState;
use crate::error::AppError;
use crate::rds::{
    self, DbCluster, DbInstance, DeleteRequest, ModifyRequest, PendingAction, RdsListing,
};
use crate::rds_data::{self as data, SqlColumn, SqlRequest, SqlResult};
use crate::rds_logs::{self as logs, LogFile, LogTail, RdsEvent};
use crate::rds_snapshots::{self as snapshots, RestoreRequest, SnapshotInfo};
use tauri::State;

#[tauri::command]
pub async fn rds_list(state: State<'_, AppState>) -> Result<RdsListing, AppError> {
    rds::list_all(&*state.connection()?).await
}

#[tauri::command]
pub async fn rds_describe_instance(
    state: State<'_, AppState>,
    id: String,
) -> Result<DbInstance, AppError> {
    rds::describe_instance(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn rds_describe_cluster(
    state: State<'_, AppState>,
    id: String,
) -> Result<DbCluster, AppError> {
    rds::describe_cluster(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn rds_pending_maintenance(
    state: State<'_, AppState>,
    arn: String,
) -> Result<Vec<PendingAction>, AppError> {
    rds::pending_maintenance(&*state.connection()?, &arn).await
}

#[tauri::command]
pub async fn rds_list_tags(
    state: State<'_, AppState>,
    arn: String,
) -> Result<Vec<(String, String)>, AppError> {
    rds::list_tags(&*state.connection()?, &arn).await
}

#[tauri::command]
pub async fn rds_start(
    state: State<'_, AppState>,
    kind: String,
    id: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    rds::start(&*state.connection()?, &kind, &id).await
}

#[tauri::command]
pub async fn rds_stop(
    state: State<'_, AppState>,
    kind: String,
    id: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    rds::stop(&*state.connection()?, &kind, &id).await
}

#[tauri::command]
pub async fn rds_reboot(
    state: State<'_, AppState>,
    kind: String,
    id: String,
    force_failover: bool,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    rds::reboot(&*state.connection()?, &kind, &id, force_failover).await
}

#[tauri::command]
pub async fn rds_failover(
    state: State<'_, AppState>,
    cluster_id: String,
    target: Option<String>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    rds::failover(&*state.connection()?, &cluster_id, target.as_deref()).await
}

#[tauri::command]
pub async fn rds_modify(
    state: State<'_, AppState>,
    kind: String,
    id: String,
    request: ModifyRequest,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    rds::modify(&*state.connection()?, &kind, &id, &request).await
}

#[tauri::command]
pub async fn rds_delete(
    state: State<'_, AppState>,
    kind: String,
    id: String,
    request: DeleteRequest,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    rds::delete(&*state.connection()?, &kind, &id, &request).await
}

/// Snapshots of one database (kind + id), or of every database when id is null.
#[tauri::command]
pub async fn rds_list_snapshots(
    state: State<'_, AppState>,
    kind: Option<String>,
    id: Option<String>,
) -> Result<Vec<SnapshotInfo>, AppError> {
    snapshots::list(&*state.connection()?, kind.as_deref(), id.as_deref()).await
}

#[tauri::command]
pub async fn rds_create_snapshot(
    state: State<'_, AppState>,
    kind: String,
    id: String,
    snapshot_id: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    snapshots::create(&*state.connection()?, &kind, &id, &snapshot_id).await
}

#[tauri::command]
pub async fn rds_copy_snapshot(
    state: State<'_, AppState>,
    kind: String,
    source: String,
    target: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    snapshots::copy(&*state.connection()?, &kind, &source, &target).await
}

#[tauri::command]
pub async fn rds_delete_snapshot(
    state: State<'_, AppState>,
    kind: String,
    snapshot_id: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    snapshots::delete(&*state.connection()?, &kind, &snapshot_id).await
}

#[tauri::command]
pub async fn rds_restore(
    state: State<'_, AppState>,
    kind: String,
    request: RestoreRequest,
) -> Result<String, AppError> {
    state.ensure_writable()?;
    snapshots::restore(&*state.connection()?, &kind, &request).await
}

/// Events of a database (and, for a cluster, its `members`) over the last `minutes`.
#[tauri::command]
pub async fn rds_events(
    state: State<'_, AppState>,
    kind: String,
    id: String,
    members: Vec<String>,
    minutes: i32,
) -> Result<Vec<RdsEvent>, AppError> {
    logs::events(&*state.connection()?, &kind, &id, &members, minutes).await
}

#[tauri::command]
pub async fn rds_log_files(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<LogFile>, AppError> {
    logs::log_files(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn rds_log_tail(
    state: State<'_, AppState>,
    id: String,
    file: String,
    lines: i32,
) -> Result<LogTail, AppError> {
    logs::tail(&*state.connection()?, &id, &file, lines).await
}

/// Saves a whole log file (a local write only, so allowed in read-only mode).
#[tauri::command]
pub async fn rds_log_download(
    state: State<'_, AppState>,
    id: String,
    file: String,
    dest: String,
) -> Result<u64, AppError> {
    logs::download(&*state.connection()?, &id, &file, &dest).await
}

/// Runs one SQL statement on an Aurora cluster through the Data API. Runs that
/// aren't read-only need read-write mode.
#[tauri::command]
pub async fn rds_execute_sql(
    state: State<'_, AppState>,
    request: SqlRequest,
) -> Result<SqlResult, AppError> {
    if !request.read_only {
        state.ensure_writable()?;
    }
    data::execute(&*state.connection()?, &request).await
}

/// Saves query results as CSV or JSON (a local write, allowed in read-only mode).
#[tauri::command]
pub async fn rds_save_result(
    dest: String,
    columns: Vec<SqlColumn>,
    rows: Vec<Vec<serde_json::Value>>,
    format: String,
) -> Result<(), AppError> {
    data::save_result(&dest, &columns, &rows, &format).await
}
