//! DynamoDB items: DynamoDB-JSON conversion, scan and query (one page at a time).

use crate::dynamo::{client, err, other};
use crate::error::AppError;
use crate::s3::Connection;
use aws_sdk_dynamodb::primitives::Blob;
use aws_sdk_dynamodb::types::{
    AttributeValue, DeleteRequest, ReturnConsumedCapacity, Select, WriteRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};

/// An item as DynamoDB JSON: attribute name → {"S": …} etc.
pub type JsonItem = Map<String, Value>;

/// AttributeValue → DynamoDB JSON (binary as base64).
pub fn av_to_json(av: &AttributeValue) -> Value {
    use serde_json::json;
    let b64 = |b: &Blob| Value::String(aws_smithy_types::base64::encode(b.as_ref()));
    match av {
        AttributeValue::S(s) => json!({ "S": s }),
        AttributeValue::N(n) => json!({ "N": n }),
        AttributeValue::B(b) => json!({ "B": b64(b) }),
        AttributeValue::Bool(b) => json!({ "BOOL": b }),
        AttributeValue::Null(_) => json!({ "NULL": true }),
        AttributeValue::M(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let obj: Map<String, Value> = keys
                .into_iter()
                .map(|k| (k.clone(), av_to_json(&m[k])))
                .collect();
            json!({ "M": obj })
        }
        AttributeValue::L(l) => json!({ "L": l.iter().map(av_to_json).collect::<Vec<_>>() }),
        AttributeValue::Ss(v) => json!({ "SS": v }),
        AttributeValue::Ns(v) => json!({ "NS": v }),
        AttributeValue::Bs(v) => json!({ "BS": v.iter().map(b64).collect::<Vec<_>>() }),
        _ => json!({ "NULL": true }),
    }
}

/// DynamoDB JSON → AttributeValue, with a path for error messages.
pub fn json_to_av(v: &Value, path: &str) -> Result<AttributeValue, String> {
    let obj = v
        .as_object()
        .filter(|o| o.len() == 1)
        .ok_or_else(|| format!("{path}: expected a typed value like {{\"S\": \"text\"}}"))?;
    let (t, inner) = obj.iter().next().unwrap();
    let s = |x: &Value| {
        x.as_str()
            .map(String::from)
            .ok_or_else(|| format!("{path}: {t} needs a string"))
    };
    let strings = |x: &Value| -> Result<Vec<String>, String> {
        x.as_array()
            .ok_or_else(|| format!("{path}: {t} needs an array"))?
            .iter()
            .map(|e| {
                e.as_str()
                    .map(String::from)
                    .ok_or_else(|| format!("{path}: {t} items must be strings"))
            })
            .collect()
    };
    let blob = |x: &str| -> Result<Blob, String> {
        aws_smithy_types::base64::decode(x)
            .map(Blob::new)
            .map_err(|_| format!("{path}: binary must be base64"))
    };
    let number = |n: String| -> Result<String, String> {
        if n.trim().parse::<f64>().is_ok() {
            Ok(n.trim().to_string())
        } else {
            Err(format!("{path}: \"{n}\" isn't a number"))
        }
    };
    Ok(match t.as_str() {
        "S" => AttributeValue::S(s(inner)?),
        "N" => AttributeValue::N(number(match inner {
            Value::Number(n) => n.to_string(),
            other => s(other)?,
        })?),
        "B" => AttributeValue::B(blob(&s(inner)?)?),
        "BOOL" => AttributeValue::Bool(
            inner
                .as_bool()
                .ok_or_else(|| format!("{path}: BOOL needs true/false"))?,
        ),
        "NULL" => AttributeValue::Null(true),
        "M" => {
            let m = inner
                .as_object()
                .ok_or_else(|| format!("{path}: M needs an object"))?;
            AttributeValue::M(
                m.iter()
                    .map(|(k, v)| Ok((k.clone(), json_to_av(v, &format!("{path}.{k}"))?)))
                    .collect::<Result<HashMap<_, _>, String>>()?,
            )
        }
        "L" => {
            let l = inner
                .as_array()
                .ok_or_else(|| format!("{path}: L needs an array"))?;
            AttributeValue::L(
                l.iter()
                    .enumerate()
                    .map(|(i, v)| json_to_av(v, &format!("{path}[{i}]")))
                    .collect::<Result<Vec<_>, String>>()?,
            )
        }
        "SS" => AttributeValue::Ss(strings(inner)?),
        "NS" => AttributeValue::Ns(
            strings(inner)?
                .into_iter()
                .map(number)
                .collect::<Result<_, _>>()?,
        ),
        "BS" => AttributeValue::Bs(
            strings(inner)?
                .iter()
                .map(|x| blob(x))
                .collect::<Result<_, _>>()?,
        ),
        other => return Err(format!("{path}: unknown type \"{other}\"")),
    })
}

