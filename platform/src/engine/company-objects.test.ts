/**
 * D118: the shipped templates write to the company's own custom objects (`crm.object_*`, today's keys when it binds none),
 * the Sales Call's closer as the option key the company declared, and its objection only from the company's own options.
 * The proof that Hair and PMU are untouched: every string of every changed template, rendered before (the files as they
 * shipped, kept under fixtures/before-d118, on the context as it was) and after, on companies bound as Hair and PMU are in
 * production, comes out the same; PMU's own copies render the same on the new context. Dating Nelly's come out as hers.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany, type InstallInput } from "./install";
import { buildContext, loadCompany, type RunRow } from "./context";
import { render } from "./template";
import { templates } from "@/templates";
import { fakeAdapters } from "./test-install";
import { closerNameOf, closerOptions, DEFAULT_OBJECTIONS, objectionOptions } from "./sales-call";
import { closerSalesCalls } from "./eod";
import { dispatchEvent } from "./dispatch";
import { applyAppointment } from "./poll";
import { applyPayment } from "./lifecycle";
import { recordRecording } from "./recordings";
import { tick } from "./runner";
import type { Adapters, AppointmentSnapshot, Classification } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/New_York";
const CHANGED = ["call-booked", "call-cancelled", "call-outcome", "call-recorded", "payment-recorded", "deal-closed", "setter-call-logged"];
const BEFORE = path.resolve(__dirname, "fixtures/before-d118");
const PMU = path.resolve(__dirname, "../../installs/pmu");
const before = (slug: string) => JSON.parse(fs.readFileSync(path.join(BEFORE, `${slug}.json`), "utf8")).definition as unknown;
const after = (slug: string) => templates.find((t) => t.slug === slug)!.definition as unknown;

type Out = { ok: string } | { err: string };
/** Every string of a definition by where it sits, rendered as a step would render it (a path the context lacks is its error). */
function rendered(def: unknown, ctx: Record<string, unknown>): Map<string, Out> {
  const env = { tz: TZ, companyTz: TZ, now: DateTime.fromISO("2026-10-20T12:00:00Z") as DateTime<true> };
  const out = new Map<string, Out>();
  const walk = (v: unknown, at: string) => {
    if (typeof v === "string") { try { out.set(at, { ok: render(v, ctx, env) }); } catch (e) { out.set(at, { err: (e as Error).message }); } }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
  };
  for (const n of (def as { nodes: { id: string }[] }).nodes) walk(n, n.id);
  walk((def as { edges: unknown }).edges, "edges");
  return out;
}
const differences = (a: Map<string, Out>, b: Map<string, Out>) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k))).map((k) => ({ at: k, before: a.get(k), after: b.get(k) }));

const HAIR_CRM = { pipeline_setter: "P-S", pipeline_closer: "P-C", stage_closer_closed_won: "ST-W", assoc_sales_call_contact: "A-SC", assoc_payment_contact: "A-PC", assoc_discovery_call_contact: "A-DC" };
const DATING_OBJECTS = { object_sales_call: "custom_objects.dating_sales_call", object_payment: "custom_objects.dating_payment", object_discovery_call: "custom_objects.dating_discovery" };
const base = (slug: string, extra: Partial<InstallInput>): InstallInput => ({ name: slug, slug, timezone: TZ, locationId: `LOC-${slug}`, pit: "fake-token", calendars: { CAL: "closing" }, templates: CHANGED, ...extra });
// Hair in production (read 2026-10-16 with a dry-run save that names the bindings a company lacks): crm.object_sales_call bound
// (the Sales Call object the ledger drift and the numbers read), no crm.object_payment, no crm.object_discovery_call, no option lists
const HAIR: Partial<InstallInput> = { crm: HAIR_CRM, salesCall: { object: "custom_objects.sales_call" } };
// PMU, as installs/pmu.json binds it: payments go on its Cash object
const PMU_INPUT: Partial<InstallInput> = { crm: { ...HAIR_CRM, object_payment: "custom_objects.cash" }, salesCall: { object: "custom_objects.sales_call" } };
const DATING: Partial<InstallInput> = { crm: { ...HAIR_CRM, ...DATING_OBJECTS }, salesCall: { object: DATING_OBJECTS.object_sales_call, objections: ["price", "partner", "timing", "fear", "competitor", "think_about_it"], closerOptions: { "mitch@d118.test": "mitch", "nelly@d118.test": "nelly" } } };
const ROSTER = [{ id: "U-CLOSER", name: "Mitch Sapoff", email: "mitch@d118.test" }, { id: "U-OTHER", name: "Pat Staff", email: "pat@d118.test" }];

