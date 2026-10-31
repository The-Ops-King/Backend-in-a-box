/** D278: what a booking post says it is: the calendar it was booked on (a closer's own, or a pool) and whether the person had a call before. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { buildContext, loadCompany, type RunRow } from "./context";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId = "", jose = "", closing = "", triage = "", pool = "", own = "";
const day = 86_400_000;

describe.skipIf(!process.env.DATABASE_URL)("D278: appointment.calendar.personal and appointment.follows_call", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D278',$1,'America/New_York') returning id", [`d278-${Date.now()}`]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      closing = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      triage = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='first_call'", [companyId]))!.id;
      jose = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,'jp@x.com','Jose P','closer','U-JP') returning id", [companyId]))!.id;
      pool = (await one<{ id: string }>(c, "insert into calendars (company_id, source, external_id, name, appointment_term) values ($1,'calendly','RR','Consultation RR',$2) returning id", [companyId, closing]))!.id;
      own = (await one<{ id: string }>(c, "insert into calendars (company_id, source, external_id, name, appointment_term, default_user_id) values ($1,'calendly','JP45','Jose 45',$2,$3) returning id", [companyId, closing, jose]))!.id;
    });
  });

  const person = (first: string) => asOperator(async (c) => (await one<{ id: string }>(c, "insert into contacts (company_id, first_name) values ($1,$2) returning id", [companyId, first]))!.id);
  const book = (contact: string, at: Date, opts: { cal?: string; term?: string; status?: string; updated?: Date; booked?: Date } = {}) => asOperator(async (c) =>
    (await one<{ id: string }>(c, `insert into appointments (company_id, contact_id, source, external_id, calendar_id, appointment_term, starts_at, ends_at, booked_at, status, assigned_user_id, source_updated_at)
      values ($1,$2,'calendly',$3,$4,$5,$6,$6::timestamptz + interval '45 minutes',$7,$8,$9,$10) returning id`,
      [companyId, contact, `E-${Math.random()}`, opts.cal ?? pool, opts.term ?? closing, at, opts.booked ?? new Date(at.getTime() - day), opts.status ?? "confirmed", jose, opts.updated ?? new Date()]))!.id);
  const apptOf = (contact: string, appointment: string) => asOperator(async (c) => {
    const lc = await loadCompany(c, companyId);
    const run = { id: "00000000-0000-0000-0000-000000000000", company_id: companyId, contact_id: contact, appointment_id: appointment, opportunity_id: null, context: { vars: {}, event: {} }, started_at: new Date() } as unknown as RunRow;
    return (await buildContext(c, run, lc.row, lc.bindings)).appointment as { calendar: { name: string; personal: boolean } | null; follows_call: boolean };
  });

  it("a closer's own calendar is personal, a pool is not; a first booking follows no call", async () => {
    const ana = await person("Ana");
    const first = await book(ana, new Date(Date.now() + day), { booked: new Date() });
    expect(await apptOf(ana, first)).toMatchObject({ calendar: { name: "Consultation RR", personal: false }, follows_call: false });
    const bo = await person("Bo");
    const self = await book(bo, new Date(Date.now() + day), { cal: own, booked: new Date() });
    expect(await apptOf(bo, self)).toMatchObject({ calendar: { name: "Jose 45", personal: true }, follows_call: false });
  });

  it("a closing call that happened before the booking makes it a follow-up; a no-show, a triage call or one cancelled before its start does not", async () => {
    const cy = await person("Cy");
    await book(cy, new Date(Date.now() - 3 * day), { status: "noshow" });
    await book(cy, new Date(Date.now() - 2 * day), { term: triage });
    await book(cy, new Date(Date.now() - 2 * day), { status: "cancelled", updated: new Date(Date.now() - 3 * day) });
    const next = await book(cy, new Date(Date.now() + day), { cal: own, booked: new Date() });
    expect(await apptOf(cy, next)).toMatchObject({ follows_call: false });
    await book(cy, new Date(Date.now() - day), { status: "cancelled", updated: new Date(Date.now() - day + 40 * 60e3) });   // cleared after its start: it happened (D276)
    expect(await apptOf(cy, next)).toMatchObject({ follows_call: true });
  });
});
