//! DynamoDB export (results or a whole table, cancellable) and import with a
//! preview. Progress goes through a callback so the logic is testable; the
//! commands forward it as `ddb-progress` events.

use crate::ddb_items::{self, item_to_json, json_to_item, JsonItem, WriteReport};
use crate::dynamo::{client, err, other};
use crate::error::AppError;
use crate::s3::Connection;
use aws_sdk_dynamodb::types::{AttributeValue, KeysAndAttributes, PutRequest, WriteRequest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    /// One DynamoDB-JSON item per line (lossless; re-importable).
    DynamoJsonl,
    /// One plain-JSON item per line (markers for sets / binary / big numbers).
    PlainJsonl,
    /// Comma-separated; nested values as JSON text.
    Csv,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub job: u64,
    pub done: u64,
    pub total: Option<u64>,
    pub finished: bool,
}

/// Jobs the user asked to cancel.
static CANCELLED: Mutex<BTreeSet<u64>> = Mutex::new(BTreeSet::new());

pub fn cancel(job: u64) {
    CANCELLED.lock().unwrap().insert(job);
}

fn is_cancelled(job: u64) -> bool {
    CANCELLED.lock().unwrap().contains(&job)
}

fn forget(job: u64) {
    CANCELLED.lock().unwrap().remove(&job);
}

/// DynamoDB JSON value → plain JSON (same markers as the UI's ddbJson.ts).
pub fn to_plain(v: &Value) -> Value {
    let Some((t, inner)) = v.as_object().and_then(|o| o.iter().next()) else {
        return Value::Null;
    };
    match t.as_str() {
        "S" | "BOOL" => inner.clone(),
        "NULL" => Value::Null,
        "N" => {
            let s = inner.as_str().unwrap_or("0");
            match s.parse::<f64>() {
                // Plain number only when it survives the trip exactly.
                Ok(f)
                    if f.is_finite()
                        && serde_json::Number::from_f64(f)
                            .is_some_and(|n| canonical(&n.to_string()) == canonical(s)) =>
                {
                    if f.fract() == 0.0 && f.abs() < 9.0e15 {
                        json!(f as i64)
                    } else {
                        json!(f)
                    }
                }
                _ => json!({ "$N": s }),
            }
        }
        "B" => json!({ "$B": inner }),
        "M" => Value::Object(
            inner
                .as_object()
                .map(|m| m.iter().map(|(k, x)| (k.clone(), to_plain(x))).collect())
                .unwrap_or_default(),
        ),
        "L" => Value::Array(
            inner
                .as_array()
                .map(|l| l.iter().map(to_plain).collect())
                .unwrap_or_default(),
        ),
        "SS" => json!({ "$SS": inner }),
        "NS" => json!({ "$NS": inner }),
        "BS" => json!({ "$BS": inner }),
        _ => Value::Null,
    }
}

fn canonical(n: &str) -> String {
    let mut t = n.trim().trim_start_matches('+').to_string();
    let neg = t.starts_with('-');
    if neg {
        t.remove(0);
    }
    if t.contains(['e', 'E']) {
        return format!("{}{}", if neg { "-" } else { "" }, t.to_lowercase());
    }
    let (i, f) = t.split_once('.').unwrap_or((&t, ""));
    let i = i.trim_start_matches('0');
    let f = f.trim_end_matches('0');
    let body = match (i.is_empty(), f.is_empty()) {
        (true, true) => return "0".into(),
        (_, true) => i.to_string(),
        (true, false) => format!("0.{f}"),
        (false, false) => format!("{i}.{f}"),
    };
    format!("{}{body}", if neg { "-" } else { "" })
}

