/**
 * D339: two guards from TRC (2026-11-16). (1) A trigger match that reads what its event never carries is refused at save: TRC's Call
 * booked matched `{{appointment.closer.ghl_user_id}}` on appointment.booked, whose match context has no closer, and never ran.
 * (2) A workflow that writes the Sales Call's Closer cannot go up while a roster closer's value is not one of the field's options: TRC's
 * Closer is a dropdown (nick, tiffany), sales_call.closer_options was {}, and GHL refused "Nick Rowe" on every write.
 * Every shipped template and every frozen fixture (what offers saved before) still saves, and goes up as before.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installTemplates } from "./install";
import { createCompanyWorkflow, saveDefinition } from "./definitions";
import { setWorkflowMode } from "./golive";
import { closerFieldBlockers } from "./golive-closer";
import { MATCH_CONTEXT, matchCarries, recordStarted, unreachableMatches } from "./match-context";
import { Definition } from "./definition";
import { templates } from "@/templates";
import { encrypt } from "./crypto";
import { fakeAdapters } from "./test-install";
import type { Adapters, ObjectField } from "@/adapters/types";
import { POST } from "../../app/api/admin/workflows/definition/route";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
type Def = { nodes: { id: string; type: string; [k: string]: unknown }[]; edges: { from: string; to: string; label?: string }[]; [k: string]: unknown };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const tpl = (slug: string) => clone(templates.find((t) => t.slug === slug)!.definition) as unknown as Def;
const FIXTURES = path.resolve(__dirname, "fixtures");
const fixtures = fs.readdirSync(FIXTURES).flatMap((dir) => fs.readdirSync(path.join(FIXTURES, dir)).filter((f) => f.endsWith(".json")).map((f) => ({ name: `${dir}/${f}`, slug: f.replace(/\.json$/, ""), def: (JSON.parse(fs.readFileSync(path.join(FIXTURES, dir, f), "utf8")) as { definition: Def }).definition })));
/** TRC's Call booked as saved on 2026-11-16: the shipped one, its booking trigger asking for one closer. */
const trcCallBooked = () => {
  const d = tpl("call-booked");
  const t = d.nodes.find((n) => n.type === "trigger" && n.event === "appointment.booked")!;
  t.match = { and: [t.match, { eq: ["{{appointment.closer.ghl_user_id}}", "GHL-NICK"] }] };
  return d;
};

describe("D339: what a trigger's match can read", () => {
  it("TRC's match on the booking's closer is never carried by appointment.booked; a branch's read of it is not a match and is not checked", () => {
    expect(unreachableMatches(Definition.parse(trcCallBooked()), new Set())).toEqual([expect.objectContaining({ event: "appointment.booked", path: "appointment.closer.ghl_user_id" })]);
    expect(matchCarries("appointment.booked", "appointment.term.category", false)).toBe(true);
    expect(matchCarries("appointment.booked", "appointment.term", false)).toBe(true);   // the object around a carried field
    expect(matchCarries("appointment.booked", "event.self_booked", false)).toBe(true);   // the event's own data, always
    expect(matchCarries("appointment.rescheduled", "appointment.set_by", false)).toBe(false);
    expect(matchCarries("appointment.booked", "company.timezone", false)).toBe(false);
  });

  it("recording.received carries no closer; a record step that starts an event hands it the run's whole recording", () => {
    expect(matchCarries("recording.received", "recording.closer.email", false)).toBe(false);
    expect(matchCarries("recording.received", "recording.title", false)).toBe(true);
    expect(matchCarries("call.closing", "recording.closer.email", true)).toBe(true);
    const exists = tpl("call-recorded");
    exists.nodes.find((n) => n.type === "trigger" && n.event === "recording.received")!.match = { exists: "recording.closer.email" };
    expect(unreachableMatches(Definition.parse(exists), new Set()).map((u) => u.path)).toEqual(["recording.closer.email"]);
  });

  it("every shipped template's and every frozen fixture's matches are all carried (nothing an offer runs today is refused)", () => {
    const all = [...templates.map((t) => ({ name: t.slug, def: Definition.parse(clone(t.definition)) })), ...fixtures.map((f) => ({ name: f.name, def: Definition.parse(f.def) }))];
    const started = recordStarted(all.map((x) => x.def));
    for (const x of all) expect(unreachableMatches(x.def, started), x.name).toEqual([]);
    for (const x of all) for (const n of x.def.nodes) if (n.type === "trigger" && n.match && n.event !== "schedule") expect(MATCH_CONTEXT[n.event] ?? started.has(n.event), `${x.name} ${n.event}`).toBeTruthy();
  });
});

