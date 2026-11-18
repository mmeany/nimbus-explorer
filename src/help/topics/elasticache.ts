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
- **Changes waiting to apply** are listed under the header (they wait for the maintenance window, or are in progress).`,
  },
  "elasticache.serverless": {
    title: "Serverless cache",
    body: `A serverless Valkey or Redis OSS cache: endpoint and reader endpoint, usage limits (data storage and ECPUs per second; none means it scales as needed), encryption (always in transit), RBAC user group, network, backups and tags.`,
  },
};
