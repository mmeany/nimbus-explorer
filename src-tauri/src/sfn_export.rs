//! Step Functions exports: a machine's (or a map run's) executions, or one
//! execution's event history, to JSON lines or CSV. Written page by page to
//! `<dest>.s3x-part`, renamed when complete (a local write, so allowed in
//! read-only mode).

use crate::error::AppError;
use crate::s3::Connection;
use crate::sfn::{self, other, ExecutionSummary};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    Jsonl,
    Csv,
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn csv_row(fields: &[&str]) -> String {
    let mut line = fields
        .iter()
        .map(|f| csv_field(f))
        .collect::<Vec<_>>()
        .join(",");
    line.push_str("\r\n");
    line
}

const EXECUTION_HEADER: &[&str] = &[
    "name",
    "status",
    "start",
    "stop",
    "version",
    "alias",
    "redrive_count",
    "map_run_arn",
    "arn",
];
const HISTORY_HEADER: &[&str] = &[
    "id",
    "previous_event_id",
    "timestamp",
    "type",
    "state",
    "details",
];

fn tail(arn: &Option<String>) -> String {
    arn.as_deref()
        .map(|a| a.rsplit(':').next().unwrap_or(a).to_string())
        .unwrap_or_default()
}

fn execution_line(e: &ExecutionSummary, format: Format) -> String {
    match format {
        Format::Jsonl => format!("{}\n", serde_json::to_string(e).unwrap_or_default()),
        Format::Csv => csv_row(&[
            &e.name,
            &e.status,
            e.start.as_deref().unwrap_or(""),
            e.stop.as_deref().unwrap_or(""),
            &tail(&e.version_arn),
            &tail(&e.alias_arn),
            &e.redrive_count.map(|n| n.to_string()).unwrap_or_default(),
            e.map_run_arn.as_deref().unwrap_or(""),
            &e.arn,
        ]),
    }
}

