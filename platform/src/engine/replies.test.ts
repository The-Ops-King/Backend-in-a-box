/**
 * D89: a reply is kept as "it came in" plus Jev's read, never its text. Driven through the real poll, dispatcher and runner against
 * Postgres; the fake GHL holds each message's words (`ghlMessages`) and hands them back by id, the way the engine now reads them.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { applyAppointment, pollAll } from "@/engine/poll";
import { loadCompany, persistedContext } from "@/engine/context";
import { tick } from "@/engine/runner";
import { encrypt } from "@/engine/crypto";
import { clearReplyTexts } from "@/engine/retention";
import { REDACTED, scrubReplyText } from "@/engine/replies";
import { fakeAdapters, ghlMessages } from "@/engine/test-install";
import type { Adapters, AppointmentSnapshot, Classification, ContactSnapshot, MessageSnapshot } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";
const SLUG = "replies";
const TABLES = ["alerts", "eod_reports", "slack_posts", "agreements", "sends", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "recordings", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"];
const CRM = { pipeline_closer: "PIPE-CLOSER", stage_closer_scheduled: "STAGE-SCHED", stage_closer_cancelled: "STAGE-C-CANCEL", default_closer: "U1" };

const crm = new Map<string, ContactSnapshot>();
const inbox: MessageSnapshot[] = [];
const apptStore = new Map<string, AppointmentSnapshot>();
const classified: string[] = [];
const posts: { channel: string; text: string }[] = [];
let intent = "confirmed";
const base = fakeAdapters();
const fake: Adapters = {
  ...base,
  read: { ...base.read, listUsers: async () => [{ id: "U1", name: "Sam Closer", email: "sam@x.com" }], getContact: async (_c, id) => crm.get(id) ?? null,
    inboundSince: async (c) => (c.id === companyId ? inbox.splice(0) : []) },
  booking: (() => { const b = { appointmentsInWindow: async () => [], listCalendars: async () => [{ id: "CAL", name: "Closer Call", teamMemberIds: ["U1"] }], getAppointment: async (_c: unknown, id: string) => apptStore.get(id) ?? null }; return { ghl: b, calendly: b }; })(),
  classifier: { choice: async (_s, input): Promise<Classification> => {
    classified.push(input);
    return intent === "unclear" ? { value: "unclear", confidence: 0.41, distribution: { cancelled: 0.41, confirmed: 0.3 }, unclear: true, ambiguity: 0.9 } : { value: intent, confidence: 0.8, distribution: { [intent]: 0.8, question: 0.1 }, unclear: false, ambiguity: 0.1 }; } },
  notifier: { ...base.notifier, post: async (_t, channel, text) => { posts.push({ channel, text }); return { ts: `ts${posts.length}` }; } },
};
let companyId: string;

const wipe = () => asOperator(async (c) => {
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [SLUG]); if (!co) return;
  await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
  await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
  await c.query("update appointments set disposition_id=null where company_id=$1", [co.id]);
  for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
  await c.query("delete from companies where id=$1", [co.id]);
});
/** A person with a closing call three days out, booked as the poll would record it; the pre-call sequence starts and parks on the reply wait. */
const booked = async (ghl: string) => {
  const s: ContactSnapshot = { id: ghl, firstName: ghl, phone: `+1602555${String(crm.size).padStart(4, "0")}`, email: `${ghl.toLowerCase()}@x.com`, tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString() };
  crm.set(ghl, s);
  // 60 hours out at any time of day: the 72-hour reminder is already behind it, the 48-hour one ahead (3 days out at 2pm put it either side of 72 hours by the clock)
  const start = DateTime.now().setZone(TZ).plus({ hours: 60 }).startOf("minute");
  const appt: AppointmentSnapshot = { id: `A-${ghl}`, calendarId: "CAL", contactId: ghl, assignedUserId: "U1", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), raw: {} };
  apptStore.set(appt.id, appt);
  await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, appt); });
  await tick(fake, undefined, companyId);
  const contactId = (await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id=$2", [companyId, ghl])))!.id;
  const run = (await runOf(contactId))!;
  expect(run).toMatchObject({ status: "waiting", current_node: "w1" });
  return { contactId, runId: run.id };
};
type Run = { id: string; status: string; current_node: string | null; next_run_at: Date | null; step_attempt: number; context: Record<string, unknown> };
const wake = (runId: string) => asOperator((c) => c.query("update runs set next_run_at=now() where id=$1", [runId]));
const runOf = (contactId: string) => asOperator((c) => one<Run>(c, "select r.id, r.status, r.current_node, r.next_run_at, r.step_attempt, r.context from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where r.company_id=$1 and r.contact_id=$2 and t.slug='pre-call-sequence' order by r.started_at desc limit 1", [companyId, contactId]));
/** They text back: GHL has the message, the poll brings it in. */
const reply = (ghl: string, text: string, at = new Date()) => { const id = `msg-${ghl}-${Math.random().toString(36).slice(2, 8)}`; ghlMessages.texts.set(id, text); inbox.push({ id, conversationId: `conv-${ghl}`, contactId: ghl, channel: "sms", direction: "inbound", body: text, dateAdded: at.toISOString() }); return pollAll(fake); };
/** Every place the engine persists what happened, as text, for this company: the words must be in none of them. */
const ledgerText = (contactId: string) => asOperator(async (c) => ({
  messages: JSON.stringify(await many(c, "select * from messages where company_id=$1 and contact_id=$2", [companyId, contactId])),
  runs: JSON.stringify(await many(c, "select context from runs where company_id=$1 and contact_id=$2", [companyId, contactId])),
  run_steps: JSON.stringify(await many(c, "select s.result, s.error from run_steps s join runs r on r.id=s.run_id where r.company_id=$1 and r.contact_id=$2", [companyId, contactId])),
  events: JSON.stringify(await many(c, "select data from events where company_id=$1 and contact_id=$2", [companyId, contactId])),
}));
const eventsOf = (contactId: string, type: string) => asOperator((c) => many<{ data: Record<string, unknown> }>(c, "select data from events where company_id=$1 and contact_id=$2 and event_type=$3 order by id", [companyId, contactId, type])).then((r) => r.map((x) => x.data));

