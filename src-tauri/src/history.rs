//! Activity history: one JSON line per recorded action, appended to
//! `<settings dir>/history/<profile>/<period>[.n].jsonl`.
//!
//! - Files are only ever appended to, so a crash can damage at most the last
//!   line (readers skip lines that don't parse).
//! - A new file starts every period (day / ISO week / month / year, in UTC),
//!   and within a period once the file reaches `max_file_mb` ("2026-11.2.jsonl").
//! - `keep_files` caps the files kept per profile; the oldest go first.
//! - Entries carry names and locations only, never values (the UI's rules in
//!   `src/history/rules.ts` decide what goes in; see the test at the bottom).

use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Period {
    Day,
    Week,
    #[default]
    Month,
    Year,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HistorySettings {
    /// Record actions at all.
    pub enabled: bool,
    pub period: Period,
    /// Also start a new file within a period once the current one reaches
    /// this many MB (0 = no size limit).
    pub max_file_mb: u32,
    /// Files kept per profile (0 = keep every file).
    pub keep_files: u32,
}

impl Default for HistorySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            period: Period::Month,
            max_file_mb: 10,
            keep_files: 24,
        }
    }
}

/// What the UI sends for one action (time, profile and region are added here).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEntry {
    pub service: String,
    pub action: String,
    #[serde(default)]
    pub target: String,
    /// The app location the action happened at (a UI `Place`), opaque here.
    #[serde(default)]
    pub place: Option<serde_json::Value>,
    /// Row to select there (object key, parameter name…).
    #[serde(default)]
    pub select: Option<String>,
    pub ok: bool,
    #[serde(default)]
    pub error_kind: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// UTC, "2026-11-05T09:30:00.123Z" (sorts as text).
    pub time: String,
    pub profile: String,
    /// Region of the regional services at the time ("" for S3, IAM and app events).
    #[serde(default)]
    pub region: String,
    pub service: String,
    pub action: String,
    #[serde(default)]
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub select: Option<String>,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

const MAX_TEXT: usize = 2_000;
const MAX_SHORT: usize = 200;
const MAX_PLACE: usize = 4_096;
const PROFILE_FILE: &str = "profile.txt";

static LOCK: Mutex<()> = Mutex::new(());

