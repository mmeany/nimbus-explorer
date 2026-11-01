# Lambda

AWS Lambda functions. Open **Lambda** in the tree under your profile. It uses
the region chosen in the toolbar's **Region** list (remembered per profile).

What this view doesn't do (agreed scope): create functions (they need an IAM
role set up first), edit code inside the app, or show X-Ray traces and metric
charts. Use the AWS console or your deployment tools for those.

## Functions

The list shows **Function, Runtime** (or "Container image"), **Memory,
Timeout, Architecture, Code size, Last modified** and **Description**, a page
at a time: choose 100, 500 or 1,000 per page and step with First / Previous /
Next (Ctrl+PgUp / Ctrl+PgDn). The tree lists the first 200 functions.

Type the start of a function name in the **Filter** box and press **Enter**.
Filters are remembered per profile and region (the last 10).

Open a function (Enter, double-click or click it in the tree). The header
shows its state, any update in progress (the view checks again every few
seconds until it finishes), its runtime and **Copy ARN**. The tabs:
**Details, Invoke, Logs, Triggers** and **Versions and aliases**.

## Details

- Runtime, handler (or image), architecture, memory, timeout, ephemeral
  storage, code size and SHA-256, last modified, concurrency, execution role,
  log group (with **Open in CloudWatch Logs**), log format, tracing,
  SnapStart, encryption key and dead-letter queue.
- **Code**: **Download code…** saves the deployment package (.zip) of
  `$LATEST`; **Upload .zip…** replaces it (see below).
- **Environment variables**: names are listed; values are hidden until you
  click **Reveal values**, which fetches them from AWS. **Hide values** (or
  leaving the function) drops them. Each value has **Copy** while shown.
- **Function URL**: the URL (**Copy**), authentication (a warning when it's
  open to anyone), invoke mode and CORS.
- **Asynchronous invocation**: retry attempts, maximum event age and the
  on-success / on-failure destinations.
- Layers, VPC (subnets, security groups) and tags.

## Invoke

Write a JSON event and press **Invoke** (Ctrl+Enter).

- **Saved events**: **Save as…** keeps the event for this function (on this
  computer, per profile and region); pick one from the list to load it;
  **Delete** removes the saved copy.
- **Start from a template…**: an empty object, an API Gateway (HTTP API)
  request, an SQS message, an S3 "object created" event or an EventBridge
  schedule.
- **Version or alias**: leave empty for `$LATEST`, or choose one of the
  function's aliases or versions.
- **Asynchronous**: Lambda queues the event and answers at once (status 202);
  retries and destinations apply, and the output goes to the log.

A synchronous call shows whether it succeeded or the function returned an
error, the **duration, billed duration, memory used** and **cold start**
time, the **response** (a tree for JSON, with **Copy**) and the **last 4 KB of
the log**. **Show all logs** opens the Logs tab.

Invoking runs your code, which can change things, so it's disabled in
read-only mode.

## Logs

The function's log group (`/aws/lambda/<name>` unless it's set to another),
in the shared log viewer: newest first for a time range, filter patterns,
**Load older**, **Follow** for new events every 3 seconds, the full message of
the selected event and **Download…**. See [CloudWatch Logs](cloudwatch-logs.md).

## Triggers

- **Event sources**: queues and streams Lambda reads from (SQS, DynamoDB and
  Kinesis streams, Kafka, Amazon MQ), with their state, batch size, batching
  window and last result. **Disable** stops Lambda reading from a source
  (messages and records wait in it meanwhile); **Enable** starts it again.
- **Allowed to invoke**: the statements of the function's resource policy,
  which is how S3, SNS, EventBridge, API Gateway and other accounts call it:
  principal, source, account and action. The full policy JSON is underneath.

## Versions and aliases

- **Publish version…** freezes the current code and settings (`$LATEST`) as
  a numbered version, with an optional description.
- **Aliases** show which version each points at, and how traffic is split.
  **New alias…** / **Edit…** choose the version and, optionally, a second
  version that gets a share of the traffic (a gradual rollout; only between
  published versions). **Delete…** removes an alias after asking.
- **Versions**: `$LATEST` first, then newest. **Download** saves a version's
  code. **Delete…** removes a published version after you type its number;
  a version an alias uses can't be deleted until you change the alias.
- Provisioned concurrency, when any is configured.

## Changing settings

**Settings…** (Ctrl+E) changes:

- **Description, memory** (128 to 10,240 MB; CPU grows with memory) and
  **timeout** (1 to 900 seconds).
- **Environment variables**: the dialog loads the current values; add, edit
  or remove rows, and they're saved together (names use letters, digits and
  `_`, can't start with `AWS_`; 4 KB in total).
- **Reserved concurrency**: unreserved, reserve a number (also the most it
  can run at once), or 0 to stop the function running.

If someone else changed the function after you opened the dialog, saving is
refused rather than overwriting their change; refresh and try again.

**Upload .zip…** replaces the code of `$LATEST` with a .zip from this computer
(up to 50 MB) or one already in S3 (same region), and can publish it as a new
version straight away. Container image functions are updated by deploying a
new image instead.

**Delete…** (Del) deletes the function with all its versions and aliases
after you type its name. Its log group is kept.

## Read-only mode

With the toolbar lock on (on whenever you
connect), invoking, settings, code uploads, triggers on / off, publishing,
aliases and deletes are disabled, and the app's backend refuses them.
Browsing, revealing environment variables, logs, saved test events and code
downloads still work.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Enter / double-click | Open function |
| Ctrl+E | Settings |
| Del | Delete function |
| Ctrl+Enter (Invoke tab) | Invoke |
| F5 | Refresh |

## Permissions

The profile needs these IAM actions (scope `Resource` to your functions):

- Browse: `lambda:ListFunctions`, `lambda:GetFunction`,
  `lambda:GetFunctionConfiguration`, `lambda:GetFunctionUrlConfig`,
  `lambda:GetFunctionEventInvokeConfig`, `lambda:GetPolicy`,
  `lambda:ListEventSourceMappings`, `lambda:ListVersionsByFunction`,
  `lambda:ListAliases`, `lambda:ListProvisionedConcurrencyConfigs`
- Invoke: `lambda:InvokeFunction`
- Settings: `lambda:UpdateFunctionConfiguration`,
  `lambda:PutFunctionConcurrency`, `lambda:DeleteFunctionConcurrency`,
  `lambda:UpdateEventSourceMapping`
- Versions and aliases: `lambda:PublishVersion`, `lambda:CreateAlias`,
  `lambda:UpdateAlias`, `lambda:DeleteAlias`, `lambda:DeleteFunction`
- Code: `lambda:UpdateFunctionCode` (and `s3:GetObject` on the .zip when
  uploading from S3); downloading uses the link GetFunction returns
- Logs: as in [CloudWatch Logs](cloudwatch-logs.md)
- Environment variables encrypted with your own KMS key also need
  `kms:Decrypt` on it to reveal them.