describe("D89: scrubbing a reply's words out of what a step leaves behind", () => {
  it("replaces each whole text and a preview cut inside one; the shape and everything else stay", () => {
    const texts = ["I need to cancel my appointment", "sorry"];
    expect(scrubReplyText({ would_post: "❌ Kai's call is cancelled.\n> I need to cancel my appointment", n: 3, list: ["sorry!", null] }, texts))
      .toEqual({ would_post: `❌ Kai's call is cancelled.\n> ${REDACTED}`, n: 3, list: [`${REDACTED}!`, null] });
    expect(scrubReplyText({ would_post: "✅ confirmed.\n> I need to can" }, texts)).toEqual({ would_post: `✅ confirmed.\n> ${REDACTED}` });   // cut at 160
    expect(scrubReplyText({ v: "I need to can" }, texts, { cut: false })).toEqual({ v: "I need to can" });
    expect(scrubReplyText({ v: "nothing of theirs" }, [])).toEqual({ v: "nothing of theirs" });
  });

  it("a run's saved reply keeps the ids, the count and Jev's read, never the words", () => {
    const ctx = { reply: { intent: "cancelled", intent_confidence: 95, top_guesses: "cancelled 95%", count: 2, message_ids: ["a", "b"], inbound_since_send: "can't\nmake it", last_inbound: { message_id: "b", at: "t", body: "make it", subject: "s" } } };
    expect(persistedContext(ctx)).toEqual({ reply: { intent: "cancelled", intent_confidence: 95, top_guesses: "cancelled 95%", count: 2, message_ids: ["a", "b"], last_inbound: { message_id: "b", at: "t" } } });
  });
});

