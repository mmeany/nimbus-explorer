//! Uploads, downloads and S3-to-S3 copies/moves with progress events and cancellation.
//!
//! Each transfer runs as its own task; a semaphore limits how many run at once.
//! Progress is reported to the UI as `transfer` events (throttled).

use crate::s3::Connection;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;

/// Name of the event the UI listens to.
pub const EVENT: &str = "transfer";
/// Files at or above this size upload in parts (smoother progress, cancellable mid-file).
pub const MULTIPART_THRESHOLD: u64 = 16 * 1024 * 1024;
/// Minimum part size (S3 minimum is 5 MiB, except the last part).
const MIN_PART_SIZE: u64 = 8 * 1024 * 1024;
/// S3 allows at most 10,000 parts; stay a little under.
const MAX_PARTS: u64 = 9_000;
/// Simultaneous transfers.
const CONCURRENCY: usize = 3;
/// Minimum gap between progress events per transfer.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Upload,
    Download,
    /// S3 -> S3 copy (server-side).
    Copy,
    /// S3 -> S3 copy, then delete the source.
    Move,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEvent {
    pub id: u64,
    pub direction: Direction,
    pub bucket: String,
    pub key: String,
    /// Local file for uploads/downloads; empty for copies/moves.
    pub local_path: String,
    /// Source object for copies/moves.
    pub source_bucket: Option<String>,
    pub source_key: Option<String>,
    pub bytes_done: u64,
    /// 0 until known (downloads learn their size when the response starts).
    pub bytes_total: u64,
    pub state: State,
    pub error: Option<String>,
}

enum Outcome {
    Cancelled,
    Failed(String),
}

type TResult<T> = Result<T, Outcome>;

/// Where progress events go (the Tauri app in production, a stub in tests).
type Sink = Arc<dyn Fn(&TransferEvent) + Send + Sync>;

/// Emits progress for one transfer, throttled.
struct Reporter {
    sink: Sink,
    ev: TransferEvent,
    last: Instant,
    cancel: Arc<AtomicBool>,
}

impl Reporter {
    fn emit(&mut self) {
        self.last = Instant::now();
        (self.sink)(&self.ev);
    }
    fn set_state(&mut self, state: State) {
        self.ev.state = state;
        self.emit();
    }
    fn set_total(&mut self, total: u64) {
        self.ev.bytes_total = total;
    }
    fn add(&mut self, n: u64) {
        self.ev.bytes_done += n;
        if self.last.elapsed() >= PROGRESS_INTERVAL {
            self.emit();
        }
    }
    fn check_cancel(&self) -> TResult<()> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(Outcome::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// What to transfer.
struct Job {
    direction: Direction,
    bucket: String,
    key: String,
    local: PathBuf,
    /// Known size, or 0.
    size: u64,
    /// (bucket, key) of the source object for copies/moves.
    source: Option<(String, String)>,
}

/// One object to copy or move: source key -> destination key.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyPair {
    pub from: String,
    pub to: String,
}

/// CopyObject handles up to 5 GiB; larger objects need a multipart copy.
const COPY_SINGLE_LIMIT: u64 = 5 * 1024 * 1024 * 1024;
/// Part size for multipart copies.
const COPY_PART_SIZE: u64 = 512 * 1024 * 1024;

pub struct Transfers {
    next_id: AtomicU64,
    cancels: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    slots: Arc<Semaphore>,
}

impl Default for Transfers {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            cancels: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(CONCURRENCY)),
        }
    }
}

