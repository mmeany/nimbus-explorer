// IAM help topics (view only; global).
export const iamTopics = {
  "iam.overview": {
    title: "IAM",
    body: `Identity and Access Management for the account behind the profile: **users**, **user groups** and **roles**, each with its policies, the account's **managed policies**, and the **Account** overview (quotas, password policy, credential report, unused credentials). IAM is global, so the **Region** list doesn't apply.

This view is read only: nothing here changes IAM, even with the lock off. Use the console, the CLI or your infrastructure code for changes.

Open a list from here or the tree. The tree lists the first 200 of each.`,
  },
  "iam.users": {
    title: "IAM users",
    body: `Users have long-term credentials: a console password, access keys, or both.

- **Access keys**, **Key last used** and **MFA** are loaded for the visible page only.
- **Password last used** is empty when the user has no password or never signed in.
- **Filter**: the start of a name (ignoring case), or a path starting with \`/\` (for example \`/admins/\`). Press Enter; filters are remembered.

Open a user (Enter or double-click) for its groups, permissions, credentials and tags.`,
  },
  "iam.groups": {
    title: "IAM user groups",
    body: `A user group gives its policies to every user in it. Groups can't be nested and can't be named as a principal in a policy.

**Filter** by name or path (starting with \`/\`). Open a group for its users and permissions.`,
  },
  "iam.roles": {
    title: "IAM roles",
    body: `A role has no credentials of its own: services, other accounts, and federated or single sign-on users **assume** it for temporary credentials. Its **trust policy** says who may.

- **Last used** is loaded for the visible page only; AWS tracks the last 400 days.
- Service-linked roles (path \`/aws-service-role/\`) are shown faded: an AWS service created them and manages their permissions.
- Roles whose names start with \`AWSReservedSSO_\` come from IAM Identity Center permission sets.

**Filter** by name or path (starting with \`/\`).`,
  },
  "iam.user": {
    title: "IAM user",
    body: `One user: name, ID, path and ARN, console access, access keys, MFA, user groups, permissions boundary and tags.

- **Permissions**: managed policies attached to the user and inline policies (expand one for its document). The user also gets its groups' permissions; the groups are linked.
- **Credentials**: the console password (whether there is one and when it was last used; never the password), access keys (ID, status, age, last used and where) and MFA devices.

Secret access keys and passwords can't be read from AWS at all.`,
  },
  "iam.group": {
    title: "IAM user group",
    body: `One user group: its users (open one from the list) and the policies they get from it.`,
  },
  "iam.role": {
    title: "IAM role",
    body: `Role ARNs shown elsewhere in the app (Lambda and Step Functions execution roles, ECS task and execution roles, RDS monitoring and feature roles) open this view when the role is in the same account as the resource.

One role: description, maximum session duration (how long credentials from assuming it last, at most), when it was last used and in which region, instance profiles (how EC2 instances use it), permissions boundary and tags.`,
  },
  "iam.trust": {
    title: "Trust",
    body: `Who may assume the role, read from its trust policy: one row per principal.

- **Service** principals are AWS services (\`lambda.amazonaws.com\`, \`states.amazonaws.com\`…).
- **AWS** principals are accounts, users or roles. An account (\`…:root\`) means any principal in that account that its own policies allow.
- **Federated** principals are identity providers (SAML, OIDC, Cognito).
- **Conditions** narrow a statement (external ID, MFA, source account…); they're in the policy below.
- A principal of \`*\` without conditions lets anyone assume the role.`,
  },
  "iam.permissions": {
    title: "Permissions",
    body: `The policies of this user, group or role.

- **Managed policies** are standalone and can be attached to many principals: *AWS managed* (maintained by AWS) or *customer managed* (yours). Click a name to open the policy, an ARN to copy it.
- **Inline policies** belong to this principal only; expand one for its document.
- A **permissions boundary** caps what the policies can allow: the result is what both allow. Click it to open the policy.

What's actually allowed also depends on resource policies, service control policies and session policies.`,
  },
  "iam.credentials": {
    title: "Credentials",
    body: `How the user signs in and calls AWS.

- **Console password**: whether one is set, when, and when it was last used. Users without one can't sign in to the console.
- **Access keys**: long-term keys for the CLI and SDKs. Age and last use help you find keys to rotate or remove; AWS recommends rotating keys regularly and preferring temporary credentials (roles, IAM Identity Center).
- **MFA devices**: a console user without MFA is marked in the header.

AWS never returns passwords or secret access keys after they're created.`,
  },
  "iam.policies": {
    title: "IAM policies",
    body: `Managed policies: standalone policies you attach to users, user groups and roles.

- **Customer managed** / **AWS managed** / **All**: which policies to list. AWS managed policies are maintained by AWS (there are over a thousand); the choice is remembered.
- **Attached only**: policies attached somewhere in this account, or used as a permissions boundary. Unattached ones are shown faded.
- **Attachments** counts users, user groups and roles in this account.
- **Filter**: the start of a name (ignoring case), or a path starting with \`/\` (for example \`/service-role/\`).

Open a policy for its document, versions and where it's attached.`,
  },
  "iam.policy": {
    title: "IAM policy",
    body: `One managed policy.

- **Document**: the default version, the one in effect, as a tree or text.
- **Details**: name, ID, ARN, path, description, dates, how many principals use it, and whether it can be attached.
- **Tags** (customer managed only).

Inline policies, which belong to one user, group or role, are shown in the same viewer on that principal's Permissions tab.`,
  },
  "iam.policy.versions": {
    title: "Policy versions",
    body: `A managed policy keeps up to five versions; only the **default** is in effect. Older versions are what a rollback would restore.

- **Show** picks the version whose document is shown.
- **Compared with** shows the differences from another version (lines removed from it in red, added in green).

Documents are loaded when you first show them.`,
  },
  "iam.account": {
    title: "IAM account",
    body: `The account behind the profile.

- **Account ID** is read from the ARNs of its users, roles or policies; **alias** is the friendly name in the sign-in URL.
- **Root user**: whether it has MFA (it should) and access keys (it shouldn't).
- **Usage and quotas**: how much of each IAM quota is used; 80% or more is highlighted. **Limits** are per-principal and size limits.`,
  },
  "iam.account.password": {
    title: "Password policy",
    body: `The rules for IAM users' console passwords: length, character types, expiry and reuse. Without a policy, AWS's default applies. The root user isn't covered.`,
  },
  "iam.credentialReport": {
    title: "Credential report",
    body: `Every user with its console password, MFA and access keys, from AWS's credential report.

- AWS keeps one report and builds a new one at most every **four hours**; opening this tab uses the latest (or generates one if there is none). **Generate new report** asks for a fresh one, which can take a minute.
- Generating a report changes no settings, so it works in read-only mode.
- **Export CSV…** saves the report exactly as AWS sends it.
- MFA is highlighted for users who can sign in to the console without it.`,
  },
  "iam.unused": {
    title: "Unused credentials",
    body: `Credentials worth a look, from the credential report:

- console passwords and active access keys **never used**, or **not used** for more than the first number of days;
- active access keys **not rotated** for more than the second number of days.

Both numbers are remembered. Inactive keys are left out. Click a user to open it; disabling or deleting credentials is done in the console or the CLI.`,
  },
  "iam.simulate": {
    title: "Policy simulator",
    body: `Asks AWS (SimulatePrincipalPolicy) whether this user, user group or role may perform actions. Nothing is changed.

- **Actions**: exact names such as \`s3:GetObject\`, separated by commas or new lines (up to 100). The simulator doesn't accept wildcards.
- **Resource ARNs**: optional; empty means any resource.
- **Context keys**: values for conditions (\`aws:SourceIp\`, \`aws:MultiFactorAuthPresent\`…). Keys the policies use but you didn't give are listed in the results, with a button to add them.
- **Extra identity policy**: tests a policy as if it were attached.

Each result is **Allowed**, **Denied (explicit)** (a Deny matched) or **Denied (implicit)** (nothing allows it). Click a row for the matching statements, highlighted in their policies, and the permissions boundary and SCP effects. Resource-based policies aren't included. A user's simulation includes its groups' policies.

Inputs and results are kept while the app runs.`,
  },
  "iam.validate": {
    title: "Policy validation",
    body: `**Validate** under a policy document checks it with IAM Access Analyzer (ValidatePolicy, in the selected region). Nothing is changed.

- **Errors**: the policy is invalid or won't work as written (a misspelt action, bad JSON grammar).
- **Security warnings**: it grants more than intended (for example \`iam:PassRole\` on \`*\`).
- **Warnings** and **suggestions**: likely mistakes and simpler ways to write it.

Click a finding to see where it is in the document; every finding is marked, coloured by severity. The link under a finding is AWS's explanation (copy it to open it in a browser). Trust policies are checked as role trust policies.

Emulators usually don't support Access Analyzer.`,
  },
  "iam.validateDialog": {
    title: "Validate policy",
    body: `Paste policy JSON and check it with IAM Access Analyzer.

- **Identity policy**: for users, groups and roles.
- **Role trust policy**: who may assume a role.
- **Resource policy**: attached to a resource; pick a resource type (S3 bucket, DynamoDB table…) for extra checks.
- **SCP** / **RCP**: AWS Organizations service and resource control policies.

Findings are grouped by severity and marked in the document. Nothing is saved.`,
  },
  "iam.policy.attached": {
    title: "Attached to",
    body: `The users, user groups and roles in this account that have the policy attached, and those using it as their **permissions boundary** (users and roles only). Click a name to open it.`,
  },
};
