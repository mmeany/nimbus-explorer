// CloudWatch Logs commands (read only; downloads write local files).
import { call } from "./core";

export interface LogGroup {
  name: string;
  arn: string | null;
  storedBytes: number | null;
  retentionDays: number | null;
  created: string | null;
  kmsKey: string | null;
  /** STANDARD or INFREQUENT_ACCESS. */
  class: string | null;
  metricFilters: number | null;
}

export interface LogStream {
  name: string;
  created: string | null;
  firstEvent: string | null;
  lastEvent: string | null;
}

export interface LogEvent {
  id: string;
  /** Milliseconds since 1970. */
  time: number;
  stream: string;
  message: string;
}

export interface EventsRequest {
  group: string;
  /** Exact stream names (at most 100); empty = every stream. */
  streams: string[];
  streamPrefix?: string | null;
  pattern?: string | null;
  startMs: number;
  endMs?: number | null;
  maxEvents: number;
}

export interface LatestPage {
  /** Oldest first. */
  events: LogEvent[];
  /** Search again with this as endMs for older events; null = start of the range reached. */
  olderEnd: number | null;
}

export const logsApi = {
  listGroups: (prefix: string, token: string | null, pageSize: number) =>
    call<{ groups: LogGroup[]; nextToken: string | null }>("logs_list_groups", { prefix, token, pageSize }),
  describeGroup: (name: string) => call<LogGroup>("logs_describe_group", { name }),
  listStreams: (group: string, prefix: string, token: string | null, pageSize: number) =>
    call<{ streams: LogStream[]; nextToken: string | null }>("logs_list_streams", { group, prefix, token, pageSize }),
  /** The newest matching events in the range. */
  latest: (request: EventsRequest) => call<LatestPage>("logs_latest", { request }),
  /** Every matching event, oldest first, to a text file; returns the count. */
  download: (request: EventsRequest, dest: string) => call<number>("logs_download", { request, dest }),
};

/** "Never expire" or "30 days". */
export function retentionLabel(days: number | null): string {
  if (!days) return "Never expire";
  if (days % 365 === 0) return `${days / 365} year${days === 365 ? "" : "s"}`;
  return `${days} day${days === 1 ? "" : "s"}`;
}
