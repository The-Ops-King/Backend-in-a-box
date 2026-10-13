import { describe, it, expect } from "vitest";
import { chartOf, pathOf } from "./words";
import { parseDefinition, type Predicate } from "@/engine/definition";
import { notWords, onlyIfWords, predicateWords, skippedWords } from "@/engine/describe";
import { evaluate } from "@/engine/predicate";
import { templates } from "@/templates";
import fs from "node:fs";
import path from "node:path";

const company = { name: "Acme", timezone: "America/Chicago" };

describe("chartOf", () => {
  it("a filter (check) carries no else pill: what happens otherwise lives in its detail line only", () => {
    let checks = 0;
    for (const t of templates) {
      const chart = chartOf(parseDefinition(t.definition), company);
      for (const n of chart.nodes.filter((n) => n.kind === "check")) {
        checks++;
        expect(n).not.toHaveProperty("stop");
        expect(n.detail).toMatch(/Otherwise the run/);
      }
    }
    expect(checks).toBeGreaterThan(0);
  });
  it("a conditional (branch) keeps its 'otherwise' edge", () => {
    const elses = templates.flatMap((t) => chartOf(parseDefinition(t.definition), company).edges.filter((e) => e.else));
    expect(elses.length).toBeGreaterThan(0);
    for (const e of elses) { expect(e.else).toBe(true); expect(e.label.length).toBeGreaterThan(0); }
  });
});

