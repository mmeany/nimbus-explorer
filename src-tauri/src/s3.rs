//! S3 connection handling: client construction (real AWS or custom endpoint
//! such as LocalStack), per-region clients, and S3 operations.

use crate::error::AppError;
use crate::profiles::ProfileInfo;
use crate::settings::ConnectionOverride;
use aws_config::timeout::TimeoutConfig;
use aws_config::{BehaviorVersion, Region, SdkConfig};
use aws_sdk_s3::config::{RequestChecksumCalculation, ResponseChecksumValidation};
use aws_sdk_s3::primitives::DateTimeFormat;
use aws_sdk_s3::Client;
use aws_smithy_http_client::tls;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

/// Region used when neither the profile nor the environment sets one.
/// Emulators accept any region; real AWS ListBuckets is global.
const FALLBACK_REGION: &str = "us-east-1";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum EndpointSource {
    /// Set in the app's Connection settings dialog.
    Override,
    /// From the profile's `endpoint_url` (or AWS_ENDPOINT_URL).
    Profile,
}

/// What the UI shows about the active connection.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub profile: String,
    pub region: String,
    /// Custom endpoint, if any. None means real AWS.
    pub endpoint_url: Option<String>,
    pub endpoint_source: Option<EndpointSource>,
    pub path_style: bool,
    /// Region used by the regional services (Parameter Store, SQS, DynamoDB,
    /// Secrets Manager). S3 buckets always use their own region.
    pub service_region: String,
    /// Read-only mode for this profile (filled in by the command layer).
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketInfo {
    pub name: String,
    /// RFC 3339 timestamp.
    pub creation_date: Option<String>,
    pub region: Option<String>,
}

/// One file (object) in a folder listing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectInfo {
    pub key: String,
    pub size: i64,
    /// RFC 3339 timestamp.
    pub last_modified: Option<String>,
    pub storage_class: Option<String>,
    pub etag: Option<String>,
}

/// One page of a delimited listing ("folder view") of a prefix.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPage {
    /// Sub-folder prefixes, each ending in "/".
    pub folders: Vec<String>,
    pub files: Vec<ObjectInfo>,
    /// Pass back to get the next page; None when complete.
    pub next_token: Option<String>,
}

/// Sub-folders of a prefix, for the tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderList {
    pub folders: Vec<String>,
    /// False if the listing was cut short (very large folder).
    pub complete: bool,
}

/// Size of a set of files and folders, for delete confirmation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemCount {
    /// Objects, including folder markers.
    pub objects: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFailure {
    pub key: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub deleted: u64,
    pub failed: Vec<DeleteFailure>,
}

/// What the preview pane can show for an object.
#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum Preview {
    /// UTF-8 text (possibly only the start of a large file).
    Text { text: String, truncated: bool },
    /// Image as a data: URL (CSP allows img-src data:).
    Image { data_url: String },
    /// Larger than the preview limit for its type.
    TooLarge { limit: u64 },
    /// Not a type we can show (binary, archive, …).
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub size: u64,
    pub content_type: Option<String>,
    pub preview: Preview,
}

/// Images and full text files up to this size are previewed whole.
pub const PREVIEW_LIMIT: u64 = 5 * 1024 * 1024;
/// Larger text files (e.g. logs) show their first part.
const TEXT_HEAD_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareLink {
    pub url: String,
    /// RFC 3339; when the link stops working.
    pub expires_at: String,
    /// True if the link was cut short because the credentials expire first.
    pub limited_by_credentials: bool,
    /// Temporary credentials (SSO, assumed role) sign links that die with the session.
    pub temporary_credentials: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectProperties {
    pub size: u64,
    pub last_modified: Option<String>,
    pub etag: Option<String>,
    pub content_type: Option<String>,
    pub storage_class: String,
    pub version_id: Option<String>,
    pub server_side_encryption: Option<String>,
    pub kms_key_id: Option<String>,
    pub cache_control: Option<String>,
    pub content_encoding: Option<String>,
    pub content_disposition: Option<String>,
    /// User-defined metadata (x-amz-meta-*).
    pub metadata: std::collections::BTreeMap<String, String>,
    /// Bucket region (real AWS) or connection region (custom endpoint).
    pub region: String,
}

/// Result of writing a folder listing to a text file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingResult {
    pub objects: u64,
    pub bytes: u64,
    pub path: String,
}

/// Keys per DeleteObjects request (the S3 maximum).
const DELETE_BATCH: usize = 1000;

/// Keys per ListObjectsV2 request (the S3 maximum).
const PAGE_SIZE: i32 = 1000;
/// Upper bound on pages scanned when listing sub-folders for the tree.
const TREE_MAX_PAGES: usize = 50;

pub struct Connection {
    pub info: ConnectionInfo,
    sdk_config: SdkConfig,
    base: Client,
    /// region -> client (real AWS only).
    regional: Mutex<HashMap<String, Client>>,
    /// bucket -> region (real AWS only).
    bucket_regions: Mutex<HashMap<String, String>>,
    /// Region chosen in the toolbar for the regional services.
    service_region: Mutex<String>,
}

impl Connection {
    /// Builds a connection for `profile`. No network calls happen here:
    /// credentials are resolved lazily on the first request.
    pub async fn new(
        profile: &ProfileInfo,
        ovr: Option<&ConnectionOverride>,
    ) -> Result<Self, AppError> {
        // rustls + ring: no OpenSSL, no CMake/NASM needed on Windows.
        let http_client = aws_smithy_http_client::Builder::new()
            .tls_provider(tls::Provider::Rustls(
                tls::rustls_provider::CryptoMode::Ring,
            ))
            .build_https();

        let timeouts = TimeoutConfig::builder()
            .connect_timeout(Duration::from_secs(5))
            .build();

        let override_endpoint = ovr
            .and_then(|o| o.endpoint_url.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);

        let mut loader = aws_config::defaults(BehaviorVersion::latest())
            .profile_name(&profile.name)
            .http_client(http_client)
            .timeout_config(timeouts);
        if let Some(ep) = &override_endpoint {
            loader = loader.endpoint_url(ep);
        }
        let sdk_config = loader.load().await;

        // Endpoint precedence: app override > SDK-resolved (profile/env) > our own profile parse.
        let (endpoint_url, endpoint_source) = match override_endpoint {
            Some(ep) => (Some(ep), Some(EndpointSource::Override)),
            None => match sdk_config
                .endpoint_url()
                .map(String::from)
                .or_else(|| profile.endpoint_url.clone())
            {
                Some(ep) => (Some(ep), Some(EndpointSource::Profile)),
                None => (None, None),
            },
        };

        let region = sdk_config
            .region()
            .map(|r| r.to_string())
            .or_else(|| profile.region.clone())
            .unwrap_or_else(|| FALLBACK_REGION.to_string());

        let path_style = ovr
            .and_then(|o| o.path_style)
            .unwrap_or(endpoint_url.is_some());

        let info = ConnectionInfo {
            profile: profile.name.clone(),
            region: region.clone(),
            endpoint_url,
            endpoint_source,
            path_style,
            service_region: region.clone(),
            read_only: false,
        };
        let base = build_client(&sdk_config, &info, &region);

        Ok(Self {
            info,
            sdk_config,
            base,
            regional: Mutex::new(HashMap::new()),
            bucket_regions: Mutex::new(HashMap::new()),
            service_region: Mutex::new(region.clone()),
        })
    }

