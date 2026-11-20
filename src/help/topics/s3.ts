export const s3Topics = {
  "s3.buckets": {
    title: "S3 buckets",
    body: `The buckets this profile can list, with each one's region and creation date. Open a bucket with Enter or a double-click, or expand it in the tree.

The app talks to each bucket in that bucket's own region, so the toolbar's **Region** list doesn't affect S3.

Right-click a bucket in the tree to sync it, save a list of its contents, copy its S3 URI or see its properties.

Creating and deleting buckets isn't part of this app.`,
  },
  "s3.folder": {
    title: "S3 folder",
    body: `The files and sub-folders at this location, one page at a time. The pager says "Page 3 of more" until you reach the last page, because S3 doesn't report a folder's size up front. Select all, delete and preview work on the page shown.

### Finding files

- **Search** (Ctrl+F): names starting with the text, searched by S3 itself. Tick **Include subfolders** for a flat list of everything below this folder, with a **Path** column.
- **Filter** row: name, file types (\`.json .csv\`), size, date and storage class. Filters only narrow the page on screen, so use Next to check further pages. They stay set until you click **Clear filters**.

### Working with files

- **Preview**: Enter or double-click a file. Text, images, Markdown, JSON, YAML and CSV are supported, and ←/→ steps through the folder. Text views show **line numbers** (untick to hide them) and can **wrap lines**.
- **Upload**: the command bar, or drag files from Explorer onto the list, a folder or a tree node.
- **Download**: select items and choose Download. Folders are recreated recursively.
- **Copy and move**: cut, copy and paste files between folders and buckets. Copies are made inside S3, with nothing downloaded.
- **Right-click** for share links, properties, Copy S3 URI, sync, and saving a listing of a folder.

Progress for uploads and downloads is in the status bar. Click it for the transfers panel, where you can cancel.

### Shortcuts

| Keys | Action |
|---|---|
| Ctrl+X / Ctrl+C / Ctrl+V | Cut / copy / paste files |
| F2 | Rename a file |
| Del | Delete (folders recursively, after confirming) |
| Ctrl+Shift+N | New folder |
| Alt+Enter | Properties |
| Ctrl+A | Select all on this page |
| Ctrl+F | Search |`,
  },
  "s3.sync": {
    title: "Sync",
    body: `Makes a local folder and this S3 folder match in one direction, like \`aws s3 sync\`. A file is copied if it's missing on the other side, its size differs, or the source is newer.

- **Direction**: Upload changes S3 and needs read-only mode off. Download only changes local files.
- **Compare by size only**: ignores dates.
- **Delete … (mirror)**: also removes files that aren't in the source. Local deletes are permanent; they don't go to the Recycle Bin.
- **Exclude**: patterns using \`*\` and \`?\`.

**Dry run** and **Preview sync…** compare both sides and list what would change, with exact totals, and change nothing. Long previews list the first 100 actions, with deletes first, and say so.

**Run sync** then carries out exactly what was previewed, once. A run with deletes needs a second confirming click.

Keys that can't become valid local file names, and names differing only by case on Windows, are skipped with a warning.`,
  },
  "s3.share": {
    title: "Share link",
    body: `Creates a presigned link that lets anyone holding it download this file, without AWS credentials, until the link expires.

- Choose how long it lasts, from 15 minutes to 7 days.
- With SSO or assumed-role credentials, the link stops working when those credentials expire. The dialog warns you when the time is shortened for this reason.
- With a custom endpoint on localhost, the link only works on this machine.

Treat the link as you would the file: anyone who has it can download it.`,
  },
};