/// Plain JSON value → DynamoDB JSON (inverse of `to_plain`).
pub fn from_plain(v: &Value, path: &str) -> Result<Value, String> {
    Ok(match v {
        Value::Null => json!({ "NULL": true }),
        Value::Bool(b) => json!({ "BOOL": b }),
        Value::Number(n) => json!({ "N": n.to_string() }),
        Value::String(s) => json!({ "S": s }),
        Value::Array(a) => {
            json!({ "L": a.iter().enumerate().map(|(i, x)| from_plain(x, &format!("{path}[{i}]"))).collect::<Result<Vec<_>, _>>()? })
        }
        Value::Object(o) => {
            if o.len() == 1 {
                let (k, x) = o.iter().next().unwrap();
                let strs = |x: &Value| -> Result<Vec<Value>, String> {
                    x.as_array()
                        .filter(|a| !a.is_empty())
                        .map(|a| {
                            a.iter()
                                .map(|e| {
                                    Value::String(
                                        e.as_str()
                                            .map(String::from)
                                            .unwrap_or_else(|| e.to_string()),
                                    )
                                })
                                .collect()
                        })
                        .ok_or_else(|| format!("{path}: {k} needs a non-empty array"))
                };
                match k.as_str() {
                    "$N" => {
                        return Ok(
                            json!({ "N": x.as_str().map(String::from).unwrap_or_else(|| x.to_string()) }),
                        )
                    }
                    "$B" => return Ok(json!({ "B": x })),
                    "$SS" => return Ok(json!({ "SS": strs(x)? })),
                    "$NS" => return Ok(json!({ "NS": strs(x)? })),
                    "$BS" => return Ok(json!({ "BS": strs(x)? })),
                    _ => {}
                }
            }
            json!({ "M": o.iter().map(|(k, x)| Ok((k.clone(), from_plain(x, &format!("{path}.{k}"))?))).collect::<Result<Map<_, _>, String>>()? })
        }
    })
}

