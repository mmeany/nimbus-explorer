// Amazon States Language → a graph of states and transitions, and the run
// status of each state from an execution's event history. State names are
// unique across the whole machine (ASL requires it), so they are the node ids;
// each (sub)graph also gets its own start and end markers.
import type { HistoryEvent } from "../../../api/sfn";

export type EdgeKind = "next" | "choice" | "default" | "catch";

export interface GNode {
  id: string;
  /** State name; "" for the start / end markers. */
  name: string;
  /** ASL type (Task, Choice, Parallel, Map, …), or "start" / "end". */
  type: string;
  /** Parallel: one graph per branch. Map: the item processor. */
  children: GGraph[];
  /** Distributed Map (ItemProcessor.ProcessorConfig.Mode = DISTRIBUTED). */
  distributed: boolean;
  /** The state's ASL. */
  def: Record<string, unknown> | null;
}

export interface GEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label: string;
}

export interface GGraph {
  /** "" for the machine, "<state>#<branch>" inside a Parallel / Map. */
  scope: string;
  nodes: GNode[];
  edges: GEdge[];
  start: string;
  end: string;
}

export interface ParsedMachine {
  graph: GGraph;
  /** Problems worth showing (unknown targets, missing StartAt). */
  warnings: string[];
}

const startId = (scope: string) => `${scope}\u0000start`;
const endId = (scope: string) => `${scope}\u0000end`;
export const isMarker = (n: GNode) => n.type === "start" || n.type === "end";

function short(s: string, max = 28): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A short label for one Choice rule. */
function choiceLabel(rule: Record<string, unknown>, i: number): string {
  if (typeof rule.Condition === "string") return short(rule.Condition.replace(/^\{%\s*|\s*%\}$/g, ""));
  const v = rule.Variable;
  const op = Object.keys(rule).find((k) => k !== "Variable" && k !== "Next" && k !== "Comment" && k !== "Assign" && k !== "Output");
  if (typeof v === "string" && op) {
    const val = rule[op];
    const shown = typeof val === "object" ? "…" : String(val);
    return short(`${v.replace(/^\$\./, "")} ${op.replace(/Path$/, "")} ${shown}`);
  }
  if (op === "And" || op === "Or" || op === "Not") return `rule ${i + 1} (${op.toLowerCase()})`;
  return `rule ${i + 1}`;
}

function errorsLabel(c: Record<string, unknown>): string {
  const e = Array.isArray(c.ErrorEquals) ? (c.ErrorEquals as unknown[]).map(String) : [];
  return short(e.join(", ") || "catch");
}

function parseGraph(machine: Record<string, unknown>, scope: string, warnings: string[]): GGraph {
  const states = (machine.States && typeof machine.States === "object" ? machine.States : {}) as Record<string, unknown>;
  const s0 = startId(scope);
  const e0 = endId(scope);
  const nodes: GNode[] = [{ id: s0, name: "", type: "start", children: [], distributed: false, def: null }];
  const edges: GEdge[] = [];
  const names = new Set(Object.keys(states));
  const link = (from: string, to: unknown, kind: EdgeKind, label = "") => {
    if (typeof to !== "string") return;
    if (!names.has(to)) {
      warnings.push(`"${from}" goes to "${to}", which isn't a state${scope ? " in its branch" : ""}.`);
      return;
    }
    edges.push({ from, to, kind, label });
  };

  for (const [name, raw] of Object.entries(states)) {
    const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const type = String(s.Type ?? "?");
    const children: GGraph[] = [];
    let distributed = false;
    if (type === "Parallel" && Array.isArray(s.Branches)) {
      (s.Branches as unknown[]).forEach((b, i) => {
        if (b && typeof b === "object") children.push(parseGraph(b as Record<string, unknown>, `${name}#${i}`, warnings));
      });
    }
    if (type === "Map") {
      const inner = (s.ItemProcessor ?? s.Iterator) as Record<string, unknown> | undefined;
      if (inner && typeof inner === "object") {
        children.push(parseGraph(inner, `${name}#0`, warnings));
        const cfg = inner.ProcessorConfig as Record<string, unknown> | undefined;
        distributed = cfg?.Mode === "DISTRIBUTED";
      }
    }
    nodes.push({ id: name, name, type, children, distributed, def: s });

    if (type === "Choice") {
      const rules = Array.isArray(s.Choices) ? (s.Choices as Record<string, unknown>[]) : [];
      rules.forEach((r, i) => r && link(name, r.Next, "choice", choiceLabel(r, i)));
      link(name, s.Default, "default", "default");
    } else if (type === "Succeed" || type === "Fail" || s.End === true) {
      edges.push({ from: name, to: e0, kind: "next", label: "" });
    } else {
      link(name, s.Next, "next");
    }
    if (Array.isArray(s.Catch)) {
      for (const c of s.Catch as Record<string, unknown>[]) if (c) link(name, c.Next, "catch", errorsLabel(c));
    }
  }
  nodes.push({ id: e0, name: "", type: "end", children: [], distributed: false, def: null });

  const startAt = machine.StartAt;
  if (typeof startAt === "string" && names.has(startAt)) edges.unshift({ from: s0, to: startAt, kind: "next", label: "" });
  else warnings.push(scope ? `A branch of "${scope.split("#")[0]}" has no valid StartAt.` : "The definition has no valid StartAt.");

  // Two edges between the same states (e.g. two choice rules) are drawn once.
  const seen = new Map<string, GEdge>();
  for (const e of edges) {
    const k = `${e.from}\u0001${e.to}\u0001${e.kind === "catch" ? "c" : "n"}`;
    const prev = seen.get(k);
    if (prev) prev.label = prev.label && e.label ? short(`${prev.label}; ${e.label}`, 40) : prev.label || e.label;
    else seen.set(k, { ...e });
  }
  return { scope, nodes, edges: [...seen.values()], start: s0, end: e0 };
}

