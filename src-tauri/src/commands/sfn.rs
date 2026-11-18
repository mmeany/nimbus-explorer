//! Step Functions commands.

use super::AppState;
use crate::error::AppError;
use crate::sfn::{
    self, ExecutionDetails, ExecutionPage, FullHistory, HistoryPage, MachineDetails, MachineRef,
    Versions,
};
use crate::sfn_activities::{self as activities, Activity};
use crate::sfn_admin::{self as admin, CreateRequest, UpdateOutcome, UpdateRequest, Validation};
use crate::sfn_export::{self as export, Format};
use crate::sfn_map::{self as map, MapRunChange, MapRunDetails, MapRunRef};
use crate::sfn_run::{self as run, SavedInput, StartRequest, Started};
use crate::sfn_versions::{self as versions, AliasRequest};
use tauri::State;

/// Every state machine in the region (names, types, ARNs); details come per page.
#[tauri::command]
pub async fn sfn_list(state: State<'_, AppState>) -> Result<Vec<MachineRef>, AppError> {
    sfn::list(&*state.connection()?).await
}

/// DescribeStateMachine for the visible page of the list.
#[tauri::command]
pub async fn sfn_details_many(
    state: State<'_, AppState>,
    arns: Vec<String>,
) -> Result<Vec<MachineDetails>, AppError> {
    sfn::details_many(&*state.connection()?, &arns).await
}

#[tauri::command]
pub async fn sfn_describe(
    state: State<'_, AppState>,
    arn: String,
) -> Result<MachineDetails, AppError> {
    sfn::describe(&*state.connection()?, &arn).await
}

#[tauri::command]
pub async fn sfn_executions(
    state: State<'_, AppState>,
    arn: String,
    status: Option<String>,
    token: Option<String>,
    page_size: i32,
) -> Result<ExecutionPage, AppError> {
    sfn::executions(
        &*state.connection()?,
        &arn,
        status.as_deref(),
        token,
        page_size,
    )
    .await
}

#[tauri::command]
pub async fn sfn_execution(
    state: State<'_, AppState>,
    arn: String,
) -> Result<ExecutionDetails, AppError> {
    sfn::execution(&*state.connection()?, &arn).await
}

#[tauri::command]
pub async fn sfn_history(
    state: State<'_, AppState>,
    arn: String,
    token: Option<String>,
    page_size: i32,
) -> Result<HistoryPage, AppError> {
    sfn::history(&*state.connection()?, &arn, token, page_size).await
}

#[tauri::command]
pub async fn sfn_versions(state: State<'_, AppState>, arn: String) -> Result<Versions, AppError> {
    sfn::versions(&*state.connection()?, &arn).await
}

/// Every event (up to 25,000), for colouring the graph.
#[tauri::command]
pub async fn sfn_history_all(
    state: State<'_, AppState>,
    arn: String,
) -> Result<FullHistory, AppError> {
    sfn::history_all(&*state.connection()?, &arn, sfn::HISTORY_LIMIT).await
}

#[tauri::command]
pub async fn sfn_execution_definition(
    state: State<'_, AppState>,
    arn: String,
) -> Result<String, AppError> {
    sfn::execution_definition(&*state.connection()?, &arn).await
}

/// Saves an exported graph (a local write; allowed in read-only mode).
#[tauri::command]
pub async fn sfn_export_svg(path: String, svg: String) -> Result<(), AppError> {
    sfn::save_svg(&path, &svg).await
}

/// Starts an execution (a write: it runs the workflow).
#[tauri::command]
pub async fn sfn_start(
    state: State<'_, AppState>,
    request: StartRequest,
) -> Result<Started, AppError> {
    state.ensure_writable()?;
    run::start(&*state.connection()?, &request).await
}

