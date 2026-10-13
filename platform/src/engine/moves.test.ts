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
import { reportFacts, renderLayout, shippedLayout } from "@/engine/reports";
import type { Adapters, BookingRead, SlackPersona } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.PUBLIC_URL = "https://engine.test";
export const posts: { channel: string; text: string; as?: SlackPersona; threadTs?: string }[] = [];
export const reactions: { channel: string; ts: string; emoji: string }[] = [];
const fake: Adapters = {
  read: { contactsChangedSince: async () => [], openCards: async () => [], inboundSince: async () => [], messageBodies: async () => new Map(), callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], pipelineCards: async () => [], getContact: async (c, id) => replicaSnapshot(c.id, id), listUsers: async () => [] },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "r" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "o" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "d" }) },
  sender: { sendSms: async () => ({ externalId: "s", accepted: true }), sendEmail: async () => ({ externalId: "e", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "confirmed", confidence: 1, distribution: {}, unclear: false }) },
  notifier: { post: async (_t, channel, text, as, threadTs) => { posts.push({ channel, text, as, threadTs }); return { ts: `ts${posts.length}` }; }, lookupUserByEmail: async () => null, react: async (_t, channel, ts, emoji) => { reactions.push({ channel, ts, emoji }); return true; }, unreact: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }), update: async () => {} },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};
