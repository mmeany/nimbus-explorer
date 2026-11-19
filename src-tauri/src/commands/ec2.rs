//! EC2 commands.

use super::AppState;
use crate::ec2::{self, Instance, InstanceDetails};
use crate::ec2_actions::{self as actions, StateChange, TypeInfo};
use crate::ec2_console::{self as console, ConsoleOutput, InstanceStatus, UserData};
use crate::error::AppError;
use tauri::State;

/// Every instance in the region, newest launch first.
#[tauri::command]
pub async fn ec2_instances(state: State<'_, AppState>) -> Result<Vec<Instance>, AppError> {
    ec2::list_instances(&*state.connection()?).await
}

/// One instance with its volumes, interfaces, security groups and protection flags.
#[tauri::command]
pub async fn ec2_instance(state: State<'_, AppState>, id: String) -> Result<InstanceDetails, AppError> {
    ec2::instance_details(&*state.connection()?, &id).await
}

/// Status checks and scheduled events.
#[tauri::command]
pub async fn ec2_status(state: State<'_, AppState>, id: String) -> Result<InstanceStatus, AppError> {
    console::status(&*state.connection()?, &id).await
}

/// Console output (the latest where the instance supports it).
#[tauri::command]
pub async fn ec2_console_output(
    state: State<'_, AppState>,
    id: String,
    latest: bool,
) -> Result<ConsoleOutput, AppError> {
    console::console_output(&*state.connection()?, &id, latest).await
}

/// A screenshot of the instance's console as a data: URL.
#[tauri::command]
pub async fn ec2_screenshot(state: State<'_, AppState>, id: String) -> Result<String, AppError> {
    console::screenshot(&*state.connection()?, &id).await
}

/// User data, decoded. Only on Reveal / Copy; never cached.
#[tauri::command]
pub async fn ec2_user_data(state: State<'_, AppState>, id: String) -> Result<UserData, AppError> {
    console::user_data(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn ec2_start(state: State<'_, AppState>, ids: Vec<String>) -> Result<Vec<StateChange>, AppError> {
    state.ensure_writable()?;
    actions::start(&*state.connection()?, &ids).await
}

#[tauri::command]
pub async fn ec2_stop(
    state: State<'_, AppState>,
    ids: Vec<String>,
    hibernate: bool,
    force: bool,
) -> Result<Vec<StateChange>, AppError> {
    state.ensure_writable()?;
    actions::stop(&*state.connection()?, &ids, hibernate, force).await
}

#[tauri::command]
pub async fn ec2_reboot(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), AppError> {
    state.ensure_writable()?;
    actions::reboot(&*state.connection()?, &ids).await
}

#[tauri::command]
pub async fn ec2_terminate(state: State<'_, AppState>, ids: Vec<String>) -> Result<Vec<StateChange>, AppError> {
    state.ensure_writable()?;
    actions::terminate(&*state.connection()?, &ids).await
}

/// Changes a stopped instance's type.
#[tauri::command]
pub async fn ec2_set_type(state: State<'_, AppState>, id: String, instance_type: String) -> Result<(), AppError> {
    state.ensure_writable()?;
    actions::set_type(&*state.connection()?, &id, &instance_type).await
}

/// Turns termination and / or stop protection on or off (None = unchanged).
#[tauri::command]
pub async fn ec2_set_protection(
    state: State<'_, AppState>,
    id: String,
    termination: Option<bool>,
    stop: Option<bool>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    actions::set_protection(&*state.connection()?, &id, termination, stop).await
}

/// Instance types offered in an availability zone for an architecture.
#[tauri::command]
pub async fn ec2_instance_types(
    state: State<'_, AppState>,
    az: String,
    architecture: Option<String>,
) -> Result<Vec<TypeInfo>, AppError> {
    actions::instance_types(&*state.connection()?, &az, architecture.as_deref()).await
}
