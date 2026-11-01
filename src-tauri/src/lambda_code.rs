//! Lambda code: download the deployment package, upload a new .zip.

use crate::error::AppError;
use crate::lambda::{client, err, other};
use crate::s3::Connection;
use aws_smithy_http_client::{tls, Connector};
use aws_smithy_runtime_api::client::http::HttpConnector;
use aws_smithy_runtime_api::http::Request;
use aws_smithy_types::body::SdkBody;
use aws_smithy_types::byte_stream::ByteStream;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

/// Lambda takes .zip files up to 50 MB directly; bigger ones go through S3.
pub const MAX_DIRECT_ZIP: u64 = 50 * 1024 * 1024;

/// GETs `url` (a presigned link) into `dest` with the SDK's HTTP client;
/// written to a `.s3x-part` file, renamed when complete. Returns the bytes.
pub async fn fetch_to_file(url: &str, dest: &str) -> Result<u64, AppError> {
    let connector = Connector::builder()
        .tls_provider(tls::Provider::Rustls(
            tls::rustls_provider::CryptoMode::Ring,
        ))
        .build();
    let mut req = Request::new(SdkBody::empty());
    req.set_uri(url)
        .map_err(|e| other(format!("Bad download link: {e}")))?;
    let resp = connector
        .call(req)
        .await
        .map_err(|e| other(format!("Download failed: {e}")))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(other(format!(
            "Download failed (HTTP {status}); the link may have expired, try again"
        )));
    }
    let mut body = ByteStream::new(resp.into_body());
    let part = format!("{dest}.s3x-part");
    let mut f = tokio::fs::File::create(&part)
        .await
        .map_err(|e| other(format!("Couldn't create {dest}: {e}")))?;
    let mut written = 0u64;
    let result: Result<(), AppError> = async {
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|e| other(format!("Download interrupted: {e}")))?;
            f.write_all(&chunk)
                .await
                .map_err(|e| other(format!("Couldn't write {dest}: {e}")))?;
            written += chunk.len() as u64;
        }
        f.flush().await.map_err(|e| other(e.to_string()))
    }
    .await;
    drop(f);
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(e);
    }
    tokio::fs::rename(&part, dest)
        .await
        .map_err(|e| other(format!("Couldn't save {dest}: {e}")))?;
    Ok(written)
}

