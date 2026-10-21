/** Appointments from a booking source outside the CRM: identity by email/phone, reschedule as a move, later CRM poll attaches the GHL id. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { pollAll } from "@/engine/poll";
import { installCompany } from "@/engine/install";
import { decideSelfBooked } from "@/engine/poll";
import type { Adapters, AppointmentSnapshot, ContactSnapshot } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string;
let events: AppointmentSnapshot[] = [];
let ghlContacts: ContactSnapshot[] = [];
const noBooking = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] };
const recordWrites: Record<string, unknown>[] = [];
const cancelled: { id: string; reason: string }[] = [];   // D196: what the engine cancelled at Calendly
const relations: string[] = [];
const fake: Adapters = {
  read: { openCards: async () => [], contactsChangedSince: async (c) => (c.id === companyId ? ghlContacts : []), inboundSince: async () => [], messageBodies: async () => new Map(), callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], pipelineCards: async () => [], getContact: async () => null, listUsers: async () => [] },
  booking: {
    ghl: noBooking,
    calendly: { listCalendars: async () => [{ id: "ET1", name: "45 Min Strategy Call", teamMemberIds: [] }], getAppointment: async (_c, id) => events.find((e) => e.id === id) ?? null,
      cancel: async (_c, id, reason) => { cancelled.push({ id, reason }); },
      appointmentsInWindow: async (c, cal) => (c.id === companyId ? events.filter((e) => e.calendarId === cal) : []) },
  },
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "task-x" }), createRecord: async (_c, _o, props) => { recordWrites.push({ op: "create", ...props }); return { id: `rec-${recordWrites.length}` }; }, updateRecord: async (_c, _o, id, props) => { recordWrites.push({ op: "update", id, ...props }); }, relateRecords: async (_c, a, f, s) => { relations.push(`${a}:${f}>${s}`); }, createOpportunity: async () => ({ id: "opp-x" }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "doc-x" }) },
  sender: { sendSms: async () => ({ externalId: "", accepted: true }), sendEmail: async () => ({ externalId: "", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "unclear", confidence: 0, distribution: {}, unclear: true }) },
  notifier: { post: async () => ({ ts: "1" }), lookupUserByEmail: async () => null, react: async () => true, unreact: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
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

  it("D153: on a calendar set to utm, a setter's link (utm_medium=setter, utm_content=their first name) is setter-booked by that person; ad UTMs are a direct booking; a link naming no one is setter-booked, unnamed", async () => {
    await asOperator(async (c) => {
      await c.query("insert into users (company_id, email, name, role) values ($1,'mitch@x.com','Mitch Sapoff','setter')", [companyId]);
      await c.query("update calendars set config=config || '{\"booking\":\"utm\"}'::jsonb, self_booked=null where company_id=$1 and external_id='ET1'", [companyId]);
    });
    const inv = (email: string) => ({ email, firstName: "P", lastName: "Q", timezone: "America/Denver" });
    events = [
      appt("EVS1", { invitee: inv("set1@x.com"), tracking: { utm_medium: "setter", utm_content: "MITCH" } }),
      appt("EVS2", { invitee: inv("ad1@x.com"), tracking: { utm_source: "facebook", utm_medium: "paid", utm_content: "mitch" } }),
      appt("EVS3", { invitee: inv("set2@x.com"), tracking: { utm_medium: "setter", utm_content: "somebody" } }),
      appt("EVS4", { invitee: inv("plain@x.com") }),
    ];
    await pollAll(fake);
    const rows = await asOperator((c) => many<{ external_id: string; self_booked: boolean | null; set_by: string | null }>(c, "select external_id, self_booked, set_by from appointments where company_id=$1 and external_id like 'EVS%' order by external_id", [companyId]));
    expect(rows).toEqual([
      { external_id: "EVS1", self_booked: false, set_by: "Mitch Sapoff" },
      { external_id: "EVS2", self_booked: true, set_by: null },
      { external_id: "EVS3", self_booked: false, set_by: null },
      { external_id: "EVS4", self_booked: true, set_by: null },
    ]);
    const booked = await asOperator((c) => many<{ data: Record<string, unknown> }>(c, "select e.data from events e join appointments a on a.id=e.appointment_id where e.company_id=$1 and e.event_type='appointment.booked' and a.external_id='EVS1'", [companyId]));
    expect(booked[0].data.self_booked).toBe(false);
    // the unnamed setter link is the setter-missing alert (D121), the named one is not
    const missing = await asOperator((c) => many<{ ext: string }>(c, "select a.external_id as ext from alerts al join appointments a on a.id::text = al.detail->>'appointment_id' where al.company_id=$1 and al.resolved_at is null", [companyId]));
    expect(missing.map((m) => m.ext)).toEqual(["EVS3"]);
    events = [];
  });

  it("a booking with no usable identity is skipped rather than inventing a contact", async () => {
    events = [appt("EV3", { invitee: { firstName: "Nobody" } })];
    const r = await pollAll(fake);
    expect(r.appointmentsNew).toBe(0); expect(r.errors.filter((e) => e.company === "cal")).toEqual([]);
  });

  it("D196: a workflow's cancel of a Calendly booking cancels it at Calendly when the person is reachable (live, sends unlocked), and runs the cancel workflows; in quiet, or with the workflow's sends locked, Calendly is not touched", async () => {
    const { parseDefinition, extractManifest } = await import("@/engine/definition");
    const { syncTriggers } = await import("@/engine/install");
    const { tick } = await import("@/engine/runner");
    const wf = await asOperator(async (c) => {
      const def = parseDefinition({ schema: 1, reentry: "always", premise: { check: "none" }, nodes: [{ id: "t1", type: "trigger", event: "appointment.booked" }, { id: "n_cx", type: "update_appointment", set: { status: "cancelled" } }, { id: "x1", type: "exit", reason: "done" }], edges: [{ from: "t1", to: "n_cx" }, { from: "n_cx", to: "x1" }] });
      const w = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Cancel it','always',true) returning id", [companyId]))!;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,$3)", [w.id, def, extractManifest(def)]);
      await syncTriggers(c, companyId, w.id, def);
      return w.id;
    });
    const later = (h: number) => new Date(Date.now() + h * 36e5).toISOString();
    // quiet: held, Calendly untouched
    await asOperator((c) => c.query("update companies set mode='quiet' where id=$1", [companyId]));
    events = [...events, appt("EV-Q", { startTime: later(30), endTime: later(31), invitee: { email: "quinn@x.com", firstName: "Quinn" } })];
    await pollAll(fake); await tick(fake, undefined, companyId);
    expect(cancelled).toEqual([]);
    // live but the workflow's sends locked: Calendly would email the person, so it is not touched (D145)
    await asOperator((c) => c.query("update companies set mode='live' where id=$1", [companyId]));
    events = [...events, appt("EV-K", { startTime: later(30), endTime: later(31), invitee: { email: "kim@x.com", firstName: "Kim" } })];
    await pollAll(fake); await tick(fake, undefined, companyId);
    expect(cancelled).toEqual([]);
    expect(await asOperator((c) => one(c, "select status from appointments where company_id=$1 and external_id='EV-K'", [companyId]))).not.toEqual({ status: "cancelled" });
    // live and unlocked: cancelled at Calendly, our booking cancelled, and the cancel event says before the call
    await asOperator((c) => c.query("update workflows set sends_unlocked_at=now() where id=$1", [wf]));
    events = [...events, appt("EV-L", { startTime: later(30), endTime: later(31), invitee: { email: "lee@x.com", firstName: "Lee" } })];
    await pollAll(fake); await tick(fake, undefined, companyId);
    expect(cancelled).toEqual([{ id: "EV-L", reason: "Cancelled by the team" }]);
    expect(await asOperator((c) => one(c, "select status from appointments where company_id=$1 and external_id='EV-L'", [companyId]))).toEqual({ status: "cancelled" });
    expect(await asOperator((c) => one(c, "select data->'status'->>'to' as to_, data->>'before_start' as before from events where company_id=$1 and event_type='appointment.status_changed' and appointment_id=(select id from appointments where external_id='EV-L')", [companyId]))).toEqual({ to_: "cancelled", before: "true" });
    await asOperator((c) => c.query("update workflows set enabled=false where id=$1", [wf]));
  });
});

describe("setter rule (D24)", () => {
  it("calendar: the calendar decides; question: a named setter decides; either: a setter calendar or a name means setter-booked", () => {
    expect(decideSelfBooked("calendar", true, "Luis")).toBe(true);
    expect(decideSelfBooked("calendar", null, "Luis")).toBeNull();
    expect(decideSelfBooked("question", null, "Luis")).toBe(false);
    expect(decideSelfBooked("question", true, "")).toBe(true);
    expect(decideSelfBooked("either", true, "Luis")).toBe(false);
    expect(decideSelfBooked("either", false, undefined)).toBe(false);
    expect(decideSelfBooked("either", null, undefined)).toBe(true);
    expect(decideSelfBooked(undefined, false, undefined)).toBe(false);
    // the calendar's own rule beats the company default
    expect(decideSelfBooked("calendar", true, "Luis", "question")).toBe(false);
    expect(decideSelfBooked("question", null, "Luis", "self")).toBe(true);
    expect(decideSelfBooked("question", null, undefined, "setter")).toBe(false);
    // D153: utm, a setter's link or not, whatever the question or the company rule
    expect(decideSelfBooked("question", true, "Luis", "utm", false)).toBe(true);
    expect(decideSelfBooked("calendar", true, undefined, "utm", true)).toBe(false);
  });
});
