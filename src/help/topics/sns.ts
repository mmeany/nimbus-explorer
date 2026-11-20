export const snsTopics = {
  "sns.topics": {
    title: "SNS topics",
    body: `The region's topics, with their type, display name, confirmed and pending subscriptions and encryption. A topic's details are only fetched for the page on screen, and the tree lists the first 200.

- **Topics / All subscriptions**: switches the list.
- **Filter**: type the start of a topic name and press Enter. It filters both lists.
- **Open** a topic: Enter or double-click.
- **New topic**: Ctrl+Shift+N.
- **Edit**: Ctrl+E.
- **Delete**: Del. You type the name to confirm. Its subscriptions go with it, and anything still publishing to it starts failing.
- **Right-click** a topic for Subscribe and Publish.`,
  },
  "sns.subscriptions": {
    title: "All subscriptions",
    body: `Every subscription in the region, with its topic, protocol, endpoint and status. The Filter box matches the start of the topic name. Double-click a row to open its topic.

- **New subscription** adds one.
- **Del** unsubscribes, after asking.
- **Edit…** changes a confirmed subscription's filter policy, raw delivery, dead-letter queue and so on.

A **pending** subscription is waiting for confirmation. It can only be confirmed, by pasting the token or the whole \`SubscribeURL\` from the confirmation message. SNS deletes unconfirmed subscriptions after 3 days, and they can't be edited or removed before that.`,
  },
  "sns.topic": {
    title: "SNS topic",
    body: `Subscription counts, the subscriptions themselves, configuration, tags and every raw attribute.

- **Publish**: send a message to the topic.
- **Subscribe…**: add a subscription. **Confirm with token…** confirms a pending one.
- Each row has **Edit…**, **Unsubscribe…** and **Copy ARN**, or **Confirm…** if it's pending.

### Watch messages

SNS doesn't keep messages, so **Start watching** creates a temporary SQS queue (\`s3x-watch-…\`), subscribes it to the topic and shows what arrives, newest first. It only sees messages published from then on. Tick **Raw delivery** first to skip the SNS envelope.

**Stop watching**, leaving the topic or closing the app removes the queue and subscription. While you watch, the subscription counts towards the topic's total. If the app closed abruptly, the panel offers to clean up what's left behind.

Starting a watch needs read-only mode off. A running watch keeps working if you lock again, and is still cleaned up.`,
  },
  "sns.topicSettings": {
    title: "Topic settings",
    body: `| Setting | Notes |
|---|---|
| Type | Standard, or FIFO (ordered and deduplicated; only SQS FIFO queues can subscribe). FIFO names get \`.fifo\` added. It can't be changed later. |
| Name | 1 to 256 letters, digits, \`-\` and \`_\`. |
| Display name | The sender name for SMS and email. |
| Encryption | Optional KMS key, such as \`alias/aws/sns\`. |
| Content-based deduplication | FIFO only: no deduplication ID needed when publishing. |
| Delivery policy | Optional JSON: retries for HTTP/S endpoints. |
| Access policy | Optional when creating; SNS adds a default one. |
| Data protection policy | Optional JSON. |

When editing, only your changes are sent. An access policy can be edited but not cleared. A data protection policy can't be removed once set, only edited.`,
  },
  "sns.subscription": {
    title: "Subscription",
    body: `| Setting | Notes |
|---|---|
| Protocol | SQS, Lambda, HTTPS, HTTP, email, email (JSON), SMS, Data Firehose or an application endpoint. FIFO topics only offer SQS. |
| Endpoint | An ARN, a URL, an email address, or a phone number such as \`+447700900123\`. Your queues' ARNs are suggested. |
| Allow this topic to send to the queue | SQS only, on by default. Adds a statement to the queue's policy. Without it, messages don't arrive. |
| Raw message delivery | SQS, HTTP/S and Firehose: deliver the message as published, without the SNS envelope. |
| Subscription role | Firehose only: an IAM role that can write to the stream. |
| Filter policy | Optional JSON, matched against message attributes or the JSON message body. Only matches are delivered. |
| Dead-letter queue | Optional queue ARN for messages SNS can't deliver. |
| Delivery policy | HTTP/S only: optional retry policy. |

Email, HTTP and HTTPS endpoints stay **pending** until someone confirms. SNS deletes them after 3 days if nobody does.`,
  },
  "sns.publish": {
    title: "Publish",
    body: `### One message

- **Subject**: optional, one line under 100 characters. Used as the email subject.
- **Message**: any text. JSON is checked as you type. The limit is 256 KB, including attributes.
- **Different message per protocol**: the message box becomes the default, and you add messages for sqs, lambda, http, https, email, email-json, sms and firehose.
- **Attributes**: up to 10, each String, String.Array (\`["a", "b"]\`), Number or Binary. Subscription filter policies match on these.
- **FIFO**: a group ID is required. A deduplication ID is required unless content-based deduplication is on.

**Publish again** keeps the form for another message.

### From a file

A JSON array, or JSON lines. Each item is the message itself, or an envelope:

\`\`\`json
{"body": "…", "subject": "…", "messageStructure": "json", "attributes": [{"name": "a", "dataType": "String", "value": "b"}], "groupId": "…", "dedupId": "…"}
\`\`\`

The subject and group ID boxes fill in for items without one. Messages go 10 per request, and failures are reported by position.`,
  },
};
