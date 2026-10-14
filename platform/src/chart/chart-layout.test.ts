import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { chartOf, type Chart } from "@/api/words";
import { parseDefinition, type Definition } from "@/engine/definition";
import { templates } from "@/templates";
import { arrange, drawable, placedIds, type Row } from "./arrange";
import { exactness, graphGeometry, svgDrawing } from "./exact";
import { pickLayout, tidyOf } from "./pick";
import { draw, drawGraph } from "./draw";

const svgOf = (chart: Chart, rows = arrange(chart)) => svgDrawing(draw(rows, 1000, () => null, false));
const graphSvg = (chart: Chart, g: Awaited<ReturnType<typeof layoutGraph>>) => svgDrawing(drawGraph(g, chart, 1000, 240, () => null).svg);
import { layoutGraph } from "./graph";
import { messy } from "./messy";

// D107: the chart dropped every step after a fork inside a fork; Tyler saw PMU's Call booked end at its two
// "A new booking or a reschedule?" forks, with no card moves, no tags, no Slack card and no Done. D111: every chart is held
// to the workflow by one check (exact.ts), and what the tidy layout cannot draw exactly is drawn as a plain graph.
const company = { name: "Acme", timezone: "America/Chicago" };
const PMU = path.resolve(__dirname, "../../installs/pmu");
const shipped = () => [
  ...templates.map((t) => ({ name: t.slug, def: parseDefinition(t.definition) })),
  ...fs.readdirSync(PMU).filter((f) => f.endsWith(".json")).map((f) => ({ name: `pmu/${f.replace(/\.json$/, "")}`, def: parseDefinition(JSON.parse(fs.readFileSync(path.join(PMU, f), "utf8")).definition) })),
];
const template = (slug: string) => parseDefinition(templates.find((t) => t.slug === slug)!.definition);
const pmu = (file: string) => parseDefinition(JSON.parse(fs.readFileSync(path.join(PMU, `${file}.json`), "utf8")).definition);
const tag = (id: string) => ({ id, type: "tags", title: `Step ${id}`, add: [id] });
const when = (t: string) => ({ eq: ["{{contact.source}}", t] });

/** Every place the drawing stops, the flow stops too: an exit, a step with no way on, or an arrow on to a step drawn elsewhere. */
function cutOff(chart: Chart, rows: Row[], go: boolean, where = "top"): string[] {
  const bad: string[] = [];
  for (const r of rows) if (r.kind === "fork") for (const g of r.groups) bad.push(...cutOff(chart, g.rows, g.go, `${where} › ${g.label || g.first}`));
  const last = rows[rows.length - 1];
  if (!last) return go ? bad : [...bad, `${where}: an empty group that goes nowhere`];
  if (last.kind === "more") bad.push(`${where}: ends in a list of steps it could not place`);
  if (last.kind === "fork" && !go && last.groups.some((g) => g.go)) bad.push(`${where}: a fork's groups rejoin but nothing follows`);
  if (last.kind === "nodes" && !go) { const it = last.items[last.items.length - 1]; if (it.n.kind !== "end" && chart.edges.some((e) => e.from === it.id)) bad.push(`${where}: stops at ${it.id}, which goes on`); }
  return bad;
}

