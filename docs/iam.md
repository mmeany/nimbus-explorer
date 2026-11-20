# IAM

AWS Identity and Access Management for the account behind your profile:
users, user groups, roles, managed policies and an account overview, plus a
policy simulator and policy validation. Open **IAM** in the tree under your
profile (it's the last service).

IAM is **global**: the toolbar's **Region** list doesn't apply, and history
entries and bookmarks for IAM store no region. Policy validation uses IAM
Access Analyzer, which is regional, so it runs in the selected region.

**View only.** Nothing in this view changes IAM, even with the read-only
lock off: there's no create, attach, edit or delete. Use the AWS console,
the CLI or your infrastructure code for changes. Generating a credential
report changes no configuration, so it works in read-only mode.

What this view doesn't do (agreed scope): identity providers, instance
profiles as a view of their own (they're shown on roles), server
certificates, service last accessed data, and any change to IAM.

## Overview

The IAM node opens an overview with **Users**, **User groups**, **Roles**,
**Policies** (customer managed + AWS managed counts) and **Account**. In the
tree, each list expands to its first 200 entries.

Every list loads in full (IAM's list calls return what the list needs) and
is shown 100, 500 or 1,000 at a time with a pager (Ctrl+PgUp / Ctrl+PgDn).
The **Filter** box takes the start of a name (ignoring case) or a path
starting with `/` (for example `/ci/` or `/service-role/`); press **Enter**.
Filters are remembered per profile and list (the last 10).

Right-click an entry to **Open** it, **Copy name**, **Copy ARN** or **Add
bookmark…**.

## Users

Columns: **User, Path, Access keys** (active of total), **Key last used**,
**Password last used**, **MFA** and **Created**. Access keys, key last use
and MFA cost calls per user, so they're loaded for the visible page only.

Open a user for:

- **Details**: name, ID, path, ARN, created, console access, password last
  used, access keys, MFA, groups and permissions boundary.
- **Permissions**: managed policies attached to the user (click a name to
  open the policy, an ARN to copy it), inline policies (expand one for its
  document), the permissions boundary (opens the policy), and links to the
  groups whose permissions the user also gets.
- **User groups**: each opens the group.
- **Credentials**: the console password (whether there is one, when it was
  set, whether it must be changed, when it was last used; never the
  password), access keys (ID, status, created, age, last used with service
  and region; never the secret) and MFA devices. A console user without MFA
  gets a **No MFA** badge in the header.
- **Tags**, and **Simulate** (see below).

## User groups

Columns: **User group, Path, Created, ARN**. A group shows its **Users**
(each opens the user), **Permissions** (attached and inline policies),
**Details** and **Simulate**.

## Roles

Columns: **Role, Path, Last used** (date and region; loaded for the visible
page), **Max session**, **Created** and **Description**. Service-linked
roles (path `/aws-service-role/`) are shown faded.

A role shows:

- **Trust**: who may assume it, one row per principal in plain words
  (a service, an account, "anyone", a federated provider), with its actions
  and whether conditions apply, then the trust policy itself.
- **Permissions**: attached and inline policies and the permissions boundary.
- **Details**: description, maximum session duration, last used, instance
  profiles, permissions boundary, service-linked.
- **Tags**, and **Simulate**.

## Policies

Managed policies, with a **Customer managed / AWS managed / All** toggle and
**Attached only** (attached somewhere in this account, or used as a
permissions boundary); both choices are remembered. Columns: **Policy, Type,
Attachments** (with boundary uses), **Path, Version, Last updated,
Created**. Unattached policies are shown faded.

A policy shows:

- **Document**: the default version (the one in effect), as a tree or text.
- **Versions**: every version (up to five). **Show** picks one;
  **compared with** shows the differences from another. Both sides are
  pretty-printed first, so policies stored on one line compare line by line.
- **Attached to**: the users, user groups and roles with the policy
  attached, and those using it as their permissions boundary; each opens.
- **Details**, and **Tags** for customer managed policies.

Inline policies, which belong to one user, group or role, appear on that
principal's Permissions tab in the same document viewer.

## Account

The **Account** node (and the overview's last row) has four tabs:

- **Summary**: the account ID (read from the ARNs of its users, roles or
  policies, as IAM has no call that returns it), the account alias, whether
  the root user has MFA (it should) and access keys (it shouldn't), usage
  against IAM's quotas (80% or more is highlighted) and the other limits.
- **Password policy**: the rules for IAM users' console passwords, or AWS's
  default when none is set.
- **Credential report**: every user with password, MFA and both access
  keys. Opening the tab uses AWS's latest report or generates one if there
  is none; AWS builds a new one at most every four hours. **Generate new
  report** asks for a fresh one (it can take a minute). **Export CSV…**
  saves the report as AWS sends it (recorded in history).
- **Unused credentials**: from the report, console passwords and active
  access keys never used or not used for more than N days, and active keys
  not rotated for more than M days. Both numbers default to 90 and are
  remembered. Each user opens. Inactive keys are left out.

## Policy simulator

The **Simulate** tab on users, groups and roles asks AWS
(SimulatePrincipalPolicy) whether the principal may perform actions.
Nothing is changed.

- **Actions**: exact names such as `s3:GetObject`, separated by commas or
  new lines, up to 100. The API doesn't accept wildcards, so `s3:Get*` is
  refused with a message.
- **Resource ARNs**: optional, one per line, up to 100; empty means any
  resource.
- **Context keys**: values for the policies' conditions (`aws:SourceIp`,
  `aws:MultiFactorAuthPresent`…), with a type. Keys the policies use but you
  didn't give are listed in the results with a button to add them.
- **Extra identity policy**: test a policy as if it were attached.

Each result row shows **Allowed**, **Denied (explicit)** (a Deny matched)
or **Denied (implicit)** (nothing allows it), the number of matching
statements, the permissions boundary and SCP effects, and missing context
keys. Click a row for an explanation and the matching statements
highlighted inside the policies they come from (the principal's own, its
groups', a managed policy or the extra one). A user's simulation includes
its groups' policies. Resource-based policies aren't included.

Inputs and results are kept while the app runs, so switching tabs doesn't
lose them.

## Policy validation

Every policy document IAM shows (managed policies and their versions,
inline policies, trust policies) has a **Validate** button, and the IAM
command bar has **Validate policy…** for pasted JSON. Validation uses IAM
Access Analyzer (ValidatePolicy) in the selected region and saves nothing.

The dialog checks a policy as an **identity policy**, **role trust
policy**, **resource policy** (optionally for a resource type, such as an
S3 bucket or DynamoDB table, for extra checks), **service control policy**
or **resource control policy**. Trust policies shown on roles are checked as
role trust policies.

Findings are grouped as **errors**, **security warnings**, **warnings** and
**suggestions**; each is underlined in the document in its severity's
colour. Click a finding to highlight it and scroll to it. AWS's explanation
link is shown as text to copy.

## Links from other services

Role ARNs shown elsewhere open the IAM role view when the role is in the
same account as the resource showing it: Lambda execution roles, ECS task
and execution roles (task definitions), Step Functions execution roles
(Configuration tab), and RDS Enhanced Monitoring and feature roles. Roles in
other accounts stay text.

The Step Functions editor's **Execution role** has **Choose…**: roles whose
trust policy allows Step Functions (`states.amazonaws.com`) first, the rest
behind **Show all roles**; service-linked roles are left out. You can still
type an ARN, and if roles can't be listed (no IAM permission) the field
works as before.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Enter / double-click | Open a user, group, role or policy |
| Ctrl+PgUp / Ctrl+PgDn | Previous / next page |
| F5 | Refresh |

## Permissions

The profile needs these actions (all reads; IAM resources are
account-wide, so most can't be narrowed much beyond `Resource: "*"`; the
AWS managed policy `IAMReadOnlyAccess` covers the IAM ones):

- Lists: `iam:ListUsers`, `iam:ListGroups`, `iam:ListRoles`,
  `iam:ListPolicies`
- Users: `iam:GetUser`, `iam:ListGroupsForUser`,
  `iam:ListAttachedUserPolicies`, `iam:ListUserPolicies`,
  `iam:GetUserPolicy`, `iam:GetLoginProfile`, `iam:ListAccessKeys`,
  `iam:GetAccessKeyLastUsed`, `iam:ListMFADevices`
- Groups: `iam:GetGroup`, `iam:ListAttachedGroupPolicies`,
  `iam:ListGroupPolicies`, `iam:GetGroupPolicy`
- Roles: `iam:GetRole`, `iam:ListAttachedRolePolicies`,
  `iam:ListRolePolicies`, `iam:GetRolePolicy`,
  `iam:ListInstanceProfilesForRole`
- Policies: `iam:GetPolicy`, `iam:ListPolicyVersions`,
  `iam:GetPolicyVersion`, `iam:ListEntitiesForPolicy`
- Account: `iam:GetAccountSummary`, `iam:ListAccountAliases`,
  `iam:GetAccountPasswordPolicy`, `iam:GenerateCredentialReport`,
  `iam:GetCredentialReport`
- Simulator: `iam:SimulatePrincipalPolicy`
- Validation: `access-analyzer:ValidatePolicy`

## Emulators

Works with [MiniStack](https://github.com/ministackorg/ministack) for
browsing, policies, the account overview and the credential report (the
app's emulator tests use it). MiniStack answers the policy simulator
without evaluating anything (every result is an implicit deny) and doesn't
implement Access Analyzer, so validation says the endpoint couldn't
validate the policy. Its account summary counts may not match what's
there.
