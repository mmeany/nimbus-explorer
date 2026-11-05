export const sqsTopics = {
  "sqs.queues": {
    title: "SQS queues",
    body: `The region's queues, with **Available**, **In flight** and **Delayed** counts and where failed messages go. Red icons are dead-letter queues, and a blue dot marks FIFO.

Counts and settings are only fetched for the page on screen, so large regions open quickly. The tree lists the first 200 queues.

- **Filter**: type the start of a queue name and press Enter.
- **Open** a queue: Enter or double-click.
- **New queue**: Ctrl+Shift+N.
- **Edit**: Ctrl+E.
- **Delete**: Del. You type the name to confirm. SQS won't let you reuse the name for 60 seconds.`,
  },
  "sqs.queue": {
    title: "SQS queue",
    body: `Live counts (refreshed every 5 seconds, untick to pause), configuration, dead-letter handling, tags and every raw attribute. **In flight** means received but not yet deleted.

### Looking at messages

- **Peek** (default): shows messages without taking them from consumers. They're held briefly and released straight away.
- **Receive & hold**: hides messages from consumers for the time you choose, until you delete or release them. Leaving the queue releases them.

**Every look counts as a receive.** The receive count rises, and with a redrive policy a message can move to the dead-letter queue. The panel shows the threshold as a reminder.

Click a message for its body and attributes. Tick messages to **Delete selected**, **Release** them or **Export** them to a JSON lines file.

### Commands

- **Send**: one message, or many from a file.
- **Purge**: deletes every message after confirming. SQS allows one purge a minute, so the button counts down.
- **Redrive** (dead-letter queues) or **Move**: moves messages to another queue.
- **Edit** (Ctrl+E) and **Delete** (Del).

In read-only mode, Peek, Receive & hold, releasing and exporting still work. Sending, deleting, purging and starting a redrive don't.`,
  },
  "sqs.settings": {
    title: "Queue settings",
    body: `| Setting | Notes |
|---|---|
| Type | Standard, or FIFO (ordered, exactly-once). FIFO names get \`.fifo\` added. It can't be changed later. |
| Visibility timeout | How long a received message stays hidden, 0 s to 12 h. |
| Message retention | 1 minute to 14 days. |
| Delivery delay | 0 to 15 minutes. |
| Maximum message size | 1 KB to 1 MB. |
| Receive wait time | 0 to 20 s. Above 0 turns on long polling. |
| Dead-letter queue | A queue of the same type, and how many receives before a message moves there. |
| Encryption | None, SQS-managed, or a KMS key with its reuse period. |
| FIFO | Content-based deduplication, and high throughput. |
| Access policy | Optional JSON, checked as you type. |

When editing, only the settings you change are sent.`,
  },
  "sqs.send": {
    title: "Send messages",
    body: `### One message

- **Body**: any text. JSON is checked as you type, with Format and Minify. The byte count is compared with the queue's maximum.
- **Attributes**: up to 10, each String, Number or Binary (base64).
- **Delay** (standard queues): 0 to 900 s. Blank uses the queue's delay.
- **FIFO**: a group ID is required. A deduplication ID is required unless content-based deduplication is on.

**Send again** keeps the form for another message.

### From a file

A JSON array, or JSON lines. Each item is either the message body, or an envelope:

\`\`\`json
{"body": {"orderId": 42}, "attributes": [{"name": "source", "dataType": "String", "value": "web"}], "groupId": "customer-7", "dedupId": "order-42", "delaySeconds": 0}
\`\`\`

The dialog shows the count and the first few, sends 10 per request, and reports failures by position. On FIFO queues, a group ID you enter is used for items without one.`,
  },
  "sqs.redrive": {
    title: "Redrive and move messages",
    body: `Moves messages out of this queue, either back to **their source queues** or to **another queue** of the same type. You can limit the rate to a number of messages per second.

The dialog lists recent redrives with their progress, updating every few seconds while one runs. **Cancel** stops one, and works in read-only mode.

If the endpoint doesn't support redrive (some emulators), the dialog offers to move messages one at a time. Each is received, sent to the destination, and deleted only after it was sent.`,
  },
};