    /// Connection details with the currently selected service region.
    pub fn current_info(&self) -> ConnectionInfo {
        ConnectionInfo {
            service_region: self.service_region(),
            ..self.info.clone()
        }
    }

    pub fn service_region(&self) -> String {
        self.service_region.lock().unwrap().clone()
    }

    pub fn set_service_region(&self, region: &str) {
        *self.service_region.lock().unwrap() = region.to_string();
    }

    /// SDK config for the regional services: same credentials and endpoint
    /// (custom endpoints such as LocalStack serve every service), with the
    /// selected service region.
    #[allow(dead_code)] // used by the regional services from Phase 1
    pub fn service_config(&self) -> SdkConfig {
        self.sdk_config
            .to_builder()
            .region(Region::new(self.service_region()))
            .build()
    }

    fn is_custom(&self) -> bool {
        self.info.endpoint_url.is_some()
    }

    pub(crate) fn err<E: std::error::Error>(&self, e: E) -> AppError {
        AppError::from_sdk(e, &self.info.profile, self.info.endpoint_url.as_deref())
    }

    /// Returns a client for the bucket's region (real AWS), or the single
    /// client for a custom endpoint.
    pub async fn client_for(&self, bucket: &str) -> Result<Client, AppError> {
        if self.is_custom() {
            return Ok(self.base.clone());
        }
        let known = self.bucket_regions.lock().unwrap().get(bucket).cloned();
        let region = match known {
            Some(r) => r,
            None => {
                let out = self
                    .base
                    .get_bucket_location()
                    .bucket(bucket)
                    .send()
                    .await
                    .map_err(|e| self.err(e))?;
                // Empty constraint = us-east-1; legacy "EU" = eu-west-1.
                let r = match out.location_constraint().map(|c| c.as_str()) {
                    None | Some("") => "us-east-1".to_string(),
                    Some("EU") => "eu-west-1".to_string(),
                    Some(other) => other.to_string(),
                };
                self.bucket_regions
                    .lock()
                    .unwrap()
                    .insert(bucket.to_string(), r.clone());
                r
            }
        };
        Ok(self.regional_client(&region))
    }

    fn regional_client(&self, region: &str) -> Client {
        if region == self.info.region {
            return self.base.clone();
        }
        let mut map = self.regional.lock().unwrap();
        map.entry(region.to_string())
            .or_insert_with(|| build_client(&self.sdk_config, &self.info, region))
            .clone()
    }

    pub async fn list_buckets(&self) -> Result<Vec<BucketInfo>, AppError> {
        let mut buckets = Vec::new();
        let mut token: Option<String> = None;
        loop {
            // Passing max_buckets makes AWS include each bucket's region.
            let out = self
                .base
                .list_buckets()
                .max_buckets(1000)
                .set_continuation_token(token.clone())
                .send()
                .await
                .map_err(|e| self.err(e))?;

            for b in out.buckets() {
                let Some(name) = b.name() else { continue };
                let region = if self.is_custom() {
                    Some(self.info.region.clone())
                } else {
                    b.bucket_region().map(String::from)
                };
                if let (false, Some(r)) = (self.is_custom(), &region) {
                    self.bucket_regions
                        .lock()
                        .unwrap()
                        .insert(name.to_string(), r.clone());
                }
                buckets.push(BucketInfo {
                    name: name.to_string(),
                    creation_date: b
                        .creation_date()
                        .and_then(|d| d.fmt(DateTimeFormat::DateTime).ok()),
                    region,
                });
            }

            token = out.continuation_token().map(String::from);
            // Guard against emulators that echo a token without progressing.
            if token.is_none() || out.buckets().is_empty() {
                break;
            }
        }
        buckets.sort_by_key(|b| b.name.to_lowercase());
        Ok(buckets)
    }

    /// One page of the folder view of `prefix` ("" = bucket root, otherwise ends in "/").
    pub async fn list_page(
        &self,
        bucket: &str,
        prefix: &str,
        token: Option<String>,
    ) -> Result<ListPage, AppError> {
        self.list_page_with(bucket, prefix, token, PAGE_SIZE, false)
            .await
    }

    /// One page of up to `page_size` rows (1–1,000) for keys starting with
    /// `prefix` (which may end mid-name, for a search). `recursive` lists every
    /// object below instead of one folder level (folder markers are skipped).
    pub async fn list_page_with(
        &self,
        bucket: &str,
        prefix: &str,
        token: Option<String>,
        page_size: i32,
        recursive: bool,
    ) -> Result<ListPage, AppError> {
        let client = self.client_for(bucket).await?;
        let out = client
            .list_objects_v2()
            .bucket(bucket)
            .set_prefix((!prefix.is_empty()).then(|| prefix.to_string()))
            .set_delimiter((!recursive).then(|| "/".to_string()))
            .max_keys(page_size.clamp(1, PAGE_SIZE))
            .set_continuation_token(token)
            .send()
            .await
            .map_err(|e| self.err(e))?;

        let folders = out
            .common_prefixes()
            .iter()
            .filter_map(|p| p.prefix())
            .filter(|p| *p != prefix)
            .map(String::from)
            .collect();

        let files = out
            .contents()
            .iter()
            .filter_map(|o| {
                let key = o.key()?;
                // A zero-byte "prefix/" object is a folder marker, not a file.
                if key == prefix || (recursive && key.ends_with('/')) {
                    return None;
                }
                Some(ObjectInfo {
                    key: key.to_string(),
                    size: o.size().unwrap_or(0),
                    last_modified: o
                        .last_modified()
                        .and_then(|d| d.fmt(DateTimeFormat::DateTime).ok()),
                    storage_class: o.storage_class().map(|c| c.as_str().to_string()),
                    etag: o.e_tag().map(|t| t.trim_matches('"').to_string()),
                })
            })
            .collect();

        let next_token = if out.is_truncated().unwrap_or(false) {
            out.next_continuation_token().map(String::from)
        } else {
            None
        };

        Ok(ListPage {
            folders,
            files,
            next_token,
        })
    }

