/**
 * D152: the CRM build. The setup is made from the client's playbook, params and research; built into an empty GHL it yields
 * every GHL id the playbook's workflows require (the agreement template and sender are the client's own documents, picked by
 * hand); a plan reads only; a build makes only what is missing and a second build makes nothing; the step is done after a
 * build that left nothing to make.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { templates } from "@/templates";
import { extractManifest, parseDefinition } from "@/engine/definition";
import { playbookOf, playbooks } from "@/playbooks";
import { fakeGhl, LOC } from "@/adapters/ghl/fake-ghl";
import { crmInput, runCrm, saveCrm, saveCrmOptions, setupFor } from "@/onboarding/crm";
import { createClient, onboardingState, saveIntake } from "@/onboarding/store";
import type { Research } from "@/onboarding/research";
import type { Intake } from "@/onboarding/intake";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const research = (named?: string): Research => ({ at: "2026-10-18T00:00:00Z", source: "ghl", calendars: [{ id: "c1", name: "Strategy", teamMemberIds: [] }, { id: "c2", name: "Demo", teamMemberIds: [] }],
  users: [{ id: "u1", name: "Carly Vu", email: "Carly@x.co" }, { id: "u2", name: "Sam", email: "sam@x.co" }], pipelines: [], objects: [], workflows: [], errors: [], proposal: null,
  answers: { calendars: { c1: { call_type: "closing" }, c2: { call_type: "closing", ...(named ? { name: named } : {}) } }, closerCall: "c1", team: { u1: "closer", u2: "setter" } }, done: { at: "2026-10-18T00:00:00Z", by: "test" } });
/** The GHL ids a playbook's workflows must have, as the install's crm map names them (no "crm." prefix). */
function required(slug: string): string[] {
  const pb = playbookOf(slug), copies = pb.build("x", pb.defaults("X Offer") ?? undefined, { salesCall: { objections: ["price"] }, scopeTag: "x", calendars: {} }).copies;
  const replaced = new Set(copies.map((c) => c.create?.takesOver ?? c.workflow));
  const defs = [...templates.filter((t) => !replaced.has(t.slug)).map((t) => ({ slug: t.slug, def: t.definition as unknown })), ...copies.map((c) => ({ slug: c.workflow, def: c.definition as unknown }))]
    // D152: Setter call logged on one board is on the build list (it needs a one-board copy), not the setup's to satisfy
    .filter((d) => !(pb.traits.boards === "one" && d.slug === "setter-call-logged"));
  return [...new Set(defs.flatMap((d) => extractManifest(parseDefinition(d.def)).bindings.filter((b) => b.required && b.key.startsWith("crm.")).map((b) => b.key.slice(4))))]
    .filter((k) => !["location_id", "agreement_template", "agreement_sender"].includes(k)).sort();
}

