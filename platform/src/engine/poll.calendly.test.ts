/** Appointments from a booking source outside the CRM: identity by email/phone, reschedule as a move, later CRM poll attaches the GHL id. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { pollAll } from "@/engine/poll";
import { installCompany } from "@/engine/install";
import type { Adapters, AppointmentSnapshot, ContactSnapshot } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string;
let events: AppointmentSnapshot[] = [];
let ghlContacts: ContactSnapshot[] = [];
const noBooking = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] };
const recordWrites: Record<string, unknown>[] = [];
const relations: string[] = [];
const fake: Adapters = {
  read: { contactsChangedSince: async (c) => (c.id === companyId ? ghlContacts : []), inboundSince: async () => [], opportunitiesSince: async () => [], getContact: async () => null, listUsers: async () => [] },
  booking: {
    ghl: noBooking,
    calendly: { listCalendars: async () => [{ id: "ET1", name: "45 Min Strategy Call", teamMemberIds: [] }], getAppointment: async (_c, id) => events.find((e) => e.id === id) ?? null,
      appointmentsInWindow: async (c, cal) => (c.id === companyId ? events.filter((e) => e.calendarId === cal) : []) },
  },
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "task-x" }), createRecord: async (_c, _o, props) => { recordWrites.push({ op: "create", ...props }); return { id: `rec-${recordWrites.length}` }; }, updateRecord: async (_c, _o, id, props) => { recordWrites.push({ op: "update", id, ...props }); }, relateRecords: async (_c, a, f, s) => { relations.push(`${a}:${f}>${s}`); }, createOpportunity: async () => ({ id: "opp-x" }), updateOpportunity: async () => {} },
  sender: { sendSms: async () => ({ externalId: "", accepted: true }), sendEmail: async () => ({ externalId: "", accepted: true }), deliveryStatus: async () => ({ status: "sent" }) },
  classifier: { choice: async () => ({ value: "unclear", confidence: 0, distribution: {}, unclear: true }) },
  notifier: { post: async () => ({ ts: "1" }) },
};
const T0 = "2026-10-20T16:00:00.000Z", T1 = "2026-10-22T18:00:00.000Z";
const appt = (id: string, over: Partial<AppointmentSnapshot> = {}): AppointmentSnapshot => ({ id, calendarId: "ET1", startTime: T0, endTime: "2026-10-20T16:45:00.000Z", status: "confirmed", assignedUserEmail: "james@x.com", invitee: { email: "pete@x.com", phone: "+18605551234", firstName: "Pete", lastName: "G", timezone: "America/Denver" }, raw: {}, ...over });
const evTypes = () => asOperator((c) => many<{ event_type: string; data: Record<string, unknown> }>(c, "select event_type, data from events where company_id=$1 and event_type like 'appointment.%' order by id", [companyId]));

describe.skipIf(!process.env.DATABASE_URL)("Calendly as the booking source", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='cal'");
      if (co) {
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of ["sends", "runs", "events", "workflow_triggers", "workflows", "crm_records", "appointments", "pipeline_cards", "opportunities", "contact_identifiers", "contacts", "calendars", "users", "company_terms", "bindings", "poll_cursors"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]);
      }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('CAL','cal','America/New_York') returning id"))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3),($1,'secret.calendly_token','secret',$4),($1,'calendly.organization','id',$5)", [companyId, Buffer.from("L"), encrypt("p"), encrypt("tok"), Buffer.from("https://api.calendly.com/organizations/O")]);
      await c.query("insert into users (company_id, email, name, role, ghl_user_id) values ($1,'james@x.com','James','closer','GU1')", [companyId]);
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      await c.query("insert into calendars (company_id, source, external_id, name, appointment_term, self_booked, booking_url) values ($1,'calendly','ET1','45 Min Strategy Call',$2,true,'https://calendly.com/d/x')", [companyId, term]);
    });
    // baseline both entities so the next polls are deltas (outside the setup transaction: pollAll opens its own)
    events = []; ghlContacts = [];
    await pollAll(fake);
  });

  it("a booking by someone the CRM has not sent us yet creates a local contact by identity and fires appointment.booked", async () => {
    events = [appt("EV1")];
    const r = await pollAll(fake);
    expect(r.appointmentsNew).toBe(1);
    const a = await asOperator((c) => one<{ external_id: string; source: string; status: string; self_booked: boolean; assigned: string | null; contact_id: string }>(c, "select a.external_id, a.source, a.status, a.self_booked, u.email as assigned, a.contact_id from appointments a left join users u on u.id=a.assigned_user_id where a.company_id=$1", [companyId]));
    expect(a).toMatchObject({ external_id: "EV1", source: "calendly", status: "confirmed", self_booked: true, assigned: "james@x.com" });
    const ct = await asOperator((c) => one<{ ghl_contact_id: string | null; timezone: string; timezone_source: string }>(c, "select ghl_contact_id, timezone, timezone_source from contacts where id=$1", [a!.contact_id]));
    expect(ct).toEqual({ ghl_contact_id: null, timezone: "America/Denver", timezone_source: "booking" });
    expect((await evTypes()).map((e) => e.event_type)).toEqual(["appointment.booked"]);
  });

  it("when the CRM poll later delivers the same person, the replica gains the GHL id instead of a duplicate contact", async () => {
    events = [appt("EV1")];
    ghlContacts = [{ id: "GC9", firstName: "Pete", email: "Pete@X.com", phone: "(860) 555-1234", tags: ["stat-booked"], customFields: {}, dateUpdated: "2026-10-06T00:00:00Z", dateAdded: "2026-10-06T00:00:00Z" }];
    await pollAll(fake);
    const rows = await asOperator((c) => many<{ ghl_contact_id: string | null }>(c, "select ghl_contact_id from contacts where company_id=$1", [companyId]));
    expect(rows).toEqual([{ ghl_contact_id: "GC9" }]);
    ghlContacts = [];
  });

  it("a reschedule (old cancelled + new event linked) moves the appointment and fires rescheduled, never cancelled", async () => {
    events = [appt("EV1", { status: "cancelled", rescheduledTo: "EV2" }), appt("EV2", { startTime: T1, endTime: "2026-10-22T18:45:00.000Z", rescheduledFrom: "EV1" })];
    const r = await pollAll(fake);
    expect(r.appointmentsNew).toBe(0); expect(r.appointmentsChanged).toBe(1);
    const rows = await asOperator((c) => many<{ external_id: string; status: string; starts_at: Date }>(c, "select external_id, status, starts_at from appointments where company_id=$1", [companyId]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ external_id: "EV2", status: "confirmed" }); expect(rows[0].starts_at.toISOString()).toBe(T1);
    expect((await evTypes()).map((e) => e.event_type)).toEqual(["appointment.booked", "appointment.rescheduled"]);
    // the pair arriving in the other order changes nothing further
    events = [appt("EV2", { startTime: T1, endTime: "2026-10-22T18:45:00.000Z", rescheduledFrom: "EV1" }), appt("EV1", { status: "cancelled", rescheduledTo: "EV2" })];
    const again = await pollAll(fake);
    expect(again.appointmentsNew + again.appointmentsChanged).toBe(0);
  });

  it("a plain cancellation fires status_changed", async () => {
    events = [appt("EV2", { startTime: T1, endTime: "2026-10-22T18:45:00.000Z", status: "cancelled" })];
    const r = await pollAll(fake);
    expect(r.appointmentsChanged).toBe(1);
    const last = (await evTypes()).at(-1)!;
    expect(last.event_type).toBe("appointment.status_changed"); expect(last.data.status).toEqual({ from: "confirmed", to: "cancelled" });
  });

  it("re-installing without a booking block keeps the company on Calendly; its event types stay active", async () => {
    const r = await installCompany({ name: "CAL", slug: "cal", timezone: "America/New_York", locationId: "L", pit: "p", calendars: { ET1: "closing" }, templates: ["new-lead"] }, fake);
    expect(r.calendars).toEqual(['"45 Min Strategy Call" → closing']);
    const cals = await asOperator((c) => many<{ source: string; active: boolean }>(c, "select source, active from calendars where company_id=$1", [companyId]));
    expect(cals).toEqual([{ source: "calendly", active: true }]);
    expect(await asOperator((c) => one(c, "select 1 from bindings where company_id=$1 and key='secret.calendly_token'", [companyId]))).toBeTruthy();
  });

  it("a booking with no usable identity is skipped rather than inventing a contact", async () => {
    events = [appt("EV3", { invitee: { firstName: "Nobody" } })];
    const r = await pollAll(fake);
    expect(r.appointmentsNew).toBe(0); expect(r.errors.filter((e) => e.company === "cal")).toEqual([]);
  });
});
