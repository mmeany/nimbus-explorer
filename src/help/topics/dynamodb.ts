export const dynamodbTopics = {
  "dynamodb.tables": {
    title: "DynamoDB tables",
    body: `The region's tables, with their keys, indexes, item count, size, capacity mode and creation date. DynamoDB updates item counts and sizes about every six hours, so they lag behind. Details are only fetched for the page on screen, and the tree lists the first 200.

- **Filter**: type the start of a table name and press Enter.
- **Open** a table: Enter or double-click.
- **New table**: in the command bar.
- **Delete table**: you type the name to confirm. It's refused while deletion protection is on. On-demand backups are kept.`,
  },
  "dynamodb.items": {
    title: "Items",
    body: `- **Scan** reads the whole table or index. **Query** reads one partition, so it's much cheaper when you know the key.
- Choose the **table or an index**. For Query, enter the partition key and optionally a sort key condition and order.
- **Filter**: add conditions, using \`a.b\` for nested attributes, or tick **Expression** and write your own with \`#names\` and \`:values\`.
- **Attributes**: a comma-separated list such as \`id, name, address.city\`. Blank means all.
- **Consistent**: strongly consistent reads. Table only, and uses twice the capacity.

### Results

Results come **100 at a time**, with **Load more** for the next page. Filters apply after DynamoDB reads, so a page can return few items, or none, while more remain. **Count all** counts every match without fetching items. The line above the grid shows items read and capacity consumed.

Click a row to see the item on the right. Column headers sort only what's loaded. Drag a header's edge to resize a column, or double-click it to fit. Widths are remembered per table.

### Changing items

| Keys | Action |
|---|---|
| Enter / double-click | Edit the selected item |
| Del | Delete selected items, after confirming |
| Ctrl+A | Select all loaded items |

**New item**, **Duplicate**, **Export…** and **Import…** are on this tab, and in the right-click menu where they apply.`,
  },
  "dynamodb.partiql": {
    title: "PartiQL",
    body: `Runs PartiQL statements against DynamoDB:

\`\`\`sql
SELECT * FROM "orders" WHERE customerId = ? AND orderTs > ?
UPDATE "orders" SET status = 'shipped' WHERE customerId = 'c1' AND orderTs = 1700000000
\`\`\`

- Put values for \`?\` in **Parameters** as a JSON array: \`["c1", 1700000000]\`.
- Press **Run** (Ctrl+Enter). SELECT results come 100 at a time, with **Load more**.
- Use double quotes for table and attribute names, and single quotes for strings.
- **History** keeps the last 10 statements per profile.

A SELECT without the partition key in its WHERE clause scans the table. In read-only mode, only SELECT runs.`,
  },
  "dynamodb.details": {
    title: "Table details",
    body: `Keys and types, item count and size, capacity, table class, time to live, stream, point-in-time recovery, deletion protection, encryption, ARNs, indexes, attribute definitions and tags.

- **Settings…**: change capacity, class, stream, time to live, recovery, deletion protection and tags.
- **Add index…**: a new global secondary index. DynamoDB builds it in the background, and its status shows here.
- **Delete…** next to a global index removes it.

Local secondary indexes can only be added when a table is created.`,
  },
  "dynamodb.backups": {
    title: "Backups",
    body: `The table's on-demand backups, with their name, creation time, status, type and size.

- **Create backup…**: takes a new backup.
- **Restore…**: creates a **new** table from the backup. The original isn't touched.
- **Delete…**: removes a backup.
- Each backup's ARN can be copied.

Deleting a table keeps its on-demand backups.`,
  },
  "dynamodb.itemEditor": {
    title: "Item editor",
    body: `Shows the item as **JSON** or **DynamoDB JSON** (switch at the top). In plain JSON, values JSON can't express use markers:

| Marker | DynamoDB type |
|---|---|
| \`{"$SS": ["a", "b"]}\` | String set |
| \`{"$NS": [1, 2]}\` | Number set |
| \`{"$BS": ["aGk="]}\` | Binary set |
| \`{"$B": "aGk="}\` | Binary (base64) |
| \`{"$N": "12345678901234567890"}\` | Number too precise for JSON |

\`null\` is DynamoDB NULL. Keys and their types are checked as you type. Ctrl+Enter saves.

- Creating never overwrites an existing item.
- Saving an edit replaces the whole item, and fails if it was deleted in the meantime.
- If you change the key, you choose whether to **move** the item or **keep both**.`,
  },
  "dynamodb.newTable": {
    title: "New table",
    body: `- **Keys**: a partition key, and an optional sort key, each with a type. Keys can't be changed later.
- **Capacity**: on-demand (pay per request) or provisioned (fixed read and write units).
- **Table class, stream, deletion protection, tags**: can all be changed later in Settings.
- **Global secondary indexes**: alternative keys to query by. They can also be added later.
- **Local secondary indexes**: the same partition key with a different sort key. They can only be added now, and only if the table has a sort key.`,
  },
  "dynamodb.addIndex": {
    title: "Add global index",
    body: `A global secondary index lets you query by a different partition key, and an optional sort key.

- **Projection** decides which attributes are copied into the index. Fewer means less storage, but queries return only what's projected.
- Provisioned tables also set the index's own capacity.

DynamoDB builds the index in the background. Its status shows on the Details tab.`,
  },
  "dynamodb.tableSettings": {
    title: "Table settings",
    body: `- **Capacity mode and units**: switching mode is allowed once per 24 hours.
- **Table class**.
- **Stream**: off, or the view type. Changing the view type turns the stream off and on again.
- **Time to live**: the attribute holding an expiry time in epoch seconds.
- **Point-in-time recovery**.
- **Deletion protection**: while on, the table can't be deleted.
- **Tags**.

Settings are applied one change at a time, because DynamoDB accepts one table update at a time.`,
  },
  "dynamodb.export": {
    title: "Export items",
    body: `Writes the current results (or selected items), or the **whole table**. The whole table is read page by page with a progress bar, and **Cancel** keeps what was written.

- **DynamoDB JSON lines**: exact types, and can be imported again.
- **JSON lines**: plain JSON, with markers for sets and binary.
- **CSV**: key columns first, then the first page's attributes. Anything else goes in an \`_other\` column as JSON.

Exporting a whole table consumes read capacity for every item.`,
  },
  "dynamodb.import": {
    title: "Import items",
    body: `Reads a JSON array or JSON lines, in DynamoDB JSON or plain JSON (detected automatically).

The preview shows how many items the file holds, how many already exist, how many can't be imported and why, and the first few items.

Existing items are skipped unless you tick **Overwrite items that already exist**. Progress is shown, and **Stop** ends the import early. Anything already written stays.`,
  },
};