    /// Which of `keys` exist (HeadObject, 8 at a time). Used for overwrite
    /// warnings when the folder isn't fully listed on screen.
    pub async fn existing_keys(
        &self,
        bucket: &str,
        keys: &[String],
    ) -> Result<Vec<String>, AppError> {
        let client = self.client_for(bucket).await?;
        let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
        let mut set = tokio::task::JoinSet::new();
        for key in keys.iter().cloned() {
            let (client, sem, bucket) = (client.clone(), sem.clone(), bucket.to_string());
            set.spawn(async move {
                let _permit = sem.acquire().await;
                let res = client.head_object().bucket(bucket).key(&key).send().await;
                (key, res)
            });
        }
        let mut found = Vec::new();
        while let Some(joined) = set.join_next().await {
            let (key, res) =
                joined.map_err(|e| AppError::new(crate::error::ErrorKind::Other, e.to_string()))?;
            match res {
                Ok(_) => found.push(key),
                Err(e) if e.as_service_error().is_some_and(|s| s.is_not_found()) => {}
                Err(e) if e.raw_response().is_some_and(|r| r.status().as_u16() == 404) => {}
                Err(e) => return Err(self.err(e)),
            }
        }
        found.sort();
        Ok(found)
    }

    /// Loads a preview: whole text/images up to PREVIEW_LIMIT; the first part of
    /// larger text files; nothing for other types.
    pub async fn preview(&self, bucket: &str, key: &str) -> Result<PreviewResult, AppError> {
        let client = self.client_for(bucket).await?;
        let head = client
            .head_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| self.err(e))?;
        let size = head.content_length().unwrap_or(0).max(0) as u64;
        let content_type = head.content_type().map(String::from);
        let kind = preview_kind(key, content_type.as_deref());

        let fetch = |range: Option<String>| {
            let client = client.clone();
            async move {
                let out = client
                    .get_object()
                    .bucket(bucket)
                    .key(key)
                    .set_range(range)
                    .send()
                    .await
                    .map_err(|e| self.err(e))?;
                out.body
                    .collect()
                    .await
                    .map(|b| b.into_bytes().to_vec())
                    .map_err(|e| {
                        AppError::new(
                            crate::error::ErrorKind::Other,
                            format!("Download interrupted: {e}"),
                        )
                    })
            }
        };

