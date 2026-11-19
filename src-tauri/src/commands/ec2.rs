//! EC2 commands.

use super::AppState;
use crate::ec2::{self, Instance, InstanceDetails};
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
