import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { chartOf, type Chart } from "./words";
import { parseDefinition, type Definition } from "@/engine/definition";
import { templates } from "@/templates";
import { arrange, drawable, placedIds, type Row } from "../../dashboard/src/ui/arrange";

// D107: the chart dropped every step after a fork inside a fork; Tyler saw PMU's Call booked end at its two
// "A new booking or a reschedule?" forks, with no card moves, no tags, no Slack card and no Done
const company = { name: "Acme", timezone: "America/Chicago" };
const PMU = path.resolve(__dirname, "../../installs/pmu");
const shipped = () => [
  ...templates.map((t) => ({ name: t.slug, def: parseDefinition(t.definition) })),
  ...fs.readdirSync(PMU).filter((f) => f.endsWith(".json")).map((f) => ({ name: `pmu/${f.replace(/\.json$/, "")}`, def: parseDefinition(JSON.parse(fs.readFileSync(path.join(PMU, f), "utf8")).definition) })),
];
const template = (slug: string) => parseDefinition(templates.find((t) => t.slug === slug)!.definition);

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

/**
 * The connections the layout draws, as chart edges: consecutive steps, a fork to each group's first step, a group's last
 * step to the join (only a group that carries on), an arrow on to a step drawn elsewhere, an entry trigger into the
 * step after it, and the edges inside a folded item. Drawn must equal the chart's own edges (hidden nodes routed
 * around): every connection on the page is real, and every real one is on the page, so order and joins are right.
 */
function drawnEdges(chart: Chart, rows: Row[]): Set<string> {
  const hidden = new Set(chart.nodes.filter((n) => n.hidden).map((n) => n.id));
  const out = new Set<string>(); const add = (from: string[], to: string) => { for (const f of from) out.add(`${f}>${to}`); };
  const lay = (rs: Row[], incoming: string[]): string[] => {
    let tails = incoming;
    for (const r of rs) {
      if (r.kind === "nodes") {
        const side = r.items.filter((i) => i.n.kind === "trig" && !i.entry);
        if (side.length) tails = side.map((i) => i.id);
        for (const it of r.items) {
          if (it.n.kind === "trig" && !it.entry) continue;
          if (it.entry) { tails = [...tails, it.id]; continue; }
          const chain = [...(it.also ?? []), it.id]; add(tails, chain[0]);
          for (let k = 1; k < chain.length; k++) add([chain[k - 1]], chain[k]);
          // a fork folded into its step: its other way skips the step and goes where the step goes
          const fork = it.also?.find((id) => chart.nodes.find((n) => n.id === id)?.kind === "fork");
          tails = fork ? [it.id, fork] : [it.id];
        }
      } else if (r.kind === "on") { add(tails, r.to); tails = []; }
      else if (r.kind === "fork") {
        if (r.fork) add(tails, r.fork.id);
        const next: string[] = [];
        for (const g of r.groups) {
          const from = g.from ? [g.from] : r.fork ? [r.fork.id] : [];
          const t = g.rows.length ? lay(g.rows, from) : from;
          if (g.go) next.push(...t);
        }
        tails = next;
      } else throw new Error(`a list of steps it could not place: ${r.label}`);
    }
    return tails;
  };
  const tails = lay(rows, []);
  if (tails.length) {
    // the top level ends where the flow ends: whatever is still open must lead nowhere
    for (const t of tails) if (chart.edges.some((e) => e.from === t)) out.add(`${t}>(not drawn)`);
  }
  void hidden; return out;
}
function realEdges(chart: Chart): Set<string> {
  const hidden = new Set(chart.nodes.filter((n) => n.hidden).map((n) => n.id));
  const skip = (id: string) => { let cur = id; for (let i = 0; i < 10 && hidden.has(cur); i++) { const o = chart.edges.find((e) => e.from === cur); if (!o) break; cur = o.to; } return cur; };
  return new Set(chart.edges.filter((e) => !hidden.has(e.from)).map((e) => `${e.from}>${skip(e.to)}`));
}

