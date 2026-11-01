# SNS

Amazon Simple Notification Service topics and subscriptions. Open **SNS** in
the tree under your profile. It uses the region chosen in the toolbar's
**Region** list (remembered per profile).

## Topics

The SNS node lists the region's topics in the tree and in the main list:
**Name, Type** (Standard / FIFO), **Display name, Subscriptions**
(confirmed), **Pending** (waiting for confirmation) and **Encryption**.

Switch the main list between **Topics** and **All subscriptions** (every
subscription in the region, with its topic, protocol, endpoint and status).
Double-clicking a subscription opens its topic.

Both lists are shown a page at a time: choose 100, 500 or 1,000 per page with
the pager under the list (remembered) and step with First / Previous / Next
(Ctrl+PgUp / Ctrl+PgDn). Every topic name is loaded, but a topic's details are
only fetched for the page you're looking at. Sorting by a column other than
Name sorts the page shown. The tree lists the first 200 topics.

### Filtering

Type the start of a topic name in the **Filter** box and press **Enter**.
It filters both the topic list and the All subscriptions list. Filters you
apply are remembered per profile and region (the last 10, newest first):
open the ▾ list to reuse one, remove one with its ✕, or clear the history.

### Topic view

Open a topic (Enter, double-click or click it in the tree) to see:

- counts of confirmed, pending and deleted subscriptions;
- **Watch messages** (see below);
- the topic's subscriptions, with **Subscribe…** and **Confirm with token…**
  above them and **Edit… / Unsubscribe… / Copy ARN** (or **Confirm…** for a
  pending one) on each row;
- configuration (type, display name, encryption, owner, delivery policy,
  tracing), the ARN with **Copy ARN**, tags, and every raw attribute under
  **All attributes**.

## Creating, editing and deleting topics

**New topic** (Ctrl+Shift+N):

| Setting | Notes |
|---|---|
| Type | Standard, or FIFO (ordered and deduplicated; only SQS FIFO queues can subscribe). FIFO names end in `.fifo` (added for you). Can't be changed later. |
| Name | 1–256 letters, digits, `-` and `_`. |
| Display name | Optional; the sender name for SMS and email. |
| Encryption | Optional KMS key (for example `alias/aws/sns`). |
| Content-based deduplication | FIFO only: no deduplication ID needed when publishing. |
| Delivery policy | Optional JSON: retries for HTTP/S endpoints. |
| Access policy | Optional when creating (SNS adds a default one). |
| Data protection policy | Optional JSON. |
| Tags | Key / value pairs. |

JSON fields are checked as you type, with Format / Minify.

**Edit** (Ctrl+E) opens the same form for an existing topic; only the
settings you change are sent. An access policy can be edited but not
cleared, and SNS has no way to remove a data protection policy once set
(edit its statements instead).

**Delete** (Del) asks you to type the topic's name. Its subscriptions are
deleted with it, and anything still publishing to it starts failing.

## Subscriptions

**Subscribe…** (on a topic, from a topic's right-click menu, or **New
subscription** in the All subscriptions view):

| Setting | Notes |
|---|---|
| Protocol | SQS, Lambda, HTTPS, HTTP, email, email (JSON), SMS, Data Firehose or a platform application endpoint. FIFO topics only offer SQS. |
| Endpoint | A queue / function / stream / endpoint ARN, a URL, an email address, or a phone number in E.164 format (`+447700900123`). Your queues' ARNs are suggested. |
| Allow this topic to send to the queue | SQS only, on by default: adds a statement to the queue's access policy letting this topic send to it (nothing is changed if one is already there). Without it, messages don't arrive. |
| Raw message delivery | SQS, HTTP/S and Firehose: deliver the message as published instead of wrapped in the SNS JSON envelope. |
| Subscription role | Firehose only: an IAM role that can write to the stream. |
| Filter policy | Optional JSON, matched against the **message attributes** or the **message body** (for JSON messages). Only matching messages are delivered. |
| Dead-letter queue | Optional SQS queue ARN for messages SNS can't deliver. |
| Delivery policy | HTTP/S only: optional retry policy JSON. |

Email, HTTP and HTTPS endpoints get a confirmation message and stay **pending**
until someone confirms. To confirm from the app, use **Confirm…** or **Confirm
with token…** and paste the token, or the whole `SubscribeURL`, from the
confirmation message. SNS deletes unconfirmed subscriptions after 3 days;
they can't be edited or removed before that.

**Edit…** changes a confirmed subscription's filter policy (and scope), raw
delivery, dead-letter queue, delivery policy or Firehose role; only changes
are sent. **All attributes** shows everything SNS reports for it.

