//! IAM commands (view only: none of them writes).

use super::AppState;
use crate::error::AppError;
use crate::iam::{
    self, GroupDetails, GroupSummary, RoleDetails, RoleExtras, RoleSummary, UserDetails,
    UserExtras, UserSummary,
};
use tauri::State;

#[tauri::command]
pub async fn iam_users(state: State<'_, AppState>) -> Result<Vec<UserSummary>, AppError> {
    iam::list_users(&*state.connection()?).await
}

#[tauri::command]
pub async fn iam_groups(state: State<'_, AppState>) -> Result<Vec<GroupSummary>, AppError> {
    iam::list_groups(&*state.connection()?).await
}

#[tauri::command]
pub async fn iam_roles(state: State<'_, AppState>) -> Result<Vec<RoleSummary>, AppError> {
    iam::list_roles(&*state.connection()?).await
}

/// Access keys and MFA devices for the users on the visible page.
#[tauri::command]
pub async fn iam_user_extras(
    state: State<'_, AppState>,
    names: Vec<String>,
) -> Result<Vec<UserExtras>, AppError> {
    Ok(iam::user_extras(state.connection()?, names).await)
}

/// Last used for the roles on the visible page.
#[tauri::command]
pub async fn iam_role_extras(
    state: State<'_, AppState>,
    names: Vec<String>,
) -> Result<Vec<RoleExtras>, AppError> {
    Ok(iam::role_extras(state.connection()?, names).await)
}

#[tauri::command]
pub async fn iam_user(state: State<'_, AppState>, name: String) -> Result<UserDetails, AppError> {
    iam::user(&*state.connection()?, &name).await
}

#[tauri::command]
pub async fn iam_group(state: State<'_, AppState>, name: String) -> Result<GroupDetails, AppError> {
    iam::group(&*state.connection()?, &name).await
}

#[tauri::command]
pub async fn iam_role(state: State<'_, AppState>, name: String) -> Result<RoleDetails, AppError> {
    iam::role(&*state.connection()?, &name).await
}
