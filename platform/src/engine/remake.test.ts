/**
 * D120: Calendly re-makes an event when the host edits it in a connected calendar ("Rescheduled from connected calendar
 * event"), often at the very same time. That call did not move, so it keeps the one Sales Call record Call booked made for it,
 * however many times its event id changes: the steps keyed by the slot (Call outcome filed's r1/r2/r3, Call recorded's record)
 * update that record and never make a second. A real move after a re-make logs the record Call booked made as rescheduled.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "./crypto";
import { installCompany, type InstallInput } from "./install";
import { loadCompany } from "./context";
import { applyAppointment } from "./poll";
import { recordDisposition } from "./disposition";
import { recordRecording } from "./recordings";
import { dispatchEvent } from "./dispatch";
import { tick } from "./runner";
import { backfillSalesCalls } from "./sales-call-backfill";
import { fakeAdapters } from "./test-install";
import type { Adapters, AppointmentSnapshot, Classification } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/New_York";
const OBJECT = "custom_objects.sales_call";

// the CRM's Sales Call records, by id, as GHL keeps them
const crm = new Map<string, { object: string; properties: Record<string, unknown> }>();
let seq = 0;
const analysis = { notes: { summary: "Good call.", pain: [], objections: [], disposition: "follow_up", primary_objection: "price", next_step: "call Friday" }, rubric: { overall_score: 7, scores: {}, strengths: [], misses: [], coaching: [] } };
const f = fakeAdapters();
// what the booking source holds now, by event id (a run re-reads its booking before it acts)
const source = new Map<string, AppointmentSnapshot>();
const fake: Adapters = { ...f,
  read: { ...f.read, listUsers: async () => [{ id: "U-CLOSER", name: "Casey Closer", email: "casey@remake.test" }],
    objectRecords: async (_c, object) => [...crm.entries()].filter(([, r]) => r.object === object).map(([id, r]) => ({ id, createdAt: new Date().toISOString(), properties: { ...r.properties } })) },
  booking: (() => { const b = { appointmentsInWindow: async () => [], listCalendars: async () => [{ id: "CAL", name: "Strategy Call", teamMemberIds: ["U-CLOSER"] }], getAppointment: async (_c: unknown, id: string) => source.get(id) ?? null }; return { ghl: b, calendly: b }; })(),
  write: { ...f.write,
    createRecord: async (_c, object, properties) => { const id = `SC-${++seq}`; crm.set(id, { object, properties: { ...properties } }); return { id }; },
    updateRecord: async (_c, _object, id, properties) => { const r = crm.get(id); if (!r) throw new Error(`no record ${id}`); Object.assign(r.properties, properties); } },
  classifier: { choice: async (_s, _i, options): Promise<Classification> => ({ value: options.includes("sales_call") ? "sales_call" : options.includes("follow_up") ? "follow_up" : options[0], confidence: 1, distribution: {}, unclear: false }) },
  analyst: { analyze: async () => ({ text: JSON.stringify(analysis), parsed: analysis, model: "fake", usage: { input: 1, output: 1, cacheRead: 0 } }) },
};

const CRM = { pipeline_setter: "P-S", pipeline_closer: "P-C", stage_closer_scheduled: "ST-SCHED", stage_closer_follow_up: "ST-FU", stage_closer_lost: "ST-LOST", stage_closer_disqualified: "ST-DQ", stage_closer_cancelled: "ST-CXL",
  stage_closer_agreement_sent: "ST-AGREE", stage_closer_closed_won: "ST-WON", stage_setter_showed: "ST-S-SHOWED", stage_setter_cancelled: "ST-S-CXL", stage_setter_appointment_set: "ST-AS", stage_setter_direct_booked: "ST-DB",
  field_contact_cash_collected: "F-CASH", field_contact_revenue_generated: "F-REV", field_contact_appointment_date: "F-AD", field_contact_setter: "F-SE", field_opportunity_setter_owner: "F-SO",
  assoc_sales_call_contact: "A-SC", assoc_sales_call_opportunity: "A-SO", agreement_template: "TPL", agreement_sender: "U-CLOSER" };
const OUTCOMES = { scheduled: "scheduled", showed: "showed", no_show: "noshow", cancelled: "cancelled", rescheduled: "rescheduled" } as const;
const TABLES = ["step_effects", "alerts", "eod_reports", "slack_posts", "agreements", "sends", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "recordings", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"];

async function wipe(slug: string) {
  await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return;
    await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
    await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
    await c.query("update appointments set disposition_id=null where company_id=$1", [co.id]);
    for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
    await c.query("delete from companies where id=$1", [co.id]);
  });
}
/** A company on Call booked, Call outcome filed and Call recorded, all on; on Calendly unless `ghl`. */
async function company(slug: string, mode: "live" | "ghost", ghl = false): Promise<string> {
  await wipe(slug);
  const input: InstallInput = { name: slug, slug, timezone: TZ, locationId: `LOC-${slug}`, pit: "fake", calendars: { CAL: "closing" }, closers: ["casey@remake.test"], crm: CRM, salesCall: { object: OBJECT, outcomes: OUTCOMES },
    templates: ["call-booked", "call-outcome", "call-recorded"], enable: true, anthropicKey: "sk-fake", contractValueDefault: 5000 };
  const id = (await installCompany(input, fake)).companyId;
  await asOperator(async (c) => {
    await c.query("update companies set mode=$2, send_window_start='00:00', send_window_end='23:59' where id=$1", [id, mode]);
    await c.query("update workflows set enabled=true where company_id=$1", [id]);
    if (!ghl) {
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'secret.calendly_token','secret',$2),($1,'calendly.organization','id',$3)", [id, encrypt("tok"), Buffer.from("https://api.calendly.com/organizations/O")]);
      await c.query("update calendars set source='calendly' where company_id=$1", [id]);
    }
  });
  return id;
}
async function person(co: string, name: string): Promise<{ ct: string; ghl: string; email: string }> {
  const ghl = `G-${name}`, email = `${name.toLowerCase()}@lead.test`;
  const ct = await asOperator(async (c) => {
    const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,$2,$3,'Lee',$4) returning id", [co, ghl, name, TZ]))!.id;
    await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [co, id, email]);
    return id;
  });
  return { ct, ghl, email };
}
type Who = Awaited<ReturnType<typeof person>>;