async function wipe(slug: string) {
  await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return;
    await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
    await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
    await c.query("update appointments set disposition_id=null where company_id=$1", [co.id]);
    for (const t of ["step_effects", "alerts", "eod_reports", "slack_posts", "agreements", "sends", "runs", "events", "slack_connections", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "recordings", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"])
      await c.query(`delete from ${t} where company_id=$1`, [co.id]);
    await c.query("delete from companies where id=$1", [co.id]);
  });
}
const adapters = (): Adapters => { const f = fakeAdapters(); return { ...f, read: { ...f.read, listUsers: async () => ROSTER } }; };
const company = async (slug: string, extra: Partial<InstallInput>) => { await wipe(slug); return (await installCompany(base(slug, { closers: ["mitch@d118.test"], ...extra }), adapters())).companyId; };

/** A booked person who had their call, with a Sales Call, a Payment and a Discovery Call record on the company's own objects. */
async function person(c: PoolClient, companyId: string, key: string, closer: boolean) {
  const objects = (await loadCompany(c, companyId)).bindings;
  const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,$2,'Jane','Doe') returning id", [companyId, `G-${key}`]))!.id;
  const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing' and is_default", [companyId]))!.id;
  const user = closer ? (await one<{ id: string }>(c, "select id from users where company_id=$1 and email='mitch@d118.test'", [companyId]))!.id : null;
  const at = DateTime.fromISO("2026-10-19T14:00:00Z");
  const appt = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, external_id, appointment_term, assigned_user_id, starts_at, ends_at, booked_at, status) values ($1,$2,$3,$4,$5,$6,$7,now(),'confirmed') returning id", [companyId, ct, `A-${key}`, term, user, at.toJSDate(), at.plus({ minutes: 45 }).toJSDate()]))!.id;
  const rec = (await one<{ id: string }>(c, "insert into recordings (company_id, contact_id, appointment_id, external_id, started_at, ended_at, duration_min, recorded_by_email, share_url, link_status) values ($1,$2,$3,$4,$5,$6,45,$7,'https://fathom.video/share/x','linked') returning id", [companyId, ct, appt, `R-${key}`, at.toJSDate(), at.plus({ minutes: 45 }).toJSDate(), closer ? "mitch@d118.test" : "nobody@d118.test"]))!.id;
  for (const [role, fallback] of [["sales_call", "custom_objects.sales_call"], ["payment", "custom_objects.payment"], ["discovery_call", "custom_objects.discovery_call"]])
    await c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id) values ($1,$2,$3,$4,$5)", [companyId, objects[`crm.object_${role}`] || fallback, `${role}-${key}`, `GR-${role}-${key}`, ct]);
  return { ct, appt, rec };
}
/** The context a step renders against, now; and as it was before D118 (no option lists, records only by their object's key). */
async function contexts(c: PoolClient, companyId: string, who: { ct: string; appt: string; rec: string }, objection: unknown) {
  const { row, bindings } = await loadCompany(c, companyId);
  const run = { id: "00000000-0000-0000-0000-000000000000", company_id: companyId, workflow_id: "00000000-0000-0000-0000-000000000000", workflow_version: 1, contact_id: who.ct, appointment_id: who.appt, opportunity_id: null, status: "active", started_at: new Date(),
    context: { vars: { notes: { primary_objection: objection, next_step: "call back" }, call_key: "CK", convo: { key: "CONV", total_min: 41, total_sec: 2460, count: 1, first: { id: who.rec, started_at: "2026-10-19T14:00:00Z" } }, result_key: "set", outcome: { disposition: "follow_up" }, disposition: "follow_up", booking_source: "self_booked", pay: { sign: "", status: "succeeded" } },
      event: { _type: "recording.received", recording_id: who.rec, slot: { from: "A-old" }, provider_payment_id: "pay_1", amount: 250, paid_at: "2026-10-19T15:00:00Z", kind: "deposit", running_total: 250 } } } as unknown as RunRow;
  const now = await buildContext(c, run, row, bindings);
  const was = structuredClone(now);
  const picklist = was.picklist as Record<string, unknown>; delete picklist.sales_call_objection; delete picklist.sales_call_closer;
  const recs = await many<{ object_key: string; record_key: string; ghl_record_id: string | null }>(c, "select distinct on (object_key) object_key, record_key, ghl_record_id from crm_records where company_id=$1 and contact_id=$2 order by object_key, updated_at desc", [companyId, who.ct]);
  was.records = Object.fromEntries(recs.map((r) => [r.object_key.replace(/^custom_objects\./, ""), { key: r.record_key, id: r.ghl_record_id ?? "" }]));
  return { now, was };
}
// every option the shipped Call recorded allowed (written out, not read from the code under test), and some it did not
const OBJECTIONS: unknown[] = ["price", "partner", "timing", "fear", "medical", "burned_before", "competitor", "think_about_it", "spouse_partner", "", undefined, 3];

