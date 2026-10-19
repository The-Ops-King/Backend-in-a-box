/**
 * D155: a playbook's template business. Made with its playbook installed, every workflow off, status template (never run);
 * publish is refused while another client's words are in it or a workflow is changed beyond words, and names each; once clean it
 * keeps a release (words, params, settings), noting placeholders left for each client; a new client on that playbook starts from
 * it: the params made the offer's, the words and settings where it has none of its own.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { parseDefinition, type Node } from "@/engine/definition";
import { EDITABLE, type CopyField } from "@/engine/copy";
import { setWord, loadWords } from "@/engine/words";
import { saveStepEdit } from "@/engine/edits";
import { foreignWords } from "@/onboarding/messages";
import { createClient, saveIntake } from "@/onboarding/store";
import { ensureTemplateBusiness, latestRelease, publish, seedFromRelease, setTemplateParams, templateSlug, untested } from "@/playbooks/template-business";
import { scenariosFor, testedFingerprint, type Tests } from "@/onboarding/tests";
import { playbookOf } from "@/playbooks";
import type { Intake } from "@/onboarding/intake";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const PB = "one-board", SLUG = templateSlug(PB);
async function wipe(slug: string) {
  await asOperator(async (c) => { const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return;
    await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
    for (const t of ["onboarding", "workflow_triggers", "workflows", "users", "calendars", "company_terms", "bindings", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
    await c.query("delete from companies where id=$1", [co.id]); });
}

/** The test passes as if every journey had passed on the test rung on what is there now (the passes themselves: tests.test.ts). */
async function passTests(companyId: string, rung = "test") {
  await asOperator(async (c) => {
    const o = (await one<{ intake: Intake }>(c, "select intake from onboarding where company_id=$1", [companyId]))!;
    const fp = await testedFingerprint(c, companyId), at = new Date().toISOString();
    const t: Tests = { contact: { id: "x", name: "Test" }, prepared: { at, by: "t", rung: "test", on: [], left_off: [] },
      results: Object.fromEntries((await scenariosFor(c, companyId, o.intake)).map((x) => [x.id, { at, by: "t", rung, acts: [], runs: [], passed: true, fp }])) };
    await c.query("update onboarding set tests=$2 where company_id=$1", [companyId, JSON.stringify(t)]);
  });
}

