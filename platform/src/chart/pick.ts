import type { Chart } from "@/api/words";
import { arrange, type Row } from "./arrange";
import { exactness, graphGeometry, svgDrawing, type Exactness } from "./exact";
import { layoutGraph, type GraphLayout } from "./graph";
import { draw, drawGraph, graphMax, graphSizes, type St } from "./draw";

/**
 * D111's order of resort, the same on every page and on the server: the tidy chart when its SVG is exactly the workflow,
 * else the plain graph when its SVG is, else (it should never happen) every step listed in order under a line saying so.
 * A view is the page's: its width, a run's states, and on a phone with a run, only the path the run took.
 */
export type Layout = "tidy" | "graph" | "list";
export type View = { width: number; stateOf?: (id: string) => St | null; pathOnly?: boolean };
export type Shown = { svg: string; check: Exactness; pan?: boolean; start?: number };
/** tidy / plain: the layout's whole drawing in this view, which decides the layout; shown: what the page puts up. */
export type Picked =
  | { layout: "tidy"; rows: Row[]; tidy: Exactness; shown: Shown }
  | { layout: "graph"; graph: GraphLayout; tidy: Exactness; plain: Exactness; shown: Shown }
  | { layout: "list"; tidy: Exactness; plain: Exactness };
export type Sizes = { size: (id: string) => { w: number; h: number }; labelSize: (text: string) => { w: number; h: number }; gap?: number };

const none = () => null;
export const narrowAt = (width: number) => width < 600;

/** The tidy chart in a view, checked from its own SVG; when the view leaves a run's untaken groups out, the whole drawing too. */
export function tidyView(chart: Chart, rows: Row[], v: View): { tidy: Exactness; shown: Shown } {
  const svg = draw(rows, v.width, v.stateOf ?? none, !!v.pathOnly);
  const check = exactness(chart, svgDrawing(svg));
  if (!check.filtered) return { tidy: check, shown: { svg, check } };
  return { tidy: exactness(chart, svgDrawing(draw(rows, v.width, v.stateOf ?? none, false))), shown: { svg, check } };
}
export function tidyOf(chart: Chart, v: View = { width: 1000 }) {
  const rows = arrange(chart);
  return { layout: "tidy" as const, rows, ...tidyView(chart, rows, v) };
}

export async function pickLayout(chart: Chart, v: View = { width: 1000 }): Promise<Picked> {
  const t = tidyOf(chart, v);
  if (t.tidy.exact && t.shown.check.exact) return t;
  let graph: GraphLayout | null = null, plain: Exactness, shown: Shown | null = null;
  try {
    const narrow = narrowAt(v.width); const s = graphSizes(chart, narrow);
    graph = await layoutGraph(chart, s.size, s.labelSize, { gap: s.gap });
    const g = drawGraph(graph, chart, v.width, graphMax(narrow), v.stateOf ?? none); const d = svgDrawing(g.svg);
    plain = exactness(chart, { ...d, problems: [...(d.problems ?? []), ...graphGeometry(graph)] });
    shown = { svg: g.svg, check: plain, pan: g.pan, start: g.start };
  } catch (e) { plain = { exact: false, problems: [`the graph layout failed: ${String((e as Error).message).slice(0, 160)}`] }; }
  if (graph && shown && plain.exact) return { layout: "graph", graph, tidy: t.tidy, plain, shown };
  return { layout: "list", tidy: t.tidy, plain };
}

/**
 * For a save or the sweep: which layout a chart gets, and the problems when neither draws it exactly. Checked at a
 * laptop's width and a phone's, with no run (a run's view only dims and badges what this draws: chart-views.test).
 */
export async function chartVerdict(chart: Chart): Promise<{ layout: Layout; problems: string[] }> {
  const views = [await pickLayout(chart, { width: 1000 }), await pickLayout(chart, { width: 358 })];
  const bad = views.find((p) => p.layout === "list");
  if (bad && bad.layout === "list") return { layout: "list", problems: [...bad.tidy.problems.map((x) => `tidy layout: ${x}`), ...bad.plain.problems.map((x) => `graph layout: ${x}`)] };
  return { layout: views.every((p) => p.layout === "tidy") ? "tidy" : "graph", problems: [] };
}