describe("D107/D111: the chart draws every step, exactly", () => {
  for (const { name, def } of shipped()) {
    it(`${name}: the tidy layout is exactly the workflow: every step drawn once, every way and only its ways`, () => {
      const chart = chartOf(def, company); const t = tidyOf(chart);
      expect(t.tidy.problems).toEqual([]);
      expect(t.tidy.exact).toBe(true);
      // nothing hidden: every node of the definition but an exit nothing touches is on the chart
      expect(new Set(placedIds(t.rows))).toEqual(new Set(drawable(chart)));
      expect(def.nodes.filter((n) => !drawable(chart).includes(n.id)).every((n) => n.type === "exit")).toBe(true);
      // the chart's own nodes are the definition's, plus the ends of the ways that are not edges (D111: implicit.ts)
      expect(chart.nodes.filter((n) => !n.id.includes("~")).length).toBe(def.nodes.length);
      expect(cutOff(chart, t.rows, false)).toEqual([]);
    });
  }

  it("an exit nothing leads to is the only node not drawn (Daily EOD reminder's check stops the run itself, drawn as its own end)", () => {
    const chart = chartOf(template("eod-reminder"), company);
    expect(chart.nodes.filter((n) => !drawable(chart).includes(n.id)).map((n) => n.id)).toEqual(["x_nothing"]);
    const lone: Chart = { nodes: [{ id: "t", kind: "trig", title: "Start" }, { id: "x", kind: "end", title: "Done" }, { id: "never", kind: "end", title: "Stop: never" }], edges: [{ from: "t", to: "x", label: "" }] };
    expect(drawable(lone)).toEqual(["t", "x"]);
  });

  it("nothing hidden: Jev's read, the values a run remembers and every wait are drawn, as helper steps", () => {
    const chart = chartOf(pmu("pre-call-sequence"), company); const rows = arrange(chart); const placed = placedIds(rows);
    for (const id of ["c1", "v_read", "v_decided", "v_agreed", "r72", "r48", "r24", "rm", "r1", "r10"]) {
      expect(placed, id).toContain(id);
      expect(chart.nodes.find((n) => n.id === id)?.helper, id).toBe(true);
    }
    expect(chart.nodes.filter((n) => n.kind === "send").every((n) => !n.helper)).toBe(true);
    // the reply-wait is its own fork now: replied (on to Jev's read) or no reply in time
    const w1 = rows.find((r) => r.kind === "fork" && r.fork?.id === "w1"); if (w1?.kind !== "fork") throw new Error("no w1 fork");
    expect(w1.groups.map((g) => [g.label, g.first])).toEqual([["They replied", "c1"], ["No reply in time", "n_unc"]]);
  });

  it("a branch around one step is folded into the step only when that is exact; otherwise it is drawn as a branch", () => {
    // PMU's morning text: "the call is at 11am or later" decides whether one text goes; the otherwise way skips it
    expect(JSON.stringify(arrange(chartOf(pmu("pre-call-sequence"), company)))).toContain(`"fold":{"fork":"bm"`);
    const fold = (extra: unknown[]) => parseDefinition({ schema: 1, reentry: "always",
      nodes: [{ id: "t", type: "trigger", event: "appointment.booked" }, { id: "g", type: "branch" }, { id: "f", type: "branch" }, tag("s"), tag("after"), tag("side"), { id: "x", type: "exit", reason: "done" }],
      edges: [{ from: "t", to: "g" }, { from: "g", to: "f", label: "a", when: when("a") }, { from: "g", to: "side", else: true }, { from: "f", to: "s", label: "this is a referral", when: when("r") }, { from: "f", to: "after", else: true }, { from: "s", to: "after" }, { from: "after", to: "x" }, ...extra] } as unknown as Definition);
    const one = chartOf(fold([{ from: "side", to: "x" }]), company); const a = tidyOf(one);
    expect(JSON.stringify(a.rows)).toContain(`"fold":{"fork":"f"`); expect(a.tidy.problems).toEqual([]);
    // the same branch with its step also reached from another way: "only if a referral" would not be the whole truth
    const two = chartOf(fold([{ from: "side", to: "s" }]), company); const b = tidyOf(two);
    expect(JSON.stringify(b.rows)).not.toContain(`"fold"`); expect(b.tidy.problems).toEqual([]);
    // a fold that showed another condition than its branch's is caught
    const rows = arrange(one); const it = JSON.parse(JSON.stringify(rows), (k, v) => v) as Row[];
    const find = (rs: Row[]): Row[] => rs.flatMap((r) => r.kind === "fork" ? [r, ...r.groups.flatMap((g) => find(g.rows))] : [r]);
    const item = find(it).flatMap((r) => r.kind === "nodes" ? r.items : []).find((i) => i.fold)!;
    item.when = "something else";
    expect(exactness(one, svgOf(one, it)).problems).toEqual(["the way “F” (f) → “Step s” (s) “this is a referral” is not drawn", "a line “F” (f) → “Step s” (s) “something else” is drawn but the workflow has no such way"].map((x) => x.replace("“F”", `“${one.nodes.find((n) => n.id === "f")!.title}”`)));
  });

  it("the check catches a drawing that drops a step, draws one twice, or draws a line the workflow does not have", () => {
    const chart = chartOf(template("cancellation-rebook"), company);
    const d = svgOf(chart);
    const [first, second] = d.nodes.slice(1);
    expect(exactness(chart, { ...d, nodes: d.nodes.filter((id) => id !== second) }).problems.join(" ")).toContain("is not drawn");
    expect(exactness(chart, { ...d, nodes: [...d.nodes, first] }).problems.join(" ")).toContain("drawn 2 times");
    expect(exactness(chart, { ...d, lines: [...d.lines, { from: second, to: first, label: "", else: false }] }).problems.join(" ")).toContain("the workflow has no such way");
    expect(exactness(chart, { ...d, lines: d.lines.map((l, i) => i === 1 ? { ...l, label: "yes" } : l) }).exact).toBe(false);
  });

  it("a fork inside each branch of a fork: both levels rejoin, and the steps after the outer join follow in order", () => {
    const resched = { eq: ["{{event._type}}", "appointment.rescheduled"] };
    const def = parseDefinition({
      schema: 1, reentry: "always",
      nodes: [{ id: "t1", type: "trigger", event: "appointment.booked" }, tag("a"), { id: "f", type: "branch", title: "Setter booked?" },
        tag("b1"), { id: "g1", type: "branch", title: "A reschedule?" }, tag("g1a"), tag("g1b"), tag("j1"),
        tag("s1"), { id: "g2", type: "branch", title: "A reschedule?" }, tag("g2a"), tag("g2b"), tag("j2"),
        tag("k"), tag("after"), { id: "x", type: "exit", reason: "done" }],
      edges: [{ from: "t1", to: "a" }, { from: "a", to: "f" },
        { from: "f", to: "b1", label: "setter booked", when: { eq: ["{{appointment.self_booked}}", false] } }, { from: "f", to: "s1", label: "self booked", else: true },
        { from: "b1", to: "g1" }, { from: "g1", to: "g1a", label: "a reschedule", when: resched }, { from: "g1", to: "g1b", label: "a new booking", else: true }, { from: "g1a", to: "j1" }, { from: "g1b", to: "j1" },
        { from: "s1", to: "g2" }, { from: "g2", to: "g2a", label: "a reschedule", when: resched }, { from: "g2", to: "g2b", label: "a new booking", else: true }, { from: "g2a", to: "j2" }, { from: "g2b", to: "j2" },
        { from: "j1", to: "k" }, { from: "j2", to: "k" }, { from: "k", to: "after" }, { from: "after", to: "x" }],
    } as unknown as Definition);
    const chart = chartOf(def, company); const rows = arrange(chart);
    expect(placedIds(rows)).toEqual(["t1", "a", "f", "b1", "g1", "g1a", "g1b", "j1", "s1", "g2", "g2a", "g2b", "j2", "k", "after", "x"]);
    const fork = rows.find((r) => r.kind === "fork"); if (fork?.kind !== "fork") throw new Error("no fork");
    expect(fork.groups.map((g) => [g.label, g.go])).toEqual([["Setter booked", true], ["Self booked", true]]);
    for (const g of fork.groups) {
      const inner = g.rows.find((r) => r.kind === "fork"); if (inner?.kind !== "fork") throw new Error("no inner fork");
      expect(inner.groups.map((x) => [x.label, x.go])).toEqual([["A reschedule", true], ["A new booking", true]]);
    }
    expect(rows.slice(rows.indexOf(fork) + 1).flatMap((r) => r.kind === "nodes" ? r.items.map((i) => i.id) : [])).toEqual(["k", "after", "x"]);
    expect(cutOff(chart, rows, false)).toEqual([]);
    expect(tidyOf(chart).tidy.exact).toBe(true);
  });

  it("the shipped setter-call-logged is fully placed: the tap fork inside 'Jev unsure' inside 'setting or confirmation call'", () => {
    const chart = chartOf(template("setter-call-logged"), company); const rows = arrange(chart);
    expect(new Set(placedIds(rows))).toEqual(new Set(drawable(chart)));
    const kind = rows.find((r) => r.kind === "fork" && r.fork?.id === "b_kind"); if (kind?.kind !== "fork") throw new Error("no b_kind");
    const setting = kind.groups.find((g) => placedIds(g.rows).includes("b_ask"))!;
    const ask = setting.rows.find((r) => r.kind === "fork" && r.fork?.id === "b_ask"); if (ask?.kind !== "fork") throw new Error("no b_ask");
    const unsure = ask.groups.find((g) => placedIds(g.rows).includes("q1"))!;
    expect(unsure.rows.some((r) => r.kind === "fork" && r.fork?.id === "l1")).toBe(true);
    expect(placedIds(setting.rows).slice(-5)).toEqual(["k_task", "k_tag", "k_lost_dq", "k_lost_ni", "x1"]);
  });

  it("PMU's Call booked ends at Done, after its forks: the Slack card and Done are drawn", () => {
    const rows = arrange(chartOf(pmu("call-booked"), company));
    const tail = rows[rows.length - 1]; if (tail.kind !== "nodes") throw new Error("does not end in steps");
    expect(tail.items[tail.items.length - 1].n.kind).toBe("end");
    expect(tail.items.some((i) => i.n.kind === "slack")).toBe(true);
  });

  it("a trigger whose first step another start reaches is drawn where it comes in (Call outcome's CRM no-show)", () => {
    const rows = arrange(chartOf(template("call-outcome"), company));
    const b1 = rows.find((r) => r.kind === "fork" && r.fork?.id === "b1"); if (b1?.kind !== "fork") throw new Error("no b1");
    const noShow = b1.groups.find((g) => /no.show/i.test(g.label))!;
    const first = noShow.rows[0]; if (first.kind !== "nodes") throw new Error("no steps");
    expect(first.items.slice(0, 2).map((i) => [i.id, !!i.entry])).toEqual([["t2", true], ["g1", false]]);
  });

  it("starts that only meet further down sit side by side, each over its own steps (Daily EOD reminder, health check)", () => {
    const eod = arrange(chartOf(template("eod-reminder"), company));
    expect(eod[0].kind === "fork" && eod[0].fork === null && eod[0].groups.map((g) => [g.first, g.go, g.bare])).toEqual([["t_evening", true, true], ["t_morning", true, true]]);
    const hc = arrange(chartOf(template("health-check"), company));
    expect(hc[0].kind === "fork" && hc[0].groups.every((g) => !g.go)).toBe(true);
  });

  it("a step the walk cannot reach, or steps past the depth limit, are listed, and the tidy layout says it is not exact", () => {
    const chart: Chart = { nodes: [{ id: "t", kind: "trig", title: "Start" }, { id: "a", kind: "tag", title: "A" }, { id: "lost", kind: "tag", title: "Nobody leads here" }], edges: [{ from: "t", to: "a", label: "" }] };
    const rows = arrange(chart); const more = rows[rows.length - 1];
    expect(more.kind === "more" && more.items.map((i) => i.id)).toEqual(["lost"]);
    expect(tidyOf(chart).tidy.problems).toContain("1 step is listed apart, not drawn on the chart");
    const nodes: Chart["nodes"] = [{ id: "t", kind: "trig", title: "Start" }]; const edges: Chart["edges"] = [{ from: "t", to: "f0", label: "" }];
    for (let i = 0; i < 6; i++) { nodes.push({ id: `f${i}`, kind: "fork", title: `Fork ${i}` }, { id: `x${i}`, kind: "end", title: "Done" }); edges.push({ from: `f${i}`, to: i < 5 ? `f${i + 1}` : "y", label: "deeper" }, { from: `f${i}`, to: `x${i}`, label: "out" }); }
    nodes.push({ id: "y", kind: "end", title: "Done" });
    const deep = arrange({ nodes, edges }); const placed = placedIds(deep);
    expect(new Set(placed)).toEqual(new Set(nodes.map((n) => n.id))); expect(placed.length).toBe(nodes.length);
    expect(JSON.stringify(deep)).toContain("Too deep to draw as branches");
    expect(tidyOf({ nodes, edges }).tidy.exact).toBe(false);
  });
});

