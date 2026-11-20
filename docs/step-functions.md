# Step Functions

AWS Step Functions state machines, their executions and activities. Open
**Step Functions** in the tree under your profile. It uses the region chosen
in the toolbar's **Region** list (remembered per profile).

What this view doesn't do (agreed scope): create IAM roles for your machines,
run single states (TestState), or show X-Ray traces and metric charts. Use
the AWS console, the CLI or your infrastructure code for those.

## State machines

The list shows **State machine, Type** (Standard or Express), **Status,
Logging, Tracing, Created** and **Description**, a page at a time: choose
100, 500 or 1,000 per page and step with First / Previous / Next (Ctrl+PgUp
/ Ctrl+PgDn). Every name is listed; the other columns are read for the page
on screen only. The tree lists the first 200 machines, under an
**Activities** node.

Type the start of a name in the **Filter** box and press **Enter**. Filters
are remembered per profile and region (the last 10).

Open a machine (Enter, double-click or click it in the tree). The header
shows its status, type, query language (JSONPath or JSONata) and **Copy
ARN**. The tabs: **Graph, Definition, Executions** (Standard machines),
**Configuration, Versions and aliases** and **Logs**.

## Graph

The definition drawn as a flow, top to bottom from **Start** to **End**.

- Choice rules are labelled with their condition, a Choice's default is
  dotted, Catch routes are red and dashed, and loops come back up on the
  right.
- **Parallel** and **Map** states are boxes that hold their branches; the
  − / + button in a box's corner collapses it, **Expand all** opens them all.
  A distributed Map is labelled as such.
- Drag to move, mouse wheel to zoom, **Fit** shows it all, **100%** is actual
  size. Click a state to see its definition on the right.
- **Export SVG…** saves the graph in the current theme's colours.
- Problems in the definition (a transition to a state that doesn't exist, no
  StartAt) are listed above the graph.

The **Definition** tab lists every state (nested ones with their path) with
its next state, resource and comment, and shows the ASL as a tree or text.

## Executions

Standard machines list their executions newest first, a page at a time, with
a **Status** filter. Each shows its start and stop time, duration, the
version or alias it ran and how often it was redriven. **Export…** saves
every execution (with the filter) as JSON lines or CSV.

Express machines keep no execution history that AWS can list: their runs are
in the machine's log group, on the **Logs** tab, when logging is on.

Right-click an execution to **Re-run with this input**, **Stop** it (while
it runs) or **Redrive** it (failed, aborted or timed out).

### An execution

Open an execution (Enter or double-click). While it runs, the view checks
again every 5 seconds. The tabs:

- **Graph**: the definition this execution ran with (an older version keeps
  its own graph), coloured by what happened: green succeeded, blue running,
  red failed, amber failed but caught (a Catch moved on), uncoloured didn't
  run. A state entered more than once shows ×n. Click a state for when it
  was entered and exited, how long it took, failed attempts (retries), the
  error and cause, and its input and output. The colours come from the event
  history; for very long histories only the first 25,000 events are read.
- **Overview**: status, times, version or alias, redrives and redrive
  status, input, output, and the error and cause when it failed.
- **Event history**: every event oldest first, a page at a time; select one
  for its details (inputs, outputs and parameters shown as trees).
  **Export…** saves them all as JSON lines (each event as AWS sent it) or CSV.
- **Map runs**, when the execution ran a distributed Map (below).