const START = DateTime.now().minus({ hours: 2 }).set({ second: 0, millisecond: 0 });
/** A Calendly event for the person (the poll's snapshot); `ghl`: the CRM's own calendar, which names the contact by id. */
const event = (who: Who, id: string, at: DateTime, over: Partial<AppointmentSnapshot> = {}, ghl = false): AppointmentSnapshot => ({ id, calendarId: "CAL", startTime: at.toUTC().toISO()!, endTime: at.plus({ minutes: 45 }).toUTC().toISO()!, status: "confirmed",
  dateAdded: START.minus({ days: 2 }).toISO()!, raw: {}, ...(ghl ? { contactId: who.ghl, assignedUserId: "U-CLOSER" } : { assignedUserEmail: "casey@remake.test", invitee: { email: who.email, firstName: who.email.split("@")[0], lastName: "Lee" } }), ...over });
/** What the poll does with a tick's snapshots. */
const poll = (co: string, ...snaps: AppointmentSnapshot[]) => asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, co); for (const s of snaps) { source.set(s.id, s); await applyAppointment(c, row, adapterCompany, fake, s); } });
const run = async (co: string) => { for (let i = 0; i < 3; i++) await tick(fake, DateTime.now() as DateTime<true>, co); };
/** Calendly re-makes `from` as `to` at the same time: the old one cancelled by the host, rescheduled into the new one. */
const remake = (who: Who, from: string, to: string, at: DateTime = START) => [event(who, from, at, { status: "cancelled", rescheduledTo: to, cancellation: { byType: "host", by: "Casey Closer", reason: "Rescheduled from connected calendar event" } }), event(who, to, at, { rescheduledFrom: from })];

