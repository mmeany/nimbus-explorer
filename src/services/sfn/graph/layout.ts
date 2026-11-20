// Layered (top-to-bottom) layout for a state machine graph, in the spirit of
// Sugiyama: loops are found by DFS and drawn as back edges, states get ranks
// by longest path, long edges pass through dummy nodes, a few barycentre
// sweeps order each rank, then x positions follow the neighbours. Parallel /
// Map states are boxes that hold their own laid-out graphs.
import { isMarker, type EdgeKind, type GGraph, type GNode } from "./asl";

export interface Pt {
  x: number;
  y: number;
}

export interface LNode {
  id: string;
  node: GNode;
  /** Top-left, relative to the graph that holds it. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Parallel / Map drawn as a box with its branches inside (not collapsed). */
  expanded: boolean;
  inner: LGraph[];
}

export interface LEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label: string;
  points: Pt[];
  back: boolean;
  labelAt: Pt | null;
}

export interface LGraph {
  nodes: LNode[];
  edges: LEdge[];
  w: number;
  h: number;
  /** Offset inside the box that holds it (0 for the machine). */
  ox: number;
  oy: number;
}

export const NODE_H = 38;
export const MARKER = 22;
const MIN_W = 110;
const PAD_X = 14;
const RANK_GAP = 46;
const NODE_GAP = 28;
export const GROUP_HEAD = 26;
const GROUP_PAD = 14;
const BRANCH_GAP = 26;
const BACK_GAP = 18;
const DUMMY_W = 10;

export type Measure = (text: string, bold: boolean) => number;

/** Text width from a canvas when there is one; a character estimate otherwise. */
export function canvasMeasure(): Measure {
  const ctx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  const cache = new Map<string, number>();
  return (text, bold) => {
    const k = `${bold ? 1 : 0}${text}`;
    let w = cache.get(k);
    if (w === undefined) {
      if (ctx) {
        ctx.font = `${bold ? "600 " : ""}12px "Segoe UI", system-ui, sans-serif`;
        w = ctx.measureText(text).width;
      } else w = text.length * (bold ? 7 : 6.5);
      cache.set(k, w);
    }
    return w;
  };
}

interface Item {
  id: string;
  /** null for a dummy (a bend point of a long edge). */
  ln: LNode | null;
  w: number;
  h: number;
  rank: number;
  order: number;
  cx: number;
}

