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

Click any part of the address bar to jump there. The button beside it copies the current location.

### Long lists

Long lists show 100, 500 or 1,000 rows at a time. Use the pager under the list, or Ctrl+PgUp / Ctrl+PgDn. Where each row costs an AWS call, only the page on screen is fetched, and sorting by a column other than the name sorts just that page.

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

Press **F1** anywhere for help with what's on screen. **General help** below covers the profile, the read-only lock, regions and shortcuts.`,
  },
  "connection.settings": {
    title: "Connection settings",
    body: `Point this profile at a different endpoint without editing your AWS config. It's for emulators and S3-compatible servers such as LocalStack and MinIO.

- **Endpoint URL**: for example \`http://localhost:4566\`. Leave it blank to use the profile's own \`endpoint_url\`, or real AWS if it has none.
- **Addressing style**: path-style puts the bucket in the URL path, and virtual-hosted puts it in the host name. Custom endpoints default to path-style.

Saving reconnects the profile, which starts read-only again. This setting takes priority over \`endpoint_url\` in the profile.`,
  },
};