describe.skipIf(!process.env.DATABASE_URL)("D118: the templates write the company's own objects and option keys", () => {
  let hair: string, pmu: string, dating: string;
  beforeAll(async () => {
    await migrate();
    hair = await company("d118hair", HAIR); pmu = await company("d118pmu", PMU_INPUT); dating = await company("d118dating", DATING);
  });

  it("Hair: every string of every changed template renders exactly as before, for every objection, with a closer and without", async () => {
    await asOperator(async (c) => {
      const b = await loadCompany(c, hair);
      expect(b.bindings["crm.object_sales_call"]).toBe("custom_objects.sales_call");
      expect(b.bindings["crm.object_payment"] ?? null).toBeNull(); expect(b.bindings["crm.object_discovery_call"] ?? null).toBeNull();
      let compared = 0;
      for (const closer of [true, false]) {
        const who = await person(c, hair, `h${closer}`, closer);
        for (const objection of OBJECTIONS) {
          const { now, was } = await contexts(c, hair, who, objection);
          for (const slug of CHANGED) {
            const a = rendered(before(slug), was), z = rendered(after(slug), now);
            expect(differences(a, z), `${slug}, objection ${String(objection)}, closer ${closer}`).toEqual([]);
            compared += z.size;
          }
        }
      }
      expect(compared).toBeGreaterThan(5000);
    });
  });

  it("Hair: the strings D118 changed render to what they wrote before (the objects, the closer, the objection)", async () => {
    await asOperator(async (c) => {
      const who = await person(c, hair, "hw", true);
      const { now } = await contexts(c, hair, who, "burned_before");
      const at = (slug: string, id: string, field: string) => rendered(after(slug), now).get(`${id}.${field}`);
      expect(at("call-booked", "k4", "object")).toEqual({ ok: "custom_objects.sales_call" });
      expect(at("call-booked", "k4", "properties.closer")).toEqual({ ok: "Mitch Sapoff" });
      expect(at("call-recorded", "r1", "properties.closer")).toEqual({ ok: "Mitch Sapoff" });
      expect(at("call-recorded", "r1", "properties.objection_primary")).toEqual({ ok: "burned_before" });
      expect(at("payment-recorded", "n4", "object")).toEqual({ ok: "custom_objects.payment" });
      expect(at("setter-call-logged", "r1", "object")).toEqual({ ok: "custom_objects.discovery_call" });
      expect(at("deal-closed", "r1", "key")).toEqual({ ok: "sales_call-hw" });
    });
  });

  it("PMU: its own copies render the same on the new context; of the changed templates only Payment recorded's object differs, and PMU's copy already writes that object", async () => {
    await asOperator(async (c) => {
      const copies = fs.readdirSync(PMU).filter((f) => f.endsWith(".json"));
      expect(copies.length).toBeGreaterThan(5);
      const diffs = new Set<string>();
      for (const closer of [true, false]) {
        const who = await person(c, pmu, `p${closer}`, closer);
        for (const objection of [...OBJECTIONS, "spouse_partner", "finances"]) {
          const { now, was } = await contexts(c, pmu, who, objection);
          for (const f of copies) {
            const def = JSON.parse(fs.readFileSync(path.join(PMU, f), "utf8")).definition;
            expect(differences(rendered(def, was), rendered(def, now)), `pmu/${f}`).toEqual([]);
          }
          for (const slug of CHANGED) for (const d of differences(rendered(before(slug), was), rendered(after(slug), now))) diffs.add(`${slug} ${d.at}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`);
        }
      }
      expect([...diffs]).toEqual(['payment-recorded n4.object: {"ok":"custom_objects.payment"} → {"ok":"custom_objects.cash"}']);
      const own = JSON.parse(fs.readFileSync(path.join(PMU, "payment-recorded.json"), "utf8")).definition.nodes.find((n: { id: string }) => n.id === "n4");
      expect(own.object).toBe("custom_objects.cash");
    });
  });

  it("Dating Nelly: her objects, Mitch as `mitch`, only her objections, and records.sales_call finds her Sales Call", async () => {
    await asOperator(async (c) => {
      const who = await person(c, dating, "d", true);
      const at = async (objection: unknown, slug: string, id: string, field: string) => rendered(after(slug), (await contexts(c, dating, who, objection)).now).get(`${id}.${field}`);
      for (const slug of ["call-booked", "call-cancelled", "call-outcome", "call-recorded", "deal-closed"])
        for (const n of (after(slug) as { nodes: { id: string; type: string }[] }).nodes.filter((x) => x.type === "crm_record")) expect(await at("price", slug, n.id, "object"), `${slug} ${n.id}`).toEqual({ ok: DATING_OBJECTS.object_sales_call });
      expect(await at("price", "payment-recorded", "n4", "object")).toEqual({ ok: DATING_OBJECTS.object_payment });
      expect(await at("price", "payment-recorded", "r2", "object")).toEqual({ ok: DATING_OBJECTS.object_sales_call });
      for (const id of ["r1", "r_late", "r2"]) expect(await at("price", "setter-call-logged", id, "object")).toEqual({ ok: DATING_OBJECTS.object_discovery_call });
      expect(await at("price", "call-booked", "k4", "properties.closer")).toEqual({ ok: "mitch" });
      expect(await at("price", "call-recorded", "r1", "properties.closer")).toEqual({ ok: "mitch" });
      expect(await at("partner", "call-recorded", "r1", "properties.objection_primary")).toEqual({ ok: "partner" });
      expect(await at("medical", "call-recorded", "r1", "properties.objection_primary")).toEqual({ ok: "" });
      expect(await at("burned_before", "call-recorded", "r1", "properties.objection_primary")).toEqual({ ok: "" });
      // records.sales_call is her Dating Sales Call (Deal closed and Payment recorded update it by that key)
      expect(await at("price", "deal-closed", "r1", "key")).toEqual({ ok: "sales_call-d" });
      expect(await at("price", "payment-recorded", "r2", "key")).toEqual({ ok: "sales_call-d" });
      // a closer with no option of their own is written as nothing, not as a name the dropdown drops
      const nobody = await person(c, dating, "dn", false);
      expect(rendered(after("call-booked"), (await contexts(c, dating, nobody, "price")).now).get("k4.properties.closer")).toEqual({ ok: "" });
    });
  });
});

