//! RDS events and database log files.

use crate::error::AppError;
use crate::rds::{client, err, iso, other};
use crate::s3::Connection;
use aws_sdk_rds::types::SourceType;
use serde::Serialize;

/// The most history DescribeEvents keeps (14 days), in minutes.
const MAX_MINUTES: i32 = 20_160;
/// Most lines one view of a log file shows.
const MAX_TAIL_LINES: i32 = 10_000;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RdsEvent {
    pub date: Option<String>,
    pub source: String,
    pub source_type: Option<String>,
    pub message: String,
    pub categories: Vec<String>,
}

/// Events for a cluster or instance over the last `minutes` (up to 14 days),
/// newest first. For a cluster, its instances' events are included.
pub async fn events(
    conn: &Connection,
    kind: &str,
    id: &str,
    members: &[String],
    minutes: i32,
) -> Result<Vec<RdsEvent>, AppError> {
    let minutes = minutes.clamp(1, MAX_MINUTES);
    let c = client(conn);
    let mut sources: Vec<(String, SourceType)> = vec![(
        id.to_string(),
        if kind == "cluster" {
            SourceType::DbCluster
        } else {
            SourceType::DbInstance
        },
    )];
    sources.extend(members.iter().map(|m| (m.clone(), SourceType::DbInstance)));
    let mut out = Vec::new();
    for (source, st) in sources {
        let mut marker: Option<String> = None;
        loop {
            let page = c
                .describe_events()
                .source_identifier(&source)
                .source_type(st.clone())
                .duration(minutes)
                .set_marker(marker.clone())
                .send()
                .await
                .map_err(|e| err(conn, e))?;
            out.extend(page.events().iter().map(|e| RdsEvent {
                date: iso(e.date()),
                source: e.source_identifier().unwrap_or_default().to_string(),
                source_type: e.source_type().map(|t| t.as_str().to_string()),
                message: e.message().unwrap_or_default().to_string(),
                categories: e.event_categories().to_vec(),
            }));
            match page.marker() {
                Some(m) if Some(m) != marker.as_deref() && !m.is_empty() => {
                    marker = Some(m.to_string())
                }
                _ => break,
            }
        }
    }
    out.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    pub name: String,
    pub size: i64,
    pub last_written: Option<String>,
}

pub async fn log_files(conn: &Connection, instance_id: &str) -> Result<Vec<LogFile>, AppError> {
    let c = client(conn);
    let mut out = Vec::new();
    let mut marker: Option<String> = None;
    loop {
        let page = c
            .describe_db_log_files()
            .db_instance_identifier(instance_id)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.extend(page.describe_db_log_files().iter().map(|f| LogFile {
            name: f.log_file_name().unwrap_or_default().to_string(),
            size: f.size().unwrap_or(0),
            last_written: f.last_written().map(|ms| {
                aws_smithy_types::DateTime::from_millis(ms)
                    .fmt(aws_smithy_types::date_time::Format::DateTime)
                    .unwrap_or_default()
            }),
        }));
        match page.marker() {
            Some(m) if Some(m) != marker.as_deref() && !m.is_empty() => {
                marker = Some(m.to_string())
            }
            _ => break,
        }
    }
    out.sort_by(|a, b| {
        b.last_written
            .cmp(&a.last_written)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogTail {
    pub text: String,
    /// More lines exist before the ones returned.
    pub truncated: bool,
}

/// The last `lines` lines of a log file.
pub async fn tail(
    conn: &Connection,
    instance_id: &str,
    file: &str,
    lines: i32,
) -> Result<LogTail, AppError> {
    let out = client(conn)
        .download_db_log_file_portion()
        .db_instance_identifier(instance_id)
        .log_file_name(file)
        .number_of_lines(lines.clamp(1, MAX_TAIL_LINES))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(LogTail {
        text: out.log_file_data().unwrap_or_default().to_string(),
        truncated: out.additional_data_pending().unwrap_or(false),
    })
}

/// Downloads a whole log file to `dest` (portion by portion, from the start);
/// returns the bytes written.
pub async fn download(
    conn: &Connection,
    instance_id: &str,
    file: &str,
    dest: &str,
) -> Result<u64, AppError> {
    use tokio::io::AsyncWriteExt;
    let c = client(conn);
    let part = format!("{dest}.s3x-part");
    let mut f = tokio::fs::File::create(&part)
        .await
        .map_err(|e| other(format!("Couldn't create {dest}: {e}")))?;
    let mut marker = "0".to_string();
    let mut written = 0u64;
    let result: Result<(), AppError> = async {
        for _ in 0..100_000 {
            let out = c
                .download_db_log_file_portion()
                .db_instance_identifier(instance_id)
                .log_file_name(file)
                .marker(&marker)
                .send()
                .await
                .map_err(|e| err(conn, e))?;
            if let Some(data) = out.log_file_data() {
                f.write_all(data.as_bytes())
                    .await
                    .map_err(|e| other(format!("Couldn't write {dest}: {e}")))?;
                written += data.len() as u64;
            }
            let next = out.marker().unwrap_or_default().to_string();
            if !out.additional_data_pending().unwrap_or(false) || next.is_empty() || next == marker
            {
                return Ok(());
            }
            marker = next;
        }
        Ok(())
    }
    .await;
    if let Err(e) = result {
        drop(f);
        let _ = tokio::fs::remove_file(&part).await;
        return Err(e);
    }
    f.flush().await.map_err(|e| other(e.to_string()))?;
    drop(f);
    tokio::fs::rename(&part, dest)
        .await
        .map_err(|e| other(format!("Couldn't save {dest}: {e}")))?;
    Ok(written)
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::rds::emulator_tests::{connect, fixtures};

    #[tokio::test]
    #[ignore]
    async fn events_and_logs() {
        let conn = connect().await;
        fixtures(&conn).await;
        // Events are supported by the emulator; log files may not be.
        let ev = events(&conn, "instance", "s3x-pg", &[], 60 * 24)
            .await
            .unwrap();
        assert!(ev.windows(2).all(|w| w[0].date >= w[1].date));
        let _ = events(
            &conn,
            "cluster",
            "s3x-aurora",
            &["s3x-aurora-1".to_string()],
            60,
        )
        .await
        .unwrap();
        if let Ok(files) = log_files(&conn, "s3x-pg").await {
            if let Some(f) = files.first() {
                let _ = tail(&conn, "s3x-pg", &f.name, 10).await;
            }
        }
    }
}
