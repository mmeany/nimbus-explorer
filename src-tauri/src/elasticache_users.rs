//! ElastiCache RBAC (view only): users, user groups, and which caches use
//! each group. Passwords are never returned by AWS; only their count is.

use crate::elasticache::{client, err};
use crate::error::AppError;
use crate::s3::Connection;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    /// The name clients log in with (several users may share one, in different groups).
    pub name: Option<String>,
    pub status: Option<String>,
    pub engine: Option<String>,
    pub minimum_engine_version: Option<String>,
    /// Redis / Valkey ACL rules, e.g. "on ~app:* +@read".
    pub access_string: Option<String>,
    pub group_ids: Vec<String>,
    /// password, no-password or iam.
    pub auth_type: Option<String>,
    pub password_count: Option<i32>,
    pub arn: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserGroup {
    pub id: String,
    pub status: Option<String>,
    pub engine: Option<String>,
    pub user_ids: Vec<String>,
    pub minimum_engine_version: Option<String>,
    pub adding: Vec<String>,
    pub removing: Vec<String>,
    /// Caches that use the group.
    pub replication_groups: Vec<String>,
    pub serverless_caches: Vec<String>,
    pub arn: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Rbac {
    /// By id.
    pub users: Vec<User>,
    pub groups: Vec<UserGroup>,
}

pub async fn list(conn: &Connection) -> Result<Rbac, AppError> {
    let c = client(conn);
    let mut out = Rbac::default();
    let mut marker: Option<String> = None;
    loop {
        let page = c
            .describe_users()
            .max_records(100)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.users.extend(page.users().iter().map(|u| {
            User {
                id: u.user_id().unwrap_or_default().to_string(),
                name: u.user_name().map(String::from),
                status: u.status().map(String::from),
                engine: u.engine().map(String::from),
                minimum_engine_version: u.minimum_engine_version().map(String::from),
                access_string: u.access_string().map(String::from),
                group_ids: u.user_group_ids().to_vec(),
                auth_type: u
                    .authentication()
                    .and_then(|a| a.r#type())
                    .map(|t| t.as_str().to_string()),
                password_count: u.authentication().and_then(|a| a.password_count()),
                arn: u.arn().map(String::from),
            }
        }));
        match page.marker() {
            Some(m) if !m.is_empty() && Some(m) != marker.as_deref() => {
                marker = Some(m.to_string())
            }
            _ => break,
        }
    }
    let mut marker: Option<String> = None;
    loop {
        let page = c
            .describe_user_groups()
            .max_records(100)
            .set_marker(marker.clone())
            .send()
            .await
            .map_err(|e| err(conn, e))?;
        out.groups.extend(page.user_groups().iter().map(|g| {
            UserGroup {
                id: g.user_group_id().unwrap_or_default().to_string(),
                status: g.status().map(String::from),
                engine: g.engine().map(String::from),
                user_ids: g.user_ids().to_vec(),
                minimum_engine_version: g.minimum_engine_version().map(String::from),
                adding: g
                    .pending_changes()
                    .map(|p| p.user_ids_to_add().to_vec())
                    .unwrap_or_default(),
                removing: g
                    .pending_changes()
                    .map(|p| p.user_ids_to_remove().to_vec())
                    .unwrap_or_default(),
                replication_groups: g.replication_groups().to_vec(),
                serverless_caches: g.serverless_caches().to_vec(),
                arn: g.arn().map(String::from),
            }
        }));
        match page.marker() {
            Some(m) if !m.is_empty() && Some(m) != marker.as_deref() => {
                marker = Some(m.to_string())
            }
            _ => break,
        }
    }
    fill_memberships(&mut out);
    out.users.sort_by(|a, b| a.id.cmp(&b.id));
    out.groups.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// A user's groups come from the groups' member lists too (some endpoints
/// leave the user's own list empty).
pub fn fill_memberships(r: &mut Rbac) {
    for u in &mut r.users {
        for g in &r.groups {
            if g.user_ids.contains(&u.id) && !u.group_ids.contains(&g.id) {
                u.group_ids.push(g.id.clone());
            }
        }
        u.group_ids.sort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn users_learn_their_groups_from_group_members() {
        let mut r = Rbac {
            users: vec![
                User {
                    id: "default".into(),
                    ..Default::default()
                },
                User {
                    id: "app".into(),
                    group_ids: vec!["g2".into()],
                    ..Default::default()
                },
            ],
            groups: vec![
                UserGroup {
                    id: "g1".into(),
                    user_ids: vec!["default".into(), "app".into()],
                    ..Default::default()
                },
                UserGroup {
                    id: "g2".into(),
                    user_ids: vec!["app".into()],
                    ..Default::default()
                },
            ],
        };
        fill_memberships(&mut r);
        assert_eq!(r.users[0].group_ids, ["g1"]);
        assert_eq!(r.users[1].group_ids, ["g1", "g2"]);
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;
    use crate::elasticache::emulator_tests::connect;

    #[tokio::test]
    #[ignore]
    async fn lists_users_and_groups() {
        let conn = connect().await;
        let c = client(&conn);
        if c.describe_users()
            .user_id("s3x-ec-user")
            .send()
            .await
            .map(|o| o.users().is_empty())
            .unwrap_or(true)
        {
            c.create_user()
                .user_id("s3x-ec-user")
                .user_name("app")
                .engine("valkey")
                .access_string("on ~app:* +@read")
                .passwords("Example-Passw0rd-123456")
                .send()
                .await
                .unwrap();
        }
        if c.describe_user_groups()
            .user_group_id("s3x-ec-ug")
            .send()
            .await
            .map(|o| o.user_groups().is_empty())
            .unwrap_or(true)
        {
            c.create_user_group()
                .user_group_id("s3x-ec-ug")
                .engine("valkey")
                .user_ids("default")
                .user_ids("s3x-ec-user")
                .send()
                .await
                .unwrap();
        }
        let r = list(&conn).await.unwrap();
        let u = r
            .users
            .iter()
            .find(|u| u.id == "s3x-ec-user")
            .expect("user listed");
        // AWS (and MiniStack) store a normalised form, e.g. "on ~app:* -@all +@read".
        let acl = u.access_string.clone().unwrap_or_default();
        assert!(acl.contains("~app:*") && acl.contains("+@read"), "{acl}");
        assert!(u.group_ids.contains(&"s3x-ec-ug".to_string()));
        let g = r
            .groups
            .iter()
            .find(|g| g.id == "s3x-ec-ug")
            .expect("group listed");
        assert!(g.user_ids.contains(&"s3x-ec-user".to_string()));
    }
}
