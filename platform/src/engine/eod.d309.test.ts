/**
 * D309: one offer's end of day, set from the admin route and its settings. "Next follow-up" made optional on that offer only (dry run
 * first, audited); with eod.totals_from_calls on, the day's numbers are the calls' answers added up, whatever was typed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { loadEodForm, submitEod, tokenFor, todayFor } from "./eod";
import { GET as getForm, POST as setField } from "../../app/api/admin/eod/form/route";
import { POST as fileDay, GET as readDay } from "../../app/api/eod/[token]/route";

const KEY = "d309-operator-key", prev = process.env.CRON_SECRET;
const TZ = "America/New_York";
let co = "", other = "", slug = "", closer = "", appt = "";

const admin = (body: unknown) => setField(new Request("http://x/api/admin/eod/form", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) }));

describe.skipIf(!process.env.DATABASE_URL)("D309: one offer's end-of-day form", () => {
  beforeAll(async () => {
    await migrate();
    process.env.CRON_SECRET = KEY;
    slug = `d309-${Date.now()}`;
    await asOperator(async (c) => {
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D309',$1,$2) returning id", [slug, TZ]))!.id;
      other = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D309 other',$1,$2) returning id", [`${slug}-b`, TZ]))!.id;
      for (const id of [co, other]) await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [id]);
      closer = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role) values ($1,'mia@d309.test','Mia Closer','closer') returning id", [co]))!.id;
      const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, first_name, last_name) values ($1,'Ana','Prospect') returning id", [co]))!.id;
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [co]))!.id;
      const at = DateTime.now().setZone(TZ).startOf("day").plus({ minutes: 1 }).toJSDate();
      appt = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, external_id, starts_at, ends_at, booked_at, status, appointment_term, assigned_user_id) values ($1,$2,'D309-A',$3,$3,now(),'confirmed',$4,$5) returning id", [co, ct, at, term, closer]))!.id;
    });
  }, 180000);
  afterAll(() => { if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev; });

  it("next follow-up made optional on one offer: dry run first, then saved and audited; the other offer still asks for it", async () => {
    const dry = await (await admin({ company: slug, key: "next_date", required: false, why: "test" })).json();
    expect(dry).toMatchObject({ ok: true, dryRun: true, change: { key: "next_date", was: true, now: false } });
    expect((await asOperator((c) => loadEodForm(c, co))).find((f) => f.key === "next_date")!.required).toBe(true);
    expect(await (await admin({ company: slug, key: "next_date", required: false, why: "test", dryRun: false })).json()).toMatchObject({ ok: true, dryRun: false });
    expect((await asOperator((c) => loadEodForm(c, co))).find((f) => f.key === "next_date")!.required).toBe(false);
    expect((await asOperator((c) => loadEodForm(c, other))).find((f) => f.key === "next_date")!.required).toBe(true);
    expect(await asOperator((c) => one(c, "select 1 from audit_log where company_id=$1 and action='eod.form_field'", [co]))).toBeTruthy();
    expect((await admin({ company: slug, key: "outcome", required: false, why: "test" })).status).toBe(400);
    const listed = await (await getForm(new Request(`http://x/api/admin/eod/form?company=${slug}`, { headers: { authorization: `Bearer ${KEY}` } }))).json();
    expect(listed.fields.find((f: { key: string }) => f.key === "next_date")).toMatchObject({ required: false });
    // a follow-up filed with no date now goes through on this offer
    const token = await asOperator((c) => tokenFor(c, closer));
    const call = { appointment_id: appt, contact_id: "", contact: "Ana Prospect", starts_at: "", href_contact: null, recording_url: null, outcome: "follow_up", revenue: null, cash: null, next_date: null, next_steps: "call Friday", dq_reason: "", dq_note: "", lost_reason: "", pitched: "Yes", about: "", notes: "", extra: {} };
    expect(await asOperator((c) => submitEod(c, { token, day: todayFor(TZ), answers: { calls_count: 1, closes: 0, deposits: 0, cash: 0, revenue: 0, calls: [call as never], day_answers: {} } }))).toMatchObject({ ok: true });
  });

  it("eod.totals_from_calls on: the form says so, and a typed number is replaced by the calls' answers added up", async () => {
    await asOperator((c) => c.query("insert into bindings (company_id,key,kind,value) values ($1,'eod.totals_from_calls','text',convert_to('on','UTF8'))", [co]));
    const token = await asOperator((c) => tokenFor(c, closer));
    const page = await (await readDay(new Request(`http://x/api/eod/${token}`), { params: Promise.resolve({ token }) })).json();
    expect(page.totals_from_calls).toBe(true);
    const call = { appointment_id: appt, contact: "Ana Prospect", outcome: "closed", revenue: 9997, cash: 3000, next_date: null, next_steps: "", pitched: "Yes", notes: "", extra: {} };
    const res = await fileDay(new Request(`http://x/api/eod/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ day: todayFor(TZ), calls_count: 99, closes: 7, cash: 1, revenue: 1, calls: [call], day_answers: {} }) }), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    const filed = await asOperator((c) => one<{ answers: { calls_count: number; closes: number; cash: number; revenue: number } }>(c, "select answers from eod_reports where company_id=$1 and user_id=$2 order by submitted_at desc limit 1", [co, closer]));
    expect(filed!.answers).toMatchObject({ calls_count: 1, closes: 1, cash: 3000, revenue: 9997 });
  });
});