describe("D118: the option lists", () => {
  it("objections: the company's own list, else the list the templates always wrote", () => {
    expect(objectionOptions({})).toEqual(["price", "partner", "timing", "fear", "medical", "burned_before", "competitor", "think_about_it"]);
    expect(objectionOptions({ "sales_call.objections": '["price","partner"]' })).toEqual(["price", "partner"]);
    expect(objectionOptions({ "sales_call.objections": "[]" })).toEqual(DEFAULT_OBJECTIONS);
    expect(objectionOptions({ "sales_call.objections": "not json" })).toEqual(DEFAULT_OBJECTIONS);
  });
  it("closer options: declared by email, CRM user id or roster name, keyed by the roster name; read back to that name", () => {
    const roster = [{ name: "Mitch Sapoff", email: "Mitch@X.com", ghl_user_id: "U1" }, { name: "Nelly Ray", email: "nelly@x.com", ghl_user_id: "U2" }, { name: "Pat Staff", email: "pat@x.com", ghl_user_id: "U3" }];
    expect(closerOptions({}, roster)).toBeNull();
    const o = closerOptions({ "sales_call.closer_options": JSON.stringify({ "mitch@x.com": "mitch", U2: "nelly" }) }, roster);
    expect(o).toEqual({ "mitch sapoff": "mitch", "nelly ray": "nelly" });
    expect(closerOptions({ "sales_call.closer_options": JSON.stringify({ "Pat Staff": "pat" }) }, roster)).toEqual({ "pat staff": "pat" });
    expect(closerNameOf("mitch", o)).toBe("mitch sapoff");
    expect(closerNameOf("Mitch Sapoff", o)).toBe("Mitch Sapoff");
    expect(closerNameOf("someone", o)).toBe("someone");
    expect(closerNameOf("mitch", null)).toBe("mitch");
  });
  it("the option filter: a list keeps only its own values, a map gives its key, nothing declared passes the value as it is", () => {
    const env = { tz: TZ };
    const ctx = (picklist: Record<string, unknown>) => ({ picklist, vars: { o: "medical", who: "Mitch Sapoff", none: "" } });
    expect(render("{{vars.o | option:sales_call_objection}}", ctx({ sales_call_objection: ["price"] }), env)).toBe("");
    expect(render("{{vars.o | option:sales_call_objection}}", ctx({ sales_call_objection: ["medical"] }), env)).toBe("medical");
    expect(render("{{vars.who | option:sales_call_closer}}", ctx({ sales_call_closer: { "mitch sapoff": "mitch" } }), env)).toBe("mitch");
    expect(render("{{vars.who | option:sales_call_closer}}", ctx({ sales_call_closer: {} }), env)).toBe("");
    expect(render("{{vars.who | option:sales_call_closer}}", ctx({}), env)).toBe("Mitch Sapoff");
    expect(render("{{vars.none | option:sales_call_closer}}", ctx({ sales_call_closer: { "": "x" } }), env)).toBe("");
  });
});

