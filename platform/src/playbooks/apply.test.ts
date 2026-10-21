/**
 * D170: a playbook put on a company saves exactly its copies, all or nothing, never removing anything; a second run changes
 * nothing; a copy changed by hand afterwards shows as stale. An offer's settings copy onto a new company only where the new one
 * has none of its own, and never a secret, an id, a channel or the scope tag. Every workflow gets its starting rung (#48).
 * D208: every copy at once only while a company is onboarding (or a template business); a running offer takes one named workflow,
 * the route is a dry run unless told to apply, and `fromTemplate` is refused on a copy the playbook builds.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { findCompanyWorkflow, saveDefinition } from "@/engine/definitions";
import { fakeAdapters } from "@/engine/test-install";
import { defaultPrompts } from "@/prompts";
import { templates } from "@/templates";
import { SETTING_DEFAULTS } from "@/engine/setting-defaults";
import { applyPlaybook, copyOfferSettings, playbookState, rungPlan, PLAYBOOK_KEY } from "@/playbooks/apply";
import { POST as playbooksPost } from "../../app/api/admin/playbooks/route";
import { POST as definitionPost } from "../../app/api/admin/workflows/definition/route";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.CRON_SECRET ??= "apply-test-secret";
const call = (route: (r: Request) => Promise<Response>, body: unknown) =>
  route(new Request("http://x/api", { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
const PMU_PARAMS = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../installs/pmu/playbook.json"), "utf8")).params;
const ONE_BOARD = ["new-lead", "call-booked", "call-cancelled", "call-outcome", "call-recorded", "deal-closed", "payment-recorded", "pre-call-sequence", "card-moved"];

async function wipe(slug: string) {
  await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
    if (!co) return;
    await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
    await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
    for (const t of ["sends", "runs", "events", "workflow_triggers", "workflows", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
    await c.query("delete from companies where id=$1", [co.id]);
  });
}
const binding = (companyId: string, key: string) => asOperator(async (c) => (await one<{ kind: string; value: Buffer }>(c, "select kind, value from bindings where company_id=$1 and key=$2", [companyId, key])) ?? null);
const versions = (companyId: string) => asOperator((c) => many<{ name: string; current_version: number }>(c, "select name, current_version from workflows where company_id=$1 order by name", [companyId]));
const base = { timezone: "America/New_York", locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" } };

describe.skipIf(!process.env.DATABASE_URL)("D170: putting a playbook on a company", () => {
  let src: string, dst: string, partial: string;
  beforeAll(async () => {
    await migrate();
    for (const s of ["pb-src", "pb-new", "pb-part"]) await wipe(s);
    src = (await installCompany({ ...base, name: "Source", slug: "pb-src", scopeTag: "src", testDomains: ["example.com"], prompts: { call_review: "PMU's own review prompt" },
      salesCall: { objections: ["price", "timing"], dispositions: { closed_won: "closed", lost: "lost" } }, qualify: { mqlAnswers: ["Employed"] }, slack: { bookings: "CSRC" },
      alerts: { repeatMinutes: 90 }, quietWhenEmpty: true, calendars: { CAL: { term: "closing", name: "Demo call" } } }, fakeAdapters())).companyId;
    await asOperator((c) => c.query("insert into bindings (company_id, key, kind, value) values ($1,'secret.anthropic_key','secret',$2)", [src, Buffer.from("x")]));
    dst = (await installCompany({ ...base, name: "New offer", slug: "pb-new", alerts: { repeatMinutes: 30 } }, fakeAdapters())).companyId;
    partial = (await installCompany({ ...base, name: "Partial", slug: "pb-part", templates: ["new-lead"] }, fakeAdapters())).companyId;
    // both are new offers still being built: a playbook goes on whole only then (D208)
    await asOperator((c) => c.query("update companies set status='onboarding' where id = any($1::uuid[])", [[dst, partial]]));
  });

  it("copies how the offer sells onto the new company where it has nothing of its own; never a secret, an id, a channel or the scope tag", async () => {
    const dry = await asOperator((c) => copyOfferSettings(c, { from: "pb-src", to: "pb-new", dryRun: true }));
    expect(dry).toMatchObject({ ok: true, dryRun: true, kept: ["alerts.repeat_minutes"], terms: ["appointment_type: Demo call"] });
    if (!dry.ok) return;
    // reports.quiet_when_empty: the target holds the default install wrote (D200), which is not its own
    expect(dry.copied).toEqual(expect.arrayContaining(["prompt.call_review", "qualify.mql_answers", "sales_call.dispositions", "sales_call.objections", "test.domains", "reports.quiet_when_empty"]));
    for (const k of dry.copied) expect(k, k).not.toMatch(/^(secret\.|slack\.channel\.|crm\.|scope\.tag)/);
    expect((await binding(dst, "sales_call.objections"))!.value.toString()).toBe(SETTING_DEFAULTS["sales_call.objections"].default);   // a dry run writes nothing
    const r = await asOperator((c) => copyOfferSettings(c, { from: "pb-src", to: "pb-new", by: "test" }));
    expect(r).toMatchObject({ ok: true, copied: dry.copied });
    expect((await binding(dst, "prompt.call_review"))!.value.toString()).toBe("PMU's own review prompt");   // the untouched default was not the company's own
    expect((await binding(dst, "alerts.repeat_minutes"))!.value.toString()).toBe("30");                     // its own value stays
    expect((await binding(dst, "reports.quiet_when_empty"))!.value.toString()).toBe("true");
    for (const k of ["secret.anthropic_key", "scope.tag", "slack.channel.bookings"]) expect(await binding(dst, k), k).toBeNull();
    expect(await asOperator((c) => one(c, "select 1 from company_terms where company_id=$1 and domain='appointment_type' and name='Demo call'", [dst]))).toBeTruthy();
    // a prompt the source never changed stays the target's default
    expect((await binding(dst, "prompt.call_notes"))!.value.toString()).toBe(defaultPrompts.call_notes);
    expect(await asOperator((c) => copyOfferSettings(c, { from: "pb-src", to: "pb-new" }))).toMatchObject({ ok: true, copied: [] });
  });

  it("a dry run checks every copy and writes nothing; the run saves each one, keeps the playbook, and a second run changes nothing", async () => {
    const before = await versions(dst);
    const dry = await asOperator((c) => applyPlaybook(c, { company: "pb-new", playbook: "one-board", params: PMU_PARAMS, dryRun: true }));
    expect(dry).toMatchObject({ ok: true, dryRun: true, playbook: "one-board" });
    if (!dry.ok) return;
    expect(dry.copies.map((o) => [o.workflow, o.did])).toEqual(ONE_BOARD.map((w) => [w, "saved"]));
    expect(await versions(dst)).toEqual(before);
    expect(await binding(dst, PLAYBOOK_KEY)).toBeNull();

    const r = await asOperator((c) => applyPlaybook(c, { company: "pb-new", playbook: "one-board", params: PMU_PARAMS, by: "test" }));
    expect(r.ok && r.copies.every((o) => o.did === "saved")).toBe(true);
    const after = await versions(dst);
    const name = (slug: string) => templates.find((t) => t.slug === slug)!.name;
    for (const w of ONE_BOARD) expect(after.find((v) => v.name === name(w))!.current_version, w).toBe(before.find((v) => v.name === name(w))!.current_version + 1);
    expect(JSON.parse((await binding(dst, PLAYBOOK_KEY))!.value.toString())).toEqual({ slug: "one-board", params: PMU_PARAMS });
    // the saved copy is PMU's copy, built for this company
    const booked = await asOperator(async (c) => { const w = await findCompanyWorkflow(c, dst, "call-booked"); return one<{ definition: { nodes: { id: string }[] } }>(c, "select v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.id=$1", [w.ok ? w.id : ""]); });
    expect(booked!.definition.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["f_card", "c_new", "c_rs", "v_type"]));

    const again = await asOperator((c) => applyPlaybook(c, { company: "pb-new", playbook: "one-board", params: PMU_PARAMS }));
    expect(again.ok && again.copies.map((o) => o.did)).toEqual(ONE_BOARD.map(() => "current"));
    expect(await versions(dst)).toEqual(after);
    expect(await asOperator((c) => playbookState(c, dst, "pb-new"))).toEqual({ playbook: "one-board", stale: [] });
  });

  it("a copy changed by hand afterwards is stale until the playbook is applied again", async () => {
    await asOperator(async (c) => {
      const w = await findCompanyWorkflow(c, dst, "deal-closed"); if (!w.ok) throw new Error(w.why);
      const cur = (await one<{ definition: { nodes: { id: string; title?: string }[] } }>(c, "select v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.id=$1", [w.id]))!.definition;
      cur.nodes[1].title = "changed by hand";
      expect(await saveDefinition(c, { workflowId: w.id, definition: cur, note: "by hand" })).toMatchObject({ ok: true, saved: true });
    });
    expect(await asOperator((c) => playbookState(c, dst, "pb-new"))).toEqual({ playbook: "one-board", stale: ["deal-closed"] });
    await asOperator((c) => applyPlaybook(c, { company: "pb-new", playbook: "one-board", params: PMU_PARAMS }));
    expect((await asOperator((c) => playbookState(c, dst, "pb-new"))).stale).toEqual([]);
  });

  it("all or nothing: one copy that cannot be saved saves none, and says which; bad params and an unknown playbook are refused", async () => {
    const before = await versions(partial);
    const r = await asOperator((c) => applyPlaybook(c, { company: "pb-part", playbook: "one-board", params: PMU_PARAMS }));
    expect(r).toMatchObject({ ok: false, status: 422 });
    if (r.ok) return;
    expect(r.copies!.find((o) => o.workflow === "new-lead")!.did).toBe("saved");
    expect(r.copies!.find((o) => o.workflow === "call-booked")).toMatchObject({ did: "refused", why: "the company does not have call-booked: install its template first" });
    expect(await versions(partial)).toEqual(before);
    expect(await asOperator((c) => applyPlaybook(c, { company: "pb-part", playbook: "one-board", params: { ...PMU_PARAMS, objections: [] } }))).toMatchObject({ ok: false, status: 422, why: expect.stringMatching(/objections/) });
    expect(await asOperator((c) => applyPlaybook(c, { company: "pb-part", playbook: "nope" }))).toMatchObject({ ok: false, status: 400 });
    expect(await asOperator((c) => applyPlaybook(c, { company: "pb-none", playbook: "one-board" }))).toMatchObject({ ok: false, status: 404 });
  });

  it("D208: a running offer takes one named workflow at a time; never every copy at once, never by default, never the bare template over a copy", async () => {
    await asOperator((c) => c.query("update companies set status='active' where id=$1", [dst]));
    const before = await versions(dst), kept = (await binding(dst, PLAYBOOK_KEY))!.value.toString();
    // every copy at once: a dry run still reads, a write is refused
    expect(await asOperator((c) => applyPlaybook(c, { company: "pb-new", playbook: "one-board", params: PMU_PARAMS, dryRun: true }))).toMatchObject({ ok: true, dryRun: true });
    expect(await asOperator((c) => applyPlaybook(c, { company: "pb-new", playbook: "one-board", params: PMU_PARAMS }))).toMatchObject({ ok: false, status: 409, why: expect.stringMatching(/one named workflow/) });
    expect(await versions(dst)).toEqual(before);
    // the route: a dry run unless told to apply, whatever else it is sent
    const dry = await (await call(playbooksPost, { company: "pb-new", playbook: "one-board", workflow: "deal-closed", dryRun: false })).json();
    expect(dry).toMatchObject({ ok: true, playbook: { dryRun: true, copies: [{ workflow: "deal-closed" }] } });
    expect(await versions(dst)).toEqual(before);
    // one named workflow, built with the params the company keeps: only it moves, the kept playbook stays
    const hand = await asOperator(async (c) => {
      const w = await findCompanyWorkflow(c, dst, "deal-closed"); if (!w.ok) throw new Error(w.why);
      const cur = (await one<{ definition: { nodes: { id: string; title?: string }[] } }>(c, "select v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.id=$1", [w.id]))!.definition;
      cur.nodes[1].title = "changed by hand again";
      return saveDefinition(c, { workflowId: w.id, definition: cur, note: "by hand" });
    });
    expect(hand).toMatchObject({ ok: true, saved: true });
    const mid = await versions(dst);
    const r = await (await call(playbooksPost, { company: "pb-new", playbook: "one-board", workflow: "deal-closed", apply: true, by: "test" })).json();
    expect(r).toMatchObject({ ok: true, playbook: { dryRun: false, copies: [{ workflow: "deal-closed", did: "saved" }], prompts: [] } });
    const name = templates.find((t) => t.slug === "deal-closed")!.name;
    expect(await versions(dst)).toEqual(mid.map((v) => (v.name === name ? { ...v, current_version: v.current_version + 1 } : v)));
    expect((await binding(dst, PLAYBOOK_KEY))!.value.toString()).toBe(kept);
    expect(await asOperator((c) => playbookState(c, dst, "pb-new"))).toEqual({ playbook: "one-board", stale: [] });
    // a workflow the playbook does not build, and another playbook, are refused
    expect(await asOperator((c) => applyPlaybook(c, { company: "pb-new", playbook: "one-board", workflow: "speed-to-lead" }))).toMatchObject({ ok: false, status: 404 });
    expect(await asOperator((c) => applyPlaybook(c, { company: "pb-new", playbook: "setter-closer", workflow: "deal-closed" }))).toMatchObject({ ok: false, status: 409 });
    // the bare template over a playbook copy would drop the playbook's changes: refused, pointing at the playbook; any other copy is not
    const fromTpl = await definitionPost(new Request("http://x/api", { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ company: "pb-new", workflow: "call-booked", fromTemplate: true, dryRun: true, note: "bring the template" }) }));
    expect(fromTpl.status).toBe(409);
    expect((await fromTpl.json()).error).toMatch(/one-board playbook/);
    const other = await definitionPost(new Request("http://x/api", { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ company: "pb-new", workflow: "speed-to-lead", fromTemplate: true, dryRun: true, note: "bring the template" }) }));
    expect(other.status).toBe(200);
  });

  it("#48: every workflow's starting rung follows what it does", async () => {
    const plan = await asOperator((c) => rungPlan(c, dst));
    expect(plan.length).toBe(templates.length);
    const of = (w: string) => plan.find((p) => p.workflow === w)!;
    expect(of("pre-call-sequence")).toMatchObject({ rung: "test", why: expect.stringMatching(/texts the contact/) });
    expect(of("deal-closed").rung).toBe("test");
    expect(of("call-booked")).toMatchObject({ rung: "quiet", why: "nothing in it reaches a contact" });
    expect(of("eod-reminder").rung).toBe("quiet");
  });
});
