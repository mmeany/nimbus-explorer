# ECS

Amazon Elastic Container Service: clusters, services, tasks and task
definitions. Open **ECS** in the tree under your profile. It uses the region
chosen in the toolbar's **Region** list (remembered per profile).

What this view doesn't do (agreed scope): create clusters or services (their
networking and permissions are a job for the console or your infrastructure
code), show metric charts, or host an interactive shell (ECS Exec needs AWS's
Session Manager plugin, so the app gives you the command to run instead).

The ECS root switches between **Clusters** and **Task definitions**. In the
tree, each cluster expands to its services, and **Task definitions** sits
underneath.

## Clusters

The list shows **Cluster, Status, Services, Running tasks, Pending,
Instances** (EC2 container instances), **Capacity providers** and **Container
Insights**. Type the start of a name in the **Filter** box and press
**Enter** (remembered per profile and region).

Open a cluster for two tabs:

- **Services**: **Service, Status, Running / desired, Pending, Deployment**
  (in progress / completed / failed), **Task definition, Runs on** and
  **Created**. Every service name loads; details are fetched for the page on
  screen (100, 500 or 1,000 per page).
- **Tasks**: **Running** or recently **Stopped** (ECS keeps stopped tasks for
  about an hour), newest first, with the task definition, status, health,
  what started it, start time, private IP, where it runs and, for stopped
  tasks, the reason.

## Services

A service shows its status, a pill while a deployment is in progress (the
view checks again every 10 seconds until it settles), and its desired,
running and pending counts. The tabs:

- **Details**: task definition, launch type or capacity strategy, platform
  version, scheduling, deployment settings (minimum healthy / maximum
  percent), circuit breaker and rollback, health check grace period, ECS
  Exec, load balancing (target group, container, port), network (subnets,
  security groups, public IP), service discovery and tags.
- **Deployments and events**: each deployment (primary / being replaced) with
  its counts and rollout state, and the service's events, newest first.
- **Tasks**: the service's running or recently stopped tasks.
- **Logs**: the logs of every task of the service (see below).

## Tasks

A task shows its status (and where it's heading), health and where it runs.
A stopped task shows why it stopped. The tabs:

- **Details**: task definition, the service that started it (click to open
  it), CPU / memory, private IP, zone, platform version, times, stop code,
  ECS Exec, and each container's status, health, image, exit code and reason
  (for example "OutOfMemoryError").
- **Logs**: each container's own log stream.
- **Shell (ECS Exec)**: the `aws ecs execute-command` line for each
  container, with the cluster, task, region and profile filled in, to paste
  into a terminal. If ECS Exec is off for the task, it shows the command that
  turns it on for the service.

## Actions

Service commands act on the open service, or on the one selected in a
cluster's Services tab (also in the right-click menu):

| Action | What it does |
|---|---|
| **Scale** | Sets the desired number of tasks (0 stops them all; the service stays, ready to scale up again). |
| **Redeploy** | Forces a new deployment: fresh tasks with the same task definition (to pick up a new image pushed to the same tag, or new secret values). |
| **Change revision** | Deploys another revision of the task definition (any family), or rolls back to an older one. ECS replaces the tasks gradually, following the service's deployment settings. |
| **Stop task** | Stops a task (from the task view, or a task list's right-click menu), with an optional reason. A service starts a replacement. |
| **Run task** | (Cluster view) Starts one-off tasks (see below). |

### Running a task

**Run task** starts 1 to 10 tasks that aren't part of a service; they run
until their essential containers exit, or until you stop them.

- **Copy settings from** a service fills in its task definition family,
  where it runs, and its subnets, security groups and public IP setting.
- **Task definition**: family and revision (latest first).
- **Run on**: the cluster's default capacity strategy, a capacity provider,
  Fargate or EC2. Fargate needs at least one subnet.
- **Assign a public IP**, **Enable ECS Exec**.
- **Overrides**: a container's **command** (quotes work as in a shell, for
  example `sh -c "echo hi"`) and extra **environment** variables
  (`NAME=value`, one per line).

With one task, the app opens it; with several, it shows the cluster's tasks.

## Task definitions

The list shows the **Active** families (with at least one active revision),
or the **Inactive** ones (every revision deregistered). Type the start of a
family name and press **Enter** to filter.

Open a family and choose a revision (newest first; deregistered ones are
marked). The tabs:

- **Details**: status, launch types, CPU / memory, network mode, platform,
  task and execution roles, volumes, when and by whom it was registered,
  and each container: image, CPU, memory, ports, command, entry point,
  health check, dependencies, logs, environment variables, and secrets,
  which show only where their value comes from (a Secrets Manager or
  Parameter Store ARN), never the value.
- **JSON**: the task definition as AWS returns it.
- **Compare**: the differences between this revision and another one (the
  fields AWS sets itself, like the revision number, are left out).

**New revision…** opens the revision's JSON (ready to register: the fields
AWS sets are removed, tags are kept). Edit it (for example the image tag,
CPU / memory or environment) and register it as the family's next revision.
The JSON is sent to AWS exactly as edited, so settings the app doesn't know
about are kept. Services keep running their current revision until you
deploy the new one with **Change revision**.

**Deregister…** (type the revision to confirm) stops new tasks and
deployments from using a revision. Tasks and services already using it keep
running. It can't be made active again.

## Logs

Logs come from each container's `awslogs` settings in the task definition:
its log group and stream prefix (ECS names streams
`prefix/container/task-id`). Choose the container; the shared log viewer
then shows newest first for a time range, with filter patterns, **Load
older**, **Follow** and **Download…** (see
[CloudWatch Logs](cloudwatch-logs.md)).

If a container logs with another driver (for example FireLens), has no
stream prefix, or logs to another region, the Logs tab says so.

## Read-only mode

With the toolbar lock on (on whenever you
connect), scale, redeploy, change revision, stop and run tasks, new task
definition revisions and deregistering are disabled, and the app's backend
refuses them. Browsing, logs and the ECS Exec commands still work.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Enter / double-click | Open cluster, service, task or family |
| Ctrl+PgUp / Ctrl+PgDn | Previous / next page |
| F5 | Refresh |

## Permissions

The profile needs these IAM actions:

- Browse: `ecs:ListClusters`, `ecs:DescribeClusters`, `ecs:ListServices`,
  `ecs:DescribeServices`, `ecs:ListTasks`, `ecs:DescribeTasks`,
  `ecs:ListTaskDefinitionFamilies`, `ecs:ListTaskDefinitions`,
  `ecs:DescribeTaskDefinition`
- Actions: `ecs:UpdateService`, `ecs:StopTask`, `ecs:RunTask` (and
  `iam:PassRole` on the task and execution roles), `ecs:TagResource` when
  tasks are tagged
- Task definitions: `ecs:RegisterTaskDefinition` (with `iam:PassRole` on its
  roles), `ecs:DeregisterTaskDefinition`
- Logs: as in [CloudWatch Logs](cloudwatch-logs.md)
- ECS Exec (in your terminal): `ecs:ExecuteCommand`, and the task role needs
  `ssmmessages:CreateControlChannel`, `ssmmessages:CreateDataChannel`,
  `ssmmessages:OpenControlChannel` and `ssmmessages:OpenDataChannel`
