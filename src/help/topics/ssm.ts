export const ssmTopics = {
  "ssm.browse": {
    title: "Parameter Store",
    body: `Names containing \`/\` appear as folders: \`/app/dev/db/host\` is \`host\` inside \`app › dev › db\`. SecureString values always show as dots here. Open a parameter (Enter or double-click) for its details and value.

### Filter by prefix

Type a prefix such as \`/app/prod/\` and press **Enter** for a flat list of every match at any depth, with a **Path** column. The tree then shows only folders with matches. **Clear**, or clicking a folder in the tree, goes back to browsing. You can also right-click a folder and choose **Filter by this path**.

### What you can do

- **New** (Ctrl+Shift+N), **Edit** (Ctrl+E). Saving an edit creates a new version.
- **Right-click** a parameter for History and labels, Tags, Tier and policies, and Copy decrypted value (copies without showing it).
- **Copy and move**: Ctrl+C / Ctrl+X then Ctrl+V, **Copy to…**, **Move to…**, **Rename…** (F2). These work on parameters and whole folders.
- **Export** and **Import** a folder as JSON or .env.
- **Del** deletes the selected parameters, or everything under a selected folder. All versions and labels go too, and this can't be undone.

In read-only mode you can still browse, filter, reveal values, view history, compare, export, and preview an import.`,
  },
  "ssm.editor": {
    title: "Parameter editor",
    body: `- **Name**: letters, digits and \`_ . - /\`. Hierarchical names start with \`/\`, up to 15 levels. A name can't start with \`aws\` or \`ssm\`, and is fixed when editing.
- **Type**: String, StringList (comma-separated) or SecureString (encrypted with KMS).
- **Value**: JSON is checked as you type, with Format and Minify. The limit is 4 KB for Standard and 8 KB for Advanced. SecureString values are masked; **Show** reveals them.
- **KMS key**: SecureString only. Blank means \`alias/aws/ssm\`.
- **Description, Tier, Data type, Allowed pattern**: optional.

Saving an edit creates a new version. If someone else changed the parameter while this was open, you're warned before replacing it. Creating a name that already exists asks before overwriting.`,
  },
  "ssm.history": {
    title: "Parameter history",
    body: `Every version, with its date, who changed it, its labels and its value.

- Click a version to see its value. SecureString versions have their own **Reveal**.
- **Compare**: Ctrl+click a second version, or use **Compare with current**. JSON is pretty-printed first, so the diff shows which keys changed. SecureStrings are decrypted only for the diff.
- **Add label…**: a label already on another version moves here, after asking. Remove one with its ×. Refer to a labelled version as \`name:label\`.
- **Restore this version…**: saves that version's value, type and KMS key as a new version. Nothing is deleted.`,
  },
  "ssm.settings": {
    title: "Tags, tier and policies",
    body: `- **Tags**: add, change or remove pairs, then **Save tags**.
- **Tier**: Standard to Advanced. Advanced is charged and can't be changed back.
- **Policies** (Advanced only): an expiration time, when SSM deletes the parameter; a notification before expiration; and a notification if the parameter hasn't changed for a while. Notifications are EventBridge events.

SSM changes tier and policies only by writing the parameter again, so saving these creates a new version with the same value.`,
  },
  "ssm.export": {
    title: "Export parameters",
    body: `Writes every parameter under the folder to a file.

- **JSON**: names, types, values, descriptions, KMS keys, tiers and tags. It can be imported again.
- **.env**: \`KEY="value"\` lines, with keys made from the names below the folder (\`/app/dev/db/host\` exported from \`/app/dev/\` becomes \`DB_HOST\`).

SecureString values are left out unless you tick **Include decrypted SecureString values**. The file then holds secrets in plain text, so look after it.`,
  },
  "ssm.import": {
    title: "Import parameters",
    body: `Reads one of these:

- a JSON export from this app (keep its names, or untick to put them in another folder);
- a plain JSON object such as \`{"db/host": "localhost", "port": 5432}\`;
- a \`.env\` file.

**Preview** compares the file with what's there and lists each parameter as create, overwrite, unchanged or skip, with the reason. A SecureString exported without its value is skipped, for example.

Only creates run unless you also tick the overwrite box. The previewed plan runs exactly once.`,
  },
};
