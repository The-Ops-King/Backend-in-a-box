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
import type { Adapters, AppointmentSnapshot, Classification, BookingRead } from "@/adapters/types";
import { recordRecording, linkRecording, recordPhoneCall, settlePhoneCall, phoneFacts, type RecordingInput } from "@/engine/recordings";
import { simulate } from "@/engine/simulate";

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
const fake: Adapters = {
  read: {
    contactsChangedSince: async () => [], inboundSince: async () => [], callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [],
    getContact: async (_c, id) => ({ id, firstName: id, tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString() }),
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
  classifier: { choice: async (): Promise<Classification> => ({ value: "confirmed", confidence: 0.95, distribution: { confirmed: 0.95 }, unclear: false }) },
  notifier: { post: async () => ({ ts: "1" }), lookupUserByEmail: async () => null },
  // answers by which prompt is asked, the way the real model would: classify → is it a sales call, notes → the write-up, rubric → the score
  analyst: { analyze: async (_k, req) => { analyses.push(req.system.slice(0, 40)); const parsed = /setters and leads/.test(req.system) ? { call_type: setterCallType, confidence: 0.9, reason: "qualifying toward a booking" }
    : /setter phone calls/.test(req.system) ? { summary: "Thinning for a year, wants it handled; asked about price and took Thursday at two.", pains: "getting worse for about a year", goals: "feel like himself again", triage: "", fit_quality: 8, digest: "Thinning for a year, wants it handled; asked about price and took Thursday at two.\nPains: getting worse for about a year\nGoals: feel like himself again\nFit: 8/10 — named the problem, a timeline and asked about price" }
    : /sales call:/.test(req.system) ? { is_sales_call: salesCall, call_kind: "closing", confidence: 0.96, reason: "prospect discussed buying" }
    : /note-taker/.test(req.system) ? { summary: "Wants to fix thinning; decided to start.", pain: ["thinning at the crown"], objections: [{ objection: "price", quote: "that is a lot right now", handled: true }], disposition: "closed_won", primary_objection: "price", next_step: "onboarding call", quotes: ["I just want it to stop"] }
    : { overall_score: 8, scores: { discovery: 9 }, strengths: ["asked about timeline"], misses: ["no urgency close"], coaching: ["ask for the card earlier"] };
    return { text: JSON.stringify(parsed), parsed, model: "fake", usage: { input: 1000, output: 100, cacheRead: 0 } }; } },
};
const analyses: string[] = [];
let salesCall = true;
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
const newContact = async (ghlId: string, email: string) => asOperator(async (c) => {
  const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, timezone) values ($1,$2,$3,$4) returning id", [companyId, ghlId, ghlId, TZ]))!.id;
  await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [companyId, id, email]);
  return id;
});
const withPhone = (contactId: string, phone: string) => asOperator((c) => c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone',$3)", [companyId, contactId, phone]));
const inbound = (contactId: string, body: string) => asOperator((c) => c.query("insert into messages (company_id, contact_id, ghl_message_id, channel, direction, body, occurred_at) values ($1,$2,$3,'sms','inbound',$4,now())", [companyId, contactId, `m${Math.random()}`, body]));
let companyId: string;

describe.skipIf(!HAS_DB)("template scenarios", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='scn'");
      if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        await c.query("update appointments set disposition_id=null where company_id=$1", [co.id]);
        for (const t of ["agreements", "sends", "runs", "events", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "recordings", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]); }
    });
    const r = await installCompany({ name: "Scenarios", slug: "scn", timezone: TZ, locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" }, enable: true, mode: "live",
      crm: { pipeline_setter: "PIPE-SETTER", stage_setter_new_lead: "STAGE-NEW", field_opportunity_stage_entered: "CF-STAGE-DATE", pipeline_closer: "PIPE-CLOSER", stage_setter_direct_booked: "STAGE-DIRECT", stage_setter_appointment_set: "STAGE-SET", stage_closer_scheduled: "STAGE-SCHED", stage_setter_cancelled: "STAGE-S-CANCEL", stage_closer_cancelled: "STAGE-C-CANCEL", field_contact_appointment_date: "CF-APPT-DATE", field_contact_setter: "CF-SETTER", field_opportunity_setter_owner: "CF-SETTER-OWNER", assoc_discovery_call_contact: "ASSOC-DC", agreement_template: "TPL-AGREE", agreement_sender: "U1", default_closer: "U1", stage_closer_agreement_sent: "STAGE-AGREE", stage_closer_closed_won: "STAGE-WON",
        field_contact_cash_collected: "CF-CASH", field_contact_revenue_generated: "CF-REV", assoc_payment_contact: "ASSOC-PC", assoc_payment_opportunity: "ASSOC-PO",
        stage_setter_showed: "STAGE-SHOWED", assoc_sales_call_contact: "ASSOC-SC", assoc_sales_call_opportunity: "ASSOC-SO" }, contractValueDefault: 2999, anthropicKey: "sk-ant-fake" }, fake);
    companyId = r.companyId;
    await asOperator((c) => c.query("update companies set send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId]));
    // (ticks below are scoped to this company: the test database is shared with the other suites)
    // the test database is shared with the other suites; park their leftover runs so this file's ticks only ever send for this company
    expect(r.installed.filter((s) => s.endsWith("enabled"))).toHaveLength(19);
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
    const n2 = since(); await tick(fake, undefined, companyId);
    rs = await runsFor("speed-to-lead");
    expect(rs.find((r) => r.contact_id === a)?.exit_reason).toBe("replied"); expect(tags).toContain("engaged");
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

  it("payment-received: thank-you email + client tag; opportunity becomes a deal", async () => {
    const cns = await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='CNS'", [companyId]));
    await asOperator(async (c) => { const ev = await applyPayment(c, companyId, cns!.id, { whopPaymentId: "P1", amount: 2500, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); await dispatchEvent(c, ev, { contact: { id: cns!.id } }); });
    const n = since(); await tick(fake, undefined, companyId);
    expect(sent.slice(n).map((s) => s.body)).toEqual([expect.stringMatching(/^You're in/)]); expect(tags).toContain("client");
    expect((await runsFor("payment-received"))[0].exit_reason).toBe("done");
    const opp = await asOperator((c) => one<{ status: string }>(c, "select status from opportunities where company_id=$1 and contact_id=$2", [companyId, cns!.id]));
    expect(opp?.status).toBe("won");
  });

  it("payment-failed: SMS + email, two days, Slack skipped cleanly when not connected", async () => {
    const cns = await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='CNS'", [companyId]));
    await asOperator(async (c) => { const ev = await applyPayment(c, companyId, cns!.id, { whopPaymentId: "P2", amount: 2500, currency: "USD", status: "failed", paidAt: new Date(), raw: {} }); await dispatchEvent(c, ev, { contact: { id: cns!.id } }); });
    const n = since(); await tick(fake, undefined, companyId);
    expect(sent.slice(n).map((s) => s.kind).sort()).toEqual(["email", "sms"]);
    let r = (await runsFor("payment-failed"))[0]; expect(r.current_node).toBe("n3"); expect(DateTime.fromJSDate(r.next_run_at!).diffNow("days").days).toBeGreaterThan(1.9);
    await expireWait(r.id, "n3"); await tick(fake, undefined, companyId);
    r = (await runsFor("payment-failed"))[0]; expect(r.exit_reason).toBe("escalated");
    const slack = await asOperator((c) => one<{ status: string; suppressed_reason: string }>(c, "select status, suppressed_reason from sends where run_id=$1 and channel='slack'", [r.id]));
    expect(slack?.status).toBe("suppressed"); expect(slack?.suppressed_reason).toMatch(/unbound: slack/);
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
    const id = await newContact("CSHADOW", "shadow@x.com");
    await asOperator(async (c) => { const ev = await applyPayment(c, companyId, id, { whopPaymentId: "P9", amount: 100, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); await dispatchEvent(c, ev, { contact: { id } }); });
    const n = since(), nt = tags.length; await tick(fake, undefined, companyId);
    expect(sent.length).toBe(n);            // the fake sender was never called
    expect(tags.length).toBe(nt);           // the fake CRM never got the tag
    const r = (await runsFor("payment-received")).find((r) => r.contact_id === id)!;
    expect(r.exit_reason).toBe("done");     // but the run went all the way through
    const ledger = await asOperator((c) => many<{ status: string; rendered_body: string }>(c, "select status, rendered_body from sends where run_id=$1", [r.id]));
    expect(ledger).toEqual([{ status: "shadow", rendered_body: expect.stringMatching(/Payment came through/) }]);
    const local = await asOperator((c) => one<{ tags: string[] }>(c, "select tags from contacts where id=$1", [id]));
    expect(local?.tags).not.toContain("client");   // shadow touches neither GHL nor our replica of GHL's tags
    const logged = await asOperator((c) => one<{ data: { shadow?: boolean } }>(c, "select data from events where run_id=$1 and event_type='tag.added'", [r.id]));
    expect(logged?.data.shadow).toBe(true);        // but the journey records what would have happened
    await asOperator((c) => c.query("update companies set mode='live' where id=$1", [companyId]));
  });

  it("an inbound text wakes a reply-wait but not a timed wait (a reminder parked for 8am stays parked)", async () => {
    const id = await newContact("CWAKE", "wake@x.com");
    const snapA: AppointmentSnapshot = { id: "AWAKE", calendarId: "CAL", contactId: "CWAKE", assignedUserId: "U1", startTime: DateTime.now().plus({ days: 2 }).set({ hour: 14, minute: 0 }).toISO()!, endTime: DateTime.now().plus({ days: 2 }).set({ hour: 14, minute: 30 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), raw: {} };
    apptStore.set("AWAKE", snapA);
    await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, snapA); });
    await tick(fake, undefined, companyId);
    const rem = (await runsFor("appointment-reminder")).find((r) => r.contact_id === id)!;
    expect(rem.status).toBe("waiting"); const parkedUntil = rem.next_run_at!.getTime(); expect(parkedUntil - Date.now()).toBeGreaterThan(3600e3);
    const flags = await asOperator((c) => many<{ wake_on_reply: boolean; current_node: string }>(c, "select wake_on_reply, current_node from runs where contact_id=$1 and status='waiting' order by current_node", [id]));
    expect(flags.find((f) => f.current_node === "n1")?.wake_on_reply).toBe(false);   // the reminder's timed wait
    // simulate what pollInbound does on an inbound message for this contact
    await asOperator((c) => c.query("update runs set next_run_at=now() where company_id=$1 and contact_id=$2 and status='waiting' and wake_on_reply", [companyId, id]));
    const after = (await runsFor("appointment-reminder")).find((r) => r.contact_id === id)!;
    expect(after.next_run_at!.getTime()).toBe(parkedUntil);   // untouched
  });

  it("a redelivered payment webhook records nothing new and starts nothing", async () => {
    const id = await newContact("CDUP", "dup@x.com");
    const pay = () => asOperator(async (c) => { const ev = await applyPayment(c, companyId, id, { whopPaymentId: "PDUP", amount: 50, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); return ev.id === -1 ? [] : dispatchEvent(c, ev, { contact: { id } }); });
    expect(await pay()).toHaveLength(4);   // payment-received (customer-facing), payment-recorded (CRM side), deal-closed (gate: not signed yet) and the unsigned-agreement chase all start
    expect(await pay()).toHaveLength(0);
    const evs = await asOperator((c) => many(c, "select 1 from events where contact_id=$1 and event_type='payment.received'", [id]));
    expect(evs).toHaveLength(1);
    await tick(fake, undefined, companyId); await tick(fake, undefined, companyId);   // flush what this started so later tests' send counts are their own (the chase parks itself for 24h)
  });

  it("new-lead: a lead with a phone gets a setter-pipeline card named 'Name -- New' with today's stage date, and the tag stat-new; without a phone, the run exits no_phone", async () => {
    const withNum = await newContact("CNL1", "nl1@x.com"); await withPhone(withNum, "+16025550101");
    await asOperator((c) => c.query("update contacts set first_name='Edwin', last_name='Ruh' where id=$1", [withNum]));
    const noNum = await newContact("CNL2", "nl2@x.com");
    for (const id of [withNum, noNum]) await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "ghl_poll", data: {} }), { contact: { id } }));
    const nTags = tags.length, nOpps = oppWrites.length;
    await tick(fake, undefined, companyId);
    const runs = await runsFor("new-lead");
    expect(runs.find((r) => r.contact_id === withNum)).toMatchObject({ status: "completed", exit_reason: "done" });
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
    expect(oppWrites.slice(nOpp)).toEqual([expect.objectContaining({ op: "create", pipelineId: "PIPE-CLOSER", stageId: "STAGE-SCHED", name: "Mia Ortiz -- Direct", assignedUserId: "U1" })]);   // no setter card existed → nothing to move, nothing created
    expect(tags.slice(nTags)).toEqual(["stat-booked", "stat-self-booked"]);
    expect(removedTags.slice(nRm)).toEqual(["seq-no-show", "seq-nurture", "seq-winback"]);
    expect(contactWrites.slice(nCw)).toEqual([expect.objectContaining({ id: "CCB1", assignedUserId: "U1", customFields: [{ id: "CF-APPT-DATE", field_value: start.setZone(TZ).toFormat("yyyy-MM-dd") }] })]);
    const steps = await asOperator((c) => many<{ node_id: string; status: string; result: Record<string, unknown> }>(c, "select node_id, status, result from run_steps where run_id=$1 order by started_at", [r.id]));
    expect(steps.find((x) => x.node_id === "s3")?.status).toBe("skipped");
    expect(steps.find((x) => x.node_id === "n4")?.status).toBe("skipped");   // Slack not connected in this company
    const slack = await asOperator((c) => one<{ suppressed_reason: string }>(c, "select suppressed_reason from sends where run_id=$1 and channel='slack'", [r.id]));
    expect(slack?.suppressed_reason).toMatch(/unbound: slack/);
    const cards = await asOperator((c) => many<{ ghl_pipeline_id: string; opportunity_id: string }>(c, "select ghl_pipeline_id, opportunity_id from pipeline_cards where company_id=$1 and contact_id=$2", [companyId, id]));
    const appt = await asOperator((c) => one<{ opportunity_id: string }>(c, "select opportunity_id from appointments where company_id=$1 and external_id='ACB1'", [companyId]));
    expect(cards).toHaveLength(1); expect(cards[0].opportunity_id).toBe(appt!.opportunity_id);   // one pursuit: the appointment and the card share it
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
    expect(tags.slice(nTags)).toEqual(["stat-booked", "stat-set"]);
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
    expect(oppWrites.slice(nOpp)).toEqual([expect.objectContaining({ op: "update", stageId: "STAGE-C-CANCEL", name: "Mia Ortiz -- Cancelled" })]);   // setter card absent → skipped, never created
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
    const notClient = (t: string) => t !== "client";   // payment-received (the customer-facing template) also runs here and tags client
    expect(tags.slice(nTags).filter(notClient)).toEqual(["pay-plan-active", "stat-agreement-sent"]); expect(removedTags.slice(nRm)).toEqual([]);   // first payment, nothing signed → the agreement goes out
    expect(docSends.at(-1)).toEqual({ templateId: "TPL-AGREE", contactId: "CCB2", userId: "U1" });
    const rec = recordWrites.slice(nRec); expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ op: "create", transaction_id: "pay_leo_1", amount: 1500, type: "deposit", status: "succeeded", processor: "whop", contact_id: "CCB2", closer: "Sam Closer", setter: "Luis" });
    expect(String(rec[0].opportunity_id)).toMatch(/^ghl-opp-/);   // the closer card's CRM id
    expect(relations.slice(nRel)).toEqual([`ASSOC-PC:CCB2>rec-${nRec + 1}`, `ASSOC-PO:rec-${nRec + 1}>${rec[0].opportunity_id}`]);
    // second payment clears the deal: revenue generated is already stamped (our replica learned the first write), so only cash collected moves; tags flip
    const nTags2 = tags.length, nRm2 = removedTags.length, nRec2 = recordWrites.length;
    await asOperator(async (c) => { const ev = await applyPayment(c, companyId, id, { whopPaymentId: "pay_leo_2", amount: 1499, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); await dispatchEvent(c, ev, { contact: { id } }); });
    await tick(fake, undefined, companyId);
    r = (await runsFor("payment-recorded")).filter((x) => x.contact_id === id).at(-1)!;
    expect(r.status).toBe("completed");
    expect(tags.slice(nTags2).filter(notClient)).toEqual(["pay-paid-full"]); expect(removedTags.slice(nRm2)).toEqual(["pay-plan-active"]);
    expect(recordWrites.slice(nRec2)[0]).toMatchObject({ op: "create", transaction_id: "pay_leo_2", type: "balance" });
    const ours = await asOperator((c) => many<{ record_key: string; ghl_record_id: string }>(c, "select record_key, ghl_record_id from crm_records where company_id=$1 and contact_id=$2 and object_key='custom_objects.payment' order by created_at", [companyId, id]));
    expect(ours.map((x) => x.record_key)).toEqual(["pay_leo_1", "pay_leo_2"]);
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
    expect(analyses.slice(nAn)).toHaveLength(3);
    expect(tags.slice(nTags)).toEqual(["stat-showed"]);
    expect(oppWrites.slice(nOpp)).toEqual([expect.objectContaining({ op: "update", stageId: "STAGE-SHOWED", status: "won" })]);   // the setter card; the closer card is untouched
    const setterCard = await asOperator((c) => one<{ status: string; ghl_stage_id: string }>(c, "select status, ghl_stage_id from pipeline_cards where company_id=$1 and contact_id=$2 and ghl_pipeline_id='PIPE-SETTER'", [companyId, id]));
    expect(setterCard).toEqual({ status: "won", ghl_stage_id: "STAGE-SHOWED" });
    const rw = recordWrites.slice(nRec); expect(rw).toHaveLength(1);
    expect(rw[0]).toMatchObject({ op: "create", external_id: appt.external_id, outcome: "showed", contact_id: "CCB2", closer: "Sam Closer", duration_min: 43, disposition: "closed_won", objection_primary: "price", recording_url: "https://fathom.video/share/abc" });
    expect(relations.slice(nRel)).toEqual([`ASSOC-SC:CCB2>rec-${nRec + 1}`, `ASSOC-SO:rec-${nRec + 1}>${rw[0].opportunity_id}`]);
    const a = await asOperator((c) => one<{ outcome: string | null }>(c, "select t.category as outcome from appointments a left join company_terms t on t.id=a.outcome_term where a.id=$1", [appt.id]));
    expect(a?.outcome).toBe("showed");
    const evs = await asOperator((c) => many<{ event_type: string }>(c, "select event_type from events where company_id=$1 and contact_id=$2 and event_type in ('appointment.outcome','call.held','call.analyzed') order by id", [companyId, id]));
    expect(evs.map((e) => e.event_type)).toEqual(["call.analyzed", "call.analyzed", "call.analyzed", "appointment.outcome", "call.held"]);
    const stored = await asOperator((c) => one<{ analysis: Record<string, unknown> }>(c, "select analysis from recordings where id=$1", [r.recording.id]));
    expect(Object.keys(stored!.analysis).sort()).toEqual(["classify", "notes", "rubric"]);
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
    expect(analyses.slice(nAn)).toHaveLength(2);
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
    // 5. a call that just ended waits for its 15 minutes (so the booking the setter makes right after shows up)
    await logCall("call-5", 200, 2, true); await tick(fake, undefined, companyId);
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
});
