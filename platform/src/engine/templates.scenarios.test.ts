/** Every shipped template driven through the real engine against Postgres with fake adapters. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, db, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { installCompany } from "@/engine/install";
import { emitEvent, dispatchEvent } from "@/engine/dispatch";
import { applyAppointment } from "@/engine/poll";
import { applyPayment } from "@/engine/lifecycle";
import { recordDisposition } from "@/engine/disposition";
import { loadCompany } from "@/engine/context";
import { tick } from "@/engine/runner";
import { replicaSnapshot } from "@/engine/test-install";
import type { Adapters, AppointmentSnapshot, Classification, BookingRead } from "@/adapters/types";
import { recordRecording, linkRecording, recordPhoneCall, settlePhoneCall, phoneFacts, type RecordingInput } from "@/engine/recordings";
import { simulate } from "@/engine/simulate";
import { reactionArrived } from "@/engine/webhooks/slack";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";
const sent: { kind: string; to: string; body: string }[] = [];
const tags: string[] = [];
const oppWrites: Record<string, unknown>[] = [];
const contactWrites: Record<string, unknown>[] = [];
const tasks: Record<string, unknown>[] = [];
const removedTags: string[] = [];
let liveStatus = "confirmed";
const apptStore = new Map<string, AppointmentSnapshot>();   // what GHL "has" for each appointment the tests book
const recordWrites: Record<string, unknown>[] = [];
const relations: string[] = [];
const docSends: { templateId: string; contactId: string; userId?: string }[] = [];
const liveCards = new Map<string, import("@/adapters/types").LiveCard[]>();   // what the CRM "has" for a contact: cards the engine never made (D41)
const fake: Adapters = {
  read: {
    contactsChangedSince: async () => [], openCards: async (_c, id) => liveCards.get(id) ?? [], pipelineCards: async (_c, pipelineId) => [...liveCards.entries()].flatMap(([cid, cards]) => cards.filter((k) => k.pipelineId === pipelineId).map((k) => ({ ...k, contactId: cid }))), inboundSince: async () => [], callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [],
    getContact: async (c, id) => (await replicaSnapshot(c.id, id)) ?? { id, firstName: id, email: `${id.toLowerCase()}@x.com`, phone: phoneFor(id), tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString() },
    listUsers: async () => [{ id: "U1", name: "Sam Closer", email: "sam@x.com" }],
  },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [],
    getAppointment: async (_c, id) => { const a = apptStore.get(id); return a ? { ...a, status: liveStatus } : null; },
    listCalendars: async () => [{ id: "CAL", name: "Closer Call", teamMemberIds: ["U1"] }] }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async (_c, _id, t) => { tags.push(t); }, removeTag: async (_c, _id, t) => { removedTags.push(t); }, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async (_c, id, patch) => { contactWrites.push({ id, ...patch }); }, createTask: async (_c, id, task) => { tasks.push({ contactId: id, ...task }); return { id: `task-${tasks.length}` }; }, createRecord: async (_c, _o, props) => { recordWrites.push({ op: "create", ...props }); return { id: `rec-${recordWrites.length}` }; }, updateRecord: async (_c, _o, id, props) => { recordWrites.push({ op: "update", id, ...props }); }, relateRecords: async (_c, a, f, s) => { relations.push(`${a}:${f}>${s}`); },
    createOpportunity: async (_c, input) => { oppWrites.push({ op: "create", ...input }); return { id: `ghl-opp-${oppWrites.length}` }; },
    updateOpportunity: async (_c, id, patch) => { oppWrites.push({ op: "update", id, ...patch }); }, sendDocumentTemplate: async (_c, input) => { docSends.push(input); return { id: `doc-${docSends.length}` }; } },
  sender: {
    sendSms: async (_c, to, body) => { sent.push({ kind: "sms", to, body }); return { externalId: `s${sent.length}`, accepted: true }; },
    sendEmail: async (_c, to, subject, html) => { sent.push({ kind: "email", to, body: `${subject}|${html}` }); return { externalId: `e${sent.length}`, accepted: true }; },
    deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null,
  },
  classifier: { choice: async (_s, _input, options): Promise<Classification> => {   // Jev, faked by vocabulary (D48)
    const value = options.includes("setting") ? setterCallType : options.includes("sales_call") ? (salesCall ? "sales_call" : "other") : options.includes("closed_won") ? "closed_won" : replyIntent;
    return { value, confidence: 0.95, distribution: { [value]: 0.95 }, unclear: false }; } },
  notifier: { post: async (_t, channel, text, _as, threadTs) => { slackPosts.push({ channel, text, threadTs }); return { ts: `ts${slackPosts.length}` }; }, lookupUserByEmail: async () => null, react: async (_t, _ch, ts, emoji) => { reacted.push(`${ts}:${emoji}`); return true; }, unreact: async (_t, _ch, ts, emoji) => { unreacted.push(`${ts}:${emoji}`); return true; }, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
  // answers by which prompt is asked, the way the real model would: classify → is it a sales call, notes → the write-up, rubric → the score
  analyst: { analyze: async (_k, req) => { analyses.push(req.system.slice(0, 40)); const parsed = /setters and leads/.test(req.system) ? { call_type: setterCallType, confidence: 0.9, reason: "qualifying toward a booking" }
    : /setter phone calls/.test(req.system) ? { summary: "Thinning for a year, wants it handled; asked about price and took Thursday at two.", pains: "getting worse for about a year", goals: "feel like himself again", triage: "", fit_quality: 8, digest: "Thinning for a year, wants it handled; asked about price and took Thursday at two.\nPains: getting worse for about a year\nGoals: feel like himself again\nFit: 8/10 — named the problem, a timeline and asked about price" }
    : /sales call:/.test(req.system) ? { is_sales_call: salesCall, call_kind: "closing", confidence: 0.96, reason: "prospect discussed buying" }
    : /note-taker/.test(req.system) ? { notes: { summary: "Wants to fix thinning; decided to start.", pain: ["thinning at the crown"], objections: [{ objection: "price", quote: "that is a lot right now", handled: true }], disposition: "closed_won", primary_objection: "price", next_step: "onboarding call", quotes: ["I just want it to stop"] },
        rubric: { overall_score: 8, scores: { discovery: 9 }, strengths: ["asked about timeline"], misses: ["no urgency close"], coaching: ["ask for the card earlier"] } }   // one read: notes and scorecard together (D41)
    : { overall_score: 8, scores: { discovery: 9 }, strengths: ["asked about timeline"], misses: ["no urgency close"], coaching: ["ask for the card earlier"] };
    return { text: JSON.stringify(parsed), parsed, model: "fake", usage: { input: 1000, output: 100, cacheRead: 0 } }; } },
};
const analyses: string[] = [];
const slackPosts: { channel: string; text: string; threadTs?: string }[] = [];   // every message is its own ts, as in Slack
const unreacted: string[] = [];
const reacted: string[] = [];
let salesCall = true;
let replyIntent = "confirmed";
let setterCallType = "setting";
const since = () => sent.length;
const bySlug = (slug: string) => asOperator((c) => one<{ id: string }>(c, "select w.id from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug=$2", [companyId, slug]));
const runsFor = (slug: string) => asOperator((c) => many<{ id: string; status: string; current_node: string | null; exit_reason: string | null; next_run_at: Date | null; contact_id: string }>(c, "select r.id, r.status, r.current_node, r.exit_reason, r.next_run_at, r.contact_id from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug=$2 order by r.started_at", [companyId, slug]));
const wake = (runId: string) => asOperator((c) => c.query("update runs set next_run_at=now() where id=$1", [runId]));
/** A timed wait is re-evaluated on wake, so making time pass means moving its pinned answer into the past (what the clock would do). */
const expireWait = (runId: string, nodeId: string) => asOperator((c) => c.query("update runs set next_run_at=now(), context = jsonb_set(context, $2::text[], to_jsonb($3::text), true) where id=$1",
  [runId, `{vars,__wait,${nodeId},until}`, new Date(Date.now() - 60e3).toISOString()]));
/** Make a wait_for_reply deadline already past, as a real ISO string (what the engine itself stores). */
const expireReplyWait = (runId: string, nodeId: string) => asOperator((c) => c.query("update runs set next_run_at=now(), context = jsonb_set(context, $2::text[], to_jsonb($3::text), true) where id=$1",
  [runId, `{vars,__wait_for_reply,${nodeId},deadline}`, new Date(Date.now() - 60e3).toISOString()]));
/** A fixture contact has a phone unless a scenario says `null`: a text goes only to a number the replica knows (G11, D60). Derived from the id so the number is stable and never collides with the explicit +1602… ones. */
const phoneFor = (ghlId: string) => `+1480${String([...ghlId].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 10_000_000, 7)).padStart(7, "0")}`;
const newContact = async (ghlId: string, email: string, phone: string | null = phoneFor(ghlId)) => asOperator(async (c) => {
  const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, timezone) values ($1,$2,$3,$4) returning id", [companyId, ghlId, ghlId, TZ]))!.id;
  await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [companyId, id, email]);
  if (phone) await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone',$3)", [companyId, id, phone]);
  return id;
});
const withPhone = (contactId: string, phone: string) => asOperator((c) => c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone',$3)", [companyId, contactId, phone]));
const inbound = (contactId: string, body: string) => asOperator((c) => c.query("insert into messages (company_id, contact_id, ghl_message_id, channel, direction, body, occurred_at) values ($1,$2,$3,'sms','inbound',$4,now())", [companyId, contactId, `m${Math.random()}`, body]));
let companyId: string;
/** A closing call five days out for a new contact, as the poll would record it. */
const bookClosing = async (ghl: string) => {
  const id = await newContact(ghl, `${ghl.toLowerCase()}@x.com`);
  const start = DateTime.now().setZone(TZ).plus({ days: 5 }).set({ hour: 13, minute: 0, second: 0, millisecond: 0 });   // 1pm their time: the morning-of reminder comes before the call
  const snap: AppointmentSnapshot = { id: `A${ghl}`, calendarId: "CAL", contactId: ghl, assignedUserId: "U1", startTime: start.toISO()!, endTime: start.plus({ minutes: 30 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), raw: {} };
  apptStore.set(snap.id, snap);
  await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, snap); });
  return id;
};
const preCallRunOf = async (contactId: string) => (await asOperator((c) => many<{ id: string; status: string; current_node: string | null; exit_reason: string | null; next_run_at: Date | null; contact_id: string; appointment_id: string }>(c, "select r.id, r.status, r.current_node, r.exit_reason, r.next_run_at, r.contact_id, r.appointment_id from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where r.company_id=$1 and t.slug='pre-call-sequence' and r.contact_id=$2 order by r.started_at", [companyId, contactId]))).at(-1)!;
/** The question a run put to the team (its decision:<appointment> post). */
const questionOf = async (runId: string) => (await asOperator((c) => one<{ tag: string; ts: string }>(c, "select tag, ts from slack_posts where company_id=$1 and run_id=$2 and tag like 'decision:%'", [companyId, runId])))!;
/** Tyler taps a reaction on a Slack post, as the Slack door would deliver it. */
const tap = (ts: string, reaction: string) => asOperator(async (c) => reactionArrived(c, companyId, { kind: "reaction", eventId: `Ev${ts}${reaction}`, user: "UTYLER", reaction, channel: (await one<{ channel: string }>(c, "select channel from slack_posts where company_id=$1 and ts=$2", [companyId, ts]))?.channel ?? "CBOOK", ts, removed: false }));
const apptStatus = async (runId: string) => (await asOperator((c) => one<{ status: string }>(c, "select a.status from appointments a join runs r on r.appointment_id=a.id where r.id=$1", [runId])))!.status;
/** What the person decided against what Jev read (D55), oldest first. */
const reviewed = (contactId: string, type = "intent.reviewed") => asOperator((c) => many<Record<string, unknown>>(c, "select data from events where company_id=$1 and contact_id=$2 and event_type=$3 order by id", [companyId, contactId, type])).then((rows) => rows.map((r) => r.data));
/** The contact's tags as our replica has them (the CRM's tags, D50). */
const tagsOn = async (contactId: string) => (await asOperator((c) => one<{ tags: string[] }>(c, "select tags from contacts where id=$1", [contactId])))!.tags;
/** The listener a run carries (D58) and where the engine will put it back. */
const listenerOn = (runId: string) => asOperator((c) => one<{ wake_on_tag: string | null; resume_node: string | null; listen: Record<string, unknown> | null }>(c, "select wake_on_tag, resume_node, context->'vars'->'__listen' as listen from runs where id=$1", [runId]));
const pendingRead = async (runId: string) => (await asOperator((c) => one<{ pending_read: Record<string, unknown> | null }>(c, "select a.pending_read from appointments a join runs r on r.appointment_id=a.id where r.id=$1", [runId])))!.pending_read;