const KEY = "match-guards-operator-key";
const prevSecret = process.env.CRON_SECRET;
const post = (body: unknown) => POST(new Request("http://x/api/admin/workflows/definition", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
const ids: Record<string, string> = {};
const SLUGS = ["call-booked", "call-recorded", "call-cancelled", "call-outcome", "setter-call-logged", "payment-recorded", "deal-closed", "agreement-chase", "daily-wrap-up", "weekly-wrap-up", "monthly-wrap-up", "new-lead"];
const wfId = async (co: string, slug: string) => (await asOperator((c) => one<{ id: string }>(c, "select w.id from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug=$2", [ids[co], slug])))!.id;
const reset = (slug: string) => asOperator(async (c) => {
  const id = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, status, mode) values ($1,$1,'UTC','template','ghost') on conflict (slug) do update set status='template', mode='ghost' returning id", [slug]))!.id;
  await c.query("delete from sends where company_id=$1", [id]);
  await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [id]);
  for (const t of ["runs", "workflow_triggers"]) await c.query(`delete from ${t} where company_id=$1`, [id]);
  await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [id]);
  for (const t of ["workflows", "bindings", "slack_connections", "users", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [id]);
  await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3)", [id, Buffer.from("LOC"), encrypt("p")]);
  return id;
});

describe.skipIf(!process.env.DATABASE_URL)("D339: the save refuses a match its event never carries", () => {
  beforeAll(async () => {
    process.env.CRON_SECRET = KEY;
    await migrate();
    ids.m = await reset("matchguard");
    await asOperator((c) => installTemplates(c, ids.m, SLUGS, { existed: false }));
  });
  afterAll(() => { if (prevSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevSecret; });

  it("TRC's Call booked: refused (422) on the dry run, naming the field and the branch, and nothing saved", async () => {
    const id = await wfId("m", "call-booked");
    const before = await asOperator((c) => one<{ v: number }>(c, "select current_version v from workflows where id=$1", [id]));
    const r = await post({ company: "matchguard", workflow: "call-booked", definition: trcCallBooked(), note: "only Nick's bookings", dryRun: true });
    expect(r.status).toBe(422);
    const body = await r.json() as { error: string; problems: string[] };
    expect(body.error).toMatch(/never carries/);
    expect(body.problems).toHaveLength(1);
    expect(body.problems[0]).toMatch(/\{\{appointment\.closer\.ghl_user_id\}\}, which appointment\.booked never carries/);
    expect(body.problems[0]).toMatch(/always false and the workflow never starts/);
    expect(body.problems[0]).toMatch(/branch as the first step/);
    expect((await post({ company: "matchguard", workflow: "call-booked", definition: trcCallBooked(), note: "only Nick's bookings" })).status).toBe(422);
    expect(await asOperator((c) => one<{ v: number }>(c, "select current_version v from workflows where id=$1", [id]))).toEqual(before);
  });

  it("a recording.received match on the recording's closer is refused the same way; a new workflow too", async () => {
    const d = tpl("call-recorded");
    const t = d.nodes.find((n) => n.type === "trigger" && n.event === "recording.received")!;
    t.match = { eq: ["{{recording.closer.email}}", "nick@trc.test"] };
    const r = await asOperator((c) => saveDefinition(c, { workflowId: "00000000-0000-0000-0000-000000000000", definition: d, note: "x", dryRun: true }));
    expect(r.ok).toBe(false);   // no such workflow: 404 before anything is read
    const id = await wfId("m", "call-recorded");
    const s = await asOperator((c) => saveDefinition(c, { workflowId: id, definition: d, note: "only Nick's calls", dryRun: true }));
    expect(s).toMatchObject({ ok: false, status: 422 });
    if (!s.ok) expect(s.problems?.join(" ")).toMatch(/\{\{recording\.closer\.email\}\}, which recording\.received never carries/);
    const made = await asOperator((c) => createCompanyWorkflow(c, { companyId: ids.m, name: "Nick's bookings", definition: trcCallBooked(), note: "x", dryRun: true }));
    expect(made).toMatchObject({ ok: false, status: 422 });
  });

  it("a copy that already has such a match still saves an unrelated change, with the match said as a warning", async () => {
    const id = await wfId("m", "call-booked");
    // as an offer saved it before this guard: written straight to a version, as the save did then
    await asOperator(async (c) => {
      const v = (await one<{ v: number }>(c, "select current_version v from workflows where id=$1", [id]))!.v + 1;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,$2,$3,'{\"bindings\":[]}',$4)", [id, v, trcCallBooked(), "before D339"]);
      await c.query("update workflows set current_version=$2 where id=$1", [id, v]);
    });
    const edited = trcCallBooked(); edited.nodes.find((n) => n.type === "trigger")!.title = "Booked (Nick)";
    const r = await asOperator((c) => saveDefinition(c, { workflowId: id, definition: edited, note: "rename the trigger", dryRun: true }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join(" ")).toMatch(/appointment\.closer\.ghl_user_id.*already so before this change/);
  });

  it("every shipped template, and every frozen fixture on its workflow, saves as before (dry run)", async () => {
    for (const t of templates.filter((x) => SLUGS.includes(x.slug))) {
      const r = await asOperator(async (c) => saveDefinition(c, { workflowId: await wfId("m", t.slug), definition: clone(t.definition), note: "same", dryRun: true }));
      expect(r.ok, `${t.slug}: ${JSON.stringify(r)}`).toBe(true);
    }
    // an offer whose saved copy is the fixture: written as its version (as it was saved then), then an unrelated change saved on it
    for (const f of fixtures) {
      const id = await wfId("m", f.slug);
      await asOperator(async (c) => {
        const v = (await one<{ v: number }>(c, "select current_version v from workflows where id=$1", [id]))!.v + 1;
        await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,$2,$3,'{\"bindings\":[]}',$4)", [id, v, f.def, f.name]);
        await c.query("update workflows set current_version=$2 where id=$1", [id, v]);
      });
      const edited = clone(f.def); edited.nodes[0].title = `${String(edited.nodes[0].title ?? "")} (renamed)`;
      const r = await asOperator((c) => saveDefinition(c, { workflowId: id, definition: edited, note: "rename", dryRun: true }));
      expect(r.ok, `${f.name}: ${JSON.stringify(r)}`).toBe(true);
      if (r.ok) expect(r.warnings.filter((w) => /never carries/.test(w)), f.name).toEqual([]);
    }
  });
});

