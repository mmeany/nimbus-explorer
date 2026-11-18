//! ElastiCache commands.

use super::AppState;
use crate::elasticache::{self as ec, Group, GroupDetails, Serverless};
use crate::elasticache_actions as actions;
use crate::elasticache_events::{self as events, Event};
use crate::elasticache_snapshots::{
    self as snapshots, Kind, RestoreRequest, Restored, Snapshot, SnapshotList,
};
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

/// Snapshots in the region, or of one cache (`kind` + `cache`).
#[tauri::command]
pub async fn ec_snapshots(
    state: State<'_, AppState>,
    kind: Option<Kind>,
    cache: Option<String>,
) -> Result<SnapshotList, AppError> {
    snapshots::list(&*state.connection()?, kind.zip(cache)).await
}

#[tauri::command]
pub async fn ec_create_snapshot(
    state: State<'_, AppState>,
    kind: Kind,
    cache: String,
    name: String,
) -> Result<Snapshot, AppError> {
    state.ensure_writable()?;
    snapshots::create(&*state.connection()?, kind, &cache, &name).await
}

#[tauri::command]
pub async fn ec_copy_snapshot(
    state: State<'_, AppState>,
    kind: Kind,
    source: String,
    target: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    snapshots::copy(&*state.connection()?, kind, &source, &target).await
}

/// Manual snapshots only.
#[tauri::command]
pub async fn ec_delete_snapshot(
    state: State<'_, AppState>,
    kind: Kind,
    name: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    snapshots::delete(&*state.connection()?, kind, &name).await
}

/// Restores a snapshot into a new cache.
#[tauri::command]
pub async fn ec_restore_snapshot(
    state: State<'_, AppState>,
    request: RestoreRequest,
) -> Result<Restored, AppError> {
    state.ensure_writable()?;
    snapshots::restore(&*state.connection()?, &request).await
}

/// Events of a group (and its nodes) or a serverless cache, newest first.
#[tauri::command]
pub async fn ec_events(
    state: State<'_, AppState>,
    kind: Kind,
    id: String,
    minutes: i32,
) -> Result<Vec<Event>, AppError> {
    events::events(&*state.connection()?, kind, &id, minutes).await
}
