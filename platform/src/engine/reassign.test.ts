/**
 * D254: a call handed from one closer to another. The doors emit `appointment.reassign_requested`; a workflow's
 * `update_appointment` `set.closer` moves the call in the engine (kept through the calendar's reschedules) and says so with
 * `appointment.reassigned`; whether the client spoke is kept on the recording.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { tick } from "@/engine/runner";
import { fakeAdapters } from "@/engine/test-install";
import { syncTriggers, installCompany } from "@/engine/install";
import { parseDefinition, extractManifest } from "@/engine/definition";
import { loadCompany } from "@/engine/context";
import { applyAppointment } from "@/engine/poll";
import { requestReassign, callsOf } from "@/engine/reassign";
import { clientSpoke } from "@/engine/recordings";
import type { AppointmentSnapshot } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const HAS_DB = !!process.env.DATABASE_URL;
const TZ = "America/Phoenix";
const SLUG = `d253-${Date.now()}`;
const fake = fakeAdapters();
let co = "", jp = "", min = "", ct = "", cal = "";

const flow = (name: string, nodes: Record<string, unknown>[], edges: Record<string, unknown>[]) => ({ schema: 1, reentry: "always", premise: { check: "contact_exists" }, name, nodes, edges });
const DEFS = [
  flow("Hand it over", [{ id: "t1", type: "trigger", event: "appointment.reassign_requested" },
    { id: "n1", type: "update_appointment", set: { closer: "{{event.to.email}}", reassigned_by: "{{event.via}}: {{event.by}}" } },
    { id: "n2", type: "set_var", key: "now_with", value: "{{appointment.closer.name}}" }, { id: "x1", type: "exit", reason: "done" }],
    [{ from: "t1", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "x1" }]),
  flow("Heard it", [{ id: "t1", type: "trigger", event: "appointment.reassigned" }, { id: "x1", type: "exit", reason: "heard" }], [{ from: "t1", to: "x1" }]),
];
const tickNow = () => tick(fake, DateTime.now() as DateTime<true>, co);
const appt = (id: string) => asOperator((c) => one<{ assigned_user_id: string; reassigned_at: Date | null; reassigned_by: string | null; starts_at: Date }>(c, "select assigned_user_id, reassigned_at, reassigned_by, starts_at from appointments where id=$1", [id]));

describe.skipIf(!HAS_DB)("D254: reassigning a call", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "D254", slug: SLUG, timezone: TZ, locationId: "LOC-D254", pit: "pit-fake", calendars: {}, templates: [] }, fake)).companyId;
    await asOperator(async (c) => {
      await c.query("update companies set mode='live' where id=$1", [co]);
      jp = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,'jp@x.com','Jose P','closer','U-JP') returning id", [co]))!.id;
      min = (await one<{ id: string }>(c, "insert into users (company_id, email, name, role, ghl_user_id) values ($1,'min@x.com','Minerva Rostro','closer','U-MIN') returning id", [co]))!.id;
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [co]))!.id;
      cal = (await one<{ id: string }>(c, "insert into calendars (company_id, external_id, name, appointment_term, active) values ($1,'CAL-RR','Consultation RR',$2,true) returning id", [co, term]))!.id;
      ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,'G-BERTHA','Bertha','Ekoko',$2) returning id", [co, TZ]))!.id;
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'secret.ghl_pit','secret',$2) on conflict (company_id,key) do nothing", [co, encrypt("p")]);
      for (const d of DEFS) {
        const { name, ...definition } = d; const def = parseDefinition(definition);
        const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled, mode) values ($1,$2,'always',true,'live') returning id", [co, name]))!;
        await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,1,$2,$3,'d253 test')", [wf.id, def, extractManifest(def)]);
        await syncTriggers(c, co, wf.id, def);
      }
    });
  });

  it("a request names who from and who to, starts the workflow; the step hands the call over, marks it a person's choice and says so once", async () => {
    const at = DateTime.now().setZone(TZ).plus({ days: 1 }).set({ hour: 14, minute: 0 });
    const id = (await asOperator((c) => one<{ id: string }>(c, `insert into appointments (company_id, contact_id, source, external_id, calendar_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status)
      select $1,$2,'ghl','EV-B',$3,appointment_term,$4,$5,$6,now(),'confirmed' from calendars where id=$3 returning id`, [co, ct, cal, jp, at.toJSDate(), at.plus({ minutes: 45 }).toJSDate()])))!.id;
    expect((await asOperator((c) => callsOf(c, co, jp, at.toISODate()!, TZ))).map((x) => x.who)).toEqual(["Bertha Ekoko"]);
    expect(await asOperator((c) => requestReassign(c, co, { appointmentId: id, toUserId: jp, via: "slack", by: "Jose P" }))).toMatchObject({ ok: false, status: 409 });
    const r = await asOperator((c) => requestReassign(c, co, { appointmentId: id, toUserId: min, via: "slack", by: "Jose P", why: "sick" }));
    expect(r).toMatchObject({ ok: true, runs: 1, from: { name: "Jose P" }, to: { name: "Minerva Rostro" } });
    await tickNow(); await tickNow();
    expect(await appt(id)).toMatchObject({ assigned_user_id: min, reassigned_by: "slack: Jose P", reassigned_at: expect.any(Date) });
    const evs = await asOperator((c) => many<{ event_type: string; data: Record<string, unknown> }>(c, "select event_type, data from events where appointment_id=$1 and event_type like 'appointment.reassign%' order by id", [id]));
    expect(evs).toEqual([
      { event_type: "appointment.reassign_requested", data: expect.objectContaining({ from: { name: "Jose P", email: "jp@x.com" }, to: expect.objectContaining({ name: "Minerva Rostro", email: "min@x.com" }), via: "slack", by: "Jose P", why: "sick", past: false }) },
      { event_type: "appointment.reassigned", data: expect.objectContaining({ from: { name: "Jose P", email: "jp@x.com" }, to: { name: "Minerva Rostro", email: "min@x.com" }, by: "slack: Jose P", node: "n1" }) }]);
    const runs = await asOperator((c) => many<{ name: string; exit_reason: string; vars: Record<string, unknown> }>(c, "select w.name, r.exit_reason, r.context->'vars' as vars from runs r join workflows w on w.id=r.workflow_id where r.appointment_id=$1 order by r.started_at", [id]));
    expect(runs).toEqual([expect.objectContaining({ name: "Hand it over", exit_reason: "done", vars: expect.objectContaining({ now_with: "Minerva Rostro" }) }), expect.objectContaining({ name: "Heard it", exit_reason: "heard" })]);
    expect((await asOperator((c) => callsOf(c, co, min, at.toISODate()!, TZ))).map((x) => x.who)).toEqual(["Bertha Ekoko"]);
  });

  it("the calendar's host no longer decides a reassigned call: a reschedule moves it and keeps Minerva; a call nobody reassigned still follows its host", async () => {
    const at = DateTime.now().setZone(TZ).plus({ days: 2 }).set({ hour: 10, minute: 0 });
    const snap = (id: string, start: DateTime): AppointmentSnapshot => ({ id, calendarId: "CAL-RR", contactId: "G-BERTHA", assignedUserId: "U-JP", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateUpdated: new Date().toISOString(), raw: {} } as AppointmentSnapshot);
    const poll = (s: AppointmentSnapshot) => asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, co); await applyAppointment(c, row, adapterCompany, fake, s); });
    await poll(snap("EV-R1", at)); await poll(snap("EV-R2", at.plus({ hours: 1 })));
    const [r1, r2] = await asOperator((c) => many<{ id: string }>(c, "select id from appointments where company_id=$1 and external_id in ('EV-R1','EV-R2') order by external_id", [co]));
    await asOperator((c) => c.query("update appointments set assigned_user_id=$2, reassigned_at=now(), reassigned_by='test' where id=$1", [r1.id, min]));
    await asOperator((c) => c.query("update appointments set assigned_user_id=$2 where id=$1", [r2.id, min]));   // a drift nobody chose
    await poll(snap("EV-R1", at.plus({ days: 1 }))); await poll(snap("EV-R2", at.plus({ days: 1, hours: 1 })));
    expect(await appt(r1.id)).toMatchObject({ assigned_user_id: min, starts_at: at.plus({ days: 1 }).toJSDate() });
    expect((await appt(r2.id))!.assigned_user_id).toBe(jp);
  });

  it("whether the client spoke: a guest's line says yes, only the team says no, no transcript says nothing", async () => {
    const base = { externalId: "x", startedAt: new Date(), invitees: [{ name: "Bertha", email: "b@x.com", isExternal: true }], recordedBy: { email: "min@x.com", name: "Minerva Rostro" } };
    expect(await asOperator((c) => clientSpoke(c, co, { ...base, transcript: [{ speaker: "Minerva Rostro", text: "hi" }, { speaker: "Bertha Ekoko", text: "hello" }] }))).toBe(true);
    expect(await asOperator((c) => clientSpoke(c, co, { ...base, transcript: [{ speaker: "Minerva Rostro", text: "hi" }, { speaker: "Jose P", email: "jp@x.com", text: "what's up" }] }))).toBe(false);
    expect(await asOperator((c) => clientSpoke(c, co, { ...base, transcript: [] }))).toBeNull();
  });
});
