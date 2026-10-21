import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/db/client";
import { chain, flow, harness, STORES } from "@/test/harness";
import { type MetricCtx, metric } from "./metrics";
import { periodFor, rangeLabel } from "./periods";

/**
 * Metrics as data over the projections, and report@1 rendering an offer's report definitions with them: Hair's own
 * wrap-up layout, the leaderboard and the end-of-day list, fed by facts.
 */

const HAIR = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../offers/hair/reports.json"), "utf8")) as Record<string, unknown>;
const NY = "America/New_York";
type N = Record<string, unknown>;
const reportWf = (report: string, period: "just_ended" | "in_progress", params: N = {}) => flow("w", [
  { id: "t", type: "trigger@1", title: "Ask", on: { event: "tag.added" } },
  { id: "r", type: "report@1", title: "Numbers", report, period, into: "r", ...(Object.keys(params).length ? { params } : {}) },
  { id: "m", type: "message@1", title: "Post", to: { slack: { channel: "{{setting.slack.channel.ops}}" } }, content: "c.m" },
  { id: "x", type: "end@1", title: "Done", reason: "done" },
], chain("t", "r", "m", "x"));
const content = { "c.m": { channel: "slack" as const, body: "{{vars.r.body}}" } };
const SETTINGS = { "slack.channel.ops": "C-OPS", "payments.contract_value": 2999, "calls.reached_seconds": 60 };

/** A day of Hair's: two leads, three bookings (one self-booked), a dial, a show and a no-show, a close, payments and a refund. */
async function aDay(h: Awaited<ReturnType<typeof harness>>) {
  const at = (t: string) => h.clock.set(`2026-10-26T${t}:00Z`);
  await h.ingest("person.added", { contact: null, payload: { person: { id: "u1", name: "Luis Ortega", ghl_user_id: "U-L", roles: ["closer"] } } });
  await h.ingest("person.added", { contact: null, payload: { person: { id: "u2", name: "Ana Diaz", ghl_user_id: "U-A", roles: ["closer"] } } });
  at("14:00"); await h.ingest("lead.created", { contact: "c1", payload: { contact: { name: "Kim Lee", source: "Facebook ads", fields: { hair_loss: "Thinning" } } } });
  at("15:00"); await h.ingest("lead.created", { contact: "c2", payload: { contact: { name: "Bo Park", source: "Google", fields: { hair_loss: "None" } } } });
  at("14:10"); await h.ingest("call.logged", { contact: "c1", payload: { recording_id: "r1", duration_sec: 120, recording: { id: "r1", kind: "phone", status: "connected", direction: "outbound", started_at: "2026-10-26T14:10:00Z", caller: { name: "Mia" } } } });
  at("14:30");
  await h.ingest("appointment.booked", { contact: "c1", appointment: "a1", payload: { appointment: { starts_at: "2026-10-26T17:00:00Z", term: { category: "closing" }, self_booked: true, closer: { ghl_user_id: "U-L" }, answers: { "hair_loss_stage": "Early", "commit": "Yes" } } } });
  await h.ingest("appointment.booked", { contact: "c2", appointment: "a2", payload: { appointment: { starts_at: "2026-10-26T18:00:00Z", term: { category: "closing" }, self_booked: false, set_by: "Mia", closer: { ghl_user_id: "U-A" }, answers: { "hair_loss_stage": "Early" } } } });
  await h.ingest("appointment.booked", { contact: "c2", appointment: "a3", payload: { appointment: { starts_at: "2026-10-29T18:00:00Z", term: { category: "closing" }, self_booked: false, set_by: "Mia", closer: { ghl_user_id: "U-A" } } } });
  at("18:00"); await h.ingest("appointment.outcome", { contact: "c1", appointment: "a1", payload: { outcome: "showed", call_outcome: "closed" } });
  at("19:00"); await h.ingest("appointment.outcome", { contact: "c2", appointment: "a2", payload: { outcome: "noshow" } });
  at("19:30"); await h.ingest("payment.received", { contact: "c1", payload: { payment_id: "p1", amount: 2999 } });
  await h.ingest("deal.won", { contact: "c1", deal: "d1", payload: {} });
  at("20:00"); await h.ingest("payment.received", { contact: "c2", payload: { payment_id: "p2", amount: 500 } });
  at("21:00"); await h.ingest("payment.refunded", { contact: "c2", payload: { payment_id: "p3", amount: 100, refund_of: "p2" } });
  at("23:00");
}

afterAll(async () => { await closeDb(); });

