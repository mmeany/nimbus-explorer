mod bookmarks;
mod commands;
mod ddb_io;
mod ddb_items;
mod ddb_tables;
mod dynamo;
mod ecs;
mod ecs_actions;
mod ecs_taskdefs;
mod elasticache;
mod elasticache_actions;
mod elasticache_events;
mod elasticache_params;
mod elasticache_snapshots;
mod elasticache_updates;
mod elasticache_users;
mod error;
mod history;
mod iam;
mod iam_account;
mod lambda;
mod lambda_admin;
mod lambda_code;
mod lambda_invoke;
mod logs;
mod profiles;
mod rds;
mod rds_data;
mod rds_logs;
mod rds_snapshots;
mod s3;
mod secrets;
mod settings;
mod sfn;
mod sfn_activities;
mod sfn_admin;
mod sfn_export;
mod sfn_map;
mod sfn_run;
mod sfn_versions;
mod sns;
mod sns_publish;
mod sns_watch;
mod sqs;
mod sqs_messages;
mod ssm;
mod ssm_io;
mod sync;
mod transfers;
mod yaml;

use commands::AppState;
use settings::SettingsStore;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage(AppState {
                settings: SettingsStore::new(dir),
                conn: Mutex::new(None),
                transfers: Default::default(),
                sync_plans: Default::default(),
                ssm_imports: Default::default(),
                read_only: Default::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::get_settings,
            commands::set_connection_override,
            commands::set_theme,
            commands::set_region,
            commands::set_read_only,
            commands::remember_filter,
            commands::forget_filter,
            commands::bookmarks::bookmarks_load,
            commands::bookmarks::bookmarks_save,
            commands::bookmarks::bookmarks_export,
            commands::bookmarks::bookmarks_read_import,
            commands::bookmarks::set_bookmarks_bar,
            commands::history::history_record,
            commands::history::history_page,
            commands::history::history_profiles,
            commands::history::history_export,
            commands::history::history_clear,
            commands::history::history_open_folder,
            commands::history::set_history_settings,
            commands::ssm::ssm_list_path,
            commands::ssm::ssm_list_prefix,
            commands::ssm::ssm_values,
            commands::ssm::ssm_describe,
            commands::ssm::ssm_get_value,
            commands::ssm::ssm_put,
            commands::ssm::ssm_delete,
            commands::ssm::ssm_history,
            commands::ssm::ssm_label,
            commands::ssm::ssm_unlabel,
            commands::ssm::ssm_restore,
            commands::ssm::ssm_list_tags,
            commands::ssm::ssm_set_tags,
            commands::ssm::ssm_update_tier_policies,
            commands::ssm::ssm_plan_copy,
            commands::ssm::ssm_copy,
            commands::ssm::ssm_export,
            commands::ssm::ssm_plan_import,
            commands::ssm::ssm_run_import,
            commands::sqs::sqs_list_refs,
            commands::sqs::sqs_details_many,
            commands::sqs::sqs_queue_details,
            commands::sqs::sqs_queue_url,
            commands::sqs::sqs_dlq_sources,
            commands::sqs::sqs_list_tags,
            commands::sqs::sqs_create_queue,
            commands::sqs::sqs_set_attributes,
            commands::sqs::sqs_set_tags,
            commands::sqs::sqs_delete_queue,
            commands::sqs::sqs_purge,
            commands::sqs::sqs_send,
            commands::sqs::sqs_send_batch,
            commands::sqs::sqs_preview_file,
            commands::sqs::sqs_send_file,
            commands::sqs::sqs_receive,
            commands::sqs::sqs_delete_messages,
            commands::sqs::sqs_change_visibility,
            commands::sqs::sqs_export_messages,
            commands::sqs::sqs_start_redrive,
            commands::sqs::sqs_list_redrives,
            commands::sqs::sqs_cancel_redrive,
            commands::sqs::sqs_move_messages,
            commands::dynamo::ddb_list_table_names,
            commands::dynamo::ddb_details_many,
            commands::dynamo::ddb_describe_table,
            commands::dynamo::ddb_list_tags,
            commands::dynamo::ddb_read_page,
            commands::dynamo::ddb_count,
            commands::dynamo::ddb_get_item,
            commands::dynamo::ddb_put_item,
            commands::dynamo::ddb_delete_items,
            commands::dynamo::ddb_execute,
            commands::dynamo::ddb_export_items,
            commands::dynamo::ddb_export_table,
            commands::dynamo::ddb_cancel_job,
            commands::dynamo::ddb_plan_import,
            commands::dynamo::ddb_run_import,
            commands::dynamo::ddb_create_table,
            commands::dynamo::ddb_delete_table,
            commands::dynamo::ddb_add_gsi,
            commands::dynamo::ddb_delete_gsi,
            commands::dynamo::ddb_update_settings,
            commands::dynamo::ddb_list_backups,
            commands::dynamo::ddb_create_backup,
            commands::dynamo::ddb_restore_backup,
            commands::dynamo::ddb_delete_backup,
            commands::secrets::sm_list,
            commands::secrets::sm_describe,
            commands::secrets::sm_get_value,
            commands::secrets::sm_create,
            commands::secrets::sm_put_value,
            commands::secrets::sm_update_metadata,
            commands::secrets::sm_delete,
            commands::secrets::sm_restore,
            commands::secrets::sm_list_versions,
            commands::secrets::sm_move_label,
            commands::secrets::sm_configure_rotation,
            commands::secrets::sm_rotate_now,
            commands::secrets::sm_cancel_rotation,
            commands::secrets::sm_set_tags,
            commands::secrets::sm_get_policy,
            commands::secrets::sm_validate_policy,
            commands::secrets::sm_put_policy,
            commands::secrets::sm_delete_policy,
            commands::rds::rds_list,
            commands::rds::rds_describe_instance,
            commands::rds::rds_describe_cluster,
            commands::rds::rds_pending_maintenance,
            commands::rds::rds_list_tags,
            commands::rds::rds_start,
            commands::rds::rds_stop,
            commands::rds::rds_reboot,
            commands::rds::rds_failover,
            commands::rds::rds_modify,
            commands::rds::rds_delete,
            commands::rds::rds_list_snapshots,
            commands::rds::rds_create_snapshot,
            commands::rds::rds_copy_snapshot,
            commands::rds::rds_delete_snapshot,
            commands::rds::rds_restore,
            commands::rds::rds_events,
            commands::rds::rds_log_files,
            commands::rds::rds_log_tail,
            commands::rds::rds_log_download,
            commands::rds::rds_execute_sql,
            commands::rds::rds_save_result,
            commands::logs::logs_list_groups,
            commands::logs::logs_describe_group,
            commands::logs::logs_list_streams,
            commands::logs::logs_latest,
            commands::logs::logs_download,
            commands::elasticache::ec_list_groups,
            commands::elasticache::ec_list_serverless,
            commands::elasticache::ec_group,
            commands::elasticache::ec_serverless,
            commands::elasticache::ec_reboot_nodes,
            commands::elasticache::ec_test_failover,
            commands::elasticache::ec_snapshots,
            commands::elasticache::ec_create_snapshot,
            commands::elasticache::ec_copy_snapshot,
            commands::elasticache::ec_delete_snapshot,
            commands::elasticache::ec_restore_snapshot,
            commands::elasticache::ec_events,
            commands::elasticache::ec_parameters,
            commands::elasticache::ec_updates,
            commands::elasticache::ec_apply_update,
            commands::elasticache::ec_users,
            commands::iam::iam_users,
            commands::iam::iam_groups,
            commands::iam::iam_roles,
            commands::iam::iam_user_extras,
            commands::iam::iam_role_extras,
            commands::iam::iam_user,
            commands::iam::iam_group,
            commands::iam::iam_role,
            commands::iam::iam_policies,
            commands::iam::iam_policy,
            commands::iam::iam_policy_version,
            commands::iam::iam_account,
            commands::iam::iam_credential_report,
            commands::iam::iam_export_credential_report,
            commands::sfn::sfn_list,
            commands::sfn::sfn_details_many,
            commands::sfn::sfn_describe,
            commands::sfn::sfn_executions,
            commands::sfn::sfn_execution,
            commands::sfn::sfn_history,
            commands::sfn::sfn_versions,
            commands::sfn::sfn_history_all,
            commands::sfn::sfn_execution_definition,
            commands::sfn::sfn_export_svg,
            commands::sfn::sfn_export_executions,
            commands::sfn::sfn_export_history,
            commands::sfn::sfn_start,
            commands::sfn::sfn_stop,
            commands::sfn::sfn_redrive,
            commands::sfn::sfn_inputs,
            commands::sfn::sfn_save_input,
            commands::sfn::sfn_delete_input,
            commands::sfn::sfn_map_runs,
            commands::sfn::sfn_map_run,
            commands::sfn::sfn_update_map_run,
            commands::sfn::sfn_validate,
            commands::sfn::sfn_update,
            commands::sfn::sfn_create,
            commands::sfn::sfn_delete,
            commands::sfn::sfn_activities,
            commands::sfn::sfn_activity,
            commands::sfn::sfn_create_activity,
            commands::sfn::sfn_delete_activity,
            commands::sfn::sfn_publish_version,
            commands::sfn::sfn_save_alias,
            commands::sfn::sfn_delete_alias,
            commands::sfn::sfn_delete_version,
            commands::lambda::lambda_list,
            commands::lambda::lambda_get,
            commands::lambda::lambda_env_values,
            commands::lambda::lambda_triggers,
            commands::lambda::lambda_versions,
            commands::lambda::lambda_invoke,
            commands::lambda::lambda_test_events,
            commands::lambda::lambda_save_test_event,
            commands::lambda::lambda_delete_test_event,
            commands::lambda::lambda_update_config,
            commands::lambda::lambda_set_concurrency,
            commands::lambda::lambda_set_mapping_enabled,
            commands::lambda::lambda_publish_version,
            commands::lambda::lambda_save_alias,
            commands::lambda::lambda_delete_alias,
            commands::lambda::lambda_delete_version,
            commands::lambda::lambda_delete_function,
            commands::lambda::lambda_download_code,
            commands::lambda::lambda_upload_code,
            commands::ecs::ecs_list_clusters,
            commands::ecs::ecs_list_service_arns,
            commands::ecs::ecs_services,
            commands::ecs::ecs_service,
            commands::ecs::ecs_list_tasks,
            commands::ecs::ecs_task,
            commands::ecs::ecs_families,
            commands::ecs::ecs_revisions,
            commands::ecs::ecs_update_service,
            commands::ecs::ecs_stop_task,
            commands::ecs::ecs_run_task,
            commands::ecs::ecs_split_command,
            commands::ecs::ecs_task_definition,
            commands::ecs::ecs_register_task_definition,
            commands::ecs::ecs_deregister_task_definition,
            commands::sns::sns_list_topic_arns,
            commands::sns::sns_details_many,
            commands::sns::sns_topic_details,
            commands::sns::sns_list_subscriptions,
            commands::sns::sns_list_tags,
            commands::sns::sns_create_topic,
            commands::sns::sns_set_topic_attributes,
            commands::sns::sns_set_tags,
            commands::sns::sns_get_data_protection_policy,
            commands::sns::sns_put_data_protection_policy,
            commands::sns::sns_delete_topic,
            commands::sns::sns_subscribe,
            commands::sns::sns_confirm_subscription,
            commands::sns::sns_unsubscribe,
            commands::sns::sns_subscription_attributes,
            commands::sns::sns_set_subscription_attributes,
            commands::sns::sns_allow_topic_on_queue,
            commands::sns::sns_publish,
            commands::sns::sns_publish_batch,
            commands::sns::sns_preview_file,
            commands::sns::sns_publish_file,
            commands::sns::sns_watch_start,
            commands::sns::sns_watch_poll,
            commands::sns::sns_watch_stop,
            commands::sns::sns_watch_leftovers,
            commands::sns::sns_watch_clean_leftovers,
            commands::pick_open_file,
            commands::pick_save_as,
            commands::connect,
            commands::s3::list_buckets,
            commands::s3::list_objects,
            commands::s3::list_folders,
            commands::s3::existing_keys,
            commands::pick_upload_files,
            commands::pick_folder,
            commands::pick_save_file,
            commands::s3::upload_paths,
            commands::s3::download_file,
            commands::s3::download_to_folder,
            commands::cancel_transfer,
            commands::cancel_all_transfers,
            commands::s3::create_folder,
            commands::s3::count_items,
            commands::s3::delete_items,
            commands::s3::copy_items,
            commands::s3::preview_object,
            commands::s3::share_link,
            commands::s3::object_properties,
            commands::parse_yaml,
            commands::about_info,
            commands::open_project_page,
            commands::s3::plan_sync,
            commands::s3::run_sync,
            commands::s3::export_listing,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Nimbus Explorer")
        .run(|_app, event| {
            // Remove temporary SNS watch queues / subscriptions before exiting.
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(async {
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        sns_watch::stop_all(),
                    )
                    .await;
                });
            }
        });
}
