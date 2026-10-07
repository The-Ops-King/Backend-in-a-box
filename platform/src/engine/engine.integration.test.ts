/**
 * End to end against a real Postgres (DATABASE_URL) with fake adapters:
 * install → appointment.booked → dispatch → tick → the confirmation email goes out via the idempotent sends ledger,
 * and a second tick does NOT send it again. Then: reply → classify (fake Jev) → branch → tag.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, db, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { parseDefinition, extractManifest, indexDefinition } from "@/engine/definition";
import { templates } from "@/templates";
import type { Adapters, AppointmentSnapshot, Classification, BookingRead } from "@/adapters/types";
import { applyAppointment } from "@/engine/poll";
import { loadCompany } from "@/engine/context";
import { tick } from "@/engine/runner";
import { recordDisposition } from "@/engine/disposition";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");

const sent: { kind: string; to: string; body: string }[] = [];
const tags: string[] = [];
let liveStatus = "confirmed";
// two days out at 2pm Phoenix, so "morning of" is genuinely in the future
const APPT_START = DateTime.now().setZone("America/Phoenix").plus({ days: 2 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
const recordWrites: Record<string, unknown>[] = [];
const relations: string[] = [];
const fake: Adapters = {
  read: {
    contactsChangedSince: async () => [], inboundSince: async () => [], callMedia: async () => null, opportunitiesSince: async () => [],
    getContact: async () => null, listUsers: async () => [{ id: "GHLU1", name: "Sam Closer", email: "sam@x.com" }],
  },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [], listCalendars: async () => [],
    getAppointment: async (_c, id) => ({ id, calendarId: "CAL1", contactId: "GHLC1", startTime: APPT_START.toISO()!, endTime: APPT_START.plus({ minutes: 30 }).toISO()!, status: liveStatus, raw: {} }) }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async (_c, _id, t) => { tags.push(t); }, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "task-x" }), createRecord: async (_c, _o, props) => { recordWrites.push({ op: "create", ...props }); return { id: `rec-${recordWrites.length}` }; }, updateRecord: async (_c, _o, id, props) => { recordWrites.push({ op: "update", id, ...props }); }, relateRecords: async (_c, a, f, s) => { relations.push(`${a}:${f}>${s}`); }, createOpportunity: async () => ({ id: "opp-x" }), updateOpportunity: async () => {} },
  sender: {
    sendSms: async (_c, to, body) => { sent.push({ kind: "sms", to, body }); return { externalId: `sms-${sent.length}`, accepted: true }; },
    sendEmail: async (_c, to, subject, html) => { sent.push({ kind: "email", to, body: `${subject}|${html}` }); return { externalId: `em-${sent.length}`, accepted: true }; },
    deliveryStatus: async () => ({ status: "sent" }),
  },
  classifier: { choice: async (_s, input): Promise<Classification> => /yes|see you/i.test(input) ? { value: "confirmed", confidence: 0.96, distribution: { confirmed: 0.96 }, unclear: false } : { value: "unclear", confidence: 0.3, distribution: { unclear: 0.3 }, unclear: true } },
  notifier: { post: async () => ({ ts: "1" }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};

describe.skipIf(!HAS_DB)("engine end to end", () => {
  let companyId: string, contactId: string, apptId: string;
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='e2e'");
      if (co) {
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
        await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        await c.query("update appointments set disposition_id=null where company_id=$1", [co.id]);
        for (const t of ["sends", "runs", "events", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"])
          await c.query(`delete from ${t} where company_id=$1`, [co.id]);
      }
      await c.query("delete from companies where slug='e2e'");
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, send_window_start, send_window_end, mode) values ('E2E','e2e','America/Phoenix','00:00','23:59','live') returning id"))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'calendar.closer_call','id',$4)", [companyId, Buffer.from("LOC1"), encrypt("pit-fake"), Buffer.from("CAL1")]);
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      await c.query("insert into calendars (company_id, external_id, name, appointment_term) values ($1,'CAL1','Closer Call',$2)", [companyId, term]);
      contactId = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, timezone) values ($1,'GHLC1','Jamie','America/Phoenix') returning id", [companyId]))!.id;
      for (const t of templates) {
        const def = parseDefinition(t.definition), manifest = extractManifest(def);
        const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,$2,$3,true) returning id", [companyId, t.name, def.reentry]))!;
        await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,$3)", [wf.id, t.definition, manifest]);
        for (const trig of indexDefinition(def).triggers) await c.query("insert into workflow_triggers (company_id, workflow_id, node_id, event_type, match) values ($1,$2,$3,$4,$5)", [companyId, wf.id, trig.id, trig.event, trig.match ?? {}]);
      }
    });
  });

  it("a booked appointment starts both workflows; confirmation email sends once; reminder waits", async () => {
    const snap: AppointmentSnapshot = { id: "GHLA1", calendarId: "CAL1", contactId: "GHLC1", assignedUserId: "GHLU1", startTime: APPT_START.toISO()!, endTime: APPT_START.plus({ minutes: 30 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), raw: {} };
    await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, snap); });
    // call-booked also starts here; this test is about confirmation + reminder, and that company has no pipeline bindings so call-booked fails at its first step
    const runs = await asOperator((c) => many<{ id: string; status: string; appointment_id: string }>(c, "select r.id, r.status, r.appointment_id from runs r join workflows w on w.id=r.workflow_id where r.company_id=$1 and w.name in ('Booking confirmation','Appointment reminder with reply handling')", [companyId]));
    expect(runs).toHaveLength(2); apptId = runs[0].appointment_id;
    const opp = await asOperator((c) => one(c, "select id from opportunities where company_id=$1 and status='open'", [companyId]));
    expect(opp).toBeTruthy();  // lifecycle: first booking opened an opportunity
    const auto = await asOperator((c) => one<{ claimed_at: null }>(c, "select claimed_at from users where company_id=$1 and ghl_user_id='GHLU1'", [companyId]));
    expect(auto?.claimed_at).toBeNull();  // unclaimed user auto-created from roster

    const r1 = await tick(fake);
    expect(r1.claimed).toBe(3); expect(r1.completed).toBe(1); expect(r1.waiting).toBe(1); expect(r1.failed).toBe(1);
    expect(sent.filter((s) => s.kind === "email")).toHaveLength(1);
    expect(sent[0].body).toMatch(/You're booked/);

    const r2 = await tick(fake);   // nothing due; the reminder is waiting on its rule
    expect(r2.claimed).toBe(0); expect(sent).toHaveLength(1);
  });

  it("reply → classify → branch → tag; idempotency ledger has every send once", async () => {
    // fast-forward the reminder's wait: pretend the rule fired and a reply arrived
    await asOperator(async (c) => {
      await c.query("update runs set next_run_at=now(), current_node='n2' where company_id=$1 and status='waiting'", [companyId]);
      await c.query("insert into messages (company_id, contact_id, ghl_message_id, channel, direction, body, occurred_at) values ($1,$2,'M1','sms','inbound','yes see you then',now())", [companyId, contactId]);
    });
    const r = await tick(fake);                       // n2 sends the reminder SMS; n3 wait_for_reply sees the reply already there? No: message was BEFORE the send → boundary excludes it → waits
    expect(sent.filter((s) => s.kind === "sms")).toHaveLength(1);
    expect(sent.at(-1)!.body).toMatch(/Jamie.*Sam.*at 2pm/);
    const waiting = await asOperator((c) => one<{ current_node: string; next_run_at: Date }>(c, "select current_node, next_run_at from runs where company_id=$1 and status='waiting'", [companyId]));
    expect(waiting?.current_node).toBe("n3");                                        // stays ON the wait_for_reply node
    expect(waiting!.next_run_at.getTime() - Date.now()).toBeGreaterThan(3.9 * 3600e3);  // deadline ≈ 4h out
    // a reply arrives AFTER our send → the poller wakes the run (simulated: next_run_at=now) → handled on the very next tick, not at hour four
    await asOperator(async (c) => {
      await c.query("insert into messages (company_id, contact_id, ghl_message_id, channel, direction, body, occurred_at) values ($1,$2,'M2','sms','inbound','yes see you then',now())", [companyId, contactId]);
      await c.query("update runs set next_run_at=now() where company_id=$1 and status='waiting'", [companyId]);
    });
    const r3 = await tick(fake);                      // n3 sees reply → n5 classify → n6 branch → n7 tag → x1
    expect(r3.completed).toBe(1);
    expect(tags).toContain("confirmed");
    const run = await asOperator((c) => one<{ exit_reason: string }>(c, "select r.exit_reason from runs r join workflows w on w.id=r.workflow_id where r.company_id=$1 and w.name like 'Appointment reminder%'", [companyId]));
    expect(run?.exit_reason).toBe("confirmed");
    const ledger = await asOperator((c) => many<{ idempotency_key: string; status: string }>(c, "select idempotency_key, status from sends where company_id=$1 order by scheduled_for", [companyId]));
    expect(new Set(ledger.map((l) => l.idempotency_key)).size).toBe(ledger.length);
    const cls = await asOperator((c) => one<{ data: { intent: string } }>(c, "select data from events where company_id=$1 and event_type='reply.classified'", [companyId]));
    expect(cls?.data.intent).toBe("confirmed");
  });

  it("wait_for_reply timeout: no reply by the deadline → the timeout edge → exit no_reply", async () => {
    await asOperator(async (c) => {
      await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [companyId]);
      await c.query("delete from sends where company_id=$1", [companyId]); await c.query("delete from runs where company_id=$1", [companyId]);
      await c.query("delete from messages where company_id=$1", [companyId]);
      const wf = await one<{ id: string }>(c, "select id from workflows where company_id=$1 and name like 'Appointment reminder%'", [companyId]);
      // park a run on n3 with a deadline already in the past
      await c.query("insert into runs (company_id, workflow_id, workflow_version, contact_id, appointment_id, status, current_node, next_run_at, context, reentry_key) values ($1,$2,1,$3,$4,'waiting','n3',now(),$5,'appointment:timeout')",
        [companyId, wf!.id, contactId, apptId, { vars: { __wait_for_reply: { n3: { deadline: new Date(Date.now() - 60e3).toISOString() } } } }]);   // nested: setPath/resolvePath split on "."
    });
    const r = await tick(fake);
    expect(r.completed).toBe(1);
    const run = await asOperator((c) => one<{ exit_reason: string }>(c, "select exit_reason from runs where company_id=$1 and reentry_key='appointment:timeout'", [companyId]));
    expect(run?.exit_reason).toBe("no_reply");
  });

  it("disposition: showed + follow_up emits call.held and starts post-call follow-up; noshow starts no-show recovery once", async () => {
    await asOperator(async (c) => {
      const [showed, noshow] = await Promise.all([one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_outcome' and category='showed'", [companyId]), one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_outcome' and category='noshow'", [companyId])]);
      const followUp = await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='call_outcome' and category='follow_up'", [companyId]);
      const r1 = await recordDisposition(c, { companyId, appointmentId: apptId, outcomeTermId: showed!.id, callOutcomeTermId: followUp!.id, notes: "wants to think" });
      expect(r1.events).toBe(2);
      const pc = await one<{ status: string }>(c, "select r.status from runs r join workflows w on w.id=r.workflow_id where w.name='Post-call follow-up' and r.appointment_id=$1", [apptId]);
      expect(pc?.status).toBe("active");
      const r2 = await recordDisposition(c, { companyId, appointmentId: apptId, outcomeTermId: noshow!.id });
      expect(r2.runs).toBe(1);
      const r3 = await recordDisposition(c, { companyId, appointmentId: apptId, outcomeTermId: noshow!.id });   // same appointment again → reentry blocks a second run
      expect(r3.runs).toBe(0);
      const ns = await many(c, "select 1 from runs r join workflows w on w.id=r.workflow_id where w.name='No-show recovery' and r.appointment_id=$1", [apptId]);
      expect(ns).toHaveLength(1);
      const j = await many<{ event_type: string }>(c, "select event_type from events where appointment_id=$1 and source='disposition' order by id", [apptId]);
      expect(j.map((e) => e.event_type)).toEqual(["appointment.outcome", "call.held", "appointment.outcome", "appointment.outcome"]);
    });
  });

  it("premise check: a cancelled appointment exits the run instead of sending", async () => {
    liveStatus = "cancelled";
    await asOperator(async (c) => {
      await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [companyId]);
      await c.query("delete from sends where company_id=$1", [companyId]);
      await c.query("delete from runs where company_id=$1", [companyId]);
      const wf = await one<{ id: string }>(c, "select id from workflows where company_id=$1 and name like 'Appointment reminder%'", [companyId]);
      await c.query("insert into runs (company_id, workflow_id, workflow_version, contact_id, appointment_id, status, current_node, next_run_at, context, reentry_key) values ($1,$2,1,$3,$4,'waiting','n2',now(),'{}','appointment:again')", [companyId, wf!.id, contactId, apptId]);
    });
    const before = sent.length;
    const r = await tick(fake);
    expect(r.exited).toBe(1); expect(sent.length).toBe(before);
    const run = await asOperator((c) => one<{ exit_reason: string }>(c, "select exit_reason from runs where company_id=$1 and reentry_key='appointment:again'", [companyId]));
    expect(run?.exit_reason).toMatch(/moot: appointment cancelled/);
  });
});
