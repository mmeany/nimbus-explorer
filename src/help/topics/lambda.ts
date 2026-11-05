export const lambdaTopics = {
  "lambda.functions": {
    title: "Lambda functions",
    body: `The region's functions, with runtime, memory, timeout, architecture, code size, last modified and description. The tree lists the first 200.

- **Filter**: type the start of a function name and press Enter.
- **Open** a function: Enter or double-click.
- **Settings**: Ctrl+E.
- **Delete**: Del. You type the name to confirm. Its log group is kept.

Creating functions isn't part of this app, because they need an IAM role set up first. Use the AWS console or your deployment tools.`,
  },
  "lambda.details": {
    title: "Function details",
    body: `Runtime, handler, memory, timeout, execution role, log group, tracing, layers, VPC and tags. While an update is in progress, the view checks again every few seconds.

- **Environment variables**: names are listed. **Reveal values** fetches the values from AWS, and **Hide values** or leaving the function drops them.
- **Code**: **Download code…** saves the \`$LATEST\` package. **Upload .zip…** replaces it.
- **Function URL**: the address and its settings, with a warning if it's open to anyone.
- **Asynchronous invocation**: retries, maximum event age and destinations.
- **Open in CloudWatch Logs**: goes to the log group.
- **Settings…** (Ctrl+E): description, memory, timeout, environment variables and concurrency.`,
  },
  "lambda.invoke": {
    title: "Invoke",
    body: `Write a JSON event and press **Invoke** (Ctrl+Enter). **This runs your code, which can change things**, so it's disabled in read-only mode.

- **Saved events**: **Save as…** keeps an event for this function on this computer. Pick one from the list to load it.
- **Start from a template…**: an empty object, API Gateway request, SQS message, S3 event or EventBridge schedule.
- **Version or alias**: empty means \`$LATEST\`.
- **Asynchronous**: Lambda queues the event and answers at once (status 202). Retries and destinations apply, and the output goes to the log.

A synchronous call shows whether it succeeded or the function returned an error, the duration, billed duration, memory used and cold start time, the response, and the last 4 KB of the log. **Show all logs** opens the Logs tab.`,
  },
  "lambda.logs": {
    title: "Function logs",
    body: `The function's log group, newest first for a time range.

- **Filter pattern**: \`ERROR\`, \`"timed out"\`, \`ERROR -health\` or \`{ $.level = "error" }\`. Press Enter or **Search**.
- **Load older**: fetches further back.
- **Follow**: adds new events every 3 seconds.
- Click an event for its full message. JSON gets a tree.
- **Download…**: saves every matching event in the range.

New invocations can take a few seconds to appear.`,
  },
  "lambda.triggers": {
    title: "Triggers",
    body: `What makes this function run.

**Event sources** are queues and streams Lambda reads from: SQS, DynamoDB and Kinesis streams, Kafka, Amazon MQ. **Disable** stops Lambda reading from a source, and messages and records wait there meanwhile. **Enable** starts it again.

**Allowed to invoke** lists the statements of the function's resource policy, which is how S3, SNS, EventBridge, API Gateway and other accounts call it. The full policy JSON is underneath.`,
  },
  "lambda.versions": {
    title: "Versions and aliases",
    body: `- **Publish version…**: freezes the current code and settings of \`$LATEST\` as a numbered version.
- **Aliases**: a name pointing at a version, optionally splitting traffic with a second one. **New alias…**, **Edit…** and **Delete…** manage them.
- **Versions**: \`$LATEST\` first, then newest. **Download** saves that version's code. **Delete…** needs you to type its number, and a version an alias uses can't be deleted until you change the alias.
- **Provisioned concurrency** is listed when any is configured.

Point callers at an alias, and you can change or roll back the version without changing the callers.`,
  },
  "lambda.settings": {
    title: "Function settings",
    body: `- **Description**.
- **Memory**: 128 to 10,240 MB. CPU grows with memory.
- **Timeout**: 1 to 900 seconds.
- **Environment variables**: current values load when the dialog opens, and all are saved together. Names use letters, digits and \`_\`, and can't start with \`AWS_\`. The limit is 4 KB in total.
- **Reserved concurrency**: unreserved, a number (which is also the most it can run at once), or 0 to stop the function running.

If someone else changed the function after you opened this, saving is refused so their change isn't overwritten. Refresh and try again.`,
  },
  "lambda.alias": {
    title: "Alias",
    body: `An alias is a name that points at a version, so callers don't need to change when you release.

- **Version**: where the alias points.
- **Second version and weight**: optional. That version gets the share of traffic you set, for a gradual rollout. Both must be published versions, not \`$LATEST\`.

Clear the second version to send all traffic back to the main one.`,
  },
  "lambda.upload": {
    title: "Upload code",
    body: `Replaces the code of \`$LATEST\`.

- **From this computer**: a .zip of up to 50 MB.
- **From S3**: a bucket, key and optional version, in the same region as the function.
- **Publish**: also publishes the new code as a version straight away.

If the function changed after you opened this, the upload is refused. Container image functions are updated by deploying a new image instead.`,
  },
};
