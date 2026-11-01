//! SQS commands.

use super::AppState;
use crate::error::AppError;
use crate::sqs::{self, MoveTask, QueueInfo};
use crate::sqs_messages::{
    self as msgs, BatchReport, FilePreview, HandleReport, InMessage, OutMessage, ReceiveOptions,
    SendResult,
};
use std::collections::BTreeMap;
use tauri::State;

/// Every queue whose name begins with `prefix` ("" = all), names only.
#[tauri::command]
pub async fn sqs_list_refs(
    state: State<'_, AppState>,
    prefix: String,
) -> Result<Vec<sqs::QueueRef>, AppError> {
    sqs::list_refs(&*state.connection()?, &prefix).await
}

/// Details for the queues on the visible page.
#[tauri::command]
pub async fn sqs_details_many(
    state: State<'_, AppState>,
    urls: Vec<String>,
) -> Result<Vec<QueueInfo>, AppError> {
    sqs::details_many(&*state.connection()?, &urls).await
}

#[tauri::command]
pub async fn sqs_queue_details(
    state: State<'_, AppState>,
    url: String,
) -> Result<QueueInfo, AppError> {
    sqs::queue_details(&*state.connection()?, &url).await
}

#[tauri::command]
pub async fn sqs_queue_url(state: State<'_, AppState>, name: String) -> Result<String, AppError> {
    sqs::queue_url(&*state.connection()?, &name).await
}

/// Queues that use this one as their dead-letter queue.
#[tauri::command]
pub async fn sqs_dlq_sources(
    state: State<'_, AppState>,
    url: String,
) -> Result<Vec<String>, AppError> {
    sqs::dlq_sources(&*state.connection()?, &url).await
}

#[tauri::command]
pub async fn sqs_list_tags(
    state: State<'_, AppState>,
    url: String,
) -> Result<BTreeMap<String, String>, AppError> {
    sqs::list_tags(&*state.connection()?, &url).await
}

#[tauri::command]
pub async fn sqs_create_queue(
    state: State<'_, AppState>,
    name: String,
    attributes: BTreeMap<String, String>,
    tags: BTreeMap<String, String>,
) -> Result<String, AppError> {
    state.ensure_writable()?;
    sqs::create_queue(&*state.connection()?, &name, &attributes, &tags).await
}

#[tauri::command]
pub async fn sqs_set_attributes(
    state: State<'_, AppState>,
    url: String,
    attributes: BTreeMap<String, String>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    sqs::set_attributes(&*state.connection()?, &url, &attributes).await
}

#[tauri::command]
pub async fn sqs_set_tags(
    state: State<'_, AppState>,
    url: String,
    tags: BTreeMap<String, String>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    sqs::set_tags(&*state.connection()?, &url, &tags).await
}

#[tauri::command]
pub async fn sqs_delete_queue(state: State<'_, AppState>, url: String) -> Result<(), AppError> {
    state.ensure_writable()?;
    sqs::delete_queue(&*state.connection()?, &url).await
}

#[tauri::command]
pub async fn sqs_purge(state: State<'_, AppState>, url: String) -> Result<(), AppError> {
    state.ensure_writable()?;
    sqs::purge(&*state.connection()?, &url).await
}

#[tauri::command]
pub async fn sqs_send(
    state: State<'_, AppState>,
    url: String,
    message: OutMessage,
) -> Result<SendResult, AppError> {
    state.ensure_writable()?;
    msgs::send(&*state.connection()?, &url, &message).await
}

#[tauri::command]
pub async fn sqs_send_batch(
    state: State<'_, AppState>,
    url: String,
    messages: Vec<OutMessage>,
) -> Result<BatchReport, AppError> {
    state.ensure_writable()?;
    msgs::send_batch(&*state.connection()?, &url, &messages).await
}

/// Counts and samples the messages in a JSON array / JSON-lines file.
#[tauri::command]
pub async fn sqs_preview_file(path: String, envelope: bool) -> Result<FilePreview, AppError> {
    msgs::preview_file(&path, envelope).await
}

#[tauri::command]
pub async fn sqs_send_file(
    state: State<'_, AppState>,
    url: String,
    path: String,
    envelope: bool,
    group_id: Option<String>,
) -> Result<BatchReport, AppError> {
    state.ensure_writable()?;
    msgs::send_file(&*state.connection()?, &url, &path, envelope, group_id).await
}

/// Peek (visibility 0) or receive-and-hold messages. Not a write: allowed in
/// read-only mode (it does count as a receive).
#[tauri::command]
pub async fn sqs_receive(
    state: State<'_, AppState>,
    url: String,
    options: ReceiveOptions,
) -> Result<Vec<InMessage>, AppError> {
    msgs::receive(&*state.connection()?, &url, &options).await
}

#[tauri::command]
pub async fn sqs_delete_messages(
    state: State<'_, AppState>,
    url: String,
    receipt_handles: Vec<String>,
) -> Result<HandleReport, AppError> {
    state.ensure_writable()?;
    msgs::delete_messages(&*state.connection()?, &url, &receipt_handles).await
}

/// Changes visibility of received messages; 0 releases them. Allowed in
/// read-only mode so held messages can always be given back.
#[tauri::command]
pub async fn sqs_change_visibility(
    state: State<'_, AppState>,
    url: String,
    receipt_handles: Vec<String>,
    seconds: i32,
) -> Result<HandleReport, AppError> {
    msgs::change_visibility(&*state.connection()?, &url, &receipt_handles, seconds).await
}

#[tauri::command]
pub async fn sqs_export_messages(
    path: String,
    messages: Vec<InMessage>,
) -> Result<usize, AppError> {
    msgs::export_messages(&path, &messages).await
}

/// Moves messages out of a dead-letter queue (to their sources, or to
/// `destination_arn`). Returns the task handle.
#[tauri::command]
pub async fn sqs_start_redrive(
    state: State<'_, AppState>,
    dlq_arn: String,
    destination_arn: Option<String>,
    max_per_second: Option<i32>,
) -> Result<String, AppError> {
    state.ensure_writable()?;
    sqs::start_redrive(
        &*state.connection()?,
        &dlq_arn,
        destination_arn,
        max_per_second,
    )
    .await
}

#[tauri::command]
pub async fn sqs_list_redrives(
    state: State<'_, AppState>,
    dlq_arn: String,
) -> Result<Vec<MoveTask>, AppError> {
    sqs::list_redrives(&*state.connection()?, &dlq_arn).await
}

/// Cancelling stops a write in progress, so it's allowed in read-only mode.
#[tauri::command]
pub async fn sqs_cancel_redrive(
    state: State<'_, AppState>,
    task_handle: String,
) -> Result<i64, AppError> {
    sqs::cancel_redrive(&*state.connection()?, &task_handle).await
}

/// Moves messages by receive → send → delete (fallback when message move
/// tasks aren't available, or between any two queues).
#[tauri::command]
pub async fn sqs_move_messages(
    state: State<'_, AppState>,
    from_url: String,
    to_url: String,
    to_fifo: bool,
    max: usize,
) -> Result<BatchReport, AppError> {
    state.ensure_writable()?;
    msgs::move_messages(&*state.connection()?, &from_url, &to_url, to_fifo, max).await
}