let companyId: string;
const TABLES = ["webhook_deliveries", "slack_posts", "alerts", "sends", "runs", "events", "form_submissions", "forms", "eod_reports", "crm_records", "recordings", "payments", "pipeline_cards", "appointments", "opportunities", "contact_identifiers", "contacts", "workflow_triggers", "workflows", "slack_connections", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log", "step_effects", "wrapups", "health_checks", "rollups_daily"];
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
    // a run about the company (no contact, no person) ends like any other: completed, finished, let go (D90, checked after a live run read as stuck)
    expect(await asOperator((c) => many(c, "select r.status, r.contact_id, r.user_id, r.claimed_at, r.finished_at is not null as finished from runs r join workflows w on w.id=r.workflow_id where w.company_id=$1 and w.name='Unlinked payment'", [companyId])))
      .toEqual([{ status: "completed", contact_id: null, user_id: null, claimed_at: null, finished: true }]);
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
    expect(posts.find((p) => p.channel === "CEOD")!.text).toMatch(/\n• Lee Park: Lost · Timing$/);
    expect((await asOperator(async (c) => eodFacts(c, (await loadCompany(c, companyId)).row, sam, "https://engine.test"))).today).toMatchObject({ filed: true });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D88: an end-of-day answer for a Sales Call booked before the engine is a workflow (A3)", () => {
  let sam: string;
  const writes: { id: string; props: Record<string, unknown> }[] = [];
  beforeAll(async () => {
    await migrate(); companyId = await freshCompany("mvs-a3");
    await asOperator(async (c) => {
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.object_sales_call','id','custom_objects.sales_call'),($1,'sales_call.outcomes','text',$2)", [companyId, Buffer.from(JSON.stringify({ showed: "showed", no_show: "noshow", scheduled: "scheduled" }))]);
      sam = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role) values ($1,'sam@x.test','Sam Closer','closer') returning id", [companyId]))!.id;
    });
    fake.write.updateRecord = async (_c, _o, id, props) => { writes.push({ id, props }); };
  });
  const filed = (data: Record<string, unknown>) => asOperator(async (c) => { const { emitEvent } = await import("@/engine/dispatch"); return dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: null, opportunity_id: null, appointment_id: null, event_type: "eod.call_filed", source: "user", data: { user_id: sam, ...data } }), { user: { id: sam } }); });

  it("the record is written by its id with the company's keys; a no-show empties what a held call carried; an edited copy writes what it says", async () => {
    await install("eod-call-filed");
    expect(await filed({ record_id: "REC1", outcome: "lost", attendance: "showed", meaning: "lost" })).toHaveLength(1);
    await filed({ record_id: "REC2", outcome: "no_show", attendance: "noshow", meaning: null });
    await run();
    expect([...writes].sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: "REC1", props: { outcome: "showed", disposition: "lost" } }, { id: "REC2", props: { outcome: "no_show", disposition: null, cash_collected: null, objection_primary: null, next_step: null, next_step_date: null, payment_terms: null } }]);
    await asOperator((c) => c.query("update workflows set enabled=false where company_id=$1", [companyId]));
    await install("eod-call-filed", (d) => { const v = d.nodes.find((n) => n.id === "v_disp")!; if (v.type === "set_var") v.pick = { ...v.pick, lost: "lost_other" }; });
    await filed({ record_id: "REC3", outcome: "lost", attendance: "showed", meaning: "lost" });
    await run();
    expect(writes.at(-1)).toEqual({ id: "REC3", props: { outcome: "showed", disposition: "lost_other" } });
  });

  it("before live the record is not written (shadow): the run says what it would have written", async () => {
    await asOperator((c) => c.query("update companies set mode='shadow' where id=$1", [companyId]));
    const n = writes.length;
    await filed({ record_id: "REC4", outcome: "lost", attendance: "showed", meaning: "lost" });
    await run();
    expect(writes).toHaveLength(n);
    expect(await asOperator((c) => one(c, "select 1 from run_steps s join runs r on r.id=s.run_id where r.company_id=$1 and s.node_id='r_held' and s.result->>'shadow'='true'", [companyId]))).toBeTruthy();
    await asOperator((c) => c.query("update companies set mode='live' where id=$1", [companyId]));
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D88: won and lost are workflow steps (A9)", () => {
  let contact: string, appt: string, opp: string;
  const oppRow = () => asOperator((c) => one<{ status: string; lost_at: Date | null; won_at: Date | null }>(c, "select status, lost_at, won_at from opportunities where id=$1", [opp]));
  const oppEvents = (t: string) => asOperator((c) => many<{ data: Record<string, unknown> }>(c, "select data from events where opportunity_id=$1 and event_type=$2 order by id", [opp, t]));
  beforeAll(async () => {
    await migrate(); companyId = await freshCompany("mvs-a9");
    await asOperator(async (c) => {
      await c.query("update companies set contract_value_default=3000 where id=$1", [companyId]);
      contact = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'G-ROY','Roy','Kent') returning id", [companyId]))!.id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','roy@x.test')", [companyId, contact]);
      opp = (await one<{ id: string }>(c, "insert into opportunities (company_id, contact_id, status, opened_by, contract_value) values ($1,$2,'open','test',3000) returning id", [companyId, contact]))!.id;
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      const cal = (await one<{ id: string }>(c, "insert into calendars (company_id, external_id, name, appointment_term, active) values ($1,'CAL','Closer',$2,true) returning id", [companyId, term]))!.id;
      appt = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, calendar_id, external_id, appointment_term, starts_at, ends_at, status, booked_at, opportunity_id) values ($1,$2,$3,'A-ROY',$4,now() - interval '2 hours', now() - interval '1 hour','confirmed', now() - interval '3 days',$5) returning id", [companyId, contact, cal, term, opp]))!.id;
    });
  });
  const file = (call: string) => asOperator(async (c) => {
    const { recordDisposition, outcomeTermFor } = await import("@/engine/disposition");
    const callTerm = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='call_outcome' and category=$2", [companyId, call]))!.id;
    return recordDisposition(c, { companyId, appointmentId: appt, outcomeTermId: (await outcomeTermFor(c, companyId, "showed"))!, callOutcomeTermId: callTerm });
  });

  it("Call outcome filed: a loss marks the open opportunity lost, a refiled answer that takes the loss back opens it again; the engine itself writes neither", async () => {
    await install("call-outcome", (d) => {
      const keep = new Set(["t1", "u1", "u2", "u3", "u4", "o_reopen", "b1", "b2", "c3", "o_lost", "x0", "x1"]);
      d.nodes = d.nodes.filter((n) => keep.has(n.id));
      d.edges = [{ from: "t1", to: "u1" }, { from: "u1", to: "u2" }, { from: "u2", to: "u3" }, { from: "u3", to: "u4" }, { from: "u4", to: "o_reopen" }, { from: "o_reopen", to: "b1" },
        { from: "b1", to: "b2", when: { eq: ["{{event.outcome}}", "showed"] } }, { from: "b1", to: "x0", else: true },
        { from: "b2", to: "c3", when: { eq: ["{{appointment.call_outcome}}", "lost"] } }, { from: "b2", to: "x1", else: true }, { from: "c3", to: "o_lost" }, { from: "o_lost", to: "x1" }];
    });
    await file("lost");
    expect(await oppRow()).toMatchObject({ status: "open" });   // nothing until the workflow runs
    await run();
    expect(await oppRow()).toMatchObject({ status: "lost" });
    expect(await oppEvents("opportunity.lost")).toEqual([{ data: expect.objectContaining({ by: "workflow", node: "o_lost", from: "open" }) }]);
    await file("follow_up"); await run();
    expect(await oppRow()).toMatchObject({ status: "open", lost_at: null });
    // a won pursuit is never made lost by a later answer: the step changes it only from open
    await asOperator((c) => c.query("update opportunities set status='won', won_at=now() where id=$1", [opp]));
    await file("lost"); await run();
    expect(await oppRow()).toMatchObject({ status: "won" });
    await asOperator((c) => c.query("update opportunities set status='open', won_at=null where id=$1", [opp]));
    await asOperator((c) => c.query("update workflows set enabled=false where company_id=$1", [companyId]));
  });

  it("Payment recorded: a payment wins the open opportunity, once; a company that wins on paid in full says so on the step", async () => {
    const pay = (id: string, amount: number) => asOperator(async (c) => { const r = await recordPayment(c, companyId, { providerPaymentId: id, amount, status: "succeeded", email: "roy@x.test", paidAt: new Date() }); if (r.outcome === "linked") await dispatchEvent(c, r.event, { contact: { id: contact } }); return r; });
    const onlyTheWin = (d: Definition, cond?: Definition["nodes"][number]["only_if"]) => {
      d.nodes = d.nodes.filter((n) => ["t1", "t2", "v1", "o_won", "x1"].includes(n.id)); d.edges = [{ from: "t1", to: "v1" }, { from: "t2", to: "v1" }, { from: "v1", to: "o_won" }, { from: "o_won", to: "x1" }];
      if (cond) { const n = d.nodes.find((x) => x.id === "o_won")!; n.only_if = cond; }
    };
    await install("payment-recorded", (d) => onlyTheWin(d, { and: [{ eq: ["{{event._type}}", "payment.received"] }, { eq: ["{{event.cleared}}", true] }] }));
    await pay("p-dep", 1000); await run();
    expect(await oppRow()).toMatchObject({ status: "open" });   // a deposit: this company wins on paid in full
    // D103: the skipped step names the part of its condition that did not hold
    expect((await asOperator((c) => one<{ why: string }>(c, "select s.result->>'why' as why from run_steps s join runs r on r.id=s.run_id where r.company_id=$1 and s.node_id='o_won' order by s.started_at desc limit 1", [companyId])))?.why).toBe("only if this is a payment and paid in full; not paid in full");
    await pay("p-bal", 2000); await run();
    expect(await oppRow()).toMatchObject({ status: "won" });
    await asOperator((c) => c.query("update workflows set enabled=false where company_id=$1", [companyId]));
    await asOperator((c) => c.query("update opportunities set status='open', won_at=null where id=$1", [opp]));
    await asOperator((c) => c.query("delete from events where opportunity_id=$1 and event_type='opportunity.won'", [opp]));
    await install("payment-recorded", (d) => onlyTheWin(d));   // the template as shipped: any payment wins it
    await pay("p-3", 100); await run();
    await pay("p-4", 100); await run();
    expect(await oppRow()).toMatchObject({ status: "won" });
    expect(await oppEvents("opportunity.won")).toEqual([{ data: expect.objectContaining({ by: "workflow", node: "o_won" }) }]);   // once
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D88: the end-of-day reminder's days and words are the template's (A4)", () => {
  let sam: string;
  const TZ = "America/Phoenix";
  beforeAll(async () => {
    await migrate(); companyId = await freshCompany("mvs-a4");
    await asOperator(async (c) => {
      sam = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, slack_user_id) values ($1,'sam@x.test','Sam Closer','closer','USAM') returning id", [companyId]))!.id;
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      const cal = (await one<{ id: string }>(c, "insert into calendars (company_id, external_id, name, appointment_term, active) values ($1,'CAL','Closer',$2,true) returning id", [companyId, term]))!.id;
      for (const [i, daysAgo] of [[1, 0], [2, 3], [3, 9]] as const) {
        const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,$2,$3) returning id", [companyId, `G${i}`, `P${i}`]))!.id;
        const at = DateTime.now().setZone(TZ).minus({ days: daysAgo }).set({ hour: daysAgo ? 10 : 0, minute: 30 });
        await c.query("insert into appointments (company_id, contact_id, calendar_id, external_id, appointment_term, starts_at, ends_at, status, booked_at, assigned_user_id) values ($1,$2,$3,$4,$5,$6,$7,'confirmed',now() - interval '20 days',$8)", [companyId, ct, cal, `A${i}`, term, at.toJSDate(), at.plus({ minutes: 30 }).toJSDate(), sam]);
      }
    });
  });
  beforeEach(() => { posts.length = 0; });
  const evening = async (wf: string) => { const { fireNow } = await import("@/engine/clock"); await asOperator((c) => fireNow(c, companyId, wf, "t_evening")); await run(); return posts.filter((p) => p.channel === "USAM").map((p) => p.text); };
  const off = () => asOperator((c) => c.query("update workflows set enabled=false where company_id=$1", [companyId]));

  it("as shipped: today and the last 7 days, one line each, in the template's words", async () => {
    const wf = await install("eod-reminder");
    const token = await asOperator((c) => tokenFor(c, sam));
    const d3 = DateTime.now().setZone(TZ).minus({ days: 3 });
    expect(await evening(wf)).toEqual([`Hey Sam, your end-of-day is waiting:\n• <https://engine.test/eod/${token}?day=${d3.toISODate()}|${d3.toFormat("ccc LLL d")}>: 1 call\n• <https://engine.test/eod/${token}|today>: 1 call\nIt's prefilled from your calendar and the day's calls. Fix anything that's off and hit submit.`]);
    await off();
  });

  it("the company's settings and words: 10 days back, today left out, its own line", async () => {
    const wf = await install("eod-reminder", (d) => {
      const n = d.nodes.find((x) => x.id === "v_evening")!; if (n.type === "eod_due") { n.lookback_days = 10; n.include_today = false; }
      const dm = d.nodes.find((x) => x.id === "n_dm")!; if (dm.type === "slack_post") dm.template = "Still to file: {{vars.due.days | each:\"{{item.label}} ({{item.calls | plural:\\\"call|calls\\\"}})\" | join:\"; \"}}";
    });
    const [d3, d9] = [3, 9].map((n) => DateTime.now().setZone(TZ).minus({ days: n }).toFormat("ccc LLL d"));
    expect(await evening(wf)).toEqual([`Still to file: ${d9} (1 call); ${d3} (1 call)`]);
    await off();
  });

  it("a copy edited before D88 (no settings on its step) still gets its lines as text, word for word", async () => {
    const wf = await install("eod-reminder", (d) => {
      for (const id of ["v_evening", "v_morning"]) { const n = d.nodes.find((x) => x.id === id)!; if (n.type === "eod_due") { n.into = "lines"; delete n.lookback_days; delete n.include_today; delete n.overdue_after_days; } }
      const c = d.nodes.find((x) => x.id === "c_due")!; if (c.type === "check") c.when = { neq: ["{{vars.lines}}", ""] };
      const dm = d.nodes.find((x) => x.id === "n_dm")!; if (dm.type === "slack_post") dm.template = "Hey {{user.first_name}}, your end-of-day is waiting:\n{{vars.lines}}\nIt's prefilled from your calendar and the day's calls. Fix anything that's off and hit submit.";
      const op = d.nodes.find((x) => x.id === "n_op")!; if (op.type === "slack_post") { op.only_if = { and: [{ exists: "company.operator_slack_id" }, { neq: ["{{vars.overdue_lines | default:}}", ""] }] }; op.template = "{{user.name}}: {{vars.overdue_lines}}"; }
    });
    const token = await asOperator((c) => tokenFor(c, sam));
    const d3 = DateTime.now().setZone(TZ).minus({ days: 3 });
    await asOperator((c) => c.query("delete from runs where workflow_id=$1", [wf]));
    expect(await evening(wf)).toEqual([`Hey Sam, your end-of-day is waiting:\n• <https://engine.test/eod/${token}?day=${d3.toISODate()}|${d3.toFormat("ccc LLL d")}>: 1 call\n• <https://engine.test/eod/${token}|today>: 1 call\nIt's prefilled from your calendar and the day's calls. Fix anything that's off and hit submit.`]);
    await off();
  });
});

