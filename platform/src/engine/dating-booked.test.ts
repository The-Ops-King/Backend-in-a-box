/**
 * D123: Dating (Nelly) books in her Calendly on two event types, each its own call type (D101): the Strategy Session ("Strategy
 * session", the Typeform's link) and the Private Dating Consultation ("Consultation", the closer call). Call booked is taken
 * over by her own two workflows, made through the definition route: Triage call booked (a Strategy session: the standard
 * steps plus stat-triage-first, the Sales Call's call type strategy_session) and Sales call booked (a Consultation: the
 * standard steps, call type closing). A booking runs exactly one of them; a reschedule runs the same one again; a cancel and a
 * filed outcome run Call cancelled and Call outcome filed as for any closing call. Install never puts Call booked back.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "./crypto";
import { installCompany, type InstallInput } from "./install";
import { loadCompany } from "./context";
import { applyAppointment } from "./poll";
import { recordDisposition } from "./disposition";
import { tick } from "./runner";
import { fakeAdapters } from "./test-install";
import type { Adapters, AppointmentSnapshot } from "@/adapters/types";
import { POST as definitionRoute } from "../../app/api/admin/workflows/definition/route";
import { DELETE as workflowsDelete } from "../../app/api/admin/workflows/route";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const KEY = "d123-operator-key", prevSecret = process.env.CRON_SECRET;
const req = (url: string, method: string, body: unknown) => new Request(`http://x${url}`, { method, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const DIR = path.resolve(__dirname, "../../installs/dating-nelly");
type OwnFile = { workflow: string; name: string; note: string; definition: unknown; create: { stage: string; sort: number; takesOver?: string } };
const own = (slug: string) => JSON.parse(fs.readFileSync(path.join(DIR, `${slug}.json`), "utf8")) as OwnFile;
const TZ = "America/Los_Angeles", SLUG = "d123booked", OBJECT = "custom_objects.dating_sales_call";
const STRATEGY = "86985d27-22e5-4b6b-ab66-8e68e9ee8e30", CONSULT = "80955126-29fe-48ea-a85e-ba4bcd145790";

const crm = new Map<string, { object: string; properties: Record<string, unknown> }>();
const tags: { id: string; tag: string }[] = [];
let seq = 0;
const source = new Map<string, AppointmentSnapshot>();
const f = fakeAdapters();
const cals = [{ id: STRATEGY, name: "Complimentary Dating Strategy Session ♡", teamMemberIds: [] }, { id: CONSULT, name: "Private Dating Consultation with Nelly", teamMemberIds: [] }];
const fake: Adapters = { ...f,
  read: { ...f.read, listUsers: async () => [{ id: "U-NELLY", name: "Nelly S.", email: "nellysudri@d123.test" }] },
  booking: (() => { const b = { appointmentsInWindow: async () => [], listCalendars: async () => cals, getAppointment: async (_c: unknown, id: string) => source.get(id) ?? null }; return { ghl: b, calendly: b }; })(),
  write: { ...f.write,
    addTag: async (_c, id, tag) => { tags.push({ id, tag }); },
    createRecord: async (_c, object, properties) => { const id = `SC-${++seq}`; crm.set(id, { object, properties: { ...properties } }); return { id }; },
    updateRecord: async (_c, _object, id, properties) => { const r = crm.get(id); if (!r) throw new Error(`no record ${id}`); Object.assign(r.properties, properties); } },
};
const CRM = { pipeline_setter: "P-S", pipeline_closer: "P-C", stage_closer_scheduled: "ST-SCHED", stage_closer_cancelled: "ST-CXL", stage_closer_follow_up: "ST-FU", stage_setter_direct_booked: "ST-DB", stage_setter_appointment_set: "ST-AS", stage_setter_cancelled: "ST-S-CXL", stage_setter_showed: "ST-S-SHOWED",
  field_contact_appointment_date: "F-AD", field_contact_setter: "F-SE", field_opportunity_setter_owner: "F-SO", object_sales_call: OBJECT, assoc_sales_call_contact: "A-SC", assoc_sales_call_opportunity: "A-SO" };
const input = (over: Partial<InstallInput> = {}): InstallInput => ({ name: "Dating (Nelly) D123", slug: SLUG, timezone: TZ, locationId: "LOC-D123", pit: "fake", scopeTag: "dating", closers: ["nellysudri@d123.test"], crm: CRM,
  salesCall: { object: OBJECT, outcomes: { scheduled: "scheduled", showed: "showed", no_show: "noshow", cancelled: "cancelled", rescheduled: "rescheduled" } },
  calendars: { [STRATEGY]: { term: "closing", name: "Strategy session", booking: "self" }, [CONSULT]: { term: "closing", name: "Consultation", booking: "self" } }, closerCall: CONSULT, bookingCalendar: STRATEGY,
  templates: ["call-booked", "call-cancelled", "call-outcome"], ...over });

let co = "";
const TABLES = ["step_effects", "alerts", "eod_reports", "slack_posts", "agreements", "sends", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "recordings", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"];
async function wipe() {
  await asOperator(async (c) => {
    const old = await one<{ id: string }>(c, "select id from companies where slug=$1", [SLUG]); if (!old) return;
    await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [old.id]);
    await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [old.id]);
    await c.query("update appointments set disposition_id=null where company_id=$1", [old.id]);
    for (const t of TABLES) await c.query(`delete from ${t} where company_id=$1`, [old.id]);
    await c.query("delete from companies where id=$1", [old.id]);
  });
}
async function person(name: string) {
  const ghl = `G-${name}`, email = `${name.toLowerCase()}@lead.test`;
  const ct = await asOperator(async (c) => {
    const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,$2,$3,'Lee',$4) returning id", [co, ghl, name, TZ]))!.id;
    await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email',$3)", [co, id, email]);
    return id;
  });
  return { ct, ghl, email };
}
type Who = Awaited<ReturnType<typeof person>>;
const AT = DateTime.now().plus({ days: 3 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
const event = (who: Who, id: string, calendarId: string, at: DateTime, over: Partial<AppointmentSnapshot> = {}): AppointmentSnapshot => ({ id, calendarId, startTime: at.toUTC().toISO()!, endTime: at.plus({ minutes: 15 }).toUTC().toISO()!, status: "confirmed",
  dateAdded: DateTime.now().toISO()!, raw: {}, assignedUserEmail: "nellysudri@d123.test", invitee: { email: who.email, firstName: who.email.split("@")[0], lastName: "Lee" }, ...over });
const poll = (...snaps: AppointmentSnapshot[]) => asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, co); for (const s of snaps) { source.set(s.id, s); await applyAppointment(c, row, adapterCompany, fake, s); } });
const run = async () => { for (let i = 0; i < 3; i++) await tick(fake, DateTime.now() as DateTime<true>, co); };
const runs = (who: Who) => asOperator(async (c) => (await many<{ name: string }>(c, "select w.name from runs r join workflows w on w.id=r.workflow_id where r.company_id=$1 and r.contact_id=$2 order by r.started_at, w.name", [co, who.ct])).map((r) => r.name));
/** The steps each of a person's runs of a workflow went through (skipped ones marked; one transaction stamps them alike, so no order). */
const stepsOf = (who: Who, wf: string) => asOperator(async (c) => {
  const rs = await many<{ id: string }>(c, "select r.id from runs r join workflows w on w.id=r.workflow_id where r.company_id=$1 and r.contact_id=$2 and w.name=$3 order by r.started_at", [co, who.ct, wf]);
  return Promise.all(rs.map(async (r) => (await many<{ node_id: string; status: string }>(c, "select node_id, status from run_steps where run_id=$1 order by node_id", [r.id])).map((x) => (x.status === "skipped" ? `${x.node_id}:skipped` : x.node_id))));
});
const records = (who: Who) => [...crm.values()].filter((r) => r.properties.contact_id === who.ghl).map((r) => r.properties);