fn csv_cell(v: Option<&Value>) -> String {
    let text = match v.map(|x| (x, x.as_object().and_then(|o| o.iter().next()))) {
        None => String::new(),
        Some((_, Some((t, inner)))) if t == "S" || t == "N" => {
            inner.as_str().unwrap_or_default().to_string()
        }
        Some((_, Some((t, inner)))) if t == "BOOL" => inner.to_string(),
        Some((_, Some((t, _)))) if t == "NULL" => String::new(),
        Some((x, _)) => to_plain(x).to_string(),
    };
    if text.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

/// Writes items in the chosen format. For CSV, `columns` is the header; any
/// attributes not in it go into a final `_other` JSON column.
struct Writer {
    file: tokio::fs::File,
    format: ExportFormat,
    columns: Option<Vec<String>>,
}

impl Writer {
    async fn create(path: &str, format: ExportFormat) -> Result<Self, AppError> {
        let file = tokio::fs::File::create(path)
            .await
            .map_err(|e| other(format!("Couldn't create {path}: {e}")))?;
        Ok(Self {
            file,
            format,
            columns: None,
        })
    }

    async fn write_items(
        &mut self,
        items: &[JsonItem],
        key_attrs: &[String],
    ) -> Result<(), AppError> {
        let mut out = String::new();
        match self.format {
            ExportFormat::DynamoJsonl => {
                for it in items {
                    out.push_str(&Value::Object(it.clone()).to_string());
                    out.push('\n');
                }
            }
            ExportFormat::PlainJsonl => {
                for it in items {
                    let plain: Map<String, Value> =
                        it.iter().map(|(k, v)| (k.clone(), to_plain(v))).collect();
                    out.push_str(&Value::Object(plain).to_string());
                    out.push('\n');
                }
            }
            ExportFormat::Csv => {
                if self.columns.is_none() {
                    // Header from the keys and the first batch's attributes.
                    let mut cols: Vec<String> = key_attrs.to_vec();
                    for it in items {
                        for k in it.keys() {
                            if !cols.contains(k) {
                                cols.push(k.clone());
                            }
                        }
                    }
                    let mut header: Vec<String> = cols
                        .iter()
                        .map(|c| csv_cell(Some(&json!({ "S": c }))))
                        .collect();
                    header.push("_other".into());
                    out.push_str(&header.join(","));
                    out.push_str("\r\n");
                    self.columns = Some(cols);
                }
                let cols = self.columns.as_ref().unwrap();
                for it in items {
                    let mut row: Vec<String> = cols.iter().map(|c| csv_cell(it.get(c))).collect();
                    let extra: Map<String, Value> = it
                        .iter()
                        .filter(|(k, _)| !cols.contains(k))
                        .map(|(k, v)| (k.clone(), to_plain(v)))
                        .collect();
                    row.push(if extra.is_empty() {
                        String::new()
                    } else {
                        csv_cell(Some(&json!({ "S": Value::Object(extra).to_string() })))
                    });
                    out.push_str(&row.join(","));
                    out.push_str("\r\n");
                }
            }
        }
        self.file
            .write_all(out.as_bytes())
            .await
            .map_err(|e| other(format!("Couldn't write the export: {e}")))
    }

    async fn finish(mut self) -> Result<(), AppError> {
        self.file.flush().await.map_err(|e| other(e.to_string()))
    }
}

/// Writes items already loaded in the UI.
pub async fn export_items(
    items: &[JsonItem],
    key_attrs: &[String],
    format: ExportFormat,
    dest: &str,
) -> Result<usize, AppError> {
    let mut w = Writer::create(dest, format).await?;
    w.write_items(items, key_attrs).await?;
    w.finish().await?;
    Ok(items.len())
}

/// Scans the whole table into `dest`, page by page. Cancelling keeps what
/// was written so far. Returns (items written, cancelled).
#[allow(clippy::too_many_arguments)]
pub async fn export_table(
    conn: &Connection,
    table: &str,
    key_attrs: &[String],
    format: ExportFormat,
    dest: &str,
    job: u64,
    total: Option<u64>,
    progress: &(dyn Fn(Progress) + Send + Sync),
) -> Result<(u64, bool), AppError> {
    let client = client(conn);
    let mut w = Writer::create(dest, format).await?;
    let mut done = 0u64;
    let mut start: Option<HashMap<String, AttributeValue>> = None;
    let mut cancelled = false;
    loop {
        if is_cancelled(job) {
            cancelled = true;
            break;
        }
        let out = client
            .scan()
            .table_name(table)
            .set_exclusive_start_key(start)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        let items: Vec<JsonItem> = out.items().iter().map(item_to_json).collect();
        w.write_items(&items, key_attrs).await?;
        done += items.len() as u64;
        progress(Progress {
            job,
            done,
            total,
            finished: false,
        });
        start = out.last_evaluated_key().filter(|k| !k.is_empty()).cloned();
        if start.is_none() {
            break;
        }
    }
    w.finish().await?;
    forget(job);
    progress(Progress {
        job,
        done,
        total,
        finished: true,
    });
    Ok((done, cancelled))
}

// ---------------------------------------------------------------------------
// Import

/// Parses a JSON array or JSON-lines file of items, in DynamoDB JSON or plain
/// JSON (detected: DynamoDB JSON when every attribute is a one-key object with
/// a type name). Returns DynamoDB-JSON items.
pub fn parse_items(text: &str) -> Result<(Vec<JsonItem>, bool), String> {
    let t = text.trim_start().trim_start_matches('\u{feff}');
    let values: Vec<Value> = if t.starts_with('[') {
        serde_json::from_str(t).map_err(|e| format!("Not a valid JSON array: {e}"))?
    } else {
        t.lines()
            .enumerate()
            .filter(|(_, l)| !l.trim().is_empty())
            .map(|(i, l)| serde_json::from_str(l).map_err(|e| format!("Line {}: {e}", i + 1)))
            .collect::<Result<_, _>>()?
    };
    const TYPES: [&str; 10] = ["S", "N", "B", "BOOL", "NULL", "M", "L", "SS", "NS", "BS"];
    let is_ddb = |v: &Value| {
        v.as_object().is_some_and(|o| {
            !o.is_empty()
                && o.values().all(|a| {
                    a.as_object().is_some_and(|x| {
                        x.len() == 1 && TYPES.contains(&x.keys().next().unwrap().as_str())
                    })
                })
        })
    };
    let ddb = !values.is_empty() && values.iter().all(is_ddb);
    let items = values
        .into_iter()
        .enumerate()
        .map(|(i, v)| {
            let obj = v
                .as_object()
                .ok_or_else(|| format!("Item {}: expected a JSON object", i + 1))?;
            if ddb {
                Ok(obj.clone())
            } else {
                obj.iter()
                    .map(|(k, x)| Ok((k.clone(), from_plain(x, &format!("item {} {k}", i + 1))?)))
                    .collect::<Result<JsonItem, String>>()
            }
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok((items, ddb))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub plan_id: u64,
    pub count: usize,
    pub dynamo_json: bool,
    /// First few items (plain JSON).
    pub samples: Vec<Value>,
    /// Items that can't be written (missing / wrongly typed keys, bad values).
    pub problems: Vec<(usize, String)>,
    pub problem_count: usize,
    /// Valid items whose key already exists in the table (None if not checked).
    pub existing: Option<usize>,
    pub duplicates_in_file: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub written: usize,
    pub skipped_existing: usize,
    pub failed: Vec<(usize, String)>,
}

struct Plan {
    table: String,
    key_attrs: Vec<String>,
    items: Vec<JsonItem>,
}

static PLANS: Mutex<Option<(u64, Plan)>> = Mutex::new(None);
static NEXT_PLAN: Mutex<u64> = Mutex::new(0);

/// Most items whose existence the preview checks (BatchGetItem, 100 per call).
const EXISTENCE_CHECK_LIMIT: usize = 20_000;

fn key_of(item: &JsonItem, key_attrs: &[String]) -> Option<String> {
    key_attrs
        .iter()
        .map(|k| item.get(k).map(|v| v.to_string()))
        .collect::<Option<Vec<_>>>()
        .map(|v| v.join("\u{1}"))
}

/// Reads the file, validates keys and checks which items already exist.
pub async fn plan_import(
    conn: &Connection,
    table: &str,
    key_attrs: &[String],
    key_types: &[String],
    path: &str,
) -> Result<ImportPreview, AppError> {
    let text = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| other(format!("Couldn't read {path}: {e}")))?;
    let (items, ddb) = parse_items(&text).map_err(other)?;
    let mut problems = Vec::new();
    let mut valid = Vec::new();
    let mut seen = BTreeSet::new();
    let mut dups = 0;
    for (i, it) in items.iter().enumerate() {
        let mut problem = None;
        for (k, t) in key_attrs.iter().zip(key_types) {
            match it
                .get(k)
                .and_then(|v| v.as_object())
                .and_then(|o| o.keys().next())
            {
                None => problem = Some(format!("missing key attribute \"{k}\"")),
                Some(actual) if actual != t => {
                    problem = Some(format!("\"{k}\" must be {t}, not {actual}"))
                }
                _ => {}
            }
        }
        if problem.is_none() {
            if let Err(e) = json_to_item(it) {
                problem = Some(e.message);
            }
        }
        match problem {
            Some(p) => problems.push((i, p)),
            None => {
                if !seen.insert(key_of(it, key_attrs).unwrap_or_default()) {
                    dups += 1;
                }
                valid.push(it.clone());
            }
        }
    }
    let existing = if valid.len() <= EXISTENCE_CHECK_LIMIT {
        Some(count_existing(conn, table, key_attrs, &valid).await?.len())
    } else {
        None
    };
    let samples = items
        .iter()
        .take(5)
        .map(|it| Value::Object(it.iter().map(|(k, v)| (k.clone(), to_plain(v))).collect()))
        .collect();
    let mut n = NEXT_PLAN.lock().unwrap();
    *n += 1;
    let plan_id = *n;
    let count = items.len();
    let problem_count = problems.len();
    problems.truncate(50);
    *PLANS.lock().unwrap() = Some((
        plan_id,
        Plan {
            table: table.into(),
            key_attrs: key_attrs.to_vec(),
            items: valid,
        },
    ));
    Ok(ImportPreview {
        plan_id,
        count,
        dynamo_json: ddb,
        samples,
        problems,
        problem_count,
        existing,
        duplicates_in_file: dups,
    })
}

/// Keys (as `key_of` strings) of items that exist in the table.
async fn count_existing(
    conn: &Connection,
    table: &str,
    key_attrs: &[String],
    items: &[JsonItem],
) -> Result<BTreeSet<String>, AppError> {
    let client = client(conn);
    let mut found = BTreeSet::new();
    let mut unique: Vec<&JsonItem> = Vec::new();
    let mut seen = BTreeSet::new();
    for it in items {
        if seen.insert(key_of(it, key_attrs).unwrap_or_default()) {
            unique.push(it);
        }
    }
    for chunk in unique.chunks(100) {
        let keys = chunk
            .iter()
            .map(|it| {
                let k: JsonItem = key_attrs
                    .iter()
                    .filter_map(|a| it.get(a).map(|v| (a.clone(), v.clone())))
                    .collect();
                json_to_item(&k)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut pending = Some(
            KeysAndAttributes::builder()
                .set_keys(Some(keys))
                .build()
                .map_err(|e| other(e.to_string()))?,
        );
        let mut tries = 0;
        while let Some(req) = pending.take() {
            let out = client
                .batch_get_item()
                .request_items(table, req)
                .send()
                .await
                .map_err(|e| err(conn, e))?;
            for it in out
                .responses()
                .and_then(|r| r.get(table))
                .into_iter()
                .flatten()
            {
                if let Some(k) = key_of(&item_to_json(it), key_attrs) {
                    found.insert(k);
                }
            }
            if let Some(more) = out
                .unprocessed_keys()
                .and_then(|u| u.get(table))
                .filter(|k| !k.keys().is_empty())
            {
                tries += 1;
                if tries > 6 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100 * 2u64.pow(tries))).await;
                pending = Some(more.clone());
            }
        }
    }
    Ok(found)
}

/// Runs the previewed import once. Without `overwrite`, existing items are
/// skipped (conditional puts); with it, items are written in batches of 25.
pub async fn run_import(
    conn: &Connection,
    plan_id: u64,
    overwrite: bool,
    job: u64,
    progress: &(dyn Fn(Progress) + Send + Sync),
) -> Result<ImportResult, AppError> {
    let plan = {
        let mut cur = PLANS.lock().unwrap();
        match cur.as_ref() {
            Some((id, _)) if *id == plan_id => cur.take().map(|(_, p)| p),
            _ => None,
        }
    }
    .ok_or_else(|| other("This preview has expired; preview the import again"))?;
    let total = plan.items.len() as u64;
    let mut res = ImportResult {
        written: 0,
        skipped_existing: 0,
        failed: Vec::new(),
    };
    if overwrite {
        for (c, chunk) in plan.items.chunks(25 * 4).enumerate() {
            if is_cancelled(job) {
                break;
            }
            let reqs = chunk
                .iter()
                .map(|it| {
                    Ok(WriteRequest::builder()
                        .put_request(
                            PutRequest::builder()
                                .set_item(Some(json_to_item(it)?))
                                .build()
                                .map_err(|e| other(e.to_string()))?,
                        )
                        .build())
                })
                .collect::<Result<Vec<_>, AppError>>()?;
            let WriteReport { done, failed } =
                ddb_items::batch_write(conn, &plan.table, reqs).await?;
            res.written += done;
            res.failed
                .extend(failed.into_iter().map(|(i, m)| (c * 100 + i, m)));
            progress(Progress {
                job,
                done: (res.written + res.failed.len()) as u64,
                total: Some(total),
                finished: false,
            });
        }
    } else {
        for (i, it) in plan.items.iter().enumerate() {
            if is_cancelled(job) {
                break;
            }
            match ddb_items::put_item(conn, &plan.table, &plan.key_attrs, it, Some(false)).await {
                Ok(()) => res.written += 1,
                Err(e) if e.message.contains("already exists") => res.skipped_existing += 1,
                Err(e) => res.failed.push((i, e.message)),
            }
            if i % 25 == 24 {
                progress(Progress {
                    job,
                    done: i as u64 + 1,
                    total: Some(total),
                    finished: false,
                });
            }
        }
    }
    forget(job);
    progress(Progress {
        job,
        done: total,
        total: Some(total),
        finished: true,
    });
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_conversion_and_csv() {
        let v = json!({"M": {"n": {"N": "5"}, "f": {"N": "2.50"}, "big": {"N": "12345678901234567890"}, "s": {"SS": ["a"]}, "z": {"NULL": true}}});
        let p = to_plain(&v);
        assert_eq!(
            p,
            json!({"n": 5, "f": 2.5, "big": {"$N": "12345678901234567890"}, "s": {"$SS": ["a"]}, "z": null})
        );
        let back = from_plain(&p, "x").unwrap();
        assert_eq!(back["M"]["s"], json!({"SS": ["a"]}));
        assert_eq!(back["M"]["big"], json!({"N": "12345678901234567890"}));
        assert_eq!(csv_cell(Some(&json!({"S": "a,b"}))), "\"a,b\"");
        assert_eq!(csv_cell(Some(&json!({"N": "3"}))), "3");
        assert_eq!(
            csv_cell(Some(&json!({"L": [{"S": "x"}]}))),
            "\"[\"\"x\"\"]\""
        );
        assert_eq!(csv_cell(None), "");
    }

    #[test]
    fn parses_import_files() {
        let (items, ddb) =
            parse_items("{\"pk\":{\"S\":\"a\"}}\n{\"pk\":{\"S\":\"b\"},\"n\":{\"N\":\"1\"}}\n")
                .unwrap();
        assert!(ddb);
        assert_eq!(items.len(), 2);
        let (items, ddb) = parse_items(r#"[{"pk": "a", "n": 1, "tags": {"$SS": ["x"]}}]"#).unwrap();
        assert!(!ddb);
        assert_eq!(items[0]["pk"], json!({"S": "a"}));
        assert_eq!(items[0]["tags"], json!({"SS": ["x"]}));
        assert!(parse_items("{bad").is_err());
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::ddb_items::emulator_tests::put_items;
    use crate::dynamo::emulator_tests::{connect, fresh_table};

    #[tokio::test]
    #[ignore]
    async fn exports_and_imports() {
        let conn = connect().await;
        fresh_table(&conn, "s3x-ddb-io").await;
        put_items(&conn, "s3x-ddb-io", 12).await;
        let keys = vec!["pk".to_string(), "sk".to_string()];
        let types = vec!["S".to_string(), "N".to_string()];
        let dir = std::env::temp_dir().join("s3x-ddb-io");
        std::fs::create_dir_all(&dir).unwrap();
        let path = |n: &str| dir.join(n).to_string_lossy().into_owned();

        let seen = std::sync::Mutex::new(Vec::new());
        let (n, cancelled) = export_table(
            &conn,
            "s3x-ddb-io",
            &keys,
            ExportFormat::DynamoJsonl,
            &path("t.jsonl"),
            1,
            None,
            &|p| seen.lock().unwrap().push(p.done),
        )
        .await
        .unwrap();
        assert_eq!((n, cancelled), (12, false));
        assert_eq!(
            std::fs::read_to_string(path("t.jsonl"))
                .unwrap()
                .lines()
                .count(),
            12
        );
        export_table(
            &conn,
            "s3x-ddb-io",
            &keys,
            ExportFormat::Csv,
            &path("t.csv"),
            2,
            None,
            &|_| {},
        )
        .await
        .unwrap();
        let csv = std::fs::read_to_string(path("t.csv")).unwrap();
        assert!(csv.starts_with("pk,sk,"), "{csv}");
        assert_eq!(csv.lines().count(), 13);

        // Cancel before it starts: nothing written.
        cancel(3);
        let (n, cancelled) = export_table(
            &conn,
            "s3x-ddb-io",
            &keys,
            ExportFormat::PlainJsonl,
            &path("c.jsonl"),
            3,
            None,
            &|_| {},
        )
        .await
        .unwrap();
        assert_eq!((n, cancelled), (0, true));

        // Import: the 12 exported (existing) + 1 new + 1 bad.
        let mut text = std::fs::read_to_string(path("t.jsonl")).unwrap();
        text.push_str("{\"pk\":{\"S\":\"new\"},\"sk\":{\"N\":\"1\"}}\n{\"pk\":{\"S\":\"bad\"}}\n");
        std::fs::write(path("in.jsonl"), text).unwrap();
        let pv = plan_import(&conn, "s3x-ddb-io", &keys, &types, &path("in.jsonl"))
            .await
            .unwrap();
        assert_eq!((pv.count, pv.problem_count, pv.existing), (14, 1, Some(12)));
        let r = run_import(&conn, pv.plan_id, false, 4, &|_| {})
            .await
            .unwrap();
        assert_eq!((r.written, r.skipped_existing), (1, 12));
        assert!(
            run_import(&conn, pv.plan_id, false, 5, &|_| {})
                .await
                .is_err(),
            "runs once"
        );
        let pv = plan_import(&conn, "s3x-ddb-io", &keys, &types, &path("in.jsonl"))
            .await
            .unwrap();
        let r = run_import(&conn, pv.plan_id, true, 6, &|_| {})
            .await
            .unwrap();
        assert_eq!(r.written, 13);
    }
}