impl Transfers {
    pub fn cancel(&self, id: u64) {
        if let Some(flag) = self.cancels.lock().unwrap().get(&id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub fn cancel_all(&self) {
        for flag in self.cancels.lock().unwrap().values() {
            flag.store(true, Ordering::Relaxed);
        }
    }

    /// Queues one transfer and returns its id immediately.
    fn spawn(self: &Arc<Self>, app: AppHandle, conn: Arc<Connection>, job: Job) -> u64 {
        let Job {
            direction,
            bucket,
            key,
            local,
            size,
            source,
        } = job;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancels.lock().unwrap().insert(id, cancel.clone());

        let sink: Sink = Arc::new(move |ev: &TransferEvent| {
            let _ = app.emit(EVENT, ev);
        });
        let mut rep = Reporter {
            sink,
            ev: TransferEvent {
                id,
                direction,
                bucket: bucket.clone(),
                key: key.clone(),
                local_path: local.to_string_lossy().into_owned(),
                source_bucket: source.as_ref().map(|s| s.0.clone()),
                source_key: source.as_ref().map(|s| s.1.clone()),
                bytes_done: 0,
                bytes_total: size,
                state: State::Queued,
                error: None,
            },
            last: Instant::now(),
            cancel,
        };
        rep.emit();

        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let _permit = this.slots.clone().acquire_owned().await;
            let result = match rep.check_cancel() {
                Err(e) => Err(e),
                Ok(()) => {
                    rep.set_state(State::Running);
                    match direction {
                        Direction::Upload => upload(&conn, &bucket, &key, &local, &mut rep).await,
                        Direction::Download => {
                            download(&conn, &bucket, &key, &local, &mut rep).await
                        }
                        Direction::Copy | Direction::Move => {
                            let (sb, sk) = source.clone().unwrap_or_default();
                            let target = ObjectRef {
                                bucket: &bucket,
                                key: &key,
                            };
                            let from = ObjectRef {
                                bucket: &sb,
                                key: &sk,
                            };
                            copy(
                                &conn,
                                from,
                                target,
                                direction == Direction::Move,
                                COPY_SINGLE_LIMIT,
                                COPY_PART_SIZE,
                                &mut rep,
                            )
                            .await
                        }
                    }
                }
            };
            match result {
                Ok(()) => rep.set_state(State::Done),
                Err(Outcome::Cancelled) => rep.set_state(State::Cancelled),
                Err(Outcome::Failed(msg)) => {
                    rep.ev.error = Some(msg);
                    rep.set_state(State::Failed);
                }
            }
            this.cancels.lock().unwrap().remove(&id);
        });
        id
    }

    /// Uploads local files and folders into `prefix`. Folders upload recursively,
    /// keeping their structure. Returns the transfer ids.
    pub fn upload_paths(
        self: &Arc<Self>,
        app: &AppHandle,
        conn: &Arc<Connection>,
        bucket: &str,
        prefix: &str,
        paths: &[PathBuf],
    ) -> Vec<u64> {
        let mut ids = Vec::new();
        for path in paths {
            let mut files = Vec::new();
            collect_files(path, &file_name(path), &mut files);
            for (local, rel, size) in files {
                ids.push(self.spawn(
                    app.clone(),
                    conn.clone(),
                    Job {
                        direction: Direction::Upload,
                        bucket: bucket.to_string(),
                        key: format!("{prefix}{rel}"),
                        local,
                        size,
                        source: None,
                    },
                ));
            }
        }
        ids
    }

    /// Copies (or moves) objects server-side. Returns the transfer ids.
    pub fn copy_items(
        self: &Arc<Self>,
        app: &AppHandle,
        conn: &Arc<Connection>,
        src_bucket: &str,
        dst_bucket: &str,
        pairs: &[CopyPair],
        is_move: bool,
    ) -> Vec<u64> {
        pairs
            .iter()
            .filter(|p| !(src_bucket == dst_bucket && p.from == p.to))
            .map(|p| {
                self.spawn(
                    app.clone(),
                    conn.clone(),
                    Job {
                        direction: if is_move {
                            Direction::Move
                        } else {
                            Direction::Copy
                        },
                        bucket: dst_bucket.to_string(),
                        key: p.to.clone(),
                        local: PathBuf::new(),
                        size: 0,
                        source: Some((src_bucket.to_string(), p.from.clone())),
                    },
                )
            })
            .collect()
    }

    /// Uploads one local file to an exact key (used by sync).
    pub fn upload_file(
        self: &Arc<Self>,
        app: &AppHandle,
        conn: &Arc<Connection>,
        bucket: &str,
        key: &str,
        local: PathBuf,
        size: u64,
    ) -> u64 {
        self.spawn(
            app.clone(),
            conn.clone(),
            Job {
                direction: Direction::Upload,
                bucket: bucket.to_string(),
                key: key.to_string(),
                local,
                size,
                source: None,
            },
        )
    }

