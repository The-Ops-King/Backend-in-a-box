import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { chartOf, type Chart } from "@/api/words";
import { parseDefinition, type Definition } from "@/engine/definition";
import { templates } from "@/templates";
import { arrange, placedIds } from "./arrange";
import { exactness, svgDrawing } from "./exact";
import { pickLayout, tidyOf } from "./pick";
import { layoutGraph } from "./graph";
import { drawGraph, graphSizes } from "./draw";
import { groupPopover, groupState, grouped, helperRuns } from "./group";

// D114: Tyler on Hair's Health check: "this is super unclear what this does": seven "Remember the alert's …" steps in a
// column between the alert triggers and the fork. A straight run of value-keeping steps is drawn as one box.
const company = { name: "Hair", timezone: "America/Chicago" };
const PMU = path.resolve(__dirname, "../../installs/pmu");
const template = (slug: string) => parseDefinition(templates.find((t) => t.slug === slug)!.definition);
const pmu = (file: string) => parseDefinition(JSON.parse(fs.readFileSync(path.join(PMU, `${file}.json`), "utf8")).definition);
const health = () => chartOf(template("health-check"), company);
const SEVEN = ["a_mark", "a_icon", "a_icon2", "a_head", "a_were", "a_dhead", "a_body"];
const v = (id: string, key: string) => ({ id, type: "set_var", key, value: id });
const tag = (id: string) => ({ id, type: "tags", add: [id] });
const def = (nodes: unknown[], edges: unknown[]) => parseDefinition({ schema: 1, reentry: "always", nodes: [{ id: "t", type: "trigger", event: "appointment.booked" }, ...nodes, { id: "x", type: "exit", reason: "done" }], edges } as unknown as Definition);

