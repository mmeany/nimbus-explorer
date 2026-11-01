//! Sync between a local folder and an S3 folder, modelled on `aws s3 sync`.
//!
//! Planning is separate from running: `plan` lists both sides and decides what
//! to do (nothing changes), the UI shows the result (a dry run), and `run`
//! executes a stored plan. The comparison itself (`compute_plan`) is pure, so
//! its rules are unit-tested without S3 or a disk.
//!
//! Rules (as the AWS CLI): copy when the file is missing at the destination,
//! the sizes differ, or (unless "size only") the source is newer. After a
//! download the local file's modified time is set to the S3 LastModified, and
//! after an upload S3's LastModified (upload time) is newer than the file, so
//! a repeat sync is a no-op.

use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use crate::transfers::{safe_segment, Transfers};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

/// Rows of actions/warnings sent to the UI; the rest are summarised in totals.
pub const PREVIEW_ROWS: usize = 100;

/// Downloads to case-insensitive filesystems must avoid case-only clashes.
const CASE_INSENSITIVE_FS: bool = cfg!(any(windows, target_os = "macos"));

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SyncDirection {
    /// Local folder -> S3 folder.
    Upload,
    /// S3 folder -> local folder.
    Download,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub direction: SyncDirection,
    pub local_dir: String,
    pub bucket: String,
    /// "" or ending in "/".
    pub prefix: String,
    /// Delete destination files that don't exist in the source (mirror).
    pub delete_extras: bool,
    /// Compare sizes only, ignoring timestamps.
    pub size_only: bool,
    /// Glob patterns (`*`, `?`) matched against paths relative to the folders.
    pub excludes: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    Upload,
    Download,
    /// Delete from S3 (upload direction, delete extras).
    DeleteRemote,
    /// Delete a local file (download direction, delete extras).
    DeleteLocal,
}

#[derive(Debug, Clone)]
pub struct Action {
    pub kind: ActionKind,
    /// Path relative to both folders, "/"-separated.
    pub rel: String,
    pub size: u64,
    pub reason: &'static str,
    pub local: PathBuf,
    pub key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub path: String,
    pub message: String,
}

/// A local file found by the scan.
#[derive(Debug, Clone)]
pub struct LocalFile {
    pub rel: String,
    pub size: u64,
    pub modified: Option<SystemTime>,
}

/// An S3 object under the prefix.
#[derive(Debug, Clone)]
pub struct RemoteFile {
    pub key: String,
    pub size: u64,
    pub modified: Option<SystemTime>,
}

#[derive(Debug, Clone)]
pub struct FullPlan {
    pub request: SyncRequest,
    pub actions: Vec<Action>,
    pub warnings: Vec<Warning>,
    pub unchanged: u64,
}

// ---------------------------------------------------------------------------
// What the UI sees

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub count: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionView {
    pub kind: ActionKind,
    pub path: String,
    pub size: u64,
    pub reason: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub plan_id: u64,
    pub direction: SyncDirection,
    pub uploads: Totals,
    pub downloads: Totals,
    pub deletes: Totals,
    pub unchanged: u64,
    pub total_actions: u64,
    /// The first PREVIEW_ROWS actions only.
    pub actions: Vec<ActionView>,
    /// True if `actions` is only the start of the list (a summary).
    pub truncated: bool,
    pub total_warnings: u64,
    /// The first PREVIEW_ROWS warnings only.
    pub warnings: Vec<Warning>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRunResult {
    /// Transfer ids for uploads/downloads (progress via `transfer` events).
    pub transfer_ids: Vec<u64>,
    pub deleted: u64,
    pub delete_failures: Vec<Warning>,
}

// ---------------------------------------------------------------------------
// Planning

/// `*` matches any run of characters (including "/", as the AWS CLI does);
/// `?` matches one character.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn excluded(rel: &str, excludes: &[String]) -> bool {
    excludes.iter().any(|p| glob_match(p, rel))
}

