//! Step Functions: validate and update a state machine (definition, role,
//! logging, tracing), optionally publishing a version.

use crate::error::AppError;
use crate::s3::Connection;
use crate::sfn::{client, err, other};
use aws_sdk_sfn::types::{
    CloudWatchLogsLogGroup, LogDestination, LogLevel, LoggingConfiguration, StateMachineType,
    TracingConfiguration,
};
use serde::{Deserialize, Serialize};

/// UpdateStateMachine's definition limit (1 MB).
pub const MAX_DEFINITION: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    /// ERROR or WARNING.
    pub severity: String,
    pub code: String,
    pub message: String,
    /// JSON pointer into the definition ("/States/Charge/Next"), if AWS gave one.
    pub location: Option<String>,
    /// The state the location points at, if any.
    pub state: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Validation {
    /// OK or FAIL.
    pub result: String,
    pub diagnostics: Vec<Diagnostic>,
    pub truncated: bool,
}

/// "/States/Fan/ItemProcessor/States/Check/Choices/0/Next" → "Check" (the innermost state).
pub fn state_of(location: &str) -> Option<String> {
    let parts: Vec<&str> = location.split('/').collect();
    let mut found = None;
    for w in parts.windows(2) {
        if w[0] == "States" && !w[1].is_empty() {
            found = Some(w[1].replace("~1", "/").replace("~0", "~"));
        }
    }
    found
}

