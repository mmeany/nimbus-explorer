//! ElastiCache commands.

use super::AppState;
use crate::elasticache::{self as ec, Group, GroupDetails, Serverless};
use crate::elasticache_actions as actions;
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

/// Reboots nodes of a cluster-mode-off group.
#[tauri::command]
pub async fn ec_reboot_nodes(
    state: State<'_, AppState>,
    group: String,
    nodes: Vec<String>,
) -> Result<Vec<String>, AppError> {
    state.ensure_writable()?;
    actions::reboot_nodes(&*state.connection()?, &group, &nodes).await
}

/// Promotes a replica of the shard, as if its primary had failed.
#[tauri::command]
pub async fn ec_test_failover(
    state: State<'_, AppState>,
    group: String,
    shard: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    actions::test_failover(&*state.connection()?, &group, &shard).await
}
