/**
 * D153: the install step puts together everything the earlier steps learned: refused until they are done, then the company
 * installed with the mapped calendars, the CRM build's ids, the team's roles, every workflow off, the playbook's copies on, SMS
 * off for a new offer, and the company active in ghost. Re-running changes nothing.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { fakeAdapters } from "@/engine/test-install";
import { fakeGhl, LOC } from "@/adapters/ghl/fake-ghl";
import { crmInput, runCrm, saveCrm } from "@/onboarding/crm";
import { createClient, onboardingState, saveIntake } from "@/onboarding/store";
import { installPlan, runInstall } from "@/onboarding/install";
import type { Intake } from "@/onboarding/intake";
import type { Research } from "@/onboarding/research";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const intake: Intake = { business: "Install Co", price: "9000", deposits: true, payment_plans: false, lead_paths: ["ads_direct_book"], application: "none", setters: false, triage: false, boards: "one",
  journey: "Ads, they book, the closer closes.", crm: "ghl", booking: "ghl", payments: "whop", recording: "none", agreement: "ghl_documents" };
const research: Research = { at: "2026-10-18T00:00:00Z", source: "ghl", calendars: [{ id: "CAL", name: "Closer", teamMemberIds: [] }, { id: "OLD", name: "Old", teamMemberIds: [] }],
  users: [{ id: "u1", name: "Carly Vu", email: "carly@install.co" }, { id: "u2", name: "Ops", email: "ops@install.co" }], pipelines: [], objects: [], workflows: [], errors: [], proposal: null,
  answers: { calendars: { CAL: { call_type: "closing", booking: "self" }, OLD: { call_type: "ignore" } }, closerCall: "CAL", team: { u1: "closer", u2: "manager" } }, done: { at: "2026-10-18T00:00:00Z", by: "t" } };
const done = (steps: string[]) => JSON.stringify(Object.fromEntries(steps.map((s) => [s, { done_at: "2026-10-18T00:00:00Z", by: "t" }])));

describe.skipIf(!process.env.DATABASE_URL)("D153: the install step", () => {
  let id: string;
  const adapters = fakeAdapters();
  adapters.read.listUsers = async () => [{ id: "u1", name: "Carly Vu", email: "carly@install.co" }, { id: "u2", name: "Ops", email: "ops@install.co" }];
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => { const co = await one<{ id: string }>(c, "select id from companies where slug='install-co'"); if (!co) return;
      // once installed the company is active, so the clock and the polls may have left rows of their own
      await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
      await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
      for (const t of ["onboarding", "sends", "runs", "events", "alerts", "agreements", "recordings", "payments", "pipeline_cards", "appointments", "opportunities", "contact_identifiers", "contacts", "workflow_triggers", "workflows", "users", "calendars", "company_terms", "bindings", "poll_cursors", "slack_connections", "health_checks", "audit_log"])
        await c.query(`delete from ${t} where company_id=$1`, [co.id]);
      await c.query("delete from companies where id=$1", [co.id]); });
    id = (await asOperator((c) => createClient(c, { name: "Install Co", timezone: "America/New_York" })) as { id: string }).id;
    await asOperator((c) => saveIntake(c, id, { intake }));
    await asOperator(async (c) => {
      for (const [k, kind, v] of [["crm.location_id", "id", LOC], ["secret.ghl_pit", "secret", "pit-x"]] as const) await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4)", [id, k, kind, kind === "secret" ? encrypt(v) : Buffer.from(v)]);
      await c.query("update onboarding set research=$2, steps = steps || $3::jsonb where company_id=$1", [id, research, done(["connections", "research"])]);
    });
  });

  it("is refused until every earlier step is done, naming them", async () => {
    expect(await asOperator((c) => installPlan(c, id))).toEqual({ ok: false, status: 409, why: "finish Slack, CRM build first" });
    const input = await asOperator((c) => crmInput(c, id)); if (!input.ok) throw new Error(input.why);
    const run = await runCrm(input.input, true, fakeGhl().http);
    await asOperator((c) => saveCrm(c, id, run));
    await asOperator((c) => c.query("update onboarding set steps = steps || $2::jsonb where company_id=$1", [id, done(["slack"])]));
    const p = await asOperator((c) => installPlan(c, id));
    if (!p.ok) throw new Error(p.why);
    expect(p.plan.input).toMatchObject({ slug: "install-co", locationId: LOC, booking: { source: "ghl" }, calendars: { CAL: { term: "closing", booking: "self" } }, closerCall: "CAL",
      closers: ["carly@install.co"], roles: { "ops@install.co": "manager" }, enable: false, mode: "ghost", smsEnabled: false, crm: { pipeline_closer: expect.any(String), object_sales_call: "custom_objects.sales_call" } });
    expect(p.plan.input.calendars).not.toHaveProperty("OLD");
    expect(p.plan.input).not.toHaveProperty("pit");   // the stored token is used; it never leaves the database here
  });

  it("installs everything off, puts the playbook's copies on, and the company runs in ghost; again, nothing changes", async () => {
    const r = await runInstall(asOperator, id, "install-co", adapters, "test");
    expect(r).toMatchObject({ ok: true, playbook: { ok: true, playbook: "one-board" } });
    const co = await asOperator((c) => one<{ status: string; mode: string; sms_enabled: boolean; contract_value_default: string }>(c, "select status, mode, sms_enabled, contract_value_default::text from companies where id=$1", [id]));
    expect(co).toEqual({ status: "active", mode: "ghost", sms_enabled: false, contract_value_default: "9000.00" });
    expect(await asOperator((c) => many(c, "select 1 from workflows where company_id=$1 and enabled", [id]))).toEqual([]);
    expect(await asOperator((c) => one(c, "select role from users where company_id=$1 and email='carly@install.co'", [id]))).toEqual({ role: "closer" });
    expect(await asOperator((c) => one(c, "select count(*)::int as n from workflows where company_id=$1 and diverged", [id]))).toEqual({ n: 9 });   // the one-board copies
    expect((await asOperator((c) => onboardingState(c, "install-co")))!.steps.find((x) => x.id === "install")!.done).toMatchObject({ by: "test" });
    const versions = await asOperator((c) => many(c, "select name, current_version from workflows where company_id=$1 order by name", [id]));
    expect(await runInstall(asOperator, id, "install-co", adapters, "test")).toMatchObject({ ok: true });
    expect(await asOperator((c) => many(c, "select name, current_version from workflows where company_id=$1 order by name", [id]))).toEqual(versions);
  });
});