pub fn item_to_json(item: &HashMap<String, AttributeValue>) -> JsonItem {
    let mut keys: Vec<&String> = item.keys().collect();
    keys.sort();
    keys.into_iter()
        .map(|k| (k.clone(), av_to_json(&item[k])))
        .collect()
}

pub fn json_to_item(item: &JsonItem) -> Result<HashMap<String, AttributeValue>, AppError> {
    item.iter()
        .map(|(k, v)| Ok((k.clone(), json_to_av(v, k)?)))
        .collect::<Result<_, String>>()
        .map_err(other)
}

fn opt_map<T>(m: HashMap<String, T>) -> Option<HashMap<String, T>> {
    if m.is_empty() {
        None
    } else {
        Some(m)
    }
}

fn non_empty(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(String::from)
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ReadRequest {
    pub table: String,
    pub index: Option<String>,
    /// true = Query (needs key_condition), false = Scan.
    pub query: bool,
    pub key_condition: Option<String>,
    pub filter: Option<String>,
    pub projection: Option<String>,
    /// "#name" → attribute name
    pub names: BTreeMap<String, String>,
    /// ":value" → DynamoDB JSON
    pub values: Map<String, Value>,
    /// Query order: true = ascending sort key.
    pub forward: Option<bool>,
    /// Items evaluated per page (default 100).
    pub limit: Option<i32>,
    pub start_key: Option<JsonItem>,
    pub consistent: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPage {
    pub items: Vec<JsonItem>,
    /// Present when there are more pages.
    pub last_key: Option<JsonItem>,
    pub count: i32,
    pub scanned_count: i32,
    pub consumed_capacity: Option<f64>,
}

/// One page of a Scan or Query.
pub async fn read_page(conn: &Connection, r: &ReadRequest) -> Result<ReadPage, AppError> {
    let names: HashMap<String, String> = r
        .names
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let values: HashMap<String, AttributeValue> = json_to_item(&r.values)?;
    let start = r.start_key.as_ref().map(json_to_item).transpose()?;
    let limit = r.limit.unwrap_or(100).clamp(1, 1000);
    let client = client(conn);
    let (items, last, count, scanned, consumed) = if r.query {
        let kc = non_empty(&r.key_condition)
            .ok_or_else(|| other("A query needs a partition key condition"))?;
        let out = client
            .query()
            .table_name(&r.table)
            .set_index_name(non_empty(&r.index))
            .key_condition_expression(kc)
            .set_filter_expression(non_empty(&r.filter))
            .set_projection_expression(non_empty(&r.projection))
            .set_expression_attribute_names(opt_map(names))
            .set_expression_attribute_values(opt_map(values))
            .scan_index_forward(r.forward.unwrap_or(true))
            .limit(limit)
            .set_exclusive_start_key(start)
            .consistent_read(r.consistent && r.index.is_none())
            .return_consumed_capacity(ReturnConsumedCapacity::Total)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        (
            out.items().to_vec(),
            out.last_evaluated_key().cloned(),
            out.count(),
            out.scanned_count(),
            out.consumed_capacity().and_then(|c| c.capacity_units()),
        )
    } else {
        let out = client
            .scan()
            .table_name(&r.table)
            .set_index_name(non_empty(&r.index))
            .set_filter_expression(non_empty(&r.filter))
            .set_projection_expression(non_empty(&r.projection))
            .set_expression_attribute_names(opt_map(names))
            .set_expression_attribute_values(opt_map(values))
            .limit(limit)
            .set_exclusive_start_key(start)
            .consistent_read(r.consistent && r.index.is_none())
            .return_consumed_capacity(ReturnConsumedCapacity::Total)
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        (
            out.items().to_vec(),
            out.last_evaluated_key().cloned(),
            out.count(),
            out.scanned_count(),
            out.consumed_capacity().and_then(|c| c.capacity_units()),
        )
    };
    Ok(ReadPage {
        items: items.iter().map(item_to_json).collect(),
        last_key: last.filter(|k| !k.is_empty()).map(|k| item_to_json(&k)),
        count,
        scanned_count: scanned,
        consumed_capacity: consumed,
    })
}

/// Total matching items (Scan/Query with Select COUNT, all pages). Used for
/// "count all" without fetching items.
pub async fn count_all(conn: &Connection, r: &ReadRequest) -> Result<i64, AppError> {
    let names: HashMap<String, String> = r
        .names
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let values = json_to_item(&r.values)?;
    let client = client(conn);
    let mut total = 0i64;
    let mut start: Option<HashMap<String, AttributeValue>> = None;
    loop {
        let (count, last) = if r.query {
            let out = client
                .query()
                .table_name(&r.table)
                .set_index_name(non_empty(&r.index))
                .set_key_condition_expression(non_empty(&r.key_condition))
                .set_filter_expression(non_empty(&r.filter))
                .set_expression_attribute_names(opt_map(names.clone()))
                .set_expression_attribute_values(opt_map(values.clone()))
                .select(Select::Count)
                .set_exclusive_start_key(start)
                .send()
                .await
                .map_err(|e| err(conn, e))?;
            (out.count(), out.last_evaluated_key().cloned())
        } else {
            let out = client
                .scan()
                .table_name(&r.table)
                .set_index_name(non_empty(&r.index))
                .set_filter_expression(non_empty(&r.filter))
                .set_expression_attribute_names(opt_map(names.clone()))
                .set_expression_attribute_values(opt_map(values.clone()))
                .select(Select::Count)
                .set_exclusive_start_key(start)
                .send()
                .await
                .map_err(|e| err(conn, e))?;
            (out.count(), out.last_evaluated_key().cloned())
        };
        total += count as i64;
        start = last.filter(|k| !k.is_empty());
        if start.is_none() {
            break;
        }
    }
    Ok(total)
}

// ---------------------------------------------------------------------------
// PartiQL

/// True if the statement only reads (starts with SELECT, ignoring leading
/// whitespace, comments and brackets).
pub fn is_read_only_statement(stmt: &str) -> bool {
    let mut rest = stmt.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.split_once('\n').map(|x| x.1).unwrap_or("").trim_start();
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.split_once("*/").map(|x| x.1).unwrap_or("").trim_start();
        } else if let Some(r) = rest.strip_prefix('(') {
            rest = r.trim_start();
        } else {
            break;
        }
    }
    rest.get(..6)
        .is_some_and(|w| w.eq_ignore_ascii_case("select"))
        && rest[6..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_alphanumeric() && c != '_')
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementPage {
    pub items: Vec<JsonItem>,
    pub next_token: Option<String>,
    pub consumed_capacity: Option<f64>,
}

/// Runs one page of a PartiQL statement. `parameters` are DynamoDB JSON
/// values for `?` placeholders.
pub async fn execute_statement(
    conn: &Connection,
    statement: &str,
    parameters: &[Value],
    next_token: Option<String>,
    limit: Option<i32>,
) -> Result<StatementPage, AppError> {
    let params = parameters
        .iter()
        .enumerate()
        .map(|(i, v)| json_to_av(v, &format!("parameter {}", i + 1)))
        .collect::<Result<Vec<_>, String>>()
        .map_err(other)?;
    let out = client(conn)
        .execute_statement()
        .statement(statement)
        .set_parameters(if params.is_empty() {
            None
        } else {
            Some(params)
        })
        .set_next_token(next_token)
        .set_limit(limit)
        .return_consumed_capacity(ReturnConsumedCapacity::Total)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(StatementPage {
        items: out.items().iter().map(item_to_json).collect(),
        next_token: out.next_token().map(String::from),
        consumed_capacity: out.consumed_capacity().and_then(|c| c.capacity_units()),
    })
}

// ---------------------------------------------------------------------------
// Writes

/// BatchWriteItem takes at most 25 requests.
const WRITE_BATCH: usize = 25;
/// Retries for unprocessed items (with growing waits).
const MAX_RETRIES: u32 = 6;

/// The item's key attributes (for conditions and deletes).
fn key_names(table_keys: &[String]) -> Result<(String, Option<String>), AppError> {
    match table_keys {
        [pk] => Ok((pk.clone(), None)),
        [pk, sk] => Ok((pk.clone(), Some(sk.clone()))),
        _ => Err(other("The table's key must be one or two attributes")),
    }
}

pub async fn get_item(
    conn: &Connection,
    table: &str,
    key: &JsonItem,
    consistent: bool,
) -> Result<Option<JsonItem>, AppError> {
    let out = client(conn)
        .get_item()
        .table_name(table)
        .set_key(Some(json_to_item(key)?))
        .consistent_read(consistent)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(out.item().map(item_to_json))
}

/// Writes an item. `must_exist: Some(false)` = create only (fails if the key
/// exists); `Some(true)` = replace only (fails if it was deleted meanwhile);
/// `None` = unconditional.
pub async fn put_item(
    conn: &Connection,
    table: &str,
    key_attrs: &[String],
    item: &JsonItem,
    must_exist: Option<bool>,
) -> Result<(), AppError> {
    let (pk, _) = key_names(key_attrs)?;
    for k in key_attrs {
        if !item.contains_key(k) {
            return Err(other(format!("The item needs its key attribute \"{k}\"")));
        }
    }
    let cond = must_exist.map(|exists| {
        if exists {
            "attribute_exists(#pk)"
        } else {
            "attribute_not_exists(#pk)"
        }
    });
    let mut req = client(conn)
        .put_item()
        .table_name(table)
        .set_item(Some(json_to_item(item)?));
    if let Some(c) = cond {
        req = req
            .condition_expression(c)
            .expression_attribute_names("#pk", &pk);
    }
    req.send().await.map_err(|e| {
        if e.as_service_error().is_some_and(|se| se.is_conditional_check_failed_exception()) {
            if must_exist == Some(false) {
                other("An item with this key already exists. Edit that item instead, or change the key.")
            } else {
                other("The item no longer exists (it was deleted since you opened it).")
            }
        } else {
            err(conn, e)
        }
    })?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReport {
    pub done: usize,
    /// Positions (in the input) that couldn't be written, with the reason.
    pub failed: Vec<(usize, String)>,
}

/// Runs BatchWriteItem in groups of 25, retrying unprocessed items with
/// growing waits. `requests[i]` keeps its position for the report.
pub async fn batch_write(
    conn: &Connection,
    table: &str,
    requests: Vec<WriteRequest>,
) -> Result<WriteReport, AppError> {
    let client = client(conn);
    let mut report = WriteReport {
        done: 0,
        failed: Vec::new(),
    };
    let indexed: Vec<(usize, WriteRequest)> = requests.into_iter().enumerate().collect();
    for chunk in indexed.chunks(WRITE_BATCH) {
        let mut pending: Vec<(usize, WriteRequest)> = chunk.to_vec();
        let mut attempt = 0;
        while !pending.is_empty() {
            let reqs: Vec<WriteRequest> = pending.iter().map(|(_, r)| r.clone()).collect();
            let out = client
                .batch_write_item()
                .request_items(table, reqs)
                .send()
                .await;
            let out = match out {
                Ok(o) => o,
                Err(e) => {
                    let e = err(conn, e);
                    if report.done == 0 && report.failed.is_empty() {
                        return Err(e);
                    }
                    report
                        .failed
                        .extend(pending.iter().map(|(i, _)| (*i, e.message.clone())));
                    break;
                }
            };
            let unprocessed: Vec<WriteRequest> = out
                .unprocessed_items()
                .and_then(|m| m.get(table))
                .cloned()
                .unwrap_or_default();
            // Match unprocessed requests back to their positions.
            let mut still = Vec::new();
            for (i, r) in pending.drain(..) {
                if unprocessed.contains(&r) {
                    still.push((i, r));
                } else {
                    report.done += 1;
                }
            }
            if still.is_empty() {
                break;
            }
            attempt += 1;
            if attempt > MAX_RETRIES {
                report.failed.extend(
                    still
                        .iter()
                        .map(|(i, _)| (*i, "Throttled: not processed after retries".to_string())),
                );
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100 * 2u64.pow(attempt))).await;
            pending = still;
        }
    }
    report.failed.sort_by_key(|f| f.0);
    Ok(report)
}

/// Deletes items by key.
pub async fn delete_items(
    conn: &Connection,
    table: &str,
    keys: &[JsonItem],
) -> Result<WriteReport, AppError> {
    let reqs = keys
        .iter()
        .map(|k| {
            Ok(WriteRequest::builder()
                .delete_request(
                    DeleteRequest::builder()
                        .set_key(Some(json_to_item(k)?))
                        .build()
                        .map_err(|e| other(e.to_string()))?,
                )
                .build())
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    batch_write(conn, table, reqs).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn read_only_statements() {
        assert!(is_read_only_statement("SELECT * FROM t"));
        assert!(is_read_only_statement(
            "  -- note\n /* x */ select a FROM \"t\""
        ));
        assert!(is_read_only_statement("(SELECT 1)"));
        assert!(!is_read_only_statement("SELECTX FROM t"));
        assert!(!is_read_only_statement("UPDATE t SET a = 1"));
        assert!(!is_read_only_statement("INSERT INTO t VALUE {'a': 1}"));
        assert!(!is_read_only_statement("DELETE FROM t WHERE pk = 'a'"));
        assert!(!is_read_only_statement("-- SELECT\nDELETE FROM t"));
    }

    #[test]
    fn json_round_trip() {
        let v = json!({"M": {
            "s": {"S": "x"}, "n": {"N": "1.5"}, "b": {"B": "aGk="}, "t": {"BOOL": true},
            "z": {"NULL": true}, "l": {"L": [{"S": "a"}, {"N": "2"}]},
            "ss": {"SS": ["a", "b"]}, "ns": {"NS": ["1", "2"]}, "bs": {"BS": ["aGk="]}
        }});
        let av = json_to_av(&v, "item").unwrap();
        assert_eq!(av_to_json(&av), v);
        assert_eq!(
            json_to_av(&json!({"N": 5}), "x").unwrap(),
            AttributeValue::N("5".into())
        );
        assert!(json_to_av(&json!({"N": "abc"}), "x")
            .unwrap_err()
            .contains("isn't a number"));
        assert!(json_to_av(&json!({"Q": 1}), "x")
            .unwrap_err()
            .contains("unknown type"));
        assert!(json_to_av(&json!("plain"), "x").is_err());
        assert!(json_to_av(&json!({"M": {"a": {"B": "!!"}}}), "item")
            .unwrap_err()
            .starts_with("item.a"));
    }
}

#[cfg(test)]
pub(crate) mod emulator_tests {
    use super::*;
    use crate::dynamo::emulator_tests::{connect, fresh_table};
    use serde_json::json;

    pub(crate) async fn put_items(conn: &Connection, table: &str, n: usize) {
        let c = client(conn);
        for i in 0..n {
            c.put_item()
                .table_name(table)
                .item("pk", AttributeValue::S(format!("c{}", i % 3)))
                .item("sk", AttributeValue::N(i.to_string()))
                .item(
                    "status",
                    AttributeValue::S(if i % 2 == 0 {
                        "open".into()
                    } else {
                        "done".into()
                    }),
                )
                .item("total", AttributeValue::N(format!("{}.5", i)))
                .send()
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    #[ignore]
    async fn scans_and_queries_in_pages() {
        let conn = connect().await;
        fresh_table(&conn, "s3x-ddb-read").await;
        put_items(&conn, "s3x-ddb-read", 30).await;

        // Scan in pages of 7.
        let mut req = ReadRequest {
            table: "s3x-ddb-read".into(),
            limit: Some(7),
            ..Default::default()
        };
        let mut seen = 0;
        loop {
            let page = read_page(&conn, &req).await.unwrap();
            seen += page.items.len();
            match page.last_key {
                Some(k) => req.start_key = Some(k),
                None => break,
            }
        }
        assert_eq!(seen, 30);

        // Query pk = c1 and sk between 5 and 20, descending.
        let mut values = Map::new();
        values.insert(":pk".into(), json!({"S": "c1"}));
        values.insert(":a".into(), json!({"N": "5"}));
        values.insert(":b".into(), json!({"N": "20"}));
        let q = ReadRequest {
            table: "s3x-ddb-read".into(),
            query: true,
            key_condition: Some("#pk = :pk AND #sk BETWEEN :a AND :b".into()),
            names: [
                ("#pk".to_string(), "pk".to_string()),
                ("#sk".to_string(), "sk".to_string()),
            ]
            .into(),
            values,
            forward: Some(false),
            ..Default::default()
        };
        let page = read_page(&conn, &q).await.unwrap();
        let sks: Vec<String> = page
            .items
            .iter()
            .map(|i| i["sk"]["N"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(sks, vec!["19", "16", "13", "10", "7"]);
        assert_eq!(count_all(&conn, &q).await.unwrap(), 5);

        // Scan the GSI with a filter and a projection.
        let mut values = Map::new();
        values.insert(":s".into(), json!({"S": "open"}));
        let g = ReadRequest {
            table: "s3x-ddb-read".into(),
            index: Some("byStatus".into()),
            query: true,
            key_condition: Some("#st = :s".into()),
            projection: Some("pk, sk".into()),
            names: [("#st".to_string(), "status".to_string())].into(),
            values,
            ..Default::default()
        };
        let page = read_page(&conn, &g).await.unwrap();
        assert_eq!(page.items.len(), 15);
        assert!(page.items[0].get("total").is_none(), "projection applied");
    }

    #[tokio::test]
    #[ignore]
    async fn creates_edits_and_deletes_items() {
        let conn = connect().await;
        fresh_table(&conn, "s3x-ddb-write").await;
        let keys = vec!["pk".to_string(), "sk".to_string()];
        let item: JsonItem =
            serde_json::from_value(json!({"pk": {"S": "a"}, "sk": {"N": "1"}, "v": {"S": "one"}}))
                .unwrap();
        put_item(&conn, "s3x-ddb-write", &keys, &item, Some(false))
            .await
            .unwrap();
        let dup = put_item(&conn, "s3x-ddb-write", &keys, &item, Some(false))
            .await
            .unwrap_err();
        assert!(dup.message.contains("already exists"));

        let mut edited = item.clone();
        edited.insert("v".into(), json!({"S": "two"}));
        put_item(&conn, "s3x-ddb-write", &keys, &edited, Some(true))
            .await
            .unwrap();
        let key: JsonItem =
            serde_json::from_value(json!({"pk": {"S": "a"}, "sk": {"N": "1"}})).unwrap();
        let got = get_item(&conn, "s3x-ddb-write", &key, true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(got["v"], json!({"S": "two"}));

        let missing: JsonItem =
            serde_json::from_value(json!({"pk": {"S": "zzz"}, "sk": {"N": "9"}, "v": {"S": "x"}}))
                .unwrap();
        assert!(
            put_item(&conn, "s3x-ddb-write", &keys, &missing, Some(true))
                .await
                .unwrap_err()
                .message
                .contains("no longer exists")
        );
        let nokey: JsonItem = serde_json::from_value(json!({"pk": {"S": "a"}})).unwrap();
        assert!(put_item(&conn, "s3x-ddb-write", &keys, &nokey, None)
            .await
            .is_err());

        // Batch: 60 puts then delete them all (3 batches of 25 / 25 / 10).
        let many: Vec<JsonItem> = (0..60)
            .map(|i| {
                serde_json::from_value(json!({"pk": {"S": "b"}, "sk": {"N": i.to_string()}}))
                    .unwrap()
            })
            .collect();
        assert_eq!(
            batch_write(
                &conn,
                "s3x-ddb-write",
                many.iter()
                    .map(|it| WriteRequest::builder()
                        .put_request(
                            aws_sdk_dynamodb::types::PutRequest::builder()
                                .set_item(Some(json_to_item(it).unwrap()))
                                .build()
                                .unwrap()
                        )
                        .build())
                    .collect()
            )
            .await
            .unwrap()
            .done,
            60
        );
        let r = delete_items(&conn, "s3x-ddb-write", &many).await.unwrap();
        assert_eq!((r.done, r.failed.len()), (60, 0));
        let left = read_page(
            &conn,
            &ReadRequest {
                table: "s3x-ddb-write".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(left.items.len(), 1);
    }

    #[tokio::test]
    #[ignore]
    async fn runs_partiql() {
        let conn = connect().await;
        fresh_table(&conn, "s3x-ddb-pql").await;
        put_items(&conn, "s3x-ddb-pql", 5).await;
        let page = execute_statement(
            &conn,
            "SELECT * FROM \"s3x-ddb-pql\" WHERE pk = ?",
            &[json!({"S": "c1"})],
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(page.items.len(), 2);
        execute_statement(
            &conn,
            "INSERT INTO \"s3x-ddb-pql\" VALUE {'pk': 'new', 'sk': 1}",
            &[],
            None,
            None,
        )
        .await
        .unwrap();
        let all = execute_statement(&conn, "SELECT pk FROM \"s3x-ddb-pql\"", &[], None, None)
            .await
            .unwrap();
        assert_eq!(all.items.len(), 6);
    }
}
