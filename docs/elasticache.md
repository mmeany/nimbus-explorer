# ElastiCache

Amazon ElastiCache for Valkey and Redis OSS: replication groups and
serverless caches. Open **ElastiCache** in the tree under your profile. It
uses the region chosen in the toolbar's **Region** list (remembered per
profile).

What this view doesn't do (agreed scope): Memcached clusters (not listed),
global datastores (shown as a field only), creating, modifying or scaling
caches, changing users or parameters, reading keys or values (the app never
connects to a cache), and metric charts. Use the AWS console, the CLI or
your infrastructure code for those.

## Caches

The list shows every replication group and serverless cache in the region:
**Cache, Type** (cluster mode off, cluster mode on, or serverless),
**Engine, Node type / limits, Shards, Nodes, Status, Encryption, Endpoint**
and **Description**, a page at a time (100, 500 or 1,000; Ctrl+PgUp /
Ctrl+PgDn). Type the start of a name in the **Filter** box and press
**Enter**; filters are remembered per profile and region (the last 10).

In the tree, a replication group expands to its nodes, grouped by shard
when cluster mode is on; the primary's icon is filled. **Snapshots** and
**Users and groups** sit at the top of the branch. The tree lists the first
200 caches.

Right-click a cache to **Copy** its name, endpoint or ARN, or **Add
bookmark…**.

## A replication group

Open one (Enter, double-click or the tree). While its status is changing,
the view checks again every 15 seconds. Changes waiting to apply are listed
under the header. The tabs:

- **Details**: engine and version, node type, shards and nodes, the
  configuration endpoint (cluster mode) or primary and reader endpoints,
  automatic failover, Multi-AZ, data tiering, encryption in transit and at
  rest, AUTH token or RBAC user groups, subnet and security groups, network
  type, parameter group, maintenance window, backups, log delivery, global
  datastore membership and tags.
- **Shards and nodes**: each node's role, availability zone and endpoint.
- **Connect**, **Snapshots**, **Events**, **Parameters** and **Updates**
  (below).

### Reboot and test failover

On **Shards and nodes**:

- **Reboot selected…** (cluster mode off only): tick nodes and reboot them.
  Each comes back empty and copies the data again from the primary;
  rebooting the primary stops writes for a while and can lose recent data,
  which the confirmation points out.
- **Test failover…** (the group, or each shard in cluster mode): promotes a
  replica as if the primary had failed. It needs automatic failover and a
  replica; AWS limits how many tests you can run per day.

## A serverless cache

Endpoint and reader endpoint, usage limits (data storage and ECPUs per
second; none means it scales as needed), encryption (always in transit),
RBAC user group, security groups, subnets, backups and tags, with the
**Connect**, **Snapshots** and **Events** tabs.

## Connect

How to reach the cache from your machine or code:

- **Endpoints**, each with **Copy**.
- Whether **TLS** is required, how clients **authenticate** (none, one AUTH
  token, or RBAC users) and whether they must be **cluster-aware**
  (serverless caches and cluster-mode groups).
- A `valkey-cli` / `redis-cli` line with `--tls`, `-c` and `--user <username>
  --askpass` as needed, and a `redis://` / `rediss://` URI for client
  libraries. Passwords and AUTH tokens are never shown: AWS doesn't return
  them, and `--askpass` keeps them out of your shell history.
- **Reaching it**: ElastiCache endpoints are private to their VPC. Connect
  from inside it, over a VPN, or through a Session Manager port-forwarding
  tunnel; the command is included, with the matching localhost command
  (`--sni` when TLS is on). In cluster mode a single tunnel isn't enough,
  because nodes redirect clients to their own addresses.

## Snapshots

The region's snapshots under **Snapshots** in the tree, one cache's on its
**Snapshots** tab: name, cache, cache type, manual or automated, status,
created, size, engine and node type, newest first. While any is changing,
the list checks again every 15 seconds.

