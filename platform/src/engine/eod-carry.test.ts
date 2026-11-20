/**
 * D358 (Tyler, 2026-11-20: "EOD marks a call complete. All fields that need to be filled with a given outcome need to be filled"):
 * from `eod.carry_over_from`, a closer's closing call stays on today's end of day, in its own section, until it has an outcome and
 * every field the form requires for it. A pre-filled guess is never a filing; an outcome the call got some other way still needs its
 * fields. Carried calls are never today's numbers, and one still unfinished never holds back today's filing.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { carriedCalls, formFor, loadEodForm, submitEod, tokenFor } from "./eod";
import { valueFor } from "./eod-form";
import { recordDisposition } from "./disposition";
import { loadCompany } from "./context";
import { installTemplateForTest, fakeAdapters } from "./test-install";
import { tick } from "./runner";
import { GET as preview } from "../../app/api/admin/eod/preview/route";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Los_Angeles";
const written: { id: string; properties: Record<string, unknown> }[] = [];
const f0 = fakeAdapters();
const fake: Adapters = { ...f0, write: { ...f0.write, updateRecord: async (_c, _o, id, properties) => { written.push({ id, properties: { ...properties } }); } } };
let co: string, closer: { id: string; name: string; email: string }, term: string, cal: string;
const appt: Record<string, string> = {};
const now = DateTime.now().setZone(TZ);
const day = (n: number) => now.minus({ days: n }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });

async function person(c: Parameters<Parameters<typeof asOperator>[0]>[0], first: string) {
  return (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,$2,$3,'Lee') returning id", [co, `G-${first}`, first]))!.id;
}
const termOf = (domain: string, cat: string) => asOperator(async (c) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain=$2 and category=$3 order by is_default desc limit 1", [co, domain, cat]))!.id);
const carried = () => asOperator(async (c) => carriedCalls(c, (await loadCompany(c, co)).row, closer, now.toFormat("yyyy-MM-dd"), now));
const setFrom = (v: string | null) => asOperator((c) => v === null ? c.query("delete from bindings where company_id=$1 and key='eod.carry_over_from'", [co])
  : c.query("insert into bindings (company_id,key,kind,value) values ($1,'eod.carry_over_from','text',$2) on conflict (company_id,key) do update set value=excluded.value", [co, Buffer.from(v)]));

describe.skipIf(!process.env.DATABASE_URL)("D358: earlier days' unfinished calls stay on the end of day", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const old = await one<{ id: string }>(c, "select id from companies where slug='eod-carry'");
      if (old) {
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [old.id]);
        await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [old.id]);
        for (const t of ["eod_reports", "crm_records", "step_effects", "runs", "events", "workflow_triggers", "workflows", "form_submissions", "forms", "appointments", "calendars", "contact_identifiers", "contacts", "users", "company_terms", "bindings", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [old.id]);
        await c.query("delete from companies where id=$1", [old.id]);
      }
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode) values ('Carry Co','eod-carry',$1,'live') returning id", [TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [co]);
      const u = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role) values ($1,'nina@carry.test','Nina Closer','closer') returning id", [co]))!.id;
      closer = { id: u, name: "Nina Closer", email: "nina@carry.test" };
      term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [co]))!.id;
      cal = (await one<{ id: string }>(c, "insert into calendars (company_id, external_id, name, appointment_term) values ($1,'CAL','Closer',$2) returning id", [co, term]))!.id;
      const book = async (key: string, first: string, at: DateTime) => {
        appt[key] = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, calendar_id, external_id, starts_at, ends_at, booked_at, status, appointment_term, assigned_user_id) values ($1,$2,$3,$4,$5,$6,now(),'confirmed',$7,$8) returning id",
          [co, await person(c, first), cal, key, at.toJSDate(), at.plus({ minutes: 45 }).toJSDate(), term, u]))!.id;
      };
      await book("OLD", "Olga", day(9));        // before the carry-over starts
      await book("BLANK", "Bea", day(2));       // nothing filed
      await book("FU", "Finn", day(1));         // a follow-up filed some other way, nothing else
      await book("DONE", "Dora", day(1));       // filed complete
      await book("TODAY", "Tess", now.set({ hour: 23, minute: 0 }));
    });
    // Finn: a follow-up from outside the end of day (no date, no next steps)
    await asOperator(async (c) => recordDisposition(c, { companyId: co, appointmentId: appt.FU, outcomeTermId: await termOf("appointment_outcome", "showed"), callOutcomeTermId: await termOf("call_outcome", "follow_up") }));
    // Dora: a no-show, filed on her day's end of day
    const fields = await asOperator((c) => loadEodForm(c, co));
    const noshow = valueFor(fields, { attendance: "noshow" });
    await asOperator(async (c) => {
      await recordDisposition(c, { companyId: co, appointmentId: appt.DONE, outcomeTermId: await termOf("appointment_outcome", "noshow") });
      await c.query("insert into eod_reports (company_id, user_id, day, prefill, answers, changes, submitted_at) values ($1,$2,$3,'{}',$4,'[]',now())", [co, closer.id, day(1).toFormat("yyyy-MM-dd"),
        JSON.stringify({ calls_count: 0, closes: 0, deposits: 0, cash: 0, revenue: 0, day_answers: {}, calls: [{ appointment_id: appt.DONE, contact_id: "", contact: "Dora Lee", starts_at: day(1).toISO(), href_contact: null, recording_url: null, kind: "closing", outcome: noshow, revenue: null, cash: null, next_date: null, next_steps: "", dq_reason: "", dq_note: "", extra: {} }] })]);
    });
    await setFrom(day(5).toFormat("yyyy-MM-dd"));
    // EOD: answers onto the Sales Call, and Finn's Sales Call as the engine made it (keyed by his booking)
    await asOperator(async (c) => {
      await installTemplateForTest(c, co, "eod-answers");
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.object_sales_call','text',$2)", [co, Buffer.from("custom_objects.sales_call")]);
      const finn = (await one<{ contact_id: string }>(c, "select contact_id from appointments where id=$1", [appt.FU]))!.contact_id;
      await c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id, properties) values ($1,'custom_objects.sales_call','FU','SC-FINN',$2,'{}')", [co, finn]);
    });
  });

  it("carries the unfiled call and the follow-up missing its fields; not the complete one, not one before the start", async () => {
    const list = await carried();
    const by = new Map(list.map((x) => [x.appointment_id, x]));
    expect([...by.keys()].sort()).toEqual([appt.BLANK, appt.FU].sort());
    expect(by.get(appt.BLANK)!.carried_from).toBe(day(2).toFormat("yyyy-MM-dd"));
    expect(by.get(appt.BLANK)!.missing).toEqual(["What happened on the call?"]);
    // no guess is pre-filled on a carried call (the day form guesses a no-show for want of a recording): the closer picks
    expect(by.get(appt.BLANK)!.outcome).toBe("");
    expect(by.get(appt.BLANK)!.hint).toBe("Nothing filed for this call yet.");
    // the follow-up's outcome came from outside the end of day: it still needs what a follow-up asks for
    expect(by.get(appt.FU)!.missing).toEqual(expect.arrayContaining(["Next follow-up", "Next steps", "Did you pitch them?"]));
  });

  it("today's form lists them after today's calls, and today's numbers leave them out", async () => {
    const f = await asOperator(async (c) => formFor(c, (await loadCompany(c, co)).row, closer, now.toFormat("yyyy-MM-dd"), now));
    expect(f.calls.map((x) => x.appointment_id)).toEqual([appt.TODAY, ...f.calls.slice(1).map((x) => x.appointment_id)]);
    expect(f.calls.filter((x) => x.carried_from).map((x) => x.appointment_id).sort()).toEqual([appt.BLANK, appt.FU].sort());
    expect(f.calls_count).toBe(1);
    // an earlier day's own form does not carry anything
    const past = await asOperator(async (c) => formFor(c, (await loadCompany(c, co)).row, closer, day(1).toFormat("yyyy-MM-dd"), now));
    expect(past.calls.some((x) => x.carried_from)).toBe(false);
  });

  it("an unfinished carried call never holds back today's filing; filing it complete takes it off", async () => {
    const token = await asOperator((c) => tokenFor(c, closer.id));
    const fields = await asOperator((c) => loadEodForm(c, co));
    const f = await asOperator(async (c) => formFor(c, (await loadCompany(c, co)).row, closer, now.toFormat("yyyy-MM-dd"), now));
    const noshow = valueFor(fields, { attendance: "noshow" }), fu = valueFor(fields, { call_outcome: "follow_up" });
    const calls = f.calls.map((x) => x.appointment_id === appt.TODAY ? { ...x, outcome: noshow }
      : x.appointment_id === appt.FU ? { ...x, outcome: fu, next_date: now.plus({ days: 3 }).toFormat("yyyy-MM-dd"), next_steps: "Call back Monday", pitched: "Yes" }
      : { ...x, outcome: "" });                     // Bea left blank: carried again
    const r = await asOperator((c) => submitEod(c, { token, day: now.toFormat("yyyy-MM-dd"), answers: { calls_count: 1, closes: 0, deposits: 0, cash: 0, revenue: 0, calls, day_answers: {} } }));
    expect(r.ok).toBe(true);
    expect((await carried()).map((x) => x.appointment_id)).toEqual([appt.BLANK]);
    // what Nina answered for Finn reaches his Sales Call
    for (let i = 0; i < 3; i++) await tick(fake, DateTime.now() as DateTime<true>, co);
    expect(written.find((w) => w.id === "SC-FINN")?.properties).toMatchObject({ next_step: "Call back Monday", next_step_date: now.plus({ days: 3 }).toFormat("yyyy-MM-dd") });
  });

  it("off (unset) carries nothing", async () => {
    await setFrom(null);
    try { expect(await carried()).toEqual([]); } finally { await setFrom(day(5).toFormat("yyyy-MM-dd")); }
  });

  it("the operator's preview shows today's form as the closer's link would, carried calls and what each needs; nothing is filed", async () => {
    const prev = process.env.CRON_SECRET; process.env.CRON_SECRET = "carry-key";
    try {
      const before = await asOperator((c) => one<{ n: number }>(c, "select count(*)::int as n from eod_reports where company_id=$1", [co]));
      const res = await preview(new Request("http://x/api/admin/eod/preview?company=eod-carry&closer=nina@carry.test", { headers: { authorization: "Bearer carry-key" } }));
      const body = await res.json() as { ok: boolean; calls: Array<{ appointment_id: string; carried_from: string | null; missing: string[] | null }> };
      expect(body.ok).toBe(true);
      expect(body.calls.filter((x) => x.carried_from).map((x) => x.appointment_id)).toContain(appt.BLANK);
      expect(body.calls.find((x) => x.appointment_id === appt.BLANK)!.missing).toEqual(["What happened on the call?"]);
      const after = await asOperator((c) => one<{ n: number }>(c, "select count(*)::int as n from eod_reports where company_id=$1", [co]));
      expect(after!.n).toBe(before!.n);
      expect((await preview(new Request("http://x/api/admin/eod/preview?company=eod-carry&closer=nina@carry.test"))).status).toBe(401);
    } finally { if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev; }
  });

  it("a DQ filed on the end of day writes its reason (and note) onto the call's Sales Call", async () => {
    await asOperator(async (c) => {
      const bea = (await one<{ contact_id: string }>(c, "select contact_id from appointments where id=$1", [appt.BLANK]))!.contact_id;
      await c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id, properties) values ($1,'custom_objects.sales_call','BLANK','SC-BEA',$2,'{}') on conflict do nothing", [co, bea]);
    });
    const token = await asOperator((c) => tokenFor(c, closer.id));
    const fields = await asOperator((c) => loadEodForm(c, co));
    const dq = valueFor(fields, { call_outcome: "unqualified" });
    const reason = fields.find((f) => f.key === "dq_reason")!.options![0]!;
    const f = await asOperator(async (c) => formFor(c, (await loadCompany(c, co)).row, closer, now.toFormat("yyyy-MM-dd"), now));
    const calls = f.calls.map((x) => x.appointment_id === appt.BLANK ? { ...x, outcome: dq, dq_reason: reason, dq_note: "Can't fund it until spring", pitched: "No" } : { ...x, outcome: x.outcome || valueFor(fields, { attendance: "noshow" }) });
    const r = await asOperator((c) => submitEod(c, { token, day: now.toFormat("yyyy-MM-dd"), answers: { calls_count: 0, closes: 0, deposits: 0, cash: 0, revenue: 0, calls, day_answers: {} } }));
    expect(r.ok).toBe(true);
    for (let i = 0; i < 3; i++) await tick(fake, DateTime.now() as DateTime<true>, co);
    expect(written.filter((w) => w.id === "SC-BEA").at(-1)?.properties).toMatchObject({ dq_reason: `${reason} - Can't fund it until spring` });
  });
});
