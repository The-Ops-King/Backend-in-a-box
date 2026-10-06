/**
 * One contact, the whole funnel, every link checked: lead → setter card → speed-to-lead → booking → confirmation →
 * reminder parked → reschedule moves the reminder → cancel → rebook sequence, reminder moot. The point is not any single
 * step (the scenario tests own those) but that the ids line up end to end: the booking attaches to the lead's card, the
 * runs point at the same appointment, and the journey reads in order.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { emitEvent, dispatchEvent } from "@/engine/dispatch";
import { applyAppointment } from "@/engine/poll";
import { loadCompany } from "@/engine/context";
import { tick } from "@/engine/runner";
import type { Adapters, AppointmentSnapshot, BookingRead, Classification } from "@/adapters/types";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix";
const sent: { kind: string; body: string }[] = [];
const tags: string[] = [];
const oppWrites: Record<string, unknown>[] = [];
const apptStore = new Map<string, AppointmentSnapshot>();
const booking: BookingRead = { appointmentsInWindow: async () => [], listCalendars: async () => [{ id: "CAL", name: "Closer Call", teamMemberIds: ["U1"] }], getAppointment: async (_c, id) => apptStore.get(id) ?? null };
const recordWrites: Record<string, unknown>[] = [];
const relations: string[] = [];
const fake: Adapters = {
  read: { contactsChangedSince: async () => [], inboundSince: async () => [], opportunitiesSince: async () => [], getContact: async (_c, id) => ({ id, firstName: id, tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString() }), listUsers: async () => [{ id: "U1", name: "Sam Closer", email: "sam@x.com" }] },
  booking: { ghl: booking, calendly: booking },
  write: { createContact: async () => ({ id: "x" }), addTag: async (_c, _id, t) => { tags.push(t); }, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "task-x" }), createRecord: async (_c, _o, props) => { recordWrites.push({ op: "create", ...props }); return { id: `rec-${recordWrites.length}` }; }, updateRecord: async (_c, _o, id, props) => { recordWrites.push({ op: "update", id, ...props }); }, relateRecords: async (_c, a, f, s) => { relations.push(`${a}:${f}>${s}`); },
    createOpportunity: async (_c, input) => { oppWrites.push({ op: "create", ...input }); return { id: `ghl-opp-${oppWrites.length}` }; }, updateOpportunity: async (_c, id, patch) => { oppWrites.push({ op: "update", id, ...patch }); } },
  sender: { sendSms: async (_c, _to, body) => { sent.push({ kind: "sms", body }); return { externalId: `s${sent.length}`, accepted: true }; }, sendEmail: async (_c, _to, subject, html) => { sent.push({ kind: "email", body: `${subject}|${html}` }); return { externalId: `e${sent.length}`, accepted: true }; }, deliveryStatus: async () => ({ status: "sent" }) },
  classifier: { choice: async (): Promise<Classification> => ({ value: "unclear", confidence: 0, distribution: {}, unclear: true }) },
  notifier: { post: async () => ({ ts: "1" }) },
};
let companyId: string, contactId: string;
const runs = () => asOperator((c) => many<{ slug: string; status: string; current_node: string | null; exit_reason: string | null; next_run_at: Date | null; appointment_id: string | null; opportunity_id: string | null }>(c,
  "select t.slug, r.status, r.current_node, r.exit_reason, r.next_run_at, r.appointment_id, r.opportunity_id from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where r.company_id=$1 and r.contact_id=$2 order by r.started_at", [companyId, contactId]));
const run = async (slug: string) => (await runs()).filter((r) => r.slug === slug).at(-1)!;
const journey = () => asOperator((c) => many<{ event_type: string }>(c, "select event_type from events where company_id=$1 and contact_id=$2 order by id", [companyId, contactId]));
const snap = (id: string, startsAt: DateTime, status: string): AppointmentSnapshot => ({ id, calendarId: "CAL", contactId: "CF1", assignedUserId: "U1", startTime: startsAt.toISO()!, endTime: startsAt.plus({ minutes: 45 }).toISO()!, status, dateAdded: new Date().toISOString(), raw: {} });
const apply = (s: AppointmentSnapshot) => asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); apptStore.set(s.id, s); await applyAppointment(c, row, adapterCompany, fake, s); });
// day-of 8am in the contact's zone, as the reminder template computes it
const morningOf = (d: DateTime) => d.setZone(TZ).set({ hour: 8, minute: 0, second: 0, millisecond: 0 });

describe.skipIf(!HAS_DB)("funnel end to end", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='fnl'");
      if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        await c.query("update appointments set disposition_id=null where company_id=$1", [co.id]);
        for (const t of ["sends", "runs", "events", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]); }
    });
    const r = await installCompany({ name: "Funnel", slug: "fnl", timezone: TZ, locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" }, enable: true, mode: "live",
      crm: { pipeline_setter: "PIPE-SETTER", stage_setter_new_lead: "STAGE-NEW", field_opportunity_stage_entered: "CF-DATE" } }, fake);
    companyId = r.companyId;
    await asOperator((c) => c.query("update companies set send_window_start='00:00', send_window_end='23:59' where id=$1", [companyId]));
    contactId = await asOperator(async (c) => {
      const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,'CF1','Jordan','Lee',$2) returning id", [companyId, TZ]))!.id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','jordan@x.com'),($1,$2,'phone','+16025550100')", [companyId, id]);
      return id;
    });
  });

  it("lead created → setter card + tag, speed-to-lead starts", async () => {
    await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "ghl_poll", data: {} }), { contact: { id: contactId } }));
    await tick(fake);
    expect(await run("new-lead")).toMatchObject({ status: "completed", exit_reason: "done" });
    expect(oppWrites).toEqual([expect.objectContaining({ op: "create", contactId: "CF1", pipelineId: "PIPE-SETTER", stageId: "STAGE-NEW", name: "Jordan Lee -- New" })]);
    expect(tags).toEqual(["stat-new"]);
    expect(await run("speed-to-lead")).toMatchObject({ status: "waiting", current_node: "n3" });
    expect(sent.map((s) => s.kind)).toEqual(["email", "sms"]);
  });

  it("booking → attaches to the lead's card, confirmation goes out, reminder parks for the morning of the call", async () => {
    const start = DateTime.now().plus({ days: 3 }).setZone(TZ).set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
    await apply(snap("A1", start, "confirmed"));
    const appt = await asOperator((c) => one<{ id: string; opportunity_id: string }>(c, "select id, opportunity_id from appointments where company_id=$1 and external_id='A1'", [companyId]));
    const pursuit = await asOperator((c) => one<{ id: string }>(c, "select id from opportunities where company_id=$1 and contact_id=$2 and status='open'", [companyId, contactId]));
    const card = await asOperator((c) => one<{ id: string; name: string; opportunity_id: string }>(c, "select id, name, opportunity_id from pipeline_cards where company_id=$1 and contact_id=$2 and ghl_pipeline_id='PIPE-SETTER'", [companyId, contactId]));
    expect(card!.opportunity_id).toBe(pursuit!.id);
    expect(appt!.opportunity_id).toBe(pursuit!.id);   // the booking lands on the pursuit new-lead opened, no second opportunity
    const n = sent.length; await tick(fake);
    expect(await run("booking-confirmation")).toMatchObject({ status: "completed", appointment_id: appt!.id, opportunity_id: pursuit!.id });
    expect(sent.slice(n).map((s) => s.kind)).toEqual(["email"]);
    const rem = await run("appointment-reminder");
    expect(rem).toMatchObject({ status: "waiting", current_node: "n1", appointment_id: appt!.id });
    expect(rem.next_run_at!.getTime()).toBe(morningOf(start).toMillis());
  });

  it("reschedule → same appointment moves, the parked reminder moves with it, nothing else fires", async () => {
    const moved = DateTime.now().plus({ days: 5 }).setZone(TZ).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    const before = (await runs()).length, n = sent.length;
    await apply(snap("A1", moved, "confirmed"));
    expect(await asOperator((c) => many(c, "select 1 from appointments where company_id=$1 and contact_id=$2", [companyId, contactId]))).toHaveLength(1);
    await tick(fake);
    const rem = await run("appointment-reminder");
    expect(rem.status).toBe("waiting"); expect(rem.current_node).toBe("n1");
    expect(rem.next_run_at!.getTime()).toBe(morningOf(moved).toMillis());
    expect((await runs()).length).toBe(before); expect(sent.length).toBe(n);
    expect((await journey()).filter((e) => e.event_type === "appointment.rescheduled")).toHaveLength(1);
  });

  it("cancel → rebook sequence sends, the reminder exits as moot, the journey reads in order", async () => {
    const current = await asOperator((c) => one<{ starts_at: Date }>(c, "select starts_at from appointments where company_id=$1 and external_id='A1'", [companyId]));
    await apply(snap("A1", DateTime.fromJSDate(current!.starts_at), "cancelled"));
    const n = sent.length; await tick(fake);
    expect(await run("cancellation-rebook")).toMatchObject({ status: "completed", exit_reason: "sent" });
    expect(sent.slice(n).map((s) => s.kind).sort()).toEqual(["email", "sms"]);
    const rem = await run("appointment-reminder");
    expect(rem.status).toBe("exited"); expect(rem.exit_reason).toMatch(/moot: appointment cancelled/);
    expect((await journey()).map((e) => e.event_type)).toEqual(expect.arrayContaining(["lead.created", "opportunity.opened", "tag.added", "appointment.booked", "appointment.rescheduled", "appointment.status_changed", "run.exited"]));
    const order = (await journey()).map((e) => e.event_type);
    for (const [a, b] of [["lead.created", "opportunity.opened"], ["opportunity.opened", "appointment.booked"], ["appointment.booked", "appointment.rescheduled"], ["appointment.rescheduled", "appointment.status_changed"]])
      expect(order.indexOf(a), `${a} before ${b}`).toBeLessThan(order.indexOf(b));
  });
});
