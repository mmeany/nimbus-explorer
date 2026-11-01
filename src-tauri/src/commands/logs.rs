//! CloudWatch Logs commands (all read-only; downloads write local files).

use super::AppState;
use crate::error::AppError;
use crate::logs::{self, EventsRequest, GroupPage, LatestPage, LogGroup, StreamPage};
use tauri::State;

/// One page of log groups whose names begin with `prefix`.
#[tauri::command]
pub async fn logs_list_groups(
    state: State<'_, AppState>,
    prefix: String,
    token: Option<String>,
    page_size: usize,
) -> Result<GroupPage, AppError> {
    logs::list_groups(
        &*state.connection()?,
        &prefix,
        token,
        page_size.clamp(1, 1000),
    )
    .await
}

#[tauri::command]
pub async fn logs_describe_group(
    state: State<'_, AppState>,
    name: String,
) -> Result<LogGroup, AppError> {
    logs::describe_group(&*state.connection()?, &name).await
}

/// One page of a group's streams (newest activity first unless `prefix`).
#[tauri::command]
pub async fn logs_list_streams(
    state: State<'_, AppState>,
    group: String,
    prefix: String,
    token: Option<String>,
    page_size: usize,
) -> Result<StreamPage, AppError> {
    logs::list_streams(
        &*state.connection()?,
        &group,
        &prefix,
        token,
        page_size.clamp(1, 1000),
    )
    .await
}

/// The newest matching events in the range (oldest first), and where older ones end.
#[tauri::command]
pub async fn logs_latest(
    state: State<'_, AppState>,
    request: EventsRequest,
) -> Result<LatestPage, AppError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    logs::latest(&*state.connection()?, &request, now).await
}

/// Saves every matching event to `dest`; returns how many.
#[tauri::command]
pub async fn logs_download(
    state: State<'_, AppState>,
    request: EventsRequest,
    dest: String,
) -> Result<u64, AppError> {
    logs::download(&*state.connection()?, &request, &dest).await
}
