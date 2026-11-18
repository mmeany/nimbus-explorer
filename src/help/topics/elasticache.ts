export const elasticacheTopics = {
  "elasticache.caches": {
    title: "ElastiCache caches",
    body: `The region's Valkey and Redis OSS caches: replication groups (with their shards and nodes) and serverless caches. Memcached clusters aren't shown.

- **Type**: *cluster mode off* (one shard: a primary and its replicas), *cluster mode on* (data split over several shards) or *serverless* (no nodes to manage; scales by itself).
- **Filter**: type the start of a name and press Enter.
- **Open** a cache: Enter or double-click. In the tree, a replication group expands to its nodes (grouped by shard when cluster mode is on); the filled node is the primary.

The app manages caches through the ElastiCache API only; it doesn't connect to a cache or read its keys.`,
  },
  "elasticache.group": {
    title: "Replication group",
    body: `A Valkey or Redis OSS replication group: engine and version, node type, shards and nodes, endpoints, failover and Multi-AZ, encryption in transit and at rest, AUTH token or RBAC user groups, network, parameter group, maintenance window, backups, log delivery and tags. While its status is changing, the view checks again every 15 seconds.

- **Shards and nodes**: each node's role (primary or replica), availability zone and endpoint. With cluster mode off, write to the primary endpoint and read from the reader endpoint; with cluster mode on, clients use the configuration endpoint.
- **Reboot selected…** (cluster mode off): tick nodes and reboot them. Each comes back empty and copies the data again from the primary; rebooting the primary stops writes for a while and can lose recent data, so test a failover first.
- **Test failover…**: promotes a replica (of the group, or of one shard in cluster mode) as if the primary had failed. Needs automatic failover and a replica; AWS limits how many you can run per day.
- **Changes waiting to apply** are listed under the header (they wait for the maintenance window, or are in progress).`,
  },
  "elasticache.connect": {
    title: "Connect",
    body: `How to reach the cache from your own machine or code. The app itself doesn't connect to caches.

- **Endpoints**: the one to start from (configuration endpoint in cluster mode, else the primary; a serverless cache's endpoint) and the others, each with **Copy**.
- **Connection**: whether TLS is required, how clients authenticate (none, one AUTH token, or RBAC users) and whether clients must be cluster-aware.
- **From the command line**: a valkey-cli / redis-cli line with --tls, -c and --user / --askpass as needed. Passwords and AUTH tokens are never shown: AWS doesn't return them, and --askpass keeps them out of your shell history.
- **From code**: a URI for client libraries, without the password.
- **Reaching it**: ElastiCache endpoints are private to their VPC. Connect from inside it, over a VPN, or through a Session Manager port-forwarding tunnel (command included; in cluster mode a single tunnel isn't enough, because nodes redirect clients to their own addresses).`,
  },
  "elasticache.snapshots": {
    title: "Snapshots",
    body: `Backups of replication groups and serverless caches: the region's under **Snapshots** in the tree, one cache's on its **Snapshots** tab. *Automated* snapshots are taken daily when backups are on and expire after the retention period; *manual* ones stay until you delete them.

- **Create snapshot…** (on a cache's tab): a manual snapshot now. Taking one can slow the cache a little while it runs.
- **Restore…** (or Enter): a new cache with the snapshot's data (see the restore dialog's help).
- **Copy…**: a manual copy (an automated snapshot copied this way doesn't expire).
- **Delete…**: manual snapshots only; you type the name to confirm.

While snapshots are being created, copied or deleted, the list checks again every 15 seconds.`,
  },
  "elasticache.restore": {
    title: "Restore snapshot",
    body: `Creates a new cache from the snapshot; the original isn't touched.

- **New cache name**: 1 to 40 letters, digits and single hyphens, starting with a letter.
- **Node type** and **replicas per shard** (replication groups): the snapshot's node type unless you change it (it must hold the data); with one or more replicas, automatic failover is turned on. Cluster-mode snapshots keep their number of shards.
- Network settings (subnet group or subnets, security groups) and encryption in transit are copied from the cache the snapshot came from, if it still exists; otherwise AWS's defaults apply.

The new cache has its own endpoint, and is billed from when it's created.`,
  },
  "elasticache.serverless": {
    title: "Serverless cache",
    body: `A serverless Valkey or Redis OSS cache: endpoint and reader endpoint, usage limits (data storage and ECPUs per second; none means it scales as needed), encryption (always in transit), RBAC user group, network, backups and tags.`,
  },
};
