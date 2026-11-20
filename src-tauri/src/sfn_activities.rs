//! Step Functions activities: tasks that your own workers poll for
//! (GetActivityTask) and answer (SendTaskSuccess / SendTaskFailure).

use crate::error::AppError;
use crate::s3::Connection;
use crate::sfn::{client, err, iso, other, Encryption};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub name: String,
    pub arn: String,
    pub created: Option<String>,
    /// Only from `describe`.
    pub encryption: Option<Encryption>,
    pub tags: Vec<(String, String)>,
}

/// Every activity in the region (ListActivities, 1,000 per call), by name.
pub async fn list(conn: &Connection) -> Result<Vec<Activity>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .list_activities()
            .max_results(1000)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.activities().iter().map(|a| Activity {
            name: a.name().to_string(),
            arn: a.activity_arn().to_string(),
            created: iso(Some(a.creation_date())),
            ..Default::default()
        }));
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub async fn describe(conn: &Connection, arn: &str) -> Result<Activity, AppError> {
    let c = client(conn);
    let o = c
        .describe_activity()
        .activity_arn(arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let mut tags = Vec::new();
    // Not every emulator has tags; the details are still useful without them.
    if let Ok(t) = c.list_tags_for_resource().resource_arn(arn).send().await {
        tags = t
            .tags()
            .iter()
            .map(|t| {
                (
                    t.key().unwrap_or_default().to_string(),
                    t.value().unwrap_or_default().to_string(),
                )
            })
            .collect();
        tags.sort();
    }
    Ok(Activity {
        name: o.name().to_string(),
        arn: o.activity_arn().to_string(),
        created: iso(Some(o.creation_date())),
        encryption: o.encryption_configuration().map(|e| Encryption {
            kind: e.r#type().as_str().to_string(),
            kms_key_id: e.kms_key_id().map(String::from),
            reuse_period_secs: e.kms_data_key_reuse_period_seconds(),
        }),
        tags,
    })
}

/// Creates the activity (CreateActivity returns the existing one if the name is taken).
pub async fn create(conn: &Connection, name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if let Some(p) = crate::sfn_run::name_problem(name) {
        return Err(other(p.replace("Execution names", "Activity names")));
    }
    let out = client(conn)
        .create_activity()
        .name(name)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out.activity_arn().to_string())
}

pub async fn delete(conn: &Connection, arn: &str) -> Result<(), AppError> {
    client(conn)
        .delete_activity()
        .activity_arn(arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::sfn::emulator_tests::connect;

    #[tokio::test]
    #[ignore]
    async fn creates_lists_and_deletes_activities() {
        let conn = connect().await;
        assert!(create(&conn, "bad name")
            .await
            .unwrap_err()
            .message
            .contains("Activity names"));
        let arn = create(&conn, "s3x-sfn-activity").await.unwrap();
        assert!(arn.ends_with(":activity:s3x-sfn-activity"));
        let all = list(&conn).await.unwrap();
        assert!(all.iter().any(|a| a.arn == arn));
        let d = describe(&conn, &arn).await.unwrap();
        assert_eq!(d.name, "s3x-sfn-activity");
        assert!(d.created.is_some());
        delete(&conn, &arn).await.unwrap();
        assert!(!list(&conn).await.unwrap().iter().any(|a| a.arn == arn));
    }
}
