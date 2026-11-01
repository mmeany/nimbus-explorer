// SNS commands.
import { call } from "./core";

export interface TopicInfo {
  name: string;
  arn: string;
  fifo: boolean;
  displayName: string | null;
  confirmed: number | null;
  pending: number | null;
  deleted: number | null;
  kmsKey: string | null;
  contentBasedDedup: boolean;
  attributes: Record<string, string>;
  error: string | null;
}

export interface SubscriptionInfo {
  /** "PendingConfirmation" until confirmed. */
  arn: string;
  topicArn: string;
  protocol: string;
  endpoint: string;
  owner: string | null;
  pending: boolean;
}

export const snsApi = {
  /** Every topic ARN, sorted by name; attributes come per page from detailsMany. */
  listTopicArns: () => call<string[]>("sns_list_topic_arns"),
  detailsMany: (arns: string[]) => call<TopicInfo[]>("sns_details_many", { arns }),
  topicDetails: (arn: string) => call<TopicInfo>("sns_topic_details", { arn }),
  /** topicArn null = every subscription in the account / region. */
  listSubscriptions: (topicArn: string | null) => call<SubscriptionInfo[]>("sns_list_subscriptions", { topicArn }),
  listTags: (arn: string) => call<[string, string][]>("sns_list_tags", { arn }),
};

export function topicNameFromArn(arn: string): string {
  return arn.slice(arn.lastIndexOf(":") + 1);
}

export const snsWriteApi = {
  createTopic: (name: string, attributes: Record<string, string>, tags: [string, string][]) =>
    call<string>("sns_create_topic", { name, attributes, tags }),
  setTopicAttributes: (arn: string, attributes: Record<string, string>) => call<void>("sns_set_topic_attributes", { arn, attributes }),
  setTags: (arn: string, tags: [string, string][]) => call<void>("sns_set_tags", { arn, tags }),
  getDataProtectionPolicy: (arn: string) => call<string | null>("sns_get_data_protection_policy", { arn }),
  putDataProtectionPolicy: (arn: string, policy: string) => call<void>("sns_put_data_protection_policy", { arn, policy }),
  deleteTopic: (arn: string) => call<void>("sns_delete_topic", { arn }),
  subscribe: (topicArn: string, protocol: string, endpoint: string, attributes: Record<string, string>) =>
    call<string>("sns_subscribe", { topicArn, protocol, endpoint, attributes }),
  confirmSubscription: (topicArn: string, token: string, authenticateUnsubscribe: boolean) =>
    call<string>("sns_confirm_subscription", { topicArn, token, authenticateUnsubscribe }),
  unsubscribe: (arn: string) => call<void>("sns_unsubscribe", { arn }),
  subscriptionAttributes: (arn: string) => call<Record<string, string>>("sns_subscription_attributes", { arn }),
  setSubscriptionAttributes: (arn: string, attributes: Record<string, string>) => call<void>("sns_set_subscription_attributes", { arn, attributes }),
  /** Adds a queue-policy statement letting the topic send; false if one was there. */
  allowTopicOnQueue: (queueArn: string, topicArn: string) => call<boolean>("sns_allow_topic_on_queue", { queueArn, topicArn }),
};

/** Topic names: 1–256 letters, digits, - or _; FIFO names end in .fifo. */
export function topicNameProblem(name: string, fifo: boolean): string | null {
  if (fifo && !name.endsWith(".fifo")) return "FIFO topic names must end in .fifo";
  if (!fifo && name.endsWith(".fifo")) return "Only FIFO topics can end in .fifo";
  const base = fifo ? name.slice(0, -5) : name;
  if (!base || name.length > 256) return "Topic names must be 1 to 256 characters";
  if (!/^[A-Za-z0-9_-]+$/.test(base)) return "Use letters, digits, - and _ only";
  return null;
}

