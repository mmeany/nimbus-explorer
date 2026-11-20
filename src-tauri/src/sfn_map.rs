//! Step Functions: Distributed Map runs (the child workflows a distributed
//! Map state starts) and their settings.

use crate::error::AppError;
use crate::s3::Connection;
use crate::sfn::{client, err, iso, other};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MapRunRef {
    pub arn: String,
    /// The Map state's Label ("Fan" in "…:mapRun:orders/Fan:uuid"); without a
    /// Label, AWS puts a generated id here, not the state name.
    pub label: String,
    /// "Fan:uuid": how a place names the run (and its child executions' prefix).
    pub id: String,
    pub start: Option<String>,
    pub stop: Option<String>,
}

/// "arn:…:mapRun:orders/Fan:3526…" → ("Fan", "Fan:3526…").
pub fn map_run_id(arn: &str) -> (String, String) {
    let tail = arn.split_once(":mapRun:").map(|(_, t)| t).unwrap_or(arn);
    let id = tail.split_once('/').map(|(_, r)| r).unwrap_or(tail);
    let label = id.rsplit_once(':').map(|(l, _)| l).unwrap_or(id);
    (label.to_string(), id.to_string())
}

/// Every map run of an execution (one per distributed Map state that ran, per redrive).
pub async fn list(conn: &Connection, execution_arn: &str) -> Result<Vec<MapRunRef>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .list_map_runs()
            .execution_arn(execution_arn)
            .max_results(1000)
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.map_runs().iter().map(|m| {
            let (label, id) = map_run_id(m.map_run_arn());
            MapRunRef {
                arn: m.map_run_arn().to_string(),
                label,
                id,
                start: iso(Some(m.start_date())),
                stop: iso(m.stop_date()),
            }
        }));
        match page.next_token() {
            Some(t) if !t.is_empty() && Some(t) != token.as_deref() => token = Some(t.to_string()),
            _ => break,
        }
    }
    out.sort_by(|a, b| a.start.cmp(&b.start));
    Ok(out)
}

/// Item or child-execution counts of a map run.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub pending: i64,
    pub running: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub timed_out: i64,
    pub aborted: i64,
    pub total: i64,
    pub results_written: i64,
    pub failures_not_redrivable: Option<i64>,
    pub pending_redrive: Option<i64>,
}

/// The two count types have the same fields but no shared trait.
macro_rules! counts {
    ($c:expr) => {
        Counts {
            pending: $c.pending(),
            running: $c.running(),
            succeeded: $c.succeeded(),
            failed: $c.failed(),
            timed_out: $c.timed_out(),
            aborted: $c.aborted(),
            total: $c.total(),
            results_written: $c.results_written(),
            failures_not_redrivable: $c.failures_not_redrivable(),
            pending_redrive: $c.pending_redrive(),
        }
    };
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MapRunDetails {
    #[serde(flatten)]
    pub run: MapRunRef,
    pub execution_arn: String,
    /// RUNNING, SUCCEEDED, FAILED or ABORTED.
    pub status: String,
    /// 0 = as many as possible (up to 10,000).
    pub max_concurrency: i32,
    pub tolerated_failure_percentage: f32,
    pub tolerated_failure_count: i64,
    pub items: Counts,
    pub executions: Counts,
    pub redrive_count: Option<i32>,
    pub redrive_date: Option<String>,
}

pub async fn describe(conn: &Connection, arn: &str) -> Result<MapRunDetails, AppError> {
    let o = client(conn)
        .describe_map_run()
        .map_run_arn(arn)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let (label, id) = map_run_id(o.map_run_arn());
    Ok(MapRunDetails {
        run: MapRunRef {
            arn: o.map_run_arn().to_string(),
            label,
            id,
            start: iso(Some(o.start_date())),
            stop: iso(o.stop_date()),
        },
        execution_arn: o.execution_arn().to_string(),
        status: o.status().as_str().to_string(),
        max_concurrency: o.max_concurrency(),
        tolerated_failure_percentage: o.tolerated_failure_percentage(),
        tolerated_failure_count: o.tolerated_failure_count(),
        items: o.item_counts().map(|c| counts!(c)).unwrap_or_default(),
        executions: o.execution_counts().map(|c| counts!(c)).unwrap_or_default(),
        redrive_count: o.redrive_count(),
        redrive_date: iso(o.redrive_date()),
    })
}

/// New settings for a running map run; fields left None stay as they are.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MapRunChange {
    pub max_concurrency: Option<i32>,
    pub tolerated_failure_percentage: Option<f32>,
    pub tolerated_failure_count: Option<i64>,
}