/** Lays out `g`; Parallel / Map states whose names are in `collapsed` are drawn as one box. */
export function layout(g: GGraph, collapsed: ReadonlySet<string>, measure: Measure): LGraph {
  // 1. Sizes (nested graphs first).
  const lnodes = new Map<string, LNode>();
  for (const n of g.nodes) {
    if (isMarker(n)) {
      lnodes.set(n.id, { id: n.id, node: n, x: 0, y: 0, w: MARKER, h: MARKER, expanded: false, inner: [] });
      continue;
    }
    const textW = Math.max(measure(n.name, true), measure(n.type, false) + (n.children.length ? 60 : 0));
    // Parallel / Map get room on both sides for the collapse toggle.
    const plainW = Math.max(MIN_W, Math.ceil(textW) + PAD_X * 2 + (n.children.length ? 40 : 0));
    if (n.children.length && !collapsed.has(n.name)) {
      const inner = n.children.map((c) => layout(c, collapsed, measure));
      const innerW = inner.reduce((s, x) => s + x.w, 0) + BRANCH_GAP * (inner.length - 1);
      const w = Math.max(plainW, innerW + GROUP_PAD * 2);
      let x = (w - innerW) / 2;
      for (const ig of inner) {
        ig.ox = x;
        ig.oy = GROUP_HEAD + 6;
        x += ig.w + BRANCH_GAP;
      }
      const h = GROUP_HEAD + 6 + Math.max(...inner.map((i) => i.h)) + GROUP_PAD;
      lnodes.set(n.id, { id: n.id, node: n, x: 0, y: 0, w, h, expanded: true, inner });
    } else {
      lnodes.set(n.id, { id: n.id, node: n, x: 0, y: 0, w: plainW, h: NODE_H, expanded: false, inner: [] });
    }
  }

  // 2. Back edges: an edge to a node still on the DFS stack closes a loop.
  const out = new Map<string, number[]>();
  g.edges.forEach((e, i) => out.set(e.from, [...(out.get(e.from) ?? []), i]));
  const back = new Set<number>();
  const visit = new Map<string, 1 | 2>();
  const dfsOrder: string[] = [];
  const dfs = (root: string) => {
    if (visit.has(root)) return;
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    visit.set(root, 1);
    dfsOrder.push(root);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const edges = out.get(top.id) ?? [];
      if (top.next >= edges.length) {
        visit.set(top.id, 2);
        stack.pop();
        continue;
      }
      const ei = edges[top.next++];
      const to = g.edges[ei].to;
      const st = visit.get(to);
      if (st === 1) back.add(ei);
      else if (!st) {
        visit.set(to, 1);
        dfsOrder.push(to);
        stack.push({ id: to, next: 0 });
      }
    }
  };
  dfs(g.start);
  for (const n of g.nodes) dfs(n.id);

  // 3. Ranks: longest path over forward edges; start alone on top, end at the bottom.
  const forward = g.edges.filter((e, i) => !back.has(i) && e.from !== e.to);
  const rank = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  const indeg = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  for (const e of forward) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = g.nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
  for (const id of queue) if (id !== g.start) rank.set(id, 1);
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of forward) {
      if (e.from !== id) continue;
      rank.set(e.to, Math.max(rank.get(e.to) ?? 0, (rank.get(id) ?? 0) + 1));
      indeg.set(e.to, (indeg.get(e.to) ?? 1) - 1);
      if (!indeg.get(e.to)) queue.push(e.to);
    }
  }
  const maxReal = Math.max(1, ...g.nodes.filter((n) => n.id !== g.end).map((n) => rank.get(n.id) ?? 0));
  rank.set(g.end, maxReal + 1);

  // 4. Items, with dummies along forward edges that skip ranks.
  const items = new Map<string, Item>();
  for (const n of g.nodes) {
    const ln = lnodes.get(n.id)!;
    items.set(n.id, { id: n.id, ln, w: ln.w, h: ln.h, rank: rank.get(n.id) ?? 0, order: 0, cx: 0 });
  }
  /** Per forward edge: the item ids it passes through, from → … → to. */
  const chains = new Map<GEdgeKey, string[]>();
  const links: [string, string][] = [];
  forward.forEach((e) => {
    const ids = [e.from];
    const r0 = items.get(e.from)!.rank;
    const r1 = items.get(e.to)!.rank;
    for (let r = r0 + 1; r < r1; r++) {
      const id = `\u0002${e.from}\u0001${e.to}\u0001${e.kind}\u0001${r}`;
      items.set(id, { id, ln: null, w: DUMMY_W, h: 0, rank: r, order: 0, cx: 0 });
      ids.push(id);
    }
    ids.push(e.to);
    for (let i = 1; i < ids.length; i++) links.push([ids[i - 1], ids[i]]);
    chains.set(edgeKey(e), ids);
  });

  // 5. Order within ranks: DFS order, then barycentre sweeps.
  const ranks: Item[][] = [];
  const dfsIndex = new Map(dfsOrder.map((id, i) => [id, i]));
  for (const it of items.values()) (ranks[it.rank] ??= []).push(it);
  for (let r = 0; r < ranks.length; r++) {
    ranks[r] ??= [];
    ranks[r].sort((a, b) => (dfsIndex.get(a.id.startsWith("\u0002") ? a.id.split("\u0001")[0].slice(1) : a.id) ?? 0) - (dfsIndex.get(b.id.startsWith("\u0002") ? b.id.split("\u0001")[0].slice(1) : b.id) ?? 0));
    ranks[r].forEach((it, i) => (it.order = i));
  }
  const ups = new Map<string, string[]>();
  const downs = new Map<string, string[]>();
  for (const [a, b] of links) {
    downs.set(a, [...(downs.get(a) ?? []), b]);
    ups.set(b, [...(ups.get(b) ?? []), a]);
  }
  const sweep = (dir: 1 | -1, key: (it: Item) => number) => {
    const start = dir === 1 ? 1 : ranks.length - 2;
    for (let r = start; r >= 0 && r < ranks.length; r += dir) {
      const row = ranks[r];
      const bary = new Map<string, number>();
      for (const it of row) {
        const nb = (dir === 1 ? ups : downs).get(it.id) ?? [];
        bary.set(it.id, nb.length ? nb.reduce((s, id) => s + key(items.get(id)!), 0) / nb.length : key(it));
      }
      row.sort((a, b) => bary.get(a.id)! - bary.get(b.id)! || a.order - b.order);
      row.forEach((it, i) => (it.order = i));
    }
  };
  for (let i = 0; i < 4; i++) {
    sweep(1, (it) => it.order);
    sweep(-1, (it) => it.order);
  }

  // 6. x: pack each rank, then pull towards neighbours (keeping order and gaps).
  const gap = (a: Item, b: Item) => a.w / 2 + b.w / 2 + (a.ln && b.ln ? NODE_GAP : NODE_GAP / 2);
  for (const row of ranks) {
    let x = 0;
    row.forEach((it, i) => {
      x = i === 0 ? it.w / 2 : x + gap(row[i - 1], it);
      it.cx = x;
    });
    const mid = x / 2;
    for (const it of row) it.cx -= mid;
  }
  const place = (row: Item[], desired: Map<string, number>) => {
    for (const it of row) if (desired.has(it.id)) it.cx = desired.get(it.id)!;
    for (let i = 1; i < row.length; i++) row[i].cx = Math.max(row[i].cx, row[i - 1].cx + gap(row[i - 1], row[i]));
    for (let i = row.length - 2; i >= 0; i--) row[i].cx = Math.min(row[i].cx, row[i + 1].cx - gap(row[i], row[i + 1]));
    for (let i = 1; i < row.length; i++) row[i].cx = Math.max(row[i].cx, row[i - 1].cx + gap(row[i - 1], row[i]));
  };
  const pull = (dir: 1 | -1) => {
    const start = dir === 1 ? 1 : ranks.length - 2;
    for (let r = start; r >= 0 && r < ranks.length; r += dir) {
      const desired = new Map<string, number>();
      for (const it of ranks[r]) {
        const nb = (dir === 1 ? ups : downs).get(it.id) ?? [];
        if (nb.length) desired.set(it.id, nb.reduce((s, id) => s + items.get(id)!.cx, 0) / nb.length);
      }
      place(ranks[r], desired);
    }
  };
  for (let i = 0; i < 3; i++) {
    pull(1);
    pull(-1);
  }
  pull(1);

  // 7. y per rank; shift so everything starts at x = 0.
  const tops: number[] = [];
  const heights: number[] = [];
  let y = 0;
  for (let r = 0; r < ranks.length; r++) {
    const h = Math.max(0, ...ranks[r].map((it) => it.h));
    tops[r] = y;
    heights[r] = h;
    y += h + RANK_GAP;
  }
  let height = y - RANK_GAP;
  const minX = Math.min(...[...items.values()].map((it) => it.cx - it.w / 2));
  for (const it of items.values()) it.cx -= minX;
  for (const it of items.values()) {
    if (!it.ln) continue;
    it.ln.x = it.cx - it.w / 2;
    it.ln.y = tops[it.rank] + (heights[it.rank] - it.h) / 2;
  }
  let width = Math.max(...[...items.values()].map((it) => it.cx + it.w / 2));

  // 8. Edges. Ports are spread along the bottom (out) and top (in) of a node.
  const outPorts = new Map<string, string[]>();
  const inPorts = new Map<string, string[]>();
  for (const e of forward) {
    const ids = chains.get(edgeKey(e))!;
    outPorts.set(e.from, [...(outPorts.get(e.from) ?? []), ids[1]]);
    inPorts.set(e.to, [...(inPorts.get(e.to) ?? []), ids[ids.length - 2]]);
  }
  const portX = (node: Item, list: string[] | undefined, other: string) => {
    if (!list || list.length < 2) return node.cx;
    const sorted = [...list].sort((a, b) => items.get(a)!.cx - items.get(b)!.cx);
    const i = sorted.indexOf(other);
    const step = Math.min(18, (node.w - 16) / (sorted.length - 1 || 1));
    return node.cx + (i - (sorted.length - 1) / 2) * step;
  };
  const edges: LEdge[] = [];
  let backLane = 0;
  g.edges.forEach((e, i) => {
    const a = items.get(e.from)!;
    const b = items.get(e.to)!;
    const ay = a.ln!.y;
    const by = b.ln!.y;
    if (e.from === e.to) {
      const x = a.cx + a.w / 2;
      const cy = ay + a.h / 2;
      edges.push({ ...e, back: true, points: [{ x, y: cy - 8 }, { x: x + 22, y: cy - 8 }, { x: x + 22, y: cy + 8 }, { x, y: cy + 8 }], labelAt: { x: x + 26, y: cy } });
      width = Math.max(width, x + 30);
      return;
    }
    if (back.has(i)) {
      const lane = width + BACK_GAP + backLane * 10;
      backLane++;
      const p0 = { x: a.cx + a.w / 2, y: ay + a.h / 2 };
      const p3 = { x: b.cx + b.w / 2, y: by + b.h / 2 };
      edges.push({ ...e, back: true, points: [p0, { x: lane, y: p0.y }, { x: lane, y: p3.y }, p3], labelAt: { x: lane + 4, y: (p0.y + p3.y) / 2 } });
      return;
    }
    const ids = chains.get(edgeKey(e))!;
    const pts: Pt[] = [{ x: portX(a, outPorts.get(e.from), ids[1]), y: ay + a.h }];
    for (const id of ids.slice(1, -1)) {
      const d = items.get(id)!;
      pts.push({ x: d.cx, y: tops[d.rank] }, { x: d.cx, y: tops[d.rank] + heights[d.rank] });
    }
    pts.push({ x: portX(b, inPorts.get(e.to), ids[ids.length - 2]), y: by });
    const labelAt = e.label ? { x: (pts[0].x + pts[1].x) / 2, y: pts[0].y + 14 } : null;
    edges.push({ ...e, back: false, points: pts, labelAt });
  });
  if (backLane) width += BACK_GAP + backLane * 10 + 4;
  height = Math.max(height, 0);
  return { nodes: [...lnodes.values()], edges, w: width, h: height, ox: 0, oy: 0 };
}

type GEdgeKey = string;
const edgeKey = (e: { from: string; to: string; kind: EdgeKind }): GEdgeKey => `${e.from}\u0001${e.to}\u0001${e.kind}`;

/** Path data for an edge: straight segments with rounded corners. */
export function edgePath(points: Pt[], radius = 8): string {
  if (points.length < 2) return "";
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1];
    const c = points[i];
    const n = points[i + 1];
    const d1 = Math.hypot(c.x - p.x, c.y - p.y);
    const d2 = Math.hypot(n.x - c.x, n.y - c.y);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (r < 0.5) {
      d += ` L${c.x},${c.y}`;
      continue;
    }
    const a = { x: c.x + ((p.x - c.x) * r) / d1, y: c.y + ((p.y - c.y) * r) / d1 };
    const b = { x: c.x + ((n.x - c.x) * r) / d2, y: c.y + ((n.y - c.y) * r) / d2 };
    d += ` L${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}