describe("D111: what the tidy layout cannot draw is drawn as a plain graph, exactly", () => {
  it("a cross-link into another branch's chain, a loop back, five deep and a step nothing reaches: the graph draws every step and every way", async () => {
    const chart = chartOf(messy(), company);
    expect(tidyOf(chart).tidy.exact).toBe(false);
    const g = await layoutGraph(chart, () => ({ w: 180, h: 40 }), (s) => ({ w: s.length * 7, h: 15 }));
    expect(exactness(chart, graphSvg(chart, g)).problems).toEqual([]);
    expect(new Set(g.nodes.map((n) => n.id))).toEqual(new Set(drawable(chart)));
    expect(g.nodes.length).toBe(drawable(chart).length);
    expect(g.edges.map((e) => `${e.from}>${e.to}:${e.label}`).sort()).toEqual(chart.edges.map((e) => `${e.from}>${e.to}:${e.label}`).sort());
    // the loop back runs up the page: its line ends above where it starts
    const back = g.edges.find((e) => e.from === "lb" && e.to === "a")!;
    expect(back.points[back.points.length - 1].y).toBeLessThan(back.points[0].y);
    for (const a of g.nodes) for (const b of g.nodes) if (a.id < b.id) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} and ${b.id} overlap`).toBe(true);
    expect((await pickLayout(chart)).layout).toBe("graph");
  });

  it("the cross-link and the loop alone are drawn tidily, as arrows on to the steps they reach, and that is exact", () => {
    const def = messy(); const deep = /^(n\d|s\d|x_\d|orphan)$/;
    const trimmed = parseDefinition({ ...def, nodes: def.nodes.filter((n) => !deep.test(n.id)), edges: [...def.edges.filter((e) => !deep.test(e.from) && !deep.test(e.to)), { from: "f1", to: "done", label: "other", else: true }] });
    const t = tidyOf(chartOf(trimmed, company));
    expect(t.tidy.problems).toEqual([]);
    expect(JSON.stringify(t.rows)).toContain(`"kind":"on","to":"a"`);
  });

  it("the graph check catches a line the layout routed away from its steps", async () => {
    const chart = chartOf(messy(), company);
    const g = await layoutGraph(chart, () => ({ w: 180, h: 40 }), (s) => ({ w: s.length * 7, h: 15 }));
    g.edges[0].points = [{ x: -500, y: -500 }, { x: -400, y: -400 }];
    expect(graphGeometry(g)[0]).toMatch(/does not run from its step's box to its step's box/);
  });
});
