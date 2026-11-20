//! Policy validation with IAM Access Analyzer (ValidatePolicy): grammar
//! errors, security warnings, warnings and suggestions with their location
//! in the document. Regional (the selected region); writes nothing.

use crate::error::{AppError, ErrorKind};
use crate::s3::Connection;
use aws_sdk_accessanalyzer::types::{
    Location, PathElement, PolicyType, ValidatePolicyResourceType,
};
use aws_sdk_accessanalyzer::Client;
use serde::{Deserialize, Serialize};

/// Largest document sent (identity policies are capped well below this).
const MAX_DOCUMENT: usize = 100_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateRequest {
    pub document: String,
    /// "identity", "trust", "resource", "scp" or "rcp".
    pub kind: String,
    /// For "resource": the AWS resource type (AWS::S3::Bucket…), if any.
    pub resource_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FindingLocation {
    /// Where in the JSON, as text: Statement[0].Action[1].
    pub path: String,
    /// 0-based character offsets: start inclusive, end exclusive.
    pub start: i32,
    pub end: i32,
    pub line: i32,
    pub column: i32,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// ERROR, SECURITY_WARNING, WARNING or SUGGESTION.
    pub severity: String,
    pub issue_code: String,
    pub details: String,
    pub learn_more: String,
    pub locations: Vec<FindingLocation>,
}

pub const RESOURCE_TYPES: [&str; 8] = [
    "AWS::S3::Bucket",
    "AWS::S3::AccessPoint",
    "AWS::S3::MultiRegionAccessPoint",
    "AWS::S3ObjectLambda::AccessPoint",
    "AWS::S3Express::DirectoryBucket",
    "AWS::S3Express::AccessPoint",
    "AWS::DynamoDB::Table",
    "AWS::DynamoDB::Stream",
];

pub fn path_text(path: &[PathElement]) -> String {
    let mut out = String::new();
    for p in path {
        match p {
            PathElement::Index(i) => out.push_str(&format!("[{i}]")),
            PathElement::Key(k) => {
                if !out.is_empty() {
                    out.push('.');
                }
                out.push_str(k);
            }
            PathElement::Value(v) => out.push_str(&format!(" = {v}")),
            PathElement::Substring(s) => out.push_str(&format!(
                " (characters {}–{})",
                s.start(),
                s.start() + s.length()
            )),
            _ => {}
        }
    }
    out
}

fn location(l: &Location) -> Option<FindingLocation> {
    let s = l.span()?;
    let (start, end) = (s.start()?, s.end()?);
    Some(FindingLocation {
        path: path_text(l.path()),
        start: start.offset(),
        end: end.offset(),
        line: start.line(),
        column: start.column(),
    })
}

/// Policy type and (for resource and trust policies) resource type.
pub fn types(
    kind: &str,
    resource_type: Option<&str>,
) -> Result<(PolicyType, Option<ValidatePolicyResourceType>), String> {
    match kind {
        "identity" => Ok((PolicyType::IdentityPolicy, None)),
        "trust" => Ok((
            PolicyType::ResourcePolicy,
            Some(ValidatePolicyResourceType::RoleTrust),
        )),
        "resource" => match resource_type.filter(|t| !t.is_empty()) {
            None => Ok((PolicyType::ResourcePolicy, None)),
            Some(t) if RESOURCE_TYPES.contains(&t) => Ok((
                PolicyType::ResourcePolicy,
                Some(ValidatePolicyResourceType::from(t)),
            )),
            Some(t) => Err(format!("Unknown resource type {t}.")),
        },
        "scp" => Ok((PolicyType::ServiceControlPolicy, None)),
        "rcp" => Ok((PolicyType::ResourceControlPolicy, None)),
        _ => Err(format!("Unknown policy kind {kind}.")),
    }
}

pub async fn validate(conn: &Connection, r: &ValidateRequest) -> Result<Vec<Finding>, AppError> {
    let bad = |m: String| AppError::new(ErrorKind::Other, m);
    if r.document.trim().is_empty() {
        return Err(bad("The policy is empty.".into()));
    }
    if r.document.len() > MAX_DOCUMENT {
        return Err(bad("The policy is too large to validate.".into()));
    }
    let (policy_type, resource_type) = types(&r.kind, r.resource_type.as_deref()).map_err(bad)?;
    let c = Client::new(&conn.service_config());
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let o = c
            .validate_policy()
            .policy_document(&r.document)
            .policy_type(policy_type.clone())
            .set_validate_policy_resource_type(resource_type.clone())
            .set_next_token(token.clone())
            .send()
            .await
            .map_err(|e| {
                AppError::from_sdk(e, &conn.info.profile, conn.info.endpoint_url.as_deref())
            })?;
        out.extend(o.findings().iter().map(|f| Finding {
            severity: f.finding_type().as_str().to_string(),
            issue_code: f.issue_code().to_string(),
            details: f.finding_details().to_string(),
            learn_more: f.learn_more_link().to_string(),
            locations: f.locations().iter().filter_map(location).collect(),
        }));
        match o
            .next_token()
            .filter(|t| !t.is_empty() && Some(*t) != token.as_deref())
        {
            Some(t) => token = Some(t.to_string()),
            None => break,
        }
    }
    let rank = |s: &str| match s {
        "ERROR" => 0,
        "SECURITY_WARNING" => 1,
        "WARNING" => 2,
        _ => 3,
    };
    out.sort_by_key(|f| rank(&f.severity));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_accessanalyzer::types::Substring;

    #[test]
    fn describes_paths() {
        let p = [
            PathElement::Key("Statement".into()),
            PathElement::Index(0),
            PathElement::Key("Action".into()),
            PathElement::Index(1),
        ];
        assert_eq!(path_text(&p), "Statement[0].Action[1]");
        let s = Substring::builder().start(2).length(3).build().unwrap();
        assert_eq!(
            path_text(&[
                PathElement::Key("Resource".into()),
                PathElement::Substring(s)
            ]),
            "Resource (characters 2–5)"
        );
    }

    #[test]
    fn maps_policy_kinds() {
        assert_eq!(
            types("identity", None).unwrap().0,
            PolicyType::IdentityPolicy
        );
        assert_eq!(
            types("trust", None).unwrap().1,
            Some(ValidatePolicyResourceType::RoleTrust)
        );
        assert_eq!(
            types("resource", Some("AWS::S3::Bucket")).unwrap().1,
            Some(ValidatePolicyResourceType::S3Bucket)
        );
        assert!(types("resource", Some("AWS::Nope")).is_err());
        assert!(types("bogus", None).is_err());
    }
}

#[cfg(test)]
mod emulator_tests {
    use super::*;

    /// MiniStack has no ValidatePolicy: the test accepts a refusal, and
    /// checks the request is built and sent.
    #[tokio::test]
    #[ignore]
    async fn validates_or_is_refused() {
        let conn = crate::sqs::emulator_tests::connect().await;
        let r = ValidateRequest {
            document: r#"{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObjekt","Resource":"*"}]}"#.into(),
            kind: "identity".into(),
            resource_type: None,
        };
        match validate(&conn, &r).await {
            Ok(f) => assert!(f.iter().all(|x| !x.severity.is_empty())),
            Err(e) => assert!(!e.message.is_empty()),
        }
        let empty = ValidateRequest {
            document: " ".into(),
            ..r
        };
        assert!(validate(&conn, &empty).await.is_err());
    }
}
