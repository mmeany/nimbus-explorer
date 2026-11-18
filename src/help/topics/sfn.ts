export const sfnTopics = {
  "sfn.machines": {
    title: "State machines",
    body: `The region's state machines, with type (Standard or Express), status, logging level, tracing, created date and description. The tree lists the first 200. Details are read for the page on screen only.

- **Filter**: type the start of a name and press Enter.
- **Open** a machine: Enter or double-click.`,
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

**Event history** lists every event oldest first, a page at a time. Select an event to see its details (state input and output, task parameters, errors). AWS leaves out input or output that's too large, and the view says so.`,
  },
};
