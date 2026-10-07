/** D29 history: the window's contacts, dialer calls, bookings, old Sales Call outcomes and won deals land as rows only — no events, no runs — and the days roll up. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { loadCompany } from "@/engine/context";
import { backfillCompany } from "@/engine/backfill";
import { readMetrics } from "@/engine/metrics";
import type { Adapters, AppointmentSnapshot, BookingRead } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string;
const d = (daysAgo: number, h: number) => DateTime.now().setZone("UTC").minus({ days: daysAgo }).set({ hour: h, minute: 0, second: 0, millisecond: 0 });
const appts: AppointmentSnapshot[] = [{ id: "evt-1", calendarId: "CAL", contactId: "G1", assignedUserId: "GC", startTime: d(5, 15).toISO()!, endTime: d(5, 16).toISO()!, status: "confirmed", dateAdded: d(6, 10).toISO()!, raw: {} }];
const fake: Adapters = {
  read: {
    contactsChangedSince: async () => [], inboundSince: async () => [], callMedia: async (_c, id) => (id === "call-1" ? { recordingUrl: "https://ghl.test/call-1", transcript: [{ speaker: "0", text: "hi" }] } : { transcript: null }),
    contactsAddedBetween: async () => [{ id: "G1", firstName: "Hist", email: "hist@x.com", tags: [], customFields: { F1: "x", F2: "y" }, dateUpdated: d(6, 9).toISO()!, dateAdded: d(6, 9).toISO()! }, { id: "G2", firstName: "Old", tags: [], customFields: {}, dateUpdated: d(3, 9).toISO()!, dateAdded: d(3, 9).toISO()! }],
    callsBetween: async () => [
      { id: "call-1", conversationId: "cv1", contactId: "G1", channel: "call", direction: "outbound", status: "completed", dateAdded: d(6, 9).plus({ minutes: 7 }).toISO()!, call: { status: "completed", durationSec: 140, userId: "GS" } },
      { id: "call-2", conversationId: "cv2", contactId: "G2", channel: "call", direction: "outbound", status: "no-answer", dateAdded: d(3, 9).plus({ minutes: 30 }).toISO()!, call: { status: "no-answer", userId: "GS" } }],
    wonOpportunities: async () => [{ id: "opp-1", contactId: "G1", pipelineId: "P", stageId: "S", wonAt: d(4, 12).toISO()!, createdAt: d(6, 10).toISO()!, monetaryValue: 0, customFields: { CV: "2500" } }],
    objectRecords: async (_c, key) => (key === "custom_objects.sales_call" ? [{ id: "sc1", createdAt: d(6, 10).toISO()!, properties: { external_id: "evt-1", contact_id: "G1", call_date: d(5, 15).toISODate(), outcome: "showed" } }, { id: "sc2", createdAt: d(6, 10).toISO()!, properties: { external_id: "evt-none", outcome: "no_show" } }] : []),
    opportunitiesSince: async () => [], getContact: async () => null, listUsers: async () => [{ id: "GS", name: "Lu Setter", email: "lu@x.com" }, { id: "GC", name: "Sam Closer", email: "sam@x.com" }],
  },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => appts, getAppointment: async () => null, listCalendars: async () => [{ id: "CAL", name: "Closing", teamMemberIds: ["GC"] }] }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {} },
  sender: { sendSms: async () => ({ externalId: "", accepted: true }), sendEmail: async () => ({ externalId: "", accepted: true }), deliveryStatus: async () => ({ status: "sent" }) },
  classifier: { choice: async () => ({ value: "unclear", confidence: 0, distribution: {}, unclear: true }) },
  notifier: { post: async () => ({ ts: "1" }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};

describe.skipIf(!HAS_DB)("history backfill", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='bf'");
      if (co) { for (const t of ["poll_cursors", "wrapup_schedules", "rollups_daily", "payments", "events", "recordings", "appointments", "opportunities", "calendars", "company_terms", "contact_identifiers", "contacts", "users", "bindings", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('BF','bf','UTC') returning id"))!.id;
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'crm.field_contact_f1','id',$4),($1,'crm.field_opportunity_contract_value','id',$5)", [companyId, Buffer.from("L"), encrypt("p"), Buffer.from("F1"), Buffer.from("CV")]);
      const term = (await one<{ id: string }>(c, "insert into company_terms (company_id, domain, name, category) values ($1,'appointment_type','Closing','closing') returning id", [companyId]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default) values ($1,'appointment_outcome','Showed','showed',true),($1,'appointment_outcome','No-show','noshow',true)", [companyId]);
      await c.query("insert into calendars (company_id, source, external_id, name, appointment_term, active) values ($1,'ghl','CAL','Closing',$2,true)", [companyId, term]);
    });
  });
  it("writes rows only, keyed on source ids, and rolls the days up", async () => {
    const payments = async () => [{ providerPaymentId: "pay_1", amount: 750, status: "succeeded" as const, paidAt: d(4, 11).toJSDate(), email: "hist@x.com", raw: { backfill: true } }, { providerPaymentId: "pay_2", amount: 100, status: "succeeded" as const, paidAt: d(2, 11).toJSDate(), email: "nobody@x.com", raw: { backfill: true } }];
    const r = await asOperator(async (c) => { const { row, adapterCompany, bindings } = await loadCompany(c, companyId); return backfillCompany(c, row, adapterCompany, fake, bindings, { from: d(30, 0).toJSDate(), to: new Date() }, payments); });
    expect(r).toMatchObject({ contacts: 2, calls: 2, callsWithTranscript: 1, appointments: 1, outcomes: 1, outcomesUnmatched: 1, won: 1, payments: 2, paymentsUnlinked: 1, errors: [] });
    const g1 = await asOperator((c) => one<{ ghl_added_at: Date; ghl_fields: Record<string, unknown> }>(c, "select ghl_added_at, ghl_fields from contacts where company_id=$1 and ghl_contact_id='G1'", [companyId]));
    expect(g1!.ghl_added_at.toISOString()).toBe(d(6, 9).toISO()); expect(g1!.ghl_fields).toEqual({ F1: "x" });   // only the bound field is kept
    // the payments ledger records its own facts (payment.received / payment.unlinked); nothing else is emitted and no workflow starts
    expect((await asOperator((c) => many<{ event_type: string }>(c, "select distinct event_type from events where company_id=$1 order by 1", [companyId]))).map((e) => e.event_type)).toEqual(["payment.received", "payment.unlinked"]);
    expect(await asOperator((c) => many(c, "select 1 from runs where company_id=$1", [companyId]))).toHaveLength(0);
    const appt = await asOperator((c) => one<{ status: string; cat: string }>(c, "select a.status, t.category as cat from appointments a join company_terms t on t.id=a.outcome_term where a.company_id=$1 and a.external_id='evt-1'", [companyId]));
    expect(appt).toEqual({ status: "showed", cat: "showed" });
    expect(await asOperator((c) => one<{ contract_value: string }>(c, "select contract_value from opportunities where company_id=$1 and ghl_opportunity_id='opp-1'", [companyId]))).toEqual({ contract_value: "2500.00" });
    const day6 = await asOperator((c) => readMetrics(c, companyId, d(6, 0).toISODate()!, d(6, 0).toISODate()!));
    expect(day6.totals).toMatchObject({ leads_new: 1, leads_called: 1, leads_reached: 1, stl_sum: 420, dials: 1, connects: 1, booked: 1 });
    const day5 = await asOperator((c) => readMetrics(c, companyId, d(5, 0).toISODate()!, d(5, 0).toISODate()!));
    expect(day5.totals).toMatchObject({ scheduled: 1, showed: 1 });
    const day4 = await asOperator((c) => readMetrics(c, companyId, d(4, 0).toISODate()!, d(4, 0).toISODate()!));
    expect(day4.totals).toMatchObject({ deals_won: 1, revenue: 2500, payments: 1, cash: 750 });
    // the same window again changes nothing
    const again = await asOperator(async (c) => { const { row, adapterCompany, bindings } = await loadCompany(c, companyId); return backfillCompany(c, row, adapterCompany, fake, bindings, { from: d(30, 0).toJSDate(), to: new Date() }, payments); });
    expect(again).toMatchObject({ contacts: 2, calls: 0, appointments: 0, outcomes: 0, won: 1, payments: 0 });
  });
});
