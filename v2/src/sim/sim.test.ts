import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXAMPLES } from "@/workflow/examples";
import { diffBehavior } from "./diff";
import { loadScenarioFolder } from "./files";
import { relative, timeOf } from "./scenario";
import { simulate, timelineText } from "./simulate";

const folder = (w: string) => path.resolve(__dirname, "../../scenarios/examples", w);
const show = (s: string) => { if (process.env.SIM_PRINT) console.log(s); };

describe.each(["pre-call-sequence", "payment-failed"])("the %s scenarios replay in the simulator", (w) => {
  const { content, scenarios } = loadScenarioFolder(folder(w));
  it.each(scenarios.map((s) => [s.file, s.scenario] as const))("%s", async (_f, scenario) => {
    const r = await simulate({ definition: EXAMPLES[w], scenario, content });
    show(timelineText(r));
    expect(r.expectations.failures).toEqual([]);
  });
});

describe("the simulator's timeline", () => {
  const { content, scenarios } = loadScenarioFolder(folder("pre-call-sequence"));
  const get = (name: string) => scenarios.find((s) => s.file === `${name}.json`)!.scenario;
  it("gives every outbox row its rendered words, gate decisions and time", async () => {
    const r = await simulate({ definition: EXAMPLES["pre-call-sequence"], scenario: get("booked-3-days-out"), content });
    expect(r.outbox.map((o) => [o.rel, o.contentKey, o.status])).toEqual([["+0m", "pre_call.booked", "sent"], ["+2d 4h", "pre_call.reminder_24h", "sent"], ["+3d 3h", "pre_call.reminder_1h", "sent"]]);
    expect(r.outbox[0]!.text).toBe("Hi Ana, you're booked for Thursday, October 29 at 2:00 PM.");
    expect(r.outbox[0]!.gates.map((g) => g.check)).toEqual(["delivery", "crm_writes", "dnd", "window", "cap", "breaker", "blank"]);
    expect(r.outbox[0]!.to).toBe("contact (sms)");
  });
  it("gives every wait its computed and fitted wake time", async () => {
    const r = await simulate({ definition: EXAMPLES["pre-call-sequence"], scenario: get("booked-for-7am"), content });
    expect(r.waits.map((x) => [x.node, x.relWake, x.moved, x.outcome, x.status])).toEqual([["w_24h", "+1d 22h", "to_opening", "next", "ok"], ["w_1h", "+2d 22h", "to_opening", null, "skipped"]]);
    expect(r.runs.map((x) => [x.status, x.endReason, x.relEnd])).toEqual([["ended", "call_not_on", "+2d 22h"]]);
  });
  it("refuses a scenario written for another workflow", async () => {
    await expect(simulate({ definition: EXAMPLES["payment-failed"], scenario: get("booked-3-days-out"), content })).rejects.toThrow("is for pre-call-sequence");
  });
  it("reads times as offsets from the start or as instants", () => {
    const start = new Date("2026-10-26T14:00:00Z");
    expect(timeOf("+2d3h30m", start).toISOString()).toBe("2026-10-28T17:30:00.000Z");
    expect(timeOf("2026-10-27T00:00:00Z", start).toISOString()).toBe("2026-10-27T00:00:00.000Z");
    expect(relative("2026-10-28T17:30:00Z", start)).toBe("+2d 3h 30m");
    expect(relative(start, start)).toBe("+0m");
  });
});

describe("diffBehavior", () => {
  const { content, scenarios } = loadScenarioFolder(folder("pre-call-sequence"));
  const all = scenarios.map((s) => s.scenario);
  const base = EXAMPLES["pre-call-sequence"] as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
  const edit = (f: (d: typeof base) => void) => { const d = structuredClone(base); f(d); return d; };
  const node = (d: typeof base, id: string) => d.nodes.find((n) => n.id === id)!;

  it("says there is no change when the behavior is the same", async () => {
    const d = await diffBehavior(base, edit((x) => { node(x, "m_24h").title = "The day-before reminder"; }), all, content);
    expect(d.same).toBe(true);
    expect(d.text).toBe("No behavior changes in any scenario.");
  });
  it("says when a reminder moves, scenario by scenario, in time relative to the start", async () => {
    const d = await diffBehavior(base, edit((x) => { (node(x, "w_1h").until as Record<string, unknown>).offset = "-2h"; }), all, content);
    show(d.text);
    const by = Object.fromEntries(d.scenarios.map((s) => [s.scenario, s.lines]));
    expect(by["booked 3 days out"]).toEqual(["~ pre_call.reminder_1h to contact (sms) moves from +3d 3h to +3d 2h"]);
    expect(by["booked 40 minutes out"]).toEqual([]);
    expect(by["booked for 7am"]).toEqual([]);
  });
  it("says what no longer happens and what happens instead", async () => {
    const d = await diffBehavior(base, edit((x) => { node(x, "m_24h").content = "pre_call.reminder_1h_no_link"; }), [all.find((s) => s.name === "booked 3 days out")!], content);
    expect(d.scenarios[0]!.lines).toEqual([
      "- pre_call.reminder_24h to contact (sms) at +2d 4h no longer happens",
      "+ pre_call.reminder_1h_no_link to contact (sms) at +2d 4h, sent",
    ]);
  });
  it("says when what the gate does changes, and when the run ends differently", async () => {
    const strict = edit((x) => { (x as Record<string, unknown>).premise = { label: "Booked and not on DND", holds: { and: [{ ne: ["{{appointment.status}}", "cancelled"] }, { gt: ["{{appointment.starts_at | minus:2h}}", "{{now}}"] }] }, endReason: "too_close" }; });
    const d = await diffBehavior(base, strict, [all.find((s) => s.name === "booked 3 days out")!], content);
    expect(d.scenarios[0]!.lines).toEqual(["- pre_call.reminder_1h to contact (sms) at +3d 3h no longer happens", "~ the run ends done → too_close"]);
  });
});

