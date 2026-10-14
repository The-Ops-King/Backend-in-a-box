import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { chartOf, type Chart } from "@/api/words";
import { parseDefinition, type Definition } from "@/engine/definition";
import { templates } from "@/templates";
import { arrange, placedIds } from "./arrange";
import { exactness, graphGeometry, svgDrawing } from "./exact";
import { tidyOf } from "./pick";
import { draw, drawGraph } from "./draw";

const svgOf = (chart: Chart, rows = arrange(chart)) => svgDrawing(draw(rows, 1000, () => null, false));
const graphSvg = (chart: Chart, g: Awaited<ReturnType<typeof layoutGraph>>) => svgDrawing(drawGraph(g, chart, 1000, 240, () => null).svg);
import { layoutGraph } from "./graph";

// D111: the ways a run leaves a step that are not edges of the definition (executor.ts / runner.ts) are drawn, and the
// check fails a drawing that leaves one out
const company = { name: "Acme", timezone: "America/Chicago" };
const tag = (id: string) => ({ id, type: "tags", title: `Step ${id}`, add: [id] });
const done = { id: "x", type: "exit", reason: "done" };
const def = (nodes: unknown[], edges: unknown[]) => parseDefinition({ schema: 1, reentry: "always", nodes: [{ id: "t", type: "trigger", event: "appointment.booked" }, ...nodes], edges: [{ from: "t", to: nodes.length ? (nodes[0] as { id: string }).id : "x" }, ...edges] } as unknown as Definition);
const soon = { anchor: "now", offset: "+1h", tz: "contact" };

/** The chart holds `line`; both layouts draw it exactly; a drawing without it is caught. */
function holds(chart: Chart, line: { from: string; to: string; label: string; else?: boolean }) {
  expect(chart.edges).toContainEqual(expect.objectContaining({ from: line.from, to: line.to, label: line.label, ...(line.else ? { else: true } : {}) }));
  const t = tidyOf(chart); expect(t.tidy.problems).toEqual([]);
  const d = svgOf(chart, t.rows);
  const without = { ...d, lines: d.lines.filter((l) => !(l.from === line.from && l.to === line.to && l.label.toLowerCase() === line.label.toLowerCase())) };
  expect(exactness(chart, without).problems).toContainEqual(expect.stringMatching(/is not drawn$/));
}

