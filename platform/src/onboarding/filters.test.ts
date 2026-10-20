/**
 * D180: their own GHL workflows, marked one by one. D192: a move up no longer waits for a check; the hourly Health check says a
 * new or changed one instead.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { setCompanyMode, setWorkflowMode } from "@/engine/golive";
import { installTemplateForTest } from "@/engine/test-install";
import { createClient, onboardingState } from "@/onboarding/store";
import { confirmCheck, filtersState, markWorkflow, problemsOf, readTheirWorkflows, saveList, useCheck, type TheirWorkflow } from "@/onboarding/filters";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const theirs: TheirWorkflow[] = [{ id: "w1", name: "Old booking confirmation", status: "published" }, { id: "w2", name: "Birthday text", status: "draft" }];

describe("D180: problemsOf", () => {
  it("names each published workflow not marked (a draft never runs, so it needs none), and one marked off that GHL says is on", () => {
    expect(problemsOf(theirs, {})).toEqual(["Old booking confirmation (published): not marked yet"]);
    const m = (mark: "off" | "filtered") => ({ mark, name: "x", status: "draft", at: "", by: "t" });
    expect(problemsOf(theirs, { w1: m("off"), w2: m("off") })).toEqual(["Old booking confirmation: marked off, but GHL says it is published"]);
    expect(problemsOf(theirs, { w1: m("filtered"), w2: m("off") })).toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D180: their GHL workflows and the check before every move up", () => {
  let id: string, wf: string;
  const wipe = async (slug: string) => asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return;
    await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
    for (const t of ["onboarding", "workflow_triggers", "workflows", "bindings", "company_terms", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
    await c.query("delete from companies where id=$1", [co.id]);
  });
  beforeAll(async () => {
    await migrate();
    await wipe("filters-co"); await wipe("filters-plain"); await wipe("filters-tpl");
    id = (await asOperator((c) => createClient(c, { name: "Filters Co", timezone: "America/Phoenix", kind: "takeover" })) as { id: string }).id;
    wf = await asOperator((c) => installTemplateForTest(c, id, "card-moved"));
  });
  const step = async () => (await asOperator((c) => onboardingState(c, "filters-co")))!.steps.find((s) => s.id === "filters")!.done;

  it("reads their list only once their GHL is connected", async () => {
    expect(await readTheirWorkflows(asOperator, id, { workflows: async () => theirs })).toMatchObject({ ok: false, status: 409 });
    await asOperator(async (c) => {
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'crm.location_id','id',$2)", [id, Buffer.from("LOC")]);
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'secret.ghl_pit','secret',$2)", [id, encrypt("pit")]);
    });
    let asked: string[] = [];
    expect(await readTheirWorkflows(asOperator, id, { workflows: async (pit, loc) => { asked = [pit, loc]; return theirs; } })).toEqual({ ok: true, list: theirs });
    expect(asked).toEqual(["pit", "LOC"]);
    expect(await readTheirWorkflows(asOperator, id, { workflows: async () => { throw new Error("GHL 401"); } })).toMatchObject({ ok: false, status: 502, why: expect.stringContaining("GHL 401") });
  });

  it("is done once every workflow on the list is marked; off is refused while GHL says it is on", async () => {
    await asOperator((c) => saveList(c, id, theirs));
    expect(await step()).toBeNull();
    expect(await asOperator((c) => markWorkflow(c, id, { id: "w1", mark: "off" }))).toMatchObject({ ok: false, status: 422 });
    expect(await asOperator((c) => markWorkflow(c, id, { id: "w9", mark: "off" }))).toMatchObject({ ok: false, status: 400 });
    expect(await asOperator((c) => markWorkflow(c, id, { id: "w1", mark: "maybe" }))).toMatchObject({ ok: false, status: 400 });
    expect(await asOperator((c) => markWorkflow(c, id, { id: "w1", mark: "replaced", note: "ours sends the confirmations" }))).toEqual({ ok: true });
    expect(await asOperator((c) => markWorkflow(c, id, { id: "w2", mark: "off" }))).toEqual({ ok: true });
    expect(await step()).toMatchObject({ by: "filters" });
    expect((await asOperator((c) => filtersState(c, id)))!.rows.map((r) => [r.name, r.marked?.mark])).toEqual([["Old booking confirmation", "replaced"], ["Birthday text", "off"]]);
    // a new workflow of theirs appears: the step is no longer done until it is marked
    await asOperator((c) => saveList(c, id, [...theirs, { id: "w3", name: "New lead nurture", status: "published" }]));
    expect(await step()).toBeNull();
  });

  it("D192: a move up no longer waits for a check, the company's or a workflow's (Tyler: \"If I turn it on it should obey me\")", async () => {
    expect(await asOperator((c) => setCompanyMode(c, id, "test", "/app/c/filters-co", "t"))).toMatchObject({ ok: true, changed: true, mode: "test" });
    expect(await asOperator((c) => setCompanyMode(c, id, "ghost", "/app/c/filters-co", "t"))).toMatchObject({ ok: true });
    expect(await asOperator((c) => setWorkflowMode(c, wf, "test", "t", "t"))).toMatchObject({ ok: true, changed: true });
    expect(await asOperator((c) => setWorkflowMode(c, wf, null, "t", "t"))).toMatchObject({ ok: true });
    // a check can still be made (the dashboard's "Check now"): it reads the list and says what is not marked
    const list = [...theirs, { id: "w3", name: "New lead nurture", status: "published" }];
    expect(await asOperator((c) => confirmCheck(c, id, list))).toMatchObject({ ok: false, status: 409, problems: ["New lead nurture (published): not marked yet"] });
  });

  it("D192: the hourly Health check says a published workflow of theirs not marked, or one marked off that is on, once; nothing before the list was first marked", async () => {
    const { sweep } = await import("@/engine/health");
    const { loadCompany } = await import("@/engine/context");
    const { fakeAdapters, fakeProbes } = await import("@/engine/test-install");
    const list = [...theirs, { id: "w3", name: "New lead nurture", status: "published" }];
    const run = (co: string, l: TheirWorkflow[]) => asOperator(async (c) => (await sweep(c, (await loadCompany(c, co)).row, fakeAdapters(), { ...fakeProbes, theirWorkflows: async () => l }, { checks: { their_workflows: true }, min_slots: 0, slots_days: 7 })).filter((f) => f.check === "their_workflows"));
    expect(await run(id, list)).toEqual([expect.objectContaining({ ok: false, item: "w3", text: expect.stringContaining('"New lead nurture" is published and not marked yet'), detail: { repeat: false } })]);
    await asOperator((c) => markWorkflow(c, id, { id: "w3", mark: "filtered" }));
    expect(await run(id, list)).toEqual([expect.objectContaining({ ok: true })]);
    // marked off, then turned on in GHL
    expect(await run(id, [{ id: "w1", name: "Old booking confirmation", status: "published" }, { id: "w2", name: "Birthday text", status: "published" }, list[2]])).toEqual([expect.objectContaining({ ok: false, item: "w2", text: expect.stringContaining("was marked off, but GHL says it is published") })]);
  });

  it("D151: a company set up before the wizard gets a takeover row with the list the first time it is read, and is never gated", async () => {
    const plain = await asOperator(async (c) => (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode, status) values ('Plain','filters-plain','America/Phoenix','ghost','active') returning id"))!.id);
    expect(await asOperator((c) => filtersState(c, plain))).toMatchObject({ rows: [], done: false, check: { fresh: false } });
    expect(await asOperator((c) => setCompanyMode(c, plain, "test", "/app/c/filters-plain", "t"))).toMatchObject({ ok: true, changed: true });
    await asOperator((c) => saveList(c, plain, theirs));
    expect(await asOperator((c) => one(c, "select kind from onboarding where company_id=$1", [plain]))).toEqual({ kind: "takeover" });
  });

  it("a template business is not gated (D183)", async () => {
    const tpl = await asOperator(async (c) => (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, mode, status) values ('Tpl','filters-tpl','America/Phoenix','ghost','template') returning id"))!.id);
    expect(await asOperator((c) => useCheck(c, tpl, "x"))).toBeNull();
  });
});
