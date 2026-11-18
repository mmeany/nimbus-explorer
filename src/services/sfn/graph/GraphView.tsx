// Graph tab: the state machine graph with a side panel for the selected
// state (its ASL and, in an execution, how it ran), a legend and Export SVG.
import { useMemo, useRef, useState } from "react";
import { api } from "../../../api/s3";
import { sfnApi, type MapRunRef } from "../../../api/sfn";
import { ValueView } from "../../../components/ValueView";
import { formatDate } from "../../../format";
import type { Shell } from "../../../shell/shell";
import { duration, PropsTable } from "../MachineView";
import { allStates, parseMachine, type RunStatus, type StateRun } from "./asl";
import { StateGraph, type StateGraphHandle } from "./StateGraph";

const STATUS_LABEL: Record<RunStatus, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  caught: "Failed, caught",
  aborted: "Stopped",
};

interface Props {
  shell: Shell;
  definition: string;
  /** Run status by state (execution view); null for the machine's own graph. */
  runs: Map<string, StateRun> | null;
  /** Shown above the graph when the history couldn't be read in full, etc. */
  note?: string | null;
  /** File name (without .svg) suggested for Export SVG. */
  exportName: string;
  /** Execution view: the Distributed Map runs it started, and how to open one. */
  mapRuns?: MapRunRef[];
  onOpenMapRun?: (arn: string) => void;
}

export function GraphView({ shell, definition, runs, note, exportName, mapRuns = [], onOpenMapRun }: Props) {
  const parsed = useMemo(() => parseMachine(definition), [definition]);
  const [selected, setSelected] = useState<string | null>(null);
  const graphRef = useRef<StateGraphHandle>(null);
  const states = useMemo(() => (parsed ? new Map(allStates(parsed.graph).map((n) => [n.name, n])) : new Map()), [parsed]);

  if (!parsed) return <div className="warn-note">The definition isn't valid JSON, so it can't be drawn.</div>;
  const node = selected ? states.get(selected) : undefined;
  const run = selected ? runs?.get(selected) : undefined;
  // A distributed Map's runs: from MapRunStarted events, else by its Label, else the only distributed Map.
  const distributed = [...states.values()].filter((n) => n.distributed);
  const nodeRuns = !node?.distributed
    ? []
    : run?.mapRuns.length
      ? mapRuns.filter((m) => run.mapRuns.includes(m.arn))
      : mapRuns.filter((m) => (typeof node.def?.Label === "string" ? m.label === node.def.Label : distributed.length === 1));

  async function exportSvg() {
    const svg = graphRef.current?.exportSvg();
    if (!svg) return;
    try {
      const path = await api.pickSaveAs("Export graph", `${exportName}.svg`);
      if (!path) return;
      await sfnApi.exportSvg(path, svg);
      shell.showFlash(`Saved ${path}.`);
    } catch (e) {
      shell.showError(e);
    }
  }

  return (
    <div className="sfn-graph-view">
      <div className="sfn-graph-main">
        <div className="row sfn-graph-bar">
          {runs ? (
            <span className="sfn-legend">
              {(["succeeded", "running", "failed", "caught"] as RunStatus[]).map((s) => (
                <span key={s} className={`sfn-key ${s}`}>
                  {STATUS_LABEL[s]}
                </span>
              ))}
              <span className="sfn-key">Not run</span>
            </span>
          ) : (
            <span className="hint">Click a state for its definition. Drag to move, wheel to zoom.</span>
          )}
          <div className="spacer" />
          <button className="btn small" onClick={() => void exportSvg()}>
            Export SVG…
          </button>
        </div>
        {note && <div className="hint">{note}</div>}
        {parsed.warnings.length > 0 && <div className="warn-note">{parsed.warnings.slice(0, 5).join(" ")}</div>}
        <StateGraph ref={graphRef} graph={parsed.graph} runs={runs} selected={selected} onSelect={setSelected} />
      </div>
      <div className="sfn-side">
        {!node ? (
          <p className="hint">{runs ? "Select a state to see how it ran: its input, output, errors and retries." : "Select a state to see its definition."}</p>
        ) : (
          <div className="lambda-details">
            <div className="qv-head">
              <span className="qv-name">{node.name}</span>
              <span className="qbadge">{node.type}</span>
            </div>
            {runs && <RunDetails run={run ?? null} />}
            {node.distributed && runs && (
              <>
                <div className="props-section">Map runs</div>
                {nodeRuns.length === 0 ? (
                  <p className="hint">None found for this state.</p>
                ) : (
                  nodeRuns.map((m) => (
                    <div key={m.arn} className="row">
                      <span className="mono">{m.label}</span>
                      <span className="hint">{m.stop ? "finished" : "running"}</span>
                      <div className="spacer" />
                      {onOpenMapRun && (
                        <button className="link-btn" onClick={() => onOpenMapRun(m.arn)}>
                          Open
                        </button>
                      )}
                    </div>
                  ))
                )}
              </>
            )}
            <div className="props-section">Definition</div>
            <ValueView value={JSON.stringify(node.def ?? {}, null, 2)} />
          </div>
        )}
      </div>
    </div>
  );
}

function RunDetails({ run }: { run: StateRun | null }) {
  if (!run) return <p className="hint">Didn't run (in the events read).</p>;
  return (
    <>
      <PropsTable
        rows={[
          ["Status", STATUS_LABEL[run.status]],
          ["Entered", run.entered > 1 ? `${run.entered} times (last ${formatDate(run.enteredAt)})` : formatDate(run.enteredAt)],
          ["Exited", formatDate(run.exitedAt)],
          ["Took", run.exitedAt ? duration(run.enteredAt, run.exitedAt) : null],
          ["Failed attempts", run.failures ? String(run.failures) : null],
        ]}
      />
      {(run.error || run.cause) && (
        <div className="warn-note">
          {run.error && <div className="mono">{run.error}</div>}
          {run.cause && <div className="selectable">{run.cause}</div>}
        </div>
      )}
      {run.input !== null && (
        <>
          <div className="props-section">Input</div>
          <ValueView value={run.input} />
        </>
      )}
      {run.output !== null && (
        <>
          <div className="props-section">Output</div>
          <ValueView value={run.output} />
        </>
      )}
    </>
  );
}