pub async fn validate(
    conn: &Connection,
    definition: &str,
    kind: &str,
) -> Result<Validation, AppError> {
    let out = client(conn)
        .validate_state_machine_definition()
        .definition(definition)
        .r#type(StateMachineType::from(kind))
        .max_results(100)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(Validation {
        result: out.result().as_str().to_string(),
        diagnostics: out
            .diagnostics()
            .iter()
            .map(|d| Diagnostic {
                severity: d.severity().as_str().to_string(),
                code: d.code().to_string(),
                message: d.message().to_string(),
                location: d.location().map(String::from),
                state: d.location().and_then(state_of),
            })
            .collect(),
        truncated: out.truncated().unwrap_or(false),
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggingChange {
    /// ALL, ERROR, FATAL or OFF.
    pub level: String,
    pub include_execution_data: bool,
    /// Required unless the level is OFF.
    pub log_group_arn: Option<String>,
}

/// What to change; fields left None stay as they are.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRequest {
    pub arn: String,
    /// The revision the editor opened; a different current one is a conflict.
    pub expected_revision: Option<String>,
    /// Save even if the machine changed since the editor opened.
    #[serde(default)]
    pub overwrite: bool,
    pub definition: Option<String>,
    pub role_arn: Option<String>,
    pub logging: Option<LoggingChange>,
    pub tracing: Option<bool>,
    #[serde(default)]
    pub publish: bool,
    pub version_description: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UpdateOutcome {
    Saved {
        revision_id: Option<String>,
        /// The published version, when `publish` was set.
        version_arn: Option<String>,
    },
    /// Someone changed the machine after the editor opened; nothing was saved.
    Changed {
        current_revision: Option<String>,
        updated: Option<String>,
    },
}

/// Why AWS would refuse the request, if it would (checked before any call).
pub fn request_problem(r: &UpdateRequest) -> Option<String> {
    if r.definition.is_none()
        && r.role_arn.is_none()
        && r.logging.is_none()
        && r.tracing.is_none()
        && !r.publish
    {
        return Some("Nothing to change".into());
    }
    if let Some(d) = &r.definition {
        if d.len() > MAX_DEFINITION {
            return Some("The definition is over 1 MB, the most Step Functions accepts".into());
        }
        if let Err(e) = serde_json::from_str::<serde_json::Value>(d) {
            return Some(format!("The definition isn't valid JSON: {e}"));
        }
    }
    if let Some(role) = &r.role_arn {
        if !role.starts_with("arn:") || !role.contains(":role/") {
            return Some(
                "The execution role is an IAM role ARN (arn:aws:iam::<account>:role/<name>)".into(),
            );
        }
    }
    if let Some(l) = &r.logging {
        if !["ALL", "ERROR", "FATAL", "OFF"].contains(&l.level.as_str()) {
            return Some("The log level is ALL, ERROR, FATAL or OFF".into());
        }
        let group = l.log_group_arn.as_deref().map(str::trim).unwrap_or("");
        if l.level != "OFF" && !(group.starts_with("arn:") && group.contains(":log-group:")) {
            return Some("Logging needs a CloudWatch Logs log group ARN (arn:aws:logs:<region>:<account>:log-group:<name>:*)".into());
        }
    }
    if r.version_description
        .as_deref()
        .is_some_and(|d| d.chars().count() > 256)
    {
        return Some("The version description is at most 256 characters".into());
    }
    None
}

fn logging_config(l: &LoggingChange) -> LoggingConfiguration {
    let mut b = LoggingConfiguration::builder()
        .level(LogLevel::from(l.level.as_str()))
        .include_execution_data(l.include_execution_data);
    if l.level != "OFF" {
        if let Some(arn) = l
            .log_group_arn
            .as_deref()
            .map(str::trim)
            .filter(|a| !a.is_empty())
        {
            b = b.destinations(
                LogDestination::builder()
                    .cloud_watch_logs_log_group(
                        CloudWatchLogsLogGroup::builder().log_group_arn(arn).build(),
                    )
                    .build(),
            );
        }
    }
    b.build()
}

pub async fn update(conn: &Connection, r: &UpdateRequest) -> Result<UpdateOutcome, AppError> {
    if let Some(p) = request_problem(r) {
        return Err(other(p));
    }
    let c = client(conn);
    // UpdateStateMachine has no condition: look first, so a change made
    // meanwhile (console, deploy) isn't overwritten without asking.
    if !r.overwrite {
        let now = c
            .describe_state_machine()
            .state_machine_arn(&r.arn)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        if r.expected_revision.is_some() && now.revision_id() != r.expected_revision.as_deref() {
            return Ok(UpdateOutcome::Changed {
                current_revision: now.revision_id().map(String::from),
                updated: crate::sfn::iso(Some(now.creation_date())),
            });
        }
    }
    let mut req = c
        .update_state_machine()
        .state_machine_arn(&r.arn)
        .set_definition(r.definition.clone())
        .set_role_arn(r.role_arn.clone())
        .set_logging_configuration(r.logging.as_ref().map(logging_config))
        .set_tracing_configuration(
            r.tracing
                .map(|t| TracingConfiguration::builder().enabled(t).build()),
        );
    if r.publish {
        req = req.publish(true).set_version_description(
            r.version_description
                .clone()
                .filter(|d| !d.trim().is_empty()),
        );
    }
    let out = req.send().await.map_err(|e| err(conn, e))?;
    Ok(UpdateOutcome::Saved {
        revision_id: out.revision_id().map(String::from),
        version_arn: out.state_machine_version_arn().map(String::from),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> UpdateRequest {
        UpdateRequest {
            arn: "arn:aws:states:r:1:stateMachine:m".into(),
            expected_revision: None,
            overwrite: false,
            definition: None,
            role_arn: None,
            logging: None,
            tracing: None,
            publish: false,
            version_description: None,
        }
    }

    #[test]
    fn finds_the_state_a_diagnostic_points_at() {
        assert_eq!(state_of("/States/Charge/Next").as_deref(), Some("Charge"));
        assert_eq!(
            state_of("/States/Fan/ItemProcessor/States/Check/Choices/0").as_deref(),
            Some("Check")
        );
        assert_eq!(state_of("/States/a~1b/Type").as_deref(), Some("a/b"));
        assert_eq!(state_of("/StartAt"), None);
        assert_eq!(state_of(""), None);
    }

    #[test]
    fn checks_requests() {
        assert_eq!(
            request_problem(&req()).as_deref(),
            Some("Nothing to change")
        );
        assert!(request_problem(&UpdateRequest {
            definition: Some("{".into()),
            ..req()
        })
        .unwrap()
        .contains("JSON"));
        assert_eq!(
            request_problem(&UpdateRequest {
                definition: Some("{}".into()),
                ..req()
            }),
            None
        );
        assert!(request_problem(&UpdateRequest {
            role_arn: Some("my-role".into()),
            ..req()
        })
        .is_some());
        assert_eq!(
            request_problem(&UpdateRequest {
                role_arn: Some("arn:aws:iam::1:role/r".into()),
                ..req()
            }),
            None
        );
        let no_group = LoggingChange {
            level: "ALL".into(),
            include_execution_data: true,
            log_group_arn: None,
        };
        assert!(request_problem(&UpdateRequest {
            logging: Some(no_group),
            ..req()
        })
        .unwrap()
        .contains("log group"));
        let off = LoggingChange {
            level: "OFF".into(),
            include_execution_data: false,
            log_group_arn: None,
        };
        assert_eq!(
            request_problem(&UpdateRequest {
                logging: Some(off),
                ..req()
            }),
            None
        );
        assert_eq!(
            request_problem(&UpdateRequest {
                publish: true,
                ..req()
            }),
            None
        );
        assert!(request_problem(&UpdateRequest {
            publish: true,
            version_description: Some("x".repeat(257)),
            ..req()
        })
        .is_some());
    }

    #[test]
    fn outcomes_serialise_for_the_ui() {
        let saved = serde_json::to_value(UpdateOutcome::Saved {
            revision_id: Some("r2".into()),
            version_arn: None,
        })
        .unwrap();
        assert_eq!(
            saved,
            serde_json::json!({"outcome": "saved", "revisionId": "r2", "versionArn": null})
        );
        let changed = serde_json::to_value(UpdateOutcome::Changed {
            current_revision: None,
            updated: None,
        })
        .unwrap();
        assert_eq!(changed["outcome"], "changed");
        assert!(changed.get("currentRevision").is_some());
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::sfn::emulator_tests::{connect, fresh_machine};

    #[tokio::test]
    #[ignore]
    async fn updates_with_a_conflict_check() {
        let conn = connect().await;
        let arn = fresh_machine(&conn, "s3x-sfn-edit").await;
        let before = crate::sfn::describe(&conn, &arn).await.unwrap();
        let v = validate(&conn, &before.definition, "STANDARD")
            .await
            .unwrap();
        assert_eq!(v.result, "OK");

        let new_def = r#"{"StartAt":"Two","States":{"Two":{"Type":"Pass","End":true}}}"#;
        let saved = update(
            &conn,
            &UpdateRequest {
                arn: arn.clone(),
                expected_revision: before.revision_id.clone(),
                overwrite: false,
                definition: Some(new_def.into()),
                role_arn: None,
                logging: None,
                tracing: Some(true),
                publish: true,
                version_description: Some("first".into()),
            },
        )
        .await
        .unwrap();
        let UpdateOutcome::Saved { version_arn, .. } = saved else {
            panic!("not saved: {saved:?}")
        };
        assert!(version_arn.unwrap_or_default().ends_with(":1"));
        let after = crate::sfn::describe(&conn, &arn).await.unwrap();
        assert!(after.definition.contains("\"Two\""));
        assert!(after.tracing);

        // The editor still holds the old revision: the next save is a conflict, unless overwriting.
        if before.revision_id.is_some() && before.revision_id != after.revision_id {
            let stale = UpdateRequest {
                arn: arn.clone(),
                expected_revision: before.revision_id.clone(),
                overwrite: false,
                definition: Some(crate::sfn::emulator_tests::PASS_DEFINITION.into()),
                role_arn: None,
                logging: None,
                tracing: None,
                publish: false,
                version_description: None,
            };
            assert!(matches!(
                update(&conn, &stale).await.unwrap(),
                UpdateOutcome::Changed { .. }
            ));
            assert!(crate::sfn::describe(&conn, &arn)
                .await
                .unwrap()
                .definition
                .contains("\"Two\""));
            let forced = UpdateRequest {
                overwrite: true,
                ..stale
            };
            assert!(matches!(
                update(&conn, &forced).await.unwrap(),
                UpdateOutcome::Saved { .. }
            ));
            assert!(crate::sfn::describe(&conn, &arn)
                .await
                .unwrap()
                .definition
                .contains("\"Hello\""));
        }
    }
}