// D103: a sometimes-step reads as one on the chart; Tyler read "A reschedule: card → Rescheduled" as a step every booking takes
const RESCHEDULE: Predicate = { eq: ["{{event._type}}", "appointment.rescheduled"] };
const NEW_BOOKING: Predicate = { neq: ["{{event._type}}", "appointment.rescheduled"] };
// a fixed fixture, not a client's copy (PMU's now forks instead): the shipped Call booked with its self-booked card move made a
// sometimes-step and a second sometimes-step after it, the shape Tyler read as two steps that always run
const pmuBooked = () => {
  const raw = structuredClone(templates.find((t) => t.slug === "call-booked")!.definition) as { nodes: Record<string, unknown>[]; edges: { from: string; to: string }[] };
  raw.nodes.find((n) => n.id === "s4")!.only_if = { neq: ["{{event._type}}", "appointment.rescheduled"] };
  const out = raw.edges.find((e) => e.from === "s4")!;
  raw.nodes.push({ id: "s4r", type: "pipeline_card", title: "A reschedule: card → Rescheduled (its name stays)", pipeline: "{{crm.pipeline_closer}}", stage: "{{crm.stage_closer_rescheduled}}", only_if: { eq: ["{{event._type}}", "appointment.rescheduled"] } });
  raw.edges.push({ from: "s4r", to: out.to }); out.to = "s4r";
  return parseDefinition(raw);
};
const shipped = () => [...templates.map((t) => ({ name: t.slug, def: parseDefinition(t.definition) })), ...fs.readdirSync(path.resolve(__dirname, "../../installs/pmu")).filter((f) => f.endsWith(".json")).map((f) => ({ name: `pmu/${f}`, def: parseDefinition(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../installs/pmu", f), "utf8")).definition) }))];

describe("D103: sometimes-steps", () => {
  it("a node with only_if carries its short condition; the full sentence stays in cond; a step without only_if carries none", () => {
    const chart = chartOf(pmuBooked(), company);
    const byId = new Map(chart.nodes.map((n) => [n.id, n]));
    expect(byId.get("s4r")).toMatchObject({ onlyIf: "a reschedule", cond: "Only if this is a reschedule" });
    expect(byId.get("s4")).toMatchObject({ onlyIf: "not a reschedule", cond: "Only if this is not a reschedule" });
    for (const n of chart.nodes) expect(!!n.onlyIf, n.id).toBe(!!pmuBooked().nodes.find((x) => x.id === n.id)?.only_if);
    // a card move that only skips when there is no card is not a sometimes-step: the blue mark, no dashed node
    const outcome = chartOf(parseDefinition(templates.find((t) => t.slug === "call-outcome")!.definition), company).nodes.find((n) => n.id === "k2")!;
    expect(outcome.cond).toMatch(/^Only if a card is already on that board/); expect(outcome.onlyIf).toBeUndefined();
  });
  it("the reschedule conditions read as intended, and so does every only_if shipped (no paths, filters or JSON)", () => {
    expect(predicateWords(RESCHEDULE)).toBe("this is a reschedule"); expect(onlyIfWords(RESCHEDULE)).toBe("a reschedule");
    expect(predicateWords(NEW_BOOKING)).toBe("this is not a reschedule"); expect(onlyIfWords(NEW_BOOKING)).toBe("not a reschedule");
    expect(predicateWords({ exists: "event.slot.from" })).toBe("there is a slot the call moved from");
    expect(predicateWords({ gte: ["{{appointment.starts_at | date:HH}}", "09"] })).toBe("the call is at 9 AM or later");
    expect(predicateWords({ eq: ["{{event._type}}", "payment.received"] })).toBe("this is a payment");
    expect(predicateWords({ neq: ["{{event.previous_outcome | default:}}:{{event.previous_call_outcome | default:}}", "{{event.outcome}}:{{appointment.call_outcome | default:}}"] }))
      .toBe("either the earlier answer is not the outcome or the earlier call outcome is not how the call went");
    let seen = 0;
    for (const { name, def } of shipped()) for (const n of def.nodes) if (n.only_if) {
      seen++;
      for (const w of [predicateWords(n.only_if), notWords(n.only_if)]) expect(w, `${name}/${n.id}`).not.toMatch(/\{\{|\}\}|\||[{}[\]]|\bthere is a [aeiou]|\bthere is an? (from|to)\b/);
    }
    expect(seen).toBeGreaterThan(30);
  });
  it("a skipped step says what held instead, right for a \"not\" too (the run log said \"only if this is not a reschedule; it is not\")", () => {
    expect(skippedWords(NEW_BOOKING)).toBe("only if this is not a reschedule; this is a reschedule");
    expect(skippedWords(RESCHEDULE)).toBe("only if this is a reschedule; this is not a reschedule");
    expect(skippedWords({ exists: "event.slot.from" })).toBe("only if there is a slot the call moved from; there is no slot the call moved from");
    expect(skippedWords({ in: ["{{appointment.pending_read.intent}}", ["cancelled", "reschedule_request"]] })).toBe("only if their unanswered reply is “cancelled” or a reschedule request; their unanswered reply is neither “cancelled” nor a reschedule request");
    expect(skippedWords({ not: RESCHEDULE })).toBe("only if not (this is a reschedule); this is a reschedule");
    expect(skippedWords({ gte: ["{{appointment.starts_at | date:HH}}", "09"] })).toBe("only if the call is at 9 AM or later; the call is before 9 AM");
    // an "and" names only the part that failed, as the executor evaluates it
    const p: Predicate = { and: [{ eq: ["{{setting.setter_result.act}}", true] }, { eq: ["{{vars.result}}", "follow_up"] }] };
    const ctx = { setting: { setter_result: { act: true } }, vars: { result: "dq" } };
    expect(skippedWords(p, (q) => evaluate(q, ctx))).toBe("only if setter-call actions are on and the result is follow up; the result is not follow up");
    expect(skippedWords(p)).toBe("only if setter-call actions are on and the result is follow up; setter-call actions are not on or the result is not follow up");
  });
  it("the step list: a planned sometimes-step carries its condition; a row skipped before D103 reads right", () => {
    const def = pmuBooked();
    const run = { id: "r1", status: "waiting", current_node: null, next_run_at: null, exit_reason: null, started_at: new Date("2026-10-13T15:00:00Z") };
    const step = (node_id: string, why: string) => ({ node_id, node_type: "pipeline_card", status: "skipped", started_at: new Date("2026-10-13T15:00:01Z"), finished_at: null, result: { kind: "noop", why }, error: null });
    const path = pathOf(def, run, [step("s4", "only if this is not a reschedule; it is not")], [], [{ node_id: "s4r", title: "x", kind: "step", at: null }], "UTC");
    expect(path.find((x) => x.node_id === "s4")).toMatchObject({ state: "skip", onlyIf: "not a reschedule", note: "Didn't go out: only if this is not a reschedule; this is a reschedule" });
    expect(path.find((x) => x.node_id === "s4r")).toMatchObject({ state: "next", onlyIf: "a reschedule" });
  });
});