Commands: **Re-run** starts a new execution with this one's input on the
same version or alias, **Stop** ends a running one (with an optional error
and cause), **Redrive** restarts a failed, aborted or timed-out Standard
execution from the state where it stopped (within 14 days; states that
succeeded aren't run again).

## Start execution

**Start execution** in the command bar (or a machine's menu) asks for:

- **Input**: JSON, at most 256 KB, checked as you type. **Saved inputs**:
  **Save as…** keeps an input for this machine on this computer, per profile
  and region; pick one to load it. **Start from a template…**: an empty
  object, an order, a list of items for a Map state, an S3 event or a
  schedule.
- **Name**: optional (AWS picks one); 1 to 80 characters without spaces,
  `< > { } [ ] ? * " # % \ ^ | ~ $ & , ; : /` or the backtick. A Standard
  machine's execution names must be unique for 90 days.
- **Run**: the latest definition, a published version or an alias.

Ctrl+Enter starts it. A Standard execution opens once started; an Express
one shows only in its log group.

## Distributed Map runs

A distributed Map runs each item (or batch) as a child execution, grouped in
a **map run**. An execution's **Map runs** tab lists them; in the graph, the
Map state's details link to its runs.

A map run shows the counts of items and child executions by status, its
settings (max concurrency, tolerated failures), redrives and its child
executions (status filter, **Export…**). A child execution opens like any
other, with its own graph (the Map's item processor) and a link back to the
run. **Settings** (command bar, while the run is running) changes max
concurrency (0 = no limit) and the tolerated failures (percentage or count)
for this run only.

Without a **Label** on the Map state, AWS names its runs with a generated id
instead of the state's name. Express child workflows aren't kept by AWS and
can't be listed.

## Edit, create and delete

**Edit** (Ctrl+E) opens the definition beside a live graph that redraws as
you type (keeping the last valid one while the JSON doesn't parse). Step
Functions checks the definition when you pause; its problems are listed
under the editor and outlined in red on the graph. The app's own checks
(missing targets, no StartAt) must be fixed before saving. The second tab
has the **execution role**, **logging** (level, log group by name or ARN,
whether to include inputs and outputs) and **X-Ray tracing**. **Publish as a
new version** saves and publishes in one go. Only what you change is sent.

If the machine changed after the editor opened (the console, a deployment,
another window), saving asks before writing over those changes. Executions
already running keep the definition they started with.

**New state machine** (on the list) uses the same editor with a name, the
type (Standard: up to a year, full history; Express: up to 5 minutes, high
volume, logs only; can't be changed later) and five templates: a Pass state,
a Lambda call with retry and catch, Choice and Wait, Parallel branches, and
a Map over items. An execution role is required.

**Delete** (Del) asks you to type the name. Versions and aliases go with the
machine; its log group and role stay.

## Versions and aliases

A **version** freezes the definition and settings with a number that never
changes; an **alias** is a name that points at one version, or splits
executions between two by weight.

- **Publish version…**: with an optional description. If the machine
  changed since the view loaded, AWS refuses; refresh first.
- **New alias…** / **Edit**: a version, and optionally a second one with its
  share (1 to 99%) for a gradual rollout. Clearing the split sends
  everything to the first version again.
- **Delete** an alias (asks) or a version (type its number). A version an
  alias uses can't be deleted.

## Configuration and logs

**Configuration** shows the execution role, logging (level, execution data,
log group with **Open in CloudWatch Logs**), tracing, encryption, revision
and tags. **Logs** shows the machine's log group in the shared log viewer
(see [CloudWatch Logs](cloudwatch-logs.md)); level ALL logs every step.

## Activities

An activity is a Task your own code does: a worker anywhere polls with
**GetActivityTask**, gets the input and a task token, and answers with
**SendTaskSuccess** or **SendTaskFailure**. The **Activities** node lists
them; **Details** (Enter) shows the ARN, encryption, tags, a Task state that
uses it, and AWS CLI commands for a worker with your profile and region
filled in. **New activity** and **Delete** (Del, asks) are in the command bar.

## On this computer

Saved inputs are kept in `sfn-inputs.json` in the app's settings folder
(Windows: `%APPDATA%\dev.example.s3explorer\`), keyed by profile, region and
machine. Exports and SVGs go where you save them.

## Read-only mode

With the toolbar lock on (on whenever you connect), starting, stopping and
redriving executions, editing, creating and deleting machines, publishing,
aliases, map run settings and activities are disabled, and the app's backend
refuses them. Browsing, graphs, histories, logs, saved inputs and exports
still work.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Enter / double-click | Open machine, execution, map run or activity |
| Ctrl+E | Edit the machine |
| Del | Delete the machine or activity |
| Ctrl+Enter (Start / Edit dialogs) | Start / save |
| Ctrl+PgUp / Ctrl+PgDn | Previous / next page |
| F5 | Refresh |

## Permissions

The profile needs these IAM actions (scope `Resource` to your machines and
activities):

- Browse: `states:ListStateMachines`, `states:DescribeStateMachine`,
  `states:ListTagsForResource`, `states:ListExecutions`,
  `states:DescribeExecution`, `states:GetExecutionHistory`,
  `states:DescribeStateMachineForExecution`,
  `states:ListStateMachineVersions`, `states:ListStateMachineAliases`,
  `states:DescribeStateMachineAlias`, `states:ListMapRuns`,
  `states:DescribeMapRun`, `states:ListActivities`, `states:DescribeActivity`
- Edit checks: `states:ValidateStateMachineDefinition`
- Run: `states:StartExecution`, `states:StopExecution`,
  `states:RedriveExecution`
- Edit, create, delete: `states:UpdateStateMachine`,
  `states:CreateStateMachine`, `states:DeleteStateMachine`, and
  `iam:PassRole` on the execution role
- Versions and aliases: `states:PublishStateMachineVersion`,
  `states:DeleteStateMachineVersion`, `states:CreateStateMachineAlias`,
  `states:UpdateStateMachineAlias`, `states:DeleteStateMachineAlias`
- Map runs: `states:UpdateMapRun`
- Activities: `states:CreateActivity`, `states:DeleteActivity`
- Logs: as in [CloudWatch Logs](cloudwatch-logs.md); turning logging on also
  needs the log-delivery permissions (`logs:CreateLogDelivery` and related)
  for the execution role.

## Emulators

Works with [MiniStack](https://github.com/ministackorg/ministack), which runs
state machines (the app's emulator tests use it). Its event histories leave
out `previousEventId` and record a caught Parallel failure as a normal exit,
so the graph shows such a Parallel as succeeded there; it doesn't implement
RedriveExecution (the app says so), and its ValidateStateMachineDefinition
accepts anything (the app's own checks still apply).