const OPTIONS = [{ key: "nick", label: "Nick" }, { key: "tiffany", label: "Tiffany" }];
const reading = (fields: () => Promise<ObjectField[]>): Adapters => { const a = fakeAdapters(); return { ...a, read: { ...a.read, objectFields: async (_c, key) => (key === "custom_objects.sales_call" ? fields() : []) } }; };
const dropdown = reading(async () => [{ key: "closer", type: "SINGLE_OPTIONS", options: OPTIONS }, { key: "outcome", type: "SINGLE_OPTIONS" }]);
const bind = (co: string, key: string, value: string) => asOperator((c) => c.query("insert into bindings (company_id,key,kind,value) values ($1,$2,'text',$3) on conflict (company_id,key) do update set value=excluded.value", [ids[co], key, Buffer.from(value)]));
const live = (wf: string, a: Adapters) => asOperator((c) => setWorkflowMode(c, wf, "live", "test", "test", a));
const ghost = (wf: string) => asOperator((c) => c.query("update workflows set mode=null where id=$1", [wf]));

describe.skipIf(!process.env.DATABASE_URL)("D339: go-live refuses a Sales Call Closer the field does not offer", () => {
  let callBooked: string, newLead: string;
  beforeAll(async () => {
    await migrate();
    ids.g = await reset("closergate");
    await asOperator(async (c) => {
      await installTemplates(c, ids.g, ["call-booked", "call-recorded", "new-lead"], { existed: false, enable: true });
      await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id) values ($1,'T1',$2,'U1')", [ids.g, Buffer.from("x")]);
      await c.query("insert into users (company_id, email, name, role, ghl_user_id) values ($1,'nick@trc.test','Nick Rowe','closer','GHL-NICK'),($1,'tiffany@trc.test','Tiffany Rose','closer','GHL-TIFF')", [ids.g]);
      // every setting the workflows need, so the closer is the only thing that can stand in the way
      for (const w of await many<{ manifest: { bindings: { key: string; required: boolean }[] } }>(c, "select v.manifest from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1", [ids.g]))
        for (const b of w.manifest.bindings) if (b.required) await c.query("insert into bindings (company_id,key,kind,value) values ($1,$2,'text',$3) on conflict do nothing", [ids.g, b.key, Buffer.from("X")]);
    });
    callBooked = await wfId("g", "call-booked"); newLead = await wfId("g", "new-lead");
  });

  it("TRC: closer_options {} on a dropdown Closer: Call booked cannot go live, naming each closer and the fix", async () => {
    await bind("g", "sales_call.closer_options", "{}");
    const r = await live(callBooked, dropdown);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const text = r.blockers!.map((b) => b.text).join(" ");
      expect(text).toMatch(/Nick Rowe's Sales Calls with Closer "Nick Rowe", which the Closer field \(a dropdown: nick, tiffany\) does not offer/);
      expect(text).toMatch(/Tiffany Rose/);
      expect(text).toMatch(/sales_call\.closer_options/);
    }
    expect((await asOperator((c) => one<{ mode: string | null }>(c, "select mode from workflows where id=$1", [callBooked])))!.mode).toBeNull();
  });

  it("mapped to the field's keys: it goes live; a closer left out of the map is said (blank Closer), not blocking", async () => {
    await bind("g", "sales_call.closer_options", JSON.stringify({ "nick@trc.test": "nick", "GHL-TIFF": "tiffany" }));
    const r = await live(callBooked, dropdown);
    expect(r).toMatchObject({ ok: true, changed: true });
    if (r.ok) expect(r.warnings).toBeUndefined();
    await ghost(callBooked);
    await bind("g", "sales_call.closer_options", JSON.stringify({ "nick@trc.test": "nick" }));
    const w = await live(callBooked, dropdown);
    expect(w.ok).toBe(true);
    if (w.ok) expect(w.warnings?.map((x) => x.text).join(" ")).toMatch(/Tiffany Rose has no entry in sales_call\.closer_options, so their Sales Calls are written with no Closer/);
    await ghost(callBooked);
  });

  it("a mapped key the field does not have is refused; a name that is already an option (its label) is taken", async () => {
    await bind("g", "sales_call.closer_options", JSON.stringify({ "nick@trc.test": "nik", "tiffany@trc.test": "tiffany" }));
    const r = await live(callBooked, dropdown);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blockers!.map((b) => b.text).join(" ")).toMatch(/Closer "nik" \(their sales_call\.closer_options entry\)/);
    await bind("g", "sales_call.closer_options", "{}");
    const named = reading(async () => [{ key: "closer", type: "SINGLE_OPTIONS", options: [{ key: "nick_rowe", label: "Nick Rowe" }, { key: "tiffany_rose", label: "Tiffany Rose" }] }]);
    expect(await live(callBooked, named)).toMatchObject({ ok: true });
    await ghost(callBooked);
  });

  it("a Closer that is plain text takes any name; a read that fails, or an engine that cannot read, is a blocker", async () => {
    await bind("g", "sales_call.closer_options", "{}");
    expect(await live(callBooked, reading(async () => [{ key: "closer", type: "TEXT" }]))).toMatchObject({ ok: true });
    await ghost(callBooked);
    const down = await live(callBooked, reading(async () => { throw new Error("GHL 503"); }));
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.blockers!.map((b) => b.text).join(" ")).toMatch(/could not be read from GHL to check them \(GHL 503\)/);
    const blind = await live(callBooked, fakeAdapters());
    expect(blind.ok).toBe(false);
  });

  it("a workflow that does not write the Sales Call's Closer never reads GHL for it, and goes up as before", async () => {
    let read = 0;
    const counting = reading(async () => { read++; throw new Error("should not be read"); });
    expect(await live(newLead, counting)).toMatchObject({ ok: true });
    expect(read).toBe(0);
    expect(await asOperator((c) => closerFieldBlockers(c, ids.g, [callBooked], () => "ghost", "/x", counting))).toEqual([]);   // staying below quiet: nothing to check
    expect(read).toBe(0);
  });

  it("every frozen fixture that writes the Closer goes live where its writes are taken, and is refused only where GHL would refuse them", async () => {
    const writers = fixtures.filter((x) => ["call-booked", "call-recorded"].includes(x.slug));
    expect(writers.length).toBeGreaterThanOrEqual(4);
    const named = reading(async () => [{ key: "closer", type: "SINGLE_OPTIONS", options: [{ key: "nick_rowe", label: "Nick Rowe" }, { key: "tiffany_rose", label: "Tiffany Rose" }] }]);
    // D289: Sales call recorded goes up only after Call booked, which makes the record it updates
    await asOperator((c) => c.query("update workflows set enabled=true where company_id=$1", [ids.g]));
    for (const f of writers) {
      const wf = await wfId("g", f.slug);
      await asOperator((c) => c.query("update workflows set mode=$2 where id=$1", [callBooked, f.slug === "call-recorded" ? "live" : null]));
      const s = await asOperator((c) => saveDefinition(c, { workflowId: wf, definition: clone(f.def), note: f.name }));
      expect(s.ok, `${f.name}: ${JSON.stringify(s)}`).toBe(true);
      // as Hair and PMU were set up before D118: the field offers the closers' names, nothing mapped; every copy writes a name it takes
      await bind("g", "sales_call.closer_options", "{}");
      const a = await live(wf, named); expect(a, `${f.name}: ${JSON.stringify(a)}`).toMatchObject({ ok: true }); await ghost(wf);
      // keys mapped (D118): the copies that write through the option keys go live; a copy from before D118 writes the name, which GHL refuses
      await bind("g", "sales_call.closer_options", JSON.stringify({ "nick@trc.test": "nick", "tiffany@trc.test": "tiffany" }));
      const viaOption = /option:sales_call_closer/.test(JSON.stringify(f.def));
      const b = await live(wf, dropdown);
      expect(b.ok, `${f.name}: ${JSON.stringify(b)}`).toBe(viaOption);
      if (b.ok) await ghost(wf);
    }
    await ghost(callBooked);
  });
});
