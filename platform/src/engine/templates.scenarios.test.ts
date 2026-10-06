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

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";
const sent: { kind: string; to: string; body: string }[] = [];
const tags: string[] = [];
const oppWrites: Record<string, unknown>[] = [];
let liveStatus = "confirmed";
const apptStore = new Map<string, AppointmentSnapshot>();   // what GHL "has" for each appointment the tests book
const fake: Adapters = {
  read: {
    contactsChangedSince: async () => [], inboundSince: async () => [], opportunitiesSince: async () => [],
    getContact: async (_c, id) => ({ id, firstName: id, tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString() }),
    listUsers: async () => [{ id: "U1", name: "Sam Closer", email: "sam@x.com" }],
  },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [],
    getAppointment: async (_c, id) => { const a = apptStore.get(id); return a ? { ...a, status: liveStatus } : null; },
    listCalendars: async () => [{ id: "CAL", name: "Closer Call", teamMemberIds: ["U1"] }] }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async (_c, _id, t) => { tags.push(t); }, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {},
    createOpportunity: async (_c, input) => { oppWrites.push({ op: "create", ...input }); return { id: `ghl-opp-${oppWrites.length}` }; },
    updateOpportunity: async (_c, id, patch) => { oppWrites.push({ op: "update", id, ...patch }); } },
  sender: {
    sendSms: async (_c, to, body) => { sent.push({ kind: "sms", to, body }); return { externalId: `s${sent.length}`, accepted: true }; },
    sendEmail: async (_c, to, subject, html) => { sent.push({ kind: "email", to, body: `${subject}|${html}` }); return { externalId: `e${sent.length}`, accepted: true }; },
    deliveryStatus: async () => ({ status: "sent" }),
  },
  classifier: { choice: async (): Promise<Classification> => ({ value: "confirmed", confidence: 0.95, distribution: { confirmed: 0.95 }, unclear: false }) },
  notifier: { post: async () => ({ ts: "1" }) },
};
const since = () => sent.length;
const bySlug = (slug: string) => asOperator((c) => one<{ id: string }>(c, "select w.id from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug=$2", [companyId, slug]));
const runsFor = (slug: string) => asOperator((c) => many<{ id: string; status: string; current_node: string | null; exit_reason: string | null; next_run_at: Date | null; contact_id: string }>(c, "select r.id, r.status, r.current_node, r.exit_reason, r.next_run_at, r.contact_id from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug=$2 order by r.started_at", [companyId, slug]));
const wake = (runId: string) => asOperator((c) => c.query("update runs set next_run_at=now() where id=$1", [runId]));
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
        for (const t of ["sends", "runs", "events", "workflow_triggers", "workflows", "messages", "payments", "form_submissions", "forms", "appointments", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]); }
    });
    const r = await installCompany({ name: "Scenarios", slug: "scn", timezone: TZ, locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" }, enable: true, mode: "live",
      crm: { pipeline_setter: "PIPE-SETTER", stage_setter_new_lead: "STAGE-NEW", field_opportunity_stage_entered: "CF-STAGE-DATE" } }, fake);
    companyId = r.companyId;
    await asOperator((c) => c.query("update companies set send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId]));
    expect(r.installed.filter((s) => s.endsWith("enabled"))).toHaveLength(10);
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
    await tick(fake); r = (await runsFor("no-show-recovery"))[0]; expect(r.status).toBe("waiting"); expect(r.current_node).toBe("n2");
    await wake(r.id); const n = since(); await tick(fake);
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
    let r = (await runsFor("payment-failed"))[0]; expect(r.current_node).toBe("n4"); expect(DateTime.fromJSDate(r.next_run_at!).diffNow("days").days).toBeGreaterThan(1.9);
    await wake(r.id); await tick(fake);
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
    const r = (await runsFor("reactivation"))[0]; expect(r.current_node).toBe("n3"); expect(DateTime.fromJSDate(r.next_run_at!).diffNow("days").days).toBeGreaterThan(2.9);
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
    expect(flags.find((f) => f.current_node === "n2")?.wake_on_reply).toBe(false);   // the reminder's timed wait
    // simulate what pollInbound does on an inbound message for this contact
    await asOperator((c) => c.query("update runs set next_run_at=now() where company_id=$1 and contact_id=$2 and status='waiting' and wake_on_reply", [companyId, id]));
    const after = (await runsFor("appointment-reminder")).find((r) => r.contact_id === id)!;
    expect(after.next_run_at!.getTime()).toBe(parkedUntil);   // untouched
  });

  it("a redelivered payment webhook records nothing new and starts nothing", async () => {
    const id = await newContact("CDUP", "dup@x.com");
    const pay = () => asOperator(async (c) => { const ev = await applyPayment(c, companyId, id, { whopPaymentId: "PDUP", amount: 50, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); return ev.id === -1 ? [] : dispatchEvent(c, ev, { contact: { id } }); });
    expect(await pay()).toHaveLength(1);
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
    const opp = await asOperator((c) => one<{ name: string; ghl_opportunity_id: string; ghl_pipeline_id: string; ghl_stage_id: string; status: string }>(c, "select name, ghl_opportunity_id, ghl_pipeline_id, ghl_stage_id, status from opportunities where company_id=$1 and contact_id=$2", [companyId, withNum]));
    expect(opp).toMatchObject({ name: "Edwin Ruh -- New", ghl_pipeline_id: "PIPE-SETTER", ghl_stage_id: "STAGE-NEW", status: "open" }); expect(opp!.ghl_opportunity_id).toMatch(/^ghl-opp-/);
    expect(await asOperator((c) => many(c, "select 1 from opportunities where company_id=$1 and contact_id=$2", [companyId, noNum]))).toHaveLength(0);
    // the same lead firing again updates the one card instead of creating a second
    await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: withNum, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "form", data: {} }), { contact: { id: withNum } }));
    await tick(fake);
    expect(oppWrites.slice(nOpps).map((w) => w.op)).toEqual(["create", "update"]);
    expect(await asOperator((c) => many(c, "select 1 from opportunities where company_id=$1 and contact_id=$2", [companyId, withNum]))).toHaveLength(1);
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