describe("periods", () => {
  it("are the offer's days, Monday weeks and months, just ended or in progress, with v1's labels", () => {
    const mon = new Date("2026-11-02T14:00:00Z");
    expect(periodFor("weekly", "just_ended", mon, NY)).toMatchObject({ from: "2026-10-26", to: "2026-11-01", name: "Last week", label: "Oct 26 – Nov 1" });
    expect(periodFor("weekly", "in_progress", mon, NY)).toMatchObject({ from: "2026-11-02", to: "2026-11-02", name: "This week" });
    expect(periodFor("monthly", "just_ended", mon, NY)).toMatchObject({ from: "2026-10-01", to: "2026-10-31", name: "Last month", label: "Oct 1–31" });
    expect(periodFor("daily", "in_progress", new Date("2026-10-27T03:00:00Z"), NY)).toMatchObject({ from: "2026-10-26", to: "2026-10-26" });
    expect(periodFor("daily", "in_progress", new Date("2026-10-27T03:00:00Z"), NY).end.toISOString()).toBe("2026-10-27T04:00:00.000Z");
    expect(rangeLabel("2025-12-29", "2026-01-04", mon, NY)).toBe("Dec 29, 2025 – Jan 4, 2026");
  });
});

describe.each(STORES)("metrics and reports, on %s", (kind) => {
  it("count and sum what happened in a period, split by closer, setter and source; a rate is two of them divided", async () => {
    const h = await harness(kind, { start: "2026-10-26T12:00:00Z", zone: NY, settings: SETTINGS, reports: HAIR, workflows: [], content: {} });
    await aDay(h);
    const day = periodFor("daily", "in_progress", h.clock.now(), NY);
    const read = async (name: string, by?: "closer" | "setter" | "source") => h.store.tx(async (tx) => {
      const c: MetricCtx = { tx, offerId: h.offerId, settings: await tx.settings(h.offerId), now: h.clock.now(), defs: await tx.reportDefinitions(h.offerId, "metric"), people: await tx.projFind("people", h.offerId) };
      const r = await metric(c, name, day, by);
      return by ? Object.fromEntries(r.rows) : r.unavailable ? `unavailable: ${r.unavailable}` : r.value;
    });
    expect(await read("leads")).toBe(2);
    expect(await read("leads", "source")).toEqual({ "Facebook ads": 1, Google: 1 });
    expect([await read("booked"), await read("booked_self"), await read("booked_set")]).toEqual([3, 1, 2]);
    expect(await read("booked_set", "setter")).toEqual({ "name:Mia": 2 });
    expect([await read("dials"), await read("connected"), await read("speed_to_lead")]).toEqual([1, 1, 10]);
    expect([await read("calls_due"), await read("shows"), await read("no_shows"), await read("calls_missing")]).toEqual([2, 1, 1, 0]);
    expect(await read("show_rate")).toBe(0.5);
    expect(await read("shows", "closer")).toEqual({ "crm:U-L": 1 });
    expect([await read("closes"), await read("revenue")]).toEqual([1, 2999]);
    expect([await read("cash_collected"), await read("cash_gross"), await read("refunds")]).toEqual([3399, 3499, 100]);
    expect(await read("cash_collected", "closer")).toEqual({ "crm:U-L": 2999, "crm:U-A": 400 });
    // a metric whose settings are unset is not there (its line says nothing); set, it counts
    expect(await read("mqls")).toBe("unavailable: the setting leads.qualifying_field is not set");
    await h.store.tx(async (tx) => { await tx.setSetting(h.offerId, "leads.qualifying_field", "hair_loss", "t"); await tx.setSetting(h.offerId, "leads.mql_answers", ["Thinning"], "t"); });
    expect(await read("mqls")).toBe(1);
  });

  it("renders Hair's daily wrap-up in its own layout from the metrics, and its empty line on a day with nothing", async () => {
    const h = await harness(kind, { start: "2026-10-26T12:00:00Z", zone: NY, settings: SETTINGS, reports: HAIR, content, workflows: [reportWf("reports.daily_wrap_up", "in_progress")] });
    await h.ingest("tag.added", { contact: "c9", payload: {} });
    await aDay(h);
    await h.ingest("tag.added", { contact: "c9", payload: {} });
    const [quiet, busy] = h.fp.effects("slack").map((c) => (c.args as { text: string }).text);
    expect(quiet).toBe("Nothing today: no leads, bookings, calls or payments.");
    expect(busy).toBe([
      "📊 *Today, Mon, Oct 26*", "", "```", "Leads               2", "New bookings        3", "  by setters        2", "Calls due           2", "Showed              1", "No-shows            1",
      "Show rate         50%", "Closes              1", "Close rate       100%", "Revenue        $2,999", "Cash           $3,399", "Refunds          $100", "Dials               1", "Connected           1",
      "Speed to lead  10 min", "```", "", "*What they said*", "*hair loss stage*", "• 2 — Early", "", "*commit*", "• 1 — Yes", "", "_From GHL and the engine, read 7:00 PM EDT_",
    ].join("\n"));
  });

  it("ranks last week's closers by cash and setters by sets, with their rates", async () => {
    const h = await harness(kind, { start: "2026-10-26T12:00:00Z", zone: NY, settings: SETTINGS, reports: HAIR, content: { "c.m": { channel: "slack", body: "{{vars.r.body}}\n_{{vars.r.period_name}} · {{vars.r.period_label}}_" } }, workflows: [reportWf("reports.leaderboard", "just_ended")] });
    await aDay(h);
    h.clock.set("2026-11-02T14:00:00Z");
    await h.ingest("tag.added", { contact: "c9", payload: {} });
    expect(h.fp.effects("slack").map((c) => (c.args as { text: string }).text)).toEqual([[
      "🏆 *Leaderboard*", "*Closers* (by cash)", "```", "1. Luis  $2,999  1 close   100%", "2. Ana     $400  0 closes", "```", "*Setters* (by sets)", "```", "1. Mia  2 sets  0% showed", "```", "_Last week · Oct 26 – Nov 1_",
    ].join("\n")]);
  });

  it("lists a closer's days still to file: held calls with no answer, not on a day they filed; today only when asked", async () => {
    const reads = { salesCallsBlank: async () => [{ day: "2026-10-23", name: "Kim Lee", appointment_id: null }] };
    const settings = { ...SETTINGS, "platform.base_url": "https://app.example.com" };
    const wf = (include: string) => flow("w", [
      { id: "t", type: "trigger@1", title: "6pm", on: { schedule: { at: "18:00", for: { role: "closer" } } } },
      { id: "r", type: "report@1", title: "Due", report: "reports.eod_due", period: "in_progress", into: "r", params: { lookback_days: "7", include_today: include, overdue_after_days: "2" } },
      { id: "m", type: "message@1", title: "Post", to: { slack: { channel: "{{setting.slack.channel.ops}}" } }, content: "c.m" },
      { id: "x", type: "end@1", title: "Done", reason: "done" },
    ], chain("t", "r", "m", "x"));
    const words = { "c.m": { channel: "slack" as const, body: "{{vars.r.count}}: {{vars.r.days | each:\"{{item.when}} {{item.calls}}+{{item.ghl_blank}} {{item.url}}\" | join:\"; \"}} / overdue {{vars.r.overdue | each:\"{{item.label}} {{item.names | join}}\" | optional}}" } };
    const h = await harness(kind, { start: "2026-10-26T12:00:00Z", zone: NY, settings, reports: HAIR, content: words, reads, workflows: [wf("true")] });
    await aDay(h);
    await h.ingest("appointment.booked", { contact: "c3", appointment: "a4", payload: { appointment: { starts_at: "2026-10-24T15:00:00Z", term: { category: "closing" }, closer: { ghl_user_id: "U-L" } } } });
    await h.ingest("appointment.booked", { contact: "c4", appointment: "a5", payload: { appointment: { starts_at: "2026-10-25T15:00:00Z", term: { category: "closing" }, closer: { ghl_user_id: "U-L" } } } });
    await h.ingest("eod.filed", { contact: null, payload: { user_id: "u1", day: "2026-10-25" } });
    await h.ingest("appointment.booked", { contact: "c5", appointment: "a6", payload: { appointment: { starts_at: "2026-10-26T16:00:00Z", term: { category: "closing" }, closer: { ghl_user_id: "U-L" } } } });
    h.clock.set("2026-10-26T22:00:00Z");
    await h.engine.firePeriod({ workflowId: h.wfs.w!.id, node: "t", at: h.clock.now() });
    await h.due();
    const texts = h.fp.effects("slack").map((c) => (c.args as { text: string }).text);
    // Luis: Oct 23's blank Sales Call (the CRM's), Oct 24's call, today's (a1 is answered, a6 is not); Oct 25 was filed. Ana: a2 (no-show) is answered.
    expect(texts).toContain("3: Fri, Oct 23 0+1 https://app.example.com/eod/u1?day=2026-10-23; Sat, Oct 24 1+0 https://app.example.com/eod/u1?day=2026-10-24; Today 1+0 https://app.example.com/eod/u1 / overdue Fri, Oct 23 Kim Lee");
    expect(texts).toContain("1: Fri, Oct 23 0+1 https://app.example.com/eod/u2?day=2026-10-23 / overdue Fri, Oct 23 Kim Lee");
  });

  it("refuses a metric that names a column its table does not have: the vocabulary is the table's own columns", async () => {
    const h = await harness(kind, { start: "2026-10-26T12:00:00Z", zone: NY, settings: SETTINGS, reports: { metrics: { bad: { label: "Bad", unit: "count", what: "x", v1: "none", from: "payments", time: "paid_at", agg: "count" } } }, workflows: [], content: {} });
    const day = periodFor("daily", "in_progress", h.clock.now(), NY);
    await expect(h.store.tx(async (tx) => metric({ tx, offerId: h.offerId, settings: {}, now: h.clock.now(), defs: await tx.reportDefinitions(h.offerId, "metric"), people: [] }, "bad", day))).rejects.toThrow("payments has no column paid_at");
  });
});
