// Container logs for an ECS task or service, using the shared CloudWatch Logs
// viewer, and the ECS Exec command to copy. Where the logs are comes from
// each container's awslogs settings in the task definition: the group, and
// the stream prefix (ECS names streams "prefix/container/task-id").
import { useEffect, useMemo, useState } from "react";
import type { AppError } from "../../api/core";
import { ecsApi } from "../../api/ecs";
import { ErrorPanel } from "../../components/ErrorPanel";
import type { Shell } from "../../shell/shell";
import { LogViewer } from "../logs/LogViewer";

export interface ContainerLog {
  container: string;
  driver: string | null;
  group: string | null;
  prefix: string | null;
  region: string | null;
}

/** Each container's log settings, from task definition JSON. */
export function containerLogs(json: string): ContainerLog[] {
  try {
    const d = JSON.parse(json) as { containerDefinitions?: { name?: string; logConfiguration?: { logDriver?: string; options?: Record<string, string> } }[] };
    return (d.containerDefinitions ?? []).map((c) => {
      const o = c.logConfiguration?.options ?? {};
      return { container: c.name ?? "", driver: c.logConfiguration?.logDriver ?? null, group: o["awslogs-group"] ?? null, prefix: o["awslogs-stream-prefix"] ?? null, region: o["awslogs-region"] ?? null };
    });
  } catch {
    return [];
  }
}

/** Logs of a task (one stream per container) or a service (all its tasks). */
export function ContainerLogs({ shell, taskDefinition, taskId, reloadToken }: { shell: Shell; taskDefinition: string; taskId: string | null; reloadToken: number }) {
  const [logs, setLogs] = useState<ContainerLog[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [container, setContainer] = useState("");
  useEffect(() => {
    let stale = false;
    setLogs(null);
    ecsApi
      .taskDefinition(taskDefinition)
      .then((t) => {
        if (stale) return;
        const l = containerLogs(t.json);
        setLogs(l);
        setContainer((c) => (l.some((x) => x.container === c) ? c : (l.find((x) => x.group)?.container ?? l[0]?.container ?? "")));
      })
      .catch((e) => !stale && setError(e as AppError));
    return () => {
      stale = true;
    };
  }, [taskDefinition]);

  const c = useMemo(() => logs?.find((x) => x.container === container) ?? null, [logs, container]);
  if (error) return <ErrorPanel error={error} profile={shell.profile} onRetry={() => setError(null)} />;
  if (!logs) return <p className="hint">Loading the task definition…</p>;
  if (!logs.length) return <p className="hint">The task definition has no containers.</p>;
  const region = shell.connection?.serviceRegion ?? "";
  const stream = c?.group && c.prefix && taskId ? `${c.prefix}/${c.container}/${taskId}` : null;
  const prefix = c?.group && c.prefix && !taskId ? `${c.prefix}/${c.container}/` : null;

  return (
    <div className="ecs-logs">
      <div className="row ecs-bar">
        <span className="hint">Container</span>
        <select className="text-input" value={container} onChange={(e) => setContainer(e.target.value)}>
          {logs.map((l) => (
            <option key={l.container} value={l.container}>
              {l.container}
              {l.group ? "" : l.driver ? ` (${l.driver})` : " (no logging)"}
            </option>
          ))}
        </select>
        {c?.group && <span className="hint mono">{c.group}</span>}
        {!taskId && c?.group && <span className="hint">· every task of the service</span>}
      </div>
      {!c?.driver ? (
        <p className="hint">This container has no log configuration, so its output isn't kept anywhere.</p>
      ) : !c.group ? (
        <p className="hint">This container logs with the {c.driver} driver, not to CloudWatch Logs, so its logs aren't shown here.</p>
      ) : c.region && region && c.region !== region ? (
        <div className="warn-note">
          The logs go to {c.region}, but the toolbar's region is {region}. Switch the region to {c.region} to see them.
        </div>
      ) : (
        <>
          {!c.prefix && <p className="hint">The container has no stream prefix, so its stream can't be picked out; showing the whole log group.</p>}
          <LogViewer key={`${c.group}|${stream ?? prefix ?? ""}`} shell={shell} group={c.group} streams={stream ? [stream] : []} streamPrefix={prefix} defaultMinutes={60} reloadToken={reloadToken} />
        </>
      )}
    </div>
  );
}

/** The `aws ecs execute-command` line for each container, and how to enable ECS Exec. */
export function ExecPanel({ shell, cluster, taskId, containers, enabled, service }: { shell: Shell; cluster: string; taskId: string; containers: string[]; enabled: boolean; service: string | null }) {
  const region = shell.connection?.serviceRegion ?? "";
  const profile = shell.connection?.profile;
  const tail = `--region ${region}${profile && profile !== "default" ? ` --profile ${profile}` : ""}`;
  const cmd = (c: string) => `aws ecs execute-command --cluster ${cluster} --task ${taskId} --container ${c} --interactive --command "/bin/sh" ${tail}`;
  return (
    <div className="lambda-details">
      <p>
        ECS Exec opens a shell inside a running container. The app can't host the session itself (it needs AWS's Session Manager plugin), so run one of these in a
        terminal with the AWS CLI and the{" "}
        <span className="mono">session-manager-plugin</span> installed.
      </p>
      {!enabled && (
        <div className="warn-note">
          ECS Exec isn't enabled for this task. Turn it on{service ? " for the service and start new tasks" : " when you run the task"}, then use a new task:
          {service && (
            <div className="row exec-row">
              <span className="mono selectable">{`aws ecs update-service --cluster ${cluster} --service ${service} --enable-execute-command --force-new-deployment ${tail}`}</span>
              <button className="link-btn" onClick={() => void shell.copyText(`aws ecs update-service --cluster ${cluster} --service ${service} --enable-execute-command --force-new-deployment ${tail}`)}>
                Copy
              </button>
            </div>
          )}
        </div>
      )}
      <table className="props-table connect-table">
        <tbody>
          {containers.map((c) => (
            <tr key={c}>
              <th>{c}</th>
              <td className="mono selectable">{cmd(c)}</td>
              <td className="copy-cell">
                <button className="link-btn" onClick={() => void shell.copyText(cmd(c))}>
                  Copy
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        The task role needs the ssmmessages permissions (CreateControlChannel, CreateDataChannel, OpenControlChannel, OpenDataChannel), and your profile needs
        ecs:ExecuteCommand. Use /bin/bash instead of /bin/sh if the image has it.
      </p>
    </div>
  );
}
