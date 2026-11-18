import { describe, expect, it } from "vitest";
import { definitionStates, executionArn, executionNameProblem, statusTone } from "./sfn";

describe("executionNameProblem", () => {
  it("accepts names AWS accepts and blank (AWS picks one)", () => {
    expect(executionNameProblem("")).toBeNull();
    expect(executionNameProblem("order-42_retry.1")).toBeNull();
  });
  it("refuses what AWS refuses", () => {
    expect(executionNameProblem("a b")).toBe("Execution names can't contain spaces");
    expect(executionNameProblem("a:b")).toBe('Execution names can\'t contain ":"');
    expect(executionNameProblem("a\\b")).toBe('Execution names can\'t contain "\\"');
    expect(executionNameProblem("a\tb")).toBe("Execution names can't contain spaces");
    expect(executionNameProblem("a\u0001b")).toBe('Execution names can\'t contain "\u0001"');
    expect(executionNameProblem("x".repeat(81))).toBe("Execution names are at most 80 characters");
  });
});

describe("helpers", () => {
  it("builds execution ARNs from machine ARNs", () => {
    expect(executionArn("arn:aws:states:eu-west-2:1:stateMachine:orders", "run-1")).toBe("arn:aws:states:eu-west-2:1:execution:orders:run-1");
  });
  it("gives statuses a tone", () => {
    expect([statusTone("SUCCEEDED"), statusTone("TIMED_OUT"), statusTone("RUNNING"), statusTone(null)]).toEqual(["ok", "bad", "busy", "off"]);
  });
  it("lists states for the states table, nested ones with their path", () => {
    const d = definitionStates(JSON.stringify({ StartAt: "P", QueryLanguage: "JSONata", States: { P: { Type: "Parallel", Branches: [{ StartAt: "A", States: { A: { Type: "Pass", End: true } } }], End: true } } }))!;
    expect(d.queryLanguage).toBe("JSONata");
    expect(d.rows.map((r) => [r.name, r.path, r.next])).toEqual([
      ["P", "", "(end)"],
      ["A", "P › branch 1", "(end)"],
    ]);
    expect(definitionStates("{")).toBeNull();
  });
});
