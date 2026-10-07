/** D29: daily rollups from the ledger, the wrap-up text, and the schedule that fires once per period. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { loadCompany } from "@/engine/context";
import { recordPhoneCall, settlePhoneCall } from "@/engine/recordings";
import { rollupDay, readMetrics } from "@/engine/metrics";
import { ensureSchedules, generateReport, isDue, periodFor, renderReport, runDueReports, type Schedule } from "@/engine/reports";

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
  it("fires after the time on the right day, once per period, never when disabled", () => {
    const base: Schedule = { id: "s", company_id: "c", kind: "daily", enabled: true, at_time: "19:00", weekday: 1, day_of_month: 1, channel: null, breakdowns: [], sections: {}, last_period_start: null };
    expect(isDue(base, tue)).toEqual({ start: "2026-10-06", end: "2026-10-06" });
    expect(isDue(base, tue.set({ hour: 18, minute: 59 }))).toBeNull();
    expect(isDue({ ...base, last_period_start: "2026-10-06" }, tue)).toBeNull();
    expect(isDue({ ...base, enabled: false }, tue)).toBeNull();
    expect(isDue({ ...base, kind: "weekly", weekday: 2, at_time: "08:00" }, tue)).toEqual({ start: "2026-09-28", end: "2026-10-04" });
    expect(isDue({ ...base, kind: "weekly", weekday: 1, at_time: "08:00" }, tue)).toBeNull();
    expect(isDue({ ...base, kind: "monthly", day_of_month: 6, at_time: "08:00" }, tue)).toEqual({ start: "2026-09-01", end: "2026-09-30" });
  });
  it("renders rates with their denominators and '—' for zero-of-zero", () => {
    const text = renderReport({ kind: "daily", period: { start: "2026-10-06", end: "2026-10-06" }, tz: "UTC", toDate: false, breakdowns: ["setter"], said: [],
      totals: { leads_new: 4, leads_booked_same_day: 1, leads_called: 2, leads_reached: 1, dials: 10, connects: 4, talk_sec: 600, calls_set: 2, booked: 3, booked_set: 2, booked_self: 1, scheduled: 0, showed: 0, noshow: 0, cancelled: 0, payments: 1, cash: 1000, deals_won: 1, revenue: 3000, stl_n: 2, stl_sum: 1200 },
      setters: [{ id: "u1", name: "Lu Setter", values: { dials: 10, connects: 4, talk_sec: 600, calls_set: 2 } }], closers: [] });
    expect(text).toContain("40% connection rate"); expect(text).toContain("50% of connects"); expect(text).toContain("25% of them");
    expect(text).toMatch(/showed\s+0\s+— show rate/); expect(text).toContain("Lu Setter"); expect(text).toContain("avg 10 min from arrival to first dial"); expect(text).toMatch(/reached\s+1\s+50% of those called/); expect(text).toContain("outstanding");
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
      if (co) { for (const t of ["wrapups", "wrapup_schedules", "rollups_daily", "poll_cursors", "sends", "events", "recordings", "payments", "appointments", "opportunities", "company_terms", "contact_identifiers", "contacts", "users", "bindings", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
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
  it("generates the daily wrap-up (shadow: recorded, not posted), and the schedule fires once", async () => {
    const r = await asOperator(async (c) => { const { row, bindings } = await loadCompany(c, companyId); const s = (await ensureSchedules(c, companyId)).find((x) => x.kind === "daily")!; return generateReport(c, row, bindings, { ...s, breakdowns: ["setter", "closer"] }, { start: day, end: day }, { onDemand: true }); });
    expect(r.posted).toBe(false); expect(r.why).toBe("shadow");
    expect(r.body).toContain("67% connection rate"); expect(r.body).toContain("Lu Setter"); expect(r.body).toContain("Sam Closer"); expect(r.body).toContain("$1,000"); expect(r.body).toContain("$3,000");
    expect(await asOperator((c) => one(c, "select 1 from sends where company_id=$1 and channel='slack' and status='shadow' and rendered_body like '%What happened today%'", [companyId]))).toBeTruthy();
    const at1905 = DateTime.fromISO(`${day}T19:05:00`, { zone: "UTC" });
    const first = await asOperator((c) => runDueReports(c, at1905, companyId));
    expect(first.generated.filter((g) => g.company === "rp").map((g) => g.kind)).toEqual(["daily"]);
    const again = await asOperator((c) => runDueReports(c, at1905.plus({ minutes: 1 }), companyId));
    expect(again.generated.filter((g) => g.company === "rp")).toEqual([]);
    expect(await asOperator((c) => many(c, "select 1 from wrapups where company_id=$1", [companyId]))).toHaveLength(2);
    // before 7pm nothing fires
    expect((await asOperator((c) => runDueReports(c, DateTime.fromISO(`${day}T18:00:00`, { zone: "UTC" }).plus({ days: 1 }), companyId))).generated.filter((g) => g.company === "rp")).toEqual([]);
  });
});