    /// Downloads one object to an exact local path (from a Save dialog).
    pub fn download_to_file(
        self: &Arc<Self>,
        app: &AppHandle,
        conn: &Arc<Connection>,
        bucket: &str,
        key: &str,
        dest: PathBuf,
    ) -> u64 {
        self.spawn(
            app.clone(),
            conn.clone(),
            Job {
                direction: Direction::Download,
                bucket: bucket.to_string(),
                key: key.to_string(),
                local: dest,
                size: 0,
                source: None,
            },
        )
    }

    /// Downloads objects and/or folder prefixes into a local folder. Folders are
    /// recreated recursively. Existing names get " (1)", " (2)"… appended.
    pub async fn download_to_folder(
        self: &Arc<Self>,
        app: &AppHandle,
        conn: &Arc<Connection>,
        bucket: &str,
        items: &[String],
        dest_dir: &Path,
    ) -> Result<Vec<u64>, crate::error::AppError> {
        let mut ids = Vec::new();
        for item in items {
            if item.ends_with('/') {
                let folder = unique_path(&dest_dir.join(safe_segment(&last_segment(item))));
                for (key, size) in conn.list_all(bucket, item).await? {
                    let rel = &key[item.len()..];
                    if rel.is_empty() || rel.ends_with('/') {
                        continue; // folder markers
                    }
                    let dest = folder.join(safe_relative_path(rel));
                    ids.push(self.spawn(
                        app.clone(),
                        conn.clone(),
                        Job {
                            direction: Direction::Download,
                            bucket: bucket.to_string(),
                            key,
                            local: dest,
                            size,
                            source: None,
                        },
                    ));
                }
            } else {
                let dest = unique_path(&dest_dir.join(safe_segment(&last_segment(item))));
                ids.push(self.download_to_file(app, conn, bucket, item, dest));
            }
        }
        Ok(ids)
    }
}

// ---------------------------------------------------------------------------
// Copy / move

/// A bucket + key pair, to keep copy() readable.
#[derive(Clone, Copy)]
struct ObjectRef<'a> {
    bucket: &'a str,
    key: &'a str,
}

