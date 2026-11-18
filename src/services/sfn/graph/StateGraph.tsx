// The state machine graph as SVG: pan (drag), zoom (wheel, buttons), fit,
// collapsible Parallel / Map boxes, click a state to select it, and states
// coloured by their run status in an execution. Colours are theme tokens
// (inline `var(--sfn-…)` styles); an exported SVG gets the resolved values.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isMarker, type GGraph, type RunStatus, type StateRun } from "./asl";
import { canvasMeasure, edgePath, GROUP_HEAD, layout, type LEdge, type LGraph, type LNode } from "./layout";

const MARGIN = 24;
/** Room under the graph for the zoom buttons when fitting. */
const BOTTOM = 44;
const MIN_SCALE = 0.1;
const MAX_SCALE = 2.5;

const FILL: Record<RunStatus, string> = {
  running: "var(--sfn-run-bg)",
  succeeded: "var(--sfn-ok-bg)",
  failed: "var(--sfn-bad-bg)",
  caught: "var(--sfn-caught-bg)",
  aborted: "var(--sfn-bad-bg)",
};
const STROKE: Record<RunStatus, string> = {
  running: "var(--sfn-run)",
  succeeded: "var(--sfn-ok)",
  failed: "var(--sfn-bad)",
  caught: "var(--sfn-caught)",
  aborted: "var(--sfn-bad)",
};

export interface StateGraphHandle {
  /** A standalone SVG document of the whole graph (theme colours resolved). */
  exportSvg: () => string;
}

interface Props {
  graph: GGraph;
  runs: Map<string, StateRun> | null;
  selected: string | null;
  onSelect: (name: string | null) => void;
}