        let preview = match kind {
            PreviewKind::Image if size > PREVIEW_LIMIT => Preview::TooLarge {
                limit: PREVIEW_LIMIT,
            },
            PreviewKind::Image => {
                let bytes = fetch(None).await?;
                let mime = content_type
                    .clone()
                    .filter(|c| c.starts_with("image/"))
                    .unwrap_or_else(|| crate::transfers::guess_content_type(key).to_string());
                Preview::Image {
                    data_url: format!(
                        "data:{mime};base64,{}",
                        aws_smithy_types::base64::encode(bytes)
                    ),
                }
            }
            PreviewKind::Text | PreviewKind::Maybe => {
                let truncated = size > PREVIEW_LIMIT;
                let range = truncated.then(|| format!("bytes=0-{}", TEXT_HEAD_BYTES - 1));
                let bytes = fetch(range).await?;
                if looks_binary(&bytes) {
                    Preview::Unsupported
                } else {
                    Preview::Text {
                        text: decode_text(&bytes, truncated),
                        truncated,
                    }
                }
            }
            PreviewKind::None => Preview::Unsupported,
        };
        Ok(PreviewResult {
            size,
            content_type,
            preview,
        })
    }

    /// Creates a presigned GET URL. If the signing credentials expire sooner
    /// than requested (SSO / assumed role), the link expiry is shortened to match.
    pub async fn share_link(
        &self,
        bucket: &str,
        key: &str,
        expires_secs: u64,
    ) -> Result<ShareLink, AppError> {
        use aws_credential_types::provider::ProvideCredentials;
        use aws_sdk_s3::presigning::PresigningConfig;
        use std::time::{Duration, SystemTime};

        // S3 caps presigned URLs at 7 days.
        let requested = Duration::from_secs(expires_secs.clamp(60, 7 * 24 * 3600));
        let creds = match self.sdk_config.credentials_provider() {
            Some(p) => Some(p.provide_credentials().await.map_err(|e| {
                AppError::from_sdk(e, &self.info.profile, self.info.endpoint_url.as_deref())
            })?),
            None => None,
        };
        let temporary = creds.as_ref().is_some_and(|c| c.session_token().is_some());
        let now = SystemTime::now();
        let mut expires_in = requested;
        let mut limited = false;
        if let Some(exp) = creds.as_ref().and_then(|c| c.expiry()) {
            if let Ok(left) = exp.duration_since(now) {
                if left < requested {
                    expires_in = left.max(Duration::from_secs(60));
                    limited = true;
                }
            }
        }
        let cfg = PresigningConfig::expires_in(expires_in)
            .map_err(|e| AppError::new(crate::error::ErrorKind::Other, e.to_string()))?;
        let req = self
            .client_for(bucket)
            .await?
            .get_object()
            .bucket(bucket)
            .key(key)
            .presigned(cfg)
            .await
            .map_err(|e| self.err(e))?;
        let expires_at = aws_sdk_s3::primitives::DateTime::from(now + expires_in)
            .fmt(DateTimeFormat::DateTime)
            .unwrap_or_default();
        Ok(ShareLink {
            url: req.uri().to_string(),
            expires_at,
            limited_by_credentials: limited,
            temporary_credentials: temporary,
        })
    }

    /// Object metadata for the Properties dialog.
    pub async fn properties(&self, bucket: &str, key: &str) -> Result<ObjectProperties, AppError> {
        let client = self.client_for(bucket).await?;
        let h = client
            .head_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| self.err(e))?;
        let region = if self.is_custom() {
            self.info.region.clone()
        } else {
            self.bucket_regions
                .lock()
                .unwrap()
                .get(bucket)
                .cloned()
                .unwrap_or_else(|| self.info.region.clone())
        };
        Ok(ObjectProperties {
            size: h.content_length().unwrap_or(0).max(0) as u64,
            last_modified: h
                .last_modified()
                .and_then(|d| d.fmt(DateTimeFormat::DateTime).ok()),
            etag: h.e_tag().map(|t| t.trim_matches('"').to_string()),
            content_type: h.content_type().map(String::from),
            // HeadObject omits the class for STANDARD.
            storage_class: h
                .storage_class()
                .map(|c| c.as_str().to_string())
                .unwrap_or_else(|| "STANDARD".into()),
            version_id: h.version_id().map(String::from).filter(|v| v != "null"),
            server_side_encryption: h.server_side_encryption().map(|e| e.as_str().to_string()),
            kms_key_id: h.ssekms_key_id().map(String::from),
            cache_control: h.cache_control().map(String::from),
            content_encoding: h.content_encoding().map(String::from),
            content_disposition: h.content_disposition().map(String::from),
            metadata: h
                .metadata()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .collect(),
            region,
        })
    }

    /// Creates an empty folder: a zero-byte object whose key ends in "/".
    pub async fn create_folder(&self, bucket: &str, prefix: &str) -> Result<(), AppError> {
        if !prefix.ends_with('/') || prefix == "/" {
            return Err(AppError::new(
                crate::error::ErrorKind::Other,
                "Folder names must end with '/'",
            ));
        }
        self.client_for(bucket)
            .await?
            .put_object()
            .bucket(bucket)
            .key(prefix)
            .body(aws_sdk_s3::primitives::ByteStream::from_static(b""))
            .send()
            .await
            .map_err(|e| self.err(e))?;
        Ok(())
    }

    /// Expands items (object keys, or folder prefixes ending in "/") into every
    /// affected object key with its size.
    async fn expand(&self, bucket: &str, items: &[String]) -> Result<Vec<(String, u64)>, AppError> {
        let mut out = Vec::new();
        for item in items {
            if item.ends_with('/') {
                out.extend(self.list_all(bucket, item).await?);
            } else {
                out.push((item.clone(), 0));
            }
        }
        Ok(out)
    }

    /// Counts what deleting `items` would remove (folders recursively).
    pub async fn count_items(&self, bucket: &str, items: &[String]) -> Result<ItemCount, AppError> {
        let all = self.expand(bucket, items).await?;
        Ok(ItemCount {
            objects: all.len() as u64,
            bytes: all.iter().map(|(_, s)| s).sum(),
        })
    }

    /// Deletes objects and folders (recursively), 1,000 keys per request.
    /// Individual failures are reported rather than aborting the whole delete.
    pub async fn delete_items(
        &self,
        bucket: &str,
        items: &[String],
    ) -> Result<DeleteResult, AppError> {
        use aws_sdk_s3::types::{Delete, ObjectIdentifier};
        let client = self.client_for(bucket).await?;
        let keys: Vec<String> = self
            .expand(bucket, items)
            .await?
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        let mut result = DeleteResult {
            deleted: 0,
            failed: Vec::new(),
        };
        for chunk in keys.chunks(DELETE_BATCH) {
            let objects = chunk
                .iter()
                .map(|k| ObjectIdentifier::builder().key(k).build())
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| AppError::new(crate::error::ErrorKind::Other, e.to_string()))?;
            let delete = Delete::builder()
                .set_objects(Some(objects))
                .quiet(true)
                .build()
                .map_err(|e| AppError::new(crate::error::ErrorKind::Other, e.to_string()))?;
            let out = client
                .delete_objects()
                .bucket(bucket)
                .delete(delete)
                .send()
                .await
                .map_err(|e| self.err(e))?;
            // Quiet mode returns only failures.
            let errors = out.errors();
            result.deleted += (chunk.len() - errors.len()) as u64;
            result.failed.extend(errors.iter().map(|e| {
                DeleteFailure {
                    key: e.key().unwrap_or_default().to_string(),
                    message: e
                        .message()
                        .or(e.code())
                        .unwrap_or("Unknown error")
                        .to_string(),
                }
            }));
        }
        Ok(result)
    }

    /// Writes every object under `prefix` (recursive) to a text file in the
    /// format of `aws s3 ls --recursive --summarize` (times in UTC). Streams page
    /// by page, so huge folders don't need to fit in memory.
    pub async fn write_listing(
        &self,
        bucket: &str,
        prefix: &str,
        dest: &std::path::Path,
    ) -> Result<ListingResult, AppError> {
        use tokio::io::AsyncWriteExt;
        let io_err = |e: std::io::Error| {
            AppError::new(
                crate::error::ErrorKind::Other,
                format!("Can't write {}: {e}", dest.display()),
            )
        };
        let client = self.client_for(bucket).await?;
        let mut tmp_name = dest
            .file_name()
            .map(|n| n.to_os_string())
            .unwrap_or_default();
        tmp_name.push(".s3x-part");
        let tmp = dest.with_file_name(tmp_name);
        let file = tokio::fs::File::create(&tmp).await.map_err(io_err)?;
        let mut w = tokio::io::BufWriter::new(file);

        let result: Result<(u64, u64), AppError> = async {
            let (mut objects, mut bytes) = (0u64, 0u64);
            let mut token = None;
            loop {
                let page = client
                    .list_objects_v2()
                    .bucket(bucket)
                    .set_prefix((!prefix.is_empty()).then(|| prefix.to_string()))
                    .max_keys(PAGE_SIZE)
                    .set_continuation_token(token)
                    .send()
                    .await
                    .map_err(|e| self.err(e))?;
                let mut chunk = String::new();
                for o in page.contents() {
                    let Some(key) = o.key() else { continue };
                    let size = o.size().unwrap_or(0).max(0) as u64;
                    let when = o
                        .last_modified()
                        .and_then(|d| d.fmt(DateTimeFormat::DateTime).ok())
                        .map(|s| s.replace('T', " ").trim_end_matches('Z').chars().take(19).collect::<String>())
                        .unwrap_or_else(|| " ".repeat(19));
                    chunk.push_str(&format!("{when} {size:>10} {key}\r\n"));
                    objects += 1;
                    bytes += size;
                }
                w.write_all(chunk.as_bytes()).await.map_err(io_err)?;
                token = match (page.is_truncated(), page.next_continuation_token()) {
                    (Some(true), Some(t)) => Some(t.to_string()),
                    _ => break,
                };
            }
            let summary = format!(
                "\r\nTotal Objects: {objects}\r\n   Total Size: {bytes}\r\n\r\n(Listing of s3://{bucket}/{prefix}; times are UTC)\r\n"
            );
            w.write_all(summary.as_bytes()).await.map_err(io_err)?;
            w.flush().await.map_err(io_err)?;
            Ok((objects, bytes))
        }
        .await;

        match result {
            Ok((objects, bytes)) => {
                let _ = tokio::fs::remove_file(dest).await;
                tokio::fs::rename(&tmp, dest).await.map_err(io_err)?;
                Ok(ListingResult {
                    objects,
                    bytes,
                    path: dest.to_string_lossy().into_owned(),
                })
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                Err(e)
            }
        }
    }

    /// Every object under `prefix` (recursive) with size and LastModified, for sync.
    pub async fn list_all_detailed(
        &self,
        bucket: &str,
        prefix: &str,
    ) -> Result<Vec<crate::sync::RemoteFile>, AppError> {
        let client = self.client_for(bucket).await?;
        let mut out = Vec::new();
        let mut token = None;
        loop {
            let page = client
                .list_objects_v2()
                .bucket(bucket)
                .set_prefix((!prefix.is_empty()).then(|| prefix.to_string()))
                .max_keys(PAGE_SIZE)
                .set_continuation_token(token)
                .send()
                .await
                .map_err(|e| self.err(e))?;
            for o in page.contents() {
                if let Some(k) = o.key() {
                    out.push(crate::sync::RemoteFile {
                        key: k.to_string(),
                        size: o.size().unwrap_or(0).max(0) as u64,
                        modified: o
                            .last_modified()
                            .and_then(|d| std::time::SystemTime::try_from(*d).ok()),
                    });
                }
            }
            token = match (page.is_truncated(), page.next_continuation_token()) {
                (Some(true), Some(t)) => Some(t.to_string()),
                _ => break,
            };
        }
        Ok(out)
    }

    /// Every object under `prefix` (recursive, no delimiter) as (key, size).
    pub async fn list_all(
        &self,
        bucket: &str,
        prefix: &str,
    ) -> Result<Vec<(String, u64)>, AppError> {
        let client = self.client_for(bucket).await?;
        let mut out = Vec::new();
        let mut token = None;
        loop {
            let page = client
                .list_objects_v2()
                .bucket(bucket)
                .set_prefix((!prefix.is_empty()).then(|| prefix.to_string()))
                .max_keys(PAGE_SIZE)
                .set_continuation_token(token)
                .send()
                .await
                .map_err(|e| self.err(e))?;
            for o in page.contents() {
                if let Some(k) = o.key() {
                    out.push((k.to_string(), o.size().unwrap_or(0).max(0) as u64));
                }
            }
            token = match (page.is_truncated(), page.next_continuation_token()) {
                (Some(true), Some(t)) => Some(t.to_string()),
                _ => break,
            };
        }
        Ok(out)
    }

    /// All sub-folders of `prefix` (bounded by TREE_MAX_PAGES), for the tree.
    pub async fn list_folders(&self, bucket: &str, prefix: &str) -> Result<FolderList, AppError> {
        let mut folders = Vec::new();
        let mut token = None;
        for _ in 0..TREE_MAX_PAGES {
            let page = self.list_page(bucket, prefix, token).await?;
            folders.extend(page.folders);
            token = page.next_token;
            if token.is_none() {
                return Ok(FolderList {
                    folders,
                    complete: true,
                });
            }
        }
        Ok(FolderList {
            folders,
            complete: false,
        })
    }
}

