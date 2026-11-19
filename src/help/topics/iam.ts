// IAM help topics (view only; global).
export const iamTopics = {
  "iam.overview": {
    title: "IAM",
    body: `Identity and Access Management for the account behind the profile: **users**, **user groups** and **roles**, each with its policies. IAM is global, so the **Region** list doesn't apply.

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
    body: `One role: description, maximum session duration (how long credentials from assuming it last, at most), when it was last used and in which region, instance profiles (how EC2 instances use it), permissions boundary and tags.`,
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

- **Managed policies** are standalone and can be attached to many principals: *AWS managed* (maintained by AWS) or *customer managed* (yours). Click an ARN to copy it.
- **Inline policies** belong to this principal only; expand one for its document.
- A **permissions boundary** caps what the policies can allow: the result is what both allow.

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
};
