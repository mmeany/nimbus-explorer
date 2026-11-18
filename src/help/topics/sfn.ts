export const sfnTopics = {
  "sfn.machines": {
    title: "State machines",
    body: `The region's state machines, with type (Standard or Express), status, logging level, tracing, created date and description. The tree lists the first 200. Details are read for the page on screen only.

- **Filter**: type the start of a name and press Enter.
- **Open** a machine: Enter or double-click.
- **Edit** (Ctrl+E): definition, role, logging and tracing.
- **New state machine**: from a template or your own definition.
- **Delete** (Del): you type the name to confirm; versions and aliases go with it.`,
  },
  "sfn.graph": {
    title: "Graph",
    body: `The machine drawn as a flow, top to bottom, from **Start** to **End**. Choice rules are labelled with their condition, dotted lines are a Choice's default, red dashed lines are Catch routes, and loops come back up on the right.

- **Move**: drag. **Zoom**: mouse wheel or the − / + buttons. **Fit** shows the whole graph; **100%** is actual size.
- **Parallel and Map** states are boxes holding their branches. The − / + button in a box's corner collapses or expands it; **Expand all** opens every one.
- **Click a state** to see its definition on the right.
- **Export SVG…** saves the graph in the current theme's colours.

Problems in the definition, like a transition to a state that doesn't exist, are listed above the graph.`,
  },
  "sfn.execution.graph": {
    title: "Execution graph",
    body: `The definition this execution ran with, coloured by what happened: green succeeded, blue running, red failed, amber failed but caught (a Catch moved on to another state). States without colour didn't run. While the execution runs, the graph updates every 5 seconds.

- **Click a state** to see how it ran: when it was entered and exited, how long it took, failed attempts (retries), the error and cause, and its input and output.
- A state entered more than once (a loop, or Map iterations) shows ×n; the details are from the last time.
- A distributed Map's items run as child executions, so the states inside it aren't coloured here.

The colours come from the execution's event history; for very long histories, only the first 25,000 events are read.`,
  },
  "sfn.start": {
    title: "Start execution",
    body: `Runs the state machine with a JSON input (at most 256 KB). **This runs your workflow, which can change things**, so it's disabled in read-only mode.

- **Saved inputs**: **Save as…** keeps an input for this machine on this computer; pick one from the list to load it. **Delete** removes the saved copy only.
- **Start from a template…**: an empty object, an order, a list of items for a Map state, an S3 event or a schedule.
- **Name**: optional. AWS picks a unique one if you leave it empty. A Standard machine's execution names must be unique for 90 days.
- **Run**: the latest definition, a published version, or an alias (which may split executions between two versions).
- **Ctrl+Enter** starts it.

A Standard execution opens once it has started. An Express machine keeps no history to look up; its run appears in the machine's log group when logging is on.`,
  },
  "sfn.stop": {
    title: "Stop execution",
    body: `Stops a running execution; it ends as **aborted**. The error and cause are optional and are recorded on the execution. Work a Task already started (a Lambda call, a batch job) isn't undone.

A stopped Standard execution can be **redriven**: restarted from the state where it stopped, within 14 days.`,
  },
  "sfn.maprun": {
    title: "Map run",
    body: `A Distributed Map state runs each item (or batch of items) as a child execution. The map run shows the counts of items and child executions by status, its settings and its child executions. While it runs, the view checks again every 5 seconds.

- **Child executions**: filter by status; **Export…** saves them all; open one (Enter or double-click) to see its graph, input, output and history. Right-click to stop a running one.
- **Settings** (command bar, while the run is running): max concurrency and tolerated failures.
- **Open parent execution** goes back to the execution that started the run.

Without a Label on the Map state, AWS names the run with a generated id instead of the state's name. Express child workflows aren't kept by AWS, so they can't be listed; look in their log group.`,
  },
  "sfn.maprun.settings": {
    title: "Map run settings",
    body: `Change a running map run without redeploying:

- **Max concurrency**: how many child executions run at once (0 means no limit, up to 10,000).
- **Tolerated failures**: as a percentage of items, a number of items, or both. Once failures pass either, the run (and the Map state) fails. 0 for both fails it at the first failure.

Only this run changes; the next run uses the Map state's definition again.`,
  },
  "sfn.activities": {
    title: "Activities",
    body: `An activity is a Task that your own code does: a worker anywhere (a server, a container, a laptop) asks Step Functions for work with **GetActivityTask**, gets the input and a task token, and answers with **SendTaskSuccess** or **SendTaskFailure** (and **SendTaskHeartbeat** while it works). A Task state uses the activity by putting its ARN in Resource.

- **Details** (Enter): the ARN, encryption and tags, a Task state snippet, and AWS CLI commands for a worker (your profile and region filled in).
- **New activity**: a name (1 to 80 characters, no spaces or special characters).
- **Delete** (Del): asks first. State machines that use it fail at that Task from then on.

The list shows every activity in the region; the tree shows how many there are.`,
  },
  "sfn.create": {
    title: "New state machine",
    body: `Create a state machine from a template or your own definition.

- **Name**: 1 to 80 characters, no spaces or special characters; unique in the region.
- **Type**: **Standard** runs up to a year, exactly once, with a full execution history (kept 90 days). **Express** runs up to 5 minutes at high volume, at least once, and keeps no history: turn logging on to see its runs. The type can't be changed later.
- **Start from a template…**: a Pass state, a Lambda call with retry and catch, Choice and Wait, Parallel branches, or a Map over items. Edit the definition as you like; the graph and Step Functions' checks follow as you type.
- **Role, logging and tracing**: the execution role is required (the IAM role Step Functions assumes, allowed to call what your states use). A log group can be given by name.
- **Publish as a new version** publishes version 1 straight away.

Creating IAM roles isn't part of this app; use the console, the CLI or your infrastructure code.`,
  },
  "sfn.edit": {
    title: "Edit state machine",
    body: `Change the machine's definition and settings. Only what you change is sent.

- **Definition**: the Amazon States Language as JSON. The graph on the right redraws as you type (while the text is valid JSON). Step Functions checks the definition when you pause; problems are listed under the editor and outlined in red on the graph. Click a state's name in a problem to find it on the graph.
- **Role, logging and tracing**: the execution role (an IAM role ARN), the log level and log group (a name or ARN), whether logs include inputs and outputs, and X-Ray tracing. Logging needs the role to be allowed to deliver logs.
- **Publish as a new version**: saves and freezes the result as a numbered version (with an optional description), for aliases to point at.
- **Ctrl+Enter** saves.

If someone changes the machine while you edit (in the console, a deployment, another window), saving asks before writing over their changes. Running executions keep the definition they started with.`,
  },
  "sfn.machine": {
    title: "Definition",
    body: `The machine's definition (Amazon States Language). The states table lists every state, including the ones inside Parallel branches and Map item processors, with the next state, the resource a Task calls, and its comment. **Definition** shows the ASL itself as a tree or as text.

The header shows the type, status and query language (JSONPath or JSONata). **Copy ARN** copies the machine's ARN.`,
  },
  "sfn.executions": {
    title: "Executions",
    body: `A Standard machine's executions, newest first, one page at a time.

- **Status**: show only running, succeeded, failed, timed out, aborted or pending-redrive executions.
- **Open** an execution: Enter or double-click.
- **Page size**: 100, 500 or 1,000. Ctrl+PgUp / Ctrl+PgDn turn pages.
- **Export…**: every execution (with the status filter), not just the page, as JSON lines or CSV. Saving works in read-only mode.

- **Right-click** an execution to re-run it with the same input, stop it (running) or redrive it (failed, aborted or timed out).

Express machines don't keep executions that AWS can list. Their runs appear in the machine's log group (the Logs tab) when logging is on.`,
  },
  "sfn.configuration": {
    title: "Configuration",
    body: `The execution role, logging (level, whether execution data is included, log group), X-Ray tracing, encryption, revision and tags.`,
  },
  "sfn.versions": {
    title: "Versions and aliases",
    body: `A **version** freezes the definition and settings at the time it's published, with a number that never changes. An **alias** is a name (\`live\`, \`prod\`) that points at one version, or splits executions between two by weight, so callers don't change when you release.

- **Publish version…**: publishes the current definition. If the machine changed since this view loaded, AWS refuses; refresh first.
- **New alias…** / **Edit**: choose a version, and optionally a second one with its share (for a gradual rollout).
- **Delete** an alias (asks) or a version (you type its number). A version an alias uses can't be deleted; change the alias first.

Start an execution on a version or alias from **Start execution** (Run).`,
  },
  "sfn.alias": {
    title: "Alias",
    body: `An alias points at a published version. To roll out gradually, tick **Send part of the executions to a second version** and give its share (1 to 99%); the first version gets the rest. Clearing the tick sends everything to the first version again.

Names are 1 to 80 letters, digits, -, _ or ., and can't be only digits (that would look like a version number). A name can't be changed; create a new alias instead.`,
  },
  "sfn.logs": {
    title: "Machine logs",
    body: `The machine's log group, newest first for a time range. Express machines keep their execution history here only; Standard machines also log here when logging is on.

- **Filter pattern**: for example \`"ExecutionFailed"\` or \`{ $.type = "TaskFailed" }\`.
- **Follow**: checks for new events every few seconds.

If logging is off, the tab says so. Turn it on in the machine's settings (level ALL to see every step).`,
  },
  "sfn.execution": {
    title: "Execution",
    body: `One execution: status, start and stop times, the version or alias it ran, its input and output, and the error and cause when it failed. While it's running, the view checks again every 5 seconds.

**Map runs** (a tab, when the execution ran a distributed Map) lists each map run; in the graph, a distributed Map state's details link to its runs. A child execution of a map run links back to it from **Overview**.

Commands: **Re-run** starts a new execution with this one's input (and the version or alias it ran), **Stop** ends a running execution, **Redrive** restarts a failed, aborted or timed-out one from the state where it stopped (within 14 days; not for executions a Map Run started). All three are disabled in read-only mode.

**Event history** lists every event oldest first, a page at a time; **Export…** saves all of them as JSON lines (each event as AWS sent it) or CSV (id, time, type, state and the details as JSON). Select an event to see its details (state input and output, task parameters, errors). AWS leaves out input or output that's too large, and the view says so.`,
  },
};
