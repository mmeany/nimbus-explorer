//! Bookmarks: `<settings dir>/bookmarks.json`, one set for the whole app.
//!
//! The UI keeps the whole file in memory and saves it whole; `normalise`
//! checks every limit and cleans up references here, so a bad save can't
//! corrupt the file. Writes go to a temp file and are renamed (atomic), under
//! a process-wide lock. Local only, so allowed in read-only mode.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_BOOKMARKS: usize = 5_000;
pub const MAX_FOLDERS: usize = 100;
pub const MAX_NAME: usize = 100;
pub const MAX_FOLDER_NAME: usize = 40;
pub const MAX_DESCRIPTION: usize = 200;
const MAX_PLACE: usize = 4_096;
const MAX_ID: usize = 64;
const FILE: &str = "bookmarks.json";
/// Marks an exported file.
pub const EXPORT_FORMAT: &str = "nimbus-explorer-bookmarks";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub profile: String,
    /// Region of the regional services ("" for S3).
    #[serde(default)]
    pub region: String,
    pub service: String,
    /// The app location (a UI `Place`), opaque here.
    pub place: serde_json::Value,
    /// Row to select there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub select: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// UTC ISO time.
    #[serde(default)]
    pub created: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Bookmark ids, in the user's order.
    #[serde(default)]
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BookmarkFile {
    /// "nimbus-explorer-bookmarks" in exported files; empty in the app's own.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub format: String,
    pub version: u32,
    pub bookmarks: Vec<Bookmark>,
    /// The user's folders, in bar order.
    pub folders: Vec<Folder>,
    /// Bookmark ids pinned to the bar, in bar order.
    pub pinned: Vec<String>,
    /// Descriptions of the feature folders, by service id.
    pub feature_notes: BTreeMap<String, String>,
}

static LOCK: Mutex<()> = Mutex::new(());

fn check_len(what: &str, s: &str, min: usize, max: usize) -> Result<(), String> {
    let n = s.chars().count();
    if n < min || n > max {
        return Err(if min > 0 {
            format!("{what} must be {min} to {max} characters")
        } else {
            format!("{what} can be at most {max} characters")
        });
    }
    Ok(())
}

/// Validates the file and removes dangling or repeated references. Errors
/// name the first problem found.
pub fn normalise(mut f: BookmarkFile) -> Result<BookmarkFile, String> {
    f.format = String::new();
    f.version = 1;
    if f.bookmarks.len() > MAX_BOOKMARKS {
        return Err(format!("At most {MAX_BOOKMARKS} bookmarks"));
    }
    if f.folders.len() > MAX_FOLDERS {
        return Err(format!("At most {MAX_FOLDERS} folders"));
    }
    let mut ids = HashSet::new();
    let mut identities: Vec<(&str, &serde_json::Value, Option<&str>)> = Vec::new();
    for b in &mut f.bookmarks {
        b.name = b.name.trim().to_string();
        b.description = b.description.trim().to_string();
        if b.id.is_empty() || b.id.len() > MAX_ID {
            return Err("A bookmark has a missing or overlong id".into());
        }
        if !ids.insert(b.id.clone()) {
            return Err(format!("Bookmark id {} is used twice", b.id));
        }
        check_len("Bookmark names", &b.name, 1, MAX_NAME)?;
        check_len("Descriptions", &b.description, 0, MAX_DESCRIPTION)?;
        if b.profile.is_empty() || b.profile.len() > 256 {
            return Err(format!("Bookmark \"{}\" has no profile", b.name));
        }
        if !b.place.is_object() || b.place.to_string().len() > MAX_PLACE {
            return Err(format!("Bookmark \"{}\" has no valid location", b.name));
        }
        if b.place.get("service").and_then(|s| s.as_str()) != Some(b.service.as_str()) {
            return Err(format!("Bookmark \"{}\" has a location of another service", b.name));
        }
        if b.select.as_deref().is_some_and(|s| s.len() > 2_000) || b.region.len() > 32 {
            return Err(format!("Bookmark \"{}\" is too long", b.name));
        }
    }
    for b in &f.bookmarks {
        let key = (b.profile.as_str(), &b.place, b.select.as_deref());
        if identities.contains(&key) {
            return Err(format!("\"{}\" is bookmarked twice for profile {}", b.name, b.profile));
        }
        identities.push(key);
    }
    let mut names = HashSet::new();
    let mut folder_ids = HashSet::new();
    for folder in &mut f.folders {
        folder.name = folder.name.trim().to_string();
        folder.description = folder.description.trim().to_string();
        if folder.id.is_empty() || folder.id.len() > MAX_ID || !folder_ids.insert(folder.id.clone()) {
            return Err("A folder has a missing or repeated id".into());
        }
        check_len("Folder names", &folder.name, 1, MAX_FOLDER_NAME)?;
        check_len("Descriptions", &folder.description, 0, MAX_DESCRIPTION)?;
        if !names.insert(folder.name.to_lowercase()) {
            return Err(format!("There's already a folder called \"{}\"", folder.name));
        }
        let mut seen = HashSet::new();
        folder.items.retain(|id| ids.contains(id) && seen.insert(id.clone()));
    }
    let mut seen = HashSet::new();
    f.pinned.retain(|id| ids.contains(id) && seen.insert(id.clone()));
    f.feature_notes.retain(|_, v| !v.trim().is_empty());
    for (k, v) in &mut f.feature_notes {
        *v = v.trim().to_string();
        check_len(&format!("The {k} description"), v, 0, MAX_DESCRIPTION)?;
    }
    Ok(f)
}