/// Percent-encodes a key for the CopySource header (keeps "/" and unreserved chars).
fn encode_copy_source(bucket: &str, key: &str) -> String {
    let mut out = format!("{bucket}/");
    for b in key.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Server-side copy (no data passes through this machine). Objects over
/// `single_limit` use a multipart copy. With `delete_source`, the source is
/// deleted only after the copy succeeds.
#[allow(clippy::too_many_arguments)]
async fn copy(
    conn: &Connection,
    from: ObjectRef<'_>,
    to: ObjectRef<'_>,
    delete_source: bool,
    single_limit: u64,
    part_size: u64,
    rep: &mut Reporter,
) -> TResult<()> {
    let fail = |e: crate::error::AppError| Outcome::Failed(e.message);
    let src = conn.client_for(from.bucket).await.map_err(fail)?;
    let dst = conn.client_for(to.bucket).await.map_err(fail)?;

    let head = src
        .head_object()
        .bucket(from.bucket)
        .key(from.key)
        .send()
        .await
        .map_err(|e| Outcome::Failed(conn.err(e).message))?;
    let size = head.content_length().unwrap_or(0).max(0) as u64;
    rep.set_total(size);
    rep.check_cancel()?;
    let copy_source = encode_copy_source(from.bucket, from.key);

    if size <= single_limit {
        dst.copy_object()
            .bucket(to.bucket)
            .key(to.key)
            .copy_source(&copy_source)
            // CopyObject defaults to STANDARD; keep the original class.
            .set_storage_class(head.storage_class().cloned())
            .send()
            .await
            .map_err(|e| Outcome::Failed(conn.err(e).message))?;
        rep.add(size);
    } else {
        let created = dst
            .create_multipart_upload()
            .bucket(to.bucket)
            .key(to.key)
            .set_content_type(head.content_type().map(String::from))
            .set_metadata(head.metadata().cloned())
            .set_storage_class(head.storage_class().cloned())
            .send()
            .await
            .map_err(|e| Outcome::Failed(conn.err(e).message))?;
        let upload_id = created
            .upload_id()
            .ok_or_else(|| Outcome::Failed("S3 returned no upload id".into()))?
            .to_string();

        let parts: TResult<Vec<CompletedPart>> = async {
            let mut parts = Vec::new();
            let mut start = 0u64;
            let mut number = 1;
            while start < size {
                rep.check_cancel()?;
                let end = (start + part_size).min(size) - 1;
                let out = dst
                    .upload_part_copy()
                    .bucket(to.bucket)
                    .key(to.key)
                    .upload_id(&upload_id)
                    .part_number(number)
                    .copy_source(&copy_source)
                    .copy_source_range(format!("bytes={start}-{end}"))
                    .send()
                    .await
                    .map_err(|e| Outcome::Failed(conn.err(e).message))?;
                let r = out.copy_part_result();
                parts.push(
                    CompletedPart::builder()
                        .part_number(number)
                        .set_e_tag(r.and_then(|r| r.e_tag()).map(String::from))
                        .set_checksum_crc32(r.and_then(|r| r.checksum_crc32()).map(String::from))
                        .set_checksum_crc32_c(
                            r.and_then(|r| r.checksum_crc32_c()).map(String::from),
                        )
                        .set_checksum_crc64_nvme(
                            r.and_then(|r| r.checksum_crc64_nvme()).map(String::from),
                        )
                        .set_checksum_sha1(r.and_then(|r| r.checksum_sha1()).map(String::from))
                        .set_checksum_sha256(r.and_then(|r| r.checksum_sha256()).map(String::from))
                        .build(),
                );
                rep.add(end + 1 - start);
                start = end + 1;
                number += 1;
            }
            Ok(parts)
        }
        .await;

        match parts {
            Ok(parts) => {
                dst.complete_multipart_upload()
                    .bucket(to.bucket)
                    .key(to.key)
                    .upload_id(&upload_id)
                    .multipart_upload(
                        CompletedMultipartUpload::builder()
                            .set_parts(Some(parts))
                            .build(),
                    )
                    .send()
                    .await
                    .map_err(|e| Outcome::Failed(conn.err(e).message))?;
            }
            Err(e) => {
                let _ = dst
                    .abort_multipart_upload()
                    .bucket(to.bucket)
                    .key(to.key)
                    .upload_id(&upload_id)
                    .send()
                    .await;
                return Err(e);
            }
        }
    }

    if delete_source {
        src.delete_object()
            .bucket(from.bucket)
            .key(from.key)
            .send()
            .await
            .map_err(|e| {
                Outcome::Failed(format!(
                    "Copied, but couldn't delete the original: {}",
                    conn.err(e).message
                ))
            })?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Upload

async fn upload(
    conn: &Connection,
    bucket: &str,
    key: &str,
    path: &Path,
    rep: &mut Reporter,
) -> TResult<()> {
    let client = conn
        .client_for(bucket)
        .await
        .map_err(|e| Outcome::Failed(e.message))?;
    let size = tokio::fs::metadata(path)
        .await
        .map_err(|e| Outcome::Failed(format!("Can't read {}: {e}", path.display())))?
        .len();
    rep.set_total(size);
    let content_type = guess_content_type(key);

    if size < MULTIPART_THRESHOLD {
        let data = tokio::fs::read(path)
            .await
            .map_err(|e| Outcome::Failed(format!("Can't read {}: {e}", path.display())))?;
        rep.check_cancel()?;
        client
            .put_object()
            .bucket(bucket)
            .key(key)
            .content_type(content_type)
            .body(ByteStream::from(data))
            .send()
            .await
            .map_err(|e| Outcome::Failed(conn.err(e).message))?;
        rep.add(size);
        return Ok(());
    }

    // Multipart upload.
    let part_size = MIN_PART_SIZE.max(size.div_ceil(MAX_PARTS));
    let created = client
        .create_multipart_upload()
        .bucket(bucket)
        .key(key)
        .content_type(content_type)
        .send()
        .await
        .map_err(|e| Outcome::Failed(conn.err(e).message))?;
    let upload_id = created
        .upload_id()
        .ok_or_else(|| Outcome::Failed("S3 returned no upload id".into()))?
        .to_string();

    let result: TResult<Vec<CompletedPart>> = async {
        let mut file = tokio::fs::File::open(path)
            .await
            .map_err(|e| Outcome::Failed(format!("Can't open {}: {e}", path.display())))?;
        let mut parts = Vec::new();
        let mut remaining = size;
        let mut number = 1;
        while remaining > 0 {
            rep.check_cancel()?;
            let len = remaining.min(part_size);
            let mut buf = vec![0u8; len as usize];
            file.read_exact(&mut buf)
                .await
                .map_err(|e| Outcome::Failed(format!("Can't read {}: {e}", path.display())))?;
            let out = client
                .upload_part()
                .bucket(bucket)
                .key(key)
                .upload_id(&upload_id)
                .part_number(number)
                .body(ByteStream::from(buf))
                .send()
                .await
                .map_err(|e| Outcome::Failed(conn.err(e).message))?;
            parts.push(
                CompletedPart::builder()
                    .part_number(number)
                    .set_e_tag(out.e_tag().map(String::from))
                    .set_checksum_crc32(out.checksum_crc32().map(String::from))
                    .set_checksum_crc32_c(out.checksum_crc32_c().map(String::from))
                    .set_checksum_crc64_nvme(out.checksum_crc64_nvme().map(String::from))
                    .set_checksum_sha1(out.checksum_sha1().map(String::from))
                    .set_checksum_sha256(out.checksum_sha256().map(String::from))
                    .build(),
            );
            rep.add(len);
            remaining -= len;
            number += 1;
        }
        Ok(parts)
    }
    .await;

    match result {
        Ok(parts) => {
            client
                .complete_multipart_upload()
                .bucket(bucket)
                .key(key)
                .upload_id(&upload_id)
                .multipart_upload(
                    CompletedMultipartUpload::builder()
                        .set_parts(Some(parts))
                        .build(),
                )
                .send()
                .await
                .map_err(|e| Outcome::Failed(conn.err(e).message))?;
            Ok(())
        }
        Err(e) => {
            // Don't leave billable orphaned parts behind.
            let _ = client
                .abort_multipart_upload()
                .bucket(bucket)
                .key(key)
                .upload_id(&upload_id)
                .send()
                .await;
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------
// Download

async fn download(
    conn: &Connection,
    bucket: &str,
    key: &str,
    dest: &Path,
    rep: &mut Reporter,
) -> TResult<()> {
    let client = conn
        .client_for(bucket)
        .await
        .map_err(|e| Outcome::Failed(e.message))?;
    let out = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| Outcome::Failed(conn.err(e).message))?;
    if let Some(len) = out.content_length() {
        rep.set_total(len.max(0) as u64);
    }
    let last_modified = out
        .last_modified()
        .and_then(|d| std::time::SystemTime::try_from(*d).ok());

    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| Outcome::Failed(format!("Can't create {}: {e}", dir.display())))?;
    }
    // Write to a temporary name; rename only when complete.
    let tmp = partial_path(dest);
    let result: TResult<()> = async {
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| Outcome::Failed(format!("Can't write {}: {e}", tmp.display())))?;
        let mut body = out.body;
        while let Some(chunk) = body
            .try_next()
            .await
            .map_err(|e| Outcome::Failed(format!("Download interrupted: {e}")))?
        {
            rep.check_cancel()?;
            file.write_all(&chunk)
                .await
                .map_err(|e| Outcome::Failed(format!("Can't write {}: {e}", tmp.display())))?;
            rep.add(chunk.len() as u64);
        }
        file.flush()
            .await
            .map_err(|e| Outcome::Failed(format!("Can't write {}: {e}", tmp.display())))?;
        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            // Save dialogs have already confirmed overwriting, so replace any existing file.
            let _ = tokio::fs::remove_file(dest).await;
            tokio::fs::rename(&tmp, dest)
                .await
                .map_err(|e| Outcome::Failed(format!("Can't save {}: {e}", dest.display())))?;
            // Match the S3 timestamp (as the AWS CLI does) so a later sync sees
            // the file as up to date. Best-effort.
            if let Some(t) = last_modified {
                if let Ok(f) = std::fs::File::options().write(true).open(dest) {
                    let _ = f.set_modified(t);
                }
            }
            Ok(())
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            Err(e)
        }
    }
}

/// Runs one upload or download immediately, without events (tests).
#[cfg(test)]
pub(crate) async fn transfer_now(
    conn: &Connection,
    direction: Direction,
    bucket: &str,
    key: &str,
    local: &Path,
) -> Result<(), String> {
    let mut rep = Reporter {
        sink: Arc::new(|_: &TransferEvent| {}),
        ev: TransferEvent {
            id: 0,
            direction,
            bucket: bucket.into(),
            key: key.into(),
            local_path: String::new(),
            source_bucket: None,
            source_key: None,
            bytes_done: 0,
            bytes_total: 0,
            state: State::Running,
            error: None,
        },
        last: Instant::now(),
        cancel: Arc::new(AtomicBool::new(false)),
    };
    let r = match direction {
        Direction::Upload => upload(conn, bucket, key, local, &mut rep).await,
        Direction::Download => download(conn, bucket, key, local, &mut rep).await,
        _ => return Err("unsupported".into()),
    };
    r.map_err(|e| match e {
        Outcome::Cancelled => "cancelled".to_string(),
        Outcome::Failed(m) => m,
    })
}

// ---------------------------------------------------------------------------
// Helpers

/// Recursively lists files under `path` as (local path, key suffix, size).
/// The key suffix uses "/" separators and starts with the top item's name.
fn collect_files(path: &Path, rel: &str, out: &mut Vec<(PathBuf, String, u64)>) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.is_file() {
        out.push((path.to_path_buf(), rel.to_string(), meta.len()));
    } else if meta.is_dir() {
        if let Ok(entries) = std::fs::read_dir(path) {
            let mut entries: Vec<_> = entries.flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let name = entry.file_name().to_string_lossy().into_owned();
                collect_files(&entry.path(), &format!("{rel}/{name}"), out);
            }
        }
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "upload".to_string())
}

