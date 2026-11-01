//! Errors returned to the UI, classified so it can show helpful guidance
//! instead of raw SDK error chains.

use aws_sdk_s3::error::DisplayErrorContext;
use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// No connection has been made yet (UI bug or race).
    NotConnected,
    /// SSO token missing or expired: user should run `aws sso login`.
    SsoExpired,
    /// No usable credentials for the profile.
    NoCredentials,
    /// Endpoint could not be reached (emulator not running, offline, DNS).
    Unreachable,
    /// Credentials valid but not permitted.
    AccessDenied,
    /// Refused because read-only mode is on for this profile.
    ReadOnly,
    /// Anything else.
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    /// Short human message for the UI.
    pub message: String,
    /// Full error chain, shown under "Details".
    pub detail: String,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            kind,
            detail: message.clone(),
            message,
        }
    }

    pub fn read_only() -> Self {
        Self::new(
            ErrorKind::ReadOnly,
            "Read-only mode is on for this profile, so changes are disabled. Turn it off with the lock in the toolbar.",
        )
    }

    pub fn not_connected() -> Self {
        Self::new(
            ErrorKind::NotConnected,
            "Not connected. Choose a profile first.",
        )
    }

    /// Classifies any SDK error using its full display chain.
    pub fn from_sdk<E: std::error::Error>(err: E, profile: &str, endpoint: Option<&str>) -> Self {
        let detail = DisplayErrorContext(&err).to_string();
        let lower = detail.to_ascii_lowercase();

        let (kind, message) =
            if lower.contains("sso") && (lower.contains("expired") || lower.contains("token")) {
                (
                    ErrorKind::SsoExpired,
                    format!(
                        "Your SSO session for profile '{profile}' has expired or is missing. \
                     Run: aws sso login --profile {profile}"
                    ),
                )
            } else if lower.contains("accessdenied")
                || lower.contains("access denied")
                || lower.contains("forbidden")
            {
                (
                    ErrorKind::AccessDenied,
                    format!("Access denied for profile '{profile}'."),
                )
            } else if lower.contains("no credentials")
                || lower.contains("credentials provider")
                || lower.contains("could not load credentials")
                || lower.contains("profile file")
                || lower.contains("invalidaccesskeyid")
                || lower.contains("signaturedoesnotmatch")
            {
                (
                    ErrorKind::NoCredentials,
                    format!("Could not get valid credentials for profile '{profile}'."),
                )
            } else if lower.contains("dispatch failure")
                || lower.contains("connection refused")
                || lower.contains("tcp connect")
                || lower.contains("dns error")
                || lower.contains("timed out")
                || lower.contains("timeout")
            {
                let target = endpoint.unwrap_or("AWS");
                let hint = if endpoint.is_some() {
                    " Is the emulator (e.g. LocalStack) running?"
                } else {
                    " Check your network connection."
                };
                (
                    ErrorKind::Unreachable,
                    format!("Can't reach {target}.{hint}"),
                )
            } else {
                (ErrorKind::Other, first_line(&detail))
            };

        Self {
            kind,
            message,
            detail,
        }
    }
}

fn first_line(s: &str) -> String {
    let line = s.lines().next().unwrap_or(s);
    if line.chars().count() > 300 {
        format!("{}…", line.chars().take(300).collect::<String>())
    } else {
        line.to_string()
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::new(ErrorKind::Other, s)
    }
}
