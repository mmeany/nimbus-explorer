//! Step Functions commands.

use super::AppState;
use crate::error::AppError;
use crate::sfn::{
    self, ExecutionDetails, ExecutionPage, FullHistory, HistoryPage, MachineDetails, MachineRef,
    Versions,
};
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