describe("scenario steps, the team and history as facts, and fixtures for what a vendor answers", () => {
  const wf = (nodes: unknown[], edges: unknown[], extra: Record<string, unknown> = {}) => ({ schema: 2, id: "w", name: "W", reentry: { policy: "always" }, nodes, edges, ...extra });
  const content = { "w.post": { channel: "slack" as const, body: "{{person.name | default:the offer}}: {{vars.answer | optional}}" } };
  const base = { name: "s", workflow: "w", start: "2026-10-26T14:00:00Z", offer: { zone: "America/New_York", settings: { "slack.channel.team": "C-TEAM" } }, contacts: [{ id: "c1", phone: "+15550100001" }] };

  it("a schedule step starts one run for the offer, or one per person with the trigger's role", async () => {
    const def = wf([
      { id: "t", type: "trigger@1", title: "6pm for each closer", on: { schedule: { at: "18:00", for: { role: "closer" } } } },
      { id: "m", type: "message@1", title: "DM", to: { slack: { dm: "{{person.slack_user_id}}" } }, content: "w.post" },
      { id: "x", type: "end@1", title: "Done", reason: "done" },
    ], [{ from: "t", to: "m" }, { from: "m", to: "x" }]);
    const r = await simulate({ definition: def, content, scenario: { ...base, people: [{ id: "u1", role: "closer", name: "Luis", slack_user_id: "U1" }, { id: "u2", role: "setter", name: "Mia" }, { id: "u3", role: "closer", name: "Ana", slack_user_id: "U3" }],
      steps: [{ at: "+0m", schedule: { node: "t" } }], expect: { outbox: ["+0m sent w.post", "+0m sent w.post"], ends: ["done", "done"] } } });
    expect(r.expectations.failures).toEqual([]);
    expect(r.outbox.map((o) => o.text)).toEqual(["Luis: ", "Ana: "]);
  });

  it("lets a scenario stand in for lookups (in turn) and reports, and answers the AI from its fixtures", async () => {
    const def = wf([
      { id: "t", type: "trigger@1", title: "A call", on: { event: "call.logged" } },
      { id: "l1", type: "action@1", title: "First look", action: "facts.lookup", params: { query: "call_conversation", params: {} }, into: "a" },
      { id: "l2", type: "action@1", title: "Second look", action: "facts.lookup", params: { query: "call_conversation", params: {} }, into: "b" },
      { id: "rp", type: "report@1", title: "Numbers", report: "reports.day", period: "in_progress", into: "rep" },
      { id: "c", type: "action@1", title: "Read it", action: "ai.classify", params: { input: "{{vars.a.text}}", prompt: "w.prompt", options: ["yes", "no"], threshold: 0.5, unclear: "no" }, into: "k" },
      { id: "s", type: "set@1", title: "Words", var: "answer", value: "{{vars.a.text}}/{{vars.b.text}}/{{vars.rep.body}}/{{vars.k.value}}" },
      { id: "m", type: "message@1", title: "Post", to: { slack: { channel: "{{setting.slack.channel.team}}" } }, content: "w.post" },
      { id: "x", type: "end@1", title: "Done", reason: "done" },
    ], [{ from: "t", to: "l1" }, { from: "l1", to: "l2" }, { from: "l2", to: "rp" }, { from: "rp", to: "c" }, { from: "c", to: "s" }, { from: "s", to: "m" }, { from: "m", to: "x" }]);
    const r = await simulate({ definition: def, content: { ...content, "w.prompt": { channel: "prompt", body: "Yes or no?" } }, scenario: { ...base,
      fixtures: { lookups: { call_conversation: [{ text: "one" }, { text: "two" }] }, reports: { "reports.day": { body: "3 calls" } }, classify: ["no"] },
      steps: [{ at: "+0m", type: "call.logged", contact: "c1" }], expect: { outbox: ["+0m sent ai.classify", "+0m sent w.post"], ends: ["done"] } } });
    expect(r.expectations.failures).toEqual([]);
    expect(r.outbox[1]!.text).toBe("the offer: one/two/3 calls/no");
  });

  it("answers a lookup the scenario gives no stand-in for from the projections, fed by the scenario's facts", async () => {
    const def = wf([
      { id: "t", type: "trigger@1", title: "A call", on: { event: "call.logged" } },
      { id: "l1", type: "action@1", title: "Look", action: "facts.lookup", params: { query: "calls_for_contact", params: {} }, into: "a" },
      { id: "s", type: "set@1", title: "Words", var: "answer", value: "{{vars.a.count}} calls, the first by {{vars.a.first.caller}}" },
      { id: "m", type: "message@1", title: "Post", to: { slack: { channel: "{{setting.slack.channel.team}}" } }, content: "w.post" },
      { id: "x", type: "end@1", title: "Done", reason: "done" },
    ], [{ from: "t", to: "l1" }, { from: "l1", to: "s" }, { from: "s", to: "m" }, { from: "m", to: "x" }]);
    const recording = { id: "rec-1", kind: "phone", status: "connected", direction: "outbound", started_at: "2026-10-26T13:50:00Z", ended_at: "2026-10-26T13:55:00Z", caller: { name: "Mia Chen", ghl_user_id: "U-MIA" } };
    const r = await simulate({ definition: def, content, scenario: { ...base, people: [{ id: "u-mia", role: "setter", name: "Mia Chen", ghl_user_id: "U-MIA" }],
      steps: [{ at: "+0m", type: "call.logged", contact: "c1", payload: { recording, recording_id: "rec-1", duration_sec: 300 } }], expect: { outbox: ["+0m sent w.post"], ends: ["done"] } } });
    expect(r.expectations.failures).toEqual([]);
    expect(r.outbox[0]!.text).toBe("the offer: 1 calls, the first by Mia Chen");
  });

  it("records the history before the start: it feeds the projections and starts nothing", async () => {
    const def = wf([
      { id: "t", type: "trigger@1", title: "Paid or tagged", on: { event: "tag.added" } },
      { id: "t2", type: "trigger@1", title: "Paid", on: { event: "payment.received" } },
      { id: "s", type: "set@1", title: "Words", var: "answer", value: "{{contact.cash_collected}} signed {{contact.agreement_signed}}" },
      { id: "m", type: "message@1", title: "Post", to: { slack: { channel: "{{setting.slack.channel.team}}" } }, content: "w.post" },
      { id: "x", type: "end@1", title: "Done", reason: "done" },
    ], [{ from: "t", to: "s" }, { from: "t2", to: "s" }, { from: "s", to: "m" }, { from: "m", to: "x" }]);
    const r = await simulate({ definition: def, content, scenario: { ...base,
      history: [{ at: "-2d", type: "payment.received", contact: "c1", payload: { payment_id: "p1", amount: 1500 } }, { at: "2026-10-25T10:00:00Z", type: "agreement.signed", contact: "c1" }],
      steps: [{ at: "+0m", type: "tag.added", contact: "c1" }], expect: { outbox: ["+0m sent w.post"], ends: ["done"] } } });
    expect(r.expectations.failures).toEqual([]);
    expect(r.outbox[0]!.text).toBe("the offer: 1500 signed true");
  });

  it("holds the run on a vendor's report the scenario gives no answer for", async () => {
    const def = wf([
      { id: "t", type: "trigger@1", title: "Hourly", on: { schedule: { every: "1h", for: "offer" } } },
      { id: "r", type: "report@1", title: "Probe", report: "reports.health", period: "in_progress", into: "h" },
      { id: "x", type: "end@1", title: "Done", reason: "done" },
    ], [{ from: "t", to: "r" }, { from: "r", to: "x" }]);
    const r = await simulate({ definition: def, content, reports: { "reports.health": { kind: "health_check", v1: "health.ts" } }, scenario: { ...base, steps: [{ at: "+0m", schedule: { node: "t" } }] } });
    expect(r.runs.map((x) => x.status)).toEqual(["paused"]);
    expect(r.alerts[0]!.message).toContain("fixtures.reports");
  });

  it("states the whole timeline in expect.outbox, and says when it differs", async () => {
    const def = wf([
      { id: "t", type: "trigger@1", title: "Tagged", on: { event: "tag.added" } },
      { id: "w1", type: "wait@1", title: "A day", until: { anchor: "now", offset: "+24h", zone: "offer" } },
      { id: "m", type: "message@1", title: "Post", to: { slack: { channel: "{{setting.slack.channel.team}}" } }, content: "w.post" },
      { id: "x", type: "end@1", title: "Done", reason: "done" },
    ], [{ from: "t", to: "w1" }, { from: "w1", to: "m" }, { from: "m", to: "x" }]);
    // a fact about the contact at +2h wakes the run early: "24 hours from now" is from when the wait began, so it keeps its time
    const steps = [{ at: "+0m", type: "tag.added", contact: "c1" }, { at: "+2h", type: "contact.updated", contact: "c1" }];
    const ok = await simulate({ definition: def, content, scenario: { ...base, steps, expect: { outbox: ["+1d sent w.post"], ends: ["done"] } } });
    expect(ok.expectations.failures).toEqual([]);
    const wrong = await simulate({ definition: def, content, scenario: { ...base, steps, expect: { outbox: ["+2h sent w.post"] } } });
    expect(wrong.expectations.failures).toEqual(['outbox ["+1d sent w.post"], expected ["+2h sent w.post"]']);
  });
});
