# RDS

Amazon RDS databases: DB instances, Aurora clusters and Multi-AZ DB clusters.
Open **RDS** in the tree under your profile. It uses the region chosen in the
toolbar's **Region** list (remembered per profile). Neptune and DocumentDB
clusters, which share the RDS API, aren't shown.

What this view doesn't do (agreed scope): create new databases, edit
parameter groups, or show CloudWatch charts. Use the AWS console for those.

## Databases

The RDS node lists the region's clusters and instances in the tree and in the
main list: **Name, Role** (Aurora cluster / Multi-AZ cluster, Writer /
Reader for a cluster's instances, Instance, Read replica), **Engine, Size**
(instance class, Serverless v2 capacity or storage), **Status** and
**Endpoint**. A cluster's instances are listed under it, marked `└`.
Stopped databases are dimmed.

Switch the main list between **Databases** and **Snapshots** (every snapshot
in the region; see below).

Type the start of a database name in the **Filter** box and press **Enter**.
Filters are remembered per profile and region (the last 10): open the ▾ list
to reuse one, remove one with its ✕, or clear the history.

### Database view

Open a database (Enter, double-click or click it in the tree). The header
shows its status, kind and **Copy ARN**; while the database is changing
(starting, modifying, backing up…) the view checks again every 15 seconds.
The tabs:

- **Details**: engine, class or capacity, storage, availability (Multi-AZ,
  zones), connectivity (endpoint, public access, VPC, subnet group, security
  groups), the master user and whether its password is managed in Secrets
  Manager, parameter and option groups, read replicas, backups (retention,
  window, restorable-to time), deletion protection, encryption, pending
  changes, pending maintenance and tags. A cluster also lists its instances
  (writer and readers; click one to open it) and whether the Data API is on.
- **Connect**: how to reach the database (below).
- **SQL**: run SQL (Aurora clusters with the Data API on only; below).
- **Snapshots**: this database's snapshots (below).
- **Events & logs**: recent events and log files (below).

## Start, stop, reboot, fail over

On the command bar, the database view and the right-click menu:

| Action | What it does |
|---|---|
| **Start** | Starts a stopped database. |
| **Stop…** | Stops it after asking. AWS starts it again automatically after 7 days. Aurora clusters stop as a whole; their instances can't be stopped one by one. |
| **Reboot…** | Restarts it after asking. A Multi-AZ instance can **Reboot with failover** (the standby takes over). |
| **Fail over…** | Aurora clusters: make a reader the writer (choose one, or let Aurora choose). Connections drop for up to a minute. |

## Modify

**Modify…** (Ctrl+E) changes:

- **Instance class** (instances; changing it restarts the database). Common
  classes are suggested; any class can be typed.
- **Backup retention** (1 to 35 days for clusters, 0 to 35 for instances;
  0 turns automated backups off).
- **Deletion protection**.

Backups and deletion protection of a cluster's instances are set on the
cluster. Choose **In the next maintenance window** or **Now**.

## Delete

**Delete…** (Del) asks you to type the database's name. Options:

- **Take a final snapshot** (on by default; the name is filled in for you).
  It's the only way to get the data back. Aurora cluster instances don't take
  one: the cluster keeps the data.
- **Also delete automated backups** (instances; otherwise they're kept for
  their retention period).

A cluster can only be deleted once it has no instances, and a database with
deletion protection on must have it turned off first (Modify).

## Snapshots

The **Snapshots** tab of a database, and the **Snapshots** list at the RDS
root, show **Snapshot, Database, Type** (manual / automated), **Created,
Status** (with progress while it's being created), **Size** and **Engine**.
Filter by **All / Manual / Automated**. Snapshots are shown newest first, a
page at a time (100, 500 or 1,000 per page; Ctrl+PgUp / Ctrl+PgDn).

- **Create snapshot** (database tab): a manual snapshot, kept until you
  delete it. For an Aurora cluster, snapshots belong to the cluster.
- **Copy…**: copies a snapshot (with its tags) as a new manual snapshot; this
  is how to keep an automated snapshot past its retention period.
- **Delete…**: manual snapshots only, with a typed confirmation.
- **Restore to a new database…**: creates a new database from the snapshot.
  Choose its name and, optionally, instance class (or Serverless v2 capacity).
  When the source database still exists, the new one gets its subnet group,
  security groups and public access setting. Restoring an Aurora cluster also
  creates its first instance (`<name>-1`).
- **Restore to point in time** (database tab): a new database from the
  latest restorable time or a time you choose, within the backup retention
  period.

The original database is never changed by a restore.

## Events and logs

**Events**: what RDS reported about the database (backups, restarts,
failovers, configuration changes…) for the last hour, day, 7 days or 14 days
(RDS keeps 14 days). A cluster's events include its instances'. Long lists
are shown a page at a time.

**Log files**: the database's log files, newest first. Logs belong to
instances: for a cluster, choose the instance. Click a file to see its last
100 to 10,000 lines (scrolled to the newest), **Copy** them, or **Download**
the whole file (saved portion by portion; a partial file is removed if it
fails).

## Connect

The **Connect** tab, on every database:

- endpoints (a cluster's writer and reader endpoints), port, user and
  database, each with **Copy**;
- where the password is: in Secrets Manager (when RDS manages it; **Copy
  ARN**, then reveal it in the Secrets Manager view) or not stored by AWS;
- whether the database is publicly accessible or reachable only from inside
  its VPC;
- ready-made client commands and URLs for the engine: `psql`, JDBC and a URI
  for PostgreSQL; `mysql` / `mariadb`, JDBC and a URI for MySQL and MariaDB;
  `sqlcmd` and JDBC for SQL Server; SQL*Plus and JDBC for Oracle; JDBC for
  Db2;
- with IAM database authentication on, the `aws rds generate-db-auth-token`
  command for a 15-minute token to use as the password.

The app doesn't connect to databases directly; use these with your own client.

## SQL (Aurora with the Data API)

Aurora clusters with the **Data API** turned on get a **SQL** tab, which runs
statements through the RDS Data API (no network route to the database
needed).

- **Credentials**: a Secrets Manager secret with the database user's
  `username` and `password`. It defaults to the master user's secret when RDS
  manages it; secret names in the region are suggested. The app passes the
  secret's ARN to the Data API and never reads its value.
- **Database**: defaults to the cluster's database; **List databases**
  suggests the others.
- Write a statement and press **Run** (Ctrl+Enter). One statement runs at a
  time: with several, select one and press **Run selection** (Ctrl+Enter
  runs the selection when there is one).
- Results show in a grid (NULLs marked, 100 / 500 / 1,000 rows a page), with
  row count and time. Click a row, then **Copy row as JSON**. **Export CSV**
  and **Export JSON** save all rows.
- **History** keeps your recent statements per profile and cluster.
- The Data API returns at most 1 MB per statement: use `LIMIT` / `OFFSET`
  for big tables.

### Read-only runs

**Read only (rolled back)** is on by default. A read-only run happens inside a
transaction that is always rolled back, so nothing it does is kept:

- PostgreSQL: the transaction is also set read only, so writes fail with an
  error.
- MySQL: only statements that read are accepted (`SELECT`, `SHOW`,
  `DESCRIBE`, `EXPLAIN`, `WITH`), because MySQL can't make an open
  transaction read only and some statements (like DDL) commit on their own.
- Transaction-control statements (`BEGIN`, `COMMIT`, `SET`, …) are refused.

Clear **Read only** to change data: statements then commit as soon as they
run.

## Read-only mode

With the toolbar lock on (on whenever you
connect), start, stop, reboot, fail over, modify, delete, snapshot create /
copy / delete and restores are disabled, and the app's backend refuses them.
SQL runs are always read-only runs. Browsing, events, viewing and downloading
logs, connection details and exporting results still work.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Enter / double-click | Open database |
| Ctrl+E | Modify |
| Del | Delete |
| F5 | Refresh |
| Ctrl+Enter (SQL tab) | Run (the selection, if any) |

## Permissions

The profile needs these IAM actions (scope `Resource` to your databases):

- Browse: `rds:DescribeDBInstances`, `rds:DescribeDBClusters`,
  `rds:DescribePendingMaintenanceActions`, `rds:ListTagsForResource`
- Actions: `rds:StartDBInstance`, `rds:StopDBInstance`,
  `rds:RebootDBInstance`, `rds:StartDBCluster`, `rds:StopDBCluster`,
  `rds:RebootDBCluster`, `rds:FailoverDBCluster`, `rds:ModifyDBInstance`,
  `rds:ModifyDBCluster`, `rds:DeleteDBInstance`, `rds:DeleteDBCluster`
- Snapshots: `rds:DescribeDBSnapshots`, `rds:DescribeDBClusterSnapshots`,
  `rds:CreateDBSnapshot`, `rds:CreateDBClusterSnapshot`,
  `rds:CopyDBSnapshot`, `rds:CopyDBClusterSnapshot`, `rds:DeleteDBSnapshot`,
  `rds:DeleteDBClusterSnapshot`, `rds:AddTagsToResource` (copies keep tags)
- Restore: `rds:RestoreDBInstanceFromDBSnapshot`,
  `rds:RestoreDBInstanceToPointInTime`,
  `rds:RestoreDBClusterFromSnapshot`, `rds:RestoreDBClusterToPointInTime`,
  `rds:CreateDBInstance` (a restored cluster's instance)
- Events and logs: `rds:DescribeEvents`, `rds:DescribeDBLogFiles`,
  `rds:DownloadDBLogFilePortion`
- SQL: `rds-data:ExecuteStatement`, `rds-data:BeginTransaction`,
  `rds-data:RollbackTransaction` on the cluster, and
  `secretsmanager:GetSecretValue` on the secret (used by the Data API on your
  behalf); `secretsmanager:ListSecrets` for the suggestions. Encrypted
  secrets also need `kms:Decrypt` on their key.