#[tauri::command]
pub async fn sfn_stop(
    state: State<'_, AppState>,
    arn: String,
    error: Option<String>,
    cause: Option<String>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    run::stop(
        &*state.connection()?,
        &arn,
        error.as_deref(),
        cause.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn sfn_redrive(
    state: State<'_, AppState>,
    arn: String,
) -> Result<Option<String>, AppError> {
    state.ensure_writable()?;
    run::redrive(&*state.connection()?, &arn).await
}

/// Saved inputs for `key` ("profile|region|machine"); local, allowed in read-only mode.
#[tauri::command]
pub fn sfn_inputs(state: State<'_, AppState>, key: String) -> Vec<SavedInput> {
    run::list_inputs(&state.settings.dir(), &key)
}

#[tauri::command]
pub fn sfn_save_input(
    state: State<'_, AppState>,
    key: String,
    name: String,
    input: String,
) -> Result<Vec<SavedInput>, AppError> {
    run::save_input(&state.settings.dir(), &key, &name, &input)
}

#[tauri::command]
pub fn sfn_delete_input(
    state: State<'_, AppState>,
    key: String,
    name: String,
) -> Result<Vec<SavedInput>, AppError> {
    run::delete_input(&state.settings.dir(), &key, &name)
}

/// The Distributed Map runs of an execution.
#[tauri::command]
pub async fn sfn_map_runs(
    state: State<'_, AppState>,
    arn: String,
) -> Result<Vec<MapRunRef>, AppError> {
    map::list(&*state.connection()?, &arn).await
}

#[tauri::command]
pub async fn sfn_map_run(
    state: State<'_, AppState>,
    arn: String,
) -> Result<MapRunDetails, AppError> {
    map::describe(&*state.connection()?, &arn).await
}

/// Changes a running map run's concurrency / failure tolerance.
#[tauri::command]
pub async fn sfn_update_map_run(
    state: State<'_, AppState>,
    arn: String,
    change: MapRunChange,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    map::update(&*state.connection()?, &arn, &change).await
}

/// Checks a definition with ValidateStateMachineDefinition (reads only).
#[tauri::command]
pub async fn sfn_validate(
    state: State<'_, AppState>,
    definition: String,
    kind: String,
) -> Result<Validation, AppError> {
    admin::validate(&*state.connection()?, &definition, &kind).await
}

/// Saves definition / role / logging / tracing (and publishes, if asked).
#[tauri::command]
pub async fn sfn_update(
    state: State<'_, AppState>,
    request: UpdateRequest,
) -> Result<UpdateOutcome, AppError> {
    state.ensure_writable()?;
    admin::update(&*state.connection()?, &request).await
}

#[tauri::command]
pub async fn sfn_publish_version(
    state: State<'_, AppState>,
    arn: String,
    description: Option<String>,
    revision_id: Option<String>,
) -> Result<String, AppError> {
    state.ensure_writable()?;
    versions::publish(
        &*state.connection()?,
        &arn,
        description.as_deref(),
        revision_id.as_deref(),
    )
    .await
}

/// Creates the alias, or updates it when `update` (the routing is always sent in full).
#[tauri::command]
pub async fn sfn_save_alias(
    state: State<'_, AppState>,
    alias: AliasRequest,
    update: bool,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    let conn = state.connection()?;
    if update {
        versions::update_alias(&conn, &alias).await
    } else {
        versions::create_alias(&conn, &alias).await.map(|_| ())
    }
}

#[tauri::command]
pub async fn sfn_delete_alias(state: State<'_, AppState>, arn: String) -> Result<(), AppError> {
    state.ensure_writable()?;
    versions::delete_alias(&*state.connection()?, &arn).await
}

/// Refused while an alias routes to the version.
#[tauri::command]
pub async fn sfn_delete_version(state: State<'_, AppState>, arn: String) -> Result<(), AppError> {
    state.ensure_writable()?;
    versions::delete_version(&*state.connection()?, &arn).await
}

#[tauri::command]
pub async fn sfn_create(
    state: State<'_, AppState>,
    request: CreateRequest,
) -> Result<String, AppError> {
    state.ensure_writable()?;
    admin::create(&*state.connection()?, &request).await
}

#[tauri::command]
pub async fn sfn_delete(state: State<'_, AppState>, arn: String) -> Result<(), AppError> {
    state.ensure_writable()?;
    admin::delete(&*state.connection()?, &arn).await
}

/// Every activity in the region.
#[tauri::command]
pub async fn sfn_activities(state: State<'_, AppState>) -> Result<Vec<Activity>, AppError> {
    activities::list(&*state.connection()?).await
}

#[tauri::command]
pub async fn sfn_activity(state: State<'_, AppState>, arn: String) -> Result<Activity, AppError> {
    activities::describe(&*state.connection()?, &arn).await
}

#[tauri::command]
pub async fn sfn_create_activity(
    state: State<'_, AppState>,
    name: String,
) -> Result<String, AppError> {
    state.ensure_writable()?;
    activities::create(&*state.connection()?, &name).await
}

#[tauri::command]
pub async fn sfn_delete_activity(state: State<'_, AppState>, arn: String) -> Result<(), AppError> {
    state.ensure_writable()?;
    activities::delete(&*state.connection()?, &arn).await
}

/// Every execution of a machine or map run to a file (a local write; allowed in read-only mode).
#[tauri::command]
pub async fn sfn_export_executions(
    state: State<'_, AppState>,
    arn: String,
    status: Option<String>,
    format: Format,
    dest: String,
) -> Result<usize, AppError> {
    export::export_executions(
        &*state.connection()?,
        &arn,
        status.as_deref().filter(|s| !s.is_empty()),
        format,
        &dest,
    )
    .await
}

/// An execution's event history to a file (a local write; allowed in read-only mode).
#[tauri::command]
pub async fn sfn_export_history(
    state: State<'_, AppState>,
    arn: String,
    format: Format,
    dest: String,
) -> Result<usize, AppError> {
    export::export_history(&*state.connection()?, &arn, format, &dest).await
}