describe.skipIf(!HAS_DB)("D89: a reply is kept as 'it came in' plus Jev's read", () => {
  beforeAll(async () => {
    await migrate();
    await wipe();
    const r = await installCompany({ name: "Replies", slug: SLUG, timezone: TZ, locationId: "LOC-REPLIES", pit: "pit-fake", calendars: { CAL: "closing" }, enable: true, templates: ["pre-call-sequence"], crm: CRM, anthropicKey: "sk-fake", contractValueDefault: 2999 }, fake);
    companyId = r.companyId;
    await asOperator(async (c) => {
      await c.query("update companies set mode='live', send_window_start='00:00', send_window_end='23:59', sms_enabled=true where id=$1", [companyId]);
      // the baseline poll already happened: from here a poll brings deltas
      for (const entity of ["contacts", "conversations"]) await c.query("insert into poll_cursors (company_id, entity, cursor, last_polled_at, last_success_at) values ($1,$2,$3,now(),now())", [companyId, entity, DateTime.now().minus({ hours: 1 }).toISO()]);
    });
  });

  it("a reply wakes the waiting run and is classified from GHL's words, read by id; no message row, run, step or event keeps them; Jev's read is kept on the run and the event", async () => {
    intent = "confirmed";
    const { contactId, runId } = await booked("CRAY");
    const reads = ghlMessages.reads.length;
    expect((await reply("CRAY", "yes see you then")).inbound).toBe(1);
    // the poll kept that it came in, not what it said, and woke the run on its reply wait
    const row = await asOperator((c) => one<Record<string, unknown>>(c, "select body, subject, channel, direction, ghl_conversation_id from messages where company_id=$1 and contact_id=$2", [companyId, contactId]));
    expect(row).toEqual({ body: null, subject: null, channel: "sms", direction: "inbound", ghl_conversation_id: "conv-CRAY" });
    expect((await runOf(contactId))!.next_run_at!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await eventsOf(contactId, "message.received")).toEqual([{ channel: "sms", message_id: expect.stringMatching(/^msg-CRAY-/) }]);
    // a second piece while they type; the reply settles (D47), then Jev reads both pieces as one, from GHL
    await reply("CRAY", "🙏");
    await tick(fake, undefined, companyId);
    expect(classified).not.toContain("yes see you then\n🙏");
    expect(ghlMessages.reads.length).toBe(reads);   // waiting out the settle reads nothing
    await wake(runId); await tick(fake, DateTime.now().plus({ minutes: 2 }), companyId);
    expect(classified.at(-1)).toBe("yes see you then\n🙏");
    expect(ghlMessages.reads.slice(reads)[0]).toHaveLength(2);   // both pieces, in one read
    const run = (await runOf(contactId))!;
    expect(run).toMatchObject({ status: "waiting", current_node: "r48" });
    expect(run.context.reply).toMatchObject({ intent: "confirmed", confidence: 0.8, intent_confidence: 80, top_guesses: "confirmed 80%, question 10%", count: 2 });
    expect(await eventsOf(contactId, "reply.classified")).toEqual([{ intent: "confirmed", confidence: 0.8, unclear: false, top_guesses: "confirmed 80%, question 10%", ambiguity: 0.1, input_chars: "yes see you then\n🙏".length }]);
    // the confirmed line quoted the reply: Slack is not connected, so the step says what it would have posted, without their words
    const conf = await asOperator((c) => one<{ result: Record<string, unknown> }>(c, "select result from run_steps where run_id=$1 and node_id='n_conf_slack'", [runId]));
    expect(conf!.result.would_post).toMatch(new RegExp(`> ${REDACTED.replace(/[[\]]/g, "\\$&")}$`));
    const ledger = await ledgerText(contactId);
    for (const [where, text] of Object.entries(ledger)) for (const words of ["yes see you then", "see you", "🙏"]) expect(text.includes(words), `${where} holds "${words}"`).toBe(false);
  });

  it("unsure: the closer is asked with the words read from GHL and Jev's guesses; the question waits for its tap; Jev's read is on the appointment and the run, the words nowhere", async () => {
    intent = "unclear";
    await asOperator(async (c) => {
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'TREP',$2,'{}')", [companyId, encrypt("xoxb-fake")]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'slack.channel.bookings','channel',$2)", [companyId, Buffer.from("CBOOK")]);
    });
    const { contactId, runId } = await booked("CMAY");
    await reply("CMAY", "hmm maybe idk");
    const n = posts.length;
    await tick(fake, DateTime.now().plus({ minutes: 2 }), companyId);
    const asked = posts.slice(n).filter((p) => /replied to the booking text/.test(p.text));
    expect(asked).toHaveLength(1);
    expect(asked[0].text).toMatch(/Jev couldn't tell what they meant \(its guesses: cancelled 41%, confirmed 30%\)\.\n\*We sent:\*\n> .*\n\*They wrote:\*\n> hmm maybe idk\n/);
    const run = (await runOf(contactId))!;
    expect(run).toMatchObject({ status: "waiting", current_node: "r48" });   // the reminders go on, the question listens (D58)
    expect((run.context.vars as Record<string, unknown>).__listen).toMatchObject({ node: "w_dec" });
    expect(run.context.reply).toMatchObject({ intent: "unclear", intent_confidence: 41, top_guesses: "cancelled 41%, confirmed 30%" });
    const appt = await asOperator((c) => one<{ pending_read: Record<string, unknown> }>(c, "select a.pending_read from appointments a join runs r on r.appointment_id=a.id where r.id=$1", [runId]));
    expect(appt!.pending_read).toMatchObject({ intent: "unclear", confidence: 41 });
    expect(await eventsOf(contactId, "reply.classified")).toEqual([expect.objectContaining({ intent: "unclear", confidence: 0.41, unclear: true, top_guesses: "cancelled 41%, confirmed 30%", input_chars: 13 })]);
    const ledger = await ledgerText(contactId);
    for (const [where, text] of Object.entries(ledger)) expect(text.includes("maybe idk"), `${where} holds the reply`).toBe(false);
    intent = "confirmed";
  });

  it("GHL down when the words are needed: Jev is not asked with an empty text; the step is retried in place and reads them when GHL answers", async () => {
    intent = "cancelled";
    const { contactId } = await booked("CZOE");
    await reply("CZOE", "cancel please");
    const n = classified.length;
    ghlMessages.down = true;
    try {
      await tick(fake, DateTime.now().plus({ minutes: 2 }), companyId);
      let run = (await runOf(contactId))!;
      expect(run).toMatchObject({ status: "waiting", current_node: "c1", step_attempt: 1 });   // D66: retried on the very step
      expect(classified.length).toBe(n);                                                      // never classified an empty text
      expect(await eventsOf(contactId, "reply.classified")).toEqual([]);
      const failed = await asOperator((c) => one<{ status: string; result: Record<string, unknown>; error: string }>(c, "select s.status, s.result, s.error from run_steps s where s.run_id=$1 and s.node_id='c1'", [run.id]));
      expect(failed).toMatchObject({ status: "failed", result: { attempt: 1, class: "transient", vendor: "ghl" }, error: expect.stringMatching(/^GHL 503/) });
      // still down at the next try
      await asOperator((c) => c.query("update runs set next_run_at=now() where id=$1", [run.id]));
      await tick(fake, DateTime.now().plus({ minutes: 4 }), companyId);
      run = (await runOf(contactId))!;
      expect(run).toMatchObject({ current_node: "c1", step_attempt: 2 }); expect(classified.length).toBe(n);
      ghlMessages.down = false;
      await asOperator((c) => c.query("update runs set next_run_at=now() where id=$1", [run.id]));
      await tick(fake, DateTime.now().plus({ minutes: 10 }), companyId);
    } finally { ghlMessages.down = false; }
    expect(classified.slice(n)).toEqual(["cancel please"]);
    expect(await eventsOf(contactId, "reply.classified")).toEqual([expect.objectContaining({ intent: "cancelled", input_chars: 13 })]);
    expect((await runOf(contactId))!.context.reply).toMatchObject({ intent: "cancelled", intent_confidence: 80 });
    for (const [where, text] of Object.entries(await ledgerText(contactId))) expect(text.includes("cancel please"), `${where} holds the reply`).toBe(false);
    intent = "confirmed";
  });

  it("the one-time cleanup: a dry run counts and writes nothing; the real one takes the words out of messages, runs, events and step results and keeps Jev's read; a rerun changes nothing", async () => {
    const { contactId, runId } = await booked("COLD");
    // what the engine kept before D89
    await asOperator(async (c) => {
      await c.query("insert into messages (company_id, contact_id, ghl_message_id, channel, direction, body, subject, occurred_at) values ($1,$2,'old-1','sms','inbound','old words here',null,now()-interval '1 hour'),($1,$2,'old-2','email','inbound',null,'Re: your call',now())", [companyId, contactId]);
      await c.query("update runs set context = context || $2::jsonb where id=$1", [runId, JSON.stringify({ reply: { intent: "confirmed", intent_confidence: 90, count: 1, inbound_since_send: "old words here", last_inbound: { body: "old words here", at: "x" } } })]);
      await c.query("insert into events (company_id, contact_id, event_type, source, data, occurred_at) values ($1,$2,'message.received','ghl_poll',$3,now()),($1,$2,'reply.classified','engine',$4,now())", [companyId, contactId, { channel: "sms", message_id: "old-1", body: "old words here" }, { intent: "confirmed", confidence: 0.9, unclear: false, input: "old words here" }]);
      await c.query("insert into run_steps (run_id, node_id, node_type, status, result, finished_at) values ($1,'n_conf_slack','slack_post','skipped',$2,now())", [runId, { kind: "blocked", would_post: "✅ COLD's call is confirmed.\n> old words here" }]);
    });
    const dry = await clearReplyTexts({ companyId });
    expect(dry).toEqual({ dryRun: true, messages: 2, runs: 1, events: 2, run_steps: 1 });
    expect((await ledgerText(contactId)).messages).toContain("old words here");   // nothing written
    const real = await clearReplyTexts({ companyId, dryRun: false });
    expect(real).toEqual({ dryRun: false, messages: 2, runs: 1, events: 2, run_steps: 1 });
    const ledger = await ledgerText(contactId);
    for (const [where, text] of Object.entries(ledger)) { expect(text.includes("old words"), `${where} holds the reply`).toBe(false); expect(text.includes("Re: your call"), `${where} holds the subject`).toBe(false); }
    expect((await runOf(contactId))!.context.reply).toEqual({ intent: "confirmed", intent_confidence: 90, count: 1, last_inbound: { at: "x" } });
    expect(await eventsOf(contactId, "reply.classified")).toEqual([{ intent: "confirmed", confidence: 0.9, unclear: false, input_chars: 14 }]);
    expect(await eventsOf(contactId, "message.received")).toEqual([{ channel: "sms", message_id: "old-1" }]);
    expect(await asOperator((c) => many(c, "select ghl_message_id from messages where company_id=$1 and contact_id=$2 order by ghl_message_id", [companyId, contactId]))).toEqual([{ ghl_message_id: "old-1" }, { ghl_message_id: "old-2" }]);   // "it came in" stays
    expect(await clearReplyTexts({ companyId, dryRun: false })).toEqual({ dryRun: false, messages: 0, runs: 0, events: 0, run_steps: 0 });
  });
});