export const StateGraph = forwardRef<StateGraphHandle, Props>(function StateGraph({ graph, runs, selected, onSelect }, ref) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const measure = useMemo(() => canvasMeasure(), []);
  const lg = useMemo(() => layout(graph, collapsed, measure), [graph, collapsed, measure]);
  const boxRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<SVGGElement>(null);
  const [view, setView] = useState({ s: 1, tx: MARGIN, ty: MARGIN });
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** Until the user pans or zooms, the graph keeps fitting the pane. */
  const touched = useRef(false);

  const fit = useCallback(() => {
    const { w, h } = size;
    if (!w || !h) return;
    const s = Math.max(MIN_SCALE, Math.min(1, (w - MARGIN * 2) / Math.max(1, lg.w), (h - MARGIN - BOTTOM) / Math.max(1, lg.h)));
    setView({ s, tx: (w - lg.w * s) / 2, ty: Math.max(MARGIN, (h - BOTTOM + MARGIN - lg.h * s) / 2) });
  }, [size, lg.w, lg.h]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!touched.current) fit();
  }, [fit]);
  useEffect(() => {
    touched.current = false;
  }, [graph]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    touched.current = true;
    setView((v) => {
      const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.s * factor));
      const k = s / v.s;
      return { s, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });
  }, []);

  // Wheel zoom needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false };
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    d.moved = true;
    touched.current = true;
    setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }));
  }
  function onPointerUp(e: React.PointerEvent) {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) return;
    // A click: on a state selects it, on a box's toggle collapses it, elsewhere clears.
    const t = (e.target as Element).closest("[data-toggle], [data-state]");
    const toggle = t?.getAttribute("data-toggle");
    if (toggle) {
      setCollapsed((c) => {
        const n = new Set(c);
        if (n.has(toggle)) n.delete(toggle);
        else n.add(toggle);
        return n;
      });
      return;
    }
    onSelect(t?.getAttribute("data-state") ?? null);
  }

  useImperativeHandle(ref, () => ({
    exportSvg: () => {
      const g = contentRef.current;
      if (!g) return "";
      const w = Math.ceil(lg.w + MARGIN * 2);
      const h = Math.ceil(lg.h + MARGIN * 2);
      const inner = g.innerHTML;
      const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="font-family: 'Segoe UI', system-ui, sans-serif; font-size: 12px"><defs>${defsMarkup()}</defs><rect width="100%" height="100%" style="fill: var(--pane)"/><g transform="translate(${MARGIN},${MARGIN})">${inner}</g></svg>`;
      const css = getComputedStyle(document.documentElement);
      return `<?xml version="1.0" encoding="UTF-8"?>\n${doc.replace(/var\((--[\w-]+)\)/g, (_, name: string) => css.getPropertyValue(name).trim() || "currentColor")}`;
    },
  }));

  const states = graph.nodes.filter((n) => !isMarker(n)).length;
  return (
    <div className="sfn-graph">
      <div
        ref={boxRef}
        className="sfn-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
      >
        <svg width="100%" height="100%" role="img" aria-label={`State machine graph with ${states} states`}>
          <defs dangerouslySetInnerHTML={{ __html: defsMarkup() }} />
          <g transform={`translate(${view.tx},${view.ty}) scale(${view.s})`}>
            <g ref={contentRef}>
              <GraphBody lg={lg} runs={runs} selected={selected} collapsed={collapsed} />
            </g>
          </g>
        </svg>
      </div>
      <div className="sfn-zoom">
        <button className="btn small" title="Zoom out" onClick={() => zoomAt(1 / 1.25, size.w / 2, size.h / 2)}>
          −
        </button>
        <button className="btn small" title="Zoom in" onClick={() => zoomAt(1.25, size.w / 2, size.h / 2)}>
          +
        </button>
        <button
          className="btn small"
          title="Fit the graph in the pane"
          onClick={() => {
            touched.current = false;
            fit();
          }}
        >
          Fit
        </button>
        <button className="btn small" title="Actual size" onClick={() => zoomAt(1 / view.s, size.w / 2, size.h / 2)}>
          100%
        </button>
        {collapsed.size > 0 && (
          <button className="btn small" title="Expand every Parallel and Map state" onClick={() => setCollapsed(new Set())}>
            Expand all
          </button>
        )}
      </div>
    </div>
  );
});

/** Arrowheads (plain and for catch edges). Written as markup so an export can reuse it. */
function defsMarkup(): string {
  const head = (id: string, colour: string) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: ${colour}"/></marker>`;
  return head("sfn-arrow", "var(--sfn-edge)") + head("sfn-arrow-catch", "var(--sfn-edge-catch)");
}

function GraphBody({ lg, runs, selected, collapsed }: { lg: LGraph; runs: Map<string, StateRun> | null; selected: string | null; collapsed: Set<string> }) {
  return (
    <>
      {lg.edges.map((e, i) => (
        <Edge key={`e${i}`} e={e} />
      ))}
      {lg.nodes.map((n) => (
        <Node key={n.id} n={n} runs={runs} selected={selected} collapsed={collapsed} />
      ))}
    </>
  );
}

function Edge({ e }: { e: LEdge }) {
  const catchEdge = e.kind === "catch";
  return (
    <g>
      <path
        d={edgePath(e.points)}
        style={{ fill: "none", stroke: catchEdge ? "var(--sfn-edge-catch)" : "var(--sfn-edge)", strokeWidth: 1.2, strokeDasharray: catchEdge ? "5 3" : e.kind === "default" ? "2 3" : undefined }}
        markerEnd={`url(#${catchEdge ? "sfn-arrow-catch" : "sfn-arrow"})`}
      />
      {e.label && e.labelAt && (
        <text
          x={e.labelAt.x}
          y={e.labelAt.y}
          textAnchor={e.back ? "start" : "middle"}
          style={{ fontSize: 10, fill: catchEdge ? "var(--sfn-edge-catch)" : "var(--muted)", stroke: "var(--pane)", strokeWidth: 3, paintOrder: "stroke" }}
        >
          {e.label}
        </text>
      )}
    </g>
  );
}

function Node({ n, runs, selected, collapsed }: { n: LNode; runs: Map<string, StateRun> | null; selected: string | null; collapsed: Set<string> }) {
  const g = n.node;
  if (g.type === "start" || g.type === "end") {
    const r = n.w / 2;
    return (
      <g transform={`translate(${n.x + r},${n.y + r})`}>
        {/* Only the machine's own Start / End are labelled (branch scopes contain "#"). */}
        <circle r={r} style={{ fill: g.type === "start" ? "var(--sfn-terminal)" : "var(--pane)", stroke: "var(--sfn-terminal)", strokeWidth: 1.5 }} />
        {g.type === "end" && <circle r={r - 5} style={{ fill: "var(--sfn-terminal)" }} />}
        {!n.id.includes("#") && (
          <text y={g.type === "start" ? -r - 4 : r + 13} textAnchor="middle" style={{ fontSize: 10, fill: "var(--muted)" }}>
            {g.type === "start" ? "Start" : "End"}
          </text>
        )}
      </g>
    );
  }
  const run = runs?.get(g.name);
  const isSel = selected === g.name;
  const fill = run ? FILL[run.status] : "var(--sfn-node-bg)";
  const stroke = isSel ? "var(--sfn-sel)" : run ? STROKE[run.status] : "var(--sfn-node-border)";
  const compound = g.children.length > 0;
  const extra = [run && run.entered > 1 ? `×${run.entered}` : "", run && run.failures ? `${run.failures} failed` : "", g.distributed ? "distributed" : ""].filter(Boolean).join(" · ");

  if (n.expanded) {
    return (
      <g transform={`translate(${n.x},${n.y})`}>
        <rect width={n.w} height={n.h} rx={8} style={{ fill: "var(--sfn-group-bg)", stroke: isSel ? "var(--sfn-sel)" : run ? STROKE[run.status] : "var(--sfn-group-border)", strokeWidth: isSel ? 2 : 1 }} />
        <g data-state={g.name} style={{ cursor: "pointer" }}>
          <rect width={n.w} height={GROUP_HEAD} rx={8} style={{ fill: run ? fill : "transparent" }} />
          <text x={30} y={17} style={{ fontWeight: 600, fontSize: 12, fill: "var(--text)" }}>
            {g.name}
          </text>
          <text x={n.w - 10} y={17} textAnchor="end" style={{ fontSize: 10, fill: "var(--muted)" }}>
            {[g.type, extra].filter(Boolean).join(" · ")}
          </text>
        </g>
        <Toggle name={g.name} open />
        {n.inner.map((ig, i) => (
          <g key={i} transform={`translate(${ig.ox},${ig.oy})`}>
            <GraphBody lg={ig} runs={runs} selected={selected} collapsed={collapsed} />
          </g>
        ))}
      </g>
    );
  }
  return (
    <g transform={`translate(${n.x},${n.y})`} data-state={g.name} style={{ cursor: "pointer" }}>
      <rect width={n.w} height={n.h} rx={6} style={{ fill, stroke, strokeWidth: isSel ? 2 : 1.1, strokeDasharray: compound ? "4 2" : undefined }} />
      <text x={n.w / 2} y={16} textAnchor="middle" style={{ fontWeight: 600, fontSize: 12, fill: "var(--text)" }}>
        {g.name}
      </text>
      <text x={n.w / 2} y={30} textAnchor="middle" style={{ fontSize: 10, fill: "var(--muted)" }}>
        {[g.type, compound ? `${g.children.length > 1 ? `${g.children.length} branches` : "items"}` : "", extra].filter(Boolean).join(" · ")}
      </text>
      {compound && <Toggle name={g.name} open={false} />}
    </g>
  );
}

function Toggle({ name, open }: { name: string; open: boolean }) {
  return (
    <g data-toggle={name} transform="translate(8,5)" style={{ cursor: "pointer" }}>
      <title>{open ? "Collapse" : "Expand"}</title>
      <rect width={16} height={16} rx={3} style={{ fill: "var(--pane)", stroke: "var(--sfn-group-border)" }} />
      <path d={open ? "M4,8 H12" : "M4,8 H12 M8,4 V12"} style={{ stroke: "var(--text)", strokeWidth: 1.4 }} />
    </g>
  );
}
