//! SNS commands.

use super::AppState;
use crate::error::AppError;
use crate::sns::{self, SubscriptionInfo, TopicInfo};
use crate::sns_publish::{self as publish, PubMessage};
use crate::sns_watch::{self as watch, Leftover, WatchInfo, WatchedMessage};
use crate::sqs_messages::{BatchReport, FilePreview, SendResult};
use std::collections::BTreeMap;
use tauri::State;

#[tauri::command]
pub async fn sns_list_topic_arns(state: State<'_, AppState>) -> Result<Vec<String>, AppError> {
    sns::list_topic_arns(&*state.connection()?).await
}

/// Attributes for the topics on the visible page.
#[tauri::command]
pub async fn sns_details_many(
    state: State<'_, AppState>,
    arns: Vec<String>,
) -> Result<Vec<TopicInfo>, AppError> {
    sns::details_many(&*state.connection()?, &arns).await
}

#[tauri::command]
pub async fn sns_topic_details(
    state: State<'_, AppState>,
    arn: String,
) -> Result<TopicInfo, AppError> {
    sns::topic_details(&*state.connection()?, &arn).await
}

/// Subscriptions of a topic, or of the whole account when `topicArn` is null.
#[tauri::command]
pub async fn sns_list_subscriptions(
    state: State<'_, AppState>,
    topic_arn: Option<String>,
) -> Result<Vec<SubscriptionInfo>, AppError> {
    sns::list_subscriptions(&*state.connection()?, topic_arn.as_deref()).await
}

#[tauri::command]
pub async fn sns_list_tags(
    state: State<'_, AppState>,
    arn: String,
) -> Result<Vec<(String, String)>, AppError> {
    sns::list_tags(&*state.connection()?, &arn).await
}

#[tauri::command]
pub async fn sns_create_topic(
    state: State<'_, AppState>,
    name: String,
    attributes: BTreeMap<String, String>,
    tags: Vec<(String, String)>,
) -> Result<String, AppError> {
    state.ensure_writable()?;
    sns::create_topic(&*state.connection()?, &name, &attributes, &tags).await
}

#[tauri::command]
pub async fn sns_set_topic_attributes(
    state: State<'_, AppState>,
    arn: String,
    attributes: BTreeMap<String, String>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    sns::set_topic_attributes(&*state.connection()?, &arn, &attributes).await
}

#[tauri::command]
pub async fn sns_set_tags(
    state: State<'_, AppState>,
    arn: String,
    tags: Vec<(String, String)>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    sns::set_tags(&*state.connection()?, &arn, &tags).await
}

#[tauri::command]
pub async fn sns_get_data_protection_policy(
    state: State<'_, AppState>,
    arn: String,
) -> Result<Option<String>, AppError> {
    sns::get_data_protection_policy(&*state.connection()?, &arn).await
}

#[tauri::command]
pub async fn sns_put_data_protection_policy(
    state: State<'_, AppState>,
    arn: String,
    policy: String,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    sns::put_data_protection_policy(&*state.connection()?, &arn, &policy).await
}

#[tauri::command]
pub async fn sns_delete_topic(state: State<'_, AppState>, arn: String) -> Result<(), AppError> {
    state.ensure_writable()?;
    sns::delete_topic(&*state.connection()?, &arn).await
}

#[tauri::command]
pub async fn sns_subscribe(
    state: State<'_, AppState>,
    topic_arn: String,
    protocol: String,
    endpoint: String,
    attributes: BTreeMap<String, String>,
) -> Result<String, AppError> {
    state.ensure_writable()?;
    sns::subscribe(
        &*state.connection()?,
        &topic_arn,
        &protocol,
        &endpoint,
        &attributes,
    )
    .await
}

#[tauri::command]
pub async fn sns_confirm_subscription(
    state: State<'_, AppState>,
    topic_arn: String,
    token: String,
    authenticate_unsubscribe: bool,
) -> Result<String, AppError> {
    state.ensure_writable()?;
    sns::confirm_subscription(
        &*state.connection()?,
        &topic_arn,
        &token,
        authenticate_unsubscribe,
    )
    .await
}

#[tauri::command]
pub async fn sns_unsubscribe(state: State<'_, AppState>, arn: String) -> Result<(), AppError> {
    state.ensure_writable()?;
    sns::unsubscribe(&*state.connection()?, &arn).await
}

#[tauri::command]
pub async fn sns_subscription_attributes(
    state: State<'_, AppState>,
    arn: String,
) -> Result<BTreeMap<String, String>, AppError> {
    sns::subscription_attributes(&*state.connection()?, &arn).await
}

#[tauri::command]
pub async fn sns_set_subscription_attributes(
    state: State<'_, AppState>,
    arn: String,
    attributes: BTreeMap<String, String>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    sns::set_subscription_attributes(&*state.connection()?, &arn, &attributes).await
}

#[tauri::command]
pub async fn sns_allow_topic_on_queue(
    state: State<'_, AppState>,
    queue_arn: String,
    topic_arn: String,
) -> Result<bool, AppError> {
    state.ensure_writable()?;
    sns::allow_topic_on_queue(&*state.connection()?, &queue_arn, &topic_arn).await
}

#[tauri::command]
pub async fn sns_publish(
    state: State<'_, AppState>,
    topic_arn: String,
    message: PubMessage,
) -> Result<SendResult, AppError> {
    state.ensure_writable()?;
    publish::publish(&*state.connection()?, &topic_arn, &message).await
}

#[tauri::command]
pub async fn sns_publish_batch(
    state: State<'_, AppState>,
    topic_arn: String,
    messages: Vec<PubMessage>,
) -> Result<BatchReport, AppError> {
    state.ensure_writable()?;
    publish::publish_batch(&*state.connection()?, &topic_arn, &messages).await
}

/// Counts and samples the messages in a JSON array / JSON-lines file.
#[tauri::command]
pub async fn sns_preview_file(path: String, envelope: bool) -> Result<FilePreview, AppError> {
    publish::preview_file(&path, envelope).await
}

#[tauri::command]
pub async fn sns_publish_file(
    state: State<'_, AppState>,
    topic_arn: String,
    path: String,
    envelope: bool,
    group_id: Option<String>,
    subject: Option<String>,
) -> Result<BatchReport, AppError> {
    state.ensure_writable()?;
    publish::publish_file(
        &*state.connection()?,
        &topic_arn,
        &path,
        envelope,
        group_id,
        subject,
    )
    .await
}

/// Creates a temporary queue subscribed to the topic (a write).
#[tauri::command]
pub async fn sns_watch_start(
    state: State<'_, AppState>,
    topic_arn: String,
    raw: bool,
) -> Result<WatchInfo, AppError> {
    state.ensure_writable()?;
    watch::start(state.connection()?, &topic_arn, raw).await
}

/// Polls and stops only touch the app's own temporary queue, so they work
/// in read-only mode too (it may have been switched on while watching).
#[tauri::command]
pub async fn sns_watch_poll(id: String, wait: i32) -> Result<Vec<WatchedMessage>, AppError> {
    watch::poll(&id, wait).await
}

#[tauri::command]
pub async fn sns_watch_stop(id: String) -> Result<(), AppError> {
    watch::stop(&id).await
}

#[tauri::command]
pub async fn sns_watch_leftovers(state: State<'_, AppState>) -> Result<Vec<Leftover>, AppError> {
    watch::find_leftovers(&*state.connection()?).await
}

#[tauri::command]
pub async fn sns_watch_clean_leftovers(state: State<'_, AppState>) -> Result<usize, AppError> {
    state.ensure_writable()?;
    watch::clean_leftovers(&*state.connection()?).await
}