fn last_segment(key_or_prefix: &str) -> String {
    let trimmed = key_or_prefix.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(trimmed).to_string()
}

/// Makes one S3 key segment safe as a Windows/macOS/Linux file name.
/// Also neutralises "." and ".." so keys can't escape the target folder.
pub fn safe_segment(seg: &str) -> String {
    let mut s: String = seg
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\' | '/' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    // Windows rejects trailing dots and spaces.
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    if s.is_empty() {
        s.push('_');
    }
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        s.insert(0, '_');
    }
    s
}

/// Converts a relative key ("a/b/c.txt") into a safe relative path.
pub fn safe_relative_path(rel: &str) -> PathBuf {
    rel.split('/').map(safe_segment).collect()
}

/// "name.ext" -> "name (1).ext" etc. until the path doesn't exist.
fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let parent = path.parent().unwrap_or(Path::new(""));
    (1..)
        .map(|n| parent.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

fn partial_path(dest: &Path) -> PathBuf {
    let mut name = dest
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".s3x-part");
    dest.with_file_name(name)
}

/// Content-Type from file extension, so browsers/previews treat objects sensibly.
pub fn guess_content_type(key: &str) -> &'static str {
    let ext = key.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "tar" => "application/x-tar",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "parquet" => "application/vnd.apache.parquet",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitises_segments() {
        assert_eq!(safe_segment("a:b*c?.txt"), "a_b_c_.txt");
        assert_eq!(safe_segment(".."), "_");
        assert_eq!(safe_segment("."), "_");
        assert_eq!(safe_segment(""), "_");
        assert_eq!(safe_segment("name. "), "name");
        assert_eq!(safe_segment("con.txt"), "_con.txt");
        assert_eq!(
            safe_relative_path("../../etc/passwd"),
            ["_", "_", "etc", "passwd"].iter().collect::<PathBuf>()
        );
    }

    #[test]
    fn unique_paths() {
        let dir = std::env::temp_dir().join("s3x-unique");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.txt");
        assert_eq!(unique_path(&p), p);
        std::fs::write(&p, "x").unwrap();
        assert_eq!(unique_path(&p), dir.join("a (1).txt"));
    }

    #[test]
    fn collects_folder_tree() {
        let dir = std::env::temp_dir().join("s3x-collect");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("top/sub")).unwrap();
        std::fs::write(dir.join("top/a.txt"), "aa").unwrap();
        std::fs::write(dir.join("top/sub/b.txt"), "b").unwrap();
        let mut out = Vec::new();
        collect_files(&dir.join("top"), "top", &mut out);
        let rels: Vec<_> = out.iter().map(|(_, r, s)| (r.as_str(), *s)).collect();
        assert_eq!(rels, vec![("top/a.txt", 2), ("top/sub/b.txt", 1)]);
    }
}