#[derive(Debug, PartialEq)]
enum PreviewKind {
    Text,
    Image,
    /// Unknown type: try as text, give up if it looks binary.
    Maybe,
    None,
}

fn preview_kind(key: &str, content_type: Option<&str>) -> PreviewKind {
    let ext = key
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif" => {
            return PreviewKind::Image
        }
        "txt" | "log" | "md" | "markdown" | "csv" | "tsv" | "json" | "jsonl" | "ndjson" | "xml"
        | "yaml" | "yml" | "toml" | "ini" | "cfg" | "conf" | "env" | "properties" | "html"
        | "htm" | "css" | "js" | "mjs" | "ts" | "tsx" | "jsx" | "py" | "rs" | "go" | "java"
        | "kt" | "c" | "h" | "cpp" | "hpp" | "cs" | "rb" | "php" | "sh" | "bash" | "ps1"
        | "bat" | "sql" | "tf" | "hcl" | "gitignore" | "dockerfile" => return PreviewKind::Text,
        "zip" | "gz" | "tgz" | "bz2" | "xz" | "7z" | "rar" | "tar" | "parquet" | "avro" | "orc"
        | "pdf" | "exe" | "dll" | "so" | "dylib" | "bin" | "iso" | "mp3" | "mp4" | "mov"
        | "avi" | "mkv" | "wav" | "flac" | "xlsx" | "xls" | "docx" | "doc" | "pptx" | "ppt"
        | "woff" | "woff2" | "ttf" | "otf" => return PreviewKind::None,
        _ => {}
    }
    match content_type {
        Some(c) if c.starts_with("image/") => PreviewKind::Image,
        Some(c)
            if c.starts_with("text/")
                || c.contains("json")
                || c.contains("xml")
                || c.contains("yaml")
                || c.contains("javascript") =>
        {
            PreviewKind::Text
        }
        _ => PreviewKind::Maybe,
    }
}

/// NUL bytes in the first 8 KiB almost always mean binary data.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