/// One event: JSON lines keep it as AWS sent it; CSV gives the common fields
/// plus the `…EventDetails` object as JSON.
fn history_line(ev: &Value, format: Format) -> String {
    match format {
        Format::Jsonl => format!("{}\n", serde_json::to_string(ev).unwrap_or_default()),
        Format::Csv => {
            let details = ev.as_object().and_then(|o| {
                o.iter()
                    .find(|(k, _)| k.ends_with("EventDetails"))
                    .map(|(_, v)| v.clone())
            });
            let state = details
                .as_ref()
                .and_then(|d| d.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let num = |k: &str| {
                ev.get(k)
                    .and_then(|v| v.as_i64())
                    .map(|n| n.to_string())
                    .unwrap_or_default()
            };
            csv_row(&[
                &num("id"),
                &num("previousEventId"),
                ev.get("timestamp").and_then(|v| v.as_str()).unwrap_or(""),
                ev.get("type").and_then(|v| v.as_str()).unwrap_or(""),
                &state,
                &details.map(|d| d.to_string()).unwrap_or_default(),
            ])
        }
    }
}

/// A file being written: `<dest>.s3x-part`, renamed on `finish`, removed if dropped unfinished.
struct PartFile {
    dest: String,
    part: String,
    file: Option<tokio::io::BufWriter<tokio::fs::File>>,
}

impl PartFile {
    async fn create(dest: &str) -> Result<Self, AppError> {
        let part = format!("{dest}.s3x-part");
        let file = tokio::fs::File::create(&part)
            .await
            .map_err(|e| other(format!("Couldn't create {part}: {e}")))?;
        Ok(Self {
            dest: dest.to_string(),
            part,
            file: Some(tokio::io::BufWriter::new(file)),
        })
    }

    async fn write(&mut self, text: &str) -> Result<(), AppError> {
        let f = self.file.as_mut().expect("open");
        f.write_all(text.as_bytes())
            .await
            .map_err(|e| other(format!("Couldn't write {}: {e}", self.dest)))
    }

    async fn finish(mut self) -> Result<(), AppError> {
        let mut f = self.file.take().expect("open");
        f.flush()
            .await
            .map_err(|e| other(format!("Couldn't write {}: {e}", self.dest)))?;
        drop(f);
        tokio::fs::rename(&self.part, &self.dest)
            .await
            .map_err(|e| other(format!("Couldn't save {}: {e}", self.dest)))
    }
}

impl Drop for PartFile {
    fn drop(&mut self) {
        if self.file.take().is_some() {
            let _ = std::fs::remove_file(&self.part);
        }
    }
}

/// Every execution of a machine or map run (newest first, optional status
/// filter) to `dest`. Returns how many were written.
pub async fn export_executions(
    conn: &Connection,
    source_arn: &str,
    status: Option<&str>,
    format: Format,
    dest: &str,
) -> Result<usize, AppError> {
    let mut out = PartFile::create(dest).await?;
    if format == Format::Csv {
        out.write(&csv_row(EXECUTION_HEADER)).await?;
    }
    let mut count = 0;
    let mut token: Option<String> = None;
    loop {
        let page = sfn::executions(conn, source_arn, status, token.take(), 1000).await?;
        let mut text = String::new();
        for e in &page.items {
            text.push_str(&execution_line(e, format));
        }
        out.write(&text).await?;
        count += page.items.len();
        match page.next_token {
            Some(t) => token = Some(t),
            None => break,
        }
    }
    out.finish().await?;
    Ok(count)
}

/// Every event of an execution (oldest first) to `dest`. Returns how many were written.
pub async fn export_history(
    conn: &Connection,
    arn: &str,
    format: Format,
    dest: &str,
) -> Result<usize, AppError> {
    let mut out = PartFile::create(dest).await?;
    if format == Format::Csv {
        out.write(&csv_row(HISTORY_HEADER)).await?;
    }
    let mut count = 0;
    let mut token: Option<String> = None;
    loop {
        let page = sfn::history(conn, arn, token.take(), 1000).await?;
        let mut text = String::new();
        for ev in &page.events {
            text.push_str(&history_line(ev, format));
        }
        out.write(&text).await?;
        count += page.events.len();
        match page.next_token {
            Some(t) => token = Some(t),
            None => break,
        }
    }
    out.finish().await?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_csv_and_json_lines() {
        let e = ExecutionSummary {
            name: "run, 1".into(),
            arn: "arn:aws:states:r:1:execution:m:run".into(),
            status: "SUCCEEDED".into(),
            start: Some("2026-01-01T00:00:00Z".into()),
            version_arn: Some("arn:aws:states:r:1:stateMachine:m:3".into()),
            ..Default::default()
        };
        assert_eq!(execution_line(&e, Format::Csv), "\"run, 1\",SUCCEEDED,2026-01-01T00:00:00Z,,3,,,,arn:aws:states:r:1:execution:m:run\r\n");
        let j: Value = serde_json::from_str(execution_line(&e, Format::Jsonl).trim_end()).unwrap();
        assert_eq!(j["name"], "run, 1");
        assert_eq!(j["versionArn"], "arn:aws:states:r:1:stateMachine:m:3");

        let ev = json!({"id": 2, "previousEventId": 1, "timestamp": "2026-01-01T00:00:01Z", "type": "PassStateEntered", "stateEnteredEventDetails": {"name": "A", "input": "{\"x\":1}"}});
        assert_eq!(
            history_line(&ev, Format::Csv),
            "2,1,2026-01-01T00:00:01Z,PassStateEntered,A,\"{\"\"name\"\":\"\"A\"\",\"\"input\"\":\"\"{\\\"\"x\\\"\":1}\"\"}\"\r\n"
        );
        assert_eq!(
            history_line(&json!({"id": 1, "type": "ExecutionStarted"}), Format::Csv),
            "1,,,ExecutionStarted,,\r\n"
        );
        assert_eq!(history_line(&ev, Format::Jsonl).trim_end(), ev.to_string());
    }

    #[tokio::test]
    async fn part_files_are_removed_when_unfinished() {
        let dir = std::env::temp_dir().join(format!("s3x-sfn-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("out.csv").to_string_lossy().into_owned();
        {
            let mut f = PartFile::create(&dest).await.unwrap();
            f.write("partial").await.unwrap();
        }
        assert!(!std::path::Path::new(&format!("{dest}.s3x-part")).exists());
        assert!(!std::path::Path::new(&dest).exists());
        let mut f = PartFile::create(&dest).await.unwrap();
        f.write("done").await.unwrap();
        f.finish().await.unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "done");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::sfn::emulator_tests::{connect, fresh_machine};

    #[tokio::test]
    #[ignore]
    async fn exports_executions_and_history() {
        let conn = connect().await;
        let arn = fresh_machine(&conn, "s3x-sfn-export").await;
        let c = sfn::client(&conn);
        let exec = c
            .start_execution()
            .state_machine_arn(&arn)
            .name("exp-1")
            .input("{}")
            .send()
            .await
            .unwrap()
            .execution_arn()
            .to_string();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let dir = std::env::temp_dir().join(format!("s3x-sfn-export-emu-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let csv = dir.join("executions.csv").to_string_lossy().into_owned();
        assert_eq!(
            export_executions(&conn, &arn, None, Format::Csv, &csv)
                .await
                .unwrap(),
            1
        );
        let text = std::fs::read_to_string(&csv).unwrap();
        assert!(text.starts_with("name,status,"));
        assert!(text.contains("exp-1,"));
        let jsonl = dir.join("history.jsonl").to_string_lossy().into_owned();
        let n = export_history(&conn, &exec, Format::Jsonl, &jsonl)
            .await
            .unwrap();
        let lines: Vec<Value> = std::fs::read_to_string(&jsonl)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), n);
        assert_eq!(lines[0]["type"], "ExecutionStarted");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
