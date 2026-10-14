import type { Chart } from "@/api/words";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import { drawable } from "./arrange";

/**
 * D111: the plain graph, for a workflow the tidy layout cannot draw exactly (a cross-link into the middle of another
 * branch, a loop back, nesting past four, steps nothing reaches). ELK's layered layout places every node and routes every
 * edge of any directed graph: cycles are broken for the layering only and their edges routed back up, every edge keeps
 * its label. Loaded only when needed (it is large), in the browser and on the server alike.
 */
export type Box = { id: string; x: number; y: number; w: number; h: number };
export type GraphEdge = { id: string; from: string; to: string; label: string; else: boolean; points: { x: number; y: number }[]; at?: { x: number; y: number; w: number; h: number } };
export type GraphLayout = { w: number; h: number; nodes: Box[]; edges: GraphEdge[] };
type Size = { w: number; h: number };

let elk: Promise<{ layout(g: ElkNode): Promise<ElkNode> }> | null = null;
const engine = () => (elk ??= import("elkjs/lib/elk.bundled.js").then((m) => { const ELK = (m as unknown as { default: new () => { layout(g: ElkNode): Promise<ElkNode> } }).default; return new ELK(); }));

export async function layoutGraph(chart: Chart, size: (id: string) => Size, labelSize: (text: string) => Size, opts: { gap?: number } = {}): Promise<GraphLayout> {
  const ids = drawable(chart); const known = new Set(ids);
  const gap = opts.gap ?? 28;
  const edges = chart.edges.map((e, i) => ({ ...e, id: `e${i}` })).filter((e) => known.has(e.from) && known.has(e.to));
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": "DOWN", "elk.edgeRouting": "ORTHOGONAL",
      // the definition's own order first: steps keep the order they were written in where the graph allows it
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES", "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.spacing.nodeNode": String(gap), "elk.layered.spacing.nodeNodeBetweenLayers": String(gap + 6),
      "elk.spacing.edgeNode": "14", "elk.spacing.edgeEdge": "10", "elk.layered.spacing.edgeNodeBetweenLayers": "14",
      "elk.spacing.edgeLabel": "4", "elk.edgeLabels.placement": "CENTER", "elk.spacing.componentComponent": String(gap + 12),
      "elk.padding": "[top=4,left=4,bottom=4,right=4]",
    },
    children: ids.map((id) => { const s = size(id); return { id, width: s.w, height: s.h }; }),
    edges: edges.map((e): ElkExtendedEdge => ({ id: e.id, sources: [e.from], targets: [e.to], ...(e.label ? { labels: [{ text: e.label, width: labelSize(e.label).w, height: labelSize(e.label).h }] } : {}) })),
  };
  const out = await (await engine()).layout(graph);
  const nodes: Box[] = (out.children ?? []).map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0, w: n.width ?? 0, h: n.height ?? 0 }));
  const byId = new Map(edges.map((e) => [e.id, e]));
  const laid: GraphEdge[] = ((out.edges ?? []) as ElkExtendedEdge[]).map((le) => {
    const e = byId.get(le.id)!;
    const points = (le.sections ?? []).flatMap((s, i) => [...(i === 0 ? [s.startPoint] : []), ...(s.bendPoints ?? []), s.endPoint]).map((p) => ({ x: p.x, y: p.y }));
    const l = le.labels?.[0];
    return { id: le.id, from: le.sources[0], to: le.targets[0], label: l?.text ?? "", else: !!e.else, points, ...(l ? { at: { x: l.x ?? 0, y: l.y ?? 0, w: l.width ?? 0, h: l.height ?? 0 } } : {}) };
  });
  return { w: out.width ?? 0, h: out.height ?? 0, nodes, edges: laid };
}