/// Why AWS would refuse the change, if it would.
pub fn change_problem(c: &MapRunChange) -> Option<String> {
    if c.max_concurrency.is_none()
        && c.tolerated_failure_percentage.is_none()
        && c.tolerated_failure_count.is_none()
    {
        return Some("Nothing to change".into());
    }
    if c.max_concurrency
        .is_some_and(|n| !(0..=10_000).contains(&n))
    {
        return Some("Maximum concurrency is 0 (no limit) to 10,000".into());
    }
    if c.tolerated_failure_percentage
        .is_some_and(|p| p.is_nan() || !(0.0..=100.0).contains(&p))
    {
        return Some("The tolerated failure percentage is 0 to 100".into());
    }
    if c.tolerated_failure_count.is_some_and(|n| n < 0) {
        return Some("The tolerated failure count can't be negative".into());
    }
    None
}

pub async fn update(conn: &Connection, arn: &str, c: &MapRunChange) -> Result<(), AppError> {
    if let Some(p) = change_problem(c) {
        return Err(other(p));
    }
    client(conn)
        .update_map_run()
        .map_run_arn(arn)
        .set_max_concurrency(c.max_concurrency)
        .set_tolerated_failure_percentage(c.tolerated_failure_percentage)
        .set_tolerated_failure_count(c.tolerated_failure_count)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_run_ids_from_arns() {
        assert_eq!(
            map_run_id("arn:aws:states:us-east-1:1:mapRun:orders/Fan:3526eafa-9ffc"),
            ("Fan".to_string(), "Fan:3526eafa-9ffc".to_string())
        );
        // Labels may contain spaces; machine names never contain a slash.
        assert_eq!(
            map_run_id("arn:aws:states:r:1:mapRun:m/Process items:u").0,
            "Process items"
        );
    }

    #[test]
    fn checks_changes() {
        assert!(change_problem(&MapRunChange::default()).is_some());
        let ok = MapRunChange {
            max_concurrency: Some(0),
            tolerated_failure_percentage: Some(12.5),
            tolerated_failure_count: Some(3),
        };
        assert_eq!(change_problem(&ok), None);
        let too_many = MapRunChange {
            max_concurrency: Some(10_001),
            ..Default::default()
        };
        assert!(change_problem(&too_many).is_some());
        let pct = MapRunChange {
            tolerated_failure_percentage: Some(101.0),
            ..Default::default()
        };
        assert!(change_problem(&pct).is_some());
        let neg = MapRunChange {
            tolerated_failure_count: Some(-1),
            ..Default::default()
        };
        assert!(change_problem(&neg).is_some());
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::sfn::emulator_tests::{connect, fresh_machine};

    const DMAP: &str = r#"{"StartAt":"Fan","States":{"Fan":{"Type":"Map","Label":"Fan","ItemsPath":"$.items","MaxConcurrency":2,"ToleratedFailurePercentage":50,
        "ItemProcessor":{"ProcessorConfig":{"Mode":"DISTRIBUTED","ExecutionType":"STANDARD"},"StartAt":"Check","States":{
        "Check":{"Type":"Choice","Choices":[{"Variable":"$.bad","BooleanEquals":true,"Next":"Boom"}],"Default":"Ok"},
        "Boom":{"Type":"Fail","Error":"Item.Bad"},"Ok":{"Type":"Pass","End":true}}},"End":true}}}"#;

    #[tokio::test]
    #[ignore]
    async fn lists_and_describes_map_runs() {
        let conn = connect().await;
        let c = client(&conn);
        let arn = fresh_machine(&conn, "s3x-sfn-dmap").await;
        c.update_state_machine()
            .state_machine_arn(&arn)
            .definition(DMAP)
            .send()
            .await
            .unwrap();
        let exec = c
            .start_execution()
            .state_machine_arn(&arn)
            .input(r#"{"items":[{"n":1},{"n":2,"bad":true},{"n":3}]}"#)
            .send()
            .await
            .unwrap()
            .execution_arn()
            .to_string();
        let mut runs = Vec::new();
        for _ in 0..20 {
            runs = list(&conn, &exec).await.unwrap();
            if !runs.is_empty() && runs[0].stop.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].label, "Fan");
        let d = describe(&conn, &runs[0].arn).await.unwrap();
        assert_eq!(d.execution_arn, exec);
        assert_eq!(d.max_concurrency, 2);
        assert_eq!(d.items.total, 3);
        assert_eq!(d.items.failed, 1);
        let children = crate::sfn::executions(&conn, &runs[0].arn, None, None, 100)
            .await
            .unwrap();
        assert_eq!(children.items.len(), 3);
        assert!(children
            .items
            .iter()
            .all(|e| e.arn.contains(":execution:s3x-sfn-dmap/Fan:")));
        let failed = crate::sfn::executions(&conn, &runs[0].arn, Some("FAILED"), None, 100)
            .await
            .unwrap();
        assert_eq!(failed.items.len(), 1);
        // A finished run can't be changed on AWS; the emulator may accept it. Either is fine here.
        let change = MapRunChange {
            max_concurrency: Some(5),
            ..Default::default()
        };
        let _ = update(&conn, &runs[0].arn, &change).await;
    }
}
