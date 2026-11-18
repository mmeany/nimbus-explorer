import { describe, expect, it } from "vitest";
import { parseMachine } from "./asl";
import { DEMO, measure } from "./fixtures";
import { edgePath, layout, type LGraph, type LNode } from "./layout";

const graph = parseMachine(JSON.stringify(DEMO))!.graph;

function overlaps(nodes: LNode[]): [string, string][] {
  const out: [string, string][] = [];
  for (const a of nodes) for (const b of nodes) if (a.id < b.id && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push([a.id, b.id]);
  return out;
}

/** Checks every graph, nested ones too. */
function eachGraph(g: LGraph, f: (g: LGraph) => void) {
  f(g);
  for (const n of g.nodes) for (const inner of n.inner) eachGraph(inner, f);
}

describe("layout", () => {
  const lg = layout(graph, new Set(), measure);
  const byId = new Map(lg.nodes.map((n) => [n.id, n]));

  it("puts Start on top, End at the bottom and states in transition order", () => {
    const start = lg.nodes.find((n) => n.node.type === "start")!;
    const end = lg.nodes.find((n) => n.node.type === "end")!;
    for (const n of lg.nodes) {
      if (n !== start) expect(n.y).toBeGreaterThan(start.y);
      if (n !== end) expect(n.y).toBeLessThan(end.y);
    }
    expect(byId.get("Validate")!.y).toBeLessThan(byId.get("Route")!.y);
    expect(byId.get("Route")!.y).toBeLessThan(byId.get("Done")!.y);
  });

  it("draws the loop as one back edge", () => {
    const back = lg.edges.filter((e) => e.back);
    expect(back.map((e) => [e.from, e.to])).toEqual([["Wait", "Validate"]]);
  });

  it("keeps nodes apart and inside the bounds, in every nested graph", () => {
    eachGraph(lg, (g) => {
      expect(overlaps(g.nodes)).toEqual([]);
      for (const n of g.nodes) {
        expect(n.x).toBeGreaterThanOrEqual(-0.01);
        expect(n.x + n.w).toBeLessThanOrEqual(g.w + 0.01);
        expect(n.y + n.h).toBeLessThanOrEqual(g.h + 0.01);
      }
      for (const e of g.edges) {
        expect(e.points.length).toBeGreaterThanOrEqual(2);
        for (const p of e.points) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      }
    });
  });

  it("draws Parallel as a box around its branches, and as one box when collapsed", () => {
    const fan = byId.get("Fan")!;
    expect(fan.expanded).toBe(true);
    expect(fan.inner).toHaveLength(2);
    expect(fan.w).toBeGreaterThan(fan.inner[0].w + fan.inner[1].w);
    const collapsed = layout(graph, new Set(["Fan"]), measure).nodes.find((n) => n.id === "Fan")!;
    expect(collapsed.expanded).toBe(false);
    expect(collapsed.inner).toEqual([]);
  });

  it("routes long edges around the ranks they skip", () => {
    // Fan → Done skips no rank, Route → Done (default) skips Fan's rank: it bends through a dummy.
    const def = lg.edges.find((e) => e.from === "Route" && e.kind === "default")!;
    expect(def.points.length).toBeGreaterThan(2);
  });

  it("lays out a 400-state machine quickly", () => {
    const big: { StartAt: string; States: Record<string, unknown> } = { StartAt: "S0", States: {} };
    for (let i = 0; i < 400; i++) {
      big.States[`S${i}`] = i < 399 ? { Type: "Pass", Next: `S${i + 1}`, ...(i % 7 ? {} : { Catch: [{ ErrorEquals: ["x"], Next: `S${Math.min(399, i + 30)}` }] }) } : { Type: "Succeed" };
    }
    const t0 = performance.now();
    const out = layout(parseMachine(JSON.stringify(big))!.graph, new Set(), measure);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(overlaps(out.nodes)).toEqual([]);
  });
});

describe("edgePath", () => {
  it("rounds corners and ends on the last point", () => {
    expect(edgePath([{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 20, y: 20 }])).toBe("M0,0 L0,12 Q0,20 8,20 L20,20");
    expect(edgePath([{ x: 1, y: 2 }])).toBe("");
  });
});