describe("the setup a client's GHL gets", () => {
  it("is refused until the offer and research are done, saying which", () => {
    expect(() => setupFor({ playbook: null, params: null, research: null, timezone: "UTC", options: { prefix: "" } })).toThrow(/answer The offer first/);
    expect(() => setupFor({ playbook: "one-board", params: null, research: { ...research(), done: undefined }, timezone: "UTC", options: { prefix: "" } })).toThrow(/finish Research first/);
  });

  it("names: closers' first names, the offer's call types, the prefix on everything in a shared account", () => {
    const s = setupFor({ playbook: "setter-closer", params: null, research: research("Demo call"), timezone: "America/Phoenix", options: { prefix: "Glow" } });
    const so = s.objects.find((o) => o.binding === "sales_call")!;
    expect(so.key).toBe("custom_objects.glow_sales_call");
    expect(so.fields.find((f) => f.key === "closer")!.options).toEqual([{ key: "carly", label: "Carly" }]);
    expect(so.fields.find((f) => f.key === "call_type")!.options).toEqual([{ key: "closing", label: "Closing" }, { key: "demo_call", label: "Demo call" }]);
    expect(s.prefix).toBe("Glow – ");
    expect(s.install).toMatchObject({ salesCall: { closerOptions: { "carly@x.co": "carly" } } });
    const own = setupFor({ playbook: "one-board", params: playbookOf("one-board").defaults("Glow"), research: research(), timezone: "UTC", options: { prefix: "" } });
    expect(own.pipelines.map((p) => p.name)).toEqual(["Glow"]);
    expect(own.objects.map((o) => o.key)).toEqual(["custom_objects.sales_call", "custom_objects.payment", "custom_objects.discovery_call"]);
  });

  for (const pb of playbooks) it(`${pb.slug}: built into an empty GHL, every GHL id its workflows require comes out`, async () => {
    const f = fakeGhl();
    const setup = setupFor({ playbook: pb.slug, params: pb.defaults("X Offer") ?? null, research: research(), timezone: "America/New_York", options: { prefix: "" } });
    const run = await runCrm({ companyId: "x", locationId: LOC, pit: "p", setup }, true, f.http);
    expect(run.error).toBeUndefined();
    expect(run.missing).toEqual([]);
    expect(required(pb.slug).length).toBeGreaterThan(20);   // the check is not empty
    expect(required(pb.slug).filter((k) => !run.crm[k])).toEqual([]);
    // a second build finds everything and writes nothing
    const n = f.writes().length;
    const again = await runCrm({ companyId: "x", locationId: LOC, pit: "p", setup }, true, f.http);
    expect(f.writes().length).toBe(n);
    expect(again.plan.filter((l) => l.action === "create")).toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D152: the CRM step", () => {
  let id: string;
  const intake: Intake = { business: "Crm Co", price: "5000", deposits: true, payment_plans: false, lead_paths: ["ads_direct_book"], application: "none", setters: true, triage: false, boards: "setter_and_closer",
    journey: "Setters book, closers close.", crm: "ghl", booking: "ghl", payments: "whop", recording: "fathom", agreement: "ghl_documents" };
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => { const co = await one<{ id: string }>(c, "select id from companies where slug='crm-co'"); if (co) { for (const t of ["onboarding", "bindings", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); } });
    id = (await asOperator((c) => createClient(c, { name: "Crm Co", timezone: "America/New_York" })) as { id: string }).id;
    await asOperator((c) => saveIntake(c, id, { intake }));
    await asOperator(async (c) => {
      for (const [k, kind, v] of [["crm.location_id", "id", LOC], ["secret.ghl_pit", "secret", "pit"]] as const) await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4)", [id, k, kind, kind === "secret" ? encrypt(v) : Buffer.from(v)]);
      await c.query("update onboarding set research=$2, steps = steps || '{\"connections\":{\"done_at\":\"2026-10-18T00:00:00Z\",\"by\":\"t\"},\"research\":{\"done_at\":\"2026-10-18T00:00:00Z\",\"by\":\"t\"}}'::jsonb where company_id=$1", [id, research()]);
    });
  });

  it("the offer's playbook params start from its defaults; a plan reads only; a build makes what is missing and the step is done", async () => {
    expect((await asOperator((c) => one<{ playbook: string; params: unknown }>(c, "select playbook, params from onboarding where company_id=$1", [id])))).toEqual({ playbook: "setter-closer", params: null });
    const input = await asOperator((c) => crmInput(c, id)); if (!input.ok) throw new Error(input.why);
    const f = fakeGhl();
    const plan = await runCrm(input.input, false, f.http);
    expect(f.writes()).toEqual([]);
    expect(plan.plan.filter((l) => l.action === "create").length).toBeGreaterThan(20);
    await asOperator((c) => saveCrm(c, id, plan));
    expect((await asOperator((c) => onboardingState(c, "crm-co")))!.steps.find((x) => x.id === "crm")!.done).toBeNull();
    const built = await runCrm(input.input, true, f.http);
    await asOperator((c) => saveCrm(c, id, built, "test"));
    const s = (await asOperator((c) => onboardingState(c, "crm-co")))!;
    expect(s.steps.find((x) => x.id === "crm")!.done).toMatchObject({ by: "test" });
    expect(s.crm!.last).toMatchObject({ applied: true, missing: [], crm: { pipeline_closer: expect.any(String), object_sales_call: "custom_objects.sales_call" } });
    // a new prefix is a new plan: the step is open again
    expect(await asOperator((c) => saveCrmOptions(c, id, { prefix: "Crm" }))).toEqual({ ok: true });
    expect((await asOperator((c) => onboardingState(c, "crm-co")))!).toMatchObject({ crm: { options: { prefix: "Crm" }, last: null } });
  });
});