fn cap(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let mut end = n;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

impl NewEntry {
    /// Builds the stored entry, capping every field so a bad caller can't
    /// write huge lines.
    pub fn into_entry(self, time_ms: i64, profile: &str, region: &str) -> Entry {
        let place = self
            .place
            .filter(|p| p.is_object() && p.to_string().len() <= MAX_PLACE);
        Entry {
            time: format_time(time_ms),
            profile: profile.to_string(),
            region: region.to_string(),
            service: cap(&self.service, 32),
            action: cap(&self.action, MAX_SHORT),
            target: cap(&self.target, MAX_TEXT),
            place,
            select: self.select.map(|s| cap(&s, MAX_TEXT)),
            ok: self.ok,
            error_kind: self.error_kind.map(|s| cap(&s, 32)),
            message: self.message.map(|s| cap(&s, MAX_TEXT)),
            detail: self.detail.map(|s| cap(&s, MAX_TEXT)),
        }
    }
}

// ---------------------------------------------------------------------------
// Dates (UTC, no date crate): Howard Hinnant's civil-from-days algorithms.

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn format_time(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let (h, mi, s, milli) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

/// The file name stem for the period containing `ms`.
pub fn period_key(period: Period, ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    match period {
        Period::Day => format!("{y:04}-{m:02}-{d:02}"),
        Period::Month => format!("{y:04}-{m:02}"),
        Period::Year => format!("{y:04}"),
        Period::Week => {
            // ISO 8601: the week belongs to the year its Thursday is in.
            let weekday = (days + 3).rem_euclid(7) + 1; // Monday = 1 (1970-01-01 was a Thursday)
            let thursday = days - (weekday - 1) + 3;
            let (ty, _, _) = civil_from_days(thursday);
            let week = (thursday - days_from_civil(ty, 1, 1)) / 7 + 1;
            format!("{ty:04}-W{week:02}")
        }
    }
}

// ---------------------------------------------------------------------------
// Files

/// `<history dir>/<profile>` with the profile made safe as a folder name.
pub fn profile_dir(root: &Path, profile: &str) -> PathBuf {
    root.join(crate::transfers::safe_segment(profile))
}

/// "2026-11.jsonl" -> ("2026-11", 1); "2026-11.3.jsonl" -> ("2026-11", 3).
fn parse_name(name: &str) -> Option<(String, u32)> {
    let stem = name.strip_suffix(".jsonl")?;
    match stem.rsplit_once('.') {
        Some((base, n)) if n.parse::<u32>().is_ok() => Some((base.to_string(), n.parse().ok()?)),
        _ => Some((stem.to_string(), 1)),
    }
}

fn file_name(base: &str, n: u32) -> String {
    if n <= 1 {
        format!("{base}.jsonl")
    } else {
        format!("{base}.{n}.jsonl")
    }
}

/// History files of one profile, newest first (by last write, then name).
pub fn list_files(dir: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(std::time::SystemTime, (String, u32), String)> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let parsed = parse_name(&name)?;
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((modified, parsed, name))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    files.into_iter().map(|f| f.2).collect()
}

/// Deletes the oldest files beyond `keep` (0 = keep all). Returns how many went.
fn prune(dir: &Path, keep: u32) -> usize {
    if keep == 0 {
        return 0;
    }
    let files = list_files(dir);
    let mut removed = 0;
    for f in files.iter().skip(keep as usize) {
        if std::fs::remove_file(dir.join(f)).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Applies `keep_files` to every profile's folder (after a settings change).
pub fn prune_all(root: &Path, keep: u32) {
    let _g = LOCK.lock().unwrap();
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.filter_map(|e| e.ok()) {
            if e.path().is_dir() {
                prune(&e.path(), keep);
            }
        }
    }
}

/// The file the next entry goes into (creating none yet).
fn current_file(dir: &Path, settings: &HistorySettings, ms: i64) -> PathBuf {
    let base = period_key(settings.period, ms);
    let mut n = 1;
    while dir.join(file_name(&base, n + 1)).exists() {
        n += 1;
    }
    let path = dir.join(file_name(&base, n));
    let limit = settings.max_file_mb as u64 * 1024 * 1024;
    if limit > 0 {
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() >= limit {
                return dir.join(file_name(&base, n + 1));
            }
        }
    }
    path
}

/// Appends one entry for its profile.
pub fn append(root: &Path, settings: &HistorySettings, entry: &Entry, ms: i64) -> Result<(), String> {
    let _g = LOCK.lock().unwrap();
    let dir = profile_dir(root, &entry.profile);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let marker = dir.join(PROFILE_FILE);
    if !marker.exists() {
        // The real profile name (the folder name may have been sanitised).
        let _ = std::fs::write(&marker, &entry.profile);
    }
    let path = current_file(&dir, settings, ms);
    let is_new = !path.exists();
    let mut line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    drop(f);
    if is_new {
        prune(&dir, settings.keep_files);
    }
    Ok(())
}

/// Profiles that have a history folder (real names), sorted.
pub fn profiles(root: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter(|e| !list_files(&e.path()).is_empty())
        .map(|e| {
            std::fs::read_to_string(e.path().join(PROFILE_FILE))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| e.file_name().to_string_lossy().into_owned())
        })
        .collect();
    out.sort_by_key(|s| s.to_lowercase());
    out.dedup();
    out
}

/// Removes one profile's history.
pub fn clear(root: &Path, profile: &str) -> Result<(), String> {
    let _g = LOCK.lock().unwrap();
    let dir = profile_dir(root, profile);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Reading

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    pub profile: String,
    pub service: Option<String>,
    /// Case-insensitive text in action, target, detail or message.
    pub text: Option<String>,
    pub failed_only: bool,
    /// ISO times (UTC), inclusive.
    pub from: Option<String>,
    pub to: Option<String>,
}

impl Query {
    fn matches(&self, e: &Entry) -> bool {
        if self.failed_only && e.ok {
            return false;
        }
        if let Some(s) = self.service.as_deref().filter(|s| !s.is_empty()) {
            if e.service != s {
                return false;
            }
        }
        if let Some(f) = self.from.as_deref().filter(|s| !s.is_empty()) {
            if e.time.as_str() < f {
                return false;
            }
        }
        if let Some(t) = self.to.as_deref().filter(|s| !s.is_empty()) {
            if e.time.as_str() > t {
                return false;
            }
        }
        if let Some(t) = self.text.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let t = t.to_lowercase();
            let hit = [&e.action, &e.target]
                .into_iter()
                .chain(e.detail.as_ref())
                .chain(e.message.as_ref())
                .any(|s| s.to_lowercase().contains(&t));
            if !hit {
                return false;
            }
        }
        true
    }
}

