export const rdsTopics = {
  "rds.databases": {
    title: "RDS databases",
    body: `The region's clusters and instances, with role, engine, size, status and endpoint. A cluster's instances are listed under it, marked \`└\`, and stopped databases are dimmed. Neptune and DocumentDB aren't shown.

- **Databases / Snapshots**: switches the list. Snapshots covers the whole region, including those of deleted databases.
- **Filter**: type the start of a name and press Enter.
- **Commands and right-click**: Start, Stop, Reboot, Fail over, Modify (Ctrl+E) and Delete (Del).

Creating databases and editing parameter groups aren't part of this app. Use the AWS console for those.`,
  },
  "rds.details": {
    title: "Database details",
    body: `Engine, class or capacity, storage, availability, connectivity, the master user, parameter groups, replicas, backups, deletion protection, encryption, pending changes, pending maintenance and tags. A cluster also lists its instances; click one to open it. While a database is changing, the view checks again every 15 seconds.

| Action | What it does |
|---|---|
| **Start** | Starts a stopped database. |
| **Stop…** | AWS starts it again automatically after 7 days. Aurora clusters stop as a whole. |
| **Reboot…** | A Multi-AZ instance can **Reboot with failover**. |
| **Fail over…** | Aurora: makes a reader the writer. Connections drop for up to a minute. |
| **Modify…** (Ctrl+E) | Instance class, backup retention, deletion protection. |
| **Delete…** (Del) | You type the name to confirm. A final snapshot is on by default. |`,
  },
  "rds.connect": {
    title: "Connect",
    body: `Everything you need to reach this database from your own client. The app doesn't connect to databases directly.

- **Endpoints**, port, user and database, each with **Copy**. A cluster has separate writer and reader endpoints.
- **Password**: in Secrets Manager when RDS manages it (copy the ARN, then reveal it in the Secrets Manager view), otherwise not stored by AWS.
- **Reachability**: whether it's publicly accessible or reachable only from inside its VPC.
- **Client commands** and URLs for the engine, such as \`psql\`, \`mysql\`, \`sqlcmd\` and JDBC.
- **IAM authentication**: when on, the \`aws rds generate-db-auth-token\` command for a 15-minute token to use as the password.`,
  },
  "rds.sql": {
    title: "SQL",
    body: `Runs statements through the RDS Data API, so no network route to the database is needed. Only Aurora clusters with the Data API on get this tab.

- **Credentials**: a Secrets Manager secret with \`username\` and \`password\`. The app passes its ARN to the Data API and never reads the value.
- **Database**: defaults to the cluster's. **List databases** suggests others.
- **Run** (Ctrl+Enter) runs one statement at a time. With several, select one and it runs the selection.
- Results show in a grid. Click a row for **Copy row as JSON**, or use **Export CSV** / **Export JSON**.
- **History** keeps recent statements per profile and cluster.
- The Data API returns at most 1 MB per statement, so use \`LIMIT\` / \`OFFSET\` for big tables.

### Read-only runs

**Read only (rolled back)** is on by default. The statement runs in a transaction that's always rolled back, so nothing is kept.

- **PostgreSQL**: the transaction is also read only, so writes fail with an error.
- **MySQL**: only \`SELECT\`, \`SHOW\`, \`DESCRIBE\`, \`EXPLAIN\` and \`WITH\` are accepted.
- Transaction-control statements such as \`BEGIN\` and \`COMMIT\` are refused.

Clear it to change data: statements then **commit as soon as they run**. With the toolbar lock on, every run is a read-only run.`,
  },
  "rds.snapshots": {
    title: "Snapshots",
    body: `Newest first, with the type, status, size and engine. Use **All / Manual / Automated** to narrow the list.

- **Create snapshot** (on a database): manual, and kept until you delete it. For an Aurora cluster, snapshots belong to the cluster.
- **Copy…**: makes a new manual snapshot. This is how to keep an automated snapshot past its retention period.
- **Delete…**: manual snapshots only, and you type the name to confirm.
- **Restore to a new database…**: creates a new database from the snapshot.
- **Restore to point in time** (on a database): a new database from a time within the backup retention period.

A restore never changes the original database.`,
  },
  "rds.events": {
    title: "Events and logs",
    body: `**Events** are what RDS reported about the database: backups, restarts, failovers, configuration changes. Choose the last hour, day, 7 days or 14 days (RDS keeps 14 days). A cluster's events include its instances'.

**Log files** are the database's logs, newest first. Logs belong to instances, so for a cluster choose the instance first.

- Click a file to see its last 100 to 10,000 lines, scrolled to the newest.
- **Copy** copies those lines.
- **Download** saves the whole file. It works in read-only mode, and a partial file is removed if it fails.`,
  },
  "rds.modify": {
    title: "Modify database",
    body: `- **Instance class** (instances): changing it restarts the database. Common classes are suggested, and you can type any class.
- **Backup retention**: 1 to 35 days for clusters, 0 to 35 for instances. 0 turns automated backups off.
- **Deletion protection**: while on, the database can't be deleted.

A cluster's instances take their backup and deletion protection settings from the cluster.

Choose **In the next maintenance window**, or **Now** to apply straight away.`,
  },
  "rds.delete": {
    title: "Delete database",
    body: `You type the database's name to confirm.

- **Take a final snapshot**: on by default. It's the only way to get the data back. Aurora cluster instances don't take one, because the cluster keeps the data.
- **Also delete automated backups** (instances): otherwise they're kept for their retention period.

A cluster can only be deleted once it has no instances. A database with deletion protection on must have it turned off first, using Modify.`,
  },
  "rds.failover": {
    title: "Fail over",
    body: `Makes a reader the cluster's new writer. Choose the reader, or let Aurora choose.

Connections drop for up to a minute while it happens. Applications should use the cluster's writer endpoint, which follows the new writer.`,
  },
  "rds.restore": {
    title: "Restore",
    body: `Creates a **new** database. The original is never changed.

- **Name**: for the new database.
- **Instance class** or **Serverless v2 capacity**: optional.
- **Time** (point in time only): the latest restorable time, or one you choose within the backup retention period.

When the source database still exists, the new one gets its subnet group, security groups and public access setting. Restoring an Aurora cluster also creates its first instance, \`<name>-1\`.`,
  },
};
