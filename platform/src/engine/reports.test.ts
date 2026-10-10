/** D29: daily rollups from the ledger, the wrap-up text, and the schedule that fires once per period. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { loadCompany } from "@/engine/context";
import { recordPhoneCall, settlePhoneCall } from "@/engine/recordings";
import { rollupDay, readMetrics } from "@/engine/metrics";
import { buildReport, periodFor, renderReport } from "@/engine/reports";
import { dispatchSchedules, periodOf, scheduleWords } from "@/engine/clock";
import { tick } from "@/engine/runner";
import { installTemplateForTest, replicaSnapshot } from "@/engine/test-install";
import type { Adapters, BookingRead } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");

describe("report periods and due-ness (pure)", () => {
  const tue = DateTime.fromISO("2026-10-06T19:05:00", { zone: "America/New_York" });   // a Tuesday
  it("daily = today; weekly = last Mon–Sun, or this week so far; monthly = last month, or this month so far", () => {
    expect(periodFor("daily", tue)).toEqual({ start: "2026-10-06", end: "2026-10-06" });
    expect(periodFor("weekly", tue)).toEqual({ start: "2026-09-28", end: "2026-10-04" });
    expect(periodFor("weekly", tue, true)).toEqual({ start: "2026-10-05", end: "2026-10-06" });
    expect(periodFor("monthly", tue)).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(periodFor("monthly", tue, true)).toEqual({ start: "2026-10-01", end: "2026-10-06" });
  });
  it("a schedule trigger is due after its time on its day, once per date; every-N buckets the clock", () => {
    expect(periodOf({ at: "19:00", for: "company" }, tue)).toBe("2026-10-06");
    expect(periodOf({ at: "19:00", for: "company" }, tue.set({ hour: 18, minute: 59 }))).toBeNull();
    expect(periodOf({ at: "08:00", days: [2], for: "company" }, tue)).toBe("2026-10-06");
    expect(periodOf({ at: "08:00", days: [1], for: "company" }, tue)).toBeNull();
    expect(periodOf({ at: "08:00", day_of_month: 6, for: "company" }, tue)).toBe("2026-10-06");
    expect(periodOf({ at: "08:00", day_of_month: 1, for: "company" }, tue)).toBeNull();
    expect(periodOf({ every: "60m", for: "company" }, tue)).toBe(periodOf({ every: "60m", for: "company" }, tue.plus({ minutes: 20 })));
    expect(periodOf({ every: "60m", for: "company" }, tue)).not.toBe(periodOf({ every: "60m", for: "company" }, tue.plus({ hours: 1 })));
    expect(scheduleWords({ at: "19:00", for: "company" })).toBe("at 7:00 PM every day");
    expect(scheduleWords({ at: "08:00", days: [1], for: "company" })).toBe("at 8:00 AM on Mon");
    expect(scheduleWords({ every: "60m", for: "closer" })).toBe("every hour, one run per closer");
  });
  it("renders rates with their denominators and '—' for zero-of-zero", () => {
    const text = renderReport({ kind: "daily", period: { start: "2026-10-06", end: "2026-10-06" }, tz: "UTC", toDate: false, breakdowns: ["setter"], said: [],
      totals: { leads_new: 4, leads_booked_same_day: 1, leads_called: 2, leads_reached: 1, dials: 10, connects: 4, talk_sec: 600, calls_set: 2, booked: 3, booked_set: 2, booked_self: 1, scheduled: 0, showed: 0, noshow: 0, cancelled: 0, payments: 1, cash: 1000, deals_won: 1, revenue: 3000, stl_n: 2, stl_sum: 1200 },
      setters: [{ id: "u1", name: "Lu Setter", values: { dials: 10, connects: 4, talk_sec: 600, calls_set: 2 } }], closers: [] });
    expect(text).toContain("40% connection rate"); expect(text).toContain("50% of connects"); expect(text).toContain("25% of them");
    expect(text).toMatch(/showed: 0  ·  — show rate/); expect(text).toContain("Lu Setter"); expect(text).toContain("avg 10 min from arrival to first dial"); expect(text).toMatch(/reached: 1  ·  50% of those called/); expect(text).toContain("outstanding");
    expect(renderReport({ kind: "weekly", period: { start: "2026-09-28", end: "2026-10-04" }, tz: "UTC", toDate: false, breakdowns: [], said: [], totals: {}, setters: [], closers: [] })).toContain("Nothing yet");
  });
});

describe.skipIf(!HAS_DB)("rollups from the ledger", () => {
  let companyId: string, setter: string, closer: string, c1: string, c2: string, c3: string, term: string;
  const day = DateTime.now().setZone("UTC").toISODate()!;
  const at = (h: number, m = 0) => DateTime.fromISO(day, { zone: "UTC" }).set({ hour: h, minute: m }).toJSDate();
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='rp'");
      if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]); for (const t of ["wrapups", "rollups_daily", "poll_cursors", "sends", "runs", "workflow_triggers", "workflows", "events", "recordings", "payments", "appointments", "opportunities", "company_terms", "contact_identifiers", "contacts", "users", "bindings", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('RP','rp','UTC') returning id"))!.id;
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3)", [companyId, Buffer.from("L"), encrypt("p")]);
      setter = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,'lu@x.com','Lu Setter','setter','GS') returning id", [companyId]))!.id;
      closer = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,'sam@x.com','Sam Closer','closer','GC') returning id", [companyId]))!.id;
      term = (await one<{ id: string }>(c, "insert into company_terms (company_id, domain, name, category) values ($1,'appointment_type','Closing','closing') returning id", [companyId]))!.id;
      const mk = async (n: string, added: Date | null) => (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, ghl_added_at) values ($1,$2,$2,$3) returning id", [companyId, n, added]))!.id;
      // two leads arrived at 9:00 today; C has no CRM arrival time (a replica the booking poll created) and is not a lead
      c1 = await mk("A", at(9)); c2 = await mk("B", at(9)); c3 = await mk("C", null);
      // calls: A dialed at 9:10 (connected 3 min, booking followed), B no-answer, B connected 90s; a simulated call never counts
      const call = async (cid: string, ext: string, status: string, dur: number, h: number, m: number, extra: Record<string, unknown> = {}) => {
        const { recording } = await recordPhoneCall(c, companyId, { externalId: ext, contactId: cid, startedAt: at(h, m), durationSec: dur, direction: "outbound", status, callerGhlUserId: "GS", raw: extra });
        await settlePhoneCall(c, recording, status === "completed" ? { transcript: [{ speaker: "0", text: "hi" }] } : null, { silent: true });
        if (status === "completed") await c.query("update recordings set analysis=$2 where id=$1", [recording.id, { classify: { call_type: "setting" } }]);
      };
      await call(c1, "k1", "completed", 180, 9, 10); await call(c2, "k2", "no-answer", 0, 9, 20); await call(c2, "k3", "completed", 90, 9, 30); await call(c3, "k4", "completed", 500, 9, 40, { simulated: true });
      // bookings made today: A set by Lu with Sam (after the call), C self-booked (harness source: excluded); a call on today's calendar that showed
      await c.query("insert into appointments (company_id, contact_id, source, external_id, appointment_term, assigned_user_id, starts_at, ends_at, self_booked, set_by, booked_at, status) values ($1,$2,'calendly','a1',$3,$4,$5,$6,false,'Lu Setter',$7,'confirmed')", [companyId, c1, term, closer, at(15), at(16), at(9, 15)]);
      await c.query("insert into appointments (company_id, contact_id, source, external_id, appointment_term, assigned_user_id, starts_at, ends_at, self_booked, booked_at, status) values ($1,$2,'test','a2',$3,$4,$5,$6,true,$7,'confirmed')", [companyId, c3, term, closer, at(17), at(18), at(10)]);
      await c.query("insert into appointments (company_id, contact_id, source, external_id, appointment_term, assigned_user_id, starts_at, ends_at, self_booked, booked_at, status) values ($1,$2,'calendly','a3',$3,$4,$5,$6,true,$7,'showed')", [companyId, c2, term, closer, at(11), at(12), DateTime.fromISO(day, { zone: "UTC" }).minus({ days: 2 }).toJSDate()]);
      // money: one payment, one refund, one deal won
      await c.query("insert into payments (company_id, contact_id, provider, whop_payment_id, amount, currency, status, paid_at) values ($1,$2,'whop','p1',1000,'USD','succeeded',$3),($1,$2,'whop','r1',-200,'USD','refunded',$3)", [companyId, c2, at(12)]);
      await c.query("insert into opportunities (company_id, contact_id, status, opened_at, opened_by, won_at, contract_value) values ($1,$2,'won',$3,'test',$3,3000)", [companyId, c2, at(12, 30)]);
    });
  });
  it("counts leads, dials, connects, talk time, sets, bookings, outcomes and money — harness rows excluded; a call booked today for today is both a booking and on the calendar", async () => {
    await asOperator((c) => rollupDay(c, companyId, day, "UTC"));
    const { totals, setters, closers } = await asOperator((c) => readMetrics(c, companyId, day, day));
    expect(totals).toMatchObject({ leads_new: 2, leads_booked_same_day: 1, leads_called: 2, leads_reached: 2, dials: 3, connects: 2, talk_sec: 270, calls_set: 1, calls_setting: 2, booked: 1, booked_set: 1, booked_self: 0, scheduled: 2, showed: 1, noshow: 0, cancelled: 0, payments: 1, cash: 1000, refunds: 1, refunded: 200, deals_won: 1, revenue: 3000 });
    expect(totals.stl_sum).toBe(600 + 1200);   // A: 9:00 → 9:10 dial; B: 9:00 → the 9:20 no-answer dial (a dial is a dial); both later connected ≥ 60s → reached
    expect(setters).toEqual([{ id: setter, name: "Lu Setter", values: expect.objectContaining({ dials: 3, connects: 2, talk_sec: 270, calls_set: 1, booked_set: 1 }) }]);
    expect(closers).toEqual([{ id: closer, name: "Sam Closer", values: expect.objectContaining({ booked: 1, booked_set: 1, scheduled: 2, showed: 1, deals_won: 1, revenue: 3000 }) }]);
    // recomputing is idempotent
    await asOperator((c) => rollupDay(c, companyId, day, "UTC"));
    expect((await asOperator((c) => readMetrics(c, companyId, day, day))).totals.dials).toBe(3);
  });
  it("builds the daily wrap-up; the wrap-ups workflow fires it at 7pm once per day and the post is recorded (suppressed: no Slack here)", async () => {
    const r = await asOperator(async (c) => buildReport(c, (await loadCompany(c, companyId)).row, "daily", { start: day, end: day }, { breakdowns: ["setter", "closer"] }));
    expect(r.body).toContain("67% connection rate"); expect(r.body).toContain("Lu Setter"); expect(r.body).toContain("Sam Closer"); expect(r.body).toContain("$1,000"); expect(r.body).toContain("$3,000");
    const fake: Adapters = {
      read: { contactsChangedSince: async () => [], openCards: async () => [], inboundSince: async () => [], callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], pipelineCards: async () => [], getContact: async (c, id) => replicaSnapshot(c.id, id), listUsers: async () => [] },
      booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] }; return { ghl: b, calendly: b }; })(),
      write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "d" }) },
      sender: { sendSms: async () => ({ externalId: "s", accepted: true }), sendEmail: async () => ({ externalId: "e", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
      classifier: { choice: async () => ({ value: "confirmed", confidence: 1, distribution: {}, unclear: false }) },
      notifier: { post: async () => ({ ts: "1" }), lookupUserByEmail: async () => null, react: async () => true, unreact: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
      analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
    };
    await asOperator((c) => installTemplateForTest(c, companyId, "wrap-ups"));
    const at1905 = DateTime.fromISO(`${day}T19:05:00`, { zone: "UTC" }) as DateTime<true>;
    // before 7pm nothing fires
    expect((await asOperator((c) => dispatchSchedules(c, at1905.set({ hour: 18 }) as DateTime<true>, companyId))).started).toEqual([]);
    const first = await asOperator((c) => dispatchSchedules(c, at1905, companyId));
    expect(first.started).toEqual([{ company: "rp", workflow: "Wrap-ups", node: "t_daily", period: day }]);
    const again = await asOperator((c) => dispatchSchedules(c, at1905.plus({ minutes: 1 }) as DateTime<true>, companyId));
    expect(again.started).toEqual([]);
    const t = await tick(fake, at1905, companyId);
    expect(t).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(await asOperator((c) => many(c, "select 1 from wrapups where company_id=$1 and kind='daily'", [companyId]))).toHaveLength(2);
    const step = await asOperator((c) => one<{ result: { kind: string; period: { start: string } } }>(c, "select s.result from run_steps s join runs r on r.id=s.run_id where r.company_id=$1 and s.node_type='report'", [companyId]));
    expect(step?.result).toMatchObject({ kind: "daily", period: { start: day } });
    // no Slack connection in this company: the post is recorded and suppressed, with the text it would have carried (D31)
    expect(await asOperator((c) => one(c, "select 1 from sends where company_id=$1 and channel='slack' and status='suppressed' and rendered_body like '%What happened today%'", [companyId]))).toBeTruthy();
  });

});
