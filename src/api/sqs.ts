// SQS commands.
import { call } from "./core";

export interface QueueInfo {
  name: string;
  url: string;
  arn: string | null;
  fifo: boolean;
  visible: number | null;
  inFlight: number | null;
  delayed: number | null;
  created: string | null;
  modified: string | null;
  /** Dead-letter queue this queue sends to. */
  dlqArn: string | null;
  maxReceiveCount: number | null;
  /** Another queue uses this one as its dead-letter queue. */
  isDlq: boolean;
  attributes: Record<string, string>;
  /** Attributes couldn't be read. */
  error: string | null;
}

export interface MsgAttribute {
  name: string;
  /** "String" | "Number" | "Binary", optionally with ".label". */
  dataType: string;
  /** Base64 for Binary. */
  value: string;
}

export interface OutMessage {
  body: string;
  attributes: MsgAttribute[];
  delaySeconds: number | null;
  groupId: string | null;
  dedupId: string | null;
}

export interface BatchReport {
  sent: number;
  failed: { index: number; message: string }[];
}

export interface InMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  md5OfBody: string | null;
  /** SentTimestamp, ApproximateReceiveCount, MessageGroupId, … */
  system: Record<string, string>;
  attributes: MsgAttribute[];
}

export interface HandleReport {
  done: number;
  failed: { index: number; message: string }[];
}

export interface MoveTask {
  taskHandle: string | null;
  /** RUNNING | COMPLETED | CANCELLING | CANCELLED | FAILED */
  status: string;
  sourceArn: string;
  destinationArn: string | null;
  moved: number;
  toMove: number | null;
  maxPerSecond: number | null;
  failureReason: string | null;
  started: string | null;
}

export interface QueueRef {
  name: string;
  url: string;
  arn: string;
}

export const sqsApi = {
  /** Every queue name (one call per 1,000); details come per page from detailsMany. */
  listRefs: (prefix: string) => call<QueueRef[]>("sqs_list_refs", { prefix }),
  detailsMany: (urls: string[]) => call<QueueInfo[]>("sqs_details_many", { urls }),
  queueDetails: (url: string) => call<QueueInfo>("sqs_queue_details", { url }),
  queueUrl: (name: string) => call<string>("sqs_queue_url", { name }),
  dlqSources: (url: string) => call<string[]>("sqs_dlq_sources", { url }),
  listTags: (url: string) => call<Record<string, string>>("sqs_list_tags", { url }),
  /** Returns the new queue's URL. */
  createQueue: (name: string, attributes: Record<string, string>, tags: Record<string, string>) =>
    call<string>("sqs_create_queue", { name, attributes, tags }),
  /** Only the attributes given change; "" clears RedrivePolicy / Policy. */
  setAttributes: (url: string, attributes: Record<string, string>) => call<void>("sqs_set_attributes", { url, attributes }),
  /** Makes the tags exactly `tags`. */
  setTags: (url: string, tags: Record<string, string>) => call<void>("sqs_set_tags", { url, tags }),
  deleteQueue: (url: string) => call<void>("sqs_delete_queue", { url }),
  /** SQS allows one purge per queue per 60 s. */
  purge: (url: string) => call<void>("sqs_purge", { url }),
  send: (url: string, message: OutMessage) => call<{ messageId: string; sequenceNumber: string | null }>("sqs_send", { url, message }),
  sendBatch: (url: string, messages: OutMessage[]) => call<BatchReport>("sqs_send_batch", { url, messages }),
  /** envelope: each item is {body, attributes, groupId, dedupId, delaySeconds}. */
  previewFile: (path: string, envelope: boolean) => call<{ count: number; samples: string[] }>("sqs_preview_file", { path, envelope }),
  sendFile: (url: string, path: string, envelope: boolean, groupId: string | null) =>
    call<BatchReport>("sqs_send_file", { url, path, envelope, groupId }),
  /** visibilityTimeout 0 = peek (released again right after collecting). */
  receive: (url: string, options: { max: number; visibilityTimeout: number; waitSeconds: number }) =>
    call<InMessage[]>("sqs_receive", { url, options }),
  deleteMessages: (url: string, receiptHandles: string[]) => call<HandleReport>("sqs_delete_messages", { url, receiptHandles }),
  /** 0 releases (makes visible) now. */
  changeVisibility: (url: string, receiptHandles: string[], seconds: number) =>
    call<HandleReport>("sqs_change_visibility", { url, receiptHandles, seconds }),
  exportMessages: (path: string, messages: InMessage[]) => call<number>("sqs_export_messages", { path, messages }),
  /** Returns the task handle. No destination = back to the source queues. */
  startRedrive: (dlqArn: string, destinationArn: string | null, maxPerSecond: number | null) =>
    call<string>("sqs_start_redrive", { dlqArn, destinationArn, maxPerSecond }),
  listRedrives: (dlqArn: string) => call<MoveTask[]>("sqs_list_redrives", { dlqArn }),
  cancelRedrive: (taskHandle: string) => call<number>("sqs_cancel_redrive", { taskHandle }),
  /** Receive → send → delete, for emulators or any queue pair. */
  moveMessages: (fromUrl: string, toUrl: string, toFifo: boolean, max: number) =>
    call<BatchReport>("sqs_move_messages", { fromUrl, toUrl, toFifo, max }),
};

/** Queue name from an ARN ("arn:aws:sqs:r:acct:name" → "name"). */
export function queueNameFromArn(arn: string | null): string | null {
  return arn ? arn.slice(arn.lastIndexOf(":") + 1) : null;
}

/** Queue name from a URL. */
export function queueNameFromUrl(url: string): string {
  return url.replace(/\/+$/, "").split("/").pop() ?? url;
}

/** 345600 → "4 days", 30 → "30 seconds". */
export function formatSeconds(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const s = Number(v);
  if (!Number.isFinite(s)) return String(v);
  const units: [number, string][] = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [n, name] of units) {
    if (s >= n && s % n === 0) return `${s / n} ${name}${s / n === 1 ? "" : "s"}`;
  }
  return `${s} second${s === 1 ? "" : "s"}`;
}
