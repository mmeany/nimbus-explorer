//! ElastiCache commands.

use super::AppState;
use crate::elasticache::{self as ec, Group, GroupDetails, Serverless};
use crate::error::AppError;
use tauri::State;

/// Every Redis / Valkey replication group in the region (with shards and nodes).
#[tauri::command]
pub async fn ec_list_groups(state: State<'_, AppState>) -> Result<Vec<Group>, AppError> {
    ec::list_groups(&*state.connection()?).await
}

/// Every serverless cache in the region.
#[tauri::command]
pub async fn ec_list_serverless(state: State<'_, AppState>) -> Result<Vec<Serverless>, AppError> {
    ec::list_serverless(&*state.connection()?).await
}

#[tauri::command]
pub async fn ec_group(state: State<'_, AppState>, id: String) -> Result<GroupDetails, AppError> {
    ec::group_details(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn ec_serverless(
    state: State<'_, AppState>,
    name: String,
) -> Result<Serverless, AppError> {
    ec::serverless_details(&*state.connection()?, &name).await
}
