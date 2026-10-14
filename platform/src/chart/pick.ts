import type { Chart } from "@/api/words";
import { exactness, graphDrawing, tidyOf, type Exactness } from "./exact";
import { layoutGraph, type GraphLayout } from "./graph";
import type { Row } from "./arrange";

/**
 * D111's order of resort, the same on every page and on the server: the tidy layout when it is exact, else the plain graph
 * when it is exact, else (it should never happen) every step listed in order under a red line saying so.
 */
export type Layout = "tidy" | "graph" | "list";
export type Picked =
  | { layout: "tidy"; rows: Row[]; tidy: Exactness }
  | { layout: "graph"; graph: GraphLayout; tidy: Exactness; plain: Exactness }
  | { layout: "list"; tidy: Exactness; plain: Exactness };
export type Sizes = { size: (id: string) => { w: number; h: number }; labelSize: (text: string) => { w: number; h: number }; gap?: number };

/** Sizes for a check with no page: the boxes' size changes where things sit, never which lines join which boxes. */
const plainSizes: Sizes = { size: () => ({ w: 200, h: 44 }), labelSize: (t) => ({ w: Math.ceil(t.length * 6.4) + 8, h: 16 }) };

export async function pickLayout(chart: Chart, sizes: Sizes = plainSizes): Promise<Picked> {
  const t = tidyOf(chart);
  if (t.tidy.exact) return t;
  let graph: GraphLayout | null = null, plain: Exactness;
  try { graph = await layoutGraph(chart, sizes.size, sizes.labelSize, { gap: sizes.gap }); plain = exactness(chart, graphDrawing(graph)); }
  catch (e) { plain = { exact: false, problems: [`the graph layout failed: ${String((e as Error).message).slice(0, 160)}`] }; }
  if (graph && plain.exact) return { layout: "graph", graph, tidy: t.tidy, plain };
  return { layout: "list", tidy: t.tidy, plain };
}

/** For a save or the sweep: which layout a chart gets, and the problems when neither draws it exactly. */
export async function chartVerdict(chart: Chart): Promise<{ layout: Layout; problems: string[] }> {
  const p = await pickLayout(chart);
  return { layout: p.layout, problems: p.layout === "list" ? [...p.tidy.problems.map((x) => `tidy layout: ${x}`), ...p.plain.problems.map((x) => `graph layout: ${x}`)] : [] };
}
