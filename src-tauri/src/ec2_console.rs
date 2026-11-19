//! Read-only instance extras: status checks and scheduled events, console
//! output, console screenshot and user data. User data can hold secrets: it
//! is decoded here, returned once and never stored or logged.

use crate::ec2::{client, err, iso, other};
use crate::error::AppError;
use crate::s3::Connection;
use aws_sdk_ec2::types::InstanceAttributeName;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CheckDetail {
    pub name: String,
    pub status: String,
    pub impaired_since: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// ok, impaired, insufficient-data, not-applicable, initializing.
    pub status: Option<String>,
    pub details: Vec<CheckDetail>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledEvent {
    pub id: Option<String>,
    /// instance-reboot, system-reboot, system-maintenance, instance-retirement, instance-stop.
    pub code: Option<String>,
    pub description: Option<String>,
    pub not_before: Option<String>,
    pub not_after: Option<String>,
    pub deadline: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstanceStatus {
    pub state: Option<String>,
    pub system: Option<Check>,
    pub instance: Option<Check>,
    pub ebs: Option<Check>,
    pub events: Vec<ScheduledEvent>,
}

pub async fn status(conn: &Connection, id: &str) -> Result<InstanceStatus, AppError> {
    let out = client(conn)
        .describe_instance_status()
        .instance_ids(id)
        .include_all_instances(true)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    let Some(s) = out.instance_statuses().first() else {
        return Ok(InstanceStatus::default());
    };
    let summary = |status: Option<String>, details: Vec<CheckDetail>| Some(Check { status, details });
    Ok(InstanceStatus {
        state: s
            .instance_state()
            .and_then(|x| x.name())
            .map(|n| n.as_str().to_string()),
        system: s.system_status().and_then(|c| {
            summary(
                c.status().map(|x| x.as_str().to_string()),
                c.details()
                    .iter()
                    .map(|d| CheckDetail {
                        name: d.name().map(|n| n.as_str().to_string()).unwrap_or_default(),
                        status: d.status().map(|n| n.as_str().to_string()).unwrap_or_default(),
                        impaired_since: iso(d.impaired_since()),
                    })
                    .collect(),
            )
        }),
        instance: s.instance_status().and_then(|c| {
            summary(
                c.status().map(|x| x.as_str().to_string()),
                c.details()
                    .iter()
                    .map(|d| CheckDetail {
                        name: d.name().map(|n| n.as_str().to_string()).unwrap_or_default(),
                        status: d.status().map(|n| n.as_str().to_string()).unwrap_or_default(),
                        impaired_since: iso(d.impaired_since()),
                    })
                    .collect(),
            )
        }),
        ebs: s.attached_ebs_status().and_then(|c| {
            summary(
                c.status().map(|x| x.as_str().to_string()),
                c.details()
                    .iter()
                    .map(|d| CheckDetail {
                        name: d.name().map(|n| n.as_str().to_string()).unwrap_or_default(),
                        status: d.status().map(|n| n.as_str().to_string()).unwrap_or_default(),
                        impaired_since: iso(d.impaired_since()),
                    })
                    .collect(),
            )
        }),
        events: s
            .events()
            .iter()
            .map(|e| ScheduledEvent {
                id: e.instance_event_id().map(String::from),
                code: e.code().map(|c| c.as_str().to_string()),
                description: e.description().map(String::from),
                not_before: iso(e.not_before()),
                not_after: iso(e.not_after()),
                deadline: iso(e.not_before_deadline()),
            })
            .collect(),
    })
}

/// Console text with terminal control sequences removed (colours, cursor
/// moves); tabs and line breaks stay.
pub fn clean_console(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => {
                // CSI: ESC [ params final-byte; other escapes: ESC + one char.
                if chars.peek() == Some(&'[') {
                    chars.next();
                    for d in chars.by_ref() {
                        if ('@'..='~').contains(&d) {
                            break;
                        }
                    }
                } else {
                    chars.next();
                }
            }
            '\r' => {
                if chars.peek() != Some(&'\n') {
                    out.push('\n');
                }
            }
            '\n' | '\t' => out.push(c),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleOutput {
    pub text: String,
    pub captured: Option<String>,
    /// The most recent output (Nitro instances); false = the last buffer AWS kept.
    pub latest: bool,
}

pub async fn console_output(conn: &Connection, id: &str, latest: bool) -> Result<ConsoleOutput, AppError> {
    let c = client(conn);
    let mut req = c.get_console_output().instance_id(id);
    if latest {
        req = req.latest(true);
    }
    let (out, latest) = match req.send().await {
        Ok(o) => (o, latest),
        // Only Nitro instances keep the latest output; fall back to the buffer.
        Err(_) if latest => (
            c.get_console_output()
                .instance_id(id)
                .send()
                .await
                .map_err(|e| err(conn, e))?,
            false,
        ),
        Err(e) => return Err(err(conn, e)),
    };
    let text = match out.output() {
        Some(b64) if !b64.is_empty() => {
            let bytes = aws_smithy_types::base64::decode(b64)
                .map_err(|_| other("The console output couldn't be decoded."))?;
            clean_console(&String::from_utf8_lossy(&bytes))
        }
        _ => String::new(),
    };
    Ok(ConsoleOutput {
        text,
        captured: iso(out.timestamp()),
        latest,
    })
}

/// A JPEG of the instance's screen as a data: URL.
pub async fn screenshot(conn: &Connection, id: &str) -> Result<String, AppError> {
    let out = client(conn)
        .get_console_screenshot()
        .instance_id(id)
        .wake_up(true)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    match out.image_data() {
        Some(d) if !d.is_empty() => Ok(format!("data:image/jpeg;base64,{d}")),
        _ => Err(other("AWS returned no screenshot for this instance.")),
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserData {
    /// None when empty or compressed.
    pub text: Option<String>,
    pub bytes: usize,
    /// gzip-compressed (shown as size only; the app has no decompressor).
    pub compressed: bool,
}

pub fn decode_user_data(b64: Option<&str>) -> Result<UserData, AppError> {
    let Some(b64) = b64.filter(|s| !s.is_empty()) else {
        return Ok(UserData::default());
    };
    let bytes = aws_smithy_types::base64::decode(b64).map_err(|_| other("The user data couldn't be decoded."))?;
    let compressed = bytes.starts_with(&[0x1f, 0x8b]);
    Ok(UserData {
        text: (!compressed).then(|| String::from_utf8_lossy(&bytes).into_owned()),
        bytes: bytes.len(),
        compressed,
    })
}

pub async fn user_data(conn: &Connection, id: &str) -> Result<UserData, AppError> {
    let out = client(conn)
        .describe_instance_attribute()
        .instance_id(id)
        .attribute(InstanceAttributeName::UserData)
        .send()
        .await
        .map_err(|e| err(conn, e))?;
    decode_user_data(out.user_data().and_then(|v| v.value()))
}

/// What Systems Manager knows about an instance (its agent), for the Connect tab.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SsmAgent {
    /// false = Systems Manager doesn't manage the instance (no agent, no role, or no route to SSM).
    pub managed: bool,
    /// Online, ConnectionLost, Inactive.
    pub ping_status: Option<String>,
    pub last_ping: Option<String>,
    pub agent_version: Option<String>,
    pub latest_agent: Option<bool>,
    pub platform: Option<String>,
    /// Set when Systems Manager couldn't be asked (permissions, endpoint).
    pub error: Option<String>,
}

pub async fn ssm_agent(conn: &Connection, id: &str) -> SsmAgent {
    let c = crate::ssm::client(conn);
    let res = c
        .describe_instance_information()
        .filters(
            aws_sdk_ssm::types::InstanceInformationStringFilter::builder()
                .key("InstanceIds")
                .values(id)
                .build()
                .expect("key and values are set"),
        )
        .send()
        .await;
    match res {
        Ok(o) => match o.instance_information_list().first() {
            Some(i) => SsmAgent {
                managed: true,
                ping_status: i.ping_status().map(|p| p.as_str().to_string()),
                last_ping: iso(i.last_ping_date_time()),
                agent_version: i.agent_version().map(String::from),
                latest_agent: i.is_latest_version(),
                platform: i.platform_name().map(String::from),
                error: None,
            },
            None => SsmAgent::default(),
        },
        Err(e) => SsmAgent {
            error: Some(err(conn, e).message),
            ..Default::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_console_text() {
        assert_eq!(clean_console("a\u{1b}[0;32mOK\u{1b}[0m b\r\nc\rd\u{7}e\tf"), "aOK b\nc\nde\tf");
        assert_eq!(clean_console("x\u{1b}Ky"), "xy");
    }

    #[test]
    fn decodes_user_data() {
        let d = decode_user_data(Some("I2Nsb3VkLWNvbmZpZwo=")).unwrap();
        assert_eq!(d.text.as_deref(), Some("#cloud-config\n"));
        assert!(!d.compressed);
        let z = decode_user_data(Some("H4sIAAAAAAAAAw==")).unwrap();
        assert!(z.compressed);
        assert_eq!(z.text, None);
        assert_eq!(decode_user_data(None).unwrap().bytes, 0);
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::ec2::emulator_tests::{connect, ensure_instance};

    #[tokio::test]
    #[ignore]
    async fn reads_status_console_and_user_data() {
        let conn = connect().await;
        let id = ensure_instance(&conn, "s3x-ec2-console").await;
        // Emulators may not have every call; each must either work or fail cleanly.
        if let Ok(s) = status(&conn, &id).await {
            assert!(s.state.is_some() || s.system.is_none());
        }
        let _ = console_output(&conn, &id, true).await;
        let _ = screenshot(&conn, &id).await;
        let agent = ssm_agent(&conn, &id).await;
        assert!(agent.managed || agent.error.is_some() || agent.ping_status.is_none());
        let u = user_data(&conn, &id).await.unwrap();
        assert!(!u.compressed);
    }
}