// ---- through the engine, in shadow as Dating Nelly is: what the runs record on her objects ----
const analysis = { notes: { summary: "Thinking it over.", pain: ["lonely"], objections: [], disposition: "follow_up", primary_objection: "medical", next_step: "call Friday" }, rubric: { overall_score: 7, scores: {}, strengths: [], misses: [], coaching: [] } };
const f = adapters();
const apptStore = new Map<string, AppointmentSnapshot>();
const engine: Adapters = { ...f,
  booking: (() => { const b = { appointmentsInWindow: async () => [], listCalendars: async () => [{ id: "CAL", name: "Strategy Call", teamMemberIds: ["U-CLOSER"] }], getAppointment: async (_c: unknown, id: string) => apptStore.get(id) ?? null }; return { ghl: b, calendly: b }; })(),
  classifier: { choice: async (_s, _i, options): Promise<Classification> => ({ value: options.includes("sales_call") ? "sales_call" : options.includes("follow_up") ? "follow_up" : options[0], confidence: 1, distribution: {}, unclear: false }) },
  analyst: { analyze: async () => ({ text: JSON.stringify(analysis), parsed: analysis, model: "fake", usage: { input: 1, output: 1, cacheRead: 0 } }) } };

const RUN_CRM = { agreement_template: "TPL", assoc_sales_call_opportunity: "A-SO", assoc_payment_opportunity: "A-PO", field_contact_appointment_date: "F-AD", field_contact_setter: "F-SE", field_opportunity_setter_owner: "F-SO",
  stage_closer_scheduled: "ST-SC", stage_setter_appointment_set: "ST-AS", stage_setter_direct_booked: "ST-DB", stage_setter_showed: "ST-SH", field_contact_cash_collected: "F-CC", field_contact_revenue_generated: "F-RG", stage_closer_agreement_sent: "ST-AG" };