/// Where the next page continues: before line `line` of `file`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    pub file: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    /// Newest first.
    pub entries: Vec<Entry>,
    pub next: Option<Cursor>,
    /// Lines that couldn't be read (e.g. cut short by a crash).
    pub skipped: usize,
}

fn read_lines(path: &Path) -> Vec<String> {
    match std::fs::File::open(path) {
        Ok(f) => std::io::BufReader::new(f).lines().map_while(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

/// Walks entries newest first, calling `f` for each match until it returns
/// false. Returns where it stopped (None = reached the oldest) and the number
/// of unreadable lines.
fn walk(
    root: &Path,
    q: &Query,
    start: Option<&Cursor>,
    mut f: impl FnMut(Entry) -> bool,
) -> (Option<Cursor>, usize) {
    let dir = profile_dir(root, &q.profile);
    let files = list_files(&dir);
    let mut skipped = 0;
    let mut started = start.is_none();
    for file in files {
        let lines = read_lines(&dir.join(&file));
        let mut end = lines.len();
        if !started {
            match start {
                Some(c) if c.file == file => {
                    started = true;
                    end = c.line.min(lines.len());
                }
                _ => continue,
            }
        }
        for i in (0..end).rev() {
            let line = lines[i].trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<Entry>(line) {
                Ok(e) => {
                    if q.matches(&e) && !f(e) {
                        return (Some(Cursor { file, line: i }), skipped);
                    }
                }
                Err(_) => skipped += 1,
            }
        }
    }
    (None, skipped)
}

/// One page of entries, newest first.
pub fn page(root: &Path, q: &Query, cursor: Option<&Cursor>, limit: usize) -> Page {
    let limit = limit.clamp(1, 1000);
    let mut entries = Vec::new();
    let (mut next, skipped) = walk(root, q, cursor, |e| {
        entries.push(e);
        entries.len() < limit
    });
    // Stopped exactly at the limit: is anything older left?
    if let Some(c) = &next {
        let mut more = false;
        walk(root, q, Some(c), |_| {
            more = true;
            false
        });
        if !more {
            next = None;
        }
    }
    Page {
        entries,
        next,
        skipped,
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Csv,
    Json,
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Writes every matching entry (newest first) to `dest`. Returns the count.
pub fn export(root: &Path, q: &Query, format: ExportFormat, dest: &Path) -> Result<usize, String> {
    let mut all = Vec::new();
    walk(root, q, None, |e| {
        all.push(e);
        true
    });
    let text = match format {
        ExportFormat::Json => serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?,
        ExportFormat::Csv => {
            let mut out = String::from("time,profile,region,service,action,target,result,detail,message\r\n");
            for e in &all {
                let result = if e.ok {
                    "ok".to_string()
                } else {
                    e.error_kind.clone().unwrap_or_else(|| "failed".into())
                };
                let fields = [
                    e.time.as_str(),
                    &e.profile,
                    &e.region,
                    &e.service,
                    &e.action,
                    &e.target,
                    &result,
                    e.detail.as_deref().unwrap_or(""),
                    e.message.as_deref().unwrap_or(""),
                ];
                out.push_str(&fields.map(csv_field).join(","));
                out.push_str("\r\n");
            }
            out
        }
    };
    let part = PathBuf::from(format!("{}.s3x-part", dest.to_string_lossy()));
    std::fs::write(&part, text).map_err(|e| e.to_string())?;
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    Ok(all.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400_000;

    fn ms(y: i64, m: u32, d: u32) -> i64 {
        days_from_civil(y, m, d) * DAY
    }

    #[test]
    fn dates_round_trip() {
        for days in [-1000, 0, 1, 59, 365, 10_957, 20_000, 30_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(format_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_time(ms(2026, 11, 5) + 3_723_004), "2026-11-05T01:02:03.004Z");
    }

    #[test]
    fn period_keys() {
        let t = ms(2026, 11, 5);
        assert_eq!(period_key(Period::Day, t), "2026-11-05");
        assert_eq!(period_key(Period::Month, t), "2026-11");
        assert_eq!(period_key(Period::Year, t), "2026");
        assert_eq!(period_key(Period::Week, t), "2026-W45");
        // ISO week edge cases.
        assert_eq!(period_key(Period::Week, ms(2021, 1, 3)), "2020-W53");
        assert_eq!(period_key(Period::Week, ms(2024, 12, 30)), "2025-W01");
        assert_eq!(period_key(Period::Week, ms(2026, 1, 1)), "2026-W01");
    }

    #[test]
    fn names_parse() {
        assert_eq!(parse_name("2026-11.jsonl"), Some(("2026-11".into(), 1)));
        assert_eq!(parse_name("2026-11.3.jsonl"), Some(("2026-11".into(), 3)));
        assert_eq!(parse_name("profile.txt"), None);
        assert_eq!(file_name("2026", 1), "2026.jsonl");
        assert_eq!(file_name("2026", 2), "2026.2.jsonl");
    }

    fn entry(profile: &str, action: &str, ok: bool, t: i64) -> Entry {
        NewEntry {
            service: "s3".into(),
            action: action.into(),
            target: format!("s3://b/{action}"),
            place: Some(serde_json::json!({"service": "s3", "bucket": "b", "prefix": ""})),
            select: None,
            ok,
            error_kind: (!ok).then(|| "accessDenied".into()),
            message: None,
            detail: None,
        }
        .into_entry(t, profile, "")
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("s3x-history-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn appends_pages_and_filters() {
        let root = temp("pages");
        let s = HistorySettings::default();
        let t = ms(2026, 10, 30);
        for i in 0..5 {
            append(&root, &s, &entry("dev", &format!("a{i}"), i != 2, t + i), t + i).unwrap();
        }
        // Next month: a new file.
        let t2 = ms(2026, 11, 2);
        std::thread::sleep(std::time::Duration::from_millis(20));
        for i in 5..8 {
            append(&root, &s, &entry("dev", &format!("a{i}"), true, t2 + i), t2 + i).unwrap();
        }
        let dir = profile_dir(&root, "dev");
        assert_eq!(list_files(&dir), ["2026-11.jsonl", "2026-10.jsonl"]);

        let q = Query { profile: "dev".into(), ..Default::default() };
        let p1 = page(&root, &q, None, 3);
        assert_eq!(p1.entries.iter().map(|e| e.action.as_str()).collect::<Vec<_>>(), ["a7", "a6", "a5"]);
        let p2 = page(&root, &q, p1.next.as_ref(), 3);
        assert_eq!(p2.entries.iter().map(|e| e.action.as_str()).collect::<Vec<_>>(), ["a4", "a3", "a2"]);
        let p3 = page(&root, &q, p2.next.as_ref(), 3);
        assert_eq!(p3.entries.len(), 2);
        assert!(p3.next.is_none());

        let failed = Query { profile: "dev".into(), failed_only: true, ..Default::default() };
        assert_eq!(page(&root, &failed, None, 10).entries[0].action, "a2");
        let text = Query { profile: "dev".into(), text: Some("A6".into()), ..Default::default() };
        assert_eq!(page(&root, &text, None, 10).entries.len(), 1);
        let range = Query { profile: "dev".into(), from: Some(format_time(t2)), ..Default::default() };
        assert_eq!(page(&root, &range, None, 10).entries.len(), 3);
        // Exactly one page: no "more".
        assert!(page(&root, &q, None, 8).next.is_none());

        assert_eq!(profiles(&root), ["dev"]);
        clear(&root, "dev").unwrap();
        assert!(page(&root, &q, None, 10).entries.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rolls_over_by_size_and_prunes() {
        let root = temp("size");
        let s = HistorySettings { period: Period::Year, max_file_mb: 0, keep_files: 2, enabled: true };
        let t = ms(2026, 1, 1);
        append(&root, &s, &entry("p", "x", true, t), t).unwrap();
        let dir = profile_dir(&root, "p");
        // Fake a full file, then switch the size limit on.
        let big = dir.join("2026.jsonl");
        let f = std::fs::OpenOptions::new().write(true).open(&big).unwrap();
        f.set_len(1024 * 1024 + 10).unwrap();
        let s = HistorySettings { max_file_mb: 1, ..s };
        std::thread::sleep(std::time::Duration::from_millis(20));
        append(&root, &s, &entry("p", "y", true, t), t).unwrap();
        assert!(dir.join("2026.2.jsonl").exists());
        // A third file pushes out the oldest.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let t2 = ms(2027, 1, 1);
        append(&root, &s, &entry("p", "z", true, t2), t2).unwrap();
        assert_eq!(list_files(&dir), ["2027.jsonl", "2026.2.jsonl"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn damaged_lines_are_skipped_and_fields_capped() {
        let root = temp("damaged");
        let s = HistorySettings::default();
        let t = ms(2026, 11, 5);
        append(&root, &s, &entry("p", "good", true, t), t).unwrap();
        let file = profile_dir(&root, "p").join("2026-11.jsonl");
        let mut f = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
        f.write_all(b"{\"time\":\"2026-11").unwrap();
        let p = page(&root, &Query { profile: "p".into(), ..Default::default() }, None, 10);
        assert_eq!(p.entries.len(), 1);
        assert_eq!(p.skipped, 1);

        let long = NewEntry {
            service: "s3".into(),
            action: "x".repeat(500),
            target: "é".repeat(3000),
            place: Some(serde_json::json!("not an object")),
            select: None,
            ok: true,
            error_kind: None,
            message: None,
            detail: None,
        }
        .into_entry(t, "p", "");
        assert!(long.action.len() <= MAX_SHORT + 3);
        assert!(long.target.len() <= MAX_TEXT + 3);
        assert!(long.place.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn exports_csv() {
        let root = temp("export");
        let s = HistorySettings::default();
        let t = ms(2026, 11, 5);
        let mut e = entry("p", "Delete", false, t);
        e.detail = Some("2 items, \"quoted\"".into());
        append(&root, &s, &e, t).unwrap();
        let dest = root.join("out.csv");
        let n = export(&root, &Query { profile: "p".into(), ..Default::default() }, ExportFormat::Csv, &dest).unwrap();
        assert_eq!(n, 1);
        let text = std::fs::read_to_string(&dest).unwrap();
        assert!(text.contains("accessDenied,\"2 items, \"\"quoted\"\"\""));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Every command that calls `ensure_writable` must have a history rule in
    /// the UI, so new write commands can't silently go unrecorded.
    #[test]
    fn every_write_command_has_a_history_rule() {
        let rules = include_str!("../../src/history/rules.ts");
        let sources = [
            include_str!("commands/mod.rs"),
            include_str!("commands/s3.rs"),
            include_str!("commands/ssm.rs"),
            include_str!("commands/sqs.rs"),
            include_str!("commands/sns.rs"),
            include_str!("commands/dynamo.rs"),
            include_str!("commands/rds.rs"),
            include_str!("commands/ecs.rs"),
            include_str!("commands/lambda.rs"),
            include_str!("commands/sfn.rs"),
            include_str!("commands/elasticache.rs"),
            include_str!("commands/ec2.rs"),
            include_str!("commands/logs.rs"),
            include_str!("commands/secrets.rs"),
        ];
        let mut missing = Vec::new();
        for src in sources {
            for chunk in src.split("#[tauri::command]").skip(1) {
                let Some(after) = chunk.split("fn ").nth(1) else { continue };
                let name: String = after.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                // Only this command's body: up to the next top-level item.
                let body = chunk.split("\n}\n").next().unwrap_or(chunk);
                if body.contains("ensure_writable") && !rules.contains(&format!("  {name}:")) {
                    missing.push(name);
                }
            }
        }
        assert!(missing.is_empty(), "no history rule in src/history/rules.ts for: {missing:?}");
    }
}
