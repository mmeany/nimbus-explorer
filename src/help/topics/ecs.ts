const LOGS_NOTE = `Logs come from each container's \`awslogs\` settings in the task definition. Containers using another driver (such as FireLens), with no stream prefix, or logging to another region get an explanation instead.

The viewer shows newest first for a time range, with filter patterns, **Load older**, **Follow** and **Download…**.`;

export const ecsTopics = {
  "ecs.clusters": {
    title: "ECS clusters",
    body: `The region's clusters, with their services, running and pending tasks, EC2 instances, capacity providers and Container Insights setting.

- **Clusters / Task definitions**: switches the view.
- **Filter**: type the start of a name and press Enter.
- **Open** a cluster: Enter or double-click. In the tree, a cluster expands to its services.

Creating clusters and services isn't part of this app. Their networking and permissions are a job for the console or your infrastructure code.`,
  },
  "ecs.cluster.services": {
    title: "Cluster services",
    body: `The cluster's services, with status, running and desired counts, deployment state, task definition and where they run. Details are fetched for the page on screen.

Select a service to use these commands, which are also in its right-click menu:

- **Scale**: sets the desired number of tasks. 0 stops them all, and the service stays ready to scale up again.
- **Redeploy**: fresh tasks with the same task definition, to pick up a new image on the same tag or new secret values.
- **Change revision**: deploys another task definition revision, or rolls back to an older one.

**Run task** starts one-off tasks that aren't part of a service.`,
  },
  "ecs.cluster.tasks": {
    title: "Cluster tasks",
    body: `Choose **Running** or recently **Stopped** tasks, newest first. ECS keeps stopped tasks for about an hour. Stopped tasks show the reason they stopped.

- **Open** a task: Enter or double-click.
- **Right-click** to stop a task. If a service started it, the service starts a replacement.
- **Run task** starts one-off tasks.`,
  },
  "ecs.service.details": {
    title: "Service details",
    body: `Task definition, launch type or capacity strategy, deployment settings, circuit breaker, ECS Exec, load balancing, network, service discovery and tags. While a deployment runs, the view checks again every 10 seconds.

- **Scale**: sets the desired number of tasks.
- **Redeploy**: forces fresh tasks with the same task definition.
- **Change revision**: deploys another revision, or rolls back.

**Minimum healthy** and **maximum percent** control how many tasks ECS keeps running while it replaces them.`,
  },
  "ecs.service.deployments": {
    title: "Deployments and events",
    body: `**Deployments**: each one, primary or being replaced, with its counts and rollout state. A failed rollout shows its reason above the tabs.

**Events**: what ECS reports about the service, newest first. This is the first place to look when tasks won't start or a deployment is stuck. Placement failures and failed health checks show up here.`,
  },
  "ecs.service.tasks": {
    title: "Service tasks",
    body: `This service's **Running** or recently **Stopped** tasks. ECS keeps stopped tasks for about an hour.

Open a task for its containers and stop reason. A task that keeps stopping usually says why here: look at the stop reason, then the container's exit code and logs.

Stopping a task from here makes the service start a replacement.`,
  },
  "ecs.service.logs": {
    title: "Service logs",
    body: `Logs from every task of this service, for the container you choose.

${LOGS_NOTE}`,
  },
  "ecs.task.details": {
    title: "Task details",
    body: `The task's definition, the service that started it (click to open it), CPU and memory, private IP, zone, times and stop code. Each container shows its status, health, image, exit code and reason, such as "OutOfMemoryError". A stopped task shows why it stopped above the tabs.

**Stop task** stops it, with an optional reason. If a service started it, the service starts a replacement.`,
  },
  "ecs.task.logs": {
    title: "Task logs",
    body: `The log stream of the container you choose, for this task only.

${LOGS_NOTE}`,
  },
  "ecs.task.exec": {
    title: "Shell (ECS Exec)",
    body: `The \`aws ecs execute-command\` line for each container, with the cluster, task, region and profile filled in. Paste it into a terminal.

It needs the AWS CLI and AWS's Session Manager plugin on your computer, which is why the app gives you the command and doesn't open a shell itself.

If ECS Exec is off for this task, you'll see the command that turns it on for the service. Tasks started after that can use it.`,
  },
  "ecs.taskdefs": {
    title: "Task definitions",
    body: `Task definition families. **Active** have at least one active revision, and **Inactive** have every revision deregistered.

Type the start of a family name and press Enter to filter. Open a family to see its revisions.`,
  },
  "ecs.family.details": {
    title: "Task definition details",
    body: `Choose a revision, newest first; deregistered ones are marked. You'll see its roles, network mode, CPU and memory, platform, volumes, and each container's image, ports, command, health check, logs and environment. Secrets show only where their value comes from, never the value.

- **New revision…**: opens this revision's JSON, ready to edit and register as the family's next revision.
- **Deregister…**: you type the revision to confirm. New tasks and deployments can't use it, but those already using it keep running. It can't be made active again.`,
  },
  "ecs.family.json": {
    title: "Task definition JSON",
    body: `The task definition exactly as AWS returns it.

**New revision…** starts from this with the fields AWS sets removed and tags kept. Editing is done there, not here.`,
  },
  "ecs.family.compare": {
    title: "Compare revisions",
    body: `The differences between this revision and another one you choose. Fields AWS sets itself, such as the revision number, are left out, so you only see real changes.`,
  },
  "ecs.revision": {
    title: "Change revision",
    body: `Deploys another revision of a task definition to this service. Choose any family, then a revision, newest first. Older revisions are labelled as a roll back.

ECS replaces the tasks gradually, following the service's deployment settings. You can follow progress on the **Deployments and events** tab.`,
  },
  "ecs.runTask": {
    title: "Run task",
    body: `Starts 1 to 10 tasks that aren't part of a service. They run until their essential containers exit, or until you stop them.

- **Copy settings from**: fills in a service's family, where it runs, its subnets, security groups and public IP setting.
- **Task definition**: family and revision, latest first.
- **Run on**: the cluster's default, a capacity provider, Fargate or EC2. Fargate needs at least one subnet.
- **Assign a public IP**, **Enable ECS Exec**.
- **Command override**: quotes work as in a shell, for example \`sh -c "echo hi"\`.
- **Environment overrides**: \`NAME=value\`, one per line.

With one task, the app opens it. With several, it shows the cluster's tasks. If ECS can't start any, the reason is shown as an error.`,
  },
  "ecs.newRevision": {
    title: "New revision",
    body: `This revision's JSON, ready to register: fields AWS sets are removed, and tags are kept. Edit it, for example the image tag, CPU, memory or environment, and register it as the family's next revision.

The JSON goes to AWS exactly as edited, so settings the app doesn't know about are kept. Pasting the output of \`describe-task-definition\` works too.

Services keep running their current revision until you deploy the new one with **Change revision**.`,
  },
};