export const PROTOCOLS: { id: string; label: string; placeholder: string }[] = [
  { id: "sqs", label: "Amazon SQS", placeholder: "arn:aws:sqs:region:account:queue" },
  { id: "lambda", label: "AWS Lambda", placeholder: "arn:aws:lambda:region:account:function:name" },
  { id: "https", label: "HTTPS", placeholder: "https://example.com/hook" },
  { id: "http", label: "HTTP", placeholder: "http://example.com/hook" },
  { id: "email", label: "Email", placeholder: "someone@example.com" },
  { id: "email-json", label: "Email (JSON)", placeholder: "someone@example.com" },
  { id: "sms", label: "SMS", placeholder: "+447700900123" },
  { id: "firehose", label: "Amazon Data Firehose", placeholder: "arn:aws:firehose:region:account:deliverystream/name" },
  { id: "application", label: "Platform application endpoint", placeholder: "arn:aws:sns:region:account:endpoint/…" },
];

/** Same checks as the backend's endpoint_problem. */
export function endpointProblem(protocol: string, endpoint: string): string | null {
  const e = endpoint.trim();
  if (!e) return "Enter an endpoint";
  if (["sqs", "lambda", "firehose", "application"].includes(protocol) && !e.startsWith("arn:")) return `A ${protocol} endpoint is an ARN (arn:aws:…)`;
  if (protocol === "http" && !e.startsWith("http://")) return "HTTP endpoints start with http://";
  if (protocol === "https" && !e.startsWith("https://")) return "HTTPS endpoints start with https://";
  if ((protocol === "email" || protocol === "email-json") && !e.includes("@")) return "Enter an email address";
  if (protocol === "sms" && !e.startsWith("+")) return "Phone numbers use E.164 format, e.g. +447700900123";
  return null;
}

export interface PubMessage {
  body: string;
  subject?: string | null;
  /** "json": body is {"default": …, "<protocol>": …}. */
  messageStructure?: string | null;
  attributes: { name: string; dataType: string; value: string }[];
  groupId?: string | null;
  dedupId?: string | null;
}

export interface PublishReport {
  sent: number;
  failed: { index: number; message: string }[];
}

export const snsPublishApi = {
  publish: (topicArn: string, message: PubMessage) =>
    call<{ messageId: string; sequenceNumber: string | null }>("sns_publish", { topicArn, message }),
  publishBatch: (topicArn: string, messages: PubMessage[]) => call<PublishReport>("sns_publish_batch", { topicArn, messages }),
  /** envelope: each item is {body, subject, messageStructure, attributes, groupId, dedupId}. */
  previewFile: (path: string, envelope: boolean) => call<{ count: number; samples: string[] }>("sns_preview_file", { path, envelope }),
  publishFile: (topicArn: string, path: string, envelope: boolean, groupId: string | null, subject: string | null) =>
    call<PublishReport>("sns_publish_file", { topicArn, path, envelope, groupId, subject }),
};

export interface WatchInfo {
  id: string;
  topicArn: string;
  queueUrl: string;
  queueArn: string;
  subscriptionArn: string;
  raw: boolean;
}

export interface WatchedMessage {
  messageId: string;
  timestamp: string | null;
  subject: string | null;
  body: string;
  /** [name, type, value] */
  attributes: [string, string, string][];
  /** The full SNS JSON envelope (not with raw delivery). */
  envelope: string | null;
}

export const snsWatchApi = {
  start: (topicArn: string, raw: boolean) => call<WatchInfo>("sns_watch_start", { topicArn, raw }),
  /** Long-polls up to `wait` seconds; received messages are removed from the temporary queue. */
  poll: (id: string, wait: number) => call<WatchedMessage[]>("sns_watch_poll", { id, wait }),
  stop: (id: string) => call<void>("sns_watch_stop", { id }),
  leftovers: () => call<{ queueUrl: string; queueArn: string; subscriptionArns: string[] }[]>("sns_watch_leftovers"),
  cleanLeftovers: () => call<number>("sns_watch_clean_leftovers"),
};
