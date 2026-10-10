/**
 * Sweep 2026-10-10 (06-journey-sweep.md): Hair books through Calendly, where a reschedule is a cancel plus a new event.
 * The Sales Call record Call booked writes follows the appointment through that, and the record written at the first
 * booking carries the closer card it just made.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { pollAll } from "@/engine/poll";
import { tick } from "@/engine/runner";
import { installTemplateForTest } from "@/engine/test-install";
import { callTime } from "@/engine/ghl-metrics";
import type { Adapters, AppointmentSnapshot, ContactSnapshot } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/New_York";
const TABLES = ["alerts", "slack_posts", "step_effects", "sends", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "crm_records", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"];
let companyId: string;
let events: AppointmentSnapshot[] = [];
let ghlContacts: ContactSnapshot[] = [];
const records: { op: string; object: string; id?: string; props: Record<string, unknown> }[] = [];
const relations: string[] = [];
let opps = 0;
const noBooking = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] };
const fake: Adapters = {
  read: { openCards: async () => [], contactsChangedSince: async (c) => (c.id === companyId ? ghlContacts : []), inboundSince: async () => [], callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [], objectRecords: async () => [], documents: async () => [], opportunitiesSince: async () => [], pipelineCards: async () => [],
    getContact: async (_c, id) => ghlContacts.find((k) => k.id === id) ?? null, listUsers: async () => [] },
  booking: { ghl: noBooking, calendly: { listCalendars: async () => [], getAppointment: async (_c, id) => events.find((e) => e.id === id) ?? null, appointmentsInWindow: async (c, cal) => (c.id === companyId ? events.filter((e) => e.calendarId === cal) : []) } },
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "task-x" }),
    createRecord: async (_c, object, props) => { records.push({ op: "create", object, props }); return { id: `rec-${records.length}` }; }, updateRecord: async (_c, object, id, props) => { records.push({ op: "update", object, id, props }); },
    relateRecords: async (_c, a, f, s) => { relations.push(`${a}:${f}>${s}`); }, createOpportunity: async () => ({ id: `opp-${++opps}` }), updateOpportunity: async () => {}, sendDocumentTemplate: async () => ({ id: "doc-x" }) },
  sender: { sendSms: async () => ({ externalId: "", accepted: true }), sendEmail: async () => ({ externalId: "", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "unclear", confidence: 0, distribution: {}, unclear: true }) },
  notifier: { post: async () => ({ ts: "1" }), lookupUserByEmail: async () => null, react: async () => true, unreact: async () => true, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};
const day = (d: number, h: number) => DateTime.now().setZone(TZ).plus({ days: d }).set({ hour: h, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()!;
const T0 = day(5, 10), T1 = day(7, 14);
const appt = (id: string, start: string, over: Partial<AppointmentSnapshot> = {}): AppointmentSnapshot => ({ id, calendarId: "ET-SELF", startTime: start, endTime: DateTime.fromISO(start).plus({ minutes: 45 }).toUTC().toISO()!, status: "confirmed", assignedUserEmail: "james@sweep.test",
  invitee: { email: "tyler@sweep-test.com", phone: "+16025550111", firstName: "Tess", lastName: "Sweep", timezone: TZ }, raw: {}, ...over });
const salesCalls = () => records.filter((r) => r.object === "custom_objects.sales_call");

describe.skipIf(!process.env.DATABASE_URL)("sweep 2026-10-10: a Calendly booking's Sales Call record", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='sweep'");
      if (co) {
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
        for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
        await c.query("delete from companies where id=$1", [co.id]);
      }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode, send_window_start, send_window_end) values ('Sweep','sweep',$1,'live','00:00','23:59') returning id", [TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      const bind = (key: string, kind: string, v: string) => c.query("insert into bindings (company_id,key,kind,value) values ($1,$2,$3,$4)", [companyId, key, kind, kind === "secret" ? encrypt(v) : Buffer.from(v)]);
      await bind("crm.location_id", "id", "LOC"); await bind("secret.ghl_pit", "secret", "pit"); await bind("secret.calendly_token", "secret", "tok"); await bind("calendly.organization", "id", "https://api.calendly.com/organizations/O");
      for (const [k, v] of Object.entries({ pipeline_setter: "PIPE-S", pipeline_closer: "PIPE-C", stage_setter_direct_booked: "ST-DIRECT", stage_closer_scheduled: "ST-SCHED", field_contact_appointment_date: "CF-DATE", assoc_sales_call_contact: "ASSOC-SC-CONTACT", assoc_sales_call_opportunity: "ASSOC-SC-OPP" })) await bind(`crm.${k}`, "id", v);
      await c.query("insert into users (company_id, email, name, role, ghl_user_id) values ($1,'james@sweep.test','James Closer','closer','GU-JAMES')", [companyId]);
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
      await c.query("insert into calendars (company_id, source, external_id, name, appointment_term, self_booked, booking_url) values ($1,'calendly','ET-SELF','45 Min Strategy Call',$2,true,'https://calendly.com/d/self')", [companyId, term]);
      await installTemplateForTest(c, companyId, "call-booked");
    });
    events = []; ghlContacts = [];
    await pollAll(fake);   // baseline
  });

  it("the first booking's record carries the closer card the run just made, a machine-readable time and the booking's id; a reschedule (Calendly: cancel + new event) updates that record rather than making a second", async () => {
    // Tyler made the test contact in GHL first; the contacts poll has them before the booking lands
    ghlContacts = [{ id: "GC-TESS", firstName: "Tess", lastName: "Sweep", email: "tyler@sweep-test.com", phone: "+16025550111", tags: ["sys-test"], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString() }];
    events = [appt("EV-1", T0)];
    await pollAll(fake);
    expect(await tick(fake, undefined, companyId)).toMatchObject({ completed: 1, failed: 0, paused: 0 });
    expect(salesCalls()).toHaveLength(1);
    const first = salesCalls()[0];
    expect(first).toMatchObject({ op: "create", props: { external_id: "EV-1", contact_id: "GC-TESS", scheduled_at: T0, outcome: "scheduled" } });
    // the closer card s4 made in this same run is the record's opportunity, and the two are associated
    const closerCard = (await asOperator((c) => one<{ ghl_opportunity_id: string }>(c, "select ghl_opportunity_id from pipeline_cards where company_id=$1 and ghl_pipeline_id='PIPE-C'", [companyId])))!.ghl_opportunity_id;
    expect(first.props.opportunity_id).toBe(closerCard);
    expect(relations).toContain(`ASSOC-SC-OPP:rec-1>${closerCard}`);
    // what the bot reads back (D73): the stamp is a time, and the day agrees with it
    const at = callTime(first.props.scheduled_at, DateTime.fromISO(String(first.props.call_date), { zone: TZ }), TZ);
    expect(at?.toMillis()).toBe(DateTime.fromISO(T0).toMillis());

    events = [appt("EV-1", T0, { status: "cancelled", rescheduledTo: "EV-2" }), appt("EV-2", T1, { rescheduledFrom: "EV-1" })];
    await pollAll(fake);
    expect(await tick(fake, undefined, companyId)).toMatchObject({ completed: 1, failed: 0, paused: 0 });
    expect(salesCalls().filter((r) => r.op === "create")).toHaveLength(1);
    expect(salesCalls().at(-1)).toMatchObject({ op: "update", id: "rec-1", props: { external_id: "EV-2", outcome: "scheduled" } });
    expect(DateTime.fromISO(String(salesCalls().at(-1)!.props.scheduled_at)).toMillis()).toBe(DateTime.fromISO(T1).toMillis());
    const ours = await asOperator((c) => many<{ record_key: string; ghl_record_id: string }>(c, "select record_key, ghl_record_id from crm_records where company_id=$1", [companyId]));
    expect(ours).toEqual([{ record_key: "EV-2", ghl_record_id: "rec-1" }]);
  });
});