describe("D107: the chart draws every step", () => {
  for (const { name, def } of shipped()) {
    it(`${name}: every visible step is placed exactly once, and every path that stops reaches an end`, () => {
      const chart = chartOf(def, company); const rows = arrange(chart);
      const placed = placedIds(rows); const visible = drawable(chart);
      expect(visible.filter((id) => !placed.includes(id)), "dropped").toEqual([]);
      expect(placed.filter((id, i) => placed.indexOf(id) !== i), "placed twice").toEqual([]);
      expect(placed.filter((id) => !visible.includes(id)), "placed but not visible").toEqual([]);
      expect(rows.some((r) => r.kind === "more"), "a list of steps it could not place").toBe(false);
      expect(cutOff(chart, rows, false)).toEqual([]);
      const drawn = drawnEdges(chart, rows), real = realEdges(chart);
      expect([...drawn].filter((e) => !real.has(e)), "drawn but not in the workflow").toEqual([]);
      expect([...real].filter((e) => !drawn.has(e)), "in the workflow but not drawn").toEqual([]);
    });
  }

  it("an exit no edge leads to is the only node not drawn (Daily EOD reminder's check stops the run itself)", () => {
    const chart = chartOf(template("eod-reminder"), company);
    expect(chart.nodes.filter((n) => !n.hidden && !drawable(chart).includes(n.id)).map((n) => n.id)).toEqual(["x_nothing"]);
  });

  it("a fork inside each branch of a fork: both levels rejoin, and the steps after the outer join follow in order", () => {
    const tag = (id: string) => ({ id, type: "tags", title: id, add: [id] });
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
    // the steps after the outer join are on the spine, after the fork
    expect(rows.slice(rows.indexOf(fork) + 1).flatMap((r) => r.kind === "nodes" ? r.items.map((i) => i.id) : [])).toEqual(["k", "after", "x"]);
    expect(cutOff(chart, rows, false)).toEqual([]);
  });

  it("the shipped setter-call-logged is fully placed: the tap fork inside 'Jev unsure' inside 'setting or confirmation call'", () => {
    const chart = chartOf(template("setter-call-logged"), company); const rows = arrange(chart);
    expect(new Set(placedIds(rows))).toEqual(new Set(drawable(chart)));
    const kind = rows.find((r) => r.kind === "fork" && r.fork?.id === "b_kind"); if (kind?.kind !== "fork") throw new Error("no b_kind");
    const setting = kind.groups.find((g) => g.first === "a2")!;
    const ask = setting.rows.find((r) => r.kind === "fork" && r.fork?.id === "b_ask"); if (ask?.kind !== "fork") throw new Error("no b_ask");
    const unsure = ask.groups.find((g) => g.first === "q1")!;
    expect(unsure.rows.some((r) => r.kind === "fork" && r.fork?.id === "l1")).toBe(true);
    expect(placedIds(setting.rows).slice(-5)).toEqual(["k_task", "k_tag", "k_lost_dq", "k_lost_ni", "x1"]);
  });

  it("PMU's Call booked ends at Done, after its forks: the Slack card and Done are drawn", () => {
    const def = parseDefinition(JSON.parse(fs.readFileSync(path.join(PMU, "call-booked.json"), "utf8")).definition);
    const rows = arrange(chartOf(def, company));
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

  it("a step the walk cannot reach is still drawn, under More steps; past the depth limit the steps are listed in order", () => {
    const chart: Chart = { nodes: [{ id: "t", kind: "trig", title: "Start" }, { id: "a", kind: "tag", title: "A" }, { id: "lost", kind: "tag", title: "Nobody leads here" }], edges: [{ from: "t", to: "a", label: "" }] };
    const rows = arrange(chart); const more = rows[rows.length - 1];
    expect(more.kind === "more" && more.items.map((i) => i.id)).toEqual(["lost"]);
    // six forks deep, each with a way out to its own end
    const nodes: Chart["nodes"] = [{ id: "t", kind: "trig", title: "Start" }]; const edges: Chart["edges"] = [{ from: "t", to: "f0", label: "" }];
    for (let i = 0; i < 6; i++) { nodes.push({ id: `f${i}`, kind: "fork", title: `Fork ${i}` }, { id: `x${i}`, kind: "end", title: "Done" }); edges.push({ from: `f${i}`, to: i < 5 ? `f${i + 1}` : "y", label: "deeper" }, { from: `f${i}`, to: `x${i}`, label: "out" }); }
    nodes.push({ id: "y", kind: "end", title: "Done" });
    const deep = arrange({ nodes, edges }); const placed = placedIds(deep);
    expect(new Set(placed)).toEqual(new Set(nodes.map((n) => n.id))); expect(placed.length).toBe(nodes.length);
    expect(JSON.stringify(deep)).toContain("Too deep to draw as branches");
  });
});
