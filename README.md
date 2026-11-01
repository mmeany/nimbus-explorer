# Nimbus Explorer

A classic Explorer-style desktop app that works with Amazon Web Services, using your AWS
profiles: Amazon S3, Parameter Store, SQS, SNS, DynamoDB, RDS, ECS, Lambda, CloudWatch Logs and Secrets Manager. Works with emulators such
as LocalStack.

Built with Tauri 2 (Rust backend), React and TypeScript. See `CLAUDE.md` for
the design decisions and roadmap.

## Prerequisites (developer machine only)

- Node.js 20+ (LTS)
- Rust (stable, MSVC toolchain on Windows) + Microsoft C++ Build Tools
- WebView2: already part of Windows 10/11

End users need none of these: the built app is a single native executable.

## Run

```
npm install
npm run tauri dev
```

The first build compiles the AWS SDK and takes a few minutes; later builds
are incremental.

## Build a distributable

```
npm install
npm run tauri build
```

This makes an optimised release build (several minutes the first time). The
first run downloads Tauri's installer tools (WiX for the MSI, NSIS for the
setup program), so it needs internet access.

| Output | Use |
|---|---|
| `src-tauri\target\release\bundle\nsis\Nimbus Explorer_<version>_x64-setup.exe` | Installer for most people: Start menu entry and uninstaller; no admin rights needed by default |
| `src-tauri\target\release\bundle\msi\Nimbus Explorer_<version>_x64_en-US.msi` | MSI installer, for IT / Group Policy deployment |
| `src-tauri\target\release\nimbus-explorer.exe` | The app as a single file; runs without installing |

To build only the setup program: `npm run tauri build -- --bundles nsis`.

Notes:

- **Not code-signed:** Windows SmartScreen shows "Windows protected your PC";
  users choose More info → Run anyway. Signing needs a code-signing
  certificate, configured under `bundle.windows` in
  `src-tauri/tauri.conf.json`.
- **Version:** `version` in `src-tauri/tauri.conf.json`. Raise it for each
  release so installers upgrade cleanly.
- **Platforms:** a build makes installers for the OS it runs on. Build on
  macOS / Linux (or in CI) for those.
- **Before a release:** run `cargo audit` in `src-tauri`
  (`cargo install cargo-audit` once).

## Services

| Service | Guide |
|---|---|
| Amazon S3 | this README (below) |
| Parameter Store | [docs/parameter-store.md](docs/parameter-store.md): folders, prefix filter with history, create/edit/delete, SecureString reveal, history/diff/labels/restore, tags/tier/policies, copy/move/rename, export/import |
| DynamoDB | [docs/dynamodb.md](docs/dynamodb.md): tables with filter history, scan & query (filters, projection, paging), results grid, item editor (JSON / DynamoDB JSON), PartiQL, export / import, create / delete tables, indexes, settings, backups |
| RDS | [docs/rds.md](docs/rds.md): instances and Aurora / Multi-AZ clusters with filter history, start / stop / reboot / fail over, modify (class, backups, deletion protection), delete with final snapshot, snapshots (create, copy, delete, restore, point in time), events, log files (tail, download), connection details and client commands, SQL on Aurora via the Data API (read-only runs rolled back, export) |
| ECS | [docs/ecs.md](docs/ecs.md): clusters, services (counts, deployments and events, load balancing, network), tasks (containers, stop reasons), scale / redeploy / change revision / roll back, stop and run tasks with overrides, task definitions (details, JSON, compare, new revision from JSON, deregister), container logs, ECS Exec command |
| Lambda | [docs/lambda.md](docs/lambda.md): functions (paged, filter history), details (environment variables revealed on demand, function URL, async settings, layers, VPC), invoke with saved test events and templates, logs, triggers (event sources on / off, resource-policy invokers), versions and aliases with traffic splits, settings (memory, timeout, env vars, concurrency), code download / upload, delete |
| CloudWatch Logs | [docs/cloudwatch-logs.md](docs/cloudwatch-logs.md): log groups (paged, prefix filter with history), streams, events newest first for a time range with filter patterns, load older, follow live, full message view (JSON tree), download (read only) |
| Secrets Manager | [docs/secrets-manager.md](docs/secrets-manager.md): folders, filter history, masked values with Reveal / Copy (key/value view), create / edit / delete / restore, versions and labels (compare, roll back), rotation, tags and resource policy |
| SQS | [docs/sqs.md](docs/sqs.md): queues with live counts and filter history, create/edit/delete, purge, send (single or from a file), peek / receive & hold, delete/release/export messages, dead-letter redrive |
| SNS | [docs/sns.md](docs/sns.md): topics and all subscriptions with filter history, create/edit/delete topics (FIFO, encryption, policies, tags), subscribe (any protocol, filter policies, DLQ, queue-policy helper), confirm/unsubscribe, publish (per-protocol messages, attributes, from a file), watch messages live via a temporary queue |

Each service is a node in the tree under the profile. Shared controls:

- **Region** list in the toolbar for the regional services (Parameter Store,
  SQS, SNS, DynamoDB, RDS, ECS, Lambda, CloudWatch Logs, Secrets Manager); remembered per profile. S3 always
  uses each bucket's own region.
- **Read-only lock** in the toolbar: on, nothing that changes AWS is allowed
  (enforced in the app's backend, not just hidden in the UI). The app always
  starts read-only, and so does every connection, including switching
  profiles. Allowing changes asks first (with an extra warning for profiles
  whose names contain `prod` or `prd`) and lasts until you lock it again or
  connect to a profile.
- **Paging**: long lists (queues, topics, tables, parameters, secrets,
  functions, log groups, ECS services and tasks, snapshots, events) are shown 100, 500 or 1,000 at a time with a pager under
  the list (Ctrl+PgUp / Ctrl+PgDn). Where each row costs an AWS call
  (queue counts, topic and table details, parameter values), only the page
  on screen is fetched.

## S3 features

- Classic Explorer layout: folder tree on the left, details list on the right,
  address bar, back/forward/up, status bar; light, dark or follow-Windows theme
- Browse buckets and folders, one page at a time: choose 100, 500 or 1,000
  items per page (remembered) and step with First / Previous / Next
  (Ctrl+PgUp / Ctrl+PgDn). S3 doesn't report a folder's size up front, so
  the pager says "Page 3 of more" until you reach the last page. Select all,
  delete and preview ←/→ work on the page shown
- **Search** box above the list (Ctrl+F): names starting with the text,
  searched by S3 itself, so it's quick in folders of any size; previous
  searches are remembered per bucket. Tick **Include subfolders** to search
  everything below the current folder as one flat list with a **Path**
  column (with the box empty, it lists every file below the folder). Opening
  another folder clears the search
- **Filter** row under the search: name contains, file types (e.g.
  `.json .csv`), size range (B / KB / MB / GB), modified date range and
  storage class. Filters narrow the page on screen (not the whole folder; use
  Next to check further pages), the status bar shows how many items match,
  and they stay set as you browse until you click **Clear filters**. Folders
  are hidden while a type, size, date or class filter is set
- Preview text, images and rendered Markdown; JSON, YAML and CSV as
  collapsible trees (CSV also as a table); ←/→ steps through the folder
- Download files or whole folders; upload files or folders (dialog or
  drag-and-drop from Explorer onto the list, a folder or a tree node)
- New folder, delete (folders recursively, with object count), rename,
  cut/copy/paste between folders and buckets (copied server-side)
- Share links (presigned URLs, up to 7 days) and a Properties dialog
- Sync a local folder with an S3 folder (either direction, like
  `aws s3 sync`): exclude patterns, optional mirror deletes, size-only mode,
  and a dry run that previews every change before anything runs
- Right-click any folder (tree or list) to sync it, download it, or save a
  recursive listing of its contents as a text file
- Copy the current s3:// location from the button beside the address bar
- Transfers panel with progress and cancel
- Works with LocalStack, MinIO and other S3-compatible endpoints

## Keyboard shortcuts (S3)

Shortcuts for the other services are in their guides.

| Keys | Action |
|---|---|
| Enter / double-click | Open folder, preview file |
| Backspace, Alt+↑ | Up one level |
| Alt+← / Alt+→ | Back / forward |
| F5 | Refresh |
| Ctrl+A | Select all (on this page) |
| Ctrl+PgDn / Ctrl+PgUp | Next / previous page |
| Ctrl+F | Search |
| Ctrl+X / Ctrl+C / Ctrl+V | Cut / copy / paste files |
| F2 | Rename file |
| Del | Delete |
| Ctrl+Shift+N | New folder |
| Alt+Enter | Properties |
| ← / → (in preview) | Previous / next file |

## Profiles

The profile dropdown lists profiles from `%USERPROFILE%\.aws\config` and
`%USERPROFILE%\.aws\credentials`, sorted by the label shown. The last profile
used is remembered. A profile with an `sso_session` setting is shown as
`sso-session (profile)`, for example `my-sso (dev-admin)`, so profiles that
share an SSO session sit together.

### LocalStack

```ini
# %USERPROFILE%\.aws\config
[profile localstack]
region = us-east-1
endpoint_url = http://localhost:4566

# %USERPROFILE%\.aws\credentials
[localstack]
aws_access_key_id = test
aws_secret_access_key = test
```

Or use the ⚙ button next to the profile list to set an endpoint and addressing
style for any profile without editing its config.

Profiles created with `aws login` aren't supported; use SSO, access keys or
`credential_process` profiles.

### SSO profiles

If the session has expired, the app shows the `aws sso login --profile …`
command to run, then Retry.

## License

MIT; see [LICENSE](LICENSE).

Not affiliated with or endorsed by Amazon Web Services. Amazon Web Services, AWS
and related names are trademarks of Amazon.com, Inc. or its affiliates.
