import { describe, expect, it } from "vitest";
import { aliasNameProblem, definitionStates, executionArn, executionNameProblem, executionPlaceName, isChildExecution, logGroupArn, mapRunArn, statusTone } from "./sfn";

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
  it("builds execution ARNs from machine ARNs, map run children included", () => {
    const m = "arn:aws:states:eu-west-2:1:stateMachine:orders";
    expect(executionArn(m, "run-1")).toBe("arn:aws:states:eu-west-2:1:execution:orders:run-1");
    expect(executionArn(m, "Fan:9f6e")).toBe("arn:aws:states:eu-west-2:1:execution:orders/Fan:9f6e");
    expect(isChildExecution("Fan:9f6e")).toBe(true);
    expect(isChildExecution("run-1")).toBe(false);
  });
  it("turns execution ARNs back into place names", () => {
    expect(executionPlaceName("arn:aws:states:eu-west-2:1:execution:orders:run-1")).toBe("run-1");
    expect(executionPlaceName("arn:aws:states:eu-west-2:1:execution:orders/Fan:9f6e")).toBe("Fan:9f6e");
    expect(executionPlaceName("arn:aws:states:eu-west-2:1:execution:orders/Process items:9f6e")).toBe("Process items:9f6e");
  });
  it("builds map run ARNs", () => {
    expect(mapRunArn("arn:aws:states:eu-west-2:1:stateMachine:orders", "Fan:3526")).toBe("arn:aws:states:eu-west-2:1:mapRun:orders/Fan:3526");
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

describe("logGroupArn", () => {
  const m = "arn:aws:states:eu-west-2:123456789012:stateMachine:orders";
  it("builds an ARN from a name in the machine's account and region", () => {
    expect(logGroupArn(m, " /aws/vendedlogs/states/orders ")).toBe("arn:aws:logs:eu-west-2:123456789012:log-group:/aws/vendedlogs/states/orders:*");
    expect(logGroupArn("arn:aws-cn:states:cn-north-1:1:stateMachine:x", "g")).toBe("arn:aws-cn:logs:cn-north-1:1:log-group:g:*");
  });
  it("keeps ARNs and empty values as they are", () => {
    const arn = "arn:aws:logs:eu-west-2:1:log-group:g:*";
    expect(logGroupArn(m, arn)).toBe(arn);
    expect(logGroupArn(m, "  ")).toBe("");
  });
});

describe("aliasNameProblem", () => {
  it("follows AWS's alias rules", () => {
    expect(aliasNameProblem("live")).toBeNull();
    expect(aliasNameProblem("prod-v2.1_b")).toBeNull();
    expect(aliasNameProblem("")).not.toBeNull();
    expect(aliasNameProblem("12")).toContain("only digits");
    expect(aliasNameProblem("a b")).not.toBeNull();
    expect(aliasNameProblem("a".repeat(81))).not.toBeNull();
  });
});