/** Parses a definition; null when it isn't a JSON object. */
export function parseMachine(definition: string): ParsedMachine | null {
  let asl: unknown;
  try {
    asl = JSON.parse(definition);
  } catch {
    return null;
  }
  if (!asl || typeof asl !== "object" || Array.isArray(asl)) return null;
  const warnings: string[] = [];
  return { graph: parseGraph(asl as Record<string, unknown>, "", warnings), warnings };
}

/** Every state node of a graph and its nested graphs. */
export function allStates(g: GGraph): GNode[] {
  const out: GNode[] = [];
  const walk = (x: GGraph) => {
    for (const n of x.nodes) {
      if (isMarker(n)) continue;
      out.push(n);
      n.children.forEach(walk);
    }
  };
  walk(g);
  return out;
}

// ---------------------------------------------------------------------------
// Run status from the event history

export type RunStatus = "running" | "succeeded" | "failed" | "caught" | "aborted";

export interface StateRun {
  status: RunStatus;
  /** How many times the state was entered (Map iterations, loops). */
  entered: number;
  /** Failed attempts (retries included). */
  failures: number;
  input: string | null;
  output: string | null;
  error: string | null;
  cause: string | null;
  enteredAt: string | null;
  exitedAt: string | null;
  /** Distributed Map: ARNs of the map runs it started (MapRunStarted events). */
  mapRuns: string[];
}

const isFailure = (t: string) => /(Failed|TimedOut|Aborted)$/.test(t) && !t.startsWith("Execution") && t !== "FailStateEntered";

