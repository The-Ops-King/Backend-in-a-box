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
