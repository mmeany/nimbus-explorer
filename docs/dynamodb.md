# DynamoDB

Amazon DynamoDB tables and items. Open **DynamoDB** in the tree under your
profile. It uses the region chosen in the toolbar's **Region** list
(remembered per profile).

## Tables

The DynamoDB node lists the region's tables in the tree and in the main list:
**Name, Status, Partition key, Sort key, Indexes, Items, Size, Capacity**
(on-demand / provisioned) and **Created**. Item counts and sizes come from
DynamoDB and are updated about every six hours.

Tables are listed a page at a time: choose 100, 500 or 1,000 per page with
the pager under the list (remembered) and step with First / Previous / Next
(Ctrl+PgUp / Ctrl+PgDn). Every table name is loaded, but table details are
only fetched for the page you're looking at. Sorting by a column other than
Name sorts the page shown. The tree lists the first 200 tables.

Type the start of a table name in the **Filter** box and press **Enter**.
Filters you apply are remembered per profile and region (last 10).

Open a table to get four tabs: **Items**, **PartiQL**, **Details** and
**Backups**.

## Items: Scan and Query

- **Scan** reads the whole table or index; **Query** reads one partition.
- Choose the **table or an index** (GSI / LSI).
- Query: enter the **partition key** value, and optionally a **sort key**
  condition: =, <, ≤, >, ≥, between, begins with. Choose ascending or
  descending order.
- **Filter**: add conditions (attribute, operator, typed value). Operators:
  =, ≠, <, ≤, >, ≥, between, begins with, contains, doesn't contain, exists,
  doesn't exist. Use `a.b` for nested attributes. Or tick **Expression** and
  write a filter expression with your own `#names` and `:values` (values as
  plain JSON).
- **Attributes**: a comma-separated projection (e.g. `id, name, address.city`);
  blank means all attributes.
- **Consistent**: strongly consistent reads (table only; uses twice the
  capacity).

Results come **100 at a time**: **Load more** fetches the next page. The line
above the grid shows items returned, items read, pages, consumed capacity and
whether more is available. Filters apply after DynamoDB reads, so a page can
return fewer than 100 items (even none) while more remain. **Count all**
counts every match without fetching items.

### Results grid

Key attributes come first (bold), then other attributes in the order they
first appear. Numbers are right-aligned; maps, lists and sets show a summary
(e.g. `{3 keys}`, `[2 items]`). Click a column header to sort the loaded
results. Click a row to show the item on the right as a tree, as plain JSON or
DynamoDB JSON. Ctrl+click / Shift+click select several; Ctrl+A selects all.

## Creating, editing and deleting items

- **New item** opens the editor with the key attributes filled in.
- **Edit** (double-click, Enter) reloads the item from the table first, then
  opens it. Saving replaces the whole item, and fails if the item was deleted
  in the meantime.
- **Duplicate** starts a new item from a copy; change the key before saving.
- **Delete** (Del) deletes the selected items after confirming, 25 per
  request, retrying throttled ones.

The editor shows the item as **JSON** or **DynamoDB JSON** (switch at the
top). In plain JSON, values JSON can't express use markers:

| Marker | DynamoDB type |
|---|---|
| `{"$SS": ["a", "b"]}` | String set |
| `{"$NS": [1, 2]}` | Number set |
| `{"$BS": ["aGk="]}` | Binary set |
| `{"$B": "aGk="}` | Binary (base64) |
| `{"$N": "12345678901234567890"}` | Number too precise for JSON |

`null` is DynamoDB NULL. The key attributes and their types are checked as
you type. Creating never overwrites an existing item. If you change the key
while editing, you choose whether to **move** the item (create the new one,
delete the old) or **keep both**.

## PartiQL

The PartiQL tab runs statements such as:

```sql
SELECT * FROM "orders" WHERE customerId = ? AND orderTs > ?
UPDATE "orders" SET status = 'shipped' WHERE customerId = 'c1' AND orderTs = 1700000000
```

