//! ECS commands.

use super::AppState;
use crate::ecs::{self, ClusterInfo, ServiceInfo, TaskInfo};
use crate::ecs_actions::{self as actions, RunTaskRequest, ServiceChange};
use crate::ecs_taskdefs as taskdefs;
use crate::error::AppError;
use tauri::State;

#[tauri::command]
pub async fn ecs_list_clusters(state: State<'_, AppState>) -> Result<Vec<ClusterInfo>, AppError> {
    ecs::list_clusters(&*state.connection()?).await
}

/// Every service ARN in the cluster; details come per page from ecs_services.
#[tauri::command]
pub async fn ecs_list_service_arns(
    state: State<'_, AppState>,
    cluster: String,
) -> Result<Vec<String>, AppError> {
    ecs::list_service_arns(&*state.connection()?, &cluster).await
}

#[tauri::command]
pub async fn ecs_services(
    state: State<'_, AppState>,
    cluster: String,
    names: Vec<String>,
) -> Result<Vec<ServiceInfo>, AppError> {
    ecs::services(&*state.connection()?, &cluster, &names).await
}

#[tauri::command]
pub async fn ecs_service(
    state: State<'_, AppState>,
    cluster: String,
    name: String,
) -> Result<ServiceInfo, AppError> {
    ecs::service(&*state.connection()?, &cluster, &name).await
}

#[tauri::command]
pub async fn ecs_list_tasks(
    state: State<'_, AppState>,
    cluster: String,
    service: Option<String>,
    stopped: bool,
) -> Result<Vec<TaskInfo>, AppError> {
    ecs::list_tasks(&*state.connection()?, &cluster, service.as_deref(), stopped).await
}

#[tauri::command]
pub async fn ecs_task(
    state: State<'_, AppState>,
    cluster: String,
    id: String,
) -> Result<TaskInfo, AppError> {
    ecs::task(&*state.connection()?, &cluster, &id).await
}

/// Task definition families (ACTIVE, or INACTIVE when `inactive`).
#[tauri::command]
pub async fn ecs_families(
    state: State<'_, AppState>,
    prefix: String,
    inactive: bool,
) -> Result<Vec<String>, AppError> {
    taskdefs::families(&*state.connection()?, &prefix, inactive).await
}

/// Revisions of a family ("family:rev"), newest first.
#[tauri::command]
pub async fn ecs_revisions(
    state: State<'_, AppState>,
    family: String,
    inactive: bool,
) -> Result<Vec<String>, AppError> {
    taskdefs::revisions(&*state.connection()?, &family, inactive).await
}

#[tauri::command]
pub async fn ecs_update_service(
    state: State<'_, AppState>,
    cluster: String,
    service: String,
    change: ServiceChange,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    actions::update_service(&*state.connection()?, &cluster, &service, &change).await
}

#[tauri::command]
pub async fn ecs_stop_task(
    state: State<'_, AppState>,
    cluster: String,
    task: String,
    reason: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    actions::stop_task(&*state.connection()?, &cluster, &task, &reason).await
}

/// Starts tasks; returns their ids.
#[tauri::command]
pub async fn ecs_run_task(
    state: State<'_, AppState>,
    request: RunTaskRequest,
) -> Result<Vec<String>, AppError> {
    state.ensure_writable()?;
    actions::run_task(&*state.connection()?, &request).await
}

/// Splits a command line into words (quotes respected).
#[tauri::command]
pub fn ecs_split_command(text: String) -> Result<Vec<String>, AppError> {
    actions::split_command(&text).map_err(crate::ecs::other)
}

/// A task definition as JSON (and ready-to-register JSON).
#[tauri::command]
pub async fn ecs_task_definition(
    state: State<'_, AppState>,
    name: String,
) -> Result<taskdefs::TaskDefJson, AppError> {
    taskdefs::describe(&*state.connection()?, &name).await
}

/// Registers JSON as a new revision; returns "family:rev".
#[tauri::command]
pub async fn ecs_register_task_definition(
    state: State<'_, AppState>,
    json: String,
) -> Result<String, AppError> {
    state.ensure_writable()?;
    taskdefs::register(&*state.connection()?, &json).await
}

#[tauri::command]
pub async fn ecs_deregister_task_definition(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    taskdefs::deregister(&*state.connection()?, &name).await
}
