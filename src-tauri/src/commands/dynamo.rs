//! DynamoDB commands.

use super::AppState;
use crate::ddb_io::{self, ExportFormat, ImportPreview, ImportResult, Progress};
use crate::ddb_items::{self, JsonItem, ReadPage, ReadRequest, StatementPage, WriteReport};
use crate::ddb_tables::{self, BackupInfo, CreateTableSpec, IndexSpec, SettingsPatch};
use crate::dynamo::{self, TableInfo};
use crate::error::AppError;
use tauri::State;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn ddb_list_table_names(state: State<'_, AppState>) -> Result<Vec<String>, AppError> {
    dynamo::list_table_names(&*state.connection()?).await
}

/// Descriptions of the tables on the visible page.
#[tauri::command]
pub async fn ddb_details_many(
    state: State<'_, AppState>,
    names: Vec<String>,
) -> Result<Vec<TableInfo>, AppError> {
    dynamo::details_many(&*state.connection()?, &names).await
}

#[tauri::command]
pub async fn ddb_describe_table(
    state: State<'_, AppState>,
    name: String,
) -> Result<TableInfo, AppError> {
    dynamo::describe_table(&*state.connection()?, &name).await
}

#[tauri::command]
pub async fn ddb_list_tags(
    state: State<'_, AppState>,
    arn: String,
) -> Result<Vec<(String, String)>, AppError> {
    dynamo::list_tags(&*state.connection()?, &arn).await
}

/// One page of a Scan or Query (reads are allowed in read-only mode).
#[tauri::command]
pub async fn ddb_read_page(
    state: State<'_, AppState>,
    request: ReadRequest,
) -> Result<ReadPage, AppError> {
    ddb_items::read_page(&*state.connection()?, &request).await
}

/// Counts every matching item (all pages, no items returned).
#[tauri::command]
pub async fn ddb_count(state: State<'_, AppState>, request: ReadRequest) -> Result<i64, AppError> {
    ddb_items::count_all(&*state.connection()?, &request).await
}

#[tauri::command]
pub async fn ddb_get_item(
    state: State<'_, AppState>,
    table: String,
    key: JsonItem,
) -> Result<Option<JsonItem>, AppError> {
    ddb_items::get_item(&*state.connection()?, &table, &key, true).await
}

/// `mustExist`: false = create only, true = replace only, null = either.
#[tauri::command]
pub async fn ddb_put_item(
    state: State<'_, AppState>,
    table: String,
    key_attrs: Vec<String>,
    item: JsonItem,
    must_exist: Option<bool>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    ddb_items::put_item(&*state.connection()?, &table, &key_attrs, &item, must_exist).await
}

#[tauri::command]
pub async fn ddb_delete_items(
    state: State<'_, AppState>,
    table: String,
    keys: Vec<JsonItem>,
) -> Result<WriteReport, AppError> {
    state.ensure_writable()?;
    ddb_items::delete_items(&*state.connection()?, &table, &keys).await
}

/// Runs a PartiQL statement page. In read-only mode only SELECT is allowed.
#[tauri::command]
pub async fn ddb_execute(
    state: State<'_, AppState>,
    statement: String,
    parameters: Vec<serde_json::Value>,
    next_token: Option<String>,
    limit: Option<i32>,
) -> Result<StatementPage, AppError> {
    if !ddb_items::is_read_only_statement(&statement) {
        state.ensure_writable()?;
    }
    ddb_items::execute_statement(
        &*state.connection()?,
        &statement,
        &parameters,
        next_token,
        limit,
    )
    .await
}

fn emitter(app: AppHandle) -> impl Fn(Progress) + Send + Sync {
    move |p| {
        let _ = app.emit("ddb-progress", p);
    }
}

/// Writes items the UI already has (current results).
#[tauri::command]
pub async fn ddb_export_items(
    items: Vec<JsonItem>,
    key_attrs: Vec<String>,
    format: ExportFormat,
    dest: String,
) -> Result<usize, AppError> {
    ddb_io::export_items(&items, &key_attrs, format, &dest).await
}

/// Scans the whole table to a file; progress as `ddb-progress` events.
/// Returns (items written, cancelled).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ddb_export_table(
    app: AppHandle,
    state: State<'_, AppState>,
    table: String,
    key_attrs: Vec<String>,
    format: ExportFormat,
    dest: String,
    job: u64,
    total: Option<u64>,
) -> Result<(u64, bool), AppError> {
    let progress = emitter(app);
    ddb_io::export_table(
        &*state.connection()?,
        &table,
        &key_attrs,
        format,
        &dest,
        job,
        total,
        &progress,
    )
    .await
}

#[tauri::command]
pub fn ddb_cancel_job(job: u64) {
    ddb_io::cancel(job);
}

#[tauri::command]
pub async fn ddb_plan_import(
    state: State<'_, AppState>,
    table: String,
    key_attrs: Vec<String>,
    key_types: Vec<String>,
    path: String,
) -> Result<ImportPreview, AppError> {
    ddb_io::plan_import(&*state.connection()?, &table, &key_attrs, &key_types, &path).await
}

#[tauri::command]
pub async fn ddb_run_import(
    app: AppHandle,
    state: State<'_, AppState>,
    plan_id: u64,
    overwrite: bool,
    job: u64,
) -> Result<ImportResult, AppError> {
    state.ensure_writable()?;
    let progress = emitter(app);
    ddb_io::run_import(&*state.connection()?, plan_id, overwrite, job, &progress).await
}

#[tauri::command]
pub async fn ddb_create_table(
    state: State<'_, AppState>,
    spec: CreateTableSpec,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    ddb_tables::create_table(&*state.connection()?, &spec).await
}

#[tauri::command]
pub async fn ddb_delete_table(state: State<'_, AppState>, name: String) -> Result<(), AppError> {
    state.ensure_writable()?;
    ddb_tables::delete_table(&*state.connection()?, &name).await
}

#[tauri::command]
pub async fn ddb_add_gsi(
    state: State<'_, AppState>,
    table: String,
    index: IndexSpec,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    ddb_tables::add_gsi(&*state.connection()?, &table, &index).await
}

#[tauri::command]
pub async fn ddb_delete_gsi(
    state: State<'_, AppState>,
    table: String,
    index: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    ddb_tables::delete_gsi(&*state.connection()?, &table, &index).await
}

#[tauri::command]
pub async fn ddb_update_settings(
    state: State<'_, AppState>,
    table: String,
    patch: SettingsPatch,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    ddb_tables::update_settings(&*state.connection()?, &table, &patch).await
}

#[tauri::command]
pub async fn ddb_list_backups(
    state: State<'_, AppState>,
    table: String,
) -> Result<Vec<BackupInfo>, AppError> {
    ddb_tables::list_backups(&*state.connection()?, &table).await
}

#[tauri::command]
pub async fn ddb_create_backup(
    state: State<'_, AppState>,
    table: String,
    name: String,
) -> Result<String, AppError> {
    state.ensure_writable()?;
    ddb_tables::create_backup(&*state.connection()?, &table, &name).await
}

#[tauri::command]
pub async fn ddb_restore_backup(
    state: State<'_, AppState>,
    backup_arn: String,
    target: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    ddb_tables::restore_backup(&*state.connection()?, &backup_arn, &target).await
}

#[tauri::command]
pub async fn ddb_delete_backup(
    state: State<'_, AppState>,
    backup_arn: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    ddb_tables::delete_backup(&*state.connection()?, &backup_arn).await
}
