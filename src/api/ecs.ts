// ECS commands.
import { call } from "./core";

export interface Strategy {
  capacityProvider: string;
  weight: number;
  base: number;
}

export interface ClusterInfo {
  name: string;
  arn: string;
  status: string | null;
  activeServices: number;
  runningTasks: number;
  pendingTasks: number;
  containerInstances: number;
  capacityProviders: string[];
  defaultStrategy: Strategy[];
  containerInsights: string | null;
  tags: [string, string][];
}

export interface Deployment {
  id: string;
  status: string | null;
  taskDefinition: string;
  desired: number;
  running: number;
  pending: number;
  failed: number;
  rolloutState: string | null;
  rolloutReason: string | null;
  created: string | null;
  updated: string | null;
}

export interface ServiceInfo {
  name: string;
  arn: string;
  cluster: string;
  status: string | null;
  desired: number;
  running: number;
  pending: number;
  launchType: string | null;
  strategy: Strategy[];
  platformVersion: string | null;
  taskDefinition: string;
  deployments: Deployment[];
  events: { id: string; created: string | null; message: string }[];
  loadBalancers: { targetGroupArn: string | null; loadBalancerName: string | null; containerName: string | null; containerPort: number | null }[];
  subnets: string[];
  securityGroups: string[];
  publicIp: boolean | null;
  scheduling: string | null;
  maxPercent: number | null;
  minHealthyPercent: number | null;
  circuitBreaker: boolean | null;
  circuitBreakerRollback: boolean | null;
  execEnabled: boolean;
  healthCheckGraceSecs: number | null;
  created: string | null;
  role: string | null;
  registries: string[];
  tags: [string, string][];
}

export interface ContainerInfo {
  name: string;
  image: string | null;
  lastStatus: string | null;
  health: string | null;
  exitCode: number | null;
  reason: string | null;
  runtimeId: string | null;
  ports: string[];
}

export interface TaskInfo {
  id: string;
  arn: string;
  cluster: string;
  taskDefinition: string;
  lastStatus: string | null;
  desiredStatus: string | null;
  health: string | null;
  launchType: string | null;
  capacityProvider: string | null;
  cpu: string | null;
  memory: string | null;
  created: string | null;
  started: string | null;
  stopped: string | null;
  stoppedReason: string | null;
  stopCode: string | null;
  group: string | null;
  availabilityZone: string | null;
  privateIp: string | null;
  platformVersion: string | null;
  execEnabled: boolean;
  containers: ContainerInfo[];
  tags: [string, string][];
}

export const ecsApi = {
  listClusters: () => call<ClusterInfo[]>("ecs_list_clusters"),
  listServiceArns: (cluster: string) => call<string[]>("ecs_list_service_arns", { cluster }),
  services: (cluster: string, names: string[]) => call<ServiceInfo[]>("ecs_services", { cluster, names }),
  service: (cluster: string, name: string) => call<ServiceInfo>("ecs_service", { cluster, name }),
  /** Running tasks, or recently stopped ones; newest first (at most 1,000). */
  listTasks: (cluster: string, service: string | null, stopped: boolean) => call<TaskInfo[]>("ecs_list_tasks", { cluster, service, stopped }),
  task: (cluster: string, id: string) => call<TaskInfo>("ecs_task", { cluster, id }),
  families: (prefix: string, inactive = false) => call<string[]>("ecs_families", { prefix, inactive }),
  /** "family:rev", newest first. */
  revisions: (family: string, inactive = false) => call<string[]>("ecs_revisions", { family, inactive }),
  updateService: (cluster: string, service: string, change: { desired?: number | null; taskDefinition?: string | null; forceNewDeployment: boolean }) =>
    call<void>("ecs_update_service", { cluster, service, change }),
  stopTask: (cluster: string, task: string, reason: string) => call<void>("ecs_stop_task", { cluster, task, reason }),
  /** Returns the new tasks' ids. */
  runTask: (request: RunTaskRequest) => call<string[]>("ecs_run_task", { request }),
  splitCommand: (text: string) => call<string[]>("ecs_split_command", { text }),
  taskDefinition: (name: string) => call<TaskDefJson>("ecs_task_definition", { name }),
  /** Registers JSON as a new revision; returns "family:rev". */
  registerTaskDefinition: (json: string) => call<string>("ecs_register_task_definition", { json }),
  deregisterTaskDefinition: (name: string) => call<void>("ecs_deregister_task_definition", { name }),
};

export interface TaskDefJson {
  name: string;
  arn: string;
  status: string;
  /** As AWS returned it. */
  json: string;
  /** Read-only fields removed, tags included: ready to edit and register. */
  registerJson: string;
}

export interface RunTaskRequest {
  cluster: string;
  taskDefinition: string;
  count: number;
  launchType: "FARGATE" | "EC2" | null;
  capacityProvider: string | null;
  subnets: string[];
  securityGroups: string[];
  publicIp: boolean;
  container: string | null;
  command: string[] | null;
  env: [string, string][];
  exec: boolean;
}

/** "arn:…/name" → "name". */
export const shortArn = (arn: string) => arn.slice(arn.lastIndexOf("/") + 1);

/** How a service or task runs: "Fargate", "EC2", or its capacity providers. */
export function launchLabel(launchType: string | null, strategy: Strategy[] = [], capacityProvider: string | null = null): string {
  if (launchType === "FARGATE") return "Fargate";
  if (launchType === "EC2") return "EC2";
  if (launchType === "EXTERNAL") return "External";
  if (capacityProvider) return capacityProvider;
  return strategy.map((s) => s.capacityProvider).join(", ");
}

/** CSS tone for a status pill. */
export function ecsTone(status: string | null): "ok" | "busy" | "bad" | "off" {
  const s = (status ?? "").toUpperCase();
  if (s === "ACTIVE" || s === "RUNNING" || s === "HEALTHY" || s === "COMPLETED") return "ok";
  if (s === "FAILED" || s === "UNHEALTHY") return "bad";
  if (s === "STOPPED" || s === "INACTIVE" || s === "DEPROVISIONING" || s === "DRAINING") return "off";
  return "busy";
}