const apptOf = (co: string, who: Who) => asOperator((c) => one<{ id: string; external_id: string; slot_key: string; starts_at: Date }>(c, "select id, external_id, coalesce(slot_key, external_id) as slot_key, starts_at from appointments where company_id=$1 and contact_id=$2", [co, who.ct]));
const ours = (co: string, who: Who) => asOperator((c) => many<{ record_key: string; ghl_record_id: string | null; properties: Record<string, unknown> }>(c, "select record_key, ghl_record_id, properties from crm_records where company_id=$1 and contact_id=$2 and object_key=$3 order by created_at", [co, who.ct, OBJECT]));
const inCrm = (who: Who) => [...crm.entries()].filter(([, r]) => r.properties.contact_id === who.ghl).map(([id, r]): Record<string, unknown> => ({ id, ...r.properties }));
async function file(co: string, who: Who, outcome: string, callOutcome?: string) {
  const a = (await apptOf(co, who))!;
  await asOperator(async (c) => {
    const term = async (domain: string, cat: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain=$2 and category=$3 and active order by is_default desc limit 1", [co, domain, cat]))!.id;
    await recordDisposition(c, { companyId: co, appointmentId: a.id, outcomeTermId: await term("appointment_outcome", outcome), callOutcomeTermId: callOutcome ? await term("call_outcome", callOutcome) : undefined });
  });
  await run(co);
}
async function record(co: string, who: Who, id: string) {
  const a = (await apptOf(co, who))!;
  const r = await asOperator((c) => recordRecording(c, co, { externalId: id, title: `${who.email} and Casey Closer`, startedAt: new Date(a.starts_at.getTime() + 60e3), durationMin: 40, shareUrl: `https://fathom.video/share/${id}`, recordedBy: { name: "Casey Closer", email: "casey@remake.test" },
    invitees: [{ name: "Casey Closer", email: "casey@remake.test", isExternal: false }, { name: who.email, email: who.email, isExternal: true }], transcript: [{ speaker: who.email, text: "Let me think about it." }] }));
  expect(r.outcome).toBe("linked"); if (r.outcome !== "linked") return;
  expect(r.appointmentId).toBe(a.id);
  await asOperator((c) => dispatchEvent(c, r.event, { contact: { id: who.ct }, appointment: { id: a.id } }));
  await run(co);
}
const lastStep = (co: string, who: Who, slug: string, node: string) => asOperator((c) => one<{ status: string; result: Record<string, unknown> }>(c,
  "select s.status, s.result from run_steps s join runs r on r.id=s.run_id join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where r.company_id=$1 and r.contact_id=$2 and t.slug=$3 and s.node_id=$4 order by s.started_at desc limit 1", [co, who.ct, slug, node]));

describe.skipIf(!process.env.DATABASE_URL)("D120: a call Calendly re-makes at the same time keeps its one Sales Call record", () => {
  let live: string, shadow: string, ghl: string, mona: Who;
  beforeAll(async () => {
    await migrate();
    live = await company("remake-live", "live");
    shadow = await company("remake-shadow", "ghost");
    ghl = await company("remake-ghl", "live", true);
  });

  it("the re-made booking keeps its slot: Call outcome filed updates the record Call booked made, and Call recorded updates it too; no second record", async () => {
    const who = await person(live, "Rita");
    await poll(live, event(who, "EV-R1", START));
    await run(live);
    expect(inCrm(who)).toEqual([expect.objectContaining({ external_id: "EV-R1", outcome: "scheduled" })]);
    // the host edits the event in her connected calendar: Calendly cancels it and makes a new one at the very same time
    await poll(live, ...remake(who, "EV-R1", "EV-R2"));
    expect(await apptOf(live, who)).toMatchObject({ external_id: "EV-R2", slot_key: "EV-R1" });
    const events = await asOperator((c) => many<{ event_type: string }>(c, "select event_type from events where company_id=$1 and contact_id=$2 and event_type like 'appointment.%' order by id", [live, who.ct]));
    expect(events.map((e) => e.event_type)).toEqual(["appointment.booked"]);   // no move: no reschedule

    await file(live, who, "showed", "follow_up");
    expect(await lastStep(live, who, "call-outcome", "r1")).toMatchObject({ status: "ok", result: expect.objectContaining({ record: "updated" }) });
    await record(live, who, "fathom-rita");
    expect(inCrm(who)).toEqual([expect.objectContaining({ external_id: "EV-R1", outcome: "showed", disposition: "follow_up", recording_url: "https://fathom.video/share/fathom-rita" })]);
    expect((await ours(live, who)).map((r) => r.record_key)).toEqual(["EV-R1"]);
  });

  it("re-made twice, the call still has the one record", async () => {
    const who = await person(live, "Tess");
    await poll(live, event(who, "EV-T1", START));
    await run(live);
    await poll(live, ...remake(who, "EV-T1", "EV-T2"));
    await poll(live, ...remake(who, "EV-T2", "EV-T3"));
    expect(await apptOf(live, who)).toMatchObject({ external_id: "EV-T3", slot_key: "EV-T1" });
    await file(live, who, "noshow");
    await record(live, who, "fathom-tess");
    const recs = inCrm(who);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ external_id: "EV-T1" });   // the recording, read as a sales call, updates the one record (its outcome is the end of day's, D271)
    expect((await ours(live, who)).map((r) => r.record_key)).toEqual(["EV-T1"]);
  });

  it("re-made twice between two polls (the new event names one the engine never saw): still the one booking and the one record", async () => {
    const who = await person(live, "Nora");
    await poll(live, event(who, "EV-N1", START));
    await run(live);
    const [n1, n2] = remake(who, "EV-N1", "EV-N2");
    const [, n3] = remake(who, "EV-N2", "EV-N3");
    await poll(live, n1, { ...n2, status: "cancelled", rescheduledTo: "EV-N3" }, n3);
    const rows = await asOperator((c) => many<{ external_id: string; slot_key: string }>(c, "select external_id, coalesce(slot_key, external_id) as slot_key from appointments where company_id=$1 and contact_id=$2", [live, who.ct]));
    expect(rows).toEqual([{ external_id: "EV-N3", slot_key: "EV-N1" }]);
    const events = await asOperator((c) => many<{ event_type: string }>(c, "select event_type from events where company_id=$1 and contact_id=$2 and event_type like 'appointment.%' order by id", [live, who.ct]));
    expect(events.map((e) => e.event_type)).toEqual(["appointment.booked"]);
    await run(live);
    await file(live, who, "showed", "follow_up");
    expect(inCrm(who)).toEqual([expect.objectContaining({ external_id: "EV-N1", outcome: "showed", disposition: "follow_up" })]);
  });

  it("a re-make and then a real move: the record Call booked made is logged rescheduled, the new slot gets its own, and the outcome lands on the new one", async () => {
    const who = mona = await person(live, "Mona");
    await poll(live, event(who, "EV-M1", START));
    await run(live);
    await poll(live, ...remake(who, "EV-M1", "EV-M2"));
    const later = START.plus({ minutes: 30 });
    await poll(live, event(who, "EV-M2", START, { status: "cancelled", rescheduledTo: "EV-M3" }), event(who, "EV-M3", later, { rescheduledFrom: "EV-M2" }));
    const moved = (await asOperator((c) => one<{ data: { slot: { from: string; to: string } } }>(c, "select data from events where company_id=$1 and contact_id=$2 and event_type='appointment.rescheduled'", [live, who.ct])))!;
    expect(moved.data.slot).toEqual({ from: "EV-M1", to: "EV-M3" });
    await run(live);
    await file(live, who, "showed", "follow_up");
    const recs = inCrm(who);
    expect(recs).toHaveLength(2);
    expect(recs.find((r) => r.external_id === "EV-M1")).toMatchObject({ outcome: "rescheduled" });
    expect(recs.find((r) => r.external_id === "EV-M3")).toMatchObject({ outcome: "showed", disposition: "follow_up" });
    expect((await ours(live, who)).map((r) => r.record_key).sort()).toEqual(["EV-M1", "EV-M3"]);
  });

  it("the Sales Call backfill names the slot the call left as the engine did: one left slot under the record Call booked made, never a second under the re-made event's id", async () => {
    const theirs = [...source.values()].filter((e) => e.id.startsWith("EV-M"));
    const reading: Adapters = { ...fake, booking: { ghl: fake.booking.ghl, calendly: { ...fake.booking.calendly, appointmentsInWindow: async (_c, cal) => theirs.filter((e) => e.calendarId === cal) } } };
    const r = await asOperator(async (c) => backfillSalesCalls(c, await loadCompany(c, live), reading, { from: START.minus({ days: 1 }).toJSDate(), to: START.plus({ days: 1 }).toJSDate(), dryRun: true }));
    const rows = r.rows.filter((x) => x.contact.id === mona.ct).map((x) => [x.kind, x.slot_key]);
    expect(rows.sort()).toEqual([["booking", "EV-M3"], ["left_slot", "EV-M1"]]);
  });

  it("in shadow the engine's own record is the one it keeps: the outcome updates the row Call booked wrote, nothing reaches the CRM", async () => {
    const who = await person(shadow, "Sara");
    await poll(shadow, event(who, "EV-S1", START));
    await run(shadow);
    await poll(shadow, ...remake(who, "EV-S1", "EV-S2"));
    await file(shadow, who, "showed", "follow_up");
    await record(shadow, who, "fathom-sara");
    expect(inCrm(who)).toEqual([]);
    const rows = await ours(shadow, who);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ record_key: "EV-S1", ghl_record_id: null, properties: expect.objectContaining({ external_id: "EV-S1", outcome: "showed", disposition: "follow_up" }) });
  });

  it("a GHL calendar keeps the booking's id: a move is a slot of its own as before, and the outcome lands on the new slot's record", async () => {
    const who = await person(ghl, "Gwen");
    await poll(ghl, event(who, "G-APPT", START, {}, true));
    await run(ghl);
    expect(await apptOf(ghl, who)).toMatchObject({ external_id: "G-APPT", slot_key: "G-APPT" });
    // the same snapshot again (the time unchanged) changes nothing
    await poll(ghl, event(who, "G-APPT", START, {}, true));
    expect(await apptOf(ghl, who)).toMatchObject({ slot_key: "G-APPT" });
    const later = START.plus({ minutes: 30 });
    await poll(ghl, event(who, "G-APPT", later, {}, true));
    const slot = `G-APPT@${later.toUTC().toISO()}`;
    expect(await apptOf(ghl, who)).toMatchObject({ external_id: "G-APPT", slot_key: slot });
    await run(ghl);
    await file(ghl, who, "showed", "follow_up");
    const recs = inCrm(who);
    expect(recs).toHaveLength(2);
    expect(recs.find((r) => r.external_id === "G-APPT")).toMatchObject({ outcome: "rescheduled" });
    expect(recs.find((r) => r.external_id === slot)).toMatchObject({ outcome: "showed", disposition: "follow_up" });
  });
});