/// UTF-8 (lossy). When truncated, drops a final partial line/character.
fn decode_text(bytes: &[u8], truncated: bool) -> String {
    let mut text = String::from_utf8_lossy(bytes).into_owned();
    if truncated {
        if let Some(i) = text.rfind('\n') {
            text.truncate(i + 1);
        }
    }
    text.strip_prefix('\u{feff}')
        .map(String::from)
        .unwrap_or(text)
}

fn build_client(sdk: &SdkConfig, info: &ConnectionInfo, region: &str) -> Client {
    let mut b = aws_sdk_s3::config::Builder::from(sdk)
        .region(Region::new(region.to_string()))
        .force_path_style(info.path_style);
    if let Some(ep) = &info.endpoint_url {
        b = b
            .endpoint_url(ep)
            // S3-compatible emulators don't always support the newer default
            // integrity checksums, so only send/validate them when required.
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired);
    }
    Client::from_conf(b.build())
}

#[cfg(test)]
mod tests {
    //! Emulator tests. Run with an S3 emulator on localhost:4566, e.g.
    //! `docker run -p 4566:4566 localstack/localstack`, then:
    //! `cargo test -- --ignored`
    use super::*;
    use crate::error::ErrorKind;

    fn write_profile(dir: &std::path::Path, endpoint: &str) {
        std::fs::write(
            dir.join("config"),
            format!("[profile emu]\nregion = eu-west-2\nendpoint_url = {endpoint}\n"),
        )
        .unwrap();
        std::fs::write(
            dir.join("credentials"),
            "[emu]\naws_access_key_id = test\naws_secret_access_key = test\n",
        )
        .unwrap();
        // SAFETY: tests touching env run single-threaded via --test-threads=1.
        unsafe {
            std::env::set_var("AWS_CONFIG_FILE", dir.join("config"));
            std::env::set_var("AWS_SHARED_CREDENTIALS_FILE", dir.join("credentials"));
        }
    }