**Unsubscribe…** (Del in the All subscriptions view) asks first.

## Publishing

**Publish** (or **Publish…** in a topic's right-click menu) opens a dialog
with two tabs.

**One message**

- Subject: optional, one line under 100 characters; used as the email subject.
- Message: any text. JSON is checked as you type, with Format / Minify. The
  byte count (message plus attributes) is compared with SNS's 256 KB limit.
- **Different message per protocol**: the message box becomes the default,
  and you add a message for any of sqs, lambda, http, https, email,
  email-json, sms and firehose. The app sends them as SNS's JSON message
  structure.
- Message attributes: up to 10, each String, String.Array (a JSON array such
  as `["a", "b"]`), Number or Binary (base64). Subscription filter policies
  match on these.
- FIFO topics: message group ID (required) and deduplication ID (required
  unless content-based deduplication is on).
- After publishing, the message ID is shown and **Publish again** keeps the
  form.

**From a file**: a JSON array, or JSON lines (one message per line). Choose
whether each item is:

- the message itself (objects are published as JSON text), or
- an envelope: `{"body": …, "subject": …, "messageStructure": "json",
  "attributes": [{"name", "dataType", "value"}], "groupId": …, "dedupId": …}`.

The subject and FIFO group ID boxes fill in for items without one. The dialog
shows how many messages the file has and the first few, then publishes them
10 per request and reports how many were published and which failed (by
position) and why.

## Watching messages

SNS doesn't keep messages, so the app watches a topic by subscribing a
temporary queue to it:

1. **Start watching** creates an SQS queue named `s3x-watch-<topic>-<id>`
   (FIFO for FIFO topics, tagged `created-by=nimbus-explorer-watch`, keeping
   messages for an hour), lets the topic send to it and subscribes it. Tick
   **Raw delivery** first to receive messages without the SNS envelope.
2. Messages published from then on appear in the list, newest first (the
   last 500). Select one to see the message as a tree or text, its
   attributes and, without raw delivery, the full SNS envelope. **Clear**
   empties the list.
3. **Stop watching**, opening another topic or place, or closing the app
   unsubscribes the queue and deletes it.

The temporary subscription counts towards the topic's subscriptions while you
watch. It has no filter policy, so it receives everything published to the
topic.

If the app was closed abruptly while watching, the queue is left behind. The
next time you open a topic, the watch panel says so and offers to remove it
(and its subscription).

## Read-only mode

With the toolbar lock on (on whenever you
connect), creating, editing and deleting topics, subscribing, confirming,
unsubscribing, publishing and starting a watch are disabled, and the app's
backend refuses them. Browsing still works. A watch that was already running
keeps working until you stop it, and it is still cleaned up.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Enter / double-click | Open topic |
| Ctrl+Shift+N | New topic |
| Ctrl+E | Edit topic settings |
| Del | Delete topic (unsubscribe in the All subscriptions view) |
| F5 | Refresh |

## Permissions

The profile needs these IAM actions (scope `Resource` to your topics):

- Browse: `sns:ListTopics`, `sns:GetTopicAttributes`,
  `sns:ListSubscriptions`, `sns:ListSubscriptionsByTopic`,
  `sns:ListTagsForResource`, `sns:GetDataProtectionPolicy`,
  `sns:GetSubscriptionAttributes`
- Manage topics: `sns:CreateTopic`, `sns:SetTopicAttributes`,
  `sns:DeleteTopic`, `sns:TagResource`, `sns:UntagResource`,
  `sns:PutDataProtectionPolicy`
- Subscriptions: `sns:Subscribe`, `sns:ConfirmSubscription`,
  `sns:Unsubscribe`, `sns:SetSubscriptionAttributes`; for "Allow this topic
  to send to the queue", `sqs:GetQueueUrl`, `sqs:GetQueueAttributes` and
  `sqs:SetQueueAttributes` on the queue
- Publish: `sns:Publish` (also covers batches)
- Watch: the subscription actions above plus `sqs:CreateQueue`,
  `sqs:TagQueue`, `sqs:GetQueueAttributes`, `sqs:SetQueueAttributes`,
  `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:DeleteQueue`,
  `sqs:ListQueues` and `sqs:ListQueueTags` on `s3x-watch-*` queues
- Encrypted topics: `kms:GenerateDataKey` and `kms:Decrypt` on the key for
  publishing (and for SNS to deliver to encrypted queues, a key policy that
  lets `sns.amazonaws.com` use it)