function details(e: HistoryEvent): Record<string, unknown> {
  for (const [k, v] of Object.entries(e)) if (k.endsWith("EventDetails") && v && typeof v === "object") return v as Record<string, unknown>;
  return {};
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** "ParallelStateFailed" → "Parallel" (events about a Parallel / Map state itself carry no name). */
const compoundEvent = (t: string) => /^(Parallel|Map)State(Started|Succeeded|Failed|Aborted)$/.exec(t)?.[1] ?? null;

/**
 * The latest status of every state that ran, by state name. A failure is
 * pinned on the state whose StateEntered event it descends from
 * (previousEventId; emulators that leave it out fall back to event order, and
 * Parallel / Map events to the innermost one still open); a state whose
 * failure led straight to another state being entered was caught.
 */
export function runStatus(events: HistoryEvent[]): Map<string, StateRun> {
  const byId = new Map<number, HistoryEvent>();
  const index = new Map<number, number>();
  events.forEach((e, i) => {
    byId.set(e.id, e);
    index.set(e.id, i);
  });
  const prevOf = (e: HistoryEvent): HistoryEvent | undefined => {
    if (e.previousEventId) return byId.get(e.previousEventId);
    if (e.previousEventId === 0) return undefined;
    const i = index.get(e.id);
    return i ? events[i - 1] : undefined;
  };
  const runs = new Map<string, StateRun>();
  /** Failure event id → the state it belongs to. */
  const failedState = new Map<number, string>();
  /** States entered and not yet exited, innermost last, with their event prefix ("Task", "Parallel", …). */
  const open: { name: string; kind: string }[] = [];
  const close = (name: string) => {
    const i = open.map((o) => o.name).lastIndexOf(name);
    if (i >= 0) open.splice(i, 1);
  };

  const ownerOf = (e: HistoryEvent): string | null => {
    const named = str(details(e).name);
    if (named) return named;
    const kind = compoundEvent(e.type);
    if (kind) return [...open].reverse().find((o) => o.kind === kind)?.name ?? null;
    let cur: HistoryEvent | undefined = e;
    for (let hops = 0; cur && hops < 10_000; hops++) {
      if (cur.type.endsWith("StateEntered")) return str(details(cur).name);
      cur = prevOf(cur);
    }
    return open[open.length - 1]?.name ?? null;
  };

  for (const e of events) {
    const d = details(e);
    if (e.type.endsWith("StateEntered")) {
      const name = str(d.name);
      if (!name) continue;
      if (e.type !== "FailStateEntered") open.push({ name, kind: e.type.slice(0, -"StateEntered".length) });
      // Entered straight after a failure (or after the failed state exited): the failure was caught.
      const p = prevOf(e);
      const prev = p ? (failedState.get(p.id) ?? (p.type.endsWith("StateExited") ? str(details(p).name) : null)) : null;
      if (prev && prev !== name) {
        const r = runs.get(prev);
        if (r && r.status === "failed") {
          r.status = "caught";
          close(prev);
        }
      }
      const r = runs.get(name);
      const status: RunStatus = e.type === "FailStateEntered" ? "failed" : "running";
      if (r) Object.assign(r, { status, entered: r.entered + 1, input: str(d.input) ?? r.input, enteredAt: e.timestamp });
      else runs.set(name, { status, entered: 1, failures: 0, input: str(d.input), output: null, error: null, cause: null, enteredAt: e.timestamp, exitedAt: null, mapRuns: [] });
      if (e.type === "FailStateEntered") {
        const def = runs.get(name)!;
        def.exitedAt = e.timestamp;
      }
    } else if (e.type === "MapRunStarted" || e.type === "MapRunRedriven") {
      const arn = str(d.mapRunArn);
      const name = arn ? ownerOf(e) : null;
      const r = name ? runs.get(name) : undefined;
      if (r && arn && !r.mapRuns.includes(arn)) r.mapRuns.push(arn);
    } else if (e.type.endsWith("StateExited")) {
      const name = str(d.name);
      if (name) close(name);
      const r = name ? runs.get(name) : undefined;
      if (r) Object.assign(r, { status: r.status === "failed" || r.status === "aborted" ? r.status : "succeeded", output: str(d.output), exitedAt: e.timestamp });
    } else if (/Succeeded$/.test(e.type) && !e.type.startsWith("Execution") && !e.type.startsWith("MapIteration") && !compoundEvent(e.type)) {
      // A retry that worked: the state is running again until it exits.
      const name = ownerOf(e);
      const r = name ? runs.get(name) : undefined;
      if (r && r.status === "failed") r.status = "running";
    } else if (isFailure(e.type)) {
      const name = ownerOf(e);
      const r = name ? runs.get(name) : undefined;
      if (!name || !r) continue;
      failedState.set(e.id, name);
      r.failures += 1;
      r.status = e.type.endsWith("Aborted") ? "aborted" : "failed";
      r.error = str(d.error) ?? r.error;
      r.cause = str(d.cause) ?? r.cause;
    } else if (e.type === "ExecutionFailed" || e.type === "ExecutionAborted" || e.type === "ExecutionTimedOut") {
      // Whatever was still running stops with the execution.
      for (const r of runs.values()) {
        if (r.status !== "running") continue;
        r.status = e.type === "ExecutionFailed" ? "failed" : "aborted";
        r.error = r.error ?? str(d.error);
        r.cause = r.cause ?? str(d.cause);
      }
    }
  }
  return runs;
}

/**
 * The item processor (as a definition) of the distributed Map whose Label (or
 * name) is `label`, or of the only distributed Map; null if none matches. Used
 * for a map run's child execution when the endpoint can't describe it.
 */
export function itemProcessorDefinition(definition: string, label: string): string | null {
  const parsed = parseMachine(definition);
  if (!parsed) return null;
  const maps = allStates(parsed.graph).filter((n) => n.distributed);
  const pick = maps.find((n) => (typeof n.def?.Label === "string" ? n.def.Label : n.name) === label) ?? (maps.length === 1 ? maps[0] : undefined);
  const inner = pick?.def ? ((pick.def.ItemProcessor ?? pick.def.Iterator) as Record<string, unknown> | undefined) : undefined;
  if (!inner) return null;
  const rest = { ...inner };
  delete rest.ProcessorConfig;
  return JSON.stringify(rest, null, 2);
}
