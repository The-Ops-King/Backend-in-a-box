/** D100: a company's whole copy of a workflow saved at once: validated, a new version of that copy only, diverged, triggers re-synced, audited. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installTemplates } from "./install";
import { saveDefinition, validateDefinition } from "./definitions";
import { templates } from "@/templates";
import { encrypt } from "./crypto";
import { GET, POST } from "../../app/api/admin/workflows/definition/route";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const KEY = "defs-test-operator-key";
const prevSecret = process.env.CRON_SECRET;
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const post = (body: unknown, headers: Record<string, string> = auth) => POST(new Request("http://x/api/admin/workflows/definition", { method: "POST", headers, body: JSON.stringify(body) }));
const get = (q: string) => GET(new Request(`http://x/api/admin/workflows/definition?${q}`, { headers: auth }));
type Def = { nodes: { id: string; type: string; [k: string]: unknown }[]; edges: { from: string; to: string; label?: string }[]; [k: string]: unknown };
const node = (d: Def, id: string) => d.nodes.find((n) => n.id === id)!;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const shipped = () => clone(templates.find((t) => t.slug === "call-cancelled")!.definition) as unknown as Def;

/** The onboarding case: one pipeline instead of two. The closer-board card (n2) goes; a second trigger and a set_var come in; the edges are rewired. */
function restructured(def: Def): Def {
  const d = clone(def);
  d.nodes = d.nodes.filter((n) => n.id !== "n2");
  d.nodes.splice(1, 0, { id: "t2", type: "trigger", event: "appointment.rescheduled" }, { id: "v1", type: "set_var", key: "one_board", value: true });
  d.edges = d.edges.filter((e) => e.from !== "n2" && e.to !== "n2" && !(e.from === "n1"));
  d.edges.push({ from: "t2", to: "n1" }, { from: "n1", to: "v1" }, { from: "v1", to: "n3" });
  return d;
}

const ids: Record<string, string> = {};
const wfOf = (slug: string) => asOperator((c) => one<{ id: string; current_version: number; diverged: boolean; template_version: number; enabled: boolean }>(c, "select w.id, w.current_version, w.diverged, w.template_version, w.enabled from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug='call-cancelled'", [ids[slug]]));
const snapshot = async (slug: string) => asOperator(async (c) => {
  const w = (await wfOf(slug))!;
  return {
    w, versions: (await many<{ version: number }>(c, "select version from workflow_versions where workflow_id=$1 order by version", [w.id])).map((v) => v.version),
    triggers: (await many<{ node_id: string; event_type: string }>(c, "select node_id, event_type from workflow_triggers where workflow_id=$1 order by node_id", [w.id])),
    audit: Number((await one<{ n: string }>(c, "select count(*)::text as n from audit_log where company_id=$1", [ids[slug]]))!.n),
    def: (await one<{ definition: unknown }>(c, "select v.definition from workflow_versions v join workflows w on w.id=v.workflow_id and v.version=w.current_version where w.id=$1", [w.id]))!.definition,
  };
});

