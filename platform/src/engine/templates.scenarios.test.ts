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
import { recordRecording, linkRecording, type RecordingInput } from "@/engine/recordings";

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
const fake: Adapters = {
  read: {
    contactsChangedSince: async () => [], inboundSince: async () => [], opportunitiesSince: async () => [],
    getContact: async (_c, id) => ({ id, firstName: id, tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString() }),
    listUsers: async () => [{ id: "U1", name: "Sam Closer", email: "sam@x.com" }],
  },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [],
    getAppointment: async (_c, id) => { const a = apptStore.get(id); return a ? { ...a, status: liveStatus } : null; },
    listCalendars: async () => [{ id: "CAL", name: "Closer Call", teamMemberIds: ["U1"] }] }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async (_c, _id, t) => { tags.push(t); }, removeTag: async (_c, _id, t) => { removedTags.push(t); }, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async (_c, id, patch) => { contactWrites.push({ id, ...patch }); }, createTask: async (_c, id, task) => { tasks.push({ contactId: id, ...task }); return { id: `task-${tasks.length}` }; }, createRecord: async (_c, _o, props) => { recordWrites.push({ op: "create", ...props }); return { id: `rec-${recordWrites.length}` }; }, updateRecord: async (_c, _o, id, props) => { recordWrites.push({ op: "update", id, ...props }); }, relateRecords: async (_c, a, f, s) => { relations.push(`${a}:${f}>${s}`); },
    createOpportunity: async (_c, input) => { oppWrites.push({ op: "create", ...input }); return { id: `ghl-opp-${oppWrites.length}` }; },
    updateOpportunity: async (_c, id, patch) => { oppWrites.push({ op: "update", id, ...patch }); } },
  sender: {
    sendSms: async (_c, to, body) => { sent.push({ kind: "sms", to, body }); return { externalId: `s${sent.length}`, accepted: true }; },
    sendEmail: async (_c, to, subject, html) => { sent.push({ kind: "email", to, body: `${subject}|${html}` }); return { externalId: `e${sent.length}`, accepted: true }; },
    deliveryStatus: async () => ({ status: "sent" }),
  },
  classifier: { choice: async (): Promise<Classification> => ({ value: "confirmed", confidence: 0.95, distribution: { confirmed: 0.95 }, unclear: false }) },
  notifier: { post: async () => ({ ts: "1" }) },
  // answers by which prompt is asked, the way the real model would: classify → is it a sales call, notes → the write-up, rubric → the score
  analyst: { analyze: async (_k, req) => { analyses.push(req.system.slice(0, 40)); const parsed = /sales call:/.test(req.system) ? { is_sales_call: salesCall, call_kind: "closing", confidence: 0.96, reason: "prospect discussed buying" }
    : /note-taker/.test(req.system) ? { summary: "Wants to fix thinning; decided to start.", pain: ["thinning at the crown"], objections: [{ objection: "price", quote: "that is a lot right now", handled: true }], disposition: "closed_won", primary_objection: "price", next_step: "onboarding call", quotes: ["I just want it to stop"] }
    : { overall_score: 8, scores: { discovery: 9 }, strengths: ["asked about timeline"], misses: ["no urgency close"], coaching: ["ask for the card earlier"] };
    return { text: JSON.stringify(parsed), parsed, model: "fake", usage: { input: 1000, output: 100, cacheRead: 0 } }; } },
};
const analyses: string[] = [];
let salesCall = true;
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
        for (const t of ["sends", "runs", "events", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "recordings", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]); }
    });
    const r = await installCompany({ name: "Scenarios", slug: "scn", timezone: TZ, locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" }, enable: true, mode: "live",
      crm: { pipeline_setter: "PIPE-SETTER", stage_setter_new_lead: "STAGE-NEW", field_opportunity_stage_entered: "CF-STAGE-DATE", pipeline_closer: "PIPE-CLOSER", stage_setter_direct_booked: "STAGE-DIRECT", stage_setter_appointment_set: "STAGE-SET", stage_closer_scheduled: "STAGE-SCHED", stage_setter_cancelled: "STAGE-S-CANCEL", stage_closer_cancelled: "STAGE-C-CANCEL", field_contact_appointment_date: "CF-APPT-DATE", field_contact_setter: "CF-SETTER", field_opportunity_setter_owner: "CF-SETTER-OWNER",
        field_contact_cash_collected: "CF-CASH", field_contact_revenue_generated: "CF-REV", assoc_payment_contact: "ASSOC-PC", assoc_payment_opportunity: "ASSOC-PO",
        stage_setter_showed: "STAGE-SHOWED", assoc_sales_call_contact: "ASSOC-SC", assoc_sales_call_opportunity: "ASSOC-SO" }, contractValueDefault: 2999, anthropicKey: "sk-ant-fake" }, fake);
    companyId = r.companyId;
    await asOperator((c) => c.query("update companies set send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId]));
    // the test database is shared with the other suites; park their leftover runs so this file's ticks only ever send for this company
    await asOperator((c) => c.query("update runs set next_run_at = now() + interval '1 day' where company_id <> $1 and status in ('active','waiting')", [companyId]));
    expect(r.installed.filter((s) => s.endsWith("enabled"))).toHaveLength(14);
  });

  it("speed-to-lead: email + SMS now; a reply → tag engaged; silence → second email", async () => {
    const a = await newContact("CA", "a@x.com"), b = await newContact("CB", "b@x.com");
    await asOperator(async (c) => { for (const id of [a, b]) await dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "form", data: {} }), { contact: { id } }); });
    const n = since(); await tick(fake);
    expect(sent.slice(n).map((s) => s.kind).sort()).toEqual(["email", "email", "sms", "sms"]);
    let rs = await runsFor("speed-to-lead"); expect(rs.map((r) => r.current_node)).toEqual(["n3", "n3"]);
    // both runs were inserted in one transaction and share started_at, so never rely on rs[0]/rs[1] order: pick by contact
    const runA = rs.find((r) => r.contact_id === a)!, runB = rs.find((r) => r.contact_id === b)!;
    await inbound(a, "yes let's talk"); await wake(runA.id);
    await expireReplyWait(runB.id, "n3");
    const n2 = since(); await tick(fake);
    rs = await runsFor("speed-to-lead");
    expect(rs.find((r) => r.contact_id === a)?.exit_reason).toBe("replied"); expect(tags).toContain("engaged");
    expect(rs.find((r) => r.contact_id === b)?.exit_reason).toBe("no_reply"); expect(sent.slice(n2).map((s) => s.body)).toEqual([expect.stringMatching(/^Still want to talk/)]);
  });

  it("cancellation-rebook: GHL status → cancelled starts it; sends both, exits", async () => {
    const snap = (status: string): AppointmentSnapshot => ({ id: "ACX", calendarId: "CAL", contactId: "CCX", assignedUserId: "U1", startTime: DateTime.now().plus({ days: 3 }).toISO()!, endTime: DateTime.now().plus({ days: 3, minutes: 30 }).toISO()!, status, dateAdded: new Date().toISOString(), raw: {} });
    apptStore.set("ACX", snap("cancelled")); liveStatus = "cancelled";   // GHL really reports it cancelled; the premise check must NOT treat that as moot here
    await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, snap("confirmed")); await applyAppointment(c, row, adapterCompany, fake, snap("cancelled")); });
    expect(await runsFor("cancellation-rebook")).toHaveLength(1);
    await tick(fake); liveStatus = "confirmed";   // booking-confirmation also fires on the booking; assert on this run's own sends, not the global list
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
    await tick(fake); r = (await runsFor("no-show-recovery"))[0]; expect(r.status).toBe("waiting"); expect(r.current_node).toBe("n1");
    await expireWait(r.id, "n1"); const n = since(); await tick(fake);
    expect(sent.slice(n).map((s) => s.kind).sort()).toEqual(["email", "sms"]);
    expect(sent.slice(n).find((s) => s.kind === "sms")?.body).toMatch(/missed each other.*Sam/);
    r = (await runsFor("no-show-recovery"))[0]; expect(r.current_node).toBe("n4");
    await expireReplyWait(r.id, "n4");
    const n2 = since(); await tick(fake);
    expect(sent.slice(n2).map((s) => s.body)).toEqual([expect.stringMatching(/^Want to reschedule/)]);
    expect((await runsFor("no-show-recovery"))[0].exit_reason).toBe("no_reply");
    liveStatus = "confirmed";
  });

  it("post-call-follow-up: a follow_up disposition schedules the SMS for 9am the next morning, contact time", async () => {
    const appt = await asOperator((c) => one<{ id: string }>(c, "select id from appointments where company_id=$1 and external_id='ANS'", [companyId]));
    const [showed, fu] = await asOperator((c) => Promise.all([one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_outcome' and category='showed'", [companyId]), one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='call_outcome' and category='follow_up'", [companyId])]));
    await asOperator((c) => recordDisposition(c, { companyId, appointmentId: appt!.id, outcomeTermId: showed!.id, callOutcomeTermId: fu!.id }));
    await tick(fake);
    const r = (await runsFor("post-call-follow-up"))[0];
    expect(r.status).toBe("waiting");
    const at = DateTime.fromJSDate(r.next_run_at!).setZone(TZ);
    expect(at.hour).toBe(9); expect(at.minute).toBe(0); expect(at.toISODate()).toBe(DateTime.now().setZone(TZ).plus({ days: 1 }).toISODate());
  });

  it("payment-received: thank-you email + client tag; opportunity becomes a deal", async () => {
    const cns = await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='CNS'", [companyId]));
    await asOperator(async (c) => { const ev = await applyPayment(c, companyId, cns!.id, { whopPaymentId: "P1", amount: 2500, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); await dispatchEvent(c, ev, { contact: { id: cns!.id } }); });
    const n = since(); await tick(fake);
    expect(sent.slice(n).map((s) => s.body)).toEqual([expect.stringMatching(/^You're in/)]); expect(tags).toContain("client");
    expect((await runsFor("payment-received"))[0].exit_reason).toBe("done");
    const opp = await asOperator((c) => one<{ status: string }>(c, "select status from opportunities where company_id=$1 and contact_id=$2", [companyId, cns!.id]));
    expect(opp?.status).toBe("won");
  });

  it("payment-failed: SMS + email, two days, Slack skipped cleanly when not connected", async () => {
    const cns = await asOperator((c) => one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='CNS'", [companyId]));
    await asOperator(async (c) => { const ev = await applyPayment(c, companyId, cns!.id, { whopPaymentId: "P2", amount: 2500, currency: "USD", status: "failed", paidAt: new Date(), raw: {} }); await dispatchEvent(c, ev, { contact: { id: cns!.id } }); });
    const n = since(); await tick(fake);
    expect(sent.slice(n).map((s) => s.kind).sort()).toEqual(["email", "sms"]);
    let r = (await runsFor("payment-failed"))[0]; expect(r.current_node).toBe("n3"); expect(DateTime.fromJSDate(r.next_run_at!).diffNow("days").days).toBeGreaterThan(1.9);
    await expireWait(r.id, "n3"); await tick(fake);
    r = (await runsFor("payment-failed"))[0]; expect(r.exit_reason).toBe("escalated");
    const slack = await asOperator((c) => one<{ status: string; suppressed_reason: string }>(c, "select status, suppressed_reason from sends where run_id=$1 and channel='slack'", [r.id]));
    expect(slack?.status).toBe("suppressed"); expect(slack?.suppressed_reason).toMatch(/unbound: slack/);
  });

  it("reactivation: tag starts the sequence; a second tag inside 90 days is blocked", async () => {
    const id = await newContact("CRA", "ra@x.com");
    const fire = () => asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "tag.added", source: "ghl_poll", data: { tag: "reactivate" } }), { contact: { id } }));
    expect(await fire()).toHaveLength(1);
    expect(await fire()).toHaveLength(0);
    const n = since(); await tick(fake);
    expect(sent.slice(n).map((s) => s.body)).toEqual([expect.stringMatching(/^Checking in/)]);
    const r = (await runsFor("reactivation"))[0]; expect(r.current_node).toBe("n2"); expect(DateTime.fromJSDate(r.next_run_at!).diffNow("days").days).toBeGreaterThan(2.9);
    expect(await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "tag.added", source: "ghl_poll", data: { tag: "something-else" } }), { contact: { id } }))).toHaveLength(0);
  });

  it("shadow mode: the run completes, messages are recorded as would-send, nothing reaches the CRM", async () => {
    await asOperator((c) => c.query("update companies set mode='shadow', sms_enabled=true where id=$1", [companyId]));
    const id = await newContact("CSHADOW", "shadow@x.com");
    await asOperator(async (c) => { const ev = await applyPayment(c, companyId, id, { whopPaymentId: "P9", amount: 100, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); await dispatchEvent(c, ev, { contact: { id } }); });
    const n = since(), nt = tags.length; await tick(fake);
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
    await tick(fake);
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
    expect(await pay()).toHaveLength(2);   // payment-received (customer-facing) and payment-recorded (CRM side) both start
    expect(await pay()).toHaveLength(0);
    const evs = await asOperator((c) => many(c, "select 1 from events where contact_id=$1 and event_type='payment.received'", [id]));
    expect(evs).toHaveLength(1);
    await tick(fake);   // flush the one run this started so later tests' send counts are their own
  });

  it("new-lead: a lead with a phone gets a setter-pipeline card named 'Name -- New' with today's stage date, and the tag stat-new; without a phone, the run exits no_phone", async () => {
    const withNum = await newContact("CNL1", "nl1@x.com"); await withPhone(withNum, "+16025550101");
    await asOperator((c) => c.query("update contacts set first_name='Edwin', last_name='Ruh' where id=$1", [withNum]));
    const noNum = await newContact("CNL2", "nl2@x.com");
    for (const id of [withNum, noNum]) await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "ghl_poll", data: {} }), { contact: { id } }));
    const nTags = tags.length, nOpps = oppWrites.length;
    await tick(fake);
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
    await tick(fake);
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
    await tick(fake);
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
    await withPhone(id, "+16025550199"); await tick(fake);
    const start = DateTime.now().plus({ days: 5 }).setZone(TZ).set({ hour: 13, minute: 0, second: 0, millisecond: 0 });
    const snap: AppointmentSnapshot = { id: "ACB2", calendarId: "CAL", contactId: "CCB2", assignedUserId: "U1", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), setBy: "Luis", raw: {} };
    apptStore.set("ACB2", snap);
    const nOpp = oppWrites.length, nTags = tags.length, nCw = contactWrites.length;
    await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, snap); });
    await tick(fake);
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
    await tick(fake); liveStatus = "confirmed";
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
    await tick(fake);
    let r = (await runsFor("payment-recorded")).find((x) => x.contact_id === id)!;
    expect(r).toMatchObject({ status: "completed", exit_reason: "recorded" });
    expect(contactWrites.slice(nCw).map((w) => w.customFields)).toEqual([[{ id: "CF-CASH", field_value: "1500" }], [{ id: "CF-REV", field_value: "2999" }]]);
    const notClient = (t: string) => t !== "client";   // payment-received (the customer-facing template) also runs here and tags client
    expect(tags.slice(nTags).filter(notClient)).toEqual(["pay-plan-active"]); expect(removedTags.slice(nRm)).toEqual([]);
    const rec = recordWrites.slice(nRec); expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ op: "create", transaction_id: "pay_leo_1", amount: 1500, type: "deposit", status: "succeeded", processor: "whop", contact_id: "CCB2", closer: "Sam Closer", setter: "Luis" });
    expect(String(rec[0].opportunity_id)).toMatch(/^ghl-opp-/);   // the closer card's CRM id
    expect(relations.slice(nRel)).toEqual([`ASSOC-PC:CCB2>rec-${nRec + 1}`, `ASSOC-PO:rec-${nRec + 1}>${rec[0].opportunity_id}`]);
    // second payment clears the deal: revenue generated is already stamped (our replica learned the first write), so only cash collected moves; tags flip
    const nTags2 = tags.length, nRm2 = removedTags.length, nRec2 = recordWrites.length;
    await asOperator(async (c) => { const ev = await applyPayment(c, companyId, id, { whopPaymentId: "pay_leo_2", amount: 1499, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); await dispatchEvent(c, ev, { contact: { id } }); });
    await tick(fake);
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
    await tick(fake);
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
    await tick(fake); salesCall = true;
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
    await tick(fake);
    const run = (await runsFor("call-recorded")).find((x) => x.contact_id === id)!;
    expect(run).toMatchObject({ status: "completed", exit_reason: "recorded" });
    const rw = recordWrites.at(-1)!; expect(rw.external_id).toBe("fathom-fathom-2001"); expect(rw.scheduled_at).toBeUndefined();   // no appointment: keyed by the recording, nothing marked showed
    const slack = await asOperator((c) => one<{ rendered_body: string }>(c, "select rendered_body from sends where run_id=$1 and channel='slack'", [run.id]));
    expect(slack).toBeTruthy();
  });

  it("sms_enabled=false: SMS nodes are suppressed and the run continues", async () => {
    await asOperator((c) => c.query("update companies set sms_enabled=false where id=$1", [companyId]));
    const id = await newContact("CNOSMS", "nosms@x.com");
    await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: id, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "form", data: {} }), { contact: { id } }));
    const n = since(); await tick(fake);
    expect(sent.slice(n).map((s) => s.kind)).toEqual(["email"]);
    const r = (await runsFor("speed-to-lead")).find((r) => r.contact_id === id)!; expect(r.status).toBe("waiting"); expect(r.current_node).toBe("n3");
    const sup = await asOperator((c) => one<{ suppressed_reason: string }>(c, "select suppressed_reason from sends where run_id=$1 and channel='sms'", [r.id]));
    expect(sup?.suppressed_reason).toMatch(/sms_disabled/);
  });
});
