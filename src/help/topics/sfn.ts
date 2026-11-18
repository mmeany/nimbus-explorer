export const sfnTopics = {
  "sfn.machines": {
    title: "State machines",
    body: `The region's state machines, with type (Standard or Express), status, logging level, tracing, created date and description. The tree lists the first 200. Details are read for the page on screen only.

- **Filter**: type the start of a name and press Enter.
- **Open** a machine: Enter or double-click.`,
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

- **Child executions**: filter by status; open one (Enter or double-click) to see its graph, input, output and history. Right-click to stop a running one.
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

- **Right-click** an execution to re-run it with the same input, stop it (running) or redrive it (failed, aborted or timed out).

Express machines don't keep executions that AWS can list. Their runs appear in the machine's log group (the Logs tab) when logging is on.`,
  },
  "sfn.configuration": {
    title: "Configuration",
    body: `The execution role, logging (level, whether execution data is included, log group), X-Ray tracing, encryption, revision and tags.`,
  },
  "sfn.versions": {
    title: "Versions and aliases",
    body: `Published versions (newest first) and aliases. An alias can split executions between two versions by weight. The table shows each alias's routing.`,
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

**Event history** lists every event oldest first, a page at a time. Select an event to see its details (state input and output, task parameters, errors). AWS leaves out input or output that's too large, and the view says so.`,
  },
};
