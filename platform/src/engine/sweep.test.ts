/**
 * Sweep 2026-10-10 (06-journey-sweep.md §4), on a Calendly company shaped like Hair: the Sales Call record through a
 * booking, a Calendly reschedule and the closer's filing (the company's own option keys; a record the engine never wrote
 * found by person and start minute); a cancel after the call's start is not a cancel; a booking that arrives before GHL
 * has the person waits for its CRM id; the wrap-up rollups leave test contacts out.
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
import { recordDisposition, outcomeTermFor } from "@/engine/disposition";
import { prefill } from "@/engine/eod";
import { loadCompany } from "@/engine/context";
import { rollupDay } from "@/engine/metrics";
import type { Adapters, AppointmentSnapshot, ContactSnapshot, ObjectRecord } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/New_York";
const TABLES = ["alerts", "slack_posts", "step_effects", "sends", "runs", "events", "form_submissions", "forms", "slack_connections", "workflow_triggers", "workflows", "crm_records", "payments", "rollups_daily", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"];
let companyId: string;
let events: AppointmentSnapshot[] = [];
let ghlContacts: ContactSnapshot[] = [];
let ghlSalesCalls: ObjectRecord[] = [];
const records: { op: string; object: string; id?: string; props: Record<string, unknown> }[] = [];
const slack: { op: string; channel: string; ts: string; text?: string; emoji?: string; thread?: string }[] = [];
const tagOps: { op: string; to: string; tag: string }[] = [], cardOps: { id: string; stageId?: string; status?: string }[] = [];
const relations: string[] = [];
let opps = 0;
const noBooking = { appointmentsInWindow: async () => [], getAppointment: async () => null, listCalendars: async () => [] };
const fake: Adapters = {
  read: { openCards: async () => [], contactsChangedSince: async (c) => (c.id === companyId ? ghlContacts : []), inboundSince: async () => [], callMedia: async () => null, contactsAddedBetween: async () => [], callsBetween: async () => [], wonOpportunities: async () => [],
    objectRecords: async (_c, key) => (key === "custom_objects.sales_call" ? ghlSalesCalls : []), documents: async () => [], opportunitiesSince: async () => [], pipelineCards: async () => [],
    getContact: async (_c, id) => ghlContacts.find((k) => k.id === id) ?? null, listUsers: async () => [] },
  booking: { ghl: noBooking, calendly: { listCalendars: async () => [], getAppointment: async (_c, id) => events.find((e) => e.id === id) ?? null, appointmentsInWindow: async (c, cal) => (c.id === companyId ? events.filter((e) => e.calendarId === cal) : []) } },
  write: { createContact: async () => ({ id: "x" }), addTag: async (_c, to, tag) => { tagOps.push({ op: "add", to, tag }); }, removeTag: async (_c, to, tag) => { tagOps.push({ op: "remove", to, tag }); }, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "task-x" }),
    createRecord: async (_c, object, props) => { records.push({ op: "create", object, props }); return { id: `rec-${records.length}` }; }, updateRecord: async (_c, object, id, props) => { records.push({ op: "update", object, id, props }); },
    relateRecords: async (_c, a, f, s) => { relations.push(`${a}:${f}>${s}`); }, createOpportunity: async () => ({ id: `opp-${++opps}` }), updateOpportunity: async (_c, id, w) => { cardOps.push({ id, stageId: w.stageId, status: w.status }); }, sendDocumentTemplate: async () => ({ id: "doc-x" }) },
  sender: { sendSms: async () => ({ externalId: "", accepted: true }), sendEmail: async () => ({ externalId: "", accepted: true }), deliveryStatus: async () => ({ status: "sent" }), sendEmailTemplate: async () => ({ externalId: "t", accepted: true }), smsTemplateBody: async () => null },
  classifier: { choice: async () => ({ value: "unclear", confidence: 0, distribution: {}, unclear: true }) },
  notifier: { post: async (_t, channel, text, _as, thread) => { const ts = `${slack.length + 1}.0001`; slack.push({ op: "post", channel, ts, text, thread }); return { ts }; }, update: async (_t, channel, ts, text) => { slack.push({ op: "update", channel, ts, text }); },
    lookupUserByEmail: async () => null, react: async (_t, channel, ts, emoji) => { slack.push({ op: "react", channel, ts, emoji }); return true; }, unreact: async (_t, channel, ts, emoji) => { slack.push({ op: "unreact", channel, ts, emoji }); return true; }, authTest: async () => ({ ok: true }), channelInfo: async () => ({ ok: true, member: true }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};
const local = () => DateTime.now().setZone(TZ);
const day = (d: number, h: number) => local().plus({ days: d }).set({ hour: h, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()!;
const T0 = day(5, 10), T1 = day(7, 14);
const person = (id: string, email: string, first: string, over: Partial<ContactSnapshot> = {}): ContactSnapshot => ({ id, firstName: first, lastName: "Sweep", email, phone: undefined, tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString(), ...over });
const appt = (id: string, start: string, over: Partial<AppointmentSnapshot> = {}): AppointmentSnapshot => ({ id, calendarId: "ET-SELF", startTime: start, endTime: DateTime.fromISO(start).plus({ minutes: 45 }).toUTC().toISO()!, status: "confirmed", assignedUserEmail: "james@sweep.test",
  invitee: { email: "tyler@sweep-test.com", firstName: "Tess", lastName: "Sweep", timezone: TZ }, raw: {}, ...over });
const salesCalls = () => records.filter((r) => r.object === "custom_objects.sales_call");
const runsOf = (name: string) => asOperator((c) => many<{ id: string; status: string; current_node: string | null; exit_reason: string | null; appointment_id: string | null }>(c, "select r.id, r.status, r.current_node, r.exit_reason, r.appointment_id from runs r join workflows w on w.id=r.workflow_id where r.company_id=$1 and w.name=$2 order by r.started_at", [companyId, name]));
const apptId = (ext: string) => asOperator(async (c) => (await one<{ id: string }>(c, "select id from appointments where company_id=$1 and external_id=$2", [companyId, ext]))!.id);
const file = (appointmentId: string, outcome: string, callOutcome?: string) => asOperator(async (c) => recordDisposition(c, { companyId, appointmentId, outcomeTermId: (await outcomeTermFor(c, companyId, outcome))!,
  callOutcomeTermId: callOutcome ? (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='call_outcome' and category=$2", [companyId, callOutcome]))!.id : null }));
const wakeAll = () => asOperator((c) => c.query("update runs set next_run_at=now(), claimed_at=null where company_id=$1 and status='waiting'", [companyId]));

describe.skipIf(!process.env.DATABASE_URL)("sweep 2026-10-10 on a Calendly company shaped like Hair", () => {
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
      for (const [k, v] of Object.entries({ pipeline_setter: "PIPE-S", pipeline_closer: "PIPE-C", stage_setter_direct_booked: "ST-DIRECT", stage_closer_scheduled: "ST-SCHED", stage_setter_showed: "ST-SHOWED", stage_setter_cancelled: "ST-S-CX", stage_closer_cancelled: "ST-C-CX",
        stage_closer_follow_up: "ST-FU", stage_closer_lost: "ST-LOST", stage_closer_disqualified: "ST-DQ", field_contact_appointment_date: "CF-DATE", assoc_sales_call_contact: "ASSOC-SC-CONTACT", assoc_sales_call_opportunity: "ASSOC-SC-OPP", object_sales_call: "custom_objects.sales_call" })) await bind(`crm.${k}`, "id", v);
      // Hair's outcome map as installed (D73): its own spellings, the engine's alias, the late cancel; and the value a new booking carries
      await bind("sales_call.outcomes", "text", JSON.stringify({ scheduled: "scheduled", showed: "showed", no_show: "noshow", noshow: "noshow", cancelled: "cancelled", late_cancel: "cancelled", rescheduled: "rescheduled" }));
      await bind("test.domains", "text", "sweep-test.com");
      await c.query("insert into users (company_id, email, name, role, ghl_user_id) values ($1,'james@sweep.test','James Closer','closer','GU-JAMES')", [companyId]);
      const term = (cat: string) => one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category=$2", [companyId, cat]);
      await c.query("insert into calendars (company_id, source, external_id, name, appointment_term, self_booked, booking_url) values ($1,'calendly','ET-SELF','45 Min Strategy Call',$2,true,'https://calendly.com/d/self'),($1,'calendly','ET-INTRO','Intro call',$3,true,'https://calendly.com/d/intro')", [companyId, (await term("closing"))!.id, (await term("first_call"))!.id]);
      await installTemplateForTest(c, companyId, "call-booked");
    });
    events = []; ghlContacts = [];
    await pollAll(fake);   // baseline
  });

  it("the first booking's record carries the closer card the run just made, a machine-readable time and the booking's id; a reschedule (Calendly: cancel + new event) logs the old slot's record as rescheduled and gives the new slot its own (D76)", async () => {
    // Tyler made the test contact in GHL first; the contacts poll has them before the booking lands
    ghlContacts = [person("GC-TESS", "tyler@sweep-test.com", "Tess", { tags: ["sys-test"] })];
    events = [appt("EV-1", T0)];
    await pollAll(fake);
    expect(await tick(fake, undefined, companyId)).toMatchObject({ completed: 1, failed: 0, paused: 0 });
    expect(salesCalls()).toHaveLength(1);
    const first = salesCalls()[0];
    expect(first).toMatchObject({ op: "create", props: { external_id: "EV-1", contact_id: "GC-TESS", scheduled_at: T0, outcome: "scheduled" } });
    const closerCard = (await asOperator((c) => one<{ ghl_opportunity_id: string }>(c, "select ghl_opportunity_id from pipeline_cards where company_id=$1 and ghl_pipeline_id='PIPE-C'", [companyId])))!.ghl_opportunity_id;
    expect(first.props.opportunity_id).toBe(closerCard);
    expect(relations).toContain(`ASSOC-SC-OPP:rec-1>${closerCard}`);
    const at = callTime(first.props.scheduled_at, DateTime.fromISO(String(first.props.call_date), { zone: TZ }), TZ);
    expect(at?.toMillis()).toBe(DateTime.fromISO(T0).toMillis());

    events = [appt("EV-1", T0, { status: "cancelled", rescheduledTo: "EV-2" }), appt("EV-2", T1, { rescheduledFrom: "EV-1" })];
    await pollAll(fake);
    expect(await tick(fake, undefined, companyId)).toMatchObject({ completed: 1, failed: 0, paused: 0 });
    const moved = salesCalls().slice(1);
    expect(moved).toEqual([
      expect.objectContaining({ op: "update", id: "rec-1", props: { outcome: "rescheduled" } }),   // the old slot is logged, never moved or reused
      expect.objectContaining({ op: "create", props: expect.objectContaining({ external_id: "EV-2", contact_id: "GC-TESS", opportunity_id: closerCard, outcome: "scheduled" }) }),
    ]);
    expect(DateTime.fromISO(String(moved[1].props.scheduled_at)).toMillis()).toBe(DateTime.fromISO(T1).toMillis());
    const ours = await asOperator((c) => many<{ record_key: string; ghl_record_id: string }>(c, "select record_key, ghl_record_id from crm_records where company_id=$1 order by created_at", [companyId]));
    expect(ours).toEqual([{ record_key: "EV-1", ghl_record_id: "rec-1" }, { record_key: "EV-2", ghl_record_id: "rec-3" }]);   // the fake numbers a record by the writes before it
  });

  it("D-1: the closer's filing writes the company's own option keys: a no-show is no_show (never the engine's noshow), a call rescheduled or cancelled on the call is the rescheduled key", async () => {
    await asOperator((c) => installTemplateForTest(c, companyId, "call-outcome"));
    const ev2 = await apptId("EV-2");
    await file(ev2, "noshow");
    await tick(fake, undefined, companyId);
    expect(salesCalls().at(-1)).toMatchObject({ op: "update", id: "rec-3", props: { outcome: "no_show" } });
    await file(ev2, "rescheduled");
    await tick(fake, undefined, companyId);
    expect(salesCalls().at(-1)).toMatchObject({ op: "update", id: "rec-3", props: { outcome: "rescheduled" } });
    expect(salesCalls().map((r) => r.props.outcome).filter(Boolean)).not.toContain("noshow");
  });

  it("D-7: a filing for a booking the engine never wrote a record for finds GHL's record by the person and the start minute (never by name) and updates it; no match stays unwritten", async () => {
    const callAt = local().minus({ days: 2 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    ghlContacts = [...ghlContacts, person("GC-GINA", "gina@x.com", "Gina"), person("GC-HANK", "hank@x.com", "Hank")];
    await pollAll(fake);
    const ids = await asOperator(async (c) => {
      const out: Record<string, string> = {};
      for (const [ghl, ext] of [["GC-GINA", "EV-GINA"], ["GC-HANK", "EV-HANK"]]) {
        const ct = (await one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id=$2", [companyId, ghl]))!.id;
        const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]))!.id;
        out[ghl] = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, source, external_id, appointment_term, starts_at, ends_at, booked_at, status) values ($1,$2,'calendly',$3,$4,$5,$6,now() - interval '5 days','confirmed') returning id",
          [companyId, ct, ext, term, callAt.toJSDate(), callAt.plus({ minutes: 45 }).toJSDate()]))!.id;
      }
      return out;
    });
    // the records an outside integration wrote: its own ids, display-text times; one is Gina's, one is a stranger's with Gina's name on it at the same minute
    const display = `${callAt.toFormat("ccc LLL d")} · ${callAt.toFormat("h:mm a ZZZZ")}`;
    ghlSalesCalls = [
      { id: "GHL-SC-STRANGER", createdAt: callAt.toISO()!, properties: { external_id: "zap-1", display_label: "Gina Sweep", contact_id: "GC-SOMEONE", scheduled_at: display, call_date: callAt.toISODate() } },
      { id: "GHL-SC-GINA", createdAt: callAt.toISO()!, properties: { external_id: "zap-2", display_label: "Gina S.", contact_id: "GC-GINA", scheduled_at: display, call_date: callAt.toISODate() } },
    ];
    const n = records.length;
    await file(ids["GC-GINA"], "showed", "lost");
    await file(ids["GC-HANK"], "noshow");
    await tick(fake, undefined, companyId);
    const writes = records.slice(n).filter((r) => r.object === "custom_objects.sales_call");
    expect(writes).toEqual([expect.objectContaining({ op: "update", id: "GHL-SC-GINA", props: expect.objectContaining({ outcome: "showed", disposition: "lost" }) })]);
    expect(await asOperator((c) => one(c, "select record_key, ghl_record_id from crm_records where company_id=$1 and record_key='EV-GINA'", [companyId]))).toEqual({ record_key: "EV-GINA", ghl_record_id: "GHL-SC-GINA" });
    const hank = (await runsOf("Call outcome filed")).find((r) => r.appointment_id === ids["GC-HANK"])!;
    const step = await asOperator((c) => one<{ status: string; result: { why?: string } }>(c, "select status, result from run_steps where run_id=$1 and node_id='r2'", [hank.id]));
    expect(step).toMatchObject({ status: "skipped", result: { why: expect.stringMatching(/no .*record/i) } });
    ghlSalesCalls = [];
  });

  it("D-3 and D-9: a cancel the source records after the call's start is not a cancel (no Call cancelled, no rebook text, the call stays on the end-of-day form); a cancel before it is; an intro call's cancel is not a closing call's", async () => {
    await asOperator(async (c) => { await installTemplateForTest(c, companyId, "call-cancelled"); await installTemplateForTest(c, companyId, "cancellation-rebook"); });
    const past = local().minus({ hours: 3 }).startOf("minute").toUTC().toISO()!, earlier = local().minus({ hours: 5 }).startOf("minute").toUTC().toISO()!, later = day(3, 11), intro = day(2, 9);
    events = [appt("EV-PAST", past), appt("EV-NOSHOW", earlier), appt("EV-LATER", later), appt("EV-INTRO", intro, { calendarId: "ET-INTRO" })];
    await pollAll(fake); await tick(fake, undefined, companyId);
    await file(await apptId("EV-NOSHOW"), "noshow"); await tick(fake, undefined, companyId);   // the closer filed a no-show before the host cleared the slot
    const now = new Date().toISOString();
    events = [appt("EV-PAST", past, { status: "cancelled", dateUpdated: now }), appt("EV-NOSHOW", earlier, { status: "cancelled", dateUpdated: now }), appt("EV-LATER", later, { status: "cancelled", dateUpdated: now }), appt("EV-INTRO", intro, { status: "cancelled", calendarId: "ET-INTRO", dateUpdated: now })];
    await pollAll(fake);
    // D76: the later cancel never overwrites the no-show: our row keeps it, and it counts as a no-show
    expect(await asOperator((c) => one<{ status: string; outcome: string }>(c, "select a.status, ot.category as outcome from appointments a join company_terms ot on ot.id=a.outcome_term where a.company_id=$1 and a.external_id='EV-NOSHOW'", [companyId]))).toEqual({ status: "confirmed", outcome: "noshow" });
    const [pastId, laterId] = [await apptId("EV-PAST"), await apptId("EV-LATER")];
    expect((await runsOf("Call cancelled")).map((r) => r.appointment_id)).toEqual([laterId]);
    expect((await runsOf("Cancellation rebook")).map((r) => r.appointment_id)).toEqual([laterId]);
    const pre = await asOperator(async (c) => prefill(c, (await loadCompany(c, companyId)).row, { id: (await one<{ id: string }>(c, "select id from users where company_id=$1", [companyId]))!.id, name: "James Closer", email: "james@sweep.test" }, DateTime.fromISO(past).setZone(TZ).toISODate()!));
    expect(pre.calls.map((x) => x.appointment_id)).toContain(pastId);
    await tick(fake, undefined, companyId);
  });

  it("D-5: a booking that arrives before GHL has the person waits for its CRM id (Call booked and the pre-call receipts), goes on when the id arrives, and pauses with the reason when it never does", async () => {
    await asOperator((c) => installTemplateForTest(c, companyId, "pre-call-sequence"));
    events = [appt("EV-NORA", day(4, 13), { invitee: { email: "nora@x.com", firstName: "Nora", lastName: "New", timezone: TZ } }), appt("EV-OMAR", day(4, 15), { invitee: { email: "omar@x.com", firstName: "Omar", lastName: "Never", timezone: TZ } })];
    await pollAll(fake); await tick(fake, undefined, companyId);
    const [nora, omar] = [await apptId("EV-NORA"), await apptId("EV-OMAR")];
    const booked = async (a: string) => (await runsOf("Call booked")).find((r) => r.appointment_id === a)!;
    const precall = async (a: string) => (await runsOf("Pre-call sequence")).find((r) => r.appointment_id === a)!;
    expect(await booked(nora)).toMatchObject({ status: "waiting" });
    expect(await precall(nora)).toMatchObject({ status: "waiting" });
    const sends = async (runId: string) => Number((await asOperator((c) => one<{ n: string }>(c, "select count(*)::text as n from sends where run_id=$1 and channel in ('sms','email')", [runId])))!.n);
    expect(await sends((await precall(nora)).id)).toBe(0);
    // GHL's contact for Nora arrives (Calendly's sync); the contacts poll joins her by email
    ghlContacts = [...ghlContacts, person("GC-NORA", "nora@x.com", "Nora")];
    await pollAll(fake); await wakeAll(); await tick(fake, undefined, companyId);
    expect(await booked(nora)).toMatchObject({ status: "completed" });
    expect(await sends((await precall(nora)).id)).toBeGreaterThan(0);
    // Omar never reaches GHL: once the wait runs out the run pauses and says why
    await asOperator((c) => c.query("update runs set context = jsonb_set(context, '{vars,__check}', jsonb_build_object('c0', jsonb_build_object('deadline', $2::text)), true) where appointment_id=$1", [omar, new Date(Date.now() - 60e3).toISOString()]));
    await wakeAll(); await tick(fake, undefined, companyId);
    expect(await booked(omar)).toMatchObject({ status: "paused", exit_reason: expect.stringMatching(/no CRM id/) });
    expect(await precall(omar)).toMatchObject({ status: "paused", exit_reason: expect.stringMatching(/no CRM id/) });
  });

  it("D-8: the wrap-up rollups leave test contacts out (tagged sys-test, or an email on a test domain), as every metric does", async () => {
    const today = local().toISODate()!;
    await asOperator(async (c) => {
      const tess = (await one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='GC-TESS'", [companyId]))!.id;
      const gina = (await one<{ id: string }>(c, "select id from contacts where company_id=$1 and ghl_contact_id='GC-GINA'", [companyId]))!.id;
      await c.query("update contacts set ghl_added_at=now() where company_id=$1", [companyId]);
      await c.query("insert into payments (company_id, contact_id, whop_payment_id, amount, status, paid_at) values ($1,$2,'p-tess',750,'succeeded',now()),($1,$3,'p-gina',1500,'succeeded',now())", [companyId, tess, gina]);
    });
    const rows = await asOperator((c) => rollupDay(c, companyId, today, TZ));
    const total = (m: string) => rows.find((r) => r.dimension === "total" && r.metric === m)?.value ?? 0;
    const people = await asOperator((c) => many<{ ghl_contact_id: string | null; tags: string[] }>(c, "select ghl_contact_id, tags from contacts where company_id=$1", [companyId]));
    const tests = people.filter((p) => p.tags.includes("sys-test")).length;
    expect(tests).toBe(1);
    expect(total("leads_new")).toBe(people.length - 1);   // Tess is a test contact (tagged, and her email is on the test domain)
    expect(total("cash")).toBe(1500);
    const tessBookedToday = await asOperator(async (c) => Number((await one<{ n: string }>(c, "select count(*)::text as n from appointments a join contacts ct on ct.id=a.contact_id where a.company_id=$1 and ct.ghl_contact_id='GC-TESS' and (a.booked_at at time zone $2)::date = $3::date", [companyId, TZ, today]))!.n));
    const allBookedToday = await asOperator(async (c) => Number((await one<{ n: string }>(c, "select count(*)::text as n from appointments a where a.company_id=$1 and (a.booked_at at time zone $2)::date = $3::date", [companyId, TZ, today]))!.n));
    expect(tessBookedToday).toBeGreaterThan(0);
    expect(total("booked")).toBe(allBookedToday - tessBookedToday);
  });
  it("D76: a refiled answer edits, never adds: no-show then showed / closed edits the one thread line, takes the 👻 and stat-no-show back, moves the setter card back to Showed (won) and the closer card back to Scheduled, and updates the same Sales Call record", async () => {
    await asOperator(async (c) => {
      await c.query("insert into slack_connections (company_id, team_id, bot_token, channels) values ($1,'T1',$2,'{}')", [companyId, encrypt("xoxb-fake")]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'slack.channel.bookings','channel',$2)", [companyId, Buffer.from("CBOOK")]);
    });
    ghlContacts = [...ghlContacts, person("GC-RAY", "ray@x.com", "Ray")];
    await pollAll(fake);
    events = [appt("EV-RAY", day(1, 10), { invitee: { email: "ray@x.com", firstName: "Ray", lastName: "Sweep", timezone: TZ } })];
    await pollAll(fake); await tick(fake, undefined, companyId);
    const ray = await apptId("EV-RAY");
    const booking = slack.find((m) => m.op === "post" && m.channel === "CBOOK" && !m.thread)!;
    const cards = await asOperator((c) => many<{ ghl_pipeline_id: string; ghl_opportunity_id: string }>(c, "select p.ghl_pipeline_id, p.ghl_opportunity_id from pipeline_cards p join contacts ct on ct.id=p.contact_id where ct.ghl_contact_id='GC-RAY'", []));
    const setter = cards.find((k) => k.ghl_pipeline_id === "PIPE-S")!.ghl_opportunity_id, closer = cards.find((k) => k.ghl_pipeline_id === "PIPE-C")!.ghl_opportunity_id;
    const rec = (await asOperator((c) => one<{ ghl_record_id: string }>(c, "select ghl_record_id from crm_records where company_id=$1 and record_key='EV-RAY'", [companyId])))!.ghl_record_id;

    await file(ray, "noshow"); await tick(fake, undefined, companyId);
    const line = slack.find((m) => m.op === "post" && m.thread === booking.ts)!;
    expect(line.text).toMatch(/^👻 No-show/);
    expect(cardOps.filter((k) => k.id === setter).at(-1)).toMatchObject({ stageId: "ST-S-CX", status: "lost" });

    const n = slack.length, nt = tagOps.length, nc = cardOps.length, nr = records.length;
    await file(ray, "showed", "closed"); await tick(fake, undefined, companyId);
    const after = slack.slice(n);
    expect(after.filter((m) => m.op === "post")).toEqual([]);   // nothing new in the channel or the thread
    expect(after.find((m) => m.op === "update")).toMatchObject({ ts: line.ts, text: "✅ Showed, per James Closer: closed." });
    expect(after).toContainEqual(expect.objectContaining({ op: "unreact", ts: booking.ts, emoji: "ghost" }));
    expect(after).toContainEqual(expect.objectContaining({ op: "react", ts: booking.ts, emoji: "white_check_mark" }));
    expect(tagOps.slice(nt).filter((t) => t.op === "remove").map((t) => t.tag).sort()).toEqual(["stat-no-show", "stat-possible-cancel"]);
    expect(tagOps.slice(nt).filter((t) => t.op === "remove").map((t) => t.tag)).not.toContain("stat-showed");
    expect(cardOps.slice(nc)).toEqual(expect.arrayContaining([{ id: setter, stageId: "ST-SHOWED", status: "won" }, { id: closer, stageId: "ST-SCHED", status: "open" }]));
    expect(records.slice(nr).filter((r) => r.object === "custom_objects.sales_call")).toEqual([expect.objectContaining({ op: "update", id: rec, props: expect.objectContaining({ outcome: "showed", disposition: "closed_won" }) })]);
    // filing the same answer again changes nothing anywhere
    const m = slack.length; await tick(fake, undefined, companyId); expect(slack.length).toBe(m);
  });
  it("D77: a changed answer leaves nothing of the old one: closed → no-show empties the disposition, cash, objection, next step and payment terms on the Sales Call (null, which the CRM clears), the ✅ and the closed tags come off, the closer card leaves Scheduled; lost → follow-up reopens the card; → rescheduled on the call edits the line and takes the reaction back", async () => {
    const ray = await apptId("EV-RAY");
    const booking = slack.find((m) => m.op === "post" && m.channel === "CBOOK" && !m.thread)!;
    const line = slack.find((m) => m.op === "post" && m.thread === booking.ts)!;
    const rec = (await asOperator((c) => one<{ ghl_record_id: string }>(c, "select ghl_record_id from crm_records where company_id=$1 and record_key='EV-RAY'", [companyId])))!.ghl_record_id;
    const closer = (await asOperator((c) => one<{ ghl_opportunity_id: string }>(c, "select p.ghl_opportunity_id from pipeline_cards p join contacts ct on ct.id=p.contact_id where ct.ghl_contact_id='GC-RAY' and p.ghl_pipeline_id='PIPE-C'", [])))!.ghl_opportunity_id;
    const held = { disposition: null, cash_collected: null, objection_primary: null, next_step: null, next_step_date: null, payment_terms: null };
    const sc = (from: number) => records.slice(from).filter((r) => r.object === "custom_objects.sales_call");

    let n = slack.length, nt = tagOps.length, nc = cardOps.length, nr = records.length;
    await file(ray, "noshow"); await tick(fake, undefined, companyId);
    expect(sc(nr)).toEqual([{ op: "update", object: "custom_objects.sales_call", id: rec, props: { external_id: "EV-RAY", outcome: "no_show", ...held } }]);
    expect(slack.slice(n).find((m) => m.op === "update")).toMatchObject({ ts: line.ts, text: expect.stringMatching(/^👻 No-show/) });
    expect(slack.slice(n)).toContainEqual(expect.objectContaining({ op: "unreact", ts: booking.ts, emoji: "white_check_mark" }));
    expect(tagOps.slice(nt).filter((t) => t.op === "remove").map((t) => t.tag).sort()).toEqual(["stat-closed-won", "stat-showed"]);
    expect(cardOps.slice(nc)).toContainEqual({ id: closer, stageId: "ST-C-CX", status: "open" });
    const tags = (await asOperator((c) => one<{ tags: string[] }>(c, "select tags from contacts where company_id=$1 and ghl_contact_id='GC-RAY'", [companyId])))!.tags;
    expect(tags).toContain("stat-no-show"); expect(tags).not.toContain("stat-showed"); expect(tags).not.toContain("stat-closed-won");

    await file(ray, "showed", "lost"); await tick(fake, undefined, companyId);
    expect(cardOps.at(-1)).toEqual({ id: closer, stageId: "ST-LOST", status: "lost" });
    nc = cardOps.length; nr = records.length;
    await file(ray, "showed", "follow_up"); await tick(fake, undefined, companyId);
    expect(cardOps.slice(nc)).toContainEqual({ id: closer, stageId: "ST-FU", status: "open" });   // a lost card is reopened, not left lost
    expect(sc(nr)).toEqual([expect.objectContaining({ id: rec, props: expect.objectContaining({ outcome: "showed", disposition: "follow_up" }) })]);

    n = slack.length; nr = records.length;
    await file(ray, "rescheduled"); await tick(fake, undefined, companyId);
    expect(sc(nr)).toEqual([{ op: "update", object: "custom_objects.sales_call", id: rec, props: { external_id: "EV-RAY", outcome: "rescheduled", ...held } }]);
    expect(slack.slice(n).filter((m) => m.op === "post")).toEqual([]);
    expect(slack.slice(n).find((m) => m.op === "update")).toMatchObject({ ts: line.ts, text: "🔁 Rescheduled or cancelled on the call, per James Closer." });
    expect(slack.slice(n)).toContainEqual(expect.objectContaining({ op: "unreact", ts: booking.ts, emoji: "white_check_mark" }));
    // a show with no call outcome empties the disposition the follow-up set
    nr = records.length;
    await file(ray, "showed"); await tick(fake, undefined, companyId);
    expect(sc(nr)).toEqual([expect.objectContaining({ id: rec, props: { external_id: "EV-RAY", outcome: "showed", disposition: null } })]);
  });
});