    #[tokio::test]
    #[ignore]
    async fn lists_buckets_from_profile_endpoint() {
        let dir = std::env::temp_dir().join("s3x-test-ok");
        std::fs::create_dir_all(&dir).unwrap();
        write_profile(&dir, "http://localhost:4566");

        let profile = crate::profiles::list_profiles()
            .into_iter()
            .find(|p| p.name == "emu")
            .expect("profile parsed");
        let conn = Connection::new(&profile, None).await.unwrap();
        assert_eq!(
            conn.info.endpoint_url.as_deref(),
            Some("http://localhost:4566")
        );
        assert_eq!(conn.info.endpoint_source, Some(EndpointSource::Profile));
        assert!(conn.info.path_style);
        assert_eq!(conn.info.region, "eu-west-2");

        let _ = conn
            .base
            .create_bucket()
            .bucket("s3x-test-bucket")
            .create_bucket_configuration(
                aws_sdk_s3::types::CreateBucketConfiguration::builder()
                    .location_constraint(aws_sdk_s3::types::BucketLocationConstraint::EuWest2)
                    .build(),
            )
            .send()
            .await;
        let buckets = conn.list_buckets().await.unwrap();
        assert!(
            buckets.iter().any(|b| b.name == "s3x-test-bucket"),
            "{buckets:?}"
        );
        let client = conn.client_for("s3x-test-bucket").await.unwrap();
        client
            .head_bucket()
            .bucket("s3x-test-bucket")
            .send()
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn lists_folders_and_files() {
        let dir = std::env::temp_dir().join("s3x-test-list");
        std::fs::create_dir_all(&dir).unwrap();
        write_profile(&dir, "http://localhost:4566");
        let profile = crate::profiles::list_profiles()
            .into_iter()
            .find(|p| p.name == "emu")
            .unwrap();
        let conn = Connection::new(&profile, None).await.unwrap();
        let bucket = "s3x-list-bucket";
        let _ = conn
            .base
            .create_bucket()
            .bucket(bucket)
            .create_bucket_configuration(
                aws_sdk_s3::types::CreateBucketConfiguration::builder()
                    .location_constraint(aws_sdk_s3::types::BucketLocationConstraint::EuWest2)
                    .build(),
            )
            .send()
            .await;
        for key in [
            "root.txt",
            "docs/",
            "docs/a.txt",
            "docs/sub/b.txt",
            "logs/2026/x.log",
        ] {
            conn.base
                .put_object()
                .bucket(bucket)
                .key(key)
                .body(aws_sdk_s3::primitives::ByteStream::from_static(b"hello"))
                .send()
                .await
                .unwrap();
        }
        // 1,050 files to exercise pagination.
        for i in 0..1050 {
            conn.base
                .put_object()
                .bucket(bucket)
                .key(format!("many/f{i:04}.txt"))
                .body(aws_sdk_s3::primitives::ByteStream::from_static(b"x"))
                .send()
                .await
                .unwrap();
        }

        let root = conn.list_page(bucket, "", None).await.unwrap();
        assert_eq!(root.folders, vec!["docs/", "logs/", "many/"]);
        assert_eq!(root.files.len(), 1);
        assert_eq!(root.files[0].key, "root.txt");
        assert_eq!(root.files[0].size, 5);
        assert!(root.next_token.is_none());

        // Folder marker "docs/" is not listed as a file.
        let docs = conn.list_page(bucket, "docs/", None).await.unwrap();
        assert_eq!(docs.folders, vec!["docs/sub/"]);
        assert_eq!(
            docs.files
                .iter()
                .map(|f| f.key.as_str())
                .collect::<Vec<_>>(),
            vec!["docs/a.txt"]
        );

        let p1 = conn.list_page(bucket, "many/", None).await.unwrap();
        assert_eq!(p1.files.len(), 1000);
        let p2 = conn
            .list_page(bucket, "many/", p1.next_token.clone())
            .await
            .unwrap();
        assert_eq!(p2.files.len(), 50);
        assert!(p2.next_token.is_none());

        let tree = conn.list_folders(bucket, "").await.unwrap();
        assert!(tree.complete);
        assert_eq!(tree.folders, vec!["docs/", "logs/", "many/"]);

        // Page size: 100 rows per page.
        let small = conn
            .list_page_with(bucket, "many/", None, 100, false)
            .await
            .unwrap();
        assert_eq!(small.files.len(), 100);
        let next = conn
            .list_page_with(bucket, "many/", small.next_token, 100, false)
            .await
            .unwrap();
        assert_eq!(next.files[0].key, "many/f0100.txt");
        // Search = a longer prefix; folders count as rows too.
        let found = conn
            .list_page_with(bucket, "many/f104", None, 100, false)
            .await
            .unwrap();
        assert_eq!(found.files.len(), 10);
        let root = conn
            .list_page_with(bucket, "", None, 2, false)
            .await
            .unwrap();
        assert_eq!(root.folders.len() + root.files.len(), 2);
        assert!(root.next_token.is_some());
        // Recursive: every object below, without the folder marker.
        let rec = conn
            .list_page_with(bucket, "docs/", None, 100, true)
            .await
            .unwrap();
        assert!(rec.folders.is_empty());
        assert_eq!(
            rec.files.iter().map(|f| f.key.as_str()).collect::<Vec<_>>(),
            vec!["docs/a.txt", "docs/sub/b.txt"]
        );

        let keys = vec![
            "docs/a.txt".to_string(),
            "docs/nope.txt".to_string(),
            "root.txt".to_string(),
        ];
        assert_eq!(
            conn.existing_keys(bucket, &keys).await.unwrap(),
            vec!["docs/a.txt", "root.txt"]
        );
    }

    #[tokio::test]
    #[ignore]
    async fn creates_counts_and_deletes() {
        let dir = std::env::temp_dir().join("s3x-test-del");
        std::fs::create_dir_all(&dir).unwrap();
        write_profile(&dir, "http://localhost:4566");
        let profile = crate::profiles::list_profiles()
            .into_iter()
            .find(|p| p.name == "emu")
            .unwrap();
        let conn = Connection::new(&profile, None).await.unwrap();
        let bucket = "s3x-del-bucket";
        let _ = conn
            .base
            .create_bucket()
            .bucket(bucket)
            .create_bucket_configuration(
                aws_sdk_s3::types::CreateBucketConfiguration::builder()
                    .location_constraint(aws_sdk_s3::types::BucketLocationConstraint::EuWest2)
                    .build(),
            )
            .send()
            .await;

        conn.create_folder(bucket, "new/").await.unwrap();
        assert!(conn.create_folder(bucket, "bad").await.is_err());
        let root = conn.list_page(bucket, "", None).await.unwrap();
        assert!(root.folders.contains(&"new/".to_string()));

        // 1,200 objects to exercise delete batching.
        for i in 0..1200 {
            conn.base
                .put_object()
                .bucket(bucket)
                .key(format!("new/sub/f{i:04}"))
                .body(aws_sdk_s3::primitives::ByteStream::from_static(b"abc"))
                .send()
                .await
                .unwrap();
        }
        conn.base
            .put_object()
            .bucket(bucket)
            .key("keep.txt")
            .body(aws_sdk_s3::primitives::ByteStream::from_static(b"k"))
            .send()
            .await
            .unwrap();

        let count = conn.count_items(bucket, &["new/".into()]).await.unwrap();
        assert_eq!(count.objects, 1201); // + folder marker
        assert_eq!(count.bytes, 3600);

        let res = conn.delete_items(bucket, &["new/".into()]).await.unwrap();
        assert_eq!(res.deleted, 1201, "{:?}", res.failed);
        assert!(res.failed.is_empty());
        assert!(conn.list_all(bucket, "new/").await.unwrap().is_empty());
        assert_eq!(conn.list_all(bucket, "").await.unwrap().len(), 1);

        let res = conn
            .delete_items(bucket, &["keep.txt".into()])
            .await
            .unwrap();
        assert_eq!(res.deleted, 1);
    }

    #[test]
    fn classifies_preview_types() {
        assert_eq!(preview_kind("a/b.JSON", None), PreviewKind::Text);
        assert_eq!(
            preview_kind("pic.png", Some("application/octet-stream")),
            PreviewKind::Image
        );
        assert_eq!(
            preview_kind("data.parquet", Some("text/plain")),
            PreviewKind::None
        );
        assert_eq!(preview_kind("noext", Some("text/plain")), PreviewKind::Text);
        assert_eq!(preview_kind("noext", None), PreviewKind::Maybe);
        assert!(looks_binary(b"ab\0cd"));
        assert_eq!(
            decode_text(b"\xef\xbb\xbfline1\nline2\npart", true),
            "line1\nline2\n"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn previews_shares_and_properties() {
        let dir = std::env::temp_dir().join("s3x-test-preview");
        std::fs::create_dir_all(&dir).unwrap();
        write_profile(&dir, "http://localhost:4566");
        let profile = crate::profiles::list_profiles()
            .into_iter()
            .find(|p| p.name == "emu")
            .unwrap();
        let conn = Connection::new(&profile, None).await.unwrap();
        let bucket = "s3x-preview-bucket";
        let _ = conn
            .base
            .create_bucket()
            .bucket(bucket)
            .create_bucket_configuration(
                aws_sdk_s3::types::CreateBucketConfiguration::builder()
                    .location_constraint(aws_sdk_s3::types::BucketLocationConstraint::EuWest2)
                    .build(),
            )
            .send()
            .await;
        let put = |key: &'static str, data: Vec<u8>, ct: &'static str| {
            let c = conn.base.clone();
            async move {
                c.put_object()
                    .bucket(bucket)
                    .key(key)
                    .content_type(ct)
                    .metadata("owner", "mark")
                    .body(aws_sdk_s3::primitives::ByteStream::from(data))
                    .send()
                    .await
                    .unwrap();
            }
        };
        put("a.json", br#"{"x":1}"#.to_vec(), "application/json").await;
        put(
            "pic.png",
            vec![0x89, b'P', b'N', b'G', 0, 1, 2],
            "image/png",
        )
        .await;
        put("blob", vec![1, 0, 2, 3], "application/octet-stream").await;
        let big: Vec<u8> = (0..(PREVIEW_LIMIT as usize + 1000))
            .map(|i| if i % 80 == 79 { b'\n' } else { b'a' })
            .collect();
        put("big.log", big, "text/plain").await;

        match conn.preview(bucket, "a.json").await.unwrap().preview {
            Preview::Text { text, truncated } => {
                assert_eq!(text, r#"{"x":1}"#);
                assert!(!truncated);
            }
            p => panic!("{p:?}"),
        }
        match conn.preview(bucket, "pic.png").await.unwrap().preview {
            Preview::Image { data_url } => assert!(data_url.starts_with("data:image/png;base64,")),
            p => panic!("{p:?}"),
        }
        assert!(matches!(
            conn.preview(bucket, "blob").await.unwrap().preview,
            Preview::Unsupported
        ));
        match conn.preview(bucket, "big.log").await.unwrap().preview {
            Preview::Text { text, truncated } => {
                assert!(truncated);
                assert!(text.len() as u64 <= TEXT_HEAD_BYTES && text.ends_with('\n'));
            }
            p => panic!("{p:?}"),
        }

        let link = conn.share_link(bucket, "a.json", 3600).await.unwrap();
        assert!(
            link.url
                .starts_with("http://localhost:4566/s3x-preview-bucket/a.json?"),
            "{}",
            link.url
        );
        assert!(link.url.contains("X-Amz-Expires=3600"));
        assert!(!link.temporary_credentials);

        let props = conn.properties(bucket, "a.json").await.unwrap();
        assert_eq!(props.size, 7);
        assert_eq!(props.content_type.as_deref(), Some("application/json"));
        assert_eq!(props.storage_class, "STANDARD");
        assert_eq!(
            props.metadata.get("owner").map(String::as_str),
            Some("mark")
        );
    }

    #[tokio::test]
    #[ignore]
    async fn writes_recursive_listing() {
        let dir = std::env::temp_dir().join("s3x-test-listing");
        std::fs::create_dir_all(&dir).unwrap();
        write_profile(&dir, "http://localhost:4566");
        let profile = crate::profiles::list_profiles()
            .into_iter()
            .find(|p| p.name == "emu")
            .unwrap();
        let conn = Connection::new(&profile, None).await.unwrap();
        let bucket = "s3x-listing-bucket";
        let _ = conn
            .base
            .create_bucket()
            .bucket(bucket)
            .create_bucket_configuration(
                aws_sdk_s3::types::CreateBucketConfiguration::builder()
                    .location_constraint(aws_sdk_s3::types::BucketLocationConstraint::EuWest2)
                    .build(),
            )
            .send()
            .await;
        for i in 0..1100 {
            conn.base
                .put_object()
                .bucket(bucket)
                .key(format!("data/sub{}/f{i:04}.txt", i % 3))
                .body(aws_sdk_s3::primitives::ByteStream::from_static(b"12345"))
                .send()
                .await
                .unwrap();
        }
        conn.base
            .put_object()
            .bucket(bucket)
            .key("other.txt")
            .body(aws_sdk_s3::primitives::ByteStream::from_static(b"x"))
            .send()
            .await
            .unwrap();

        let dest = dir.join("listing.txt");
        let res = conn.write_listing(bucket, "data/", &dest).await.unwrap();
        assert_eq!(res.objects, 1100);
        assert_eq!(res.bytes, 5500);
        let text = std::fs::read_to_string(&dest).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert!(
            lines[0].ends_with("          5 data/sub0/f0000.txt"),
            "{}",
            lines[0]
        );
        assert_eq!(
            lines[0].len(),
            19 + 1 + 10 + 1 + "data/sub0/f0000.txt".len()
        );
        assert!(!text.contains("other.txt"));
        assert!(text.contains("Total Objects: 1100"));
        assert!(text.contains("Total Size: 5500"));
    }

    #[tokio::test]
    #[ignore]
    async fn unreachable_endpoint_is_classified() {
        let dir = std::env::temp_dir().join("s3x-test-down");
        std::fs::create_dir_all(&dir).unwrap();
        write_profile(&dir, "http://localhost:4599");
        let profile = crate::profiles::list_profiles()
            .into_iter()
            .find(|p| p.name == "emu")
            .unwrap();
        let conn = Connection::new(&profile, None).await.unwrap();
        let err = conn.list_buckets().await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Unreachable, "{err:?}");
        assert!(err.message.contains("localhost:4599"), "{}", err.message);
    }

    #[tokio::test]
    #[ignore]
    async fn service_region_is_switchable() {
        let dir = std::env::temp_dir().join("s3x-test-region");
        std::fs::create_dir_all(&dir).unwrap();
        write_profile(&dir, "http://localhost:4566");
        let profile = crate::profiles::list_profiles()
            .into_iter()
            .find(|p| p.name == "emu")
            .unwrap();
        let conn = Connection::new(&profile, None).await.unwrap();
        assert_eq!(conn.current_info().service_region, "eu-west-2");
        conn.set_service_region("ap-southeast-2");
        assert_eq!(conn.current_info().service_region, "ap-southeast-2");
        assert_eq!(
            conn.current_info().region,
            "eu-west-2",
            "profile region unchanged (S3)"
        );
        let cfg = conn.service_config();
        assert_eq!(cfg.region().map(|r| r.as_ref()), Some("ap-southeast-2"));
        assert_eq!(
            cfg.endpoint_url(),
            Some("http://localhost:4566"),
            "same endpoint for all services"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn override_beats_profile_endpoint() {
        let dir = std::env::temp_dir().join("s3x-test-ovr");
        std::fs::create_dir_all(&dir).unwrap();
        write_profile(&dir, "http://localhost:4599");
        let profile = crate::profiles::list_profiles()
            .into_iter()
            .find(|p| p.name == "emu")
            .unwrap();
        let ovr = ConnectionOverride {
            endpoint_url: Some("http://localhost:4566".into()),
            path_style: None,
        };
        let conn = Connection::new(&profile, Some(&ovr)).await.unwrap();
        assert_eq!(conn.info.endpoint_source, Some(EndpointSource::Override));
        conn.list_buckets().await.unwrap();
    }
}

#[cfg(test)]
mod serde_tests {
    use super::*;

    #[test]
    fn preview_serialises_for_the_ui() {
        let v = serde_json::to_value(Preview::Image {
            data_url: "x".into(),
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({"kind": "image", "dataUrl": "x"}));
        let v = serde_json::to_value(Preview::TooLarge { limit: 5 }).unwrap();
        assert_eq!(v, serde_json::json!({"kind": "tooLarge", "limit": 5}));
    }
}