- **Create snapshot…** (a cache's tab): a manual snapshot now.
- **Restore…** (or Enter): a new cache from the snapshot. For replication
  groups, choose the node type and replicas per shard (automatic failover is
  on with replicas; cluster-mode snapshots keep their shards). Network
  settings and encryption in transit are copied from the original cache if
  it still exists. The new cache opens once created.
- **Copy…**: an automated snapshot copied this way becomes a manual one that
  doesn't expire.
- **Delete…**: manual snapshots only; you type the name to confirm.
  Automated ones expire after the retention period.

## Events

What happened to the cache, newest first, for the last hour up to the last
14 days (remembered; AWS keeps events for 14 days). For a replication group
the list includes its nodes' events too; **Source** says which.

## Parameters

The parameter group a replication group's nodes use and its parameters,
read only: value, whether it's changed from the default, when a change
takes effect (immediately or after a reboot), modifiable, type, allowed
values and description. **Only values changed from the default**
(remembered) and a search box narrow the list. Parameters whose value
depends on the node type show this group's value; select one for every
node type's. Serverless caches have no parameter groups.

## Updates

Service updates (engine and security patches) for a replication group, most
urgent first: severity, this cache's status, the recommended apply-by date
(overdue in red), release date and nodes updated. Completed and
not-applicable updates are hidden unless ticked. **Apply now…** starts an
update instead of waiting for the maintenance window; nodes are updated one
at a time, and the confirmation says whether the cache stays available
(it does when every shard has a replica). While an update runs, the list
checks again every 30 seconds.

## Users and groups

Role-based access control, view only. **Users**: ID, user name, status,
engine, authentication (passwords, IAM or none), access string (ACL rules
such as `on ~app:* +@read`) and groups. **User groups**: members, the caches
that use the group and changes in progress; select one to see its members'
access strings and open its caches.

## Read-only mode

With the toolbar lock on (on whenever you connect), rebooting, testing
failover, creating, copying, deleting and restoring snapshots, and applying
updates are disabled, and the app's backend refuses them. Everything else
is reading.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Enter / double-click | Open a cache; restore a snapshot |
| Ctrl+PgUp / Ctrl+PgDn | Previous / next page |
| F5 | Refresh |

## Permissions

The profile needs these IAM actions (scope `Resource` to your caches where
you can):

- Browse: `elasticache:DescribeReplicationGroups`,
  `elasticache:DescribeServerlessCaches`, `elasticache:DescribeCacheClusters`,
  `elasticache:ListTagsForResource`
- Events, parameters, users: `elasticache:DescribeEvents`,
  `elasticache:DescribeCacheParameterGroups`,
  `elasticache:DescribeCacheParameters`, `elasticache:DescribeUsers`,
  `elasticache:DescribeUserGroups`
- Snapshots: `elasticache:DescribeSnapshots`, `elasticache:CreateSnapshot`,
  `elasticache:CopySnapshot`, `elasticache:DeleteSnapshot`,
  `elasticache:DescribeServerlessCacheSnapshots`,
  `elasticache:CreateServerlessCacheSnapshot`,
  `elasticache:CopyServerlessCacheSnapshot`,
  `elasticache:DeleteServerlessCacheSnapshot`
- Restore: `elasticache:CreateReplicationGroup`,
  `elasticache:CreateServerlessCache` (plus the EC2 permissions ElastiCache
  needs for the network)
- Actions: `elasticache:RebootCacheCluster`, `elasticache:TestFailover`
- Updates: `elasticache:DescribeUpdateActions`,
  `elasticache:BatchApplyUpdateAction`

## Emulators

Works with [MiniStack](https://github.com/ministackorg/ministack), which runs
real Valkey / Redis containers for its caches (the app's emulator tests use
it). It doesn't implement TestFailover, CopySnapshot, serverless snapshots
or service updates; the app says so instead of failing. It sends some
dates in a form the AWS SDK can't read, which the app rewrites, for custom
endpoints only, before parsing.
