# SQS

Amazon Simple Queue Service queues. Open **SQS** in the tree under your
profile. It uses the region chosen in the toolbar's **Region** list
(remembered per profile).

## Queues

The SQS node lists the region's queues in the tree and in the main list:
**Name, Type** (Standard / FIFO), **Available, In flight, Delayed**,
**Dead-letter** (which queue failed messages go to, or "Is a dead-letter
queue") and **Created**. Queue icons are red for dead-letter queues and have
a blue dot for FIFO queues.

Queues are listed a page at a time: choose 100, 500 or 1,000 per page with
the pager under the list (remembered) and step with First / Previous / Next
(Ctrl+PgUp / Ctrl+PgDn). Every queue name is loaded, but counts and settings
are only fetched for the page you're looking at, so regions with thousands of
queues open quickly. Sorting by a column other than Name sorts the page shown.
The tree lists the first 200 queues; the list has the rest.

### Filtering

Type the start of a queue name in the **Filter** box (for example `orders-`)
and press **Enter**. Filters you apply are remembered per profile and region
(the last 10, newest first): open the ▾ list to reuse one, remove one with
its ✕, or clear the history.

### Queue view

Open a queue (Enter, double-click or click it in the tree) to see:

- **Available / In flight / Delayed** counts, refreshed every 5 seconds while
  the queue is shown (untick to pause). In flight = received but not yet
  deleted.
- Configuration: type, visibility timeout, retention, delivery delay, maximum
  message size, receive wait time, encryption, FIFO settings, created and
  changed times, URL and ARN (with **Copy URL** / **Copy ARN**).
- Dead-letter handling: where failed messages go and after how many
  receives, or, for a dead-letter queue, which queues feed it. Names are links.
- Tags, and every raw attribute under **All attributes**.

## Creating, editing and deleting

**New queue** (Ctrl+Shift+N):

| Setting | Notes |
|---|---|
| Type | Standard, or FIFO (ordered, exactly-once). FIFO names end in `.fifo` (added for you). Can't be changed later. |
| Visibility timeout | 0 s – 12 h. How long a received message stays hidden. |
| Message retention | 1 min – 14 days. |
| Delivery delay | 0 – 15 min. |
| Maximum message size | 1 KB – 1 MB. |
| Receive wait time | 0 – 20 s. Above 0 turns on long polling. |
| Dead-letter queue | A queue of the same type, and how many receives before a message moves there. |
| Encryption | None, SQS-managed (SSE-SQS) or a KMS key (SSE-KMS) with its reuse period. |
| FIFO | Content-based deduplication; high throughput (deduplication and limits per message group). |
| Access policy | Optional JSON, checked as you type. |
| Tags | Key / value pairs. |

**Edit** (Ctrl+E) opens the same form for an existing queue; only the
settings you change are sent.

**Delete** (Del) asks you to type the queue's name. You're warned if other
queues use it as their dead-letter queue. SQS doesn't allow a queue with the
same name to be created for 60 seconds afterwards.

**Purge** deletes every message in a queue after confirming. SQS allows one
purge per queue per minute, so the button counts down for 60 seconds.

## Sending messages

**Send** opens a dialog with two tabs.

**One message**

- Body: any text. JSON is checked as you type, with Format / Minify. The byte
  count is compared with the queue's maximum size.
- Message attributes: up to 10, each String, Number or Binary (base64).
- Delay (standard queues): 0–900 s; blank uses the queue's delay.
- FIFO queues: message group ID (required) and deduplication ID (required
  unless content-based deduplication is on).
- After sending, the message ID is shown and **Send again** keeps the form.

**From a file**: a JSON array, or JSON lines (one message per line). Choose
whether each item is:

- the message body (objects are sent as JSON text), or
- an envelope:
  ```json
  {"body": {"orderId": 42}, "attributes": [{"name": "source", "dataType": "String", "value": "web"}],
   "groupId": "customer-7", "dedupId": "order-42", "delaySeconds": 0}
  ```

The dialog shows how many messages the file holds and the first few, then
sends them 10 per request and reports any that failed by position. For FIFO
queues, a group ID you enter is used for items without one.

## Looking at messages

The **Messages** section of the queue view has two modes:

- **Peek** (default): see messages without taking them from consumers.
  They're collected with a short hold and released straight away.
- **Receive & hold**: messages are hidden from consumers for the time you
  choose (default 60 s), with a countdown, until you delete or release them.
  Leaving the queue releases them.

Choose how many to get (up to 10, 50, 100 or 500) and optionally **Wait for
messages** (long poll up to 20 s). Either way, every look counts as a
receive: the message's receive count rises, and with a redrive policy a
message can move to the dead-letter queue. The panel shows the queue's
threshold as a reminder.

The table shows sent time, receive count, FIFO group and the start of the
body. Click a message for its body (JSON as a tree), message attributes and
system attributes (sender, timestamps, receive count, group and sequence for
FIFO). Tick messages to:

- **Delete selected** (confirmed),
- **Release selected / Release all** (Receive & hold): visible to consumers
  again now,
- **Export** selected or all to a JSON lines file (body, attributes and
  system attributes; no receipt handles).

## Redrive (dead-letter queues)

**Redrive** on a dead-letter queue (or **Move** on any queue) moves messages
out:

- back to **their source queues**, or to **another queue** of the same type,
- optionally limited to a number of messages per second.

The dialog lists recent redrives with status and progress (moved / to move),
updating every few seconds while one runs, with **Cancel**.

If the endpoint doesn't support SQS redrive (some emulators), the dialog
offers to move the messages by receiving each one, sending it to the
destination (keeping attributes and the FIFO group) and deleting it only
after it was sent.

## Read-only mode

With the toolbar lock on (on whenever you
connect), creating, editing, deleting, purging, sending, deleting messages
and starting redrives are disabled, and the app's backend refuses them.
Browsing, counts, Peek and Receive & hold, releasing held messages, export,
and cancelling a redrive still work. (Receiving isn't a write, but note that
it raises receive counts.)

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Enter / double-click | Open queue |
| Ctrl+Shift+N | New queue |
| Ctrl+E | Edit queue settings |
| Del | Delete queue |
| F5 | Refresh |

## Permissions

The profile needs these IAM actions (scope `Resource` to your queues):

- Browse: `sqs:ListQueues`, `sqs:GetQueueAttributes`, `sqs:GetQueueUrl`,
  `sqs:ListQueueTags`, `sqs:ListDeadLetterSourceQueues`
- Manage: `sqs:CreateQueue`, `sqs:SetQueueAttributes`, `sqs:DeleteQueue`,
  `sqs:TagQueue`, `sqs:UntagQueue`, `sqs:PurgeQueue`
- Messages: `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage`,
  `sqs:ChangeMessageVisibility`
- Redrive: `sqs:StartMessageMoveTask`, `sqs:ListMessageMoveTasks`,
  `sqs:CancelMessageMoveTask` (plus receive/send/delete on both queues)
- Encrypted queues: `kms:GenerateDataKey` and `kms:Decrypt` on the key
