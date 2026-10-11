/** D88: business rules that lived in engine code now live in workflows and settings. Each item: what an existing company sees is what it saw before, and editing the step or the setting changes it. */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { dispatchEvent } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { installTemplateForTest, replicaSnapshot } from "@/engine/test-install";
import { recordPayment } from "@/engine/payments";
import { ingestRecording } from "@/engine/inbound";
import { loadCompany } from "@/engine/context";
import type { Definition } from "@/engine/definition";
import { DateTime } from "luxon";
import { mergeEodFields, outcomesOf, choiceOf, totalsOf } from "@/engine/eod-form";
import { prefill, submitEod, tokenFor, saveEodForm, loadEodForm, eodFacts } from "@/engine/eod";
import type { Adapters, BookingRead, SlackPersona } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.PUBLIC_URL = "https://engine.test";
export const posts: { channel: string; text: string; as?: SlackPersona; threadTs?: string }[] = [];
export const reactions: { channel: string; ts: string; emoji: string }[] = [];
const fake: Adapters = {
  read: { contactsChangedSince: async () => [], openCards: async () => [], inboundSince: async () => [], callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], pipelineCards: async () => [], getContact: async (c, id) => replicaSnapshot(c.id, id), listUsers: async () => [] },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "d" }) },
  sender: { sendSms: async () => ({ externalId: "s", accepted: true }), sendEmail: async () => ({ externalId: "e", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "confirmed", confidence: 1, distribution: {}, unclear: false }) },
  notifier: { post: async (_t, channel, text, as, threadTs) => { posts.push({ channel, text, as, threadTs }); return { ts: `ts${posts.length}` }; }, lookupUserByEmail: async () => null, react: async (_t, channel, ts, emoji) => { reactions.push({ channel, ts, emoji }); return true; }, unreact: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }), update: async () => {} },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};
let companyId: string;
const TABLES = ["slack_posts", "alerts", "sends", "runs", "events", "form_submissions", "forms", "eod_reports", "crm_records", "recordings", "payments", "pipeline_cards", "appointments", "opportunities", "contact_identifiers", "contacts", "workflow_triggers", "workflows", "slack_connections", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log", "step_effects", "wrapups", "health_checks", "rollups_daily"];
const freshCompany = async (slug: string, mode = "live") => asOperator(async (c) => {
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
  if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
    for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]).catch(() => undefined); await c.query("delete from companies where id=$1", [co.id]); }
  const id = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode) values ('Moves Co',$1,'America/Phoenix',$2) returning id", [slug, mode]))!.id;
  await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [id]);
  await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'slack.channel.alerts','channel',$4),($1,'slack.channel.bookings','channel',$5)", [id, Buffer.from("LOC"), encrypt("p"), Buffer.from("CALERTS"), Buffer.from("CBOOK")]);
  await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [id, encrypt("xoxb-fake")]);
  return id;
});
const install = (slug: string, patch?: (d: Definition) => void) => asOperator((c) => installTemplateForTest(c, companyId, slug, { patch }));
const run = () => tick(fake, undefined, companyId);