#[cfg(test)]
mod emulator_tests {
    //! Need an S3 emulator on localhost:4566 (see s3.rs tests).
    use super::*;
    use crate::profiles::ProfileInfo;

    fn reporter() -> (Reporter, Arc<Mutex<Vec<TransferEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let ev2 = events.clone();
        let rep = Reporter {
            sink: Arc::new(move |e: &TransferEvent| ev2.lock().unwrap().push(e.clone())),
            ev: TransferEvent {
                id: 1,
                direction: Direction::Upload,
                bucket: String::new(),
                key: String::new(),
                local_path: String::new(),
                source_bucket: None,
                source_key: None,
                bytes_done: 0,
                bytes_total: 0,
                state: State::Running,
                error: None,
            },
            last: Instant::now(),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        (rep, events)
    }

    async fn connect() -> Connection {
        let profile = ProfileInfo {
            name: "s3x-transfer-test".into(),
            region: Some("us-east-1".into()),
            endpoint_url: None,
            sso_session: None,
        };
        let ovr = crate::settings::ConnectionOverride {
            endpoint_url: Some("http://localhost:4566".into()),
            path_style: None,
        };
        // SAFETY: single-threaded test run (--test-threads=1).
        unsafe {
            std::env::set_var("AWS_ACCESS_KEY_ID", "test");
            std::env::set_var("AWS_SECRET_ACCESS_KEY", "test");
        }
        Connection::new(&profile, Some(&ovr)).await.unwrap()
    }

    #[tokio::test]
    #[ignore]
    async fn round_trips_small_and_multipart_files() {
        let conn = connect().await;
        let bucket = "s3x-transfer-bucket";
        let _ = conn
            .client_for(bucket)
            .await
            .unwrap()
            .create_bucket()
            .bucket(bucket)
            .send()
            .await;

        let dir = std::env::temp_dir().join("s3x-transfer");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        for (name, size) in [
            ("small.bin", 1234usize),
            ("big.bin", (MULTIPART_THRESHOLD as usize) + 3 * 1024 * 1024),
        ] {
            let data: Vec<u8> = (0..size).map(|i| (i * 31 % 251) as u8).collect();
            let src = dir.join(name);
            std::fs::write(&src, &data).unwrap();

            let (mut rep, _) = reporter();
            let key = format!("up/{name}");
            if upload(&conn, bucket, &key, &src, &mut rep).await.is_err() {
                panic!("upload failed");
            }
            assert_eq!(rep.ev.bytes_done, size as u64);

            let dest = dir.join(format!("down-{name}"));
            let (mut rep, _) = reporter();
            if download(&conn, bucket, &key, &dest, &mut rep)
                .await
                .is_err()
            {
                panic!("download failed");
            }
            assert_eq!(rep.ev.bytes_total, size as u64);
            assert_eq!(
                std::fs::read(&dest).unwrap(),
                data,
                "{name} content differs"
            );
            assert!(!partial_path(&dest).exists());
        }

        let listed = conn.list_all(bucket, "up/").await.unwrap();
        assert_eq!(listed.len(), 2);
    }

    #[test]
    fn encodes_copy_source() {
        assert_eq!(
            encode_copy_source("b", "a b/ü+&.txt"),
            "b/a%20b/%C3%BC%2B%26.txt"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn copies_moves_and_multipart_copies() {
        let conn = connect().await;
        let bucket = "s3x-copy-bucket";
        let other = "s3x-copy-other";
        for b in [bucket, other] {
            let _ = conn
                .client_for(b)
                .await
                .unwrap()
                .create_bucket()
                .bucket(b)
                .send()
                .await;
        }
        let client = conn.client_for(bucket).await.unwrap();
        let put = |key: &'static str, data: Vec<u8>| {
            let client = client.clone();
            async move {
                client
                    .put_object()
                    .bucket(bucket)
                    .key(key)
                    .content_type("text/plain")
                    .body(ByteStream::from(data))
                    .send()
                    .await
                    .unwrap();
            }
        };
        put("src/a b+c.txt", b"hello".to_vec()).await;
        let big: Vec<u8> = (0..12 * 1024 * 1024).map(|i| (i % 253) as u8).collect();
        put("src/big.bin", big.clone()).await;

        // Plain copy, across buckets, odd characters in the key.
        let (mut rep, _) = reporter();
        let from = ObjectRef {
            bucket,
            key: "src/a b+c.txt",
        };
        let to = ObjectRef {
            bucket: other,
            key: "dst/a b+c.txt",
        };
        assert!(copy(
            &conn,
            from,
            to,
            false,
            COPY_SINGLE_LIMIT,
            COPY_PART_SIZE,
            &mut rep
        )
        .await
        .is_ok());
        let got = client
            .get_object()
            .bucket(other)
            .key("dst/a b+c.txt")
            .send()
            .await
            .unwrap();
        assert_eq!(got.content_type(), Some("text/plain"));
        assert_eq!(
            got.body.collect().await.unwrap().into_bytes().as_ref(),
            b"hello"
        );

        // Multipart copy (forced with a small limit and 5 MiB parts).
        let (mut rep, _) = reporter();
        let from = ObjectRef {
            bucket,
            key: "src/big.bin",
        };
        let to = ObjectRef {
            bucket,
            key: "dst/big.bin",
        };
        assert!(
            copy(&conn, from, to, false, 1024, 5 * 1024 * 1024, &mut rep)
                .await
                .is_ok()
        );
        assert_eq!(rep.ev.bytes_done, big.len() as u64);
        let got = client
            .get_object()
            .bucket(bucket)
            .key("dst/big.bin")
            .send()
            .await
            .unwrap();
        assert_eq!(
            got.body.collect().await.unwrap().into_bytes().as_ref(),
            &big[..]
        );

        // Move = copy + delete source.
        let (mut rep, _) = reporter();
        let from = ObjectRef {
            bucket,
            key: "src/a b+c.txt",
        };
        let to = ObjectRef {
            bucket,
            key: "src/renamed.txt",
        };
        assert!(copy(
            &conn,
            from,
            to,
            true,
            COPY_SINGLE_LIMIT,
            COPY_PART_SIZE,
            &mut rep
        )
        .await
        .is_ok());
        let keys: Vec<String> = conn
            .list_all(bucket, "src/")
            .await
            .unwrap()
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        assert_eq!(keys, vec!["src/big.bin", "src/renamed.txt"]);
    }

    #[tokio::test]
    #[ignore]
    async fn cancelled_multipart_upload_is_aborted() {
        let conn = connect().await;
        let bucket = "s3x-transfer-bucket";
        let _ = conn
            .client_for(bucket)
            .await
            .unwrap()
            .create_bucket()
            .bucket(bucket)
            .send()
            .await;
        let dir = std::env::temp_dir().join("s3x-transfer-cancel");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("big.bin");
        std::fs::write(&src, vec![7u8; MULTIPART_THRESHOLD as usize + 1]).unwrap();

        let (mut rep, _) = reporter();
        rep.cancel.store(true, Ordering::Relaxed);
        assert!(matches!(
            upload(&conn, bucket, "cancel/big.bin", &src, &mut rep).await,
            Err(Outcome::Cancelled)
        ));
        let client = conn.client_for(bucket).await.unwrap();
        let open = client
            .list_multipart_uploads()
            .bucket(bucket)
            .prefix("cancel/")
            .send()
            .await
            .unwrap();
        assert!(open.uploads().is_empty(), "multipart upload left open");
        assert!(conn.list_all(bucket, "cancel/").await.unwrap().is_empty());
    }
}
