/** D34: the closer's end-of-day report. Prefilled from the engine's own ledger, every answer editable, corrections posted, outcomes recorded through the disposition path, a ✅ on the reminder DM. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { prefill, submitEod, remindDue, tokenFor, closerByToken, diffAnswers, todayFor } from "@/engine/eod";
import { loadCompany } from "@/engine/context";
import type { Adapters, BookingRead, SlackPersona } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.PUBLIC_URL = "https://engine.test";
const posts: { channel: string; text: string; as?: SlackPersona; threadTs?: string }[] = [];
const reactions: { channel: string; ts: string; emoji: string }[] = [];
const fake: Adapters = {
  read: { contactsChangedSince: async () => [], inboundSince: async () => [], callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], getContact: async () => null, listUsers: async () => [] },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "d" }) },
  sender: { sendSms: async () => ({ externalId: "s", accepted: true }), sendEmail: async () => ({ externalId: "e", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "confirmed", confidence: 1, distribution: {}, unclear: false }) },
  notifier: { post: async (_t, channel, text, as, threadTs) => { posts.push({ channel, text, as, threadTs }); return { ts: `ts${posts.length}` }; }, lookupUserByEmail: async (_t, email) => (email === "allan@eod.test" ? "UALLAN" : null), react: async (_t, channel, ts, emoji) => { reactions.push({ channel, ts, emoji }); return true; }, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};
const TZ = "America/Phoenix";
let companyId: string, allan: string, sarah: string, leo: string, apptSarah: string, apptLeo: string;

describe.skipIf(!process.env.DATABASE_URL)("end-of-day report (D34)", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='eod'");
      if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
        for (const t of ["eod_reports", "alerts", "sends", "runs", "events", "form_submissions", "forms", "recordings", "payments", "pipeline_cards", "appointments", "opportunities", "contact_identifiers", "contacts", "workflow_triggers", "workflows", "slack_connections", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode, eod_at) values ('EOD Co','eod',$1,'live','17:00') returning id", [TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'alerts.slack_channel','channel',$4)", [companyId, Buffer.from("LOC"), encrypt("p"), Buffer.from("CALERTS")]);
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [companyId, encrypt("xoxb-fake")]);
      allan = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,'allan@eod.test','Allan P','closer','GALLAN') returning id", [companyId]))!.id;
      sarah = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'GS','Sarah','Kim') returning id", [companyId]))!.id;
      leo = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'GL','Leo','Ortiz') returning id", [companyId]))!.id;
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      const cal = (await one<{ id: string }>(c, "insert into calendars (company_id, external_id, name, appointment_term) values ($1,'CAL','Closer',$2) returning id", [companyId, term]))!.id;
      const today = DateTime.now().setZone(TZ);
      const at = (h: number) => today.set({ hour: h, minute: 0, second: 0, millisecond: 0 }).toJSDate();
      apptSarah = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, calendar_id, external_id, starts_at, ends_at, booked_at, status, appointment_term, assigned_user_id) values ($1,$2,$3,'A1',$4,$5,now(),'confirmed',$6,$7) returning id", [companyId, sarah, cal, at(10), at(11), term, allan]))!.id;
      apptLeo = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, calendar_id, external_id, starts_at, ends_at, booked_at, status, appointment_term, assigned_user_id) values ($1,$2,$3,'A2',$4,$5,now(),'confirmed',$6,$7) returning id", [companyId, leo, cal, at(14), at(15), term, allan]))!.id;
      // Sarah's call was recorded and read: a follow-up with pains and a next step
      await c.query("insert into recordings (company_id, contact_id, appointment_id, provider, external_id, title, started_at, share_url, analysis, linked_by, raw) values ($1,$2,$3,'fathom','R1','Sarah <> Allan',$4,'https://fathom.video/share/r1',$5,'invitee_email','{}')", [companyId, sarah, apptSarah, at(10), { notes: { disposition: "follow_up", pain: ["thinning at the crown"], desire: ["keep what she has"], objections: [{ objection: "price", quote: "more than I expected" }], next_step: "decide with her partner", next_step_date: today.plus({ days: 3 }).toISODate(), summary: "Good call, price is the hang-up." } }]);
      // Leo paid today and his opportunity is won
      const opp = (await one<{ id: string }>(c, "insert into opportunities (company_id, contact_id, opened_by, status, won_at, contract_value) values ($1,$2,'test','won',$3,4000) returning id", [companyId, leo, at(15)]))!.id;
      await c.query("insert into payments (company_id, contact_id, opportunity_id, whop_payment_id, amount, status, paid_at) values ($1,$2,$3,'p1',1500,'succeeded',$4)", [companyId, leo, opp, at(15)]);
    });
  });

  it("prefills the day from the ledger: Sarah a follow-up with her pains and next step, Leo a close with cash and revenue; totals follow", async () => {
    const pre = await asOperator(async (c) => prefill(c, (await loadCompany(c, companyId)).row, { id: allan, name: "Allan P", email: "allan@eod.test" }, todayFor(TZ)));
    expect(pre.calls_count).toBe(2); expect(pre.closes).toBe(1); expect(pre.cash).toBe(1500); expect(pre.revenue).toBe(4000);
    const s = pre.calls.find((x) => x.contact === "Sarah Kim")!, l = pre.calls.find((x) => x.contact === "Leo Ortiz")!;
    expect(s).toMatchObject({ attendance: "showed", outcome: "follow_up", pains: "thinning at the crown", goals: "keep what she has", objections: "price", next_steps: "decide with her partner", recording_url: "https://fathom.video/share/r1" });
    expect(s.next_date).toBeTruthy();
    expect(l).toMatchObject({ attendance: "", outcome: "close", cash: 1500, revenue: 4000 });   // paid, but nobody has said he showed yet
    expect(l.href_contact).toBe("https://app.gohighlevel.com/v2/location/LOC/contacts/detail/GL");
  });

  it("the reminder: at the company's end-of-day time, a closer with calls and no filed report gets one DM with the standing link, once", async () => {
    const before = DateTime.now().setZone(TZ).set({ hour: 16, minute: 59 }) as DateTime<true>;
    expect((await asOperator((c) => remindDue(c, fake, before, companyId))).reminded).toEqual([]);
    const at = DateTime.now().setZone(TZ).set({ hour: 17, minute: 1 }) as DateTime<true>;
    const r = await asOperator((c) => remindDue(c, fake, at, companyId));
    expect(r.reminded).toEqual([{ company: "eod", closer: "Allan P" }]);
    const token = await asOperator((c) => tokenFor(c, allan));
    expect(posts.at(-1)).toMatchObject({ channel: "UALLAN", as: { name: "End of day" } });
    expect(posts.at(-1)!.text).toContain(`https://engine.test/eod/${token}|open your report`);
    expect((await asOperator((c) => remindDue(c, fake, at.plus({ minutes: 5 }), companyId))).reminded).toEqual([]);   // once
    expect((await asOperator((c) => closerByToken(c, token)))?.name).toBe("Allan P");
  });

  it("filing: outcomes recorded through the disposition path, corrections posted to the alerts channel, a ✅ and a reply on the DM", async () => {
    const token = await asOperator((c) => tokenFor(c, allan));
    const pre = await asOperator(async (c) => prefill(c, (await loadCompany(c, companyId)).row, { id: allan, name: "Allan P", email: "allan@eod.test" }, todayFor(TZ)));
    const answers = { ...pre, calls_count: 3, calls: pre.calls.map((x) => (x.contact === "Leo Ortiz" ? { ...x, attendance: "showed" as const, cash: 2000 } : x)) };
    const changes = diffAnswers(pre, answers);
    expect(changes.map((ch) => `${ch.contact ? `${ch.contact}: ` : ""}${ch.field} ${ch.from} → ${ch.to}`)).toEqual(["calls count 2 → 3", "Leo Ortiz: attendance blank → showed", "Leo Ortiz: cash 1500 → 2000"]);
    const n = posts.length;
    const r = await asOperator((c) => submitEod(c, fake, { token, day: todayFor(TZ), answers }));
    expect(r).toMatchObject({ ok: true, recorded: 2 });
    // the appointments carry the outcomes now, and the call.held events fired
    const rows = await asOperator((c) => many<{ id: string; status: string; oc: string | null; cc: string | null }>(c, "select a.id, a.status, ot.category as oc, ct.category as cc from appointments a left join company_terms ot on ot.id=a.outcome_term left join company_terms ct on ct.id=a.call_outcome_term where a.company_id=$1 order by a.starts_at", [companyId]));
    expect(rows.map((x) => [x.oc, x.cc])).toEqual([["showed", "follow_up"], ["showed", "closed"]]);
    expect((await asOperator((c) => one<{ n: string }>(c, "select count(*)::text as n from events where company_id=$1 and event_type='call.held'", [companyId])))!.n).toBe("2");
    // Slack: the ✅ and the reply on the reminder, and the corrections to the alerts channel
    expect(reactions).toEqual([{ channel: "UALLAN", ts: `ts${n}`, emoji: "white_check_mark" }]);
    const reply = posts.slice(n).find((p) => p.threadTs === `ts${n}`)!; expect(reply.text).toMatch(/^✅ Got it\. 3 calls, 1 close, \$1,500 collected\./);
    const summary = posts.slice(n).find((p) => p.channel === "CALERTS")!;
    expect(summary.text).toMatch(/📝 \*Allan P\* filed .*: 3 calls, 1 closes, \$1,500 cash, \$4,000 revenue\.\n\*Corrected from what the engine had:\*\n• calls count 2 → 3\n• Leo Ortiz: attendance blank → showed\n• Leo Ortiz: cash 1,500 → 2,000/);
    const filed = await asOperator((c) => one<{ submitted_at: Date | null; changes: unknown[] }>(c, "select submitted_at, changes from eod_reports where company_id=$1 and user_id=$2", [companyId, allan]));
    expect(filed?.submitted_at).toBeTruthy(); expect(filed?.changes).toHaveLength(3);
    // filed: no more reminders for that day
    expect((await asOperator((c) => remindDue(c, fake, DateTime.now().setZone(TZ).set({ hour: 18 }) as DateTime<true>, companyId))).reminded).toEqual([]);
  });
});
