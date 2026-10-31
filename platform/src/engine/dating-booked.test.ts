/**
 * D123, D142: Dating (Nelly) books in her Calendly on two event types, each its own call type (D101): the 15-minute
 * Complimentary Strategy Session is the triage call ("Triage call", taken by Mitch: the calendar's owner) and the Private Dating
 * Consultation the closing call ("Closing call", Nelly's). Call booked is taken over by her own two workflows, made through the
 * definition route: Triage call booked (the setter card and a Discovery Call record, Mitch's; no Sales Call, no closer card) and
 * Closing call booked (the closer card and the Sales Call, call type closing). A booking runs exactly one of them; a reschedule
 * runs the same one again; a closing call's cancel runs Call cancelled. Install never puts Call booked back.
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
import { tick } from "./runner";
import { prefill, submitEod, tokenFor } from "./eod";
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
const STRATEGY = "86985d27-22e5-4b6b-ab66-8e68e9ee8e30", CONSULT = "80955126-29fe-48ea-a85e-ba4bcd145790", DISCOVERY = "custom_objects.dating_discovery";

const crm = new Map<string, { object: string; properties: Record<string, unknown> }>();
const tags: { id: string; tag: string }[] = [];
const owners: { contact: string; user?: string }[] = [], cards: { contact: string; pipeline: string; user?: string }[] = [];
let seq = 0;
const source = new Map<string, AppointmentSnapshot>();
const f = fakeAdapters();
const cals = [{ id: STRATEGY, name: "Complimentary Dating Strategy Session ♡", teamMemberIds: [] }, { id: CONSULT, name: "Private Dating Consultation with Nelly", teamMemberIds: [] }];
const fake: Adapters = { ...f,
  read: { ...f.read, listUsers: async () => [{ id: "U-NELLY", name: "Nelly S.", email: "nellysudri@d123.test" }, { id: "U-MITCH", name: "Mitch Sapoff", email: "mitch@d123.test" }] },
  booking: (() => { const b = { appointmentsInWindow: async () => [], listCalendars: async () => cals, getAppointment: async (_c: unknown, id: string) => source.get(id) ?? null }; return { ghl: b, calendly: b }; })(),
  write: { ...f.write,
    addTag: async (_c, id, tag) => { tags.push({ id, tag }); },
    updateContact: async (_c, id, patch) => { if (patch.assignedUserId) owners.push({ contact: id, user: patch.assignedUserId }); },
    createOpportunity: async (_c, w) => { cards.push({ contact: w.contactId, pipeline: w.pipelineId, user: w.assignedUserId }); return { id: `OPP-${cards.length}` }; },
    createRecord: async (_c, object, properties) => { const id = `SC-${++seq}`; crm.set(id, { object, properties: { ...properties } }); return { id }; },
    updateRecord: async (_c, _object, id, properties) => { const r = crm.get(id); if (!r) throw new Error(`no record ${id}`); Object.assign(r.properties, properties); } },
};
const CRM = { pipeline_setter: "P-S", pipeline_closer: "P-C", stage_closer_scheduled: "ST-SCHED", stage_closer_cancelled: "ST-CXL", stage_closer_follow_up: "ST-FU", stage_setter_direct_booked: "ST-DB", stage_setter_appointment_set: "ST-AS", stage_setter_cancelled: "ST-S-CXL", stage_setter_showed: "ST-S-SHOWED", stage_setter_dq: "ST-S-DQ", stage_setter_not_interested: "ST-S-NI",
  field_contact_appointment_date: "F-AD", field_contact_setter: "F-SE", field_opportunity_setter_owner: "F-SO", object_sales_call: OBJECT, assoc_sales_call_contact: "A-SC", assoc_sales_call_opportunity: "A-SO", object_discovery_call: DISCOVERY, assoc_discovery_call_contact: "A-DC" };
const input = (over: Partial<InstallInput> = {}): InstallInput => ({ name: "Dating (Nelly) D123", slug: SLUG, timezone: TZ, locationId: "LOC-D123", pit: "fake", scopeTag: "dating", closers: ["nellysudri@d123.test"], crm: CRM,
  salesCall: { object: OBJECT, outcomes: { scheduled: "scheduled", showed: "showed", no_show: "noshow", cancelled: "cancelled", rescheduled: "rescheduled" } },
  calendars: { [STRATEGY]: { term: "first_call", name: "Triage call", booking: "self", owner: "mitch@d123.test" }, [CONSULT]: { term: "closing", name: "Closing call", booking: "self" } }, closerCall: CONSULT, bookingCalendar: STRATEGY,
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
const records = (who: Who, object = OBJECT) => [...crm.values()].filter((r) => r.properties.contact_id === who.ghl && r.object === object).map((r) => r.properties);

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
    for (const slug of ["triage-call-booked", "closing-call-booked"]) expect(await (await make(slug)).json(), slug).toMatchObject({ ok: true, created: true, dryRun: false, layout: "tidy", missing: [] });
    const wfs = await asOperator((c) => many<{ name: string; enabled: boolean; template_id: string | null; takes_over: string; current_version: number; triggers: string[] }>(c,
      "select w.name, w.enabled, w.template_id, w.takes_over, w.current_version, array(select t.node_id || ':' || t.event_type from workflow_triggers t where t.workflow_id=w.id order by t.node_id) as triggers from workflows w where w.company_id=$1 and w.takes_over is not null order by w.name", [co]));
    expect(wfs).toEqual([
      { name: "Closing call booked", enabled: false, template_id: null, takes_over: "call-booked", current_version: 1, triggers: ["t1:appointment.booked", "t2:appointment.rescheduled"] },
      { name: "Triage call booked", enabled: false, template_id: null, takes_over: "call-booked", current_version: 1, triggers: ["t1:appointment.booked", "t2:appointment.rescheduled"] }]);
    expect(await asOperator((c) => many(c, "select after->>'takes_over' as t from audit_log where company_id=$1 and action='workflow.created'", [co]))).toEqual([{ t: "call-booked" }, { t: "call-booked" }]);
    // the same call again finds the workflow by its name: an ordinary save, the same definition, no new version
    expect(await (await make("closing-call-booked")).json()).toMatchObject({ ok: true, saved: false, version: 1 });
    const out = await installCompany(input({ templates: ["call-booked"] }), fake);   // D147: even asked for by name
    expect(out.installed).toContain("call-booked → not installed: the company's own “Closing call booked” and “Triage call booked” do its job (D123)");
    expect(await asOperator((c) => many(c, "select 1 from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug='call-booked'", [co]))).toEqual([]);
    await asOperator((c) => c.query("update workflows set enabled=true where company_id=$1 and name in ('Triage call booked','Closing call booked','Call cancelled','Call outcome filed')", [co]));
  });

  it("a booking runs exactly one: a triage call is Triage call booked (Mitch's: the contact, the setter card, a Discovery Call record; no Sales Call, no closer card); a closing call is Closing call booked (Nelly's Sales Call, call type closing, the closer card)", async () => {
    sara = await person("Sara"); cleo = await person("Cleo");
    await poll(event(sara, "EV-S1", STRATEGY, AT), event(cleo, "EV-C1", CONSULT, AT.plus({ hours: 2 })));
    await run();
    expect(await runs(sara)).toEqual(["Triage call booked"]);
    expect(await runs(cleo)).toEqual(["Closing call booked"]);
    expect(records(sara)).toEqual([]);
    expect(records(sara, DISCOVERY)).toEqual([expect.objectContaining({ external_id: "EV-S1", outcome: "scheduled", setter: "Mitch Sapoff" })]);
    expect(records(cleo)).toEqual([expect.objectContaining({ external_id: "EV-C1", call_type: "closing", outcome: "scheduled" })]);
    expect(records(cleo, DISCOVERY)).toEqual([]);
    expect(owners.filter((o) => o.contact === sara.ghl).map((o) => o.user)).toEqual(["U-MITCH"]);
    expect(owners.filter((o) => o.contact === cleo.ghl).map((o) => o.user)).toEqual(["U-NELLY"]);
    expect(cards.filter((k) => k.contact === sara.ghl)).toEqual([{ contact: sara.ghl, pipeline: "P-S", user: "U-MITCH" }]);   // the setter card only
    expect(cards.filter((k) => k.contact === cleo.ghl).map((k) => k.pipeline)).toContain("P-C");
    const tagsOf = (who: Who) => tags.filter((t) => t.id === who.ghl).map((t) => t.tag);
    expect(tagsOf(sara)).toEqual(expect.arrayContaining(["dating", "stat-call-booked", "stat-self-booked", "stat-triage-first"]));
    expect(tagsOf(cleo)).toEqual(expect.arrayContaining(["dating", "stat-call-booked", "stat-self-booked"]));
    expect(tagsOf(cleo)).not.toContain("stat-triage-first");
  });

  it("D284: someone whose earlier closing call was held books again: a follow-up (its own Sales Call, call type follow_up; no new set, the setter card and the setter left alone; the closer card back to Scheduled with its name)", async () => {
    const fay = await person("Fay");
    await asOperator(async (c) => {
      const cal = (await one<{ id: string; term: string }>(c, "select id, appointment_term as term from calendars where company_id=$1 and external_id=$2", [co, CONSULT]))!;
      await c.query("insert into appointments (company_id, contact_id, calendar_id, source, external_id, starts_at, ends_at, booked_at, status, appointment_term) values ($1,$2,$3,'calendly','EV-F0',now()-interval '2 days',now()-interval '2 days'+interval '45 minutes',now()-interval '5 days','showed',$4)", [co, fay.ct, cal.id, cal.term]);
    });
    const before = cards.length;
    await poll(event(fay, "EV-F1", CONSULT, AT.plus({ hours: 4 })));
    await run();
    expect(await runs(fay)).toEqual(["Closing call booked"]);
    expect(records(fay)).toEqual([expect.objectContaining({ external_id: "EV-F1", call_type: "follow_up", outcome: "scheduled" })]);
    const [steps] = await stepsOf(fay, "Closing call booked");
    expect(steps).toEqual(expect.arrayContaining(["fu0", "fu1", "fu4", "fu_card", "fu_sc", "fu_v"])); expect(steps.some((x) => x.startsWith("n4"))).toBe(true);   // the booking post (no Slack in this test)
    for (const st of steps) expect(st).not.toMatch(/^(n2|s3|s5|b3|b6|c_new|c_rs|k3|k4)$/);
    const mine = tags.filter((t) => t.id === fay.ghl).map((t) => t.tag);
    expect(mine).toContain("stat-follow-up-booked"); expect(mine).not.toContain("stat-self-booked"); expect(mine).not.toContain("stat-set");
    expect(cards.slice(before).filter((k) => k.contact === fay.ghl).map((k) => k.pipeline)).not.toContain("P-S");   // the setter card is not touched
  });

  it("a reschedule runs the same one again (the slot left logged rescheduled); a closing call's cancel runs Call cancelled on its Sales Call", async () => {
    await poll(event(sara, "EV-S1", STRATEGY, AT.plus({ days: 1 })));
    await run();
    expect(await runs(sara)).toEqual(["Triage call booked", "Triage call booked"]);
    expect(records(sara, DISCOVERY)).toEqual([expect.objectContaining({ external_id: "EV-S1", outcome: "rescheduled" }), expect.objectContaining({ outcome: "scheduled", setter: "Mitch Sapoff" })]);
    const [booked, moved] = await stepsOf(sara, "Triage call booked");
    expect(booked).toEqual(expect.arrayContaining(["d_rs:skipped", "d1"])); expect(moved).toEqual(expect.arrayContaining(["d_rs", "d1"]));
    for (const st of [...booked, ...moved]) expect(st).not.toMatch(/^(c_new|c_rs|k3|k4|k5)/);
    await poll(event(cleo, "EV-C1", CONSULT, AT.plus({ hours: 2 }), { status: "cancelled", cancellation: { byType: "invitee", by: "Cleo Lee" } }));
    await run();
    expect(await runs(cleo)).toEqual(["Closing call booked", "Call cancelled"]);
    expect(records(cleo)).toEqual([expect.objectContaining({ external_id: "EV-C1", outcome: "cancelled" })]);
  });

  it("D143: a triage call is on its setter's end of day with its own answers (set pre-filled once they booked a closing call); filing it runs Triage call filed (the Discovery Call record showed and set), never Call outcome filed", async () => {
    const made = await definitionRoute(req("/api/admin/workflows/definition", "POST", { company: SLUG, workflow: own("triage-call-filed").name, definition: own("triage-call-filed").definition, note: own("triage-call-filed").note, create: own("triage-call-filed").create }));
    expect(await made.json()).toMatchObject({ ok: true, created: true, missing: [] });
    await asOperator((c) => c.query("update workflows set enabled=true where company_id=$1 and name='Triage call filed'", [co]));
    const tia = await person("Tia");
    const yesterday = DateTime.now().setZone(TZ).minus({ days: 1 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    const mitch = await asOperator(async (c) => {
      const m = (await one<{ id: string; name: string; email: string }>(c, "select id, name, email from users where company_id=$1 and email='mitch@d123.test'", [co]))!;
      const term = async (name: string) => (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and name=$2", [co, name]))!.id;
      const cal = async (ext: string) => (await one<{ id: string }>(c, "select id from calendars where company_id=$1 and external_id=$2", [co, ext]))!.id;
      await c.query("insert into appointments (company_id, contact_id, calendar_id, external_id, slot_key, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status, source) values ($1,$2,$3,'EV-T1','EV-T1',$4,$5,$6::timestamptz,$7,$6::timestamptz - interval '3 days','confirmed','calendly')",
        [co, tia.ct, await cal(STRATEGY), await term("Triage call"), m.id, yesterday.toJSDate(), yesterday.plus({ minutes: 15 }).toJSDate()]);
      await c.query("insert into appointments (company_id, contact_id, calendar_id, external_id, appointment_term, starts_at, ends_at, booked_at, status, source) values ($1,$2,$3,'EV-T2',$4,now() + interval '2 days', now() + interval '2 days 1 hour', now(),'confirmed','calendly')",
        [co, tia.ct, await cal(CONSULT), await term("Closing call")]);
      crm.set("DC-T1", { object: DISCOVERY, properties: { external_id: "EV-T1", contact_id: tia.ghl, outcome: "scheduled" } });
      await c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id) values ($1,$2,'EV-T1','DC-T1',$3)", [co, DISCOVERY, tia.ct]);
      return m;
    });
    const day = yesterday.toFormat("yyyy-MM-dd");
    const pre = await asOperator(async (c) => prefill(c, (await loadCompany(c, co)).row, mitch, day));
    expect(pre.calls.map((x) => [x.contact, x.kind, x.outcome])).toEqual([["Tia Lee", "triage", "set"]]);
    const token = await asOperator((c) => tokenFor(c, mitch.id));
    expect(await asOperator((c) => submitEod(c, { token, day, answers: { ...pre, day_answers: {} }, adapters: fake }))).toMatchObject({ ok: true, recorded: 1 });
    await run();
    expect(await runs(tia)).toEqual(["Triage call filed"]);
    expect(crm.get("DC-T1")!.properties).toMatchObject({ outcome: "showed", call_result: "set" });
  });

  it("D144: a booking's join link is kept as the source gives it, and a reschedule's new link replaces it", async () => {
    const zed = await person("Zed");
    await poll(event(zed, "EV-Z1", CONSULT, AT.plus({ hours: 5 }), { meetingUrl: "https://zoom.us/j/111?pwd=a" }));
    const url = () => asOperator(async (c) => (await one<{ meeting_url: string }>(c, "select meeting_url from appointments where company_id=$1 and contact_id=$2", [co, zed.ct]))!.meeting_url);
    expect(await url()).toBe("https://zoom.us/j/111?pwd=a");
    await poll(event(zed, "EV-Z1", CONSULT, AT.plus({ hours: 5 }), { meetingUrl: "https://zoom.us/j/222" }));
    expect(await url()).toBe("https://zoom.us/j/222");
  });

  it("D142: an install that gives a calendar its call type and owner moves the bookings it already holds: every one takes the type, an upcoming one the owner (a past call stays whoever took it)", async () => {
    const ids = await asOperator(async (c) => {
      const old = (await one<{ id: string }>(c, "insert into company_terms (company_id, domain, name, category, is_default, sort) values ($1,'appointment_type','Strategy session','closing',false,50) returning id", [co]))!.id;
      const nelly = (await one<{ id: string }>(c, "select id from users where company_id=$1 and email='nellysudri@d123.test'", [co]))!.id;
      const cal = (await one<{ id: string }>(c, "select id from calendars where company_id=$1 and external_id=$2", [co, STRATEGY]))!.id;
      const mk = async (hours: number) => (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, calendar_id, external_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status, source) values ($1,$2,$3,$4,$5,$6,now() + make_interval(hours => $7), now() + make_interval(hours => $7 + 1), now(),'confirmed','calendly') returning id", [co, sara.ct, cal, `OLD-${hours}`, old, nelly, hours]))!.id;
      return { ahead: await mk(48), past: await mk(-48) };
    });
    await installCompany(input({ templates: [] }), fake);
    const of = (id: string) => asOperator((c) => one(c, "select t.name as term, u.name as owner from appointments a join company_terms t on t.id=a.appointment_term join users u on u.id=a.assigned_user_id where a.id=$1", [id]));
    expect(await of(ids.ahead)).toEqual({ term: "Triage call", owner: "Mitch Sapoff" });
    expect(await of(ids.past)).toEqual({ term: "Triage call", owner: "Nelly S." });
  });
});