fn path(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

/// Loads the bookmarks; a missing file is empty, an unreadable one an error
/// (so a later save can't silently replace it).
pub fn load(dir: &Path) -> Result<BookmarkFile, String> {
    let _g = LOCK.lock().unwrap();
    match std::fs::read_to_string(path(dir)) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("bookmarks.json can't be read ({e}); fix or move it to start again")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BookmarkFile { version: 1, ..Default::default() }),
        Err(e) => Err(e.to_string()),
    }
}

fn write_atomic(target: &Path, text: &str) -> Result<(), String> {
    if let Some(d) = target.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = PathBuf::from(format!("{}.tmp", target.to_string_lossy()));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, target).map_err(|e| e.to_string())
}

/// Validates and saves; returns what was stored.
pub fn save(dir: &Path, f: BookmarkFile) -> Result<BookmarkFile, String> {
    let f = normalise(f)?;
    let _g = LOCK.lock().unwrap();
    let text = serde_json::to_string_pretty(&f).map_err(|e| e.to_string())?;
    write_atomic(&path(dir), &text)?;
    Ok(f)
}

/// Writes an export file (the subset the UI chose).
pub fn export(f: BookmarkFile, dest: &Path) -> Result<usize, String> {
    let mut f = normalise(f)?;
    f.format = EXPORT_FORMAT.into();
    let n = f.bookmarks.len();
    let text = serde_json::to_string_pretty(&f).map_err(|e| e.to_string())?;
    write_atomic(dest, &text)?;
    Ok(n)
}

/// Reads a file to import (an export, or a copied bookmarks.json).
pub fn read_import(src: &Path) -> Result<BookmarkFile, String> {
    let meta = std::fs::metadata(src).map_err(|e| e.to_string())?;
    if meta.len() > 20 * 1024 * 1024 {
        return Err("That file is too big to be a bookmarks file".into());
    }
    let text = std::fs::read_to_string(src).map_err(|e| e.to_string())?;
    let f: BookmarkFile = serde_json::from_str(&text).map_err(|e| format!("Not a bookmarks file: {e}"))?;
    if !f.format.is_empty() && f.format != EXPORT_FORMAT {
        return Err("Not a Nimbus Explorer bookmarks file".into());
    }
    normalise(f)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bm(id: &str, profile: &str, place: serde_json::Value) -> Bookmark {
        Bookmark {
            id: id.into(),
            profile: profile.into(),
            region: String::new(),
            service: place["service"].as_str().unwrap().into(),
            place,
            select: None,
            name: format!("name {id}"),
            description: String::new(),
            created: String::new(),
        }
    }

    fn sample() -> BookmarkFile {
        BookmarkFile {
            bookmarks: vec![
                bm("a", "dev", json!({"service": "s3", "bucket": "b", "prefix": ""})),
                bm("b", "dev", json!({"service": "sqs", "queue": "q"})),
            ],
            folders: vec![Folder { id: "f1".into(), name: "Team".into(), description: "x".into(), items: vec!["a".into(), "zz".into(), "a".into()] }],
            pinned: vec!["b".into(), "gone".into()],
            ..Default::default()
        }
    }

    #[test]
    fn normalise_cleans_references() {
        let f = normalise(sample()).unwrap();
        assert_eq!(f.folders[0].items, ["a"]);
        assert_eq!(f.pinned, ["b"]);
        assert_eq!(f.version, 1);
    }

    #[test]
    fn normalise_refuses_bad_files() {
        let mut f = sample();
        f.bookmarks[1].place = json!({"service": "s3", "bucket": "b", "prefix": ""});
        f.bookmarks[1].service = "s3".into();
        assert!(normalise(f).unwrap_err().contains("bookmarked twice"));

        // Same place, other key order: still a duplicate.
        let mut f = sample();
        f.bookmarks[1].place = json!({"prefix": "", "bucket": "b", "service": "s3"});
        f.bookmarks[1].service = "s3".into();
        assert!(normalise(f).is_err());

        // Same place for another profile, or with an item selected, is fine.
        let mut f = sample();
        f.bookmarks[1].place = json!({"service": "s3", "bucket": "b", "prefix": ""});
        f.bookmarks[1].service = "s3".into();
        f.bookmarks[1].select = Some("k".into());
        assert!(normalise(f).is_ok());

        let mut f = sample();
        f.folders.push(Folder { id: "f2".into(), name: " team ".into(), description: String::new(), items: vec![] });
        assert!(normalise(f).unwrap_err().contains("already a folder"));

        let mut f = sample();
        f.bookmarks[0].name = "  ".into();
        assert!(normalise(f).is_err());

        let mut f = sample();
        f.bookmarks[0].description = "d".repeat(201);
        assert!(normalise(f).is_err());

        let mut f = sample();
        f.bookmarks[0].service = "sqs".into();
        assert!(normalise(f).unwrap_err().contains("another service"));

        let mut f = sample();
        f.folders[0].name = "x".repeat(41);
        assert!(normalise(f).is_err());
    }

    #[test]
    fn saves_loads_exports_and_imports() {
        let dir = std::env::temp_dir().join(format!("s3x-bookmarks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(load(&dir).unwrap().bookmarks.is_empty());
        let saved = save(&dir, sample()).unwrap();
        assert_eq!(load(&dir).unwrap(), saved);

        let dest = dir.join("out.json");
        assert_eq!(export(saved.clone(), &dest).unwrap(), 2);
        assert!(std::fs::read_to_string(&dest).unwrap().contains(EXPORT_FORMAT));
        let back = read_import(&dest).unwrap();
        assert_eq!(back.bookmarks, saved.bookmarks);

        std::fs::write(&dest, r#"{"format":"something-else"}"#).unwrap();
        assert!(read_import(&dest).is_err());
        std::fs::write(path(&dir), "{oops").unwrap();
        assert!(load(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
