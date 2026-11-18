import { describe, expect, it } from "vitest";
import type { HistoryEvent } from "../../../api/sfn";
import { allStates, parseMachine, runStatus } from "./asl";
import { DEMO, eventMaker } from "./fixtures";

describe("parseMachine", () => {
  const p = parseMachine(JSON.stringify(DEMO))!;

  it("adds start and end markers to every graph", () => {
    expect(p.graph.nodes.filter((n) => n.type === "start" || n.type === "end")).toHaveLength(2);
    expect(p.graph.nodes).toHaveLength(10);
    const fan = p.graph.nodes.find((n) => n.name === "Fan")!;
    expect(fan.children).toHaveLength(2);
    expect(fan.children[0].nodes.map((n) => n.type)).toEqual(["start", "Pass", "Pass", "end"]);
  });

  it("lists every state, nested ones included", () => {
    expect(allStates(p.graph).map((n) => n.name).sort()).toEqual(["A1", "A2", "B1", "Done", "Failed", "Fan", "M1", "Notify", "Orphan", "Route", "Validate", "Wait"]);
  });

  it("labels choice rules (JSONPath and JSONata), defaults and catches", () => {
    const e = p.graph.edges;
    expect(e).toContainEqual({ from: "Route", to: "Fan", kind: "choice", label: "kind StringEquals big" });
    expect(e).toContainEqual({ from: "Route", to: "Wait", kind: "choice", label: "$states.input.x > 1" });
    expect(e).toContainEqual({ from: "Route", to: "Done", kind: "default", label: "default" });
    expect(e).toContainEqual({ from: "Validate", to: "Notify", kind: "catch", label: "States.ALL" });
  });

  it("sends terminal states to the end marker", () => {
    const end = p.graph.end;
    for (const name of ["Failed", "Done"]) expect(p.graph.edges.some((e) => e.from === name && e.to === end)).toBe(true);
  });

  it("marks distributed maps", () => {
    const b1 = p.graph.nodes.find((n) => n.name === "Fan")!.children[1].nodes.find((n) => n.name === "B1")!;
    expect(b1.distributed).toBe(true);
  });

  it("warns about transitions to missing states and drops them", () => {
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0]).toContain('"Missing"');
    expect(p.graph.edges.some((e) => e.from === "Orphan")).toBe(false);
  });

  it("merges duplicate edges between the same states", () => {
    const g = parseMachine(JSON.stringify({ StartAt: "C", States: { C: { Type: "Choice", Choices: [{ Variable: "$.a", BooleanEquals: true, Next: "D" }, { Variable: "$.b", BooleanEquals: true, Next: "D" }], Default: "D" }, D: { Type: "Succeed" } } }))!;
    const choice = g.graph.edges.filter((e) => e.from === "C" && e.kind !== "default");
    expect(choice).toHaveLength(1);
    // Merged labels are cut to 40 characters.
    expect(choice[0].label).toBe("a BooleanEquals true; b BooleanEquals t…");
  });

  it("rejects anything that isn't a JSON object", () => {
    expect(parseMachine("nope")).toBeNull();
    expect(parseMachine("[1]")).toBeNull();
    expect(parseMachine("null")).toBeNull();
  });

  it("warns when StartAt is missing", () => {
    expect(parseMachine(JSON.stringify({ States: { A: { Type: "Succeed" } } }))!.warnings).toEqual(["The definition has no valid StartAt."]);
  });
});