describe.skipIf(!process.env.DATABASE_URL)("D123: Dating (Nelly)'s two booked-call workflows take Call booked's place", () => {
  let sara: Who, cleo: Who;
  beforeAll(async () => {
    process.env.CRON_SECRET = KEY;
    await migrate(); await wipe();
    co = (await installCompany(input(), fake)).companyId;
    await asOperator(async (c) => {
      await c.query("update companies set mode='live', send_window_start='00:00', send_window_end='23:59' where id=$1", [co]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'secret.calendly_token','secret',$2),($1,'calendly.organization','id',$3)", [co, encrypt("tok"), Buffer.from("https://api.calendly.com/organizations/O")]);
      await c.query("update calendars set source='calendly' where company_id=$1", [co]);
    });
  }, 60_000);
  afterAll(() => { if (prevSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevSecret; });

  it("made through the definition route: refused while Call booked is there; Call booked removed; a dry run; then made OFF, version 1, triggers synced, audited; a re-install does not put Call booked back", async () => {
    const make = (slug: string, dryRun = false) => { const o = own(slug); return definitionRoute(req("/api/admin/workflows/definition", "POST", { company: SLUG, workflow: o.name, definition: o.definition, note: o.note, create: o.create, dryRun })); };
    const refused = await make("triage-call-booked");
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/still has "Call booked".*DELETE \/api\/admin\/workflows/);
    const del = await workflowsDelete(req("/api/admin/workflows", "DELETE", { company: SLUG, workflow: "call-booked" }));
    expect(await del.json()).toMatchObject({ ok: true, slug: "call-booked", runs_removed: 0 });
    expect(await (await make("triage-call-booked", true)).json()).toMatchObject({ ok: true, created: false, dryRun: true, layout: "tidy", takesOver: "call-booked" });
    expect(await asOperator((c) => one(c, "select 1 from workflows where company_id=$1 and name='Triage call booked'", [co]))).toBeUndefined();
    for (const slug of ["triage-call-booked", "sales-call-booked"]) expect(await (await make(slug)).json(), slug).toMatchObject({ ok: true, created: true, dryRun: false, layout: "tidy", missing: [] });
    const wfs = await asOperator((c) => many<{ name: string; enabled: boolean; template_id: string | null; takes_over: string; current_version: number; triggers: string[] }>(c,
      "select w.name, w.enabled, w.template_id, w.takes_over, w.current_version, array(select t.node_id || ':' || t.event_type from workflow_triggers t where t.workflow_id=w.id order by t.node_id) as triggers from workflows w where w.company_id=$1 and w.takes_over is not null order by w.name", [co]));
    expect(wfs).toEqual([
      { name: "Sales call booked", enabled: false, template_id: null, takes_over: "call-booked", current_version: 1, triggers: ["t1:appointment.booked", "t2:appointment.rescheduled"] },
      { name: "Triage call booked", enabled: false, template_id: null, takes_over: "call-booked", current_version: 1, triggers: ["t1:appointment.booked", "t2:appointment.rescheduled"] }]);
    expect(await asOperator((c) => many(c, "select after->>'takes_over' as t from audit_log where company_id=$1 and action='workflow.created'", [co]))).toEqual([{ t: "call-booked" }, { t: "call-booked" }]);
    // the same call again finds the workflow by its name: an ordinary save, the same definition, no new version
    expect(await (await make("sales-call-booked")).json()).toMatchObject({ ok: true, saved: false, version: 1 });
    const out = await installCompany(input({ templates: undefined }), fake);
    expect(out.installed).toContain("call-booked → not installed: the company's own “Sales call booked” and “Triage call booked” do its job (D123)");
    expect(await asOperator((c) => many(c, "select 1 from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug='call-booked'", [co]))).toEqual([]);
    await asOperator((c) => c.query("update workflows set enabled=true where company_id=$1 and name in ('Triage call booked','Sales call booked','Call cancelled','Call outcome filed')", [co]));
  });

  it("a booking runs exactly one: a Strategy session is Triage call booked (stat-triage-first, call type strategy_session); a Consultation is Sales call booked (call type closing, no triage tag)", async () => {
    sara = await person("Sara"); cleo = await person("Cleo");
    await poll(event(sara, "EV-S1", STRATEGY, AT), event(cleo, "EV-C1", CONSULT, AT.plus({ hours: 2 })));
    await run();
    expect(await runs(sara)).toEqual(["Triage call booked"]);
    expect(await runs(cleo)).toEqual(["Sales call booked"]);
    expect(records(sara)).toEqual([expect.objectContaining({ external_id: "EV-S1", call_type: "strategy_session", outcome: "scheduled" })]);
    expect(records(cleo)).toEqual([expect.objectContaining({ external_id: "EV-C1", call_type: "closing", outcome: "scheduled" })]);
    const tagsOf = (who: Who) => tags.filter((t) => t.id === who.ghl).map((t) => t.tag);
    expect(tagsOf(sara)).toEqual(expect.arrayContaining(["dating", "stat-booked", "stat-self-booked", "stat-triage-first"]));
    expect(tagsOf(cleo)).toEqual(expect.arrayContaining(["dating", "stat-booked", "stat-self-booked"]));
    expect(tagsOf(cleo)).not.toContain("stat-triage-first");
  });

  it("a reschedule runs the same one again (the slot left logged rescheduled); a cancel runs Call cancelled; a filed outcome runs Call outcome filed on that call's record", async () => {
    await poll(event(sara, "EV-S1", STRATEGY, AT.plus({ days: 1 })));
    await run();
    expect(await runs(sara)).toEqual(["Triage call booked", "Triage call booked"]);
    expect(records(sara)).toEqual([expect.objectContaining({ external_id: "EV-S1", outcome: "rescheduled" }), expect.objectContaining({ call_type: "strategy_session", outcome: "scheduled" })]);
    // one fork after the booking paths: the new booking went to the card and the video task, the reschedule to the card kept as it is and the old slot's record
    const [booked, moved] = await stepsOf(sara, "Triage call booked");
    expect(booked).toEqual(expect.arrayContaining(["f_card", "c_new", "k3", "k4"])); expect(booked).not.toContain("c_rs"); expect(booked).not.toContain("k5");
    expect(moved).toEqual(expect.arrayContaining(["f_card", "c_rs", "k5", "k4"])); expect(moved).not.toContain("c_new"); expect(moved).not.toContain("k3");
    await poll(event(cleo, "EV-C1", CONSULT, AT.plus({ hours: 2 }), { status: "cancelled", cancellation: { byType: "invitee", by: "Cleo Lee" } }));
    await run();
    expect(await runs(cleo)).toEqual(["Sales call booked", "Call cancelled"]);
    expect(records(cleo)).toEqual([expect.objectContaining({ external_id: "EV-C1", outcome: "cancelled" })]);
    const a = (await asOperator((c) => one<{ id: string }>(c, "select id from appointments where company_id=$1 and contact_id=$2", [co, sara.ct])))!;
    await asOperator(async (c) => {
      const term = async (domain: string, cat: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain=$2 and category=$3 and active order by is_default desc limit 1", [co, domain, cat]))!.id;
      await recordDisposition(c, { companyId: co, appointmentId: a.id, outcomeTermId: await term("appointment_outcome", "showed"), callOutcomeTermId: await term("call_outcome", "follow_up") });
    });
    await run();
    expect(await runs(sara)).toEqual(["Triage call booked", "Triage call booked", "Call outcome filed"]);
    expect(records(sara)[1]).toMatchObject({ call_type: "strategy_session", outcome: "showed", disposition: "follow_up" });
  });
});