/// Whole seconds, since S3 timestamps have one-second resolution.
fn secs(t: Option<SystemTime>) -> Option<u64> {
    t.and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

fn norm(rel: &str, case_insensitive: bool) -> String {
    if case_insensitive {
        rel.to_lowercase()
    } else {
        rel.to_string()
    }
}

/// Decides every action. Pure: no I/O.
pub fn compute_plan(
    req: &SyncRequest,
    local: Vec<LocalFile>,
    remote: Vec<RemoteFile>,
    case_insensitive: bool,
) -> FullPlan {
    let root = PathBuf::from(&req.local_dir);
    let mut warnings = Vec::new();
    let mut actions = Vec::new();
    let mut unchanged = 0u64;

    // Remote objects relative to the prefix (skipping folder markers).
    let mut remote_by_rel: Vec<(String, RemoteFile)> = remote
        .into_iter()
        .filter_map(|r| {
            let rel = r.key.strip_prefix(&req.prefix)?.to_string();
            (!rel.is_empty() && !rel.ends_with('/')).then_some((rel, r))
        })
        .filter(|(rel, _)| !excluded(rel, &req.excludes))
        .collect();
    remote_by_rel.sort_by(|a, b| a.0.cmp(&b.0));

    let local: Vec<LocalFile> = local
        .into_iter()
        .filter(|l| !excluded(&l.rel, &req.excludes))
        .collect();

    match req.direction {
        SyncDirection::Upload => {
            let remote_map: HashMap<&str, &RemoteFile> = remote_by_rel
                .iter()
                .map(|(rel, r)| (rel.as_str(), r))
                .collect();
            let mut seen = HashSet::new();
            for l in &local {
                seen.insert(l.rel.as_str());
                let reason = match remote_map.get(l.rel.as_str()) {
                    None => Some("new"),
                    Some(r) if r.size != l.size => Some("size differs"),
                    Some(r) if !req.size_only && secs(l.modified) > secs(r.modified) => {
                        Some("newer locally")
                    }
                    Some(_) => None,
                };
                match reason {
                    Some(reason) => actions.push(Action {
                        kind: ActionKind::Upload,
                        rel: l.rel.clone(),
                        size: l.size,
                        reason,
                        local: root.join(&l.rel),
                        key: format!("{}{}", req.prefix, l.rel),
                    }),
                    None => unchanged += 1,
                }
            }
            if req.delete_extras {
                for (rel, r) in &remote_by_rel {
                    if !seen.contains(rel.as_str()) {
                        actions.push(Action {
                            kind: ActionKind::DeleteRemote,
                            rel: rel.clone(),
                            size: r.size,
                            reason: "not in local folder",
                            local: PathBuf::new(),
                            key: r.key.clone(),
                        });
                    }
                }
            }
        }
        SyncDirection::Download => {
            let local_map: HashMap<String, &LocalFile> = local
                .iter()
                .map(|l| (norm(&l.rel, case_insensitive), l))
                .collect();
            let mut claimed: HashSet<String> = HashSet::new();
            for (rel, r) in &remote_by_rel {
                // Keys whose names can't exist on disk would come back as a
                // different key on a later upload; skip them.
                if rel.split('/').any(|seg| safe_segment(seg) != seg) {
                    warnings.push(Warning {
                        path: rel.clone(),
                        message: "Name contains characters this computer can't use in file names; skipped".into(),
                    });
                    continue;
                }
                let n = norm(rel, case_insensitive);
                if !claimed.insert(n.clone()) {
                    warnings.push(Warning {
                        path: rel.clone(),
                        message: "Differs from another key only by upper/lower case; skipped to avoid overwriting it".into(),
                    });
                    continue;
                }
                let reason = match local_map.get(&n) {
                    None => Some("new"),
                    Some(l) if l.size != r.size => Some("size differs"),
                    Some(l) if !req.size_only && secs(r.modified) > secs(l.modified) => {
                        Some("newer in S3")
                    }
                    Some(_) => None,
                };
                match reason {
                    Some(reason) => actions.push(Action {
                        kind: ActionKind::Download,
                        rel: rel.clone(),
                        size: r.size,
                        reason,
                        local: rel.split('/').fold(root.clone(), |p, s| p.join(s)),
                        key: r.key.clone(),
                    }),
                    None => unchanged += 1,
                }
            }
            if req.delete_extras {
                for l in &local {
                    if !claimed.contains(&norm(&l.rel, case_insensitive)) {
                        actions.push(Action {
                            kind: ActionKind::DeleteLocal,
                            rel: l.rel.clone(),
                            size: l.size,
                            reason: "not in S3 folder",
                            local: root.join(&l.rel),
                            key: String::new(),
                        });
                    }
                }
            }
        }
    }

    // Deletes first: in a large plan the preview lists only the first 100
    // actions, and destructive ones must always be visible there.
    actions.sort_by_key(|a| !matches!(a.kind, ActionKind::DeleteRemote | ActionKind::DeleteLocal));

    FullPlan {
        request: req.clone(),
        actions,
        warnings,
        unchanged,
    }
}

/// Recursively lists files under `root` as "/"-separated relative paths.
/// Symlinks are skipped (no loops); our own partial downloads are ignored.
pub fn scan_local(root: &Path) -> Result<Vec<LocalFile>, String> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let entries =
            std::fs::read_dir(&dir).map_err(|e| format!("Can't read {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if meta.is_dir() {
                stack.push((entry.path(), child_rel));
            } else if meta.is_file() && !name.ends_with(".s3x-part") {
                out.push(LocalFile {
                    rel: child_rel,
                    size: meta.len(),
                    modified: meta.modified().ok(),
                });
            }
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

/// Lists both sides and computes the plan. Changes nothing.
pub async fn plan(conn: &Connection, req: SyncRequest) -> Result<FullPlan, AppError> {
    let root = PathBuf::from(&req.local_dir);
    if !req.prefix.is_empty() && !req.prefix.ends_with('/') {
        return Err(AppError::new(
            ErrorKind::Other,
            "The S3 folder must end with '/'",
        ));
    }
    let local = if root.is_dir() {
        let r = root.clone();
        tauri::async_runtime::spawn_blocking(move || scan_local(&r))
            .await
            .map_err(|e| AppError::new(ErrorKind::Other, e.to_string()))?
            .map_err(|e| AppError::new(ErrorKind::Other, e))?
    } else if req.direction == SyncDirection::Upload {
        return Err(AppError::new(
            ErrorKind::Other,
            format!("Local folder {} doesn't exist", root.display()),
        ));
    } else {
        Vec::new() // download into a folder that will be created
    };
    let remote = conn.list_all_detailed(&req.bucket, &req.prefix).await?;
    Ok(compute_plan(&req, local, remote, CASE_INSENSITIVE_FS))
}

impl FullPlan {
    pub fn summary(&self, plan_id: u64) -> SyncSummary {
        let mut uploads = Totals::default();
        let mut downloads = Totals::default();
        let mut deletes = Totals::default();
        for a in &self.actions {
            let t = match a.kind {
                ActionKind::Upload => &mut uploads,
                ActionKind::Download => &mut downloads,
                ActionKind::DeleteRemote | ActionKind::DeleteLocal => &mut deletes,
            };
            t.count += 1;
            t.bytes += a.size;
        }
        SyncSummary {
            plan_id,
            direction: self.request.direction,
            uploads,
            downloads,
            deletes,
            unchanged: self.unchanged,
            total_actions: self.actions.len() as u64,
            actions: self
                .actions
                .iter()
                .take(PREVIEW_ROWS)
                .map(|a| ActionView {
                    kind: a.kind,
                    path: a.rel.clone(),
                    size: a.size,
                    reason: a.reason,
                })
                .collect(),
            truncated: self.actions.len() > PREVIEW_ROWS,
            total_warnings: self.warnings.len() as u64,
            warnings: self.warnings.iter().take(PREVIEW_ROWS).cloned().collect(),
        }
    }
}

// ---------------------------------------------------------------------------
// Plan store + running

/// Holds the most recent plan so "Run sync" executes exactly what was previewed.
#[derive(Default)]
pub struct PlanStore {
    next: Mutex<u64>,
    current: Mutex<Option<(u64, FullPlan)>>,
}

impl PlanStore {
    pub fn put(&self, plan: FullPlan) -> u64 {
        let mut n = self.next.lock().unwrap();
        *n += 1;
        *self.current.lock().unwrap() = Some((*n, plan));
        *n
    }

    /// Takes the plan with this id (a plan runs at most once).
    pub fn take(&self, id: u64) -> Option<FullPlan> {
        let mut cur = self.current.lock().unwrap();
        match cur.as_ref() {
            Some((cid, _)) if *cid == id => cur.take().map(|(_, p)| p),
            _ => None,
        }
    }
}

/// Executes a plan: queues uploads/downloads on the transfer engine and
/// performs deletes directly.
pub async fn run(
    app: &tauri::AppHandle,
    conn: &Arc<Connection>,
    transfers: &Arc<Transfers>,
    plan: FullPlan,
) -> Result<SyncRunResult, AppError> {
    let bucket = plan.request.bucket.clone();
    let mut transfer_ids = Vec::new();
    let mut remote_deletes = Vec::new();
    let mut local_deletes = Vec::new();
    for a in plan.actions {
        match a.kind {
            ActionKind::Upload => transfer_ids
                .push(transfers.upload_file(app, conn, &bucket, &a.key, a.local, a.size)),
            ActionKind::Download => {
                transfer_ids.push(transfers.download_to_file(app, conn, &bucket, &a.key, a.local))
            }
            ActionKind::DeleteRemote => remote_deletes.push(a.key),
            ActionKind::DeleteLocal => local_deletes.push((a.rel, a.local)),
        }
    }

    let mut deleted = 0u64;
    let mut delete_failures = Vec::new();
    if !remote_deletes.is_empty() {
        let res = conn.delete_items(&bucket, &remote_deletes).await?;
        deleted += res.deleted;
        delete_failures.extend(res.failed.into_iter().map(|f| Warning {
            path: f.key,
            message: f.message,
        }));
    }
    for (rel, path) in local_deletes {
        match std::fs::remove_file(&path) {
            Ok(()) => deleted += 1,
            Err(e) => delete_failures.push(Warning {
                path: rel,
                message: e.to_string(),
            }),
        }
    }
    Ok(SyncRunResult {
        transfer_ids,
        deleted,
        delete_failures,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn t(s: u64) -> Option<SystemTime> {
        Some(SystemTime::UNIX_EPOCH + Duration::from_secs(s))
    }
    fn req(direction: SyncDirection) -> SyncRequest {
        SyncRequest {
            direction,
            local_dir: "/data".into(),
            bucket: "b".into(),
            prefix: "p/".into(),
            delete_extras: false,
            size_only: false,
            excludes: vec![],
        }
    }
    fn lf(rel: &str, size: u64, m: u64) -> LocalFile {
        LocalFile {
            rel: rel.into(),
            size,
            modified: t(m),
        }
    }
    fn rf(key: &str, size: u64, m: u64) -> RemoteFile {
        RemoteFile {
            key: key.into(),
            size,
            modified: t(m),
        }
    }
    fn kinds(p: &FullPlan) -> Vec<(ActionKind, &str, &str)> {
        p.actions
            .iter()
            .map(|a| (a.kind, a.rel.as_str(), a.reason))
            .collect()
    }

    #[test]
    fn globs() {
        assert!(glob_match("*.tmp", "a.tmp"));
        assert!(
            glob_match("*.tmp", "dir/a.tmp"),
            "* crosses / like the AWS CLI"
        );
        assert!(glob_match(".git/*", ".git/objects/x"));
        assert!(glob_match("log?.txt", "log1.txt"));
        assert!(!glob_match("log?.txt", "log10.txt"));
        assert!(!glob_match("*.tmp", "a.tmpx"));
        assert!(glob_match("*", ""));
    }

    #[test]
    fn upload_rules() {
        let local = vec![
            lf("new.txt", 1, 100),
            lf("same.txt", 5, 100),
            lf("bigger.txt", 9, 100),
            lf("touched.txt", 5, 300),
            lf("x.tmp", 1, 1),
        ];
        let remote = vec![
            rf("p/same.txt", 5, 200),
            rf("p/bigger.txt", 5, 200),
            rf("p/touched.txt", 5, 200),
            rf("p/gone.txt", 3, 200),
            rf("p/", 0, 0),
        ];
        let mut r = req(SyncDirection::Upload);
        r.excludes = vec!["*.tmp".into()];
        let p = compute_plan(&r, local.clone(), remote.clone(), false);
        assert_eq!(
            kinds(&p),
            vec![
                (ActionKind::Upload, "new.txt", "new"),
                (ActionKind::Upload, "bigger.txt", "size differs"),
                (ActionKind::Upload, "touched.txt", "newer locally"),
            ]
        );
        assert_eq!(p.unchanged, 1);
        assert_eq!(p.actions[0].key, "p/new.txt");

        r.size_only = true;
        r.delete_extras = true;
        let p = compute_plan(&r, local, remote, false);
        assert_eq!(
            kinds(&p),
            vec![
                (ActionKind::DeleteRemote, "gone.txt", "not in local folder"),
                (ActionKind::Upload, "new.txt", "new"),
                (ActionKind::Upload, "bigger.txt", "size differs"),
            ],
            "deletes listed first"
        );
    }

    #[test]
    fn download_rules_and_warnings() {
        let local = vec![
            lf("same.txt", 5, 200),
            lf("old.txt", 5, 100),
            lf("extra.txt", 1, 1),
        ];
        let remote = vec![
            rf("p/same.txt", 5, 200),
            rf("p/old.txt", 5, 150),
            rf("p/new/deep.txt", 7, 1),
            rf("p/bad:name.txt", 1, 1),
            rf("p/Case.txt", 1, 1),
            rf("p/case.txt", 1, 1),
        ];
        let mut r = req(SyncDirection::Download);
        r.delete_extras = true;
        let p = compute_plan(&r, local, remote, true);
        assert_eq!(
            kinds(&p),
            vec![
                (ActionKind::DeleteLocal, "extra.txt", "not in S3 folder"),
                (ActionKind::Download, "Case.txt", "new"),
                (ActionKind::Download, "new/deep.txt", "new"),
                (ActionKind::Download, "old.txt", "newer in S3"),
            ]
        );
        assert_eq!(p.unchanged, 1);
        let warned: Vec<_> = p.warnings.iter().map(|w| w.path.as_str()).collect();
        assert_eq!(warned, vec!["bad:name.txt", "case.txt"]);
        assert_eq!(
            p.actions[2].local,
            PathBuf::from("/data").join("new").join("deep.txt")
        );
    }

    #[test]
    fn summary_lists_first_100_and_totals_everything() {
        let local: Vec<_> = (0..250).map(|i| lf(&format!("f{i:03}"), 10, 1)).collect();
        let mut r = req(SyncDirection::Upload);
        r.delete_extras = true;
        let p = compute_plan(&r, local, vec![rf("p/zzz-old.txt", 4, 1)], false);
        let s = p.summary(7);
        assert_eq!(
            s.actions[0].kind,
            ActionKind::DeleteRemote,
            "delete visible in the first 100"
        );
        assert_eq!(s.deletes.count, 1);
        let p = compute_plan(
            &req(SyncDirection::Upload),
            (0..250).map(|i| lf(&format!("f{i:03}"), 10, 1)).collect(),
            vec![],
            false,
        );
        let s = p.summary(7);
        assert_eq!(s.total_actions, 250);
        assert_eq!(s.actions.len(), PREVIEW_ROWS);
        assert!(s.truncated);
        assert_eq!(s.uploads.count, 250);
        assert_eq!(s.uploads.bytes, 2500);
        let small = compute_plan(
            &req(SyncDirection::Upload),
            vec![lf("a", 1, 1)],
            vec![],
            false,
        )
        .summary(8);
        assert!(!small.truncated);
    }

    #[test]
    fn plan_runs_once() {
        let store = PlanStore::default();
        let p = compute_plan(&req(SyncDirection::Upload), vec![], vec![], false);
        let id = store.put(p.clone());
        let id2 = store.put(p);
        assert!(store.take(id).is_none(), "superseded plan can't run");
        assert!(store.take(id2).is_some());
        assert!(store.take(id2).is_none(), "plan runs at most once");
    }
}

#[cfg(test)]
mod emulator_tests {
    //! Needs an S3 emulator on localhost:4566 (see s3.rs tests).
    use super::*;
    use crate::profiles::ProfileInfo;
    use crate::transfers::{transfer_now, Direction};

    async fn connect() -> Connection {
        // SAFETY: single-threaded test run (--test-threads=1).
        unsafe {
            std::env::set_var("AWS_ACCESS_KEY_ID", "test");
            std::env::set_var("AWS_SECRET_ACCESS_KEY", "test");
        }
        let profile = ProfileInfo {
            name: "s3x-sync-test".into(),
            region: Some("us-east-1".into()),
            endpoint_url: None,
            sso_session: None,
        };
        let ovr = crate::settings::ConnectionOverride {
            endpoint_url: Some("http://localhost:4566".into()),
            path_style: None,
        };
        Connection::new(&profile, Some(&ovr)).await.unwrap()
    }

    /// Executes a plan without the Tauri app (transfers run inline).
    async fn execute(conn: &Connection, plan: &FullPlan) {
        let b = &plan.request.bucket;
        for a in &plan.actions {
            match a.kind {
                ActionKind::Upload => transfer_now(conn, Direction::Upload, b, &a.key, &a.local)
                    .await
                    .unwrap(),
                ActionKind::Download => {
                    transfer_now(conn, Direction::Download, b, &a.key, &a.local)
                        .await
                        .unwrap()
                }
                ActionKind::DeleteRemote => {
                    conn.delete_items(b, std::slice::from_ref(&a.key))
                        .await
                        .unwrap();
                }
                ActionKind::DeleteLocal => std::fs::remove_file(&a.local).unwrap(),
            }
        }
    }

    fn request(direction: SyncDirection, dir: &Path) -> SyncRequest {
        SyncRequest {
            direction,
            local_dir: dir.to_string_lossy().into_owned(),
            bucket: "s3x-sync-bucket".into(),
            prefix: "site/".into(),
            delete_extras: false,
            size_only: false,
            excludes: vec!["*.tmp".into()],
        }
    }

    #[tokio::test]
    #[ignore]
    async fn upload_then_download_round_trip() {
        let conn = connect().await;
        let bucket = "s3x-sync-bucket";
        let client = conn.client_for(bucket).await.unwrap();
        let _ = client.create_bucket().bucket(bucket).send().await;
        // Clean slate.
        let existing: Vec<String> = conn
            .list_all(bucket, "")
            .await
            .unwrap()
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        if !existing.is_empty() {
            conn.delete_items(bucket, &existing).await.unwrap();
        }

        let base = std::env::temp_dir().join("s3x-sync");
        let _ = std::fs::remove_dir_all(&base);
        let up = base.join("up");
        std::fs::create_dir_all(up.join("sub")).unwrap();
        std::fs::write(up.join("a.txt"), "hello").unwrap();
        std::fs::write(up.join("sub/b.txt"), "world!").unwrap();
        std::fs::write(up.join("skip.tmp"), "x").unwrap();

        // 1. First upload: two files, the .tmp excluded.
        let p = plan(&conn, request(SyncDirection::Upload, &up))
            .await
            .unwrap();
        let mut got: Vec<_> = p.actions.iter().map(|a| (a.kind, a.key.as_str())).collect();
        got.sort_by_key(|x| x.1);
        assert_eq!(
            got,
            vec![
                (ActionKind::Upload, "site/a.txt"),
                (ActionKind::Upload, "site/sub/b.txt")
            ]
        );
        execute(&conn, &p).await;

        // 2. Repeat: nothing to do.
        let p = plan(&conn, request(SyncDirection::Upload, &up))
            .await
            .unwrap();
        assert!(p.actions.is_empty(), "{:?}", p.actions);
        assert_eq!(p.unchanged, 2);

        // 3. A changed file is detected.
        std::fs::write(up.join("a.txt"), "hello again").unwrap();
        let p = plan(&conn, request(SyncDirection::Upload, &up))
            .await
            .unwrap();
        assert_eq!(p.actions.len(), 1);
        assert_eq!(p.actions[0].reason, "size differs");
        execute(&conn, &p).await;

        // 4. Extra remote file: only deleted with delete_extras.
        client
            .put_object()
            .bucket(bucket)
            .key("site/extra.txt")
            .body(aws_sdk_s3::primitives::ByteStream::from_static(b"e"))
            .send()
            .await
            .unwrap();
        assert!(plan(&conn, request(SyncDirection::Upload, &up))
            .await
            .unwrap()
            .actions
            .is_empty());
        let mut r = request(SyncDirection::Upload, &up);
        r.delete_extras = true;
        let p = plan(&conn, r).await.unwrap();
        assert_eq!(p.actions.len(), 1);
        assert_eq!(p.actions[0].kind, ActionKind::DeleteRemote);

        // 5. Download into an empty folder (it's created); a bad key is skipped.
        client
            .put_object()
            .bucket(bucket)
            .key("site/bad:name.txt")
            .body(aws_sdk_s3::primitives::ByteStream::from_static(b"x"))
            .send()
            .await
            .unwrap();
        let down = base.join("down");
        let p = plan(&conn, request(SyncDirection::Download, &down))
            .await
            .unwrap();
        assert_eq!(p.actions.len(), 3, "{:?}", p.actions); // a, sub/b, extra
        assert_eq!(p.warnings.len(), 1);
        execute(&conn, &p).await;
        assert_eq!(
            std::fs::read_to_string(down.join("sub").join("b.txt")).unwrap(),
            "world!"
        );

        // 6. Repeat download: no-op, which proves mtimes were set from S3.
        let p = plan(&conn, request(SyncDirection::Download, &down))
            .await
            .unwrap();
        assert!(p.actions.is_empty(), "{:?}", p.actions);
        assert_eq!(p.unchanged, 3);

        // 7. Mirror download deletes a local extra.
        std::fs::write(down.join("local-only.txt"), "l").unwrap();
        let mut r = request(SyncDirection::Download, &down);
        r.delete_extras = true;
        let p = plan(&conn, r).await.unwrap();
        assert_eq!(p.actions.len(), 1);
        assert_eq!(p.actions[0].kind, ActionKind::DeleteLocal);
        execute(&conn, &p).await;
        assert!(!down.join("local-only.txt").exists());
    }
}