describe("runStatus", () => {
  it("shows a retried task that then succeeded as succeeded, with the failed attempt counted", () => {
    const ev = eventMaker();
    const h = [
      ev("ExecutionStarted", 0, {}, "executionStarted"),
      ev("TaskStateEntered", 1, { name: "Validate", input: '{"a":1}' }, "stateEntered"),
      ev("TaskScheduled", 2),
      ev("TaskFailed", 3, { error: "Boom", cause: "c1" }, "taskFailed"),
      ev("TaskScheduled", 4),
      ev("TaskSucceeded", 5),
      ev("TaskStateExited", 6, { name: "Validate", output: '{"b":2}' }, "stateExited"),
    ];
    const v = runStatus(h).get("Validate")!;
    expect(v).toMatchObject({ status: "succeeded", failures: 1, entered: 1, input: '{"a":1}', output: '{"b":2}', error: "Boom", cause: "c1" });
  });

  it("marks a failure that moved straight on to another state as caught", () => {
    const ev = eventMaker();
    const h = [
      ev("ExecutionStarted", 0, {}, "executionStarted"),
      ev("TaskStateEntered", 1, { name: "Notify" }, "stateEntered"),
      ev("TaskScheduled", 2),
      ev("TaskFailed", 3, { error: "SnsDown" }, "taskFailed"),
      ev("FailStateEntered", 4, { name: "Failed" }, "stateEntered"),
      ev("ExecutionFailed", 5, { error: "SnsDown" }, "executionFailed"),
    ];
    const r = runStatus(h);
    expect(r.get("Notify")).toMatchObject({ status: "caught", error: "SnsDown" });
    expect(r.get("Failed")!.status).toBe("failed");
  });

  it("leaves a state running until it exits, and stops it with the execution", () => {
    const ev = eventMaker();
    const h = [ev("ExecutionStarted", 0, {}, "executionStarted"), ev("TaskStateEntered", 1, { name: "Slow" }, "stateEntered"), ev("TaskScheduled", 2)];
    expect(runStatus(h).get("Slow")!.status).toBe("running");
    expect(runStatus([...h, ev("ExecutionAborted", 3, {}, "executionAborted")]).get("Slow")!.status).toBe("aborted");
    const failed = runStatus([...h.slice(0, 3), { ...ev("ExecutionFailed", 3, { error: "States.Timeout" }, "executionFailed") }]).get("Slow")!;
    expect(failed).toMatchObject({ status: "failed", error: "States.Timeout" });
  });

  it("pins a Parallel's own failure on the Parallel, not on a state in its branch", () => {
    const ev = eventMaker();
    const h = [
      ev("ExecutionStarted", 0, {}, "executionStarted"), // 1
      ev("ParallelStateEntered", 1, { name: "Work" }, "stateEntered"), // 2
      ev("ParallelStateStarted", 2), // 3
      ev("PassStateEntered", 3, { name: "Fine" }, "stateEntered"), // 4
      ev("ChoiceStateEntered", 3, { name: "Check" }, "stateEntered"), // 5
      ev("PassStateExited", 4, { name: "Fine" }, "stateExited"), // 6
      ev("ChoiceStateExited", 5, { name: "Check" }, "stateExited"), // 7
      ev("FailStateEntered", 7, { name: "Boom" }, "stateEntered"), // 8
      ev("ParallelStateFailed", 8), // 9
      ev("PassStateEntered", 9, { name: "Recover" }, "stateEntered"), // 10
      ev("PassStateExited", 10, { name: "Recover" }, "stateExited"), // 11
    ];
    const r = runStatus(h);
    expect(r.get("Work")!.status).toBe("caught");
    expect(r.get("Boom")!.status).toBe("failed");
    expect(r.get("Fine")!.status).toBe("succeeded");
    expect(r.get("Recover")!.status).toBe("succeeded");
  });

  it("falls back to event order when previousEventId is missing (MiniStack)", () => {
    const h = [
      { id: 1, type: "ExecutionStarted", timestamp: "t" },
      { id: 2, type: "TaskStateEntered", timestamp: "t", stateEnteredEventDetails: { name: "Call" } },
      { id: 3, type: "TaskScheduled", timestamp: "t" },
      { id: 4, type: "TaskFailed", timestamp: "t", taskFailedEventDetails: { error: "E" } },
      { id: 5, type: "PassStateEntered", timestamp: "t", stateEnteredEventDetails: { name: "Handle" } },
      { id: 6, type: "PassStateExited", timestamp: "t", stateExitedEventDetails: { name: "Handle" } },
    ] as HistoryEvent[];
    expect(runStatus(h).get("Call")).toMatchObject({ status: "caught", error: "E" });
  });

  it("counts loop and Map iterations and pins iteration failures on the Map", () => {
    const ev = eventMaker();
    const loop = [
      ev("ExecutionStarted", 0, {}, "executionStarted"),
      ev("PassStateEntered", 1, { name: "Loop" }, "stateEntered"),
      ev("PassStateExited", 2, { name: "Loop" }, "stateExited"),
      ev("PassStateEntered", 3, { name: "Loop" }, "stateEntered"),
      ev("PassStateExited", 4, { name: "Loop" }, "stateExited"),
    ];
    expect(runStatus(loop).get("Loop")).toMatchObject({ status: "succeeded", entered: 2 });
    const map = [
      { id: 1, previousEventId: 0, type: "MapStateEntered", timestamp: "t", stateEnteredEventDetails: { name: "Each" } },
      { id: 2, previousEventId: 1, type: "MapIterationFailed", timestamp: "t", mapIterationFailedEventDetails: { name: "Each", index: 2 } },
      { id: 3, previousEventId: 2, type: "MapStateFailed", timestamp: "t" },
      { id: 4, previousEventId: 3, type: "ExecutionFailed", timestamp: "t", executionFailedEventDetails: { error: "States.Runtime" } },
    ] as HistoryEvent[];
    expect(runStatus(map).get("Each")!.status).toBe("failed");
  });
});