describe.skipIf(!process.env.DATABASE_URL)("D118: Dating Nelly's runs, in shadow", () => {
  let co: string, ct: string;
  beforeAll(async () => {
    await migrate();
    await wipe("d118run");
    co = (await installCompany(base("d118run", { ...DATING, templates: ["call-booked", "call-recorded", "payment-recorded"], enable: true, anthropicKey: "sk-fake", closers: ["mitch@d118.test"], crm: { ...DATING.crm, ...RUN_CRM } }), adapters())).companyId;
    expect(await asOperator((c) => many(c, "select name from workflows where company_id=$1 and not enabled", [co]))).toEqual([]);
    await asOperator((c) => c.query("update companies set send_window_start='00:00', send_window_end='23:59', mode='shadow' where id=$1", [co]));
    ct = await asOperator(async (c) => {
      const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,'G-RUN','Dana','Lee',$2) returning id", [co, TZ]))!.id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','dana@d118.test')", [co, id]);
      return id;
    });
  });
  const records = () => asOperator((c) => many<{ object_key: string; record_key: string; properties: Record<string, unknown> }>(c, "select object_key, record_key, properties from crm_records where company_id=$1 order by created_at", [co]));

  it("a booking writes her Dating Sales Call with Mitch as `mitch`; the recording updates it with only her objection; a payment goes on her Dating Payment and updates her Sales Call", async () => {
    const start = DateTime.now().plus({ days: 2 }).set({ minute: 0, second: 0, millisecond: 0 });
    const snap: AppointmentSnapshot = { id: "APPT-RUN", calendarId: "CAL", contactId: "G-RUN", assignedUserId: "U-CLOSER", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), raw: {} };
    apptStore.set(snap.id, snap);
    await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, co); await applyAppointment(c, row, adapterCompany, engine, snap); });
    await tick(engine, DateTime.now() as DateTime<true>, co);
    const booked = (await records()).filter((r) => r.object_key === DATING_OBJECTS.object_sales_call);
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({ record_key: "APPT-RUN", properties: expect.objectContaining({ closer: "mitch", outcome: "scheduled", external_id: "APPT-RUN" }) });
    expect((await records()).some((r) => /custom_objects\.(sales_call|payment|discovery_call)$/.test(r.object_key))).toBe(false);

    const appt = (await asOperator((c) => one<{ id: string }>(c, "select id from appointments where company_id=$1 and external_id='APPT-RUN'", [co])))!.id;
    const r = await asOperator((c) => recordRecording(c, co, { externalId: "fathom-run", title: "Dana Lee and Mitch Sapoff", startedAt: start.plus({ minutes: 1 }).toJSDate(), durationMin: 40, shareUrl: "https://fathom.video/share/run", recordedBy: { name: "Mitch Sapoff", email: "mitch@d118.test" },
      invitees: [{ name: "Mitch Sapoff", email: "mitch@d118.test", isExternal: false }, { name: "Dana Lee", email: "dana@d118.test", isExternal: true }], transcript: [{ speaker: "Dana Lee", text: "Let me think about it." }] }));
    expect(r.outcome).toBe("linked"); if (r.outcome !== "linked") return;
    await asOperator((c) => dispatchEvent(c, r.event, { contact: { id: ct }, appointment: { id: appt } }));
    await tick(engine, start.plus({ hours: 1 }) as DateTime<true>, co);
    const reviewed = (await records()).filter((x) => x.object_key === DATING_OBJECTS.object_sales_call);
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0].properties).toMatchObject({ closer: "mitch", outcome: "showed", disposition: "follow_up", next_step: "call Friday" });
    expect(reviewed[0].properties).not.toHaveProperty("objection_primary");   // the AI said "medical": not one of hers, so nothing is written

    await asOperator(async (c) => { const ev = await applyPayment(c, co, ct, { whopPaymentId: "pay_run", amount: 250, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); await dispatchEvent(c, ev, { contact: { id: ct } }); });
    await tick(engine, start.plus({ hours: 2 }) as DateTime<true>, co);
    const all = await records();
    expect(all.filter((x) => x.object_key === DATING_OBJECTS.object_payment)).toEqual([expect.objectContaining({ record_key: "pay_run", properties: expect.objectContaining({ amount: 250, type: expect.anything() }) })]);
    expect(all.find((x) => x.object_key === DATING_OBJECTS.object_sales_call)!.properties).toMatchObject({ cash_collected: expect.anything() });
    expect(all.map((x) => x.object_key).every((k) => Object.values(DATING_OBJECTS).includes(k))).toBe(true);
  });

  it("the end-of-day reminder reads a Sales Call that says `mitch` as Mitch's; without the declared option it would not", async () => {
    const at = DateTime.now().minus({ days: 1 }).set({ hour: 15, minute: 0, second: 0, millisecond: 0 });
    const appt = await asOperator(async (c) => {
      const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing' and is_default", [co]))!.id;
      const id = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, external_id, appointment_term, starts_at, ends_at, booked_at, status) values ($1,$2,'APPT-EOD',$3,$4,$5,now(),'confirmed') returning id", [co, ct, term, at.toJSDate(), at.plus({ minutes: 45 }).toJSDate()]))!.id;
      await c.query("insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id) values ($1,$2,'APPT-EOD','GR-EOD',$3)", [co, DATING_OBJECTS.object_sales_call, ct]);
      return id;
    });
    const reads: Adapters = { ...engine, read: { ...engine.read, objectRecords: async () => [{ id: "GR-EOD", createdAt: at.toISO()!, properties: { closer: "mitch", scheduled_at: at.toISO(), call_date: at.toISODate(), external_id: "APPT-EOD", contact_id: "G-RUN" } }] } };
    const calls = (bindings: Record<string, string>) => asOperator(async (c) => { const l = await loadCompany(c, co); return closerSalesCalls(c, reads, l.adapterCompany, co, bindings, "Mitch Sapoff", TZ, DateTime.now()); });
    const { bindings } = await asOperator((c) => loadCompany(c, co));
    expect(await calls(bindings)).toEqual([expect.objectContaining({ id: "GR-EOD", appointment_id: appt, filed: false, due: true })]);
    const without = { ...bindings }; delete without["sales_call.closer_options"];
    expect(await calls(without)).toEqual([]);
  });
});

describe("D118: Hair's Sales Call records still read as the closer named on them", () => {
  it("a full name stays a full name when nothing is declared", () => {
    expect(closerNameOf("James Langridge", closerOptions({}, [{ name: "James Langridge", email: "j@x.com", ghl_user_id: "U" }]))).toBe("James Langridge");
  });
});