/// Saves the deployment package of `$LATEST` or `qualifier` to `dest`.
pub async fn download(
    conn: &Connection,
    name: &str,
    qualifier: Option<&str>,
    dest: &str,
) -> Result<u64, AppError> {
    let out = client(conn)
        .get_function()
        .function_name(name)
        .set_qualifier(qualifier.filter(|q| !q.is_empty()).map(String::from))
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let code = out
        .code()
        .ok_or_else(|| other("Lambda didn't return the code's location"))?;
    if code.repository_type() == Some("ECR") {
        return Err(other(format!(
            "This function runs a container image, so there's no package to download. Image: {}",
            code.image_uri()
                .or(code.resolved_image_uri())
                .unwrap_or("unknown")
        )));
    }
    let url = code
        .location()
        .ok_or_else(|| other("Lambda didn't return a download link"))?;
    fetch_to_file(url, dest).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    rename_all = "camelCase",
    tag = "kind",
    rename_all_fields = "camelCase"
)]
pub enum CodeSource {
    /// A local .zip (at most 50 MB).
    Zip { path: String },
    /// A .zip already in S3 (same region as the function).
    S3 {
        bucket: String,
        key: String,
        version: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRequest {
    pub name: String,
    pub source: CodeSource,
    /// Also publish the new code as a numbered version.
    pub publish: bool,
    /// The revision the upload started from (refused if the function changed).
    pub revision_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub version: Option<String>,
    pub code_size: i64,
    pub code_sha256: Option<String>,
}

/// Why a local file can't be uploaded directly (None = fine).
pub fn zip_problem(len: u64, head: &[u8]) -> Option<String> {
    if len > MAX_DIRECT_ZIP {
        return Some(
            "The file is larger than 50 MB: upload it to S3 first and choose it from there".into(),
        );
    }
    if !head.starts_with(b"PK") {
        return Some("That isn't a .zip file".into());
    }
    None
}

pub async fn upload(conn: &Connection, r: &UploadRequest) -> Result<UploadResult, AppError> {
    let mut req = client(conn)
        .update_function_code()
        .function_name(&r.name)
        .publish(r.publish)
        .set_revision_id(r.revision_id.clone());
    match &r.source {
        CodeSource::Zip { path } => {
            let meta = tokio::fs::metadata(path)
                .await
                .map_err(|e| other(format!("Couldn't read {path}: {e}")))?;
            let bytes = if meta.len() <= MAX_DIRECT_ZIP {
                tokio::fs::read(path)
                    .await
                    .map_err(|e| other(format!("Couldn't read {path}: {e}")))?
            } else {
                Vec::new()
            };
            if let Some(p) = zip_problem(meta.len(), &bytes) {
                return Err(other(p));
            }
            req = req.zip_file(aws_smithy_types::Blob::new(bytes));
        }
        CodeSource::S3 {
            bucket,
            key,
            version,
        } => {
            if bucket.trim().is_empty() || key.trim().is_empty() {
                return Err(other("Choose the S3 bucket and key of the .zip"));
            }
            req = req
                .s3_bucket(bucket.trim())
                .s3_key(key.trim())
                .set_s3_object_version(version.clone().filter(|v| !v.is_empty()));
        }
    }
    let out = req.send().await.map_err(|e| err(conn, e))?;
    Ok(UploadResult {
        version: out.version().filter(|v| *v != "$LATEST").map(String::from),
        code_size: out.code_size(),
        code_sha256: out.code_sha256().map(String::from),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_zips() {
        assert!(zip_problem(10, b"PK\x03\x04").is_none());
        assert!(zip_problem(10, b"%PDF").unwrap().contains(".zip"));
        assert!(zip_problem(MAX_DIRECT_ZIP + 1, b"PK")
            .unwrap()
            .contains("50 MB"));
    }

    #[test]
    fn reads_code_sources() {
        let z: CodeSource = serde_json::from_str(r#"{"kind":"zip","path":"C:\\a.zip"}"#).unwrap();
        assert!(matches!(z, CodeSource::Zip { path } if path == "C:\\a.zip"));
        let s: CodeSource =
            serde_json::from_str(r#"{"kind":"s3","bucket":"b","key":"k.zip","version":null}"#)
                .unwrap();
        assert!(matches!(s, CodeSource::S3 { bucket, .. } if bucket == "b"));
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::lambda::emulator_tests::{connect, fresh_function, EMPTY_ZIP};

    #[tokio::test]
    #[ignore]
    async fn fetches_and_uploads() {
        // The SDK's HTTP client fetches a plain URL (the emulator's own page here).
        let dir = std::env::temp_dir().join(format!("s3x-code-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let page = dir.join("page.html");
        let n = fetch_to_file("http://127.0.0.1:4566/moto-api/", page.to_str().unwrap())
            .await
            .unwrap();
        assert!(n > 0 && std::fs::metadata(&page).unwrap().len() == n);
        assert!(fetch_to_file(
            "http://127.0.0.1:4566/moto-api/no-such-page",
            dir.join("x").to_str().unwrap()
        )
        .await
        .is_err());

        let conn = connect().await;
        fresh_function(&conn, "s3x-fn-code").await;
        let zip = dir.join("code.zip");
        std::fs::write(&zip, EMPTY_ZIP).unwrap();
        let r = upload(
            &conn,
            &UploadRequest {
                name: "s3x-fn-code".into(),
                source: CodeSource::Zip {
                    path: zip.to_str().unwrap().into(),
                },
                publish: true,
                revision_id: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(r.version.as_deref(), Some("1"));
        let notzip = dir.join("x.txt");
        std::fs::write(&notzip, "hello").unwrap();
        assert!(upload(
            &conn,
            &UploadRequest {
                name: "s3x-fn-code".into(),
                source: CodeSource::Zip {
                    path: notzip.to_str().unwrap().into()
                },
                publish: false,
                revision_id: None
            }
        )
        .await
        .is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