describe.skipIf(!HAS_DB)("template scenarios", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='scn'");
      if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        await c.query("update appointments set disposition_id=null where company_id=$1", [co.id]);
        for (const t of ["agreements", "sends", "runs", "events", "slack_connections", "slack_posts", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "recordings", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]); }
    });
    const r = await installCompany({ name: "Scenarios", slug: "scn", timezone: TZ, locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" }, enable: true,
      crm: { pipeline_setter: "PIPE-SETTER", stage_setter_new_lead: "STAGE-NEW", field_opportunity_stage_entered: "CF-STAGE-DATE", pipeline_closer: "PIPE-CLOSER", stage_setter_direct_booked: "STAGE-DIRECT", stage_setter_appointment_set: "STAGE-SET", stage_closer_scheduled: "STAGE-SCHED", stage_setter_cancelled: "STAGE-S-CANCEL", stage_closer_cancelled: "STAGE-C-CANCEL", field_contact_appointment_date: "CF-APPT-DATE", field_contact_setter: "CF-SETTER", field_opportunity_setter_owner: "CF-SETTER-OWNER", assoc_discovery_call_contact: "ASSOC-DC", agreement_template: "TPL-AGREE", agreement_sender: "U1", default_closer: "U1", stage_closer_agreement_sent: "STAGE-AGREE", stage_closer_closed_won: "STAGE-WON", stage_closer_follow_up: "STAGE-FOLLOWUP", stage_closer_lost: "STAGE-LOST", stage_closer_disqualified: "STAGE-DQ",
        field_contact_cash_collected: "CF-CASH", field_contact_revenue_generated: "CF-REV", assoc_payment_contact: "ASSOC-PC", assoc_payment_opportunity: "ASSOC-PO",
        stage_setter_showed: "STAGE-SHOWED", assoc_sales_call_contact: "ASSOC-SC", assoc_sales_call_opportunity: "ASSOC-SO" }, contractValueDefault: 2999, anthropicKey: "sk-ant-fake" }, fake);
    companyId = r.companyId;
    // the fixture sets the flag itself: the only real way to live is goLive (D56), which wants Slack connected, and these scenarios assert what happens while it is not
    await asOperator((c) => c.query("update companies set mode='live', send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId]));
    // (ticks below are scoped to this company: the test database is shared with the other suites)
    // the test database is shared with the other suites; park their leftover runs so this file's ticks only ever send for this company
    expect(r.installed.filter((s) => s.endsWith("enabled"))).toHaveLength(23);
  });

  it("speed-to-lead: email + SMS now; a reply → tag engaged; silence → second email", async () => {
    const a = await newContact("CA", "a@x.com"), b = await newContact("CB", "b@x.com");
    await asOperator(async (c) => { for (const id of [a, b]) await dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "form", data: {} }), { contact: { id } }); });
    const n = since(); await tick(fake, undefined, companyId);
    expect(sent.slice(n).map((s) => s.kind).sort()).toEqual(["email", "email", "sms", "sms"]);
    let rs = await runsFor("speed-to-lead"); expect(rs.map((r) => r.current_node)).toEqual(["n3", "n3"]);
    // both runs were inserted in one transaction and share started_at, so never rely on rs[0]/rs[1] order: pick by contact
    const runA = rs.find((r) => r.contact_id === a)!, runB = rs.find((r) => r.contact_id === b)!;
    await inbound(a, "yes let's talk"); await wake(runA.id);
    await expireReplyWait(runB.id, "n3");
    const n2 = since(); await tick(fake, DateTime.now().plus({ minutes: 2 }), companyId);   // past the 90 s settle window for the rest of a reply (D47)
    rs = await runsFor("speed-to-lead");
    expect(rs.find((r) => r.contact_id === a)?.exit_reason).toBe("replied");
    expect(rs.find((r) => r.contact_id === b)?.exit_reason).toBe("no_reply"); expect(sent.slice(n2).map((s) => s.body)).toEqual([expect.stringMatching(/^Still want to talk/)]);
  });

  it("cancellation-rebook: GHL status → cancelled starts it; sends both, exits", async () => {
    const snap = (status: string): AppointmentSnapshot => ({ id: "ACX", calendarId: "CAL", contactId: "CCX", assignedUserId: "U1", startTime: DateTime.now().plus({ days: 3 }).toISO()!, endTime: DateTime.now().plus({ days: 3, minutes: 30 }).toISO()!, status, dateAdded: new Date().toISOString(), raw: {} });
    apptStore.set("ACX", snap("cancelled")); liveStatus = "cancelled";   // GHL really reports it cancelled; the premise check must NOT treat that as moot here
    await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, snap("confirmed")); await applyAppointment(c, row, adapterCompany, fake, snap("cancelled")); });
    expect(await runsFor("cancellation-rebook")).toHaveLength(1);
    await tick(fake, undefined, companyId); liveStatus = "confirmed";   // booking-confirmation also fires on the booking; assert on this run's own sends, not the global list
    const r = (await runsFor("cancellation-rebook"))[0];
    const mine = await asOperator((c) => many<{ channel: string; rendered_body: string }>(c, "select channel, rendered_body from sends where run_id=$1 and status='sent' order by channel", [r.id]));
    expect(mine.map((s) => s.channel)).toEqual(["email", "sms"]);
    expect(mine.find((s) => s.channel === "sms")?.rendered_body).toMatch(/cancelled.*widget\/booking\/CAL/);
    expect(r.exit_reason).toBe("sent");
  });

  it("no-show-recovery: GHL no-show → 10 min → SMS + email → 24h for a reply → second email", async () => {
    liveStatus = "noshow";
    const snap = (status: string): AppointmentSnapshot => ({ id: "ANS", calendarId: "CAL", contactId: "CNS", assignedUserId: "U1", startTime: DateTime.now().minus({ hours: 1 }).toISO()!, endTime: DateTime.now().minus({ minutes: 30 }).toISO()!, status, dateAdded: new Date().toISOString(), raw: {} });
    apptStore.set("ANS", snap("noshow"));
    await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, snap("confirmed")); await applyAppointment(c, row, adapterCompany, fake, snap("noshow")); });
    let r = (await runsFor("no-show-recovery"))[0]; expect(r).toBeTruthy();
    await tick(fake, undefined, companyId); r = (await runsFor("no-show-recovery"))[0]; expect(r.status).toBe("waiting"); expect(r.current_node).toBe("n1");
    await expireWait(r.id, "n1"); const n = since(); await tick(fake, undefined, companyId);
    expect(sent.slice(n).map((s) => s.kind).sort()).toEqual(["email", "sms"]);
    expect(sent.slice(n).find((s) => s.kind === "sms")?.body).toMatch(/missed each other.*Sam/);
    r = (await runsFor("no-show-recovery"))[0]; expect(r.current_node).toBe("n4");
    await expireReplyWait(r.id, "n4");
    const n2 = since(); await tick(fake, undefined, companyId);
    expect(sent.slice(n2).map((s) => s.body)).toEqual([expect.stringMatching(/^Want to reschedule/)]);
    expect((await runsFor("no-show-recovery"))[0].exit_reason).toBe("no_reply");
    liveStatus = "confirmed";
  });

  it("post-call-follow-up: a follow_up disposition schedules the SMS for 9am the next morning, contact time", async () => {
    const appt = await asOperator((c) => one<{ id: string }>(c, "select id from appointments where company_id=$1 and external_id='ANS'", [companyId]));
    const [showed, fu] = await asOperator((c) => Promise.all([one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_outcome' and category='showed'", [companyId]), one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='call_outcome' and category='follow_up'", [companyId])]));
    await asOperator((c) => recordDisposition(c, { companyId, appointmentId: appt!.id, outcomeTermId: showed!.id, callOutcomeTermId: fu!.id }));
    await tick(fake, undefined, companyId);
    const r = (await runsFor("post-call-follow-up"))[0];
    expect(r.status).toBe("waiting");
    const at = DateTime.fromJSDate(r.next_run_at!).setZone(TZ);
    expect(at.hour).toBe(9); expect(at.minute).toBe(0); expect(at.toISODate()).toBe(DateTime.now().setZone(TZ).plus({ days: 1 }).toISODate());
  });

  it("payment-recorded: a payment is written to the CRM side only (nothing goes to the customer from here, D54); opportunity becomes a deal", async () => {
    const cns = await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='CNS'", [companyId]));
    await asOperator(async (c) => { const ev = await applyPayment(c, companyId, cns!.id, { whopPaymentId: "P1", amount: 2500, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); await dispatchEvent(c, ev, { contact: { id: cns!.id } }); });
    const n = since(), nTags = tags.length, nCw = contactWrites.length; await tick(fake, undefined, companyId);
    expect(sent.slice(n)).toEqual([]);   // no thank-you email: the customer-facing "Payment received" template is gone
    expect(tags.slice(nTags)).toContain("pay-plan-active"); expect(tags).not.toContain("client");
    expect(contactWrites.slice(nCw).map((w) => w.customFields)).toContainEqual([{ id: "CF-CASH", field_value: "2500" }]);
    expect((await runsFor("payment-recorded")).find((r) => r.contact_id === cns!.id)?.exit_reason).toBe("recorded");
    const opp = await asOperator((c) => one<{ status: string }>(c, "select status from opportunities where company_id=$1 and contact_id=$2", [companyId, cns!.id]));
    expect(opp?.status).toBe("won");
  });

  it("payment-failed: nothing to the client; one Slack post tagging the closer (suppressed cleanly when Slack is not connected)", async () => {
    const cns = await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='CNS'", [companyId]));
    await asOperator(async (c) => { const ev = await applyPayment(c, companyId, cns!.id, { whopPaymentId: "P2", amount: 2500, currency: "USD", status: "failed", paidAt: new Date(), raw: {} }); await dispatchEvent(c, ev, { contact: { id: cns!.id } }); });
    const n = since(); await tick(fake, undefined, companyId);
    expect(sent.slice(n)).toEqual([]);
    const r = (await runsFor("payment-failed"))[0]; expect(r.exit_reason).toBe("done");
    const slack = await asOperator((c) => one<{ status: string; suppressed_reason: string; rendered_body: string }>(c, "select status, suppressed_reason, rendered_body from sends where run_id=$1 and channel='slack'", [r.id]));
    expect(slack?.status).toBe("suppressed"); expect(slack?.suppressed_reason).toMatch(/unbound: slack/);
    expect(slack?.rendered_body).toMatch(/^\*Payment failed:\* \$2,500/); expect(slack?.rendered_body).toMatch(/\*Closer:\* /);
  });

  it("reactivation: tag starts the sequence; a second tag inside 90 days is blocked", async () => {
    const id = await newContact("CRA", "ra@x.com");
    const fire = () => asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "tag.added", source: "ghl_poll", data: { tag: "reactivate" } }), { contact: { id } }));
    expect(await fire()).toHaveLength(1);
    expect(await fire()).toHaveLength(0);
    const n = since(); await tick(fake, undefined, companyId);
    expect(sent.slice(n).map((s) => s.body)).toEqual([expect.stringMatching(/^Checking in/)]);
    const r = (await runsFor("reactivation"))[0]; expect(r.current_node).toBe("n2"); expect(DateTime.fromJSDate(r.next_run_at!).diffNow("days").days).toBeGreaterThan(2.9);
    expect(await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "tag.added", source: "ghl_poll", data: { tag: "something-else" } }), { contact: { id } }))).toHaveLength(0);
  });

  it("shadow mode: the run completes, messages are recorded as would-send, nothing reaches the CRM", async () => {
    await asOperator((c) => c.query("update companies set mode='shadow', sms_enabled=true where id=$1", [companyId]));
    const id = await newContact("CSHADOW", "shadow@x.com"); await withPhone(id, "+16025550199");
    await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "ghl_poll", data: {} }), { contact: { id } }));
    const n = since(), nt = tags.length, nOpps = oppWrites.length; await tick(fake, undefined, companyId);
    expect(sent.length).toBe(n);            // the fake sender was never called (speed-to-lead's email and text)
    expect(tags.length).toBe(nt);           // the fake CRM never got the tag (new-lead's stat-new)
    expect(oppWrites.length).toBe(nOpps);   // nor the setter card
    const lead = (await runsFor("new-lead")).find((r) => r.contact_id === id)!;
    expect(lead.exit_reason).toBe("done");  // but the run went all the way through
    const speed = (await runsFor("speed-to-lead")).find((r) => r.contact_id === id)!;
    expect(speed).toMatchObject({ status: "waiting", current_node: "n3" });   // and the sequence is parked for a reply as it would be live
    const ledger = await asOperator((c) => many<{ status: string; rendered_body: string }>(c, "select status, rendered_body from sends where run_id=$1 order by channel", [speed.id]));
    expect(ledger).toEqual([{ status: "shadow", rendered_body: expect.any(String) }, { status: "shadow", rendered_body: expect.any(String) }]);   // email and text, written down, not delivered
    const local = await asOperator((c) => one<{ tags: string[] }>(c, "select tags from contacts where id=$1", [id]));
    expect(local?.tags ?? []).not.toContain("stat-new");   // shadow touches neither GHL nor our replica of GHL's tags
    const logged = await asOperator((c) => one<{ data: { shadow?: boolean } }>(c, "select data from events where run_id=$1 and event_type='tag.added'", [lead.id]));
    expect(logged?.data.shadow).toBe(true);        // but the journey records what would have happened
    await asOperator((c) => c.query("update companies set mode='live' where id=$1", [companyId]));
  });

  it("an inbound text wakes a reply-wait but not a timed wait (a sequence parked on the 24-hour reminder stays parked)", async () => {
    const id = await newContact("CWAKE", "wake@x.com");
    const snapA: AppointmentSnapshot = { id: "AWAKE", calendarId: "CAL", contactId: "CWAKE", assignedUserId: "U1", startTime: DateTime.now().plus({ days: 2 }).set({ hour: 14, minute: 0 }).toISO()!, endTime: DateTime.now().plus({ days: 2 }).set({ hour: 14, minute: 30 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), raw: {} };
    apptStore.set("AWAKE", snapA);
    await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, snapA); });
    await tick(fake, undefined, companyId);
    const seq = (await runsFor("pre-call-sequence")).find((r) => r.contact_id === id)!;
    expect(seq.status).toBe("waiting"); expect(seq.current_node).toBe("w1");   // the booking text's reply wait: an inbound text wakes it
    expect((await asOperator((c) => one<{ wake_on_reply: boolean }>(c, "select wake_on_reply from runs where id=$1", [seq.id])))!.wake_on_reply).toBe(true);
    // park it on a timed reminder instead, the way it sits the day before the call
    const parkedUntil = Date.now() + 86_400e3;
    await asOperator((c) => c.query("update runs set current_node='r24', next_run_at=$2, wake_on_reply=false where id=$1", [seq.id, new Date(parkedUntil)]));
    // simulate what pollInbound does on an inbound message for this contact
    await asOperator((c) => c.query("update runs set next_run_at=now() where company_id=$1 and contact_id=$2 and status='waiting' and wake_on_reply", [companyId, id]));
    const after = (await runsFor("pre-call-sequence")).find((r) => r.contact_id === id)!;
    expect(after.next_run_at!.getTime()).toBe(parkedUntil);   // untouched
  });

  it("a redelivered payment webhook records nothing new and starts nothing", async () => {
    const id = await newContact("CDUP", "dup@x.com");
    const pay = () => asOperator(async (c) => { const ev = await applyPayment(c, companyId, id, { whopPaymentId: "PDUP", amount: 50, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); return ev.id === -1 ? [] : dispatchEvent(c, ev, { contact: { id } }); });
    expect(await pay()).toHaveLength(3);   // payment-recorded (CRM side), deal-closed (gate: not signed yet) and the unsigned-agreement chase all start
    expect(await pay()).toHaveLength(0);
    const evs = await asOperator((c) => many(c, "select 1 from events where contact_id=$1 and event_type='payment.received'", [id]));
    expect(evs).toHaveLength(1);
    await tick(fake, undefined, companyId); await tick(fake, undefined, companyId);   // flush what this started so later tests' send counts are their own (the chase parks itself for 24h)
  });

  it("new-lead: a lead with a phone gets a setter-pipeline card named 'Name -- New' with today's stage date, and the tag stat-new; without a phone, the run exits no_phone", async () => {
    const withNum = await newContact("CNL1", "nl1@x.com"); await withPhone(withNum, "+16025550101");
    await asOperator((c) => c.query("update contacts set first_name='Edwin', last_name='Ruh' where id=$1", [withNum]));
    const noNum = await newContact("CNL2", "nl2@x.com", null);
    for (const id of [withNum, noNum]) await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "ghl_poll", data: {} }), { contact: { id } }));
    const nTags = tags.length, nOpps = oppWrites.length;
    await tick(fake, undefined, companyId);
    let runs = await runsFor("new-lead");
    expect(runs.find((r) => r.contact_id === withNum)).toMatchObject({ status: "completed", exit_reason: "done" });
    expect(runs.find((r) => r.contact_id === noNum)).toMatchObject({ status: "waiting", current_node: "n1" });   // D39: it waits for a phone number
    // a day passes with no phone: the deadline it wrote is behind us and the clock says it is due
    await asOperator((c) => c.query("update runs set next_run_at=now(), context=jsonb_set(context, '{vars,__check,n1,deadline}', to_jsonb((now()-interval '1 minute')::text)) where company_id=$1 and contact_id=$2 and status='waiting'", [companyId, noNum]));
    await tick(fake, undefined, companyId);
    runs = await runsFor("new-lead");
    expect(runs.find((r) => r.contact_id === noNum)).toMatchObject({ status: "completed", exit_reason: "no_phone" });
    const created = oppWrites.slice(nOpps);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ op: "create", contactId: "CNL1", pipelineId: "PIPE-SETTER", stageId: "STAGE-NEW", name: "Edwin Ruh -- New", status: "open" });
    expect((created[0].customFields as { id: string; field_value: string }[])[0]).toEqual({ id: "CF-STAGE-DATE", field_value: DateTime.now().setZone(TZ).toFormat("yyyy-MM-dd") });
    expect(tags.slice(nTags)).toEqual(["stat-new"]);
    const card = await asOperator((c) => one<{ name: string; ghl_opportunity_id: string; ghl_pipeline_id: string; ghl_stage_id: string; status: string; opportunity_id: string }>(c, "select name, ghl_opportunity_id, ghl_pipeline_id, ghl_stage_id, status, opportunity_id from pipeline_cards where company_id=$1 and contact_id=$2", [companyId, withNum]));
    expect(card).toMatchObject({ name: "Edwin Ruh -- New", ghl_pipeline_id: "PIPE-SETTER", ghl_stage_id: "STAGE-NEW", status: "open" }); expect(card!.ghl_opportunity_id).toMatch(/^ghl-opp-/);
    expect(await asOperator((c) => many(c, "select 1 from opportunities where company_id=$1 and contact_id=$2 and status='open'", [companyId, withNum]))).toHaveLength(1);   // the card hangs off one pursuit
    expect(await asOperator((c) => many(c, "select 1 from opportunities where company_id=$1 and contact_id=$2", [companyId, noNum]))).toHaveLength(0);
    // the same lead firing again updates the one card instead of creating a second
    await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: withNum, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "form", data: {} }), { contact: { id: withNum } }));
    await tick(fake, undefined, companyId);
    expect(oppWrites.slice(nOpps).map((w) => w.op)).toEqual(["create", "update"]);
    expect(await asOperator((c) => many(c, "select 1 from pipeline_cards where company_id=$1 and contact_id=$2", [companyId, withNum]))).toHaveLength(1);
  });

  it("D61: the filed outcome moves the cards: a no-show puts the setter card on No-Show / Cancel / Reschedule, lost, and the closer card on No Show / Cancelled, open; a showed / follow-up puts the setter card on Showed (won) and the closer card on Follow Up; a showed / disqualified marks the closer card lost at Disqualified; filing the same no-show again writes nothing (already there)", async () => {
    const [noShow, followUp, dq] = await Promise.all([bookClosing("CO1"), bookClosing("CO2"), bookClosing("CO3")]);
    await tick(fake, undefined, companyId);   // Call booked makes both cards for each
    const apptOf = async (ghl: string) => (await asOperator((c) => one<{ id: string }>(c, "select id from appointments where company_id=$1 and external_id=$2", [companyId, `A${ghl}`])))!.id;
    const term = (domain: string, category: string) => asOperator(async (c) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain=$2 and category=$3", [companyId, domain, category]))!.id);
    const file = async (appointmentId: string, outcome: "showed" | "noshow", callOutcome?: "follow_up" | "unqualified") => asOperator(async (c) => recordDisposition(c, { companyId, appointmentId, outcomeTermId: await term("appointment_outcome", outcome), callOutcomeTermId: callOutcome ? await term("call_outcome", callOutcome) : null, notes: "filed", userId: null }));
    const cardsOf = (contactId: string) => asOperator((c) => many<{ pipeline: string; stage: string; status: string }>(c, "select ghl_pipeline_id as pipeline, ghl_stage_id as stage, status from pipeline_cards where company_id=$1 and contact_id=$2 order by ghl_pipeline_id", [companyId, contactId]));
    const runOf = async (contactId: string) => (await runsFor("call-outcome")).filter((r) => r.contact_id === contactId).at(-1)!;
    let n = oppWrites.length;
    await file(await apptOf("CO1"), "noshow"); await tick(fake, undefined, companyId);
    expect(await runOf(noShow)).toMatchObject({ status: "completed", exit_reason: "noted" });
    expect(oppWrites.slice(n)).toEqual([expect.objectContaining({ op: "update", pipelineId: "PIPE-SETTER", stageId: "STAGE-S-CANCEL", status: "lost" }), expect.objectContaining({ op: "update", pipelineId: "PIPE-CLOSER", stageId: "STAGE-C-CANCEL", status: "open" })]);
    expect(await cardsOf(noShow)).toEqual([{ pipeline: "PIPE-CLOSER", stage: "STAGE-C-CANCEL", status: "open" }, { pipeline: "PIPE-SETTER", stage: "STAGE-S-CANCEL", status: "lost" }]);
    n = oppWrites.length;
    await file(await apptOf("CO1"), "noshow"); await tick(fake, undefined, companyId);   // filed again (a correction, a CRM no-show after the form): the cards are already there
    expect(await runOf(noShow)).toMatchObject({ status: "completed", exit_reason: "noted" });
    expect(oppWrites.length).toBe(n);
    const again = (await runOf(noShow)).id;
    expect((await asOperator((c) => many<{ node_id: string; result: Record<string, unknown> }>(c, "select node_id, result from run_steps where run_id=$1 and node_id in ('gn1','gn2') order by node_id", [again]))).map((s) => [s.node_id, s.result.why])).toEqual([["gn1", "no open card on this board to move; this step never creates one"], ["gn2", "already there"]]);   // the setter card is lost (closed), the closer card is already there
    n = oppWrites.length;
    await file(await apptOf("CO2"), "showed", "follow_up"); await tick(fake, undefined, companyId);
    expect(await runOf(followUp)).toMatchObject({ status: "completed", exit_reason: "noted" });
    expect(oppWrites.slice(n)).toEqual([expect.objectContaining({ op: "update", pipelineId: "PIPE-SETTER", stageId: "STAGE-SHOWED", status: "won" }), expect.objectContaining({ op: "update", pipelineId: "PIPE-CLOSER", stageId: "STAGE-FOLLOWUP", status: "open" })]);
    expect(await cardsOf(followUp)).toEqual([{ pipeline: "PIPE-CLOSER", stage: "STAGE-FOLLOWUP", status: "open" }, { pipeline: "PIPE-SETTER", stage: "STAGE-SHOWED", status: "won" }]);
    n = oppWrites.length;
    await file(await apptOf("CO3"), "showed", "unqualified"); await tick(fake, undefined, companyId);
    expect(await runOf(dq)).toMatchObject({ status: "completed", exit_reason: "noted" });
    expect(oppWrites.slice(n)).toEqual([expect.objectContaining({ op: "update", pipelineId: "PIPE-SETTER", stageId: "STAGE-SHOWED", status: "won" }), expect.objectContaining({ op: "update", pipelineId: "PIPE-CLOSER", stageId: "STAGE-DQ", status: "lost" })]);
    expect(await cardsOf(dq)).toEqual([{ pipeline: "PIPE-CLOSER", stage: "STAGE-DQ", status: "lost" }, { pipeline: "PIPE-SETTER", stage: "STAGE-SHOWED", status: "won" }]);
  });

  it("call-booked, self-booked: closer card created at Scheduled, setter card only moved if present, stat-booked + stat-self-booked, nurture tags off, contact gets date + owner, Slack skipped when unbound", async () => {
    const id = await newContact("CCB1", "cb1@x.com"); await asOperator((c) => c.query("update contacts set first_name='Mia', last_name='Ortiz' where id=$1", [id]));
    const start = DateTime.now().plus({ days: 4 }).setZone(TZ).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    const snap: AppointmentSnapshot = { id: "ACB1", calendarId: "CAL", contactId: "CCB1", assignedUserId: "U1", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), tracking: { utm_source: "meta" }, rescheduleUrl: "https://calendly.com/reschedulings/abc", raw: {} };
    apptStore.set("ACB1", snap);
    const nOpp = oppWrites.length, nTags = tags.length, nRm = removedTags.length, nCw = contactWrites.length;
    await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, snap); });
    await tick(fake, undefined, companyId);
    const r = (await runsFor("call-booked")).find((x) => x.contact_id === id)!;
    expect(r).toMatchObject({ status: "completed", exit_reason: "booked" });
    expect(oppWrites.slice(nOpp)).toEqual([
      expect.objectContaining({ op: "create", pipelineId: "PIPE-SETTER", stageId: "STAGE-DIRECT", name: "Mia Ortiz -- Direct", assignedUserId: "U1" }),   // no setter card existed → one is made where it belongs (D41)
      expect.objectContaining({ op: "create", pipelineId: "PIPE-CLOSER", stageId: "STAGE-SCHED", name: "Mia Ortiz -- Direct", assignedUserId: "U1" }),
    ]);
    expect(tags.slice(nTags)).toEqual(["stat-booked", "stat-self-booked", "meta booked call"]);
    expect(removedTags.slice(nRm)).toEqual(["seq-no-show", "seq-nurture", "seq-winback", "opt-in lead", "stat-no-show", "stat-cancelled", "stat-possible-cancel", "stat-needs-attention"]);   // D62: a fresh booking takes the no-show / cancel / attention tags off
    expect(contactWrites.slice(nCw)).toEqual([expect.objectContaining({ id: "CCB1", assignedUserId: "U1", customFields: [{ id: "CF-APPT-DATE", field_value: start.setZone(TZ).toFormat("yyyy-MM-dd") }] })]);
    const steps = await asOperator((c) => many<{ node_id: string; status: string; result: Record<string, unknown> }>(c, "select node_id, status, result from run_steps where run_id=$1 order by started_at", [r.id]));
    expect(steps.find((x) => x.node_id === "s3")?.status).toBe("ok");
    expect(steps.filter((x) => ["s5", "b6", "n3", "k1", "k2"].includes(x.node_id)).map((x) => x.node_id)).toEqual(["s5"]);   // every tag change in one step
    expect(steps.find((x) => x.node_id === "n4")?.status).toBe("skipped");   // Slack not connected in this company
    const slack = await asOperator((c) => one<{ suppressed_reason: string }>(c, "select suppressed_reason from sends where run_id=$1 and channel='slack'", [r.id]));
    expect(slack?.suppressed_reason).toMatch(/unbound: slack/);
    const cards = await asOperator((c) => many<{ ghl_pipeline_id: string; opportunity_id: string }>(c, "select ghl_pipeline_id, opportunity_id from pipeline_cards where company_id=$1 and contact_id=$2", [companyId, id]));
    const appt = await asOperator((c) => one<{ opportunity_id: string }>(c, "select opportunity_id from appointments where company_id=$1 and external_id='ACB1'", [companyId]));
    expect(cards).toHaveLength(2); expect(cards.map((x) => x.opportunity_id)).toEqual([appt!.opportunity_id, appt!.opportunity_id]);   // one pursuit: the appointment and both cards share it
  });

  it("D41: a setter card the CRM already holds (made by a GHL workflow before the engine watched) is adopted and moved, never duplicated", async () => {
    const id = await newContact("CCB9", "cb9@x.com"); await asOperator((c) => c.query("update contacts set first_name='Calvin', last_name='Coates' where id=$1", [id]));
    await asOperator((c) => c.query("update calendars set self_booked=true where company_id=$1 and external_id='CAL'", [companyId]));
    liveCards.set("CCB9", [{ id: "ghl-live-9", pipelineId: "PIPE-SETTER", stageId: "STAGE-NEW", status: "open", name: "Calvin Coates -- New", assignedUserId: "U1", updatedAt: new Date().toISOString() }]);
    const start = DateTime.now().plus({ days: 4 }).setZone(TZ).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    const snap: AppointmentSnapshot = { id: "ACB9", calendarId: "CAL", contactId: "CCB9", assignedUserId: "U1", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), raw: {} };
    apptStore.set("ACB9", snap);
    const nOpp = oppWrites.length;
    await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, snap); });
    await tick(fake, undefined, companyId);
    await asOperator((c) => c.query("update calendars set self_booked=null where company_id=$1 and external_id='CAL'", [companyId]));
    liveCards.delete("CCB9");
    const r = (await runsFor("call-booked")).find((x) => x.contact_id === id)!;
    expect(r).toMatchObject({ status: "completed", exit_reason: "booked" });
    expect(oppWrites.slice(nOpp)).toEqual([
      expect.objectContaining({ op: "update", id: "ghl-live-9", stageId: "STAGE-DIRECT", name: "Calvin Coates -- Direct" }),   // the CRM's card, moved
      expect.objectContaining({ op: "create", pipelineId: "PIPE-CLOSER", stageId: "STAGE-SCHED" }),
    ]);
    const cards = await asOperator((c) => many<{ ghl_pipeline_id: string; ghl_opportunity_id: string | null; ghl_stage_id: string; opportunity_id: string }>(c, "select ghl_pipeline_id, ghl_opportunity_id, ghl_stage_id, opportunity_id from pipeline_cards where company_id=$1 and contact_id=$2 order by ghl_pipeline_id", [companyId, id]));
    expect(cards.map((x) => [x.ghl_pipeline_id, x.ghl_opportunity_id, x.ghl_stage_id])).toEqual([["PIPE-CLOSER", "ghl-opp-" + oppWrites.length, "STAGE-SCHED"], ["PIPE-SETTER", "ghl-live-9", "STAGE-DIRECT"]]);
    expect(new Set(cards.map((x) => x.opportunity_id)).size).toBe(1);   // the adopted card and the new one share the pursuit
    const s3 = await asOperator((c) => one<{ result: Record<string, unknown> }>(c, "select result from run_steps where run_id=$1 and node_id='s3'", [r.id]));
    expect(s3?.result).toMatchObject({ card: "moved", from_stage: "STAGE-NEW", crm_card: "ghl-live-9" });
  });

  it("call-booked, setter booked: setter card moves to Appointment Set as '-- Set', closer card '-- Setter Booked', setter stamped on contact and cards, stat-set", async () => {
    const id = await newContact("CCB2", "cb2@x.com"); await asOperator((c) => c.query("update contacts set first_name='Leo', last_name='Park' where id=$1", [id]));
    await asOperator((c) => c.query("update calendars set self_booked=false where company_id=$1 and external_id='CAL'", [companyId]));
    // a setter card already exists from new-lead
    await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "ghl_poll", data: {} }), { contact: { id } }));
    await withPhone(id, "+16025550911"); await tick(fake, undefined, companyId);
    const start = DateTime.now().plus({ days: 5 }).setZone(TZ).set({ hour: 13, minute: 0, second: 0, millisecond: 0 });
    const snap: AppointmentSnapshot = { id: "ACB2", calendarId: "CAL", contactId: "CCB2", assignedUserId: "U1", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), setBy: "Luis", raw: {} };
    apptStore.set("ACB2", snap);
    const nOpp = oppWrites.length, nTags = tags.length, nCw = contactWrites.length;
    await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, snap); });
    await tick(fake, undefined, companyId);
    await asOperator((c) => c.query("update calendars set self_booked=null where company_id=$1 and external_id='CAL'", [companyId]));
    const r = (await runsFor("call-booked")).find((x) => x.contact_id === id)!;
    expect(r).toMatchObject({ status: "completed", exit_reason: "booked" });
    const writes = oppWrites.slice(nOpp);
    expect(writes).toEqual([
      expect.objectContaining({ op: "update", stageId: "STAGE-SET", name: "Leo Park -- Set", customFields: [{ id: "CF-SETTER-OWNER", field_value: "Luis" }] }),
      expect.objectContaining({ op: "create", pipelineId: "PIPE-CLOSER", stageId: "STAGE-SCHED", name: "Leo Park -- Setter Booked", customFields: [{ id: "CF-SETTER-OWNER", field_value: "Luis" }] }),
    ]);
    expect(tags.slice(nTags)).toEqual(["stat-booked", "stat-set", "meta booked call"]);
    expect(contactWrites.slice(nCw).map((w) => w.customFields)).toEqual([[{ id: "CF-APPT-DATE", field_value: start.setZone(TZ).toFormat("yyyy-MM-dd") }], [{ id: "CF-SETTER", field_value: "Luis" }]]);
    const cards = await asOperator((c) => many<{ ghl_pipeline_id: string; name: string; opportunity_id: string }>(c, "select ghl_pipeline_id, name, opportunity_id from pipeline_cards where company_id=$1 and contact_id=$2 order by ghl_pipeline_id", [companyId, id]));
    expect(cards.map((x) => x.name)).toEqual(["Leo Park -- Setter Booked", "Leo Park -- Set"]);
    expect(new Set(cards.map((x) => x.opportunity_id)).size).toBe(1);   // two boards, one pursuit
    const ctxRow = await asOperator((c) => one<{ context: { vars: Record<string, string> } }>(c, "select context from runs where id=$1", [r.id]));
    expect(ctxRow!.context.vars.setter_line).toBe("*Setter:* Luis"); expect(ctxRow!.context.vars.booking_kind).toBe("setter booked");
  });

  it("call-cancelled: a real cancel moves both cards to their cancelled stage, clears the appointment date, opens a rebook task for the closer with the reason, swaps the tags; cancellation-rebook (prospect-facing) runs alongside", async () => {
    // cancel the self-booked call from the call-booked scenario (closer card exists; no setter card)
    const base = apptStore.get("ACB1")!;
    const cancelled: AppointmentSnapshot = { ...base, status: "cancelled", cancellation: { by: "Mia Ortiz", reason: "work trip", byType: "invitee" } };
    apptStore.set("ACB1", cancelled); liveStatus = "cancelled";
    const nOpp = oppWrites.length, nTags = tags.length, nRm = removedTags.length, nCw = contactWrites.length, nTasks = tasks.length;
    await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, cancelled); });
    await tick(fake, undefined, companyId); liveStatus = "confirmed";
    const id = (await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='CCB1'", [companyId])))!.id;
    const r = (await runsFor("call-cancelled")).find((x) => x.contact_id === id)!;
    expect(r).toMatchObject({ status: "completed", exit_reason: "cancelled_recorded" });
    expect(oppWrites.slice(nOpp)).toEqual([expect.objectContaining({ op: "update", stageId: "STAGE-S-CANCEL", name: "Mia Ortiz -- Cancelled" }), expect.objectContaining({ op: "update", stageId: "STAGE-C-CANCEL", name: "Mia Ortiz -- Cancelled" })]);   // both cards exist since booking; both move
    expect(contactWrites.slice(nCw)).toEqual([expect.objectContaining({ id: "CCB1", customFields: [{ id: "CF-APPT-DATE", field_value: "" }] })]);
    expect(tasks.slice(nTasks)).toEqual([expect.objectContaining({ contactId: "CCB1", title: "Rebook Mia Ortiz — cancelled", body: "Cancelled by Mia Ortiz. Reason: work trip.", assignedUserId: "U1" })]);
    const due = (tasks.at(-1)!.dueAt as Date).getTime() - Date.now(); expect(due).toBeGreaterThan(23 * 3600e3); expect(due).toBeLessThan(25 * 3600e3);
    expect(tags.slice(nTags)).toEqual(["stat-cancelled"]);
    expect(removedTags.slice(nRm)).toEqual(["stat-booked", "stat-self-booked", "stat-set", "stat-confirmed"]);
    const appt = await asOperator((c) => one<{ cancelled_by: string; cancel_reason: string }>(c, "select cancelled_by, cancel_reason from appointments where company_id=$1 and external_id='ACB1'", [companyId]));
    expect(appt).toEqual({ cancelled_by: "Mia Ortiz", cancel_reason: "work trip" });
    expect((await runsFor("cancellation-rebook")).some((x) => x.contact_id === id)).toBe(true);
  });

  it("payment-recorded: a deposit stamps cash collected + revenue generated, tags pay-plan-active, writes the Payment record linked to contact and closer card; the balance flips to pay-paid-full", async () => {
    // Leo Park (setter-booked scenario) has a closer card owned by U1
    const id = (await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='CCB2'", [companyId])))!.id;
    const nTags = tags.length, nRm = removedTags.length, nCw = contactWrites.length, nRec = recordWrites.length, nRel = relations.length;
    await asOperator(async (c) => { const ev = await applyPayment(c, companyId, id, { whopPaymentId: "pay_leo_1", amount: 1500, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); await dispatchEvent(c, ev, { contact: { id } }); });
    await tick(fake, undefined, companyId);
    let r = (await runsFor("payment-recorded")).find((x) => x.contact_id === id)!;
    expect(r).toMatchObject({ status: "completed", exit_reason: "recorded" });
    expect(contactWrites.slice(nCw).map((w) => w.customFields)).toEqual([[{ id: "CF-CASH", field_value: "1500" }], [{ id: "CF-REV", field_value: "2999" }]]);
    expect(tags.slice(nTags)).toEqual(["pay-plan-active", "stat-agreement-sent"]); expect(removedTags.slice(nRm)).toEqual([]);   // first payment, nothing signed → the agreement goes out
    expect(docSends.at(-1)).toEqual({ templateId: "TPL-AGREE", contactId: "CCB2", userId: "U1" });
    const rec = recordWrites.slice(nRec); expect(rec).toHaveLength(2);   // the Payment record, then the payment stamped on the Sales Call record call-booked created
    expect(rec[1]).toMatchObject({ op: "update" });
    expect(rec[0]).toMatchObject({ op: "create", transaction_id: "pay_leo_1", amount: 1500, type: "deposit", status: "succeeded", processor: "whop", contact_id: "CCB2", closer: "Sam Closer", setter: "Luis" });
    expect(String(rec[0].opportunity_id)).toMatch(/^ghl-opp-/);   // the closer card's CRM id
    expect(relations.slice(nRel)).toEqual([`ASSOC-PC:CCB2>rec-${nRec + 1}`, `ASSOC-PO:rec-${nRec + 1}>${rec[0].opportunity_id}`]);
    // second payment clears the deal: revenue generated is already stamped (our replica learned the first write), so only cash collected moves; tags flip
    const nTags2 = tags.length, nRm2 = removedTags.length, nRec2 = recordWrites.length;
    await asOperator(async (c) => { const ev = await applyPayment(c, companyId, id, { whopPaymentId: "pay_leo_2", amount: 1499, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); await dispatchEvent(c, ev, { contact: { id } }); });
    await tick(fake, undefined, companyId);
    r = (await runsFor("payment-recorded")).filter((x) => x.contact_id === id).at(-1)!;
    expect(r.status).toBe("completed");
    expect(tags.slice(nTags2)).toEqual(["pay-paid-full"]); expect(removedTags.slice(nRm2)).toEqual(["pay-plan-active"]);
    expect(recordWrites.slice(nRec2)[0]).toMatchObject({ op: "create", transaction_id: "pay_leo_2", type: "balance" });
    const ours = await asOperator((c) => many<{ record_key: string; ghl_record_id: string }>(c, "select record_key, ghl_record_id from crm_records where company_id=$1 and contact_id=$2 and object_key='custom_objects.payment' order by created_at", [companyId, id]));
    expect(ours.map((x) => x.record_key)).toEqual(["pay_leo_1", "pay_leo_2"]);
  });

  it("payment-recorded (D57): a refund is a new line with a minus sign: cash collected drops to the lower running total, a second Payment record carries the negative amount, pay-refunded is added, pay-paid-full stays, the Slack line says Refund and the thread lines go 💸", async () => {
    // Leo has paid 1,500 + 1,499 = the 2,999 program and wears pay-paid-full; part of the second payment goes back
    const id = (await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='CCB2'", [companyId])))!.id;
    const nTags = tags.length, nRm = removedTags.length, nCw = contactWrites.length, nRec = recordWrites.length, nDoc = docSends.length;
    await asOperator(async (c) => { const ev = await applyPayment(c, companyId, id, { whopPaymentId: "pay_leo_r1", amount: 500, currency: "USD", status: "refunded", paidAt: new Date(), raw: {} }); expect(ev.event_type).toBe("payment.refunded"); await dispatchEvent(c, ev, { contact: { id } }); });
    await tick(fake, undefined, companyId);
    const r = (await runsFor("payment-recorded")).filter((x) => x.contact_id === id).at(-1)!;
    expect(r).toMatchObject({ status: "completed", exit_reason: "recorded" });
    expect(contactWrites.slice(nCw).map((w) => w.customFields)).toEqual([[{ id: "CF-CASH", field_value: "2499" }]]);   // cash collected follows the ledger; revenue generated is not re-stamped
    expect(tags.slice(nTags)).toEqual(["pay-refunded"]); expect(removedTags.slice(nRm)).toEqual([]);   // pay-paid-full / pay-plan-active stay as the last payment left them
    expect(docSends.length).toBe(nDoc);   // a refund never sends the agreement
    const rec = recordWrites.slice(nRec); expect(rec).toHaveLength(2);
    expect(rec[0]).toMatchObject({ op: "create", transaction_id: "pay_leo_r1", amount: -500, type: "refund", status: "refunded", processor: "whop", contact_id: "CCB2", display_label: expect.stringMatching(/^−\$500 · /) });
    expect(rec[1]).toMatchObject({ op: "update", cash_collected: "2499" });   // the Sales Call record follows too
    const ours = await asOperator((c) => many<{ record_key: string }>(c, "select record_key from crm_records where company_id=$1 and contact_id=$2 and object_key='custom_objects.payment' order by created_at", [companyId, id]));
    expect(ours.map((x) => x.record_key)).toEqual(["pay_leo_1", "pay_leo_2", "pay_leo_r1"]);   // a new line, never an edit of the old one
    const slack = await asOperator((c) => many<{ rendered_body: string }>(c, "select rendered_body from sends where run_id=$1 and channel='slack' order by id", [r.id]));
    expect(slack.map((s) => s.rendered_body.split("\n")[0]).sort()).toEqual(["*Refund:* −$500", "💸 Refunded $500 · refund.", "💸 Refunded $500 · refund. Details in the payments channel."]);   // the three Slack lines of the run (payments channel, booking thread, review thread)
  });

  it("call-recorded: a Fathom recording matched by invitee email → AI classifies, notes, scores; appointment marked showed (call.held fires), stat-showed, setter card to Showed + won, Sales Call record linked, note, Slack; an internal meeting stops at the check", async () => {
    // Leo Park (setter-booked scenario, closer card owned by U1) has an appointment ACB2 and a setter card
    const id = (await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='CCB2'", [companyId])))!.id;
    const appt = (await asOperator((c) => one<{ id: string; starts_at: Date; external_id: string }>(c, "select id, starts_at, external_id from appointments where company_id=$1 and contact_id=$2 order by starts_at desc limit 1", [companyId, id])))!;
    const rec: RecordingInput = { externalId: "fathom-1001", title: "Leo Park and Sam Closer", startedAt: new Date(appt.starts_at.getTime() + 2 * 60e3), durationMin: 43, shareUrl: "https://fathom.video/share/abc",
      recordedBy: { name: "Sam Closer", email: "sam@x.com" }, invitees: [{ name: "Sam Closer", email: "sam@x.com", isExternal: false }, { name: "Leo Park", email: "cb2@x.com", isExternal: true }],
      transcript: [{ speaker: "Sam Closer", text: "Thanks for hopping on." }, { speaker: "Leo Park", text: "I just want it to stop." }] };
    const nTags = tags.length, nOpp = oppWrites.length, nRec = recordWrites.length, nRel = relations.length, nAn = analyses.length;
    const r = await asOperator((c) => recordRecording(c, companyId, rec));
    expect(r.outcome).toBe("linked"); if (r.outcome !== "linked") return;
    expect(r.contactId).toBe(id); expect(r.recording.linked_by).toBe("email"); expect(r.appointmentId).toBe(appt.id);
    await asOperator((c) => dispatchEvent(c, r.event, { contact: { id }, appointment: { id: appt.id } }));
    await tick(fake, undefined, companyId);
    const run = (await runsFor("call-recorded")).find((x) => x.contact_id === id)!;
    expect(run).toMatchObject({ status: "completed", exit_reason: "recorded" });
    expect(analyses.slice(nAn)).toHaveLength(1);   // notes + scorecard in one read; the kind of call and how it ended are Jev's (D48)
    expect(tags.slice(nTags)).toEqual(["stat-showed"]);
    expect(oppWrites.slice(nOpp)).toEqual([expect.objectContaining({ op: "update", stageId: "STAGE-SHOWED", status: "won" })]);   // the setter card; the closer card is untouched
    const setterCard = await asOperator((c) => one<{ status: string; ghl_stage_id: string }>(c, "select status, ghl_stage_id from pipeline_cards where company_id=$1 and contact_id=$2 and ghl_pipeline_id='PIPE-SETTER'", [companyId, id]));
    expect(setterCard).toEqual({ status: "won", ghl_stage_id: "STAGE-SHOWED" });
    const rw = recordWrites.slice(nRec); expect(rw).toHaveLength(1);
    // the record was created at booking (call-booked); the recording updates that same one
    expect(rw[0]).toMatchObject({ op: "update", external_id: appt.external_id, outcome: "showed", contact_id: "CCB2", closer: "Sam Closer", duration_min: 43, disposition: "closed_won", objection_primary: "price", recording_url: "https://fathom.video/share/abc" });
    expect(relations.slice(nRel)).toEqual([`ASSOC-SC:CCB2>${rw[0].id}`, `ASSOC-SO:${rw[0].id}>${rw[0].opportunity_id}`]);
    const a = await asOperator((c) => one<{ outcome: string | null }>(c, "select t.category as outcome from appointments a left join company_terms t on t.id=a.outcome_term where a.id=$1", [appt.id]));
    expect(a?.outcome).toBe("showed");
    const evs = await asOperator((c) => many<{ event_type: string }>(c, "select event_type from events where company_id=$1 and contact_id=$2 and event_type in ('appointment.outcome','call.held','call.analyzed') order by id", [companyId, id]));
    expect(evs.map((e) => e.event_type)).toEqual(["call.analyzed", "appointment.outcome", "call.held"]);
    const stored = await asOperator((c) => one<{ analysis: Record<string, unknown> }>(c, "select analysis from recordings where id=$1", [r.recording.id]));
    expect(Object.keys(stored!.analysis).sort()).toEqual(["classify", "notes", "outcome", "rubric"]);   // Jev's kind and outcome, Anthropic's notes and scorecard
    const slack = await asOperator((c) => one<{ rendered_body: string; suppressed_reason: string | null }>(c, "select rendered_body, suppressed_reason from sends where run_id=$1 and channel='slack'", [run.id]));
    expect(slack?.suppressed_reason).toMatch(/slack/);   // channel unbound in this test company; the text is still what matters
    // a replay of the same recording records nothing new
    expect((await asOperator((c) => recordRecording(c, companyId, rec))).outcome).toBe("duplicate");
    // an internal meeting: the AI says not a sales call → nothing written
    salesCall = false;
    const internal: RecordingInput = { ...rec, externalId: "fathom-1002", title: "Team sync", invitees: rec.invitees, transcript: [{ speaker: "Sam Closer", text: "Pipeline review." }] };
    const r2 = await asOperator((c) => recordRecording(c, companyId, internal));
    expect(r2.outcome).toBe("linked"); if (r2.outcome !== "linked") return;
    const nTags2 = tags.length, nRec2 = recordWrites.length;
    await asOperator((c) => dispatchEvent(c, r2.event, { contact: { id } }));
    await tick(fake, undefined, companyId); salesCall = true;
    const run2 = (await runsFor("call-recorded")).filter((x) => x.contact_id === id).at(-1)!;
    expect(run2).toMatchObject({ status: "completed", exit_reason: "not_a_sales_call" });
    expect(tags.length).toBe(nTags2); expect(recordWrites.length).toBe(nRec2);
  });

  it("call-recorded, unmatched: a stranger's recording is unlinked with a reason; linking it by hand starts the workflow and remembers the email", async () => {
    const rec: RecordingInput = { externalId: "fathom-2001", title: "Intro call", startedAt: new Date(Date.now() - 30 * 86400e3), durationMin: 20, recordedBy: { email: "sam@x.com" }, invitees: [{ name: "Sam Closer", email: "sam@x.com" }, { name: "Nobody Known", email: "stranger@z.com" }], transcript: [{ speaker: "Nobody Known", text: "Hi." }] };
    const r = await asOperator((c) => recordRecording(c, companyId, rec));
    expect(r.outcome).toBe("unlinked"); if (r.outcome !== "unlinked") return;
    expect(r.reason).toMatch(/nobody in the CRM matches stranger@z.com/);
    const id = await newContact("CSTR", "other@z.com");
    const { event } = await asOperator((c) => linkRecording(c, companyId, r.recording.id, id));
    expect(event.event_type).toBe("recording.received"); expect(event.data.matched_by).toBe("manual"); expect(event.data.appointment_matched).toBe(false);
    const ids = await asOperator((c) => many<{ value: string }>(c, "select value from contact_identifiers where contact_id=$1 and kind='email' order by value", [id]));
    expect(ids.map((x) => x.value)).toEqual(["other@z.com", "stranger@z.com"]);
    await asOperator((c) => dispatchEvent(c, event, { contact: { id } }));
    await tick(fake, undefined, companyId);
    const run = (await runsFor("call-recorded")).find((x) => x.contact_id === id)!;
    expect(run).toMatchObject({ status: "completed", exit_reason: "recorded" });
    const rw = recordWrites.at(-1)!; expect(rw.external_id).toBe("fathom-fathom-2001"); expect(rw.scheduled_at).toBeUndefined();   // no appointment: keyed by the recording, nothing marked showed
    const slack = await asOperator((c) => one<{ rendered_body: string }>(c, "select rendered_body from sends where run_id=$1 and channel='slack'", [run.id]));
    expect(slack).toBeTruthy();
  });

  it("test harness: sys-test create → book → cancel → reset drive the real workflows on a synthetic appointment that survives the premise check; refused when live", async () => {
    const id = await newContact("CSIM", "sim@x.com"); await withPhone(id, "+16025550922");
    await asOperator((c) => c.query("update contacts set first_name='Sim', last_name='Person' where id=$1", [id]));
    const sim = (action: Parameters<typeof simulate>[1]) => asOperator(async (c) => { const { row } = await loadCompany(c, companyId); return simulate({ c, company: row, contactId: id }, action); });
    const live = await sim("create"); expect(live).toMatchObject({ ok: false, why: expect.stringMatching(/live/) });   // this company runs live; the harness refuses
    await asOperator((c) => c.query("update companies set mode='shadow' where id=$1", [companyId]));
    expect(await sim("create")).toMatchObject({ ok: true, runsStarted: 2 });   // new-lead + speed-to-lead
    await tick(fake, undefined, companyId);
    expect((await runsFor("new-lead")).find((r) => r.contact_id === id)).toMatchObject({ status: "completed", exit_reason: "done" });
    const b = await sim("book"); expect(b).toMatchObject({ ok: true }); if (!b.ok) return;
    const appt = await asOperator((c) => one<{ source: string; status: string; set_by: string; self_booked: boolean }>(c, "select source, status, set_by, self_booked from appointments where id=$1", [b.detail.appointment as string]));
    expect(appt).toEqual({ source: "test", status: "confirmed", set_by: "Test Setter", self_booked: false });
    await tick(fake, undefined, companyId);
    const booked = (await runsFor("call-booked")).find((r) => r.contact_id === id)!; expect(booked).toMatchObject({ status: "completed", exit_reason: "booked" });   // premise appointment_exists held on a 'test' source
    const cards = await asOperator((c) => many<{ ghl_pipeline_id: string; ghl_stage_id: string; name: string }>(c, "select ghl_pipeline_id, ghl_stage_id, name from pipeline_cards where company_id=$1 and contact_id=$2 order by ghl_pipeline_id", [companyId, id]));
    expect(cards).toEqual([{ ghl_pipeline_id: "PIPE-CLOSER", ghl_stage_id: "STAGE-SCHED", name: "Sim Person -- Setter Booked" }, { ghl_pipeline_id: "PIPE-SETTER", ghl_stage_id: "STAGE-SET", name: "Sim Person -- Set" }]);
    expect(await sim("cancel")).toMatchObject({ ok: true });
    await tick(fake, undefined, companyId);
    expect((await runsFor("call-cancelled")).find((r) => r.contact_id === id)).toMatchObject({ status: "completed", exit_reason: "cancelled_recorded" });
    expect(await sim("reset")).toMatchObject({ ok: true });
    expect(await asOperator((c) => many(c, "select 1 from runs where company_id=$1 and contact_id=$2", [companyId, id]))).toHaveLength(0);
    expect(await asOperator((c) => many(c, "select 1 from appointments where company_id=$1 and contact_id=$2", [companyId, id]))).toHaveLength(0);
    expect(await asOperator((c) => one(c, "select 1 from contacts where id=$1", [id]))).toBeTruthy();   // the person stays; only what the engine did is gone
    // booked with a named closer at an exact time (earlier today, so the call is already due for that closer's end-of-day form)
    const closer = (await asOperator((c) => one<{ name: string }>(c, "insert into users (company_id, email, name, role) values ($1,'zara.harness@x.com','Zara Harness','closer') on conflict do nothing returning name", [companyId]))) ?? { name: "Zara Harness" };
    const at = DateTime.now().setZone(TZ).startOf("day").plus({ hours: 10 }).toISO()!;
    const simX = (o: { closer?: string; startsAt?: string }) => asOperator(async (c) => { const { row } = await loadCompany(c, companyId); return simulate({ c, company: row, contactId: id, ...o }, "book"); });
    expect(await simX({ closer: "Nobody Here" })).toMatchObject({ ok: false, why: expect.stringMatching(/no one on the roster/) });
    const b2 = await simX({ closer: closer.name.split(" ")[0], startsAt: at }); expect(b2).toMatchObject({ ok: true, detail: { closer: closer.name } }); if (!b2.ok) return;
    expect(Date.parse(b2.detail.starts_at as string)).toBe(Date.parse(at));
    expect(await sim("reset")).toMatchObject({ ok: true });
    await asOperator((c) => c.query("update companies set mode='live' where id=$1", [companyId]));
  });

  it("dark hours: a human-sounding send waits for the window; a transactional one goes out only when the company allows it", async () => {
    const id = await newContact("CDARK", "dark@x.com"); await withPhone(id, "+16025550177");
    // a window that is closed right now, in the contact's zone
    const now = DateTime.now().setZone(TZ); const closedStart = now.plus({ hours: 2 }).toFormat("HH:mm"), closedEnd = now.plus({ hours: 3 }).toFormat("HH:mm");
    await asOperator((c) => c.query("update companies set send_window_start=$2, send_window_end=$3, quiet_allow_transactional=false where id=$1", [companyId, closedStart, closedEnd]));
    const n = sent.length;
    await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "form", data: {} }), { contact: { id } }));
    await tick(fake, undefined, companyId);
    expect(sent.length).toBe(n);   // speed-to-lead's first email waited
    expect((await runsFor("speed-to-lead")).find((r) => r.contact_id === id)).toMatchObject({ status: "waiting", current_node: "n1" });
    // mark that first email transactional and allow transactional sends in dark hours → it goes out at once
    const wf = (await bySlug("speed-to-lead"))!;
    await asOperator((c) => c.query(`update workflow_versions set definition = jsonb_set(definition, '{nodes,1,kind}', '"transactional"') where workflow_id=$1`, [wf.id]));
    await asOperator((c) => c.query("update companies set quiet_allow_transactional=true where id=$1", [companyId]));
    await asOperator((c) => c.query("update runs set next_run_at=now() where company_id=$1 and contact_id=$2", [companyId, id]));
    await tick(fake, undefined, companyId);
    expect(sent.slice(n).map((s) => s.kind)).toEqual(["email"]);   // the SMS that follows is human and still waits
    expect((await runsFor("speed-to-lead")).find((r) => r.contact_id === id)).toMatchObject({ status: "waiting", current_node: "n2" });
    await asOperator((c) => c.query("update companies set send_window_start='00:00', send_window_end='23:59', quiet_allow_transactional=false where id=$1", [companyId]));
  });

  it("sms_enabled=false: SMS nodes are suppressed and the run continues", async () => {
    await asOperator((c) => c.query("update companies set sms_enabled=false where id=$1", [companyId]));
    const id = await newContact("CNOSMS", "nosms@x.com");
    await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "form", data: {} }), { contact: { id } }));
    const n = since(); await tick(fake, undefined, companyId);
    expect(sent.slice(n).map((s) => s.kind)).toEqual(["email"]);
    const r = (await runsFor("speed-to-lead")).find((r) => r.contact_id === id)!; expect(r.status).toBe("waiting"); expect(r.current_node).toBe("n3");
    const sup = await asOperator((c) => one<{ suppressed_reason: string }>(c, "select suppressed_reason from sends where run_id=$1 and channel='sms'", [r.id]));
    expect(sup?.suppressed_reason).toMatch(/sms_disabled/);
  });

  it("setter-call-logged: a connected dialer call with a transcript → 15 minutes after the call the AI calls it a setting call, digest, Discovery Call record linked to the contact, note, Slack; too short / no transcript / 'where are you' each stop at their check; a fresh call waits", async () => {
    const id = (await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='CCB2'", [companyId])))!.id;
    const transcript = [{ speaker: "0", text: "Hey Leo, got two minutes?" }, { speaker: "1", text: "Sure. It has been getting worse for a year. What does it cost?" }, { speaker: "0", text: "The specialist covers that. Thursday at two?" }, { speaker: "1", text: "Works." }];
    const logCall = (ext: string, durationSec: number, minutesAgo: number, withTranscript: boolean, status = "completed") => asOperator(async (c) => {
      const { recording } = await recordPhoneCall(c, companyId, { externalId: ext, contactId: id, startedAt: new Date(Date.now() - minutesAgo * 60e3), durationSec, direction: "outbound", status, callerGhlUserId: "U1", conversationUrl: "https://app.gohighlevel.com/v2/location/L/conversations/conversations/CCB2" });
      const { recording: row, event } = await settlePhoneCall(c, recording, withTranscript ? { recordingUrl: `https://ghl.test/${ext}/recording`, transcript } : { transcript: null });
      await dispatchEvent(c, event!, { contact: { id }, recording: { id: row.id, ...phoneFacts(row) } });
      return row;
    });
    const lastRun = async () => (await runsFor("setter-call-logged")).filter((x) => x.contact_id === id).at(-1)!;
    // 1. the real thing: 3 minutes, 20 minutes ago, transcript present
    const nRec = recordWrites.length, nRel = relations.length, nAn = analyses.length;
    const row = await logCall("call-1", 184, 20, true);
    expect(row.raw).toMatchObject({ kind: "phone", call_status: "connected", duration_sec: 184, transcript_status: "ready" });
    expect(row.recorded_by_name).toBe("Sam Closer");
    await tick(fake, undefined, companyId); await tick(fake, undefined, companyId);
    const run = await lastRun();
    expect(run).toMatchObject({ status: "completed", exit_reason: "posted" });
    expect(analyses.slice(nAn)).toHaveLength(1);   // the digest; the kind of call is Jev's (D48)
    const rw = recordWrites.slice(nRec); expect(rw).toHaveLength(1);
    expect(rw[0]).toMatchObject({ op: "create", external_id: "call-1", contact_id: "CCB2", direction: "outbound", duration_sec: 184, setter: "Sam Closer", outcome: "connected", recording_url: "https://ghl.test/call-1/recording" });
    expect(rw[0].led_to_booking).toEqual(["yes"]);   // Leo's appointment was booked (by this test run) after the call started → the checkbox is written as the CRM wants it
    expect(relations.slice(nRel)).toEqual([`ASSOC-DC:CCB2>rec-${nRec + 1}`]);
    const slack = await asOperator((c) => one<{ rendered_body: string }>(c, "select rendered_body from sends where run_id=$1 and channel='slack'", [run.id]));
    expect(slack?.rendered_body).toContain("setting"); expect(slack?.rendered_body).toContain("Fit: 8/10"); expect(slack?.rendered_body).toContain("Set — a booking followed this call");
    const stored = await asOperator((c) => one<{ analysis: Record<string, unknown> }>(c, "select analysis from recordings where id=$1", [row.id]));
    expect(Object.keys(stored!.analysis).sort()).toEqual(["classify", "notes"]);
    // 2. a 30-second connect stops before the wait; 3. a connected call nobody recorded stops too; neither reaches the AI
    const nAn2 = analyses.length;
    await logCall("call-2", 30, 20, true); await tick(fake, undefined, companyId); expect(await lastRun()).toMatchObject({ status: "completed", exit_reason: "too_short" });
    await logCall("call-3", 120, 20, false); await tick(fake, undefined, companyId); expect(await lastRun()).toMatchObject({ status: "completed", exit_reason: "no_transcript" });
    expect(analyses.length).toBe(nAn2);
    // 4. "are you joining the call?" → the AI says other → nothing written
    setterCallType = "other"; const nRec4 = recordWrites.length;
    await logCall("call-4", 95, 20, true); await tick(fake, undefined, companyId); await tick(fake, undefined, companyId); setterCallType = "setting";
    expect(await lastRun()).toMatchObject({ status: "completed", exit_reason: "not_a_setting_call" }); expect(recordWrites.length).toBe(nRec4);
    // 5. a call that just ended waits 15 minutes from its END (so the booking the setter makes right after shows up): a 40-minute call that started 42 minutes ago ended 2 minutes ago → ~13 minutes to go
    await logCall("call-5", 2400, 42, true); await tick(fake, undefined, companyId);
    const waiting = await lastRun(); expect(waiting.status).toBe("waiting");
    expect(Math.abs(DateTime.fromJSDate(waiting.next_run_at!).diffNow("minutes").minutes - 13)).toBeLessThan(1.5);
    // 6. a no-answer never starts the workflow at all (trigger wants a connected call)
    const nRuns = (await runsFor("setter-call-logged")).length;
    await logCall("call-6", 0, 20, false, "no-answer"); await tick(fake, undefined, companyId);
    expect((await runsFor("setter-call-logged")).length).toBe(nRuns);
  });

  it("agreements (D30): the chase nudges the owner after 24h with a task; the signature records, closes the deal (either-order gate), and ends the chase; the manual tag sends the agreement", async () => {
    const id = (await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='CCB2'", [companyId])))!.id;
    // 1. the chase started on Leo's first payment and is parked; 24h later: not signed → owner nudged (CRM task; Slack suppressed here: not connected)
    const chase = (await runsFor("agreement-chase")).find((x) => x.contact_id === id)!;
    expect(chase.status).toBe("waiting");
    const nTasks = tasks.length;
    // a wait anchored on "now" pins its answer in the run's context, so fast-forwarding means moving both the wake time and the pin
    const ff = (runId: string, node: string) => asOperator((c) => c.query(`update runs set next_run_at=now() - interval '1 minute', context = jsonb_set(context, $2::text[], to_jsonb($3::text), true) where id=$1`, [runId, `{vars,__wait,${node},until}`, new Date(Date.now() - 60e3).toISOString()]));
    await ff(chase.id, "w1");
    await tick(fake, undefined, companyId);
    const chase2 = (await runsFor("agreement-chase")).find((x) => x.id === chase.id)!;
    expect(chase2).toMatchObject({ status: "waiting", current_node: "w2" });
    expect(tasks.slice(nTasks)).toEqual([expect.objectContaining({ contactId: "CCB2", title: "Chase the unsigned agreement: Leo Park", assignedUserId: "U1" })]);
    const nudge = await asOperator((c) => one<{ rendered_body: string; status: string }>(c, "select rendered_body, status from sends where run_id=$1 and channel='slack' order by scheduled_for desc limit 1", [chase.id]));
    expect(nudge?.status).toBe("suppressed"); expect(nudge?.rendered_body).toContain("Nudge 1 of 3"); expect(nudge?.rendered_body).toContain("Sam Closer");
    // deal-closed stopped at its gate on each of Leo's two payments and released its once-per key both times
    const gated = (await runsFor("deal-closed")).filter((x) => x.contact_id === id);
    expect(gated.map((r) => r.exit_reason)).toEqual(["not_yet", "not_yet"]);
    // 2. the signature: agreement-signed runs; deal-closed runs for real this time
    const nTags = tags.length, nOpp = oppWrites.length, nRec = recordWrites.length, nSent = sent.length;
    const signed = await asOperator((c) => simulate({ c, company: { id: companyId, mode: "live", timezone: TZ } as never, contactId: id, force: true }, "sign"));
    expect(signed.ok).toBe(true); if (!signed.ok) return;
    expect(signed.detail.events).toEqual(["agreement.signed"]);   // the engine sent Leo's agreement on his first payment (send_document recorded it), so the harness completes that same document
    await tick(fake, undefined, companyId); await tick(fake, undefined, companyId);
    expect((await runsFor("agreement-signed")).find((x) => x.contact_id === id)).toMatchObject({ status: "completed", exit_reason: "recorded" });
    const closed = (await runsFor("deal-closed")).filter((x) => x.contact_id === id).at(-1)!;
    expect(closed).toMatchObject({ status: "completed", exit_reason: "closed" });
    expect(tags.slice(nTags).sort()).toEqual(["stat-agreement-signed", "stat-customer"]);   // two workflows, one tick: order between them is not promised
    expect(oppWrites.slice(nOpp)).toEqual(expect.arrayContaining([expect.objectContaining({ op: "update", stageId: "STAGE-WON", status: "won" }), expect.objectContaining({ op: "update", status: "won" })]));
    const rw = recordWrites.slice(nRec); expect(rw.at(-1)).toMatchObject({ op: "update", disposition: "closed_won", outcome: "showed" });
    const welcome = sent.slice(nSent); expect(welcome.map((x) => x.kind)).toEqual(["email"]); expect(welcome[0].body).toContain("Welcome — Let's Get You Ready");   // this company has SMS off, so the welcome text is recorded as skipped, not sent
    const smsRow = await asOperator((c) => one<{ status: string; suppressed_reason: string }>(c, "select status, suppressed_reason from sends where run_id=$1 and channel='sms'", [closed.id]));
    expect(smsRow).toMatchObject({ status: "suppressed", suppressed_reason: expect.stringMatching(/sms_disabled/) });
    // 3. the chase sees the signature at its next check and ends without a second nudge
    await ff(chase.id, "w2");
    await tick(fake, undefined, companyId);
    expect((await runsFor("agreement-chase")).find((x) => x.id === chase.id)).toMatchObject({ status: "completed", exit_reason: "signed" });
    expect(tasks.length).toBe(nTasks + 1);
    // 4. the manual tag on someone unsigned sends the agreement; on Leo (signed) it stops
    const other = (await asOperator((c) => one<{ id: string; ghl_contact_id: string }>(c, "select id, ghl_contact_id from contacts where company_id=$1 and ghl_contact_id='CCB1'", [companyId])))!;
    const nDocs = docSends.length, nTags4 = tags.length;
    for (const who of [other, { id, ghl_contact_id: "CCB2" }]) {
      const ev = await asOperator((c) => emitEvent(c, { company_id: companyId, contact_id: who.id, opportunity_id: null, appointment_id: null, event_type: "tag.added", source: "ghl_poll", data: { tag: "sys-send-agreement-manually" } }));
      await asOperator((c) => dispatchEvent(c, ev, { contact: { id: who.id, ghl_contact_id: who.ghl_contact_id } }));
    }
    await tick(fake, undefined, companyId);
    const manual = (await runsFor("agreement-send-manually")).filter((x) => [other.id, id].includes(x.contact_id));
    expect(manual.map((r) => r.exit_reason).sort()).toEqual(["already_signed", "sent"]);
    expect(docSends.slice(nDocs)).toEqual([{ templateId: "TPL-AGREE", contactId: "CCB1", userId: "U1" }]);
    expect(tags.slice(nTags4)).toEqual(["stat-agreement-sent"]); expect(removedTags.at(-1)).toBe("sys-send-agreement-manually");
  });

  it("deal-closed race: two triggers in the same minute, before any tick — the loser is remembered on the in-flight run and replayed after its gate; a signature arriving with a payment closes once", async () => {
    const who = (await asOperator((c) => one<{ id: string; ghl_contact_id: string }>(c, "select id, ghl_contact_id from contacts where company_id=$1 and ghl_contact_id='CCB1'", [companyId])))!;
    const sim = (a: "pay" | "sign") => asOperator((c) => simulate({ c, company: { id: companyId, mode: "live", timezone: TZ } as never, contactId: who.id, force: true }, a));
    // two payments back to back (deposit, then balance), nothing signed: the second deal-closed trigger loses the once-per race to the first, still-unprocessed run
    expect((await sim("pay")).ok).toBe(true); expect((await sim("pay")).ok).toBe(true);
    const before = (await runsFor("deal-closed")).filter((x) => x.contact_id === who.id);
    expect(before).toHaveLength(1); expect(before[0].status).toBe("active");
    expect((await asOperator((c) => one<{ n: number }>(c, "select jsonb_array_length(pending_events)::int as n from runs where id=$1", [before[0].id])))?.n).toBe(1);
    const r = await tick(fake, undefined, companyId);
    expect(r.replayed).toBe(1);   // the first run stopped at its gate (not signed) and handed the key to the queued trigger
    await tick(fake, undefined, companyId);
    expect((await runsFor("deal-closed")).filter((x) => x.contact_id === who.id).map((x) => x.exit_reason)).toEqual(["not_yet", "not_yet"]);
    // now the signature: a fresh run (key released) sees paid + signed and closes; nothing left pending anywhere
    expect((await sim("sign")).ok).toBe(true);
    await tick(fake, undefined, companyId); await tick(fake, undefined, companyId);
    const after = (await runsFor("deal-closed")).filter((x) => x.contact_id === who.id);
    expect(after.map((x) => x.exit_reason)).toEqual(["not_yet", "not_yet", "closed"]);
    expect(await asOperator((c) => many(c, "select 1 from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where r.company_id=$1 and r.contact_id=$2 and t.slug='deal-closed' and jsonb_array_length(r.pending_events) > 0 and r.status in ('active','waiting')", [companyId, who.id]))).toHaveLength(0);
  });

  it("D53/D58: an unclear reply asks the team (in the bookings channel when no attention channel is bound) and the run does NOT wait: it goes on to the reminders and listens; another booking's tap or a stray emoji changes nothing; ✅ confirms this contact and returns the run to its reminder, 🔁 sends them the rebooking link", async () => {
    // Slack joins the scenarios here, last: the scenarios above assert what happens while it is not connected
    await asOperator(async (c) => {
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'TSCN',$2,'{}')", [companyId, encrypt("xoxb-fake")]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'slack.channel.bookings','channel',$2)", [companyId, Buffer.from("CBOOK")]);
      await c.query("insert into users (company_id, email, name, role, slack_user_id) values ($1,'tyler@x.com','Tyler','owner','UTYLER')", [companyId]);
      await c.query("update companies set sms_enabled=true where id=$1", [companyId]);   // the sms_enabled scenario above left it off
    });
    liveStatus = "confirmed"; replyIntent = "unclear";
    const jeremy = await bookClosing("CJEREMY"), kai = await bookClosing("CKAI");
    await tick(fake, undefined, companyId);   // booking email + text; both park on the reply wait
    for (const id of [jeremy, kai]) { await inbound(id, "hmm maybe idk"); await wake((await preCallRunOf(id)).id); }
    const nPosts = slackPosts.length, nTags = tags.length;
    await tick(fake, DateTime.now().plus({ minutes: 2 }), companyId);   // settled → Jev cannot read it → the question goes to the team → the run goes ON to the reminders, listening
    const asked = slackPosts.slice(nPosts).filter((p) => /replied to the booking text/.test(p.text));
    expect(asked).toHaveLength(2);
    expect(asked[0].text).not.toMatch(/Unclear reply|Keep, cancel or reschedule\?/);   // the persona carries the title; the body does not say it again (item 20)
    expect(asked[0].text).toMatch(/^Sam Closer — (CJEREMY|CKAI) replied to the booking text for the call .*\. Jev couldn't tell what they meant \(its guesses: unclear 95%\)\./);   // the closer is addressed; Jev's confidence is in the body
    expect(asked[0].text).toMatch(/Tap ✅ keep the call, ❌ cancel it, 🔁 reschedule/);
    expect(asked.map((p) => [p.channel, p.threadTs])).toEqual([["CBOOK", undefined], ["CBOOK", undefined]]);   // its own message, in the bookings channel: no attention channel is bound yet
    expect(tags.slice(nTags).filter((t) => t === "stat-needs-attention")).toHaveLength(2);
    const [rj, rk] = [await preCallRunOf(jeremy), await preCallRunOf(kai)];
    expect([rj, rk].map((r) => [r.status, r.current_node])).toEqual([["waiting", "r72"], ["waiting", "r72"]]);   // D58: parked on the next reminder, not on the question
    const qOf = (runId: string) => questionOf(runId);
    expect(await listenerOn(rj.id)).toMatchObject({ wake_on_tag: (await qOf(rj.id)).tag, resume_node: "r72", listen: { node: "w_dec", emojis: ["white_check_mark", "x", "repeat"] } });
    expect(await pendingRead(rj.id)).toMatchObject({ intent: "unclear", confidence: 95, at: expect.any(String) });
    // Kai's ✅ is Kai's: Jeremy's run is not even woken (item 17)
    const parkedUntil = rj.next_run_at!.getTime();
    const kaiQ = await qOf(rk.id);
    expect(await tap(kaiQ.ts, "white_check_mark")).toMatchObject({ runs_woken: 1, runs_started: 0 });
    expect((await preCallRunOf(jeremy)).next_run_at!.getTime()).toBe(parkedUntil);
    // 👀 on Jeremy's question is not one of the three offered: the run wakes, finds no decision, and goes back to sleep on the same reminder
    expect(await tap((await qOf(rj.id)).ts, "eyes")).toMatchObject({ runs_woken: 1 });
    const nTags2 = tags.length, nSent = since(), nP2 = slackPosts.length, nUn = unreacted.length, nRe = reacted.length;
    await tick(fake, undefined, companyId);
    expect(await preCallRunOf(jeremy)).toMatchObject({ status: "waiting", current_node: "r72", next_run_at: new Date(parkedUntil) });
    expect(await listenerOn(rj.id)).toMatchObject({ wake_on_tag: (await qOf(rj.id)).tag, listen: { node: "w_dec" } });   // still listening
    expect(await preCallRunOf(kai)).toMatchObject({ status: "waiting", current_node: "r72", next_run_at: rk.next_run_at });   // confirmed, and back on the very reminder it was parked on, due as before
    expect(await listenerOn(rk.id)).toMatchObject({ wake_on_tag: null, resume_node: null, listen: null });   // the listener is spent
    expect(tags.slice(nTags2)).toEqual(["stat-confirmed"]); expect(removedTags.slice(-2)).toEqual(["stat-needs-attention", "stat-unconfirmed"]);
    expect(await pendingRead(rk.id)).toBeNull();
    expect(slackPosts.slice(nP2).map((p) => p.text)).toEqual([expect.stringMatching(/^✅ CKAI's call .* is confirmed\.\n> hmm maybe idk\nDecided by Tyler$/)]);
    expect(unreacted.slice(nUn)).toEqual(["white_check_mark", "x", "repeat"].map((e) => `${kaiQ.ts}:${e}`));   // the bot's own three come off Kai's question, not Jeremy's
    expect(reacted.slice(nRe)).toContain(`${kaiQ.ts}:white_check_mark`);   // and the outcome goes on the question, so the channel shows it at a glance
    // D55: the tap scores Jev, with how sure it was — unclear never agrees
    expect(await reviewed(kai)).toEqual([{ predicted: "unclear", predicted_confidence: 95, decided: "confirmed", agreed: false, decided_by: "Tyler", appointment_id: expect.any(String) }]);
    expect(await reviewed(jeremy)).toEqual([]);
    // Jeremy's team taps 🔁: Jeremy gets the rebooking link and the run ends as a reschedule
    expect(await tap((await qOf(rj.id)).ts, "repeat")).toMatchObject({ runs_woken: 1 });
    await tick(fake, undefined, companyId);
    expect(await preCallRunOf(jeremy)).toMatchObject({ status: "completed", exit_reason: "reschedule_sent" });
    expect(sent.slice(nSent).filter((x) => x.kind === "sms").map((x) => [x.to, x.body])).toEqual([["CJEREMY", expect.stringMatching(/^No problem — grab a new time here/)]]);
    expect(await reviewed(jeremy)).toEqual([{ predicted: "unclear", predicted_confidence: 95, decided: "reschedule_request", agreed: false, decided_by: "Tyler", appointment_id: expect.any(String) }]);
    expect(await tagsOn(jeremy)).not.toContain("stat-needs-attention");
    const evs = await asOperator((c) => many<{ data: { kind: string; reaction: string; user_name: string; ref: string } }>(c, "select data from events where company_id=$1 and event_type='slack.reaction' order by id", [companyId]));
    expect(evs.map((e) => [e.data.kind, e.data.reaction, e.data.user_name])).toEqual([["decision", "white_check_mark", "Tyler"], ["decision", "eyes", "Tyler"], ["decision", "repeat", "Tyler"]]);
    replyIntent = "confirmed";
  });

  it("D55/D58: a reply Jev reads as a cancel cancels nothing: the closer is asked in the attention channel with Jev's confidence while the reminders go on; ❌ pulls the run from its reminder, cancels the call, tells the thread who decided, reacts ❌ on the question and scores Jev as right", async () => {
    await asOperator((c) => c.query("insert into bindings (company_id,key,kind,value) values ($1,'slack.channel.attention','channel',$2)", [companyId, Buffer.from("CATTN")]));
    replyIntent = "cancelled";
    const maya = await bookClosing("CMAYA");
    await tick(fake, undefined, companyId);
    const run = await preCallRunOf(maya);
    await inbound(maya, "I need to cancel my appointment"); await wake(run.id);
    const nPosts = slackPosts.length, nSent = since();
    await tick(fake, DateTime.now().plus({ minutes: 2 }), companyId);
    const asked = slackPosts.slice(nPosts).filter((p) => /replied to the booking text/.test(p.text));
    expect(asked.map((p) => [p.channel, p.threadTs, p.text])).toEqual([["CATTN", undefined, expect.stringMatching(/^Sam Closer — CMAYA replied to the booking text for the call .*\. Jev is 95% sure they want to cancel\.\n\*We sent:\*\n> .*\n\*They wrote:\*\n> I need to cancel my appointment\nTap ✅ keep the call, ❌ cancel it, 🔁 reschedule .*The reminders keep going until you do\.$/)]]);
    const parked = await preCallRunOf(maya);
    expect(parked).toMatchObject({ status: "waiting", current_node: "r72" });   // the reminders go on
    expect(await listenerOn(run.id)).toMatchObject({ wake_on_tag: `decision:${run.appointment_id}`, resume_node: "r72" });
    expect(await tagsOn(maya)).toContain("stat-needs-attention");
    expect(await pendingRead(run.id)).toMatchObject({ intent: "cancelled", confidence: 95 });
    expect(await apptStatus(run.id)).toBe("confirmed");   // nothing touched the appointment
    expect(since()).toBe(nSent);                          // and nothing was texted
    expect(await reviewed(maya)).toEqual([]);
    const q = await questionOf(run.id);
    expect(await tap(q.ts, "x")).toMatchObject({ runs_woken: 1 });
    const nP2 = slackPosts.length, nRe = reacted.length;
    await tick(fake, undefined, companyId);
    expect(await preCallRunOf(maya)).toMatchObject({ status: "completed", exit_reason: "cancelled" });
    expect(await apptStatus(run.id)).toBe("cancelled");
    expect(slackPosts.slice(nP2).map((p) => [p.channel, p.text, p.threadTs])).toEqual([["CBOOK", "❌ CMAYA's call is cancelled.\n> I need to cancel my appointment\nDecided by Tyler", expect.any(String)]]);   // the outcome line stays in the booking thread
    expect(reacted.slice(nRe)).toEqual([expect.stringMatching(/:x$/), `${q.ts}:x`]);   // ❌ on the booking post, then on the question
    expect(since()).toBe(nSent);
    expect(await reviewed(maya)).toEqual([{ predicted: "cancelled", predicted_confidence: 95, decided: "cancelled", agreed: true, decided_by: "Tyler", appointment_id: run.appointment_id }]);
    expect(await tagsOn(maya)).not.toContain("stat-needs-attention"); expect(await pendingRead(run.id)).toBeNull();
    const steps = await asOperator((c) => many<{ node_id: string; result: Record<string, unknown> }>(c, "select node_id, result from run_steps where run_id=$1 and node_id='w_dec' order by started_at", [run.id]));
    expect(steps.map((x) => x.result)).toEqual([expect.objectContaining({ listening: `decision:${run.appointment_id}` }), expect.objectContaining({ listener: "tap", reaction: "x", by: "Tyler", interrupted: "r72" })]);   // the run page shows the arming and the jump
    replyIntent = "confirmed";
  });

  it("D55/D58: a reply Jev reads as a reschedule sends no rebooking link on its own; ✅ keeps the call (confirmed tags, ✅ in the thread), scores Jev as wrong and puts the run back on the reminder it was parked on, due as before", async () => {
    replyIntent = "reschedule_request";
    const noah = await bookClosing("CNOAH");
    await tick(fake, undefined, companyId);
    const run = await preCallRunOf(noah);
    await inbound(noah, "can we do tuesday instead"); await wake(run.id);
    const nPosts = slackPosts.length, nSent = since();
    await tick(fake, DateTime.now().plus({ minutes: 2 }), companyId);
    const asked = slackPosts.slice(nPosts).filter((p) => /replied to the booking text/.test(p.text));
    expect(asked.map((p) => p.text)).toEqual([expect.stringMatching(/Jev is 95% sure they want to reschedule\./)]);
    const parked = await preCallRunOf(noah);
    expect(parked).toMatchObject({ status: "waiting", current_node: "r72" });
    expect(since()).toBe(nSent);   // no rebooking link until a person says so
    expect(await tap((await questionOf(run.id)).ts, "white_check_mark")).toMatchObject({ runs_woken: 1 });
    const nTags = tags.length, nP2 = slackPosts.length;
    await tick(fake, undefined, companyId);
    expect(await preCallRunOf(noah)).toMatchObject({ status: "waiting", current_node: "r72", next_run_at: parked.next_run_at });   // `resume`: the same reminder, the same due time
    expect(tags.slice(nTags)).toEqual(["stat-confirmed"]); expect(removedTags.slice(-2)).toEqual(["stat-needs-attention", "stat-unconfirmed"]);
    expect(slackPosts.slice(nP2).map((p) => p.text)).toEqual([expect.stringMatching(/^✅ CNOAH's call .* is confirmed\.\n> can we do tuesday instead\nDecided by Tyler$/)]);
    expect(since()).toBe(nSent);
    expect(await apptStatus(run.id)).toBe("confirmed");
    expect(await reviewed(noah)).toEqual([{ predicted: "reschedule_request", predicted_confidence: 95, decided: "confirmed", agreed: false, decided_by: "Tyler", appointment_id: run.appointment_id }]);
    replyIntent = "confirmed";
  });

  it("D58: nobody taps by the call: the listener disarms, stat-needs-attention comes off, intent.unanswered is recorded with Jev's confidence and the reminders go on; the pending read stays, so a no-show filed that evening is a possible cancel (stat-possible-cancel, intent.unanswered_no_show)", async () => {
    replyIntent = "cancelled";
    const zoe = await bookClosing("CZOE");
    await tick(fake, undefined, companyId);
    const run = await preCallRunOf(zoe);
    await inbound(zoe, "cancel please"); await wake(run.id);
    await tick(fake, DateTime.now().plus({ minutes: 2 }), companyId);
    expect(await preCallRunOf(zoe)).toMatchObject({ status: "waiting", current_node: "r72" });
    expect(await tagsOn(zoe)).toContain("stat-needs-attention");
    // the call time comes with no tap (the clock moves; the booking source still has the call, so the premise holds)
    const startsAt = DateTime.fromJSDate((await asOperator((c) => one<{ starts_at: Date }>(c, "select starts_at from appointments where id=$1", [run.appointment_id])))!.starts_at);
    await wake(run.id); const nSent = since();
    await tick(fake, startsAt.plus({ minutes: 1 }) as DateTime<true>, companyId);
    expect(await preCallRunOf(zoe)).toMatchObject({ status: "completed", exit_reason: "done" });   // the reminders ran their course (the stale ones skipped, the 10-minute text went)
    expect(await listenerOn(run.id)).toMatchObject({ wake_on_tag: null, resume_node: null, listen: null });
    expect(await tagsOn(zoe)).not.toContain("stat-needs-attention");
    expect(await reviewed(zoe)).toEqual([]);
    expect(await reviewed(zoe, "intent.unanswered")).toEqual([{ predicted: "cancelled", predicted_confidence: 95, hours_before_call: expect.any(Number), appointment_id: run.appointment_id }]);
    expect(await pendingRead(run.id)).toMatchObject({ intent: "cancelled", confidence: 95 });   // kept: nobody said otherwise
    expect(since()).toBeGreaterThan(nSent);
    // the closer files the day: no-show → Call outcome filed marks it, and because Jev had read a cancel nobody answered, a possible cancel
    const noshow = await asOperator((c) => one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_outcome' and category='noshow'", [companyId]));
    await asOperator((c) => recordDisposition(c, { companyId, appointmentId: run.appointment_id, outcomeTermId: noshow!.id }));
    const nTags = tags.length;
    await tick(fake, undefined, companyId);
    expect((await runsFor("call-outcome")).filter((r) => r.contact_id === zoe).map((r) => [r.status, r.exit_reason])).toEqual([["completed", "noted"]]);
    expect(tags.slice(nTags)).toEqual(["stat-no-show", "stat-possible-cancel"]);
    expect(await reviewed(zoe, "intent.unanswered_no_show")).toEqual([{ predicted: "cancelled", predicted_confidence: 95, asked_at: expect.any(String), appointment_id: run.appointment_id }]);
    // a no-show with no pending read is just a no-show
    liveStatus = "confirmed"; replyIntent = "confirmed";
    const ian = await bookClosing("CIAN"); await tick(fake, undefined, companyId);
    const ianRun = await preCallRunOf(ian);
    await asOperator((c) => recordDisposition(c, { companyId, appointmentId: ianRun.appointment_id, outcomeTermId: noshow!.id }));
    const nTags2 = tags.length; await tick(fake, undefined, companyId);
    expect(tags.slice(nTags2)).toEqual(["stat-no-show"]);
    expect(await reviewed(ian, "intent.unanswered_no_show")).toEqual([]);
  });
});