describe.skipIf(!process.env.DATABASE_URL)("saving a company's whole workflow definition (D100)", () => {
  beforeAll(async () => {
    process.env.CRON_SECRET = KEY;
    await migrate();
    await asOperator(async (c) => {
      for (const slug of ["defa", "defb"]) {
        // kept between runs, not deleted (other suites leave rows on every company); onboarding, so no other suite's tick picks it up
        ids[slug] = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, status) values ($1,$1,'UTC','onboarding') on conflict (slug) do update set status='onboarding' returning id", [slug]))!.id;
        await c.query("delete from sends where company_id=$1", [ids[slug]]);
        await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [ids[slug]]);
        await c.query("delete from runs where company_id=$1", [ids[slug]]);
        await c.query("delete from workflow_triggers where company_id=$1", [ids[slug]]);
        await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [ids[slug]]);
        for (const t of ["workflows", "bindings", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [ids[slug]]);
        await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3)", [ids[slug], Buffer.from("LOC"), encrypt("p")]);
        await installTemplates(c, ids[slug], ["call-cancelled"], { existed: false });
      }
    });
  });
  afterAll(() => { if (prevSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevSecret; });

  it("every shipped template passes the check as it stands (an operator can fetch any copy, edit it and save it)", async () => {
    await asOperator(async (c) => { for (const t of templates) expect(await validateDefinition(c, ids.defa, clone(t.definition)), t.slug).toMatchObject({ ok: true }); });
  });

  it("refuses an invalid definition with every reason, and changes nothing", async () => {
    const before = await snapshot("defa");
    const bad = shipped();
    bad.nodes.push({ id: "z1", type: "teleport" });
    bad.edges.push({ from: "n7", to: "nowhere" });
    node(bad, "n4").title = "Rebook {{contcat.name}}";
    const r = await post({ company: "defa", workflow: "call-cancelled", definition: bad, note: "broken on purpose" });
    expect(r.status).toBe(422);
    const body = await r.json() as { problems: string[] };
    expect(body.problems.some((p) => /node z1: "teleport" is not a step type/.test(p))).toBe(true);
    expect(body.problems.some((p) => /edge to nowhere is not a node/.test(p))).toBe(true);
    expect(body.problems.some((p) => /node n4: \{\{contcat\.name\}\} is not a path the engine knows/.test(p))).toBe(true);
    // a definition that parses but leans on what the engine does not have: an event it never emits, a wait that is not a wait
    const odd = shipped();
    node(odd, "t1").event = "appointment.exploded";
    odd.nodes.splice(1, 0, { id: "w9", type: "wait", rule: { anchor: "now", offset: "soon" } });
    odd.edges = odd.edges.map((e) => (e.from === "t1" ? { from: "t1", to: "w9" } : e)); odd.edges.push({ from: "w9", to: "n1" });
    const r2 = await asOperator((c) => saveDefinition(c, { workflowId: before.w.id, definition: odd, note: "odd" }));
    expect(r2).toMatchObject({ ok: false, status: 422 });
    const problems = (r2 as { problems: string[] }).problems;
    expect(problems.some((p) => /"appointment\.exploded" is not an event the engine knows/.test(p))).toBe(true);
    expect(problems.some((p) => /node w9 rule: "soon" is not a wait/.test(p))).toBe(true);
    expect(await snapshot("defa")).toEqual(before);
  });

  it("dryRun returns the diff and changes nothing", async () => {
    const before = await snapshot("defa");
    const r = await post({ company: "defa", workflow: "call-cancelled", definition: restructured(before.def as Def), note: "one board", dryRun: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, saved: false, dryRun: true, from: before.w.current_version, version: before.w.current_version + 1,
      diff: { nodes: { added: ["t2", "v1"], removed: ["n2"], changed: [] }, edges: { added: ["t2→n1", "n1→v1", "v1→n3"], removed: ["n1→n2", "n2→n3"] }, settings: [] } });
    expect(await snapshot("defa")).toEqual(before);
  });

  it("saving a restructured copy: a new version, diverged, triggers re-synced, audited; a run in flight keeps its version; GET returns what was saved", async () => {
    const before = await snapshot("defa");
    const run = (await asOperator((c) => one<{ id: string }>(c, "insert into runs (company_id, workflow_id, workflow_version, status, current_node, reentry_key) values ($1,$2,$3,'waiting','n2','defa-run') returning id", [ids.defa, before.w.id, before.w.current_version])))!;
    const r = await post({ company: "defa", workflow: "call-cancelled", definition: restructured(before.def as Def), note: "one board: the closer pipeline is not used", by: "tyler" });
    expect(r.status).toBe(200);
    const body = await r.json() as { saved: boolean; version: number; missing: string[] };
    expect(body).toMatchObject({ ok: true, saved: true, from: before.w.current_version, version: before.w.current_version + 1 });
    // the company has none of the CRM ids yet: saved while off, and said
    expect(body.missing).toEqual(expect.arrayContaining(["crm.pipeline_setter", "crm.stage_setter_cancelled"]));
    expect(body.missing).not.toContain("crm.pipeline_closer");
    const after = await snapshot("defa");
    expect(after.w).toMatchObject({ current_version: before.w.current_version + 1, diverged: true });
    expect(after.versions).toEqual([...before.versions, before.w.current_version + 1]);
    expect(after.triggers).toEqual([{ node_id: "t1", event_type: "appointment.status_changed" }, { node_id: "t2", event_type: "appointment.rescheduled" }]);
    const stored = await asOperator((c) => one<{ note: string; manifest: { bindings: { key: string }[] } }>(c, "select note, manifest from workflow_versions where workflow_id=$1 and version=$2", [before.w.id, after.w.current_version]));
    expect(stored!.note).toBe("one board: the closer pipeline is not used");
    expect(stored!.manifest.bindings.map((b) => b.key)).not.toContain("crm.pipeline_closer");
    const audit = await asOperator((c) => one<{ before: unknown; after: Record<string, unknown> }>(c, "select before, after from audit_log where company_id=$1 and action='workflow.definition_saved' and target_id=$2", [ids.defa, before.w.id]));
    expect(audit).toMatchObject({ before: { version: before.w.current_version }, after: { version: before.w.current_version + 1, note: "one board: the closer pipeline is not used", by: "tyler" } });
    // the run started on the old version stays on it, and that version still has the step it is parked on
    const pinned = await asOperator((c) => one<{ workflow_version: number; has: boolean }>(c, "select r.workflow_version, exists (select 1 from jsonb_array_elements(v.definition->'nodes') n where n->>'id'='n2') as has from runs r join workflow_versions v on v.workflow_id=r.workflow_id and v.version=r.workflow_version where r.id=$1", [run.id]));
    expect(pinned).toEqual({ workflow_version: before.w.current_version, has: true });
    const g = await (await get("company=defa&workflow=call-cancelled")).json() as { workflow: { version: number; diverged: boolean }; definition: Def };
    expect(g.workflow).toMatchObject({ version: after.w.current_version, diverged: true });
    expect(g.definition.nodes.map((n) => n.id)).toEqual(restructured(before.def as Def).nodes.map((n) => n.id));
    // the same definition again is no new version
    expect(await asOperator((c) => saveDefinition(c, { workflowId: before.w.id, definition: g.definition, note: "again" }))).toMatchObject({ ok: true, saved: false, version: after.w.current_version });
  });

  it("the other company's copy of the same template is untouched", async () => {
    const b = await snapshot("defb");
    expect(b.w).toMatchObject({ current_version: 1, diverged: false });
    expect(b.def).toEqual(shipped());
    expect(b.triggers).toEqual([{ node_id: "t1", event_type: "appointment.status_changed" }]);
  });

  it("a later template upgrade leaves the diverged copy alone and upgrades the untouched one", async () => {
    const a = await snapshot("defa");
    await asOperator((c) => c.query("update workflows set template_version=0 where company_id = any($1::uuid[])", [[ids.defa, ids.defb]]));
    const outA = await asOperator((c) => installTemplates(c, ids.defa, ["call-cancelled"], { existed: true }));
    const outB = await asOperator((c) => installTemplates(c, ids.defb, ["call-cancelled"], { existed: true }));
    expect(outA[0]).toMatch(/edited since install, left alone/);
    expect(outB[0]).toMatch(/upgraded v1→v2/);
    const a2 = await snapshot("defa");
    expect(a2.w.current_version).toBe(a.w.current_version);
    expect(a2.def).toEqual(a.def);
    expect(a2.triggers).toEqual(a.triggers);
  });

  it("a workflow that is ON is not saved into needing a binding the company lacks", async () => {
    const a = await snapshot("defa");
    await asOperator((c) => c.query("update workflows set enabled=true where id=$1", [a.w.id]));
    const d = clone(a.def) as Def;
    node(d, "n4").title = "Rebook {{contact.name}} on {{crm.board_extra}}";
    const r = await post({ company: "defa", workflow: a.w.id, definition: d, note: "needs a new id" });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ missing: expect.arrayContaining(["crm.board_extra"]) });
    await asOperator((c) => c.query("update workflows set enabled=false where id=$1", [a.w.id]));
    const after = await snapshot("defa");
    expect({ ...after, w: { ...after.w, enabled: true } }).toEqual({ ...a, w: { ...a.w, enabled: true } });
  });

  it("the route needs the operator key, a note, and a workflow the company has", async () => {
    expect((await post({ company: "defa", workflow: "call-cancelled", definition: shipped(), note: "x" }, { "content-type": "application/json" })).status).toBe(401);
    expect((await post({ company: "defa", workflow: "call-cancelled", definition: shipped() })).status).toBe(400);
    expect((await post({ company: "defa", workflow: "nope", definition: shipped(), note: "x" })).status).toBe(404);
  });
});
