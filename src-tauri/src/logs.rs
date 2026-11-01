//! CloudWatch Logs: log groups, streams and events (read only; downloads
//! write local files only).

use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use aws_sdk_cloudwatchlogs::types::OrderBy;
use aws_sdk_cloudwatchlogs::Client;
use serde::{Deserialize, Serialize};

/// DescribeLogGroups / DescribeLogStreams return at most 50 per call.
const DESCRIBE_LIMIT: i32 = 50;

pub fn client(conn: &Connection) -> Client {
    Client::new(&conn.service_config())
}

fn err(conn: &Connection, e: impl std::error::Error) -> AppError {
    AppError::from_sdk(e, &conn.info.profile, conn.info.endpoint_url.as_deref())
}

fn other(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Other, msg)
}

/// Milliseconds since 1970 → ISO 8601 (UTC).
pub fn iso_ms(ms: Option<i64>) -> Option<String> {
    ms.and_then(|m| {
        aws_smithy_types::DateTime::from_millis(m)
            .fmt(aws_smithy_types::date_time::Format::DateTime)
            .ok()
    })
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogGroup {
    pub name: String,
    pub arn: Option<String>,
    pub stored_bytes: Option<i64>,
    pub retention_days: Option<i32>,
    pub created: Option<String>,
    pub kms_key: Option<String>,
    /// STANDARD or INFREQUENT_ACCESS.
    pub class: Option<String>,
    pub metric_filters: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GroupPage {
    pub groups: Vec<LogGroup>,
    pub next_token: Option<String>,
}

fn to_group(g: &aws_sdk_cloudwatchlogs::types::LogGroup) -> LogGroup {
    LogGroup {
        name: g.log_group_name().unwrap_or_default().to_string(),
        arn: g.arn().map(|a| a.trim_end_matches(":*").to_string()),
        stored_bytes: g.stored_bytes(),
        retention_days: g.retention_in_days(),
        created: iso_ms(g.creation_time()),
        kms_key: g.kms_key_id().map(String::from),
        class: g.log_group_class().map(|c| c.as_str().to_string()),
        metric_filters: g.metric_filter_count(),
    }
}

/// One page (up to `page_size`) of log groups whose names begin with `prefix`.
pub async fn list_groups(
    conn: &Connection,
    prefix: &str,
    token: Option<String>,
    page_size: usize,
) -> Result<GroupPage, AppError> {
    let c = client(conn);
    let prefix = Some(prefix.trim())
        .filter(|p| !p.is_empty())
        .map(String::from);
    let mut out = GroupPage {
        groups: Vec::new(),
        next_token: token,
    };
    loop {
        let want = (page_size - out.groups.len()).min(DESCRIBE_LIMIT as usize) as i32;
        let page = c
            .describe_log_groups()
            .set_log_group_name_prefix(prefix.clone())
            .limit(want)
            .set_next_token(out.next_token.take())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.groups.extend(page.log_groups().iter().map(to_group));
        out.next_token = page
            .next_token()
            .map(String::from)
            .filter(|t| !t.is_empty());
        if out.next_token.is_none() || out.groups.len() >= page_size || page.log_groups().is_empty()
        {
            return Ok(out);
        }
    }
}

/// One log group by exact name.
pub async fn describe_group(conn: &Connection, name: &str) -> Result<LogGroup, AppError> {
    let c = client(conn);
    let mut token = None;
    for _ in 0..20 {
        let page = c
            .describe_log_groups()
            .log_group_name_prefix(name)
            .limit(DESCRIBE_LIMIT)
            .set_next_token(token)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        if let Some(g) = page
            .log_groups()
            .iter()
            .find(|g| g.log_group_name() == Some(name))
        {
            return Ok(to_group(g));
        }
        token = page.next_token().map(String::from);
        if token.is_none() {
            break;
        }
    }
    Err(other(format!(
        "Log group {name} doesn't exist in this region"
    )))
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogStream {
    pub name: String,
    pub created: Option<String>,
    pub first_event: Option<String>,
    pub last_event: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StreamPage {
    pub streams: Vec<LogStream>,
    pub next_token: Option<String>,
}

/// One page of a group's streams: most recent activity first, or (with a
/// `prefix`, which AWS can't combine with that order) by name.
pub async fn list_streams(
    conn: &Connection,
    group: &str,
    prefix: &str,
    token: Option<String>,
    page_size: usize,
) -> Result<StreamPage, AppError> {
    let c = client(conn);
    let prefix = Some(prefix.trim())
        .filter(|p| !p.is_empty())
        .map(String::from);
    let mut out = StreamPage {
        streams: Vec::new(),
        next_token: token,
    };
    loop {
        let want = (page_size - out.streams.len()).min(DESCRIBE_LIMIT as usize) as i32;
        let mut req = c
            .describe_log_streams()
            .log_group_name(group)
            .limit(want)
            .set_next_token(out.next_token.take());
        req = match &prefix {
            Some(p) => req.log_stream_name_prefix(p),
            None => req.order_by(OrderBy::LastEventTime).descending(true),
        };
        let page = req.send().await.map_err(|e| err(conn, e))?;
        out.streams
            .extend(page.log_streams().iter().map(|s| LogStream {
                name: s.log_stream_name().unwrap_or_default().to_string(),
                created: iso_ms(s.creation_time()),
                first_event: iso_ms(s.first_event_timestamp()),
                last_event: iso_ms(s.last_event_timestamp()),
            }));
        out.next_token = page
            .next_token()
            .map(String::from)
            .filter(|t| !t.is_empty());
        if out.next_token.is_none()
            || out.streams.len() >= page_size
            || page.log_streams().is_empty()
        {
            return Ok(out);
        }
    }
}

/// What to search: a group, optionally narrowed to streams, a filter pattern
/// (CloudWatch syntax) and a time range.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EventsRequest {
    pub group: String,
    /// Exact stream names (at most 100); empty = every stream.
    #[serde(default)]
    pub streams: Vec<String>,
    /// Streams whose names begin with this (ignored when `streams` is set).
    pub stream_prefix: Option<String>,
    pub pattern: Option<String>,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
    /// Stop once this many events are collected (the token continues).
    pub max_events: usize,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub id: String,
    /// Milliseconds since 1970.
    pub time: i64,
    pub stream: String,
    pub message: String,
}

pub fn request_problem(r: &EventsRequest) -> Option<String> {
    if r.group.trim().is_empty() {
        return Some("Choose a log group".into());
    }
    if r.streams.len() > 100 {
        return Some("At most 100 streams can be searched at once".into());
    }
    if let Some(end) = r.end_ms {
        if end < r.start_ms {
            return Some("The end of the range is before its start".into());
        }
    }
    None
}

async fn filter_page(
    c: &Client,
    conn: &Connection,
    r: &EventsRequest,
    token: Option<String>,
    limit: i32,
) -> Result<(Vec<LogEvent>, Option<String>), AppError> {
    let mut req = c
        .filter_log_events()
        .log_group_name(&r.group)
        .start_time(r.start_ms)
        .set_end_time(r.end_ms)
        .set_filter_pattern(r.pattern.clone().filter(|p| !p.trim().is_empty()))
        .limit(limit)
        .set_next_token(token);
    if !r.streams.is_empty() {
        req = req.set_log_stream_names(Some(r.streams.clone()));
    } else if let Some(p) = r.stream_prefix.as_ref().filter(|p| !p.is_empty()) {
        req = req.log_stream_name_prefix(p);
    }
    let out = req.send().await.map_err(|e| err(conn, e))?;
    let events = out
        .events()
        .iter()
        .map(|e| LogEvent {
            id: e.event_id().unwrap_or_default().to_string(),
            time: e.timestamp().unwrap_or(0),
            stream: e.log_stream_name().unwrap_or_default().to_string(),
            message: e
                .message()
                .unwrap_or_default()
                .trim_end_matches(['\n', '\r'])
                .to_string(),
        })
        .collect();
    Ok((
        events,
        out.next_token().map(String::from).filter(|t| !t.is_empty()),
    ))
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LatestPage {
    /// Oldest first.
    pub events: Vec<LogEvent>,
    /// Older events may exist up to this time (ms, inclusive): search again
    /// with this as `end_ms` for the next ones. None = the range start was reached.
    pub older_end: Option<i64>,
}

/// Most events one time window may hold before it's split.
const WINDOW_CAP: usize = 10_000;
/// FilterLogEvents calls one `latest` request may make in total.
const MAX_LATEST_CALLS: usize = 40;

/// Every event in [lo, hi] up to WINDOW_CAP; `true` if the window had more.
async fn window(
    c: &Client,
    conn: &Connection,
    r: &EventsRequest,
    lo: i64,
    hi: i64,
    calls: &mut usize,
) -> Result<(Vec<LogEvent>, bool), AppError> {
    let w = EventsRequest {
        start_ms: lo,
        end_ms: Some(hi),
        ..r.clone()
    };
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        *calls += 1;
        let (evs, next) =
            filter_page(c, conn, &w, token.clone(), (WINDOW_CAP - out.len()) as i32).await?;
        out.extend(evs);
        match next {
            Some(n) if Some(&n) != token.as_ref() => {
                if out.len() >= WINDOW_CAP {
                    return Ok((out, true));
                }
                if *calls >= MAX_LATEST_CALLS {
                    return Ok((out, true));
                }
                token = Some(n);
            }
            _ => return Ok((out, false)),
        }
    }
}

/// The newest `max_events` events in [start_ms, end_ms] (end defaults to
/// now): searches backwards from the end in windows that start at a minute
/// and grow fourfold while they're sparse (a window that overflows is cut to
/// a quarter and searched again).
pub async fn latest(
    conn: &Connection,
    r: &EventsRequest,
    now_ms: i64,
) -> Result<LatestPage, AppError> {
    if let Some(p) = request_problem(r) {
        return Err(other(p));
    }
    let c = client(conn);
    let max = r.max_events.clamp(1, 10_000);
    let start = r.start_ms;
    let mut hi = r.end_ms.unwrap_or(now_ms);
    let mut width: i64 = 60_000;
    let mut found: Vec<LogEvent> = Vec::new();
    let mut calls = 0usize;
    while hi >= start && found.len() < max && calls < MAX_LATEST_CALLS {
        let lo = (hi - width + 1).max(start);
        let (evs, overflow) = window(&c, conn, r, lo, hi, &mut calls).await?;
        if overflow && width > 1_000 {
            width = (width / 4).max(1_000);
            continue;
        }
        // Older window goes in front: `found` stays oldest first.
        let mut evs = evs;
        evs.extend(found);
        found = evs;
        hi = lo - 1;
        if found.len() < max / 4 {
            width = width.saturating_mul(4);
        }
    }
    let mut older_end = if hi >= start { Some(hi) } else { None };
    if found.len() > max {
        // Cut at the oldest event kept. Events sharing its millisecond may
        // fall either side of the cut, so keep only newer ones and let the
        // next "older" search (end inclusive) return that millisecond whole.
        let boundary = found[found.len() - max].time;
        let kept: Vec<LogEvent> = found
            .iter()
            .filter(|e| e.time > boundary)
            .cloned()
            .collect();
        if kept.is_empty() {
            // More than `max` events in one millisecond: show them all.
            let n = found.len() - max;
            found.drain(..n);
            older_end = Some(boundary - 1).filter(|t| *t >= start);
        } else {
            found = kept;
            older_end = Some(boundary);
        }
    }
    Ok(LatestPage {
        events: found,
        older_end,
    })
}

fn line(e: &LogEvent, with_stream: bool) -> String {
    let when = iso_ms(Some(e.time)).unwrap_or_default();
    if with_stream {
        format!("{when}\t{}\t{}\n", e.stream, e.message)
    } else {
        format!("{when}\t{}\n", e.message)
    }
}

/// Saves every matching event (oldest first) to `dest` as text lines
/// ("time<TAB>stream<TAB>message"; no stream column for one stream).
/// Written to a `.s3x-part` file, renamed when complete. Returns the count.
pub async fn download(conn: &Connection, r: &EventsRequest, dest: &str) -> Result<u64, AppError> {
    use tokio::io::AsyncWriteExt;
    if let Some(p) = request_problem(r) {
        return Err(other(p));
    }
    let c = client(conn);
    let with_stream = r.streams.len() != 1;
    let part = format!("{dest}.s3x-part");
    let mut f = tokio::fs::File::create(&part)
        .await
        .map_err(|e| other(format!("Couldn't create {dest}: {e}")))?;
    let mut count = 0u64;
    let result: Result<(), AppError> = async {
        let mut token: Option<String> = None;
        loop {
            let (evs, next) = filter_page(&c, conn, r, token.clone(), 10_000).await?;
            let mut buf = String::new();
            for e in &evs {
                buf.push_str(&line(e, with_stream));
            }
            f.write_all(buf.as_bytes())
                .await
                .map_err(|e| other(format!("Couldn't write {dest}: {e}")))?;
            count += evs.len() as u64;
            match next {
                Some(n) if Some(&n) != token.as_ref() => token = Some(n),
                _ => return Ok(()),
            }
        }
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
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_requests() {
        let ok = EventsRequest {
            group: "/aws/lambda/f".into(),
            start_ms: 10,
            end_ms: Some(20),
            max_events: 10,
            ..Default::default()
        };
        assert!(request_problem(&ok).is_none());
        assert!(request_problem(&EventsRequest {
            group: " ".into(),
            ..ok.clone()
        })
        .is_some());
        assert!(request_problem(&EventsRequest {
            end_ms: Some(5),
            ..ok.clone()
        })
        .is_some());
        assert!(request_problem(&EventsRequest {
            streams: vec!["s".into(); 101],
            ..ok
        })
        .is_some());
    }

    #[test]
    fn formats_lines() {
        let e = LogEvent {
            id: "1".into(),
            time: 0,
            stream: "s1".into(),
            message: "hello".into(),
        };
        assert_eq!(line(&e, true), "1970-01-01T00:00:00Z\ts1\thello\n");
        assert_eq!(line(&e, false), "1970-01-01T00:00:00Z\thello\n");
    }
}

#[cfg(test)]
pub(crate) mod emulator_tests {
    use super::*;

    pub(crate) async fn connect() -> Connection {
        crate::sqs::emulator_tests::connect().await
    }

    /// A fresh group with two streams of events at fixed times (ms).
    pub(crate) async fn fixture(conn: &Connection, group: &str) -> i64 {
        let c = client(conn);
        let _ = c.delete_log_group().log_group_name(group).send().await;
        c.create_log_group()
            .log_group_name(group)
            .send()
            .await
            .unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
            - 60_000;
        for (stream, n) in [("app/a", 3), ("app/b", 2)] {
            c.create_log_stream()
                .log_group_name(group)
                .log_stream_name(stream)
                .send()
                .await
                .unwrap();
            let evs: Vec<_> = (0..n)
                .map(|i| {
                    aws_sdk_cloudwatchlogs::types::InputLogEvent::builder()
                        .timestamp(now + i * 1000)
                        .message(format!(
                            "{stream} event {i}{}",
                            if i == 1 { " ERROR boom" } else { "" }
                        ))
                        .build()
                        .unwrap()
                })
                .collect();
            c.put_log_events()
                .log_group_name(group)
                .log_stream_name(stream)
                .set_log_events(Some(evs))
                .send()
                .await
                .unwrap();
        }
        now
    }

    #[tokio::test]
    #[ignore]
    async fn lists_and_searches() {
        let conn = connect().await;
        let now = fixture(&conn, "/s3x/logs/app").await;
        let groups = list_groups(&conn, "/s3x/logs/", None, 100).await.unwrap();
        assert!(groups.groups.iter().any(|g| g.name == "/s3x/logs/app"));
        assert_eq!(
            describe_group(&conn, "/s3x/logs/app").await.unwrap().name,
            "/s3x/logs/app"
        );
        assert!(describe_group(&conn, "/s3x/logs/nope").await.is_err());

        let streams = list_streams(&conn, "/s3x/logs/app", "", None, 100)
            .await
            .unwrap();
        let mut names: Vec<_> = streams.streams.iter().map(|s| s.name.clone()).collect();
        names.sort();
        assert_eq!(names, ["app/a", "app/b"]);
        assert_eq!(
            list_streams(&conn, "/s3x/logs/app", "app/b", None, 100)
                .await
                .unwrap()
                .streams
                .len(),
            1
        );

        let base = EventsRequest {
            group: "/s3x/logs/app".into(),
            start_ms: now - 1000,
            max_events: 100,
            ..Default::default()
        };
        let all = latest(&conn, &base, now + 600_000).await.unwrap();
        assert_eq!(all.events.len(), 5);
        let one = latest(
            &conn,
            &EventsRequest {
                streams: vec!["app/a".into()],
                ..base.clone()
            },
            now + 600_000,
        )
        .await
        .unwrap();
        assert_eq!(one.events.len(), 3);
        assert!(one.events.windows(2).all(|w| w[0].time <= w[1].time));
        let errors = latest(
            &conn,
            &EventsRequest {
                pattern: Some("ERROR".into()),
                ..base.clone()
            },
            now + 600_000,
        )
        .await
        .unwrap();
        assert_eq!(errors.events.len(), 2);

        let dir = std::env::temp_dir().join("s3x-logs-test");
        let _ = std::fs::create_dir_all(&dir);
        let dest = dir.join("a.log");
        let n = download(
            &conn,
            &EventsRequest {
                streams: vec!["app/a".into()],
                ..base
            },
            dest.to_str().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(n, 3);
        let text = std::fs::read_to_string(&dest).unwrap();
        assert_eq!(text.lines().count(), 3);
        assert!(text.lines().next().unwrap().ends_with("\tapp/a event 0"));
    }
}
