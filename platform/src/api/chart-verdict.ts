import type { Definition } from "@/engine/definition";
import { chartOf } from "./words";
import { chartVerdict, type Layout } from "@/chart/pick";

export type { Layout };
/** D111: which layout a workflow definition gets on its page, and why neither draws it exactly when that is so. */
export async function definitionLayout(def: Definition): Promise<{ layout: Layout; problems: string[] }> {
  let chart;
  try { chart = chartOf(def, { name: "", timezone: "UTC" }); } catch (e) { return { layout: "list", problems: [`the chart could not be built: ${String((e as Error).message).slice(0, 160)}`] }; }
  return chartVerdict(chart);
}
// the graph layout draws any graph exactly, so no real definition reaches the refusal; tests stand a verdict in to prove it
let verdict = definitionLayout;
export const setChartVerdict = (f?: typeof definitionLayout) => { verdict = f ?? definitionLayout; };
export const chartLayoutOf = (def: Definition) => verdict(def);
/** The refusal every save gives when no layout draws the workflow exactly. */
export const notDrawable = (problems: string[]) => `its chart cannot be drawn exactly (${problems.length} problem${problems.length === 1 ? "" : "s"}): the workflow page could not show every step and every way it runs`;
