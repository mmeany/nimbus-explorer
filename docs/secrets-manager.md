# Secrets Manager

AWS Secrets Manager secrets, browsed like folders. Open **Secrets Manager** in
the tree under your profile. It uses the region chosen in the toolbar's
**Region** list (remembered per profile).

## Browsing

- Names containing `/` are shown as folders: `prod/app/db` appears as `db`
  inside `prod › app`.
- The list shows **Name, Description, Last changed, Last retrieved, Rotation**
  and **Scheduled deletion**. Secrets scheduled for deletion are shown faded.
- Type the start of a name in the **Filter** box (e.g. `prod/`) and press
  **Enter** for a flat list of every match with a **Folder** column; the tree
  shows only folders with matches. Filters are remembered per profile and
  region (last 10).
- Big folders and filter results are shown a page at a time (folders first):
  choose 100, 500 or 1,000 per page with the pager under the list
  (remembered) and step with First / Previous / Next (Ctrl+PgUp / Ctrl+PgDn).

## Viewing a value

Open a secret (Enter / double-click) to see its metadata, tags and value. The
value stays hidden until you click **Reveal** or **Copy**; it's decrypted then
and forgotten when you hide it or close the window. Nothing is cached or
logged.

- Flat JSON secrets (e.g. `{"username": "…", "password": "…"}`) show as a
  **key / value** table with Copy per key, or as JSON.
- Other JSON shows as a tree; plain text as text; binary secrets as base64.
- Right-click › **Copy value** copies without showing it.

## Creating and editing

**New** (Ctrl+Shift+N) asks for:

- **Name**: letters, digits and `/ _ + = . @ -`. Avoid ending a name with a
  hyphen and six characters: that looks like the random suffix in secret ARNs.
- **Value**, entered one of three ways:
  - **Key / value** rows, each with a type (text, number, true/false, null),
    saved as a JSON object;
  - **Plaintext** (JSON is checked as you type);
  - **Binary** as base64.
  Values are masked until you click **Show values**.
- **Description**, **Encryption key** (blank = `aws/secretsmanager`) and
  **Tags**.

**Edit** (Ctrl+E) loads the current value. Saving a changed value creates a
new version labelled **AWSCURRENT**; the previous one becomes **AWSPREVIOUS**.
Description and key changes don't create a version.

## Deleting and restoring

**Delete** (Del) offers:

- **Schedule deletion** with a 7–30 day recovery window. The secret can't be
  read meanwhile and can be **Restored** (command bar or right-click) until
  the date.
- **Delete immediately**, with no recovery, after typing the secret's name.

## Versions and labels

**Versions** lists every version with its staging labels, creation time and
when it was last retrieved. Versions without labels are deprecated and may be
removed by Secrets Manager.

- Click a version to **Reveal** its value.
- **Compare with current**, or Ctrl+click two versions and **Compare**: both
  are decrypted for the diff (JSON is pretty-printed first).
- **Make current…** moves AWSCURRENT to the selected version (roll back).
- **Add label…** attaches a custom label (moving it from another version asks
  first); remove a custom label with its ×. AWS labels (AWSCURRENT,
  AWSPREVIOUS, AWSPENDING) can't be removed here.

## Rotation

**Rotation…** shows the status and last / next rotation, and lets you set:

- the **rotation function** (Lambda ARN; leave blank to keep the current one),
- the **schedule**: `rate(30 days)`, `rate(6 hours)` (4–23 hours) or
  `cron(0 4 1 * ? *)` (six fields, UTC), with 7 / 30 / 90-day shortcuts,
- an optional **window** in hours,
- **Also rotate immediately**.

**Rotate now…** rotates with the existing configuration; **Turn off…** stops
automatic rotation (the current value stays).

## Tags and resource policy

**Tags and policy…** (or right-click › Tags… / Resource policy…):

- **Tags**: add, change or remove, then **Save tags**.
- **Resource policy**: edit the JSON (start from an example if there's none),
  **Validate** it with AWS (problems are listed), **Save policy** (with
  **Block policies that grant broad access** on by default) or **Delete
  policy…**. If the endpoint can't validate policies, saving asks first.

## Read-only mode

With the toolbar lock on (on whenever you
connect), creating, editing, deleting, restoring, labels, rotation, tags and
policies are disabled and refused by the app's backend. Browsing, revealing
values, versions, comparing and validating a policy still work.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Enter / double-click | Open folder, show secret details |
| Ctrl+Shift+N | New secret |
| Ctrl+E | Edit secret |
| Del | Delete secret |
| F5 | Refresh |

## Permissions

The profile needs these IAM actions (scope `Resource` to your secrets):

- Browse: `secretsmanager:ListSecrets`, `secretsmanager:DescribeSecret`
- Values: `secretsmanager:GetSecretValue` (and `kms:Decrypt` on the key)
- Write: `secretsmanager:CreateSecret`, `PutSecretValue`, `UpdateSecret`,
  `DeleteSecret`, `RestoreSecret` (and `kms:GenerateDataKey` / `kms:Encrypt`)
- Versions: `secretsmanager:ListSecretVersionIds`,
  `secretsmanager:UpdateSecretVersionStage`
- Rotation: `secretsmanager:RotateSecret`, `secretsmanager:CancelRotateSecret`
  (plus `lambda:InvokeFunction` for the rotation function)
- Tags and policy: `secretsmanager:TagResource`, `UntagResource`,
  `GetResourcePolicy`, `ValidateResourcePolicy`, `PutResourcePolicy`,
  `DeleteResourcePolicy`