describe("D88: the wrap-up's words are the template's (A8)", () => {
  const day = { start: "2026-10-10", end: "2026-10-10" };
  const facts = (over: Partial<Parameters<typeof reportFacts>[0]> = {}) => reportFacts({ kind: "daily", period: day, tz: "UTC", toDate: false, numbers: { leads: 3, booked: 0 }, calls: null, said: [], readAt: new Date("2026-10-10T19:00:00Z"), ...over });
  const FOOT = "\n\n_From GHL and the engine, read 7:00 PM UTC_";
  const body = (f: ReturnType<typeof reportFacts>, layout = shippedLayout(f.kind)) => renderLayout(layout, f, {}, { tz: "UTC", companyTz: "UTC" });

  it("as shipped: what they said, the top four answers each, the rest counted, long answers cut", () => {
    const long = "Business owner or entrepreneur who runs several companies at once and travels";
    const said = [{ label: "work situation", answered: 9, top: [[long, 3], ["Employed full-time", 2], ["Investor", 1], ["Retired", 1]] as [string, number][], rest: 2, restKinds: 2 }, { label: "budget", answered: 2, top: [["$5k", 2]] as [string, number][], rest: 0, restKinds: 0 }];
    expect(body(facts({ said }))).toBe(`📊 *Today, Sat Oct 10*\n\n\`\`\`\nLeads   3\n\`\`\`\n\n*What they said*\n*work situation*\n• 3 — ${long.slice(0, 59)}…\n• 2 — Employed full-time\n• 1 — Investor\n• 1 — Retired\n• 2 — other answers\n\n*budget*\n• 2 — $5k${FOOT}`);
  });

  it("the company's layout decides the words, the sections and the order; per-closer lines when the step asks for them", () => {
    const layout = { heading: { daily: "📊 {{report.start | date:LLL d}}" }, empty: { daily: "Quiet day." }, sections: [
      { title: "People", lines: ["{{report.n.leads | each:\"{{item | plural:lead}} came in\"}}"] },
      { title: "By closer", lines: ["{{report.by.closer | each:\"{{item.name}} won {{item.values.deals_won | default:0}}\" | join:\"\\n\"}}"] }] };
    expect(body(facts(), layout)).toBe("📊 Oct 10\n\nPeople\n3 leads came in");
    expect(body(facts({ by: { closer: [{ id: "1", name: "Sam", values: { deals_won: 2 } }], setter: [] } }), layout)).toBe("📊 Oct 10\n\nPeople\n3 leads came in\n\nBy closer\nSam won 2");
    expect(body(facts({ numbers: { leads: 0 } }), layout)).toBe("Quiet day.");
  });

  it("this week so far has its own heading and empty line; the shipped words are unchanged", () => {
    expect(body(facts({ kind: "weekly", toDate: true, period: { start: "2026-10-05", end: "2026-10-10" }, numbers: {} }))).toBe("Nothing this week: no leads, bookings, calls or payments.");
    expect(body(facts({ kind: "weekly", toDate: true, period: { start: "2026-10-05", end: "2026-10-10" } }))).toBe(`📊 *This week so far, Oct 5 to Oct 10*\n\n\`\`\`\nLeads   3\n\`\`\`${FOOT}`);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D88: the wrap-ups workflow words its post from its own step (A8)", () => {
  beforeAll(async () => { await migrate(); companyId = await freshCompany("mvs-a8"); await asOperator((c) => c.query("insert into bindings (company_id,key,kind,value) values ($1,'slack.channel.reports','channel','CREP')", [companyId])); });
  beforeEach(() => { posts.length = 0; });
  it("an edited layout and metric list change what is posted and what the wrap-ups ledger keeps", async () => {
    const { fakeProbes } = await import("@/engine/test-install");
    const ghl = { contactsAdded: async () => [], wonCards: async () => [], objectRecords: async () => [], cards: async () => [], pipelines: async () => [], users: async () => [], getContact: async () => null, recordContact: async () => null, fieldCatalog: async () => [] };
    const wf = await install("daily-wrap-up", (d) => { const n = d.nodes.find((x) => x.id === "n_build")!; if (n.type === "report") { n.metrics = ["booked", "dials"]; n.layout = { heading: { daily: "Today" }, empty: { daily: "Nothing to report, boss." }, sections: [{ title: "Calls", lines: ["{{report.raw.dials}} dials"] }] }; } });
    const { fireNow } = await import("@/engine/clock");
    await asOperator((c) => fireNow(c, companyId, wf, "t_daily"));
    await tick(fake, undefined, companyId, { ...fakeProbes, ghl });
    expect(posts.map((p) => p.text)).toEqual(["Today\n\nCalls\n0 dials"]);
    expect((await asOperator((c) => one<{ body: string; numbers: { registry: Record<string, unknown> } }>(c, "select body, numbers from wrapups where company_id=$1", [companyId])))).toMatchObject({ body: "Today\n\nCalls\n0 dials", numbers: { registry: { booked: 0, dials: 0 } } });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D88: alerts are said by the Health check workflow; the cadence is a setting (A7)", () => {
  beforeAll(async () => { await migrate(); companyId = await freshCompany("mvs-a7"); await asOperator((c) => c.query("insert into bindings (company_id,key,kind,value) values ($1,'alerts.slack_channel','channel','CALERTS')", [companyId])); });
  beforeEach(() => { posts.length = 0; reactions.length = 0; });
  const say = async (at = new Date()) => { const { announceDue } = await import("@/engine/alerts"); const a = await asOperator((c) => announceDue(c, fake, at, companyId)); await run(); return a; };
  const raiseOne = async (key: string, text: string) => { const { raise } = await import("@/engine/alerts"); await asOperator((c) => raise(c, { companyId, key, level: "error", source: "engine", text, href: "/app/c/mvs-a7" })); };

  it("nothing is posted by the engine itself: with no workflow listening the alert is only recorded", async () => {
    await raiseOne("x:quiet", "Something broke");
    expect(await say()).toEqual({ posted: 0, repeated: 0, resolved: 0 });
    expect(posts).toEqual([]);
  });

  it("the company's copy says it its own way, where it wants", async () => {
    await install("health-check", (d) => {
      const h = d.nodes.find((n) => n.id === "a_head")!; if (h.type === "set_var") h.pick = { ...h.pick, engine: "Heads up" };
      const p = d.nodes.find((n) => n.id === "a_post")!; if (p.type === "slack_post") { p.channel = "{{slack.channel.bookings}}"; p.template = "{{vars.head}}: {{vars.body}}"; }
    });
    await raiseOne("x:loud", "The CRM is slow");
    expect(await say()).toMatchObject({ posted: 1 });
    expect(posts).toEqual([expect.objectContaining({ channel: "CBOOK", text: "Heads up: The CRM is slow" })]);
    await asOperator((c) => c.query("update workflows set enabled=false where company_id=$1", [companyId]));
  });

  it("alerts.repeat_minutes decides when an open alert is said again; alerts.poll_failures how many failed polls make one", async () => {
    await install("health-check");
    await raiseOne("x:open", "Still broken");
    await say();
    expect(posts.map((p) => p.text)).toEqual([expect.stringMatching(/^🔴 \*Moves Co · Engine\*\nStill broken\n<https:\/\/engine\.test\/app\/c\/mvs-a7\|Open>$/)]);
    await asOperator((c) => c.query("update alerts set announced_at=now() - interval '31 minutes' where company_id=$1 and key='x:open'", [companyId]));
    expect(await say()).toMatchObject({ repeated: 0 });   // the default: an hour
    await asOperator((c) => c.query("insert into bindings (company_id,key,kind,value) values ($1,'alerts.repeat_minutes','number','30')", [companyId]));
    expect(await say()).toMatchObject({ repeated: 1 });
    expect(posts.at(-1)).toMatchObject({ threadTs: "ts1", text: expect.stringMatching(/^🔴 Still open after \d+ min: Still broken$/) });
    const { tickAlerts } = await import("@/engine/alerts");
    const poll = { companies: 1, contacts: 0, appointmentsNew: 0, appointmentsChanged: 0, inbound: 0, calls: 0, agreements: 0, cardsMoved: 0, eventsDispatched: 0, baselined: 0, errors: [] };
    const tk = { claimed: 0, completed: 0, waiting: 0, exited: 0, failed: 0, paused: 0, recovery: false, staleExits: 0, sends: 0 };
    await asOperator((c) => c.query("insert into poll_cursors (company_id, entity, cursor, consecutive_failures) values ($1,'contacts','0',2)", [companyId]));
    await asOperator((c) => c.query("insert into bindings (company_id,key,kind,value) values ($1,'alerts.poll_failures','number','3')", [companyId]));
    await asOperator((c) => tickAlerts(c, fake, poll, tk, new Date(), companyId));
    expect((await asOperator((c) => many<{ key: string }>(c, "select key from alerts where company_id=$1 and resolved_at is null", [companyId]))).map((a) => a.key)).not.toContain("poll:contacts");
    await asOperator((c) => c.query("update poll_cursors set consecutive_failures=3 where company_id=$1", [companyId]));
    await asOperator((c) => tickAlerts(c, fake, poll, tk, new Date(), companyId));
    expect((await asOperator((c) => many<{ key: string }>(c, "select key from alerts where company_id=$1 and resolved_at is null", [companyId]))).map((a) => a.key)).toContain("poll:contacts");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D88: the drift sweep's findings are events; its questions are worded by the workflow; its window is a setting (A6, B)", () => {
  const ago = (o: Record<string, number>) => DateTime.now().minus(o);
  let added: { id: string; when: DateTime }[] = [];
  const ghl = { contactsAdded: async () => added.map((a) => ({ id: a.id, firstName: a.id, tags: [], customFields: {}, dateAdded: a.when.toUTC().toISO()!, dateUpdated: a.when.toUTC().toISO()! })),
    wonCards: async () => [{ id: "W1", pipelineId: "P-C", status: "won", wonAt: ago({ days: 1 }).toUTC().toISO()!, contactId: "G-WON", contactName: "Wendy Won", contactTags: [] }],
    objectRecords: async (_c: unknown, key: string) => (key === "custom_objects.payment" ? [{ id: "PAY1", createdAt: ago({ days: 1 }).toISO()!, properties: { contact_id: "G-OTHER", amount: 100, type: "deposit", status: "succeeded", occurred_at: ago({ days: 40 }).toUTC().toISO() } }] : []),
    cards: async () => [], pipelines: async () => [], users: async () => [], getContact: async () => null, recordContact: async () => null, fieldCatalog: async () => [] };
  beforeAll(async () => { await migrate(); companyId = await freshCompany("mvs-a6"); await asOperator((c) => c.query("insert into bindings (company_id,key,kind,value) values ($1,'alerts.slack_channel','channel','CALERTS'),($1,'crm.pipeline_closer','id','P-C')", [companyId])); });
  beforeEach(() => { posts.length = 0; });
  const sweepWith = async (patch?: (d: Definition) => void) => {
    const { fakeProbes } = await import("@/engine/test-install");
    await asOperator((c) => c.query("update workflows set enabled=false where company_id=$1", [companyId]));
    const wf = await install("health-check", (d) => { const n = d.nodes.find((x) => x.type === "health_check")!; if (n.type === "health_check") n.checks = Object.fromEntries(["ghl_token", "ghl_calendars", "ghl_pipelines", "ghl_fields", "ghl_users", "slack", "steps", "urls", "anthropic", "duplicates"].map((k) => [k, false])); patch?.(d); });
    const { fireNow } = await import("@/engine/clock");
    await asOperator((c) => fireNow(c, companyId, wf));
    await tick(fake, undefined, companyId, { ...fakeProbes, ghl });
    const { announceDue } = await import("@/engine/alerts");
    await asOperator((c) => announceDue(c, fake, new Date(), companyId)); await tick(fake, undefined, companyId, { ...fakeProbes, ghl });
    return asOperator((c) => many<{ kind: string; count: number }>(c, "select data->>'kind' as kind, (data->>'count')::int as count from events where company_id=$1 and event_type='drift.found' order by id", [companyId]));
  };

  it("each kind of finding is one drift.found event; a won card with no payment is asked in the template's words; the window is the step's", async () => {
    added = [{ id: "G-NINE", when: ago({ days: 9 }) }];
    const found = await sweepWith();
    expect(found).toEqual([{ kind: "won_no_payment", count: 1 }]);   // nine days ago is outside the 7-day window
    expect(posts.find((p) => /match GHL/.test(p.text))!.text).toContain("One thing in the engine doesn't match GHL and I have a question about it:\n• Wendy Won: their closer card was won");
    await asOperator((c) => c.query("delete from events where company_id=$1 and event_type='drift.found'", [companyId]));
    await asOperator((c) => c.query("update alerts set resolved_at=now(), resolved_announced=true where company_id=$1", [companyId]));
    const wider = await sweepWith((d) => {
      const n = d.nodes.find((x) => x.type === "health_check")!; if (n.type === "health_check") n.drift_days = 10;
      const b = d.nodes.find((x) => x.id === "a_body")!; if (b.type === "set_var") b.else_value = String(b.else_value).replace("their closer card was won", "card won");
    });
    expect(wider).toEqual(expect.arrayContaining([{ kind: "pulled_in", count: 1 }, { kind: "won_no_payment", count: 1 }]));
    expect(posts.filter((p) => /match GHL/.test(p.text)).at(-1)!.text).toMatch(/• Wendy Won: card won \w{3} \w{3} \d{1,2}, but GHL has no payment/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D88: the health sweep's constants are the step's settings (B)", () => {
  beforeAll(async () => {
    await migrate(); companyId = await freshCompany("mvs-b");
    await asOperator(async (c) => {
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'secret.fathom_api_key','secret',$2),($1,'fathom.webhook_id','id','WH1')", [companyId, encrypt("fk")]);
      await c.query("insert into webhook_deliveries (company_id, provider, delivery_id, received_at) values ($1,'fathom','d-old', now() - interval '20 days')", [companyId]);
    });
  });
  it("fathom_silent_days: twenty quiet days are a warning at 14, nothing at 30", async () => {
    const { fakeProbes } = await import("@/engine/test-install");
    const { runHealthStep } = await import("@/engine/health");
    const sweep = (days?: number) => asOperator(async (c) => { const { row } = await loadCompany(c, companyId); return runHealthStep(c, row, fake, fakeProbes, { checks: { fathom_webhook: true }, min_slots: 0, slots_days: 7, ...(days ? { fathom_silent_days: days } : {}) }); });
    const fathom = (r: Awaited<ReturnType<typeof sweep>>) => r.findings.find((f) => f.check === "fathom_webhook")!;
    expect(fathom(await sweep())).toMatchObject({ ok: false, text: "No Fathom delivery in 20 days (Fathom does not list webhooks, so this is the only signal)." });
    expect(fathom(await sweep(30))).toMatchObject({ ok: true, text: "Last Fathom delivery 20 days ago." });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("the steps check reads an object named through a binding", () => {
  it("{{crm.object_sales_call}} is checked as the object it is bound to, not as the placeholder", async () => {
    await migrate(); companyId = await freshCompany("mvs-objref");
    await asOperator((c) => c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.object_sales_call','id',$2)", [companyId, Buffer.from("custom_objects.sales_call")]));
    await install("eod-call-filed");
    const { runHealthStep } = await import("@/engine/health");
    const { fakeProbes } = await import("@/engine/test-install");
    const run = (objects: { key: string }[]) => asOperator(async (c) => runHealthStep(c, (await loadCompany(c, companyId)).row, fake, { ...fakeProbes, ghlCatalog: async () => ({ users: [], pipelines: [], contactFields: [], opportunityFields: [], associations: [], objects, tags: [], errors: [] }) } as never, { checks: { steps: true } as never, min_slots: 0, slots_days: 7 } as never));
    const steps = (r: Awaited<ReturnType<typeof run>>) => r.findings.filter((f) => f.check === "steps" && !f.ok).map((f) => f.text);
    expect(steps(await run([{ key: "custom_objects.sales_call" }]))).toEqual([]);
    expect(steps(await run([])).join("\n")).toContain("writes custom_objects.sales_call, which no longer exists in the CRM");
    expect(steps(await run([])).join("\n")).not.toContain("{{");
  });
});
