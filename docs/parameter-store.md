# Parameter Store

AWS Systems Manager Parameter Store, browsed like folders. Open **Parameter
Store** in the tree under your profile. It uses the region chosen in the
toolbar's **Region** list (remembered per profile).

## Browsing

- Names containing `/` are shown as folders: `/app/dev/db/host` appears as
  `host` inside `app › dev › db`. Names without a leading `/` sit at the top.
- The list shows **Name, Type, Value, Version, Last modified, Tier**.
  SecureString values are always shown as `••••••••`.
- **Enter** or double-click a parameter for its details: every field, and the
  value. Values that are JSON or YAML get a collapsible tree (Tree / Text).
- Big folders and filter results are shown a page at a time (folders first):
  choose 100, 500 or 1,000 per page with the pager under the list
  (remembered) and step with First / Previous / Next (Ctrl+PgUp / Ctrl+PgDn).
  Values are only fetched for the page you're looking at.

### Filtering by prefix

Type a name prefix in the **Filter** box above the list (for example
`/app/prod/` or `/app/prod/db`) and press **Enter**:

- The list becomes a flat view of every parameter whose name begins with the
  prefix, at any depth, with a **Path** column.
- The tree shows only the folders that contain matches.
- **Clear** (or clicking a folder in the tree) returns to folder browsing.

Filters you apply are remembered per profile and region (the last 10, newest
first). Open the ▾ list to reuse one, remove one with its ✕, or clear the
history. Right-click a folder and choose **Filter by this path** as a shortcut.

## Creating and editing

**New** (Ctrl+Shift+N) and **Edit** (Ctrl+E) open the editor:

| Field | Notes |
|---|---|
| Name | Letters, digits, `_ . - /`; hierarchical names start with `/`; can't start with `aws` or `ssm`; up to 15 levels. Fixed when editing. |
| Type | String, StringList (comma-separated) or SecureString (encrypted with KMS). |
| Value | JSON is checked as you type, with Format / Minify. The byte counter shows the tier's limit (4 KB Standard, 8 KB Advanced). SecureString values are masked; **Show** reveals them while editing. |
| Description, KMS key, Tier, Data type, Allowed pattern | Optional. KMS key applies to SecureString (blank = `alias/aws/ssm`). |

- Creating a name that already exists asks before overwriting.
- Saving an edit creates a new version. If someone changed the parameter while
  the editor was open, you're warned before your save replaces it.
- Editing a SecureString decrypts its current value into the editor (opening
  the editor is the explicit action).

## SecureString values

Values are decrypted only when you ask:

- **Reveal** / **Copy** in the details dialog (Hide drops the value again;
  closing the dialog forgets it).
- **Copy decrypted value** in the right-click menu copies without showing it.

Decrypted values are never cached, logged or written to settings.

## History and labels

**History** (or right-click › History and labels…) lists every version with its
date, who changed it, labels and value.

- Click a version to see its value (SecureString: Reveal per version).
- **Ctrl+click** a second version, then **Compare**, or use **Compare with
  current**. JSON values are pretty-printed first so the diff shows which keys
  changed. Comparing SecureStrings decrypts both versions for the diff only.
- **Add label…** attaches a label (letters, digits, `_ . -`; not starting with
  a digit, `aws` or `ssm`). A label already on another version moves (you're
  asked first). Remove a label with the × on it. Reference a labelled version
  as `name:label`.
- **Restore this version…** saves that version's value (with its type and KMS
  key) as a new version. Nothing is deleted.

## Tags, tier and policies

Right-click › **Tags…** or **Tier and policies…** (also from the details
dialog):

- **Tags**: add, change or remove key/value pairs, then **Save tags**.
- **Tier**: Standard → Advanced (charged; can't be changed back).
- **Policies** (Advanced only): an expiration time (SSM deletes the parameter
  then), a notification some days/hours before expiration, and a notification
  if the parameter hasn't changed for some days/hours. Notifications are
  EventBridge events.

SSM changes tier and policies only by writing the parameter again, so saving
these creates a new version with the same value.

## Copy, move and rename

Works on parameters and whole folders:

- **Ctrl+C / Ctrl+X**, then **Ctrl+V** in another folder (or right-click ›
  Paste into this folder).
- **Copy to…** / **Move to…** ask for a destination folder.
- **Rename…** (F2) gives a parameter a new name or path; renaming a folder
  moves everything inside it.

Copies keep the value, type, KMS key, description, allowed pattern, data type,
tier and tags (not history, labels or policies). If destinations already exist
you choose **Overwrite**, **Skip existing** or **Cancel**. A move deletes each
original only after its copy succeeded, so a failure never loses a parameter.

## Export and import

**Export** writes every parameter under a folder to a file:

- **JSON**: names, types, values, descriptions, KMS keys, tiers and tags. It
  can be imported again.
- **.env**: `KEY="value"` lines; keys come from the names below the folder
  (`/app/dev/db/host` exported from `/app/dev/` → `DB_HOST`).

SecureString values are left out unless you tick **Include decrypted
SecureString values** (asked every time; the file then holds secrets in plain
text).

**Import** reads:

- a JSON export from this app (keep its names, or untick to move it into
  another folder),
- a plain JSON object such as `{"db/host": "localhost", "port": 5432}` (names
  go into the folder you choose; non-string values are stored as JSON text),
- a `.env` file (`KEY=value`, `export KEY=…`, quotes and `#` comments; keys go
  into the folder you choose as they are).

**Preview** compares the file with what's there and lists each parameter as
create, overwrite (value or type differs), unchanged or skip (with the reason,
e.g. an invalid name or a SecureString exported without its value). Only
creates run unless you also tick the overwrite box. The previewed plan is run
exactly once.

## Deleting

**Del** deletes the selected parameters. Selecting a folder deletes every
parameter under it; the confirmation lists what will go. Deleting removes all
versions and labels and can't be undone.

## Read-only mode

With the toolbar lock on (on whenever you
connect), everything that writes is disabled, and the app's backend refuses
writes even if asked. Browsing, filtering, revealing values, history, compare,
export and import previews still work.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Enter / double-click | Open folder, show parameter details |
| Ctrl+Shift+N | New parameter |
| Ctrl+E | Edit parameter |
| F2 | Rename parameter or folder |
| Ctrl+X / Ctrl+C / Ctrl+V | Cut / copy / paste |
| Del | Delete |
| F5 | Refresh |

## Permissions

The profile needs these IAM actions (scope `Resource` to the parameters you
work with):

- Browse: `ssm:DescribeParameters`, `ssm:GetParameters`, `ssm:GetParameter`
- History: `ssm:GetParameterHistory`
- Write: `ssm:PutParameter`, `ssm:DeleteParameters`,
  `ssm:LabelParameterVersion`, `ssm:UnlabelParameterVersion`
- Tags: `ssm:ListTagsForResource`, `ssm:AddTagsToResource`,
  `ssm:RemoveTagsFromResource`
- SecureString: `kms:Decrypt` (reveal, copy, edit, compare, export) and
  `kms:Encrypt` for the key in use (create / edit)
