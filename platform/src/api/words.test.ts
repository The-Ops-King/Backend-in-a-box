import { describe, it, expect } from "vitest";
import { chartOf, pathOf, shortTitle } from "./words";
import { namer, UNREAD, UNREAD_MANY, type CrmNames } from "./crm-names";
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

// D112: Tyler trusts the chart only if its words come from what each step is set to do; a hand-written title is a label
describe("D112: a step's words are made from its settings", () => {
  const pmu = (f: string) => parseDefinition(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../installs/pmu", `${f}.json`), "utf8")).definition);
  const nodeOf = (def: ReturnType<typeof pmu>, id: string) => chartOf(def, company).nodes.find((n) => n.id === id)!;
  const line = (n: { title: string; meta?: string }) => `${n.title}${n.meta ? ` · ${n.meta}` : ""}`;

  it("a node with a title shows the generated main line, the title only as its label; a changed setting changes the words, not the title", () => {
    const def = pmu("call-booked");
    const rs = nodeOf(def, "c_rs");
    expect(rs.label).toBe("Card → Rescheduled, if it is before the call (its name stays)");
    expect(line(rs)).toBe("Move the card ‹Closer → Rescheduled› · only from New Lead, Scheduled, Unresponsive, Confirmed, No Show, Cancelled, Rescheduled · keeps its name · owner: the closer");
    // someone narrows the stages it moves from and lets it rename the card: the title still says the old thing, the words do not
    const edited = parseDefinition({ ...def, nodes: def.nodes.map((n) => (n.id === "c_rs" ? { ...n, from_stages: ["{{crm.stage_closer_scheduled}}", "{{crm.stage_closer_confirmed}}"], keep_name: false } : n)) });
    const after = nodeOf(edited, "c_rs");
    expect(after.label).toBe(rs.label);
    expect(line(after)).toBe("Move the card ‹Closer → Rescheduled› · only from Scheduled, Confirmed · named [full name] -- Direct/Setter · owner: the closer");
    // a task's title is the task itself, not a label
    expect(nodeOf(def, "k3")).toMatchObject({ title: "Task for the closer: send them a personalized video", meta: "due in 1 day", label: undefined });
  });

  it("a card move says its board and stage, its name, its status, the stages it moves from, and that it needs a card", () => {
    expect(line(nodeOf(pmu("call-booked"), "c_new"))).toBe("Move the card ‹Closer → Scheduled› · named [full name] -- Direct/Setter · owner: the closer");
    expect(line(nodeOf(pmu("pre-call-sequence"), "k_conf"))).toBe("Move the card ‹Closer → Confirmed› · only if there is a card");
    const outcome = parseDefinition(templates.find((t) => t.slug === "call-outcome")!.definition);
    expect(line(nodeOf(outcome, "k3"))).toBe("Move the card ‹Closer → Lost› · marked lost · only if there is a card");
    expect(line(nodeOf(parseDefinition(templates.find((t) => t.slug === "deal-closed")!.definition), "p2"))).toBe("Mark the card won ‹Setter›");
  });

  it("a CRM record says which object, update or write, and the values that matter", () => {
    expect(line(nodeOf(pmu("call-booked"), "k5"))).toBe("Update the Sales Call record for the slot the call moved from · outcome = rescheduled");
    expect(line(nodeOf(pmu("call-booked"), "k4"))).toMatch(/^Write the Sales Call record · outcome = scheduled · \+\d+ more fields$/);
    expect(line(nodeOf(pmu("call-outcome"), "r2"))).toBe("Update the Sales Call record · outcome = no-show · empties 6 fields");
    expect(line(nodeOf(pmu("call-outcome"), "r1"))).toBe("Update the Sales Call record · outcome = showed, sets disposition · empties 1 field");
  });

  it("the other kinds read as what they do", () => {
    const pre = pmu("pre-call-sequence");
    expect(line(nodeOf(pre, "n_conf_slack"))).toBe("Slack: Confirmed · in the thread of the booking post · reacts :white_check_mark:");
    expect(line(nodeOf(pre, "e1"))).toBe("Email: You're booked: [call time] — reply to lock it in");
    expect(line(nodeOf(pre, "c0"))).toBe("Check there is a CRM contact · waits up to 1 hour");
    expect(line(nodeOf(pmu("call-booked"), "n1"))).toBe("Update the contact · owner: the closer, appointment date");
    expect(line(nodeOf(pmu("call-booked"), "n4"))).toBe("Slack: Call rescheduled or New call booked · to the bookings channel");
    const setter = parseDefinition(templates.find((t) => t.slug === "setter-call-logged")!.definition);
    expect(nodeOf(setter, "a3").title).toBe("Jev: set, follow up, DQ or not interested?");
    expect(nodeOf(setter, "c_latest").title).toBe("Check there are no later parts already in");
    expect(nodeOf(pmu("call-recorded"), "x_linked").title).toBe("Done: linked by the team");
  });

  it("no main line of any step of any shipped template or PMU copy, helpers included, shows a binding, an id, JSON or Slack markup", () => {
    let n = 0; const helpers = new Set<string>();
    for (const { name, def } of shipped()) for (const node of [...chartOf(def, company).nodes, ...def.nodes.map((x) => ({ id: x.id, type: x.type, ...shortTitle(def, x) }))]) {
      n++; if ("type" in node) helpers.add(node.type);
      const words = line(node).replace(/“[^”]*”/g, "").replace(/:[a-z0-9_+-]+:/g, "");
      expect(words, `${name}/${node.id}`).not.toMatch(/\{\{|\}\}|[{}]|\b[0-9a-f]{8}-[0-9a-f]{4}|\b[A-Za-z0-9]{20,}\b|\b(crm|vars|event|contact|appointment|slack|picklist|recording|setting|user|reply|reaction)\.[a-z]|_|(^|\s)\*\S|\S\*(\s|$)/);
    }
    for (const t of ["set_var", "classify", "lookup", "wait"]) expect(helpers).toContain(t);
    expect(n).toBeGreaterThan(900);
  });

  it("a remembered value says what is kept and its cases in words", () => {
    const booked = pmu("call-booked"); const at = (id: string) => line(shortTitle(booked, booked.nodes.find((x) => x.id === id)!));
    expect(at("b1")).toBe("Remember the setter line: ‘Setter: [setter]’");
    expect(at("s1")).toBe("Remember the setter line: nothing");
    expect(at("v4")).toBe("Remember the Slack card's look · ‘Call rescheduled’ :repeat: if this is a reschedule, otherwise ‘New call booked’ :telephone_receiver: :calendar: :date: :spiral_calendar_pad:");
    expect(at("v_type")).toBe("Remember the call type · by the term name; Demo call → ‘demo’; otherwise ‘closing’");
    const pre = pmu("pre-call-sequence");
    expect(line(shortTitle(pre, pre.nodes.find((x) => x.id === "v_decided")!))).toBe("Remember what the team decided · by the tap; :white_check_mark: → ‘confirmed’; :x: → ‘cancelled’; :repeat: → ‘reschedule request’; otherwise nothing");
  });

  it("two steps of one workflow never share a main line, so an arrow \"on to …\" names one step", () => {
    for (const { name, def } of shipped()) {
      const titles = chartOf(def, company).nodes.map((x) => x.title);
      expect(titles.filter((t, i) => titles.indexOf(t) !== i), name).toEqual([]);
    }
    const pre = chartOf(pmu("pre-call-sequence"), company).nodes; const t = (id: string) => pre.find((x) => x.id === id)!.title;
    expect([t("m72"), t("m1"), t("mm")]).toEqual(["Text, 3 days before the call", "Text, 1 hour before the call", "Text, when the call is at 11am or later"]);
    const chase = chartOf(parseDefinition(templates.find((x) => x.slug === "agreement-chase")!.definition), company).nodes; const c = (id: string) => chase.find((x) => x.id === id)!.title;
    expect([c("c1"), c("c2"), c("c3")]).toEqual(["Check they have not signed the agreement", "Check they have not signed the agreement (2nd time)", "Check they have not signed the agreement (3rd time)"]);
  });

  it("the step list uses the same words", () => {
    const def = pmu("call-booked");
    const run = { id: "r1", status: "completed", current_node: null, next_run_at: null, exit_reason: "booked", started_at: new Date("2026-10-13T15:00:00Z") };
    const path = pathOf(def, run, [{ node_id: "c_rs", node_type: "pipeline_card", status: "ok", started_at: new Date("2026-10-13T15:00:01Z"), finished_at: null, result: {}, error: null }], [], [], "UTC");
    expect(path.find((x) => x.node_id === "c_rs")).toMatchObject({ title: "Move the card ‹Closer → Rescheduled›", meta: "only from New Lead, Scheduled, Unresponsive, Confirmed, No Show, Cancelled, Rescheduled · keeps its name · owner: the closer" });
  });
});

// the coordinator's bar for D112: the CRM's own names, every stage listed, and a name not read is never passed off as one
describe("D112: boards, stages and fields by the CRM's names", () => {
  const pmu = (f: string) => parseDefinition(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../installs/pmu", `${f}.json`), "utf8")).definition);
  const keys = ["new_lead", "scheduled", "unresponsive", "confirmed", "no_show", "cancelled", "rescheduled"];
  const ghlNames = ["New Lead", "Booked Call", "Unresponsive - Call Unconfirmed", "Call Confirmed", "No Show", "No-Show / Cancel / Reschedule", "Rescheduled"];
  const bindings = { "crm.pipeline_closer": "PIPE1", ...Object.fromEntries(keys.map((k, i) => [`crm.stage_closer_${k}`, `ST${i}`])), "crm.field_contact_appointment_date": "FLD1", "crm.field_contact_setter": "FLD2", "crm.field_opportunity_setter_owner": "FLD3" };
  const read: CrmNames = { read: true, pipelines: { PIPE1: "Beauty Moguls" }, stages: Object.fromEntries(ghlNames.map((nm, i) => [`ST${i}`, nm])), fields: { FLD1: "Appointment Date & Time", FLD2: "Setter", FLD3: "Setter Owner" }, objects: { "custom_objects.sales_call": "Sales Call" } };
  const chart = (def: ReturnType<typeof pmu>, names: CrmNames | null) => chartOf(def, company, bindings, "ghl", namer(bindings, names));
  const at = (c: ReturnType<typeof chart>, id: string) => { const n = c.nodes.find((x) => x.id === id)!; return `${n.title}${n.meta ? ` · ${n.meta}` : ""}`; };

  it("read from GHL: PMU's new card goes to Booked Call on Beauty Moguls, and the reschedule lists every stage it moves from by GHL's name", () => {
    const c = chart(pmu("call-booked"), read);
    expect(at(c, "c_new")).toBe("Move the card ‹Beauty Moguls → Booked Call› · named [full name] -- Direct/Setter · owner: the closer");
    expect(at(c, "c_rs")).toBe("Move the card ‹Beauty Moguls → Rescheduled› · only from New Lead, Booked Call, Unresponsive - Call Unconfirmed, Call Confirmed, No Show, No-Show / Cancel / Reschedule, Rescheduled · keeps its name · owner: the closer");
    expect(at(c, "n1")).toBe("Update the contact · owner: the closer, Appointment Date & Time");
    // the popover lists them too
    expect(c.nodes.find((x) => x.id === "c_rs")!.detail).toContain("only a card on New Lead, Booked Call, Unresponsive - Call Unconfirmed, Call Confirmed, No Show, No-Show / Cancel / Reschedule, Rescheduled moves");
    expect(JSON.stringify(c.nodes)).not.toContain("not read from GHL");
  });

  it("GHL could not be read: the key words stand in, marked, never as if they were GHL's", () => {
    const c = chart(pmu("call-booked"), { read: false, pipelines: {}, stages: {}, fields: {}, objects: {} });
    expect(at(c, "c_new")).toBe(`Move the card ‹Closer → Scheduled› · Closer, Scheduled: ${UNREAD_MANY} · named [full name] -- Direct/Setter · owner: the closer`);
    expect(at(c, "c_rs")).toContain(`only from New Lead, Scheduled, Unresponsive, Confirmed, No Show, Cancelled, Rescheduled (${UNREAD_MANY})`);
    expect(at(c, "n1")).toBe(`Update the contact · owner: the closer, appointment date (${UNREAD})`);
    expect(at(c, "k4")).toContain(`Write the Sales Call record (${UNREAD})`);
  });

  it("the run log's D105 skip names the stage the card was on by GHL's name", () => {
    const def = pmu("call-booked");
    const run = { id: "r1", status: "completed", current_node: null, next_run_at: null, exit_reason: "booked", started_at: new Date("2026-10-13T15:00:00Z") };
    const step = { node_id: "c_rs", node_type: "pipeline_card", status: "skipped", started_at: new Date("2026-10-13T15:00:01Z"), finished_at: null, result: { kind: "noop", why: "left where it is: the card is on Follow Up, a stage this step does not move from", stage: "ST9" }, error: null };
    const names = { ...read, stages: { ...read.stages, ST9: "Follow Up - Hot" } };
    expect(pathOf(def, run, [step], [], [], "UTC", namer(bindings, names)).find((x) => x.node_id === "c_rs")!.note).toBe("Didn't go out: left where it is: the card is on Follow Up - Hot, a stage this step does not move from");
    expect(pathOf(def, run, [step], [], [], "UTC", namer(bindings, { ...read, read: false, stages: {} })).find((x) => x.node_id === "c_rs")!.note).toBe(`Didn't go out: left where it is: the card is on ST9 (${UNREAD}), a stage this step does not move from`);
  });
});