Put values for `?` in **Parameters** as a JSON array (`["c1", 1700000000]`).
**Run** (Ctrl+Enter). SELECT results come 100 at a time with **Load more**.
The last 10 statements are remembered per profile (**History**). Use double
quotes for table and attribute names and single quotes for strings.

## Export and import

**Export…** writes either the current results (or the selected items) or the
**whole table** (read page by page with a progress bar; **Cancel** keeps what
was written). Formats:

- **DynamoDB JSON lines**: exact types, can be imported again,
- **JSON lines**: plain JSON with the markers above,
- **CSV**: key columns first, then the first page's attributes; anything else
  goes in an `_other` column as JSON.

**Import…** reads a JSON array or JSON lines, in DynamoDB JSON or plain JSON
(detected). The preview shows how many items the file holds, how many already
exist in the table, how many can't be imported (missing or wrongly typed keys,
invalid values, with reasons) and the first few items. Existing items are
skipped unless you tick **Overwrite items that already exist**. Progress is
shown, and **Stop** ends the import early.

## Details

Keys and types, item count and size, capacity, table class, time to live,
stream, point-in-time recovery, deletion protection, encryption, ARNs, every
index (keys, projection, status, items), attribute definitions and tags.

- **Settings…**: capacity mode and units (switching mode is allowed once per
  24 hours), table class, stream (off, or the view type), time-to-live
  attribute (epoch seconds), point-in-time recovery, deletion protection, tags.
- **Add index…**: a new global secondary index (partition key, optional sort
  key, projection, capacity for provisioned tables). DynamoDB builds it in the
  background; its status shows here.
- **Delete…** next to a global index removes it.

## Creating and deleting tables

**New table** (command bar): name, partition key and optional sort key with
types, capacity (on-demand or provisioned), table class, stream, deletion
protection, global and local secondary indexes (local ones only at creation,
and only with a sort key), tags.

**Delete table** asks you to type the table's name. It's refused while
deletion protection is on. On-demand backups are kept.

## Backups

The Backups tab lists on-demand backups (name, created, status, type, size)
and lets you **Create backup…**, **Restore…** into a new table, **Delete…**,
or copy a backup's ARN.

## Read-only mode

With the toolbar lock on (on whenever you
connect), every write is disabled and refused by the app's backend: item
create / edit / delete, imports, PartiQL statements other than SELECT, table
create / delete, indexes, settings and backups. Scans, queries, SELECT,
viewing items, Count all and exports still work.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Enter / double-click | Open table; edit (view) the selected item |
| Del | Delete the selected items |
| Ctrl+A | Select all loaded items |
| Ctrl+Enter | Run the PartiQL statement / save in the item editor |
| F5 | Refresh |

## Permissions

The profile needs these IAM actions (scope `Resource` to your tables):

- Browse: `dynamodb:ListTables`, `dynamodb:DescribeTable`,
  `dynamodb:DescribeTimeToLive`, `dynamodb:DescribeContinuousBackups`,
  `dynamodb:ListTagsOfResource`
- Read: `dynamodb:Scan`, `dynamodb:Query`, `dynamodb:GetItem`,
  `dynamodb:BatchGetItem` (import preview), `dynamodb:PartiQLSelect`
- Write items: `dynamodb:PutItem`, `dynamodb:DeleteItem`,
  `dynamodb:BatchWriteItem`, `dynamodb:PartiQLInsert`, `PartiQLUpdate`,
  `PartiQLDelete`
- Tables: `dynamodb:CreateTable`, `dynamodb:DeleteTable`,
  `dynamodb:UpdateTable`, `dynamodb:UpdateTimeToLive`,
  `dynamodb:UpdateContinuousBackups`, `dynamodb:TagResource`,
  `dynamodb:UntagResource`
- Backups: `dynamodb:ListBackups`, `dynamodb:CreateBackup`,
  `dynamodb:RestoreTableFromBackup`, `dynamodb:DeleteBackup` (restores also
  need the write actions on the new table)