describe.skipIf(!process.env.DATABASE_URL)("D88: unlinked payments and recordings are workflows (A2)", () => {
  beforeAll(async () => { await migrate(); companyId = await freshCompany("mvs-a2"); });
  beforeEach(() => { posts.length = 0; });

  it("an unlinked payment starts Unlinked payment, which posts what the engine used to post, word for word", async () => {
    await install("payment-unlinked");
    await asOperator(async (c) => { const r = await recordPayment(c, companyId, { providerPaymentId: "pay_x1", amount: 1500, status: "succeeded", email: "nobody@buyer.test", phone: "+16025550199", memberId: "mem_1", paidAt: new Date() }); expect(r.outcome).toBe("unlinked"); if (r.outcome === "unlinked") await dispatchEvent(c, r.event, {}); });
    await run();
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("CALERTS");
    expect(posts[0].text).toBe("*Unlinked payment* · $1500.00 succeeded\nNobody in the CRM matched this buyer.\n*Email:* nobody@buyer.test · *Phone:* +16025550199 · *Whop member:* mem_1\nLink it: https://engine.test/c/mvs-a2/payments");
  });

  it("an unmatched recording starts Unmatched recording, word for word; an edited copy says what the company wrote", async () => {
    await install("recording-unlinked");
    await asOperator(async (c) => { const { row, bindings } = await loadCompany(c, companyId); await ingestRecording(c, row, bindings, { provider: "fathom", externalId: "rec-x1", title: "Strategy call", startedAt: new Date(), endedAt: new Date(), durationMin: 32, shareUrl: "https://fathom.test/share/1", recordedBy: { email: "closer@co.test", name: "Closer" }, invitees: [{ name: "Ann", email: "ann@x.test" }, { name: "Bo" }], raw: {} }); });
    await run();
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toMatch(/^\*Unmatched recording\* · Strategy call · 32 min\n.+\n\*Attendees:\* ann@x\.test, Bo · \*Recorded by:\* closer@co\.test\nhttps:\/\/fathom\.test\/share\/1\nLink it: https:\/\/engine\.test\/c\/mvs-a2\/recordings$/);
    // the company's own words: its copy of the step changes what goes out
    await asOperator((c) => c.query("update workflows set enabled=false where company_id=$1", [companyId]));
    await install("payment-unlinked", (d) => { const n = d.nodes.find((x) => x.id === "n1")!; if (n.type === "slack_post") { n.template = "💸 Nobody matched {{event.customer_email}} (${{event.amount | money}})"; n.channel = "{{slack.channel.bookings}}"; } });
    await asOperator(async (c) => { const r = await recordPayment(c, companyId, { providerPaymentId: "pay_x2", amount: 2999, status: "succeeded", email: "ghost@buyer.test", paidAt: new Date() }); if (r.outcome === "unlinked") await dispatchEvent(c, r.event, {}); });
    await run();
    expect(posts.at(-1)).toMatchObject({ channel: "CBOOK", text: "💸 Nobody matched ghost@buyer.test ($2,999)" });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D88: a card moved by hand is a workflow (A1)", () => {
  let contact: string, appt: string;
  beforeAll(async () => {
    await migrate(); companyId = await freshCompany("mvs-a1");
    await asOperator(async (c) => {
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.pipeline_closer','id','P-C'),($1,'crm.stage_closer_lost','id','S-LOST'),($1,'crm.stage_closer_follow_up','id','S-FU')", [companyId]);
      await c.query("insert into users (company_id, email, name, role, ghl_user_id) values ($1,'sam@x.test','Sam Closer','closer','U-SAM')", [companyId]);
      contact = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'G-PAT','Pat','Lind') returning id", [companyId]))!.id;
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      const cal = (await one<{ id: string }>(c, "insert into calendars (company_id, external_id, name, appointment_term, active) values ($1,'CAL','Closer',$2,true) returning id", [companyId, term]))!.id;
      appt = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, calendar_id, external_id, appointment_term, starts_at, ends_at, status, booked_at) values ($1,$2,$3,'A-PAT',$4,now() - interval '2 hours', now() - interval '1 hour','confirmed', now() - interval '3 days') returning id", [companyId, contact, cal, term]))!.id;
      await c.query("insert into slack_posts (company_id, tag, channel, ts) values ($1,$2,'CBOOK','ts-booking')", [companyId, `appointment:${appt}`]);
    });
  });
  beforeEach(() => { posts.length = 0; });
  const move = (from: string, to: string) => asOperator(async (c) => {
    const opp = (await one<{ id: string }>(c, "insert into opportunities (company_id, contact_id, status, opened_by) values ($1,$2,'open','test') returning id", [companyId, contact]))!.id;
    const { handMoved } = await import("@/engine/card-moves");
    return handMoved(c, companyId, fake, { contactId: contact, cardId: "x", opportunityId: opp, crmCardId: "CARD-1", pipelineId: "P-C", fromStage: from, toStage: to, fromStatus: "open", toStatus: "open", movedBy: "U-SAM", at: new Date() });
  });
  const outcome = () => asOperator((c) => one<{ outcome: string | null; call_outcome: string | null; via: string | null }>(c, `select ot.category as outcome, cot.category as call_outcome, (select fs.answers->>'via' from form_submissions fs where fs.appointment_id=a.id order by fs.submitted_at desc limit 1) as via
    from appointments a left join company_terms ot on ot.id=a.outcome_term left join company_terms cot on cot.id=a.call_outcome_term where a.id=$1`, [appt]));

  it("the engine only records card.moved; the workflow says it in the thread and files a lost call as a person's answer", async () => {
    await install("card-moved");
    const r = await move("S-FU", "S-LOST");
    expect(r.runs).toHaveLength(1);
    expect(posts).toHaveLength(0);   // nothing is said by the engine itself
    await run();
    expect(posts).toEqual([expect.objectContaining({ channel: "CBOOK", threadTs: "ts-booking", text: "🗂️ Sam Closer moved the closer card to Lost", as: { name: "Card moved", icon: ":card_index_dividers:" } })]);
    expect(await outcome()).toEqual({ outcome: "showed", call_outcome: "lost", via: "card_moved" });
    expect(await asOperator((c) => one(c, "select 1 from events where company_id=$1 and event_type='appointment.outcome' and source='disposition'", [companyId]))).toBeTruthy();   // Call outcome filed starts on this
  });

  it("the company's copy decides: a line in its own words, and Lost only noted", async () => {
    await asOperator((c) => c.query("update workflows set enabled=false where company_id=$1", [companyId]));
    await asOperator((c) => c.query("update appointments set outcome_term=null, call_outcome_term=null where id=$1", [appt]));
    await install("card-moved", (d) => {
      const v = d.nodes.find((n) => n.id === "v_line")!; if (v.type === "set_var") v.value = "{{event.mover | default:someone}} dragged {{event.to_name}}";
      d.edges = d.edges.filter((e) => e.to !== "o_lost");
    });
    await move("S-FU", "S-LOST");
    await run();
    expect(posts.map((p) => p.text)).toEqual(["Sam Closer dragged Lost"]);
    expect(await outcome()).toMatchObject({ outcome: null, call_outcome: null });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D88: the end-of-day form's outcomes are the company's (B6), and a card dragged to Lost asks why (A1)", () => {
  let sam: string, appt: string, contact: string;
  const day = () => DateTime.now().setZone("America/Phoenix").toFormat("yyyy-MM-dd");
  beforeAll(async () => {
    await migrate(); companyId = await freshCompany("mvs-eod");
    await asOperator(async (c) => {
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.pipeline_closer','id','P-C'),($1,'crm.stage_closer_lost','id','S-LOST'),($1,'slack.channel.eod','channel','CEOD')", [companyId]);
      sam = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,'sam@x.test','Sam Closer','closer','U-SAM') returning id", [companyId]))!.id;
      contact = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'G-LEE','Lee','Park') returning id", [companyId]))!.id;
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      const cal = (await one<{ id: string }>(c, "insert into calendars (company_id, external_id, name, appointment_term, active) values ($1,'CAL','Closer',$2,true) returning id", [companyId, term]))!.id;
      appt = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, calendar_id, external_id, appointment_term, starts_at, ends_at, status, booked_at, assigned_user_id) values ($1,$2,$3,'A-LEE',$4,now() - interval '20 minutes', now() - interval '5 minutes','confirmed', now() - interval '3 days',$5) returning id", [companyId, contact, cal, term, sam]))!.id;
    });
  });
  beforeEach(() => { posts.length = 0; });

  it("the defaults gain Close pending: a show, never a close; the builtins follow what an answer means", () => {
    const fields = mergeEodFields(null);
    expect(outcomesOf(fields).map((o) => o.value)).toEqual(["closed", "deposit", "pending", "follow_up", "lost", "dq", "rescheduled", "no_show"]);
    expect(choiceOf("pending", fields)).toMatchObject({ label: "Close pending", attendance: "showed", call_outcome: "pending" });
    const call = (outcome: string) => ({ appointment_id: outcome, contact_id: "", contact: outcome, starts_at: "", href_contact: null, recording_url: null, outcome, revenue: 3000, cash: 500, next_date: null, next_steps: "", dq_reason: "", dq_note: "", about: "", notes: "", extra: {} });
    expect(totalsOf([call("closed"), call("pending"), call("deposit")], fields)).toEqual({ calls_count: 3, closes: 1, deposits: 1, cash: 1000, revenue: 6000 });
    expect(fields.find((f) => f.key === "about")!.when).toEqual(["closed", "deposit", "pending", "follow_up", "lost", "dq"]);
  });

  it("a company's own list: its words, its keys, the meaning decides what is filed and counted", async () => {
    const own = [{ key: "outcome", label: "What happened?", type: "select" as const, scope: "call" as const, required: true, builtin: true, choices: [
      { value: "won", label: "Won 🎉", attendance: "showed" as const, call_outcome: "closed" as const },
      { value: "half", label: "Signed, not paid", attendance: "showed" as const, call_outcome: "pending" as const },
      { value: "gone", label: "Lost it", attendance: "showed" as const, call_outcome: "lost" as const },
      { value: "ghost", label: "Ghosted", attendance: "noshow" as const } ] }];
    await asOperator((c) => saveEodForm(c, companyId, own));
    const fields = await asOperator((c) => loadEodForm(c, companyId));
    expect(outcomesOf(fields).map((o) => o.label)).toEqual(["Won 🎉", "Signed, not paid", "Lost it", "Ghosted"]);
    expect(fields.find((f) => f.key === "cash")!.when).toEqual(["won"]);
    expect(fields.find((f) => f.key === "lost_reason")!.when).toEqual(["gone"]);
    const token = await asOperator((c) => tokenFor(c, sam));
    const pre = await asOperator(async (c) => prefill(c, (await loadCompany(c, companyId)).row, { id: sam, name: "Sam Closer", email: "sam@x.test" }, day()));
    const calls = pre.calls.map((x) => ({ ...x, outcome: "half" }));
    expect(await asOperator((c) => submitEod(c, fake, { token, day: day(), answers: { ...pre, ...totalsOf(calls, fields), calls, day_answers: {} } }))).toMatchObject({ ok: true, recorded: 1 });
    expect(await asOperator((c) => one(c, "select ot.category as outcome, cot.category as call_outcome from appointments a join company_terms ot on ot.id=a.outcome_term join company_terms cot on cot.id=a.call_outcome_term where a.id=$1", [appt]))).toEqual({ outcome: "showed", call_outcome: "pending" });
    expect(totalsOf(calls, fields).closes).toBe(0);
    // the form shows the ledger's answer in the company's own word
    expect((await asOperator(async (c) => prefill(c, (await loadCompany(c, companyId)).row, { id: sam, name: "Sam Closer", email: "sam@x.test" }, day()))).calls[0].outcome).toBe("half");
    await asOperator((c) => c.query("delete from forms where company_id=$1 and purpose='eod'", [companyId]));
    await asOperator((c) => c.query("delete from eod_reports where company_id=$1", [companyId]));
  });

  it("a card dragged to Lost: the form opens Lost with what the move said, asks why, the reminder owes the day until it is filed, and the summary says why", async () => {
    await install("card-moved"); await install("eod-filed");
    await asOperator((c) => c.query("update appointments set outcome_term=null, call_outcome_term=null where id=$1", [appt]));
    await asOperator(async (c) => {
      const opp = (await one<{ id: string }>(c, "insert into opportunities (company_id, contact_id, status, opened_by) values ($1,$2,'open','test') returning id", [companyId, contact]))!.id;
      const { handMoved } = await import("@/engine/card-moves");
      await handMoved(c, companyId, fake, { contactId: contact, cardId: "x", opportunityId: opp, crmCardId: "CARD-L", pipelineId: "P-C", fromStage: "S-SCHED", toStage: "S-LOST", fromStatus: "open", toStatus: "open", movedBy: "U-SAM", at: new Date() });
    });
    await run();
    const who = { id: sam, name: "Sam Closer", email: "sam@x.test" };
    const pre = await asOperator(async (c) => prefill(c, (await loadCompany(c, companyId)).row, who, day()));
    expect(pre.calls[0]).toMatchObject({ outcome: "lost", moved: "Card moved to Lost in the CRM by Sam Closer. Say why.", lost_reason: "" });
    const facts = await asOperator(async (c) => eodFacts(c, (await loadCompany(c, companyId)).row, sam, "https://engine.test"));
    expect(facts.today).toMatchObject({ calls: 1, filed: false, moved: [appt] });   // owed: the closer has not said why
    const token = await asOperator((c) => tokenFor(c, sam));
    expect(await asOperator((c) => submitEod(c, fake, { token, day: day(), answers: { ...pre, calls: pre.calls, day_answers: {} } }))).toEqual({ ok: false, why: "Still needed: Lee Park: Why were they lost?" });
    const calls = pre.calls.map((x) => ({ ...x, lost_reason: "Timing" }));
    expect(await asOperator((c) => submitEod(c, fake, { token, day: day(), answers: { ...pre, calls, day_answers: {} } }))).toMatchObject({ ok: true });
    await run();
    expect(posts.find((p) => p.channel === "CEOD")!.text).toMatch(/\n\*Why lost or DQ:\* \n• Lee Park \(Lost\): Timing$/);
    expect((await asOperator(async (c) => eodFacts(c, (await loadCompany(c, companyId)).row, sam, "https://engine.test"))).today).toMatchObject({ filed: true });
  });
});
