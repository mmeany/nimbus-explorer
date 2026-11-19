//! EC2 commands.

use super::AppState;
use crate::ec2::{self, Instance, InstanceDetails};
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
