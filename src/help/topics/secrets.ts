export const secretsTopics = {
  "secrets.browse": {
    title: "Secrets Manager",
    body: `Names containing \`/\` appear as folders: \`prod/app/db\` is \`db\` inside \`prod › app\`. Secrets scheduled for deletion are faded.

- **Filter**: type the start of a name, such as \`prod/\`, and press Enter for a flat list with a **Folder** column.
- **Open** a secret: Enter or double-click. Its value stays hidden until you click **Reveal** or **Copy**, and it's forgotten when you hide it or close the window.
- **Right-click › Copy value**: copies without showing it.
- **New** (Ctrl+Shift+N), **Edit** (Ctrl+E), **Delete** (Del), **Versions**: in the commands.
- **Right-click** a secret for **Rotation…**, **Tags…** and **Resource policy…**. An open secret has them too.
- **Restore**: brings back a secret scheduled for deletion, until its date.

In read-only mode you can still browse, reveal values, view versions, compare, and validate a policy.`,
  },
  "secrets.editor": {
    title: "Secret editor",
    body: `- **Name**: letters, digits and \`/ _ + = . @ -\`. Avoid ending with a hyphen and six characters, which looks like the random suffix in secret ARNs.
- **Value**, one of:
  - **Key / value** rows, each with a type, saved as a JSON object;
  - **Plaintext**, with JSON checked as you type;
  - **Binary**, as base64.
- **Show values**: values are masked until you click it.
- **Description**, **Encryption key** (blank means \`aws/secretsmanager\`) and **Tags**.

Saving a changed value creates a new version labelled **AWSCURRENT**, and the previous one becomes **AWSPREVIOUS**. Changing only the description or key doesn't create a version.`,
  },
  "secrets.delete": {
    title: "Delete secret",
    body: `- **Schedule deletion**: with a 7 to 30 day recovery window. The secret can't be read meanwhile, and can be **Restored** until the date. Prefer this.
- **Delete immediately**: no recovery at all. You type the secret's name to confirm.

Check nothing still reads the secret first. **Last retrieved** in the list is a useful clue.`,
  },
  "secrets.versions": {
    title: "Secret versions",
    body: `Every version, with its staging labels, creation time and when it was last retrieved. Versions without labels are deprecated, and Secrets Manager may remove them.

- Click a version to **Reveal** its value.
- **Compare with current**, or Ctrl+click two versions and **Compare**. Both are decrypted for the diff.
- **Make current…**: moves AWSCURRENT to this version, which is how you roll back.
- **Add label…**: attaches a custom label; moving it from another version asks first. Remove a custom label with its ×.

AWS labels (AWSCURRENT, AWSPREVIOUS, AWSPENDING) can't be removed here.`,
  },
  "secrets.rotation": {
    title: "Rotation",
    body: `Shows the status and the last and next rotation.

- **Rotation function**: a Lambda ARN. Leave blank to keep the current one.
- **Schedule**: \`rate(30 days)\`, \`rate(6 hours)\` (4 to 23 hours) or \`cron(0 4 1 * ? *)\` (six fields, UTC), with 7, 30 and 90-day shortcuts.
- **Window**: optional, in hours.
- **Also rotate immediately**.

**Rotate now…** rotates with the existing configuration. **Turn off…** stops automatic rotation, and the current value stays.`,
  },
  "secrets.settings": {
    title: "Tags and resource policy",
    body: `**Tags**: add, change or remove pairs, then **Save tags**.

**Resource policy**: controls who else can use this secret.

- Edit the JSON, starting from an example if there's none.
- **Validate** checks it with AWS and lists any problems.
- **Save policy**: **Block policies that grant broad access** is on by default.
- **Delete policy…** removes it.

If the endpoint can't validate policies, saving asks first.`,
  },
};
