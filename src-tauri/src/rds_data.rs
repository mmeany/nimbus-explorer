//! Running SQL on Aurora clusters through the RDS Data API, and saving results.
//!
//! Read-only runs happen inside a transaction that is always rolled back.
//! PostgreSQL also gets `SET TRANSACTION READ ONLY`, so writes fail outright;
//! MySQL can't make an already-open transaction read only, so read-only runs
//! there accept only statements that read (SELECT, SHOW, …), and the rollback
//! undoes anything a function might have changed.

use crate::error::AppError;
use crate::rds::{err, other};
use crate::s3::Connection;
use aws_sdk_rdsdata::types::{ArrayValue, Field};
use aws_sdk_rdsdata::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Instant;

pub fn client(conn: &Connection) -> Client {
    Client::new(&conn.service_config())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlRequest {
    pub cluster_arn: String,
    pub secret_arn: String,
    pub database: Option<String>,
    pub sql: String,
    /// "postgres" or "mysql" (the engine family).
    pub family: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SqlColumn {
    pub name: String,
    pub type_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SqlResult {
    pub columns: Vec<SqlColumn>,
    pub rows: Vec<Vec<Value>>,
    pub updated: i64,
    pub read_only: bool,
    pub elapsed_ms: u64,
}

/// Splits SQL into statements on `;`, skipping quotes, comments and
/// PostgreSQL dollar quoting. Empty statements are dropped.
pub fn split_statements(sql: &str) -> Vec<String> {
    let b: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied();
        match c {
            '\'' | '"' | '`' => {
                cur.push(c);
                i += 1;
                while i < b.len() {
                    cur.push(b[i]);
                    if b[i] == '\\' && c != '"' && i + 1 < b.len() {
                        cur.push(b[i + 1]);
                        i += 2;
                        continue;
                    }
                    if b[i] == c {
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            '-' if next == Some('-') => {
                while i < b.len() && b[i] != '\n' {
                    cur.push(b[i]);
                    i += 1;
                }
            }
            '#' => {
                while i < b.len() && b[i] != '\n' {
                    cur.push(b[i]);
                    i += 1;
                }
            }
            '/' if next == Some('*') => {
                cur.push_str("/*");
                i += 2;
                while i < b.len() && !(b[i] == '*' && b.get(i + 1) == Some(&'/')) {
                    cur.push(b[i]);
                    i += 1;
                }
                cur.push_str("*/");
                i += 2;
            }
            '$' => {
                // $tag$ … $tag$ (tag may be empty).
                let mut j = i + 1;
                while j < b.len() && (b[j].is_alphanumeric() || b[j] == '_') {
                    j += 1;
                }
                if j < b.len()
                    && b[j] == '$'
                    && !b[i + 1..j].first().is_some_and(|c| c.is_ascii_digit())
                {
                    let tag: String = b[i..=j].iter().collect();
                    cur.push_str(&tag);
                    i = j + 1;
                    let rest: String = b[i..].iter().collect();
                    match rest.find(&tag) {
                        Some(pos) => {
                            let body = &rest[..pos + tag.len()];
                            cur.push_str(body);
                            i += body.chars().count();
                        }
                        None => {
                            cur.push_str(&rest);
                            i = b.len();
                        }
                    }
                } else {
                    cur.push(c);
                    i += 1;
                }
            }
            ';' => {
                out.push(std::mem::take(&mut cur));
                i += 1;
            }
            _ => {
                cur.push(c);
                i += 1;
            }
        }
    }
    out.push(cur);
    out.into_iter()
        .filter(|s| !strip_comments(s).trim().is_empty())
        .map(|s| s.trim().to_string())
        .collect()
}

/// The statement with leading comments and whitespace removed.
fn strip_comments(s: &str) -> &str {
    let mut s = s.trim_start();
    loop {
        if let Some(r) = s.strip_prefix("--").or_else(|| s.strip_prefix('#')) {
            s = r.find('\n').map(|p| &r[p + 1..]).unwrap_or("").trim_start();
        } else if let Some(r) = s.strip_prefix("/*") {
            s = r.find("*/").map(|p| &r[p + 2..]).unwrap_or("").trim_start();
        } else {
            return s;
        }
    }
}

fn first_word(s: &str) -> String {
    strip_comments(s)
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase()
}

/// Why `sql` can't run (in read-only mode when `read_only`); None when it can.
pub fn statement_problem(sql: &str, family: &str, read_only: bool) -> Option<String> {
    let parts = split_statements(sql);
    if parts.is_empty() {
        return Some("Write a statement first".into());
    }
    if parts.len() > 1 {
        return Some("Run one statement at a time (select it and press Run selection)".into());
    }
    if !read_only {
        return None;
    }
    let word = first_word(&parts[0]);
    const TXN: &[&str] = &[
        "BEGIN",
        "START",
        "COMMIT",
        "END",
        "ROLLBACK",
        "ABORT",
        "SAVEPOINT",
        "RELEASE",
        "SET",
        "RESET",
        "PREPARE",
        "LOCK",
        "UNLOCK",
    ];
    if TXN.contains(&word.as_str()) {
        return Some(format!("{word} can't run in a read-only run"));
    }
    if family == "mysql" {
        const READS: &[&str] = &[
            "SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH", "TABLE", "VALUES",
        ];
        if !READS.contains(&word.as_str()) {
            return Some("Read-only runs on MySQL accept only SELECT, SHOW, DESCRIBE, EXPLAIN and WITH statements".into());
        }
        let lower = parts[0].to_ascii_lowercase();
        if ["into outfile", "into dumpfile", "outfile s3"]
            .iter()
            .any(|p| lower.contains(p))
        {
            return Some("Read-only runs can't write files".into());
        }
    }
    None
}

/// JavaScript can't hold integers beyond 2^53 exactly, so those become strings.
fn long(v: i64) -> Value {
    if v.unsigned_abs() > (1u64 << 53) {
        Value::String(v.to_string())
    } else {
        Value::from(v)
    }
}

fn array(a: &ArrayValue) -> Value {
    fn each<T>(v: &[Option<T>], f: impl Fn(&T) -> Value) -> Value {
        Value::Array(
            v.iter()
                .map(|x| x.as_ref().map(&f).unwrap_or(Value::Null))
                .collect(),
        )
    }
    match a {
        ArrayValue::ArrayValues(v) => each(v, array),
        ArrayValue::BooleanValues(v) => each(v, |b| Value::Bool(*b)),
        ArrayValue::DoubleValues(v) => each(v, |d| Value::from(*d)),
        ArrayValue::LongValues(v) => each(v, |l| long(*l)),
        ArrayValue::StringValues(v) => each(v, |s| Value::String(s.clone())),
        _ => Value::Null,
    }
}

pub fn field(f: &Field) -> Value {
    match f {
        Field::IsNull(_) => Value::Null,
        Field::BooleanValue(b) => Value::Bool(*b),
        Field::LongValue(l) => long(*l),
        Field::DoubleValue(d) => Value::from(*d),
        Field::StringValue(s) => Value::String(s.clone()),
        Field::BlobValue(b) => Value::String(format!("<{} bytes>", b.as_ref().len())),
        Field::ArrayValue(a) => array(a),
        _ => Value::Null,
    }
}

async fn run_one(
    c: &Client,
    conn: &Connection,
    req: &SqlRequest,
    sql: &str,
    txn: Option<&str>,
) -> Result<SqlResult, AppError> {
    let out = c
        .execute_statement()
        .resource_arn(&req.cluster_arn)
        .secret_arn(&req.secret_arn)
        .set_database(req.database.clone().filter(|d| !d.is_empty()))
        .sql(sql)
        .include_result_metadata(true)
        .set_transaction_id(txn.map(str::to_string))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    Ok(SqlResult {
        columns: out
            .column_metadata()
            .iter()
            .map(|m| SqlColumn {
                name: m.label().or(m.name()).unwrap_or_default().to_string(),
                type_name: m.type_name().map(str::to_string),
            })
            .collect(),
        rows: out
            .records()
            .iter()
            .map(|r| r.iter().map(field).collect())
            .collect(),
        updated: out.number_of_records_updated(),
        ..Default::default()
    })
}

/// Runs one statement. Read-only runs use a transaction that's rolled back.
pub async fn execute(conn: &Connection, req: &SqlRequest) -> Result<SqlResult, AppError> {
    if let Some(p) = statement_problem(&req.sql, &req.family, req.read_only) {
        return Err(other(p));
    }
    if req.secret_arn.trim().is_empty() {
        return Err(other(
            "Choose the secret that holds the database credentials",
        ));
    }
    let sql = split_statements(&req.sql).remove(0);
    let c = client(conn);
    let started = Instant::now();
    let mut result = if req.read_only {
        let txn = c
            .begin_transaction()
            .resource_arn(&req.cluster_arn)
            .secret_arn(&req.secret_arn)
            .set_database(req.database.clone().filter(|d| !d.is_empty()))
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        let id = txn.transaction_id().unwrap_or_default().to_string();
        let res = async {
            if req.family == "postgres" {
                run_one(&c, conn, req, "SET TRANSACTION READ ONLY", Some(&id)).await?;
            }
            run_one(&c, conn, req, &sql, Some(&id)).await
        }
        .await;
        let rollback = c
            .rollback_transaction()
            .resource_arn(&req.cluster_arn)
            .secret_arn(&req.secret_arn)
            .transaction_id(&id)
            .send()
            .await;
        let mut r = res?;
        rollback.map_err(|e| {
            other(format!(
                "The statement ran but the rollback failed: {}",
                err(conn, e).message
            ))
        })?;
        r.read_only = true;
        r
    } else {
        run_one(&c, conn, req, &sql, None).await?
    };
    result.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(result)
}

fn text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn csv_cell(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) || s.starts_with(' ') || s.ends_with(' ') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Results as CSV (header row first) or JSON (an array of objects).
pub fn format_result(columns: &[SqlColumn], rows: &[Vec<Value>], format: &str) -> String {
    if format == "json" {
        let objs: Vec<Value> = rows
            .iter()
            .map(|r| {
                Value::Object(
                    columns
                        .iter()
                        .zip(r)
                        .map(|(c, v)| (c.name.clone(), v.clone()))
                        .collect(),
                )
            })
            .collect();
        return serde_json::to_string_pretty(&objs).unwrap_or_default();
    }
    let mut out = columns
        .iter()
        .map(|c| csv_cell(&c.name))
        .collect::<Vec<_>>()
        .join(",");
    out.push_str("\r\n");
    for r in rows {
        out.push_str(
            &r.iter()
                .map(|v| csv_cell(&text(v)))
                .collect::<Vec<_>>()
                .join(","),
        );
        out.push_str("\r\n");
    }
    out
}

pub async fn save_result(
    dest: &str,
    columns: &[SqlColumn],
    rows: &[Vec<Value>],
    format: &str,
) -> Result<(), AppError> {
    tokio::fs::write(dest, format_result(columns, rows, format))
        .await
        .map_err(|e| other(format!("Couldn't save {dest}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn splits_statements() {
        assert_eq!(
            split_statements("select 1; select 2;"),
            vec!["select 1", "select 2"]
        );
        assert_eq!(split_statements("select ';' as a"), vec!["select ';' as a"]);
        assert_eq!(
            split_statements("select 'it''s; ok'"),
            vec!["select 'it''s; ok'"]
        );
        assert_eq!(
            split_statements("select \"a;b\" from t -- x; y\n"),
            vec!["select \"a;b\" from t -- x; y"]
        );
        assert_eq!(
            split_statements("/* a; b */ select 1"),
            vec!["/* a; b */ select 1"]
        );
        assert_eq!(
            split_statements("do $$ begin perform 1; end $$; select 2").len(),
            2
        );
        assert_eq!(
            split_statements("select $tag$ ; $tag$"),
            vec!["select $tag$ ; $tag$"]
        );
        assert_eq!(split_statements("select $1, $2; commit").len(), 2);
        assert_eq!(
            split_statements("select 1; -- trailing\n"),
            vec!["select 1"]
        );
        assert!(split_statements("  ;; ").is_empty());
    }

    #[test]
    fn read_only_rules() {
        assert!(statement_problem("", "postgres", false).is_some());
        assert!(
            statement_problem("select 1; drop table t", "postgres", false)
                .unwrap()
                .contains("one statement")
        );
        assert!(statement_problem("delete from t", "postgres", false).is_none());
        // PostgreSQL: the read-only transaction blocks writes; only transaction control is refused.
        assert!(statement_problem("delete from t", "postgres", true).is_none());
        assert!(statement_problem("commit", "postgres", true).is_some());
        assert!(
            statement_problem("  -- c\n SET TRANSACTION READ WRITE", "postgres", true).is_some()
        );
        assert!(statement_problem("select 1; commit; drop table t", "postgres", true).is_some());
        // MySQL: reads only.
        assert!(statement_problem("SELECT * FROM t", "mysql", true).is_none());
        assert!(statement_problem("show tables", "mysql", true).is_none());
        assert!(statement_problem("drop table t", "mysql", true).is_some());
        assert!(
            statement_problem("select * from t into outfile '/tmp/x'", "mysql", true).is_some()
        );
        assert!(statement_problem("drop table t", "mysql", false).is_none());
    }

    #[test]
    fn converts_fields() {
        assert_eq!(field(&Field::IsNull(true)), Value::Null);
        assert_eq!(field(&Field::LongValue(42)), json!(42));
        assert_eq!(
            field(&Field::LongValue(9_007_199_254_740_993)),
            json!("9007199254740993")
        );
        assert_eq!(
            field(&Field::BlobValue(aws_smithy_types::Blob::new(vec![
                1, 2, 3
            ]))),
            json!("<3 bytes>")
        );
        assert_eq!(
            field(&Field::ArrayValue(ArrayValue::LongValues(vec![
                Some(1),
                None
            ]))),
            json!([1, null])
        );
    }

    #[test]
    fn formats_results() {
        let cols = vec![
            SqlColumn {
                name: "id".into(),
                type_name: None,
            },
            SqlColumn {
                name: "note".into(),
                type_name: None,
            },
        ];
        let rows = vec![
            vec![json!(1), json!("a, \"b\"")],
            vec![json!(2), Value::Null],
        ];
        assert_eq!(
            format_result(&cols, &rows, "csv"),
            "id,note\r\n1,\"a, \"\"b\"\"\"\r\n2,\r\n"
        );
        let j: Value = serde_json::from_str(&format_result(&cols, &rows, "json")).unwrap();
        assert_eq!(
            j,
            json!([{"id": 1, "note": "a, \"b\""}, {"id": 2, "note": null}])
        );
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::rds::emulator_tests::connect;
    use std::io::{Read, Write};

    /// Queues a canned ExecuteStatement result in the emulator.
    fn queue_result(body: &str) {
        let mut s = std::net::TcpStream::connect("127.0.0.1:4566").unwrap();
        write!(
            s,
            "POST /moto-api/static/rds-data/statement-results HTTP/1.1\r\nHost: motoapi.amazonaws.com\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut resp = String::new();
        let _ = s.read_to_string(&mut resp);
        assert!(resp.starts_with("HTTP/1.1 20"), "{resp}");
    }

    #[tokio::test]
    #[ignore]
    async fn executes_statements() {
        let conn = connect().await;
        queue_result(
            r#"{"region":"eu-west-2","results":[{"records":[[{"longValue":1},{"stringValue":"Ada"}],[{"longValue":2},{"isNull":true}]],"columnMetadata":[{"name":"id","typeName":"int4"},{"name":"name","typeName":"text"}],"numberOfRecordsUpdated":0}]}"#,
        );
        let req = SqlRequest {
            cluster_arn: "arn:aws:rds:eu-west-2:000000000000:cluster:s3x-aurora".into(),
            secret_arn: "arn:aws:secretsmanager:eu-west-2:000000000000:secret:db".into(),
            database: Some("shop".into()),
            sql: "select id, name from people;".into(),
            family: "postgres".into(),
            read_only: false,
        };
        let r = execute(&conn, &req).await.unwrap();
        assert_eq!(
            r.columns
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            ["id", "name"]
        );
        assert_eq!(
            r.rows,
            vec![
                vec![serde_json::json!(1), serde_json::json!("Ada")],
                vec![serde_json::json!(2), Value::Null]
            ]
        );
        assert!(!r.read_only);
        // Refused before reaching the service.
        let bad = SqlRequest {
            sql: "drop table t".into(),
            family: "mysql".into(),
            read_only: true,
            ..req
        };
        assert!(execute(&conn, &bad)
            .await
            .unwrap_err()
            .message
            .contains("only SELECT"));
    }
}