describe("D111: every way out of a step is on the chart, edge or not", () => {
  it("a check that otherwise stops: an end beside it, “otherwise”", () => {
    const chart = chartOf(def([{ id: "c", type: "check", when: { exists: "contact.phone" }, else_exit: "no_phone" }, tag("a"), done], [{ from: "c", to: "a" }, { from: "a", to: "x" }]), company);
    holds(chart, { from: "c", to: "c~stop", label: "otherwise", else: true });
    expect(chart.nodes.find((n) => n.id === "c~stop")).toMatchObject({ kind: "end", title: "Stop: no phone number" });
    // drawn off the check's side, the run's main way going on down the spine
    const rows = arrange(chart); const first = rows[1]; if (first.kind !== "nodes") throw new Error("no steps");
    expect(first.items.map((i) => [i.id, (i.exits ?? []).map((e) => e.id)])).toEqual([["c", ["c~stop"]], ["a", []], ["x", []]]);
  });

  it("a check that looks again and then pauses for a person: “otherwise, after looking for up to …”", () => {
    const chart = chartOf(def([{ id: "c", type: "check", when: { exists: "contact.ghl_contact_id" }, else_exit: "no_crm_id", else_pause: "GHL never had the person", retry: { every: "5m", for: "1h" } }, done], [{ from: "c", to: "x" }]), company);
    holds(chart, { from: "c", to: "c~pause", label: "otherwise, after looking for up to 1 hour", else: true });
    expect(chart.nodes.find((n) => n.id === "c~pause")?.title).toBe("Paused for a person: GHL never had the person");
  });

  it("Daily EOD reminder's check: otherwise “Stop: nothing to file”, its own end; the exit step nothing leads to is never run, so not drawn", () => {
    const chart = chartOf(parseDefinition(templates.find((t) => t.slug === "eod-reminder")!.definition), company);
    holds(chart, { from: "c_due", to: "c_due~stop", label: "otherwise", else: true });
    expect(chart.nodes.find((n) => n.id === "c_due~stop")?.title).toBe("Stop: nothing to file");
    expect(placedIds(arrange(chart))).not.toContain("x_nothing");
  });

  it("a branch with no otherwise way: none of these → paused for a person", () => {
    const chart = chartOf(def([{ id: "b", type: "branch" }, tag("a"), done], [{ from: "b", to: "a", label: "a referral", when: { eq: ["{{contact.source}}", "ref"] } }, { from: "a", to: "x" }]), company);
    holds(chart, { from: "b", to: "b~pause", label: "none of these", else: true });
  });

  it("a reply wait with no timeout way: no reply in time → the run stops", () => {
    const chart = chartOf(def([{ id: "w", type: "wait_for_reply", timeout: "4h" }, tag("a"), done], [{ from: "w", to: "a", label: "replied" }, { from: "a", to: "x" }]), company);
    holds(chart, { from: "w", to: "w~stop", label: "no reply in time" });
  });

  it("a step with no way on, or an event wait with no way for an outcome, is refused by the definition: nothing to draw", () => {
    expect(() => def([tag("a"), done], [])).toThrow(/node a \(tags\) has no outgoing edge/);
    expect(() => def([{ id: "w", type: "wait_for_event", event: "appointment.booked", until: soon }, tag("a"), done], [{ from: "w", to: "a", label: "event" }, { from: "a", to: "x" }])).toThrow(/has no edge labeled .{0,2}until/);
  });

  it("a text that pauses when it is out of date: out of date → paused for a person", () => {
    const chart = chartOf(def([{ id: "s", type: "send_sms", template: "Hi", on_stale: "escalate" }, done], [{ from: "s", to: "x" }]), company);
    holds(chart, { from: "s", to: "s~pause", label: "out of date" });
  });

  it("a hand-off to another workflow ends this run: its own edges are never taken, so not drawn", () => {
    const chart = chartOf(def([{ id: "h", type: "start_workflow", workflow: "Speed to lead" }, done], [{ from: "h", to: "x" }]), company);
    holds(chart, { from: "h", to: "h~handoff", label: "" });
    expect(chart.edges.some((e) => e.from === "h" && e.to === "x")).toBe(false);
    expect(chart.nodes.find((n) => n.id === "h~handoff")?.title).toBe("Hands off to “Speed to lead”");
  });

  it("resume: back to the step the run was on, from the listener's onward way (PMU's pre-call reminders)", () => {
    const pre = parseDefinition(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../installs/pmu/pre-call-sequence.json"), "utf8")).definition);
    const chart = chartOf(pre, company);
    holds(chart, { from: "rs", to: "r72", label: "back to the step the run was on: “Wait until 3 days before the call” or one after it" });
    expect(chart.edges.filter((e) => e.from === "rs")).toHaveLength(1);
    // setter-call-logged: both of its resumes go back to the question's hold, or a step after it
    const scl = chartOf(parseDefinition(templates.find((t) => t.slug === "setter-call-logged")!.definition), company);
    for (const r of ["rs", "rs2"]) expect(scl.edges.filter((e) => e.from === r).map((e) => [e.to, e.label])).toEqual([["w_hold", "back to the step the run was on: “Wait 2 days” or one after it"]]);
  });

  it("the plain graph draws them too", async () => {
    const chart = chartOf(def([{ id: "c", type: "check", when: { exists: "contact.phone" }, else_exit: "no_phone" }, { id: "b", type: "branch" }, tag("a"), done], [{ from: "c", to: "b" }, { from: "b", to: "a", label: "a referral", when: { eq: ["{{contact.source}}", "ref"] } }, { from: "a", to: "x" }]), company);
    const g = await layoutGraph(chart, () => ({ w: 160, h: 40 }), (s) => ({ w: s.length * 7, h: 15 }));
    expect(exactness(chart, graphSvg(chart, g)).problems).toEqual([]);
    expect(g.edges.map((e) => `${e.from}>${e.to}`)).toEqual(expect.arrayContaining(["c>c~stop", "b>b~pause"]));
    expect(exactness(chart, { ...graphSvg(chart, g), lines: graphSvg(chart, g).lines.filter((l) => l.to !== "c~stop") }).problems).toContainEqual(expect.stringMatching(/is not drawn$/));
  });
});