describe.skipIf(!process.env.DATABASE_URL)("D155: a playbook's template business", () => {
  let id: string;
  beforeAll(async () => { await migrate(); await wipe(SLUG); await wipe("tpl-client"); await asOperator((c) => c.query("delete from playbook_releases where playbook=$1", [PB])); });

  it("is made with its playbook on, every workflow off, never run; making it again changes nothing", async () => {
    const r = await asOperator((c) => ensureTemplateBusiness(c, PB, "test"));
    expect(r).toMatchObject({ ok: true, slug: SLUG, created: true });
    id = (r as { id: string }).id;
    expect(await asOperator((c) => one(c, "select status, mode from companies where id=$1", [id]))).toEqual({ status: "template", mode: "ghost" });
    expect(await asOperator((c) => many(c, "select 1 from workflows where company_id=$1 and enabled", [id]))).toEqual([]);
    expect((await asOperator((c) => one<{ n: number }>(c, "select count(*)::int as n from workflows where company_id=$1 and diverged", [id])))!.n).toBe(playbookOf(PB).changes.length);
    expect(await asOperator((c) => ensureTemplateBusiness(c, PB))).toMatchObject({ ok: true, created: false });
    // D159: set up and tested through the wizard like a client: its offer is its playbook's, its messages need no approval
    const o = await asOperator((c) => one<{ playbook: string; intake: Intake; steps: Record<string, unknown> }>(c, "select playbook, intake, steps from onboarding where company_id=$1", [id]));
    expect(o).toMatchObject({ playbook: PB, intake: { boards: "one", setters: true, payments: "other", recording: "other", agreement: "ghl_documents", booking: "ghl" } });
    expect(Object.keys(o!.steps).sort()).toEqual(["messages", "offer"]);
  });

  it("every playbook's template business can be made (what a client's CRM build gives it, the objections, is seeded)", async () => {
    for (const p of ["setter-closer", "application-triage"]) { await wipe(templateSlug(p)); expect(await asOperator((c) => ensureTemplateBusiness(c, p, "test")), p).toMatchObject({ ok: true, created: true }); }
  });

  it("publish is refused while another client's words are in it, naming each; then once rewritten it keeps a release", async () => {
    const refused = await asOperator((c) => publish(c, PB, "test"));
    expect(refused).toMatchObject({ ok: false, status: 422 });
    expect(!refused.ok && refused.problems!.some((p) => /another client's words/.test(p))).toBe(true);
    expect(!refused.ok && refused.problems![0]).toMatch(/^not tested/);
    // rewrite every word that is Hair's
    const rows = await asOperator((c) => many<{ id: string; definition: unknown }>(c, "select w.id, v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1", [id]));
    for (const r of rows) for (const n of parseDefinition(r.definition).nodes as (Node & Record<string, unknown>)[]) for (const f of EDITABLE[n.type] ?? [])
      if (typeof n[f] === "string" && foreignWords(SLUG, n[f] as string).length) expect(await asOperator((c) => setWord(c, { workflowId: r.id, nodeId: n.id, field: f as CopyField, text: "Hi {{contact.first_name}}, welcome aboard." }))).toMatchObject({ ok: true });
    await passTests(id);
    const r = await asOperator((c) => publish(c, PB, "test"));
    expect(r).toMatchObject({ ok: true, release: { playbook: PB, version: 1, published_by: "test" } });
    if (!r.ok) return;
    expect(Object.keys(r.release.words).length).toBeGreaterThan(0);
    expect(r.release.params).toMatchObject({ name: "Template", board: "Template" });
    expect(Object.keys(r.release.settings).some((k) => k.startsWith("prompt."))).toBe(true);
  });

  it("D159: publish needs every journey passed on the test rung, on exactly what is published", async () => {
    await passTests(id, "ghost");
    expect((await asOperator((c) => untested(c, id)))[0]).toMatch(/ran in ghost: run it again on the test rung/);
    await passTests(id);
    expect(await asOperator((c) => untested(c, id))).toEqual([]);
    const w = (await asOperator((c) => one<{ id: string; definition: { nodes: { id: string; type: string }[] } }>(c, "select w.id, v.definition from workflows w join workflow_templates t on t.id=w.template_id join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1 and t.slug='speed-to-lead'", [id])))!;
    const sms = w.definition.nodes.find((n) => n.type === "send_sms")!;
    expect(await asOperator((c) => setWord(c, { workflowId: w.id, nodeId: sms.id, field: "template" as CopyField, text: "Hi {{contact.first_name}}, saw you came in. When's good?" }))).toMatchObject({ ok: true });
    const stale = await asOperator((c) => untested(c, id));
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.every((p) => /tested an earlier version/.test(p))).toBe(true);
    expect(await asOperator((c) => publish(c, PB))).toMatchObject({ ok: false, status: 422 });
  });

  it("a workflow changed beyond words is refused at publish: its steps are the code's", async () => {
    const w = (await asOperator((c) => one<{ id: string; definition: { nodes: { id: string; type: string }[] } }>(c, "select w.id, v.definition from workflows w join workflow_templates t on t.id=w.template_id join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1 and t.slug='speed-to-lead'", [id])))!;
    const sms = w.definition.nodes.find((n) => n.type === "send_sms")!;
    expect(await asOperator((c) => saveStepEdit(c, { workflowId: w.id, nodeId: sms.id, edit: { type: "send_sms", ghl_template: "snip-1" } }))).toMatchObject({ ok: true });
    await passTests(id);
    const r = await asOperator((c) => publish(c, PB));
    expect(r).toMatchObject({ ok: false, problems: [expect.stringMatching(/Speed to lead.*changed beyond its words.*build-workflow/)] });
    expect((await asOperator((c) => latestRelease(c, PB)))!.version).toBe(1);
  });

  it("params are checked by the playbook; a new client on the playbook starts from the release, made the offer's", async () => {
    expect(await asOperator((c) => setTemplateParams(c, PB, { nope: 1 }))).toMatchObject({ ok: false, status: 422 });
    const cid = (await asOperator((c) => createClient(c, { name: "Tpl Client", slug: "tpl-client", timezone: "America/Phoenix" })) as { id: string }).id;
    const intake: Intake = { business: "Tpl", price: "5000", deposits: false, payment_plans: false, lead_paths: ["ads_direct_book"], application: "none", setters: false, triage: false, boards: "one",
      journey: "They book, the closer closes.", crm: "ghl", booking: "ghl", payments: "whop", recording: "none", agreement: "ghl_documents" };
    await asOperator((c) => saveIntake(c, cid, { intake }));
    expect((await asOperator((c) => one<{ params: { name: string; board: string } }>(c, "select params from onboarding where company_id=$1", [cid])))!.params).toMatchObject({ name: "Tpl Client", board: "Tpl Client" });
    expect(await asOperator((c) => seedFromRelease(c, cid, PB))).toBe(1);
    const words = await asOperator((c) => loadWords(c, cid));
    expect(words).toEqual((await asOperator((c) => latestRelease(c, PB)))!.words);
    expect(await asOperator((c) => one(c, "select 1 from bindings where company_id=$1 and key like 'prompt.%' limit 1", [cid]))).toBeTruthy();
  });
});