describe("D114: a run of value-keeping steps is one box", () => {
  it("Health check: the seven steps that make the alert's words are one box, between the alert starts and the fork", () => {
    const chart = health();
    expect(helperRuns(chart)).toEqual([SEVEN]);
    const box = grouped(chart).nodes.find((n) => n.group)!;
    expect(box.id).toBe("a_mark"); expect(box.group).toEqual(SEVEN);
    expect(box.title).toBe("Prepare the alert's words (7 steps)");
    expect(box.meta).toBe("its mark, face, headline and text; the drift line's verb (it's or they've); how the drift questions start; 2 only sometimes");
    expect(box.helper).toBe(true);
    // at a glance: the hourly check on one side; on the other the alerts → the words → the three-way fork → the posts
    const rows = arrange(chart); const top = rows[0]; if (top.kind !== "fork") throw new Error("no starts side by side");
    expect(top.groups.map((g) => placedIds(g.rows))).toEqual([["t1", "n1", "x_done"], ["t_raised", "t_repeated", "t_resolved", ...SEVEN, "b_alert", "a_post", "a_thread", "a_repeat", "a_resolve", "x_alert"]]);
    const alerts = top.groups[1].rows; expect(alerts[1].kind === "nodes" && alerts[1].items.map((i) => i.id)).toEqual(["a_mark"]);
    const fork = alerts[2]; expect(fork.kind === "fork" && fork.groups.map((g) => g.label)).toEqual(["New", "Still open", "Cleared"]);
    // the drawing: one box standing for the seven, and the check holds it exact
    for (const width of [1000, 358]) {
      const t = tidyOf(chart, { width }); const d = svgDrawing(t.shown.svg);
      expect(t.shown.check.problems).toEqual([]);
      expect(d.groups).toEqual([SEVEN]);
      expect((t.shown.svg.match(/class="nd\b/g) ?? []).length).toBe(grouped(chart).nodes.length);
      expect(d.lines.filter((l) => SEVEN.includes(l.to) || SEVEN.includes(l.from)).map((l) => `${l.from}>${l.to}`).sort()).toEqual(["a_body>b_alert", "t_raised>a_mark", "t_repeated>a_mark", "t_resolved>a_mark"]);
    }
  });

  it("PMU's Call booked: each booking path's remembered values are a box; a lone one stays a step", () => {
    const chart = chartOf(pmu("call-booked"), company); const g = grouped(chart);
    const boxes = g.nodes.filter((n) => n.group).map((n) => [n.group, n.title]);
    expect(boxes).toEqual([[["s1", "s2", "s2b", "s_suffix"], "Remember the setter line, booking kind, booking source and card's name ending (4 steps)"], [["b1", "b2", "b2b"], "Remember the setter line, booking kind and booking source, when setter booked (3 steps)"], [["v_textoff", "v_nophone"], "Remember the no text reason (2 steps)"],
      // D284: the follow-up path's values are a box of their own
      [["fu1", "fu2", "fu3"], "Remember the setter line, booking kind and booking source, when a follow up (3 steps)"]]);
    // b_suffix comes after the contact update: alone, it is drawn as itself
    expect(g.nodes.find((n) => n.id === "b_suffix")?.group).toBeUndefined();
    expect(tidyOf(chart).tidy.problems).toEqual([]);
    // the template's two paths keep the same values: told apart by the way into them
    expect(grouped(chartOf(template("call-booked"), company)).nodes.filter((n) => n.group).map((n) => n.title)).toEqual([
      "Remember the setter line, booking kind, booking source and card's name ending, when self booked (4 steps)", "Remember the setter line, booking kind, booking source and card's name ending, when setter booked (4 steps)", "Remember the no text reason (2 steps)", "Remember the setter line, booking kind and booking source (3 steps)"]);
  });

  it("only values kept and lookups are grouped: a wait, Jev's read, a fork or a step that acts is never inside a box", () => {
    // Jev's read is a helper drawn small, but it decides a fork: never part of a box
    const pre = chartOf(pmu("pre-call-sequence"), company);
    expect(pre.nodes.find((n) => n.id === "c1")?.plumb).toBeUndefined();
    expect(helperRuns(pre).flat()).not.toContain("c1");
    const d = def([v("a", "one"), { id: "w", type: "wait", rule: { anchor: "now", offset: "+1h", tz: "company" } }, v("b", "two"), v("c", "three"), tag("s"), v("e", "four"), { id: "l", type: "lookup", query: "appointments_for_contact", into: "bookings" }],
      [{ from: "t", to: "a" }, { from: "a", to: "w" }, { from: "w", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "s" }, { from: "s", to: "e" }, { from: "e", to: "l" }, { from: "l", to: "x" }]);
    const chart = chartOf(d, company);
    expect(helperRuns(chart)).toEqual([["b", "c"], ["e", "l"]]);
    expect(grouped(chart).nodes.find((n) => n.id === "e")?.title).toBe("Look up their bookings, then remember the four (2 steps)");
    expect(tidyOf(chart).tidy.problems).toEqual([]);
  });

  it("a fork in the middle of a chain splits it: no box runs across a fork, nor across a way in from elsewhere", () => {
    const when = { eq: ["{{contact.source}}", "ad"] };
    const d = def([v("a", "one"), v("b", "two"), { id: "f", type: "branch" }, v("c", "three"), v("d", "four"), v("e", "five"), tag("side")],
      [{ from: "t", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "f" }, { from: "f", to: "c", label: "an ad", when }, { from: "f", to: "side", else: true }, { from: "side", to: "d" }, { from: "c", to: "d" }, { from: "d", to: "e" }, { from: "e", to: "x" }]);
    const chart = chartOf(d, company);
    // c is alone (d is reached from c and from side: a second way in), d and e are a run
    expect(helperRuns(chart)).toEqual([["a", "b"], ["d", "e"]]);
    expect(grouped(chart).nodes.find((n) => n.id === "c")?.group).toBeUndefined();
    expect(tidyOf(chart).tidy.problems).toEqual([]);
  });

  it("a value-keeping step with a way out that is not an edge (implicit.ts) is not grouped across it", () => {
    const chart: Chart = {
      nodes: [{ id: "t", kind: "trig", title: "Start" }, ...["a", "b", "c"].map((id) => ({ id, kind: "other" as const, title: `Remember ${id}`, helper: true, plumb: { verb: "remember" as const, what: `the ${id}` } })), { id: "b~stop", kind: "end", title: "Stop: b" }, { id: "x", kind: "end", title: "Done" }],
      edges: [{ from: "t", to: "a", label: "" }, { from: "a", to: "b", label: "" }, { from: "b", to: "c", label: "" }, { from: "b", to: "b~stop", label: "otherwise", else: true }, { from: "c", to: "x", label: "" }],
    };
    expect(helperRuns(chart)).toEqual([["a", "b"]]);
    expect(tidyOf(chart).tidy.problems).toEqual([]);
  });

  it("the check refuses a box that hides a fork, a way out, a way in, a step that acts, or leaves a step out", () => {
    const chart = health(); const svg = tidyOf(chart).shown.svg;
    const regroup = (ids: string[]) => svgDrawing(svg.replace(/data-group="[^"]*"/, `data-group="${ids.join(",")}"`));
    expect(exactness(chart, regroup(SEVEN)).problems).toEqual([]);
    // the box claims the fork after it too: it hides three ways out and a step that does more than keep a value
    const fork = exactness(chart, regroup([...SEVEN, "b_alert"])).problems.join("\n");
    expect(fork).toMatch(/hides “.*” \(b_alert\), which does more than keep a value/);
    expect(fork).toMatch(/hides a way out of “.*” \(a_body\)|is drawn 2 times/);
    // one left out: drawn nowhere, and the box hides the way into the next
    const gap = exactness(chart, regroup(SEVEN.filter((id) => id !== "a_head"))).problems.join("\n");
    expect(gap).toContain("(a_head) is not drawn"); expect(gap).toMatch(/hides a way out of .*\(a_icon2\)/);
    // out of order
    expect(exactness(chart, regroup([SEVEN[0], SEVEN[2], SEVEN[1], ...SEVEN.slice(3)])).exact).toBe(false);
    // a box of one, or one that does not start at the step it is drawn as
    expect(exactness(chart, regroup(["a_mark"])).problems.join("\n")).toContain("stands for one step");
    expect(exactness(chart, regroup(["a_icon", ...SEVEN.slice(2)])).problems.join("\n")).toContain("stands for steps it does not start with");
    // a way into the middle of the run: the workflow gets a second way into a_head, and the drawing (unchanged) is caught
    const cross: Chart = { ...chart, edges: [...chart.edges, { from: "n1", to: "a_head", label: "" }] };
    expect(exactness(cross, svgDrawing(svg)).problems.join("\n")).toMatch(/hides a way into .*\(a_head\) from .*\(n1\)/);
    // a way out of the middle: an extra way from a_icon is hidden
    const out: Chart = { ...chart, edges: [...chart.edges, { from: "a_icon", to: "x_alert", label: "" }] };
    expect(exactness(out, svgDrawing(svg)).problems.join("\n")).toMatch(/hides a way out of .*\(a_icon\): 2 ways out/);
    // the line out of the box must leave from its last step
    expect(exactness(chart, svgDrawing(svg.replace(/a_body\|b_alert/, "a_mark|b_alert"))).exact).toBe(false);
  });

  it("the plain graph draws the box too, exactly, its line out leaving from its last step", async () => {
    const chart = health(); const s = graphSizes(chart, false);
    const g = await layoutGraph(chart, s.size, s.labelSize, { gap: s.gap });
    expect(g.nodes.map((n) => n.id)).toContain("a_mark"); expect(g.nodes.map((n) => n.id)).not.toContain("a_body");
    const d = svgDrawing(drawGraph(g, chart, 1000, 240, () => null).svg);
    expect(d.groups).toEqual([SEVEN]); expect(exactness(chart, d).problems).toEqual([]);
    expect(d.lines.some((l) => l.from === "a_body" && l.to === "b_alert")).toBe(true);
    // with a run, the graph is held to the same check
    const p = await pickLayout(chart, { width: 1000, stateOf: (id) => (["t_raised", ...SEVEN, "b_alert"].includes(id) ? "ok" : "next") });
    expect(p.layout).toBe("tidy");
  });

  it("every shipped template and PMU copy with a box is exact in the plain graph too, at both widths", async () => {
    const all = [...templates.map((t) => ({ name: t.slug, d: parseDefinition(t.definition) })), ...fs.readdirSync(PMU).filter((f) => f.endsWith(".json") && f !== "playbook.json").map((f) => ({ name: `pmu/${f}`, d: pmu(f.replace(/\.json$/, "")) }))];
    let boxes = 0;
    for (const { name, d } of all) {
      const chart = chartOf(d, company); if (!helperRuns(chart).length) continue; boxes++;
      for (const narrow of [false, true]) {
        const s = graphSizes(chart, narrow); const g = await layoutGraph(chart, s.size, s.labelSize, { gap: s.gap });
        expect(exactness(chart, svgDrawing(drawGraph(g, chart, narrow ? 358 : 1000, narrow ? 176 : 240, () => null).svg)).problems, `${name} ${narrow ? "phone" : "laptop"}`).toEqual([]);
      }
    }
    expect(boxes).toBeGreaterThan(8);
  });

  it("counts: the box wears its first step's count; with a run, its steps' state, said when not all simply ran", () => {
    const chart = health(); chart.counts = { days: 7, by: Object.fromEntries(SEVEN.map((id) => [id, { went: 12, skipped: id === "a_were" || id === "a_dhead" ? 11 : 0 }])) };
    const svg = tidyOf(chart, { width: 1000, countOf: (id) => chart.counts!.by[id] ?? { went: 0, skipped: 0 } }).shown.svg;
    const box = /<g class="nd grp[^]*?<\/g><\/g>/.exec(svg)?.[0] ?? "";
    expect(box).toContain(">12<");
    expect(groupState(["ok", "ok", "ok", "ok", "skip", "skip", "ok"])).toEqual({ st: "ok", words: "5 ran · 2 skipped" });
    expect(groupState(["ok", "ok", "warn", "next"])).toEqual({ st: "warn", words: "failed at step 3 of 4" });
    expect(groupState(["ok", "ok"])).toEqual({ st: "ok" });
    expect(groupState(["next", "next"])).toEqual({ st: "next" });
    expect(groupState([null, null])).toEqual({ st: null });
    const ran = Object.fromEntries(SEVEN.map((id) => [id, id === "a_were" || id === "a_dhead" ? "skip" : "ok"])) as Record<string, "ok" | "skip">;
    const runSvg = tidyOf(chart, { width: 1000, stateOf: (id) => ran[id] ?? "next" }).shown.svg;
    expect(runSvg).toContain("5 ran · 2 skipped");
  });

  it("the box's popover lists every step in order with its words, its condition and its count, or its state on a run", () => {
    const chart = health(); chart.counts = { days: 7, by: { a_mark: { went: 9, skipped: 0 }, a_were: { went: 9, skipped: 8 } } };
    const p = groupPopover(chart, "a_mark")!;
    expect(p.title).toBe("Prepare the alert's words (7 steps)");
    expect(p.steps.map((s) => s.id)).toEqual(SEVEN);
    expect(p.steps.map((s) => s.title)).toEqual(SEVEN.map((id) => chart.nodes.find((n) => n.id === id)!.title));
    expect(p.steps[0].meta).toBe(chart.nodes.find((n) => n.id === "a_mark")!.meta);
    const were = p.steps.find((s) => s.id === "a_were")!;
    expect(were.cond).toMatch(/^Only if .*Otherwise it is skipped and the run goes on\.$/);
    expect(were.went).toBe("9 went through, 8 skipped"); expect(p.steps.find((s) => s.id === "a_icon")!.went).toBe("nobody lately");
    expect(p.days).toBe(7);
    const run = groupPopover(chart, "a_mark", Object.fromEntries(SEVEN.map((id) => [id, id === "a_were" || id === "a_dhead" ? "skip" : "ok"])))!;
    expect(run.steps.map((s) => s.state)).toEqual(["ok", "ok", "ok", "ok", "skip", "skip", "ok"]);
    expect(run.summary).toEqual({ st: "ok", words: "5 ran · 2 skipped" });
    expect(groupPopover(chart, "b_alert")).toBeNull();
  });
});
