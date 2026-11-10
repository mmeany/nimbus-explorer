export const generalTopics = {
  general: {
    title: "General",
    body: `Nimbus Explorer browses and manages AWS services in an Explorer-style window: the tree on the left, the current view on the right, and commands above it.

### Getting connected

- Choose a **Profile** from your AWS config. Credentials only ever come from the profile.
- If an SSO session has expired, the app shows the \`aws sso login --profile …\` command to run. Run it in a terminal, then choose **Retry**.
- The ⚙ button next to the profile sets a custom endpoint and addressing style for that profile, for LocalStack, MinIO and similar.

### Read-only lock

Every connection starts **read-only**. Nothing that changes AWS is allowed, and the app's backend refuses it as well as the screen disabling it. Click the lock in the toolbar to allow changes. It asks first, and connecting to a profile locks it again.

### Region

The **Region** list applies to every service except S3, whose buckets always use their own region. It's remembered per profile.

### Moving around

| Keys | Action |
|---|---|
| Enter / double-click | Open |
| Backspace, Alt+↑ | Up one level |
| Alt+← / Alt+→ | Back / forward |
| F5 | Refresh |
| F1 | Help for the current view or dialog |
| Ctrl+H | History |
| Ctrl+D | Bookmark this location (and the selected item) |
| Ctrl+Shift+B | Show or hide the bookmarks bar |
| Ctrl+Shift+O | Manage bookmarks |

Click any part of the address bar to jump there. The button beside it copies the current location.

### Bookmarks and history

The **bookmarks bar** under the address bar holds pinned bookmarks, a folder per service and your own folders. The ☆ or Ctrl+D adds a bookmark, and clicking one goes there. **History** (the clock button, Ctrl+H) lists what you did, and an entry can take you back to where it happened. Neither ever re-runs anything.

### Long lists

Long lists show 100, 500 or 1,000 rows at a time. Use the pager under the list, or Ctrl+PgUp / Ctrl+PgDn. Where each row costs an AWS call, only the page on screen is fetched, and sorting by a column other than the name sorts just that page.

### Line numbers

Text views (file previews, parameter and secret values, messages, log events, diffs) number their lines in a left margin. Untick **Line numbers** in any of them to hide the numbers everywhere; the choice is remembered. Copying text never includes the numbers.

### Columns

Click a column heading to sort by it. Drag the edge of a heading to resize the column, or double-click the edge to fit the widest row on screen. Each list remembers its widths. Right-click a heading and choose **Reset column widths** to go back to the defaults.

### Filters

Filter boxes remember your last 10 filters per profile and region. Open the ▾ list to reuse one, remove one with its ✕, or clear the history.

### Secrets

Secret values stay masked until you choose **Reveal** or **Copy**. They're never cached or logged.`,
  },
  home: {
    title: "Home",
    body: `This lists the services the app can work with. Open one here or in the tree.

- **Amazon S3**: buckets, folders and files
- **Parameter Store**: configuration values and secrets
- **SQS** and **SNS**: queues, topics and subscriptions
- **DynamoDB**: tables and items
- **RDS**: databases, Aurora clusters and snapshots
- **ECS**: clusters, services, tasks and task definitions
- **Lambda**: functions, invoking, triggers and versions
- **CloudWatch Logs**: log groups, streams and events
- **Secrets Manager**: secrets, versions and rotation

Press **F1** anywhere for help with what's on screen. **General help** below covers the profile, the read-only lock, regions and shortcuts.

**About** (before the theme list) shows the version and links to the project on GitHub, where you can report bugs and request features.`,
  },
  history: {
    title: "History",
    body: `The app records what you do, per profile: changes (uploads, deletes, edits, invokes, purges…), downloads and exports, connecting, unlocking or locking read-only mode, and exporting or importing bookmarks. Open it with the clock button in the toolbar or **Ctrl+H**.

### Going back to where it happened

Double-click an entry, or select it and choose **Go to location**. **Bookmark…** saves that location as a bookmark, for the entry's profile and region. The app opens the folder, queue, table, function or other place where it happened and selects the item when it's on the page. If the entry belongs to another profile, it asks before switching, and it switches region if needed. **Nothing is run again.**

After a delete, the location is the folder or list the item was in.

### What's recorded

Time, service, action, target (names, keys, ARNs), the result and a short detail such as a count. **Values are never recorded**: no parameter or secret values, message bodies, item contents, environment variables, payloads or SQL text. Reads such as SELECT statements, and anything refused by the read-only lock, aren't recorded.

### Filters

Filter by profile, service, text, date range (your local days) or failures only. **Load older** fetches the next 200.

### Files and settings

History is kept on this computer in one folder per profile under the app's settings folder (**Open folder** shows it), as JSON Lines files. In **Settings…** choose when a new file starts (every day, week, month or year, and when a file reaches a size), how many files to keep (older ones are deleted), or turn recording off.

**Export…** writes the filtered entries as CSV, or JSON if the file name ends in \`.json\`. **Clear…** deletes the selected profile's history after you type its name.`,
  },
  "connection.settings": {
    title: "Connection settings",
    body: `Point this profile at a different endpoint without editing your AWS config. It's for emulators and S3-compatible servers such as LocalStack and MinIO.

- **Endpoint URL**: for example \`http://localhost:4566\`. Leave it blank to use the profile's own \`endpoint_url\`, or real AWS if it has none.
- **Addressing style**: path-style puts the bucket in the URL path, and virtual-hosted puts it in the host name. Custom endpoints default to path-style.

Saving reconnects the profile, which starts read-only again. This setting takes priority over \`endpoint_url\` in the profile.`,
  },
};
