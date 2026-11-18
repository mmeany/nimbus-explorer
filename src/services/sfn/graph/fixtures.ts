// Shared test data for the graph tests (not part of the app bundle: only the
// *.test.ts files import it).
import type { HistoryEvent } from "../../../api/sfn";

/** Choice, a loop, Parallel with an inline Map and a distributed Map, Catch, Fail, Succeed, and one bad transition. */
export const DEMO = {
  StartAt: "Validate",
  States: {
    Validate: {
      Type: "Task",
      Resource: "arn:aws:states:::lambda:invoke",
      Next: "Route",
      Retry: [{ ErrorEquals: ["States.ALL"] }],
      Catch: [{ ErrorEquals: ["States.ALL"], Next: "Notify" }],
    },
    Route: {
      Type: "Choice",
      Choices: [
        { Variable: "$.kind", StringEquals: "big", Next: "Fan" },
        { Condition: "{% $states.input.x > 1 %}", Next: "Wait" },
      ],
      Default: "Done",
    },
    Wait: { Type: "Wait", Seconds: 5, Next: "Validate" },
    Fan: {
      Type: "Parallel",
      Branches: [
        { StartAt: "A1", States: { A1: { Type: "Pass", Next: "A2" }, A2: { Type: "Pass", End: true } } },
        {
          StartAt: "B1",
          States: {
            B1: { Type: "Map", ItemProcessor: { ProcessorConfig: { Mode: "DISTRIBUTED" }, StartAt: "M1", States: { M1: { Type: "Pass", End: true } } }, End: true },
          },
        },
      ],
      Next: "Done",
    },
    Notify: { Type: "Task", Resource: "arn:aws:states:::sns:publish", Next: "Failed" },
    Failed: { Type: "Fail" },
    Done: { Type: "Succeed" },
    Orphan: { Type: "Pass", Next: "Missing" },
  },
};

/** Builds history events with ids 1, 2, … */
export function eventMaker() {
  let id = 0;
  return (type: string, prev: number | undefined, details?: Record<string, unknown>, key = "x"): HistoryEvent => {
    id += 1;
    const e: HistoryEvent = { id, type, timestamp: `2026-01-01T00:00:${String(id).padStart(2, "0")}Z` };
    if (prev !== undefined) e.previousEventId = prev;
    if (details) e[`${key}EventDetails`] = details;
    return e;
  };
}

/** Width estimate used instead of a canvas. */
export const measure = (t: string, bold: boolean) => t.length * (bold ? 7 : 6.5);
