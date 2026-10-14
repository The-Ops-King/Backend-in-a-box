import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { chartOf, type Chart } from "@/api/words";
import { parseDefinition, type Definition } from "@/engine/definition";
import { templates } from "@/templates";
import { exactness, realOf, svgDrawing } from "./exact";
import { pickLayout, tidyOf, type View } from "./pick";
import { messy } from "./messy";
import type { St } from "./draw";

/**
 * D111: the check reads the SVG the page draws, in every view the page draws: no run, a run selected (each way it could
 * have gone), a laptop and a phone, a run's path alone. Tyler opened Hair's Health check with its hourly run selected and
 * saw the four triggers and nothing under them: a drawing whose layout was "fully placed" still left steps off the page.
 */
const company = { name: "Acme", timezone: "America/Chicago" };
const PMU = path.resolve(__dirname, "../../installs/pmu");
const shipped = () => [
  ...templates.map((t) => ({ name: t.slug, def: parseDefinition(t.definition) })),
  ...fs.readdirSync(PMU).filter((f) => f.endsWith(".json")).map((f) => ({ name: `pmu/${f.replace(/\.json$/, "")}`, def: parseDefinition(JSON.parse(fs.readFileSync(path.join(PMU, f), "utf8")).definition) })),
];
const ids = (svg: string) => [...svg.matchAll(/<g\b[^>]*\bclass="nd\b[^>]*\bdata-id="([^"]+)"/g)].map((m) => m[1]);
const viewOf = (states: Record<string, St> | null, width: number, pathOnly: boolean): View => ({ width, pathOnly, stateOf: states ? (id) => states[id] ?? "next" : undefined });

/** The runs a chart can show: from each start, at each way out of each step with several, that way, the first way elsewhere. */
function runs(chart: Chart): Record<string, St>[] {
  const outs = (id: string) => chart.edges.filter((e) => e.from === id);
  const walk = (start: string, pick: Map<string, number>): Record<string, St> => {
    const st: Record<string, St> = {}; let cur: string | undefined = start;
    for (let i = 0; cur && !(cur in st) && i < 500; i++) { st[cur] = "ok"; const o = outs(cur); cur = o[Math.min(pick.get(cur) ?? 0, o.length - 1)]?.to; }
    return st;
  };
  const out: Record<string, St>[] = [];
  for (const t of chart.nodes.filter((n) => n.kind === "trig")) {
    out.push(walk(t.id, new Map()));
    for (const n of chart.nodes) for (let k = 1; k < outs(n.id).length; k++) { const r = walk(t.id, new Map([[n.id, k]])); if (n.id in r) out.push(r); }
  }
  return out;
}

describe("D111: every view the page draws is checked from its SVG", () => {
  const hourly: Record<string, St> = { t1: "ok", n1: "ok", x_done: "ok" };
  const health = () => chartOf(parseDefinition(templates.find((t) => t.slug === "health-check")!.definition), { name: "Hair", timezone: "America/Chicago" });

  it("Tyler's screen: Hair's Health check with its hourly run selected draws every step, on a laptop and a phone", () => {
    const chart = health(); const want = realOf(chart).nodes;
    for (const width of [1000, 358]) {
      const t = tidyOf(chart, viewOf(hourly, width, false));
      expect(t.shown.check.problems, `${width}`).toEqual([]);
      expect(new Set(ids(t.shown.svg))).toEqual(new Set(want));
    }
  });

  it("…with only the run's path (a phone), the drawing says so, draws the whole path, and the whole chart is still exact", () => {
    const chart = health(); const t = tidyOf(chart, viewOf(hourly, 358, true));
    expect(t.shown.check).toEqual({ exact: true, problems: [], filtered: true });
    expect(t.shown.svg).toContain(`data-filtered="1"`);
    expect(ids(t.shown.svg)).toEqual(["t1", "n1", "x_done"]);
    expect(t.tidy.exact).toBe(true);
  });

  it("the check fails the drawing Tyler saw (the layout before D107: four triggers, nothing under them)", () => {
    const before = fs.readFileSync(path.join(__dirname, "fixtures/health-check-hourly.before-d107.svg"), "utf8");
    expect(ids(before)).toEqual(["t1", "t_raised", "t_repeated", "t_resolved"]);
    const c = exactness(health(), svgDrawing(before));
    expect(c.exact).toBe(false);
    for (const id of ["n1", "x_done", "b_alert", "a_post", "x_alert"]) expect(c.problems.join("\n")).toContain(`(${id}) is not drawn`);
  });

  it("a view that leaves out a step it should draw, or a line it should draw, is caught from the SVG alone", () => {
    const chart = health(); const svg = tidyOf(chart, viewOf(hourly, 1000, false)).shown.svg;
    expect(exactness(chart, svgDrawing(svg.replace(/<g\b[^>]*data-id="n1"[\s\S]*?<\/g><\/g>|<g\b[^>]*data-id="n1"[\s\S]*?<\/g>/, ""))).problems).toContainEqual(expect.stringMatching(/\(n1\) is not drawn/));
    expect(exactness(chart, svgDrawing(svg.replace(/ data-ways="[^"]*"/, ""))).exact).toBe(false);
  });

  for (const { name, def } of shipped()) {
    it(`${name}: exact with no run, and with every run it can show, at a laptop's and a phone's width; a run's path alone draws that path`, () => {
      const chart = chartOf(def, company);
      for (const width of [1000, 358]) {
        expect(tidyOf(chart, viewOf(null, width, false)).shown.check.problems, `${width}, no run`).toEqual([]);
        for (const st of runs(chart)) {
          const full = tidyOf(chart, viewOf(st, width, false));
          expect(full.shown.check.problems, `${width}, run ${Object.keys(st).join(">")}`).toEqual([]);
          const only = tidyOf(chart, viewOf(st, width, true));
          expect(only.shown.check.problems, `${width}, path only, run ${Object.keys(st).join(">")}`).toEqual([]);
          if (only.shown.check.filtered) for (const id of Object.keys(st).filter((k) => realOf(chart).nodes.includes(k))) expect(svgDrawing(only.shown.svg).nodes, `${id} on the run's path`).toContain(id);
        }
      }
    });
  }

  it("the plain graph with a run selected is checked from its SVG too", async () => {
    const chart = chartOf(messy() as Definition, company);
    for (const width of [1000, 358]) {
      const p = await pickLayout(chart, viewOf({ t: "ok", a: "ok", f1: "ok", y1: "ok" }, width, true));
      expect(p.layout).toBe("graph");
      if (p.layout === "graph") { expect(p.shown.check.problems).toEqual([]); expect(new Set(ids(p.shown.svg))).toEqual(new Set(realOf(chart).nodes)); }
    }
  });
});
