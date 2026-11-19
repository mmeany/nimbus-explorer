// In-app help: one short Markdown topic per view, tab and larger dialog. Topic
// ids are checked by the compiler, so a view can't point at a missing topic.
// The longer guides for readers of the repository are in docs/.
import type { Place } from "../shell/places";
import { bookmarksTopics } from "./topics/bookmarks";
import { dynamodbTopics } from "./topics/dynamodb";
import { ecsTopics } from "./topics/ecs";
import { elasticacheTopics } from "./topics/elasticache";
import { generalTopics } from "./topics/general";
import { lambdaTopics } from "./topics/lambda";
import { logsTopics } from "./topics/logs";
import { rdsTopics } from "./topics/rds";
import { s3Topics } from "./topics/s3";
import { secretsTopics } from "./topics/secrets";
import { sfnTopics } from "./topics/sfn";
import { snsTopics } from "./topics/sns";
import { sqsTopics } from "./topics/sqs";
import { ssmTopics } from "./topics/ssm";

export interface HelpTopicText {
  title: string;
  /** Markdown, rendered by viewers/markdown.tsx. */
  body: string;
}

export const HELP_TOPICS = {
  ...generalTopics,
  ...bookmarksTopics,
  ...s3Topics,
  ...ssmTopics,
  ...sqsTopics,
  ...snsTopics,
  ...dynamodbTopics,
  ...rdsTopics,
  ...elasticacheTopics,
  ...ecsTopics,
  ...lambdaTopics,
  ...sfnTopics,
  ...logsTopics,
  ...secretsTopics,
};

export type HelpTopicId = keyof typeof HELP_TOPICS;

/** The topic for a place, before any tab or dialog has a say. */
export function placeTopic(p: Place): HelpTopicId {
  switch (p.service) {
    case "home":
      return "home";
    case "s3":
      return p.bucket ? "s3.folder" : "s3.buckets";
    case "ssm":
      return "ssm.browse";
    case "sqs":
      return p.queue ? "sqs.queue" : "sqs.queues";
    case "sns":
      return p.topic ? "sns.topic" : "sns.topics";
    case "dynamodb":
      return p.table ? "dynamodb.items" : "dynamodb.tables";
    case "rds":
      return p.id ? "rds.details" : "rds.databases";
    case "elasticache":
      return p.kind === "group" ? "elasticache.group" : p.kind === "serverless" ? "elasticache.serverless" : p.kind === "snapshots" ? "elasticache.snapshots" : p.kind === "users" ? "elasticache.users" : "elasticache.caches";
    case "ecs":
      if (p.view === "taskdefs") return p.id ? "ecs.family.details" : "ecs.taskdefs";
      if (p.view === "service") return "ecs.service.details";
      if (p.view === "task") return "ecs.task.details";
      return p.cluster ? "ecs.cluster.services" : "ecs.clusters";
    case "lambda":
      return p.fn ? "lambda.details" : "lambda.functions";
    case "sfn":
      if (p.view === "activities") return "sfn.activities";
      if (p.mapRun) return "sfn.maprun";
      if (p.execution) return "sfn.execution";
      return p.machine ? "sfn.machine" : "sfn.machines";
    case "logs":
      return p.group ? "logs.events" : "logs.groups";
    case "secrets":
      return "secrets.browse";
  }
}
