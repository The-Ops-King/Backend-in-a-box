/**
 * D161: a template business tested in the sandbox, by Claude through the admin API (`/api/admin/templates/test`), never through the
 * onboarding wizard: Tyler (2026-10-19) "the wizard is for onboarding new things only; you make the test". The steps a client's
 * wizard takes are taken here in code, with what the wizard asks Tyler answered from the deployment's settings (env, below) and
 * from the sandbox itself: its GHL key, its calendars and team (the first closing-looking calendar is the closer call, the first
 * user the closer, the next a setter where the playbook has setters), one Slack channel in Tyler's ops Slack for every post, the
 * playbook's GHL build under its own prefix (so every template business can share the one sub-account), the install, the test
 * contact (his own email, so the send lock lets its sends through; the template businesses share it, one runs at a time), and the test rung. Then each journey is run with `run` (one per call: a journey ticks the
 * company between its steps) and `status` says what publish still needs (`untested`).
 *
 * Settings, kept in the deployment's environment so no key passes through a conversation:
 *   SANDBOX_LOCATION_ID, SANDBOX_GHL_PIT       the snapshot sub-account
 *   SANDBOX_SLACK_BOT_TOKEN, SANDBOX_SLACK_SIGNING_SECRET, SANDBOX_SLACK_CHANNEL   Tyler's ops Slack app and its test channel
 *   SANDBOX_TEST_EMAIL                         the test contact's email, as the send lock knows it (jt@jtylerray.com)
 *   SANDBOX_AGREEMENT_TEMPLATE                 a GHL document template in the sub-account (optional: without it the
 *                                              agreement workflows stay off and the tests say so)
 *   ANTHROPIC_API_KEY                          (already set) for the workflows that ask the model
 */
import type { PoolClient } from "pg";
import { asOperator, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { encrypt } from "@/engine/crypto";
import { connect } from "@/onboarding/connections";
import { gather, researchInput, saveResearch, saveResearchAnswers, type Research, type ResearchAnswers } from "@/onboarding/research";
import { connectSlack, saveChannels, CHANNEL_SLOTS } from "@/onboarding/slack";
import { crmInput, runCrm, saveCrm, saveCrmOptions } from "@/onboarding/crm";
import { runInstall } from "@/onboarding/install";
import { readTheirWorkflows, isOn } from "@/onboarding/filters";
import { createTestContact } from "@/onboarding/test-contact";
import { prepareTests, runScenario, testsState, type ScenarioResult } from "@/onboarding/tests";
import { TEST_CHANNEL_KEY } from "@/engine/mode";
import { playbookOf } from "./index";
import { ensureTemplateBusiness, templateSlug, untested } from "./template-business";

type Op = <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;
export type Step = { step: string; ok: boolean; detail: string };
export type SandboxEnv = { locationId?: string; pit?: string; slackToken?: string; slackSecret?: string; slackChannel?: string; testEmail?: string; agreementTemplate?: string; anthropicKey?: string };
export const sandboxEnv = (e: NodeJS.ProcessEnv = process.env): SandboxEnv => ({
  locationId: e.SANDBOX_LOCATION_ID, pit: e.SANDBOX_GHL_PIT, slackToken: e.SANDBOX_SLACK_BOT_TOKEN, slackSecret: e.SANDBOX_SLACK_SIGNING_SECRET,
  slackChannel: e.SANDBOX_SLACK_CHANNEL, testEmail: e.SANDBOX_TEST_EMAIL, agreementTemplate: e.SANDBOX_AGREEMENT_TEMPLATE, anthropicKey: e.ANTHROPIC_API_KEY,
});
const NEEDED: [keyof SandboxEnv, string][] = [["locationId", "SANDBOX_LOCATION_ID"], ["pit", "SANDBOX_GHL_PIT"], ["slackToken", "SANDBOX_SLACK_BOT_TOKEN"], ["slackSecret", "SANDBOX_SLACK_SIGNING_SECRET"], ["slackChannel", "SANDBOX_SLACK_CHANNEL"], ["testEmail", "SANDBOX_TEST_EMAIL"]];

/**
 * The wizard's research answers, made from the sandbox: each calendar a closing call (one named "triage" the qualifying "Triage
 * call" where the playbook has one), the first closing one the closer call and booking link; the first user the closer, the next a setter
 * where the playbook has setters, the rest staff. `given` (from the call) wins wherever it says something.
 */
export function sandboxAnswers(r: Research, playbook: string, given?: Partial<ResearchAnswers>): ResearchAnswers {
  const t = playbookOf(playbook).traits, calendars: ResearchAnswers["calendars"] = {};
  for (const k of r.calendars) calendars[k.id] = t.triage && /triage/i.test(k.name) ? { call_type: "qualifying", name: "Triage call", booking: "self" } : { call_type: "closing", booking: t.booking.includes("setter") ? "question" : "self" };
  const closing = r.calendars.find((k) => calendars[k.id].call_type === "closing")?.id;
  const team: ResearchAnswers["team"] = {};
  r.users.forEach((u, i) => { team[u.id] = i === 0 ? "closer" : i === 1 && t.booking.includes("setter") ? "setter" : "staff"; });
  return { calendars: { ...calendars, ...(given?.calendars ?? {}) }, closerCall: given?.closerCall ?? closing, bookingCalendar: given?.bookingCalendar ?? closing, team: { ...team, ...(given?.team ?? {}) } };
}

const setText = (c: PoolClient, companyId: string, key: string, kind: string, value: Buffer) =>
  c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4) on conflict (company_id, key) do update set kind=excluded.kind, value=excluded.value, updated_at=now()", [companyId, key, kind, value]);

/**
 * Every step up to the test rung, in order, stopping at the first that fails (each says why). Safe to run again: each step is
 * idempotent, and what the sandbox already has is found, not made twice.
 */
export async function setupSandbox(op: Op, adapters: Adapters, playbook: string, args: { answers?: Partial<ResearchAnswers>; env?: SandboxEnv } = {}): Promise<{ ok: boolean; slug: string; steps: Step[] }> {
  const env = args.env ?? sandboxEnv(), slug = templateSlug(playbook), steps: Step[] = [];
  const step = (s: string, ok: boolean, detail: string) => { steps.push({ step: s, ok, detail }); return ok; };
  const done = (ok = false) => ({ ok, slug, steps });
  const missing = NEEDED.filter(([k]) => !env[k]).map(([, name]) => name);
  if (!step("settings", !missing.length, missing.length ? `set in the deployment's environment: ${missing.join(", ")}` : "the sandbox's settings are there")) return done();
  const tb = await op((c) => ensureTemplateBusiness(c, playbook, "sandbox"));
  if (!tb.ok) { step("template business", false, tb.why); return done(); }
  const id = tb.id;
  step("template business", true, tb.created ? `made ${slug}` : slug);

  const g = await op((c) => connect(c, id, { id: "ghl", values: { locationId: env.locationId, pit: env.pit }, by: "sandbox" }));
  if (!step("GHL", g.ok, g.ok ? "the snapshot sub-account answered" : g.why)) return done();

  const ri = await op((c) => researchInput(c, id));
  if (!ri.ok) { step("research", false, ri.why); return done(); }
  const research = await gather(ri.input);
  await op((c) => saveResearch(c, id, research));
  if (!research.calendars.length) { step("research", false, "the sandbox has no calendar: make one in the snapshot sub-account (it books the closer call)"); return done(); }
  if (!research.users.length) { step("research", false, "the sandbox has no user to close: add one to the snapshot sub-account"); return done(); }
  const ra = await op((c) => saveResearchAnswers(c, id, sandboxAnswers(research, playbook, args.answers), "sandbox"));
  if (!step("research", ra.ok, ra.ok ? `${research.calendars.length} calendar(s), ${research.users.length} user(s) mapped` : `${ra.why}: ${(ra.problems ?? []).join("; ")}`)) return done();

  const sl = await op(async (c) => {
    const k = await connectSlack(c, id, { token: env.slackToken, signingSecret: env.slackSecret, by: "sandbox" });
    if (!k.ok) return k;
    await setText(c, id, TEST_CHANNEL_KEY, "channel", Buffer.from(env.slackChannel!));
    return saveChannels(c, id, Object.fromEntries(CHANNEL_SLOTS.map((s) => [s.key, env.slackChannel])), "sandbox");
  });
  if (!step("Slack", sl.ok, sl.ok ? `every post to ${env.slackChannel}` : sl.why)) return done();

  const pb = playbookOf(playbook);
  const opt = await op((c) => saveCrmOptions(c, id, { prefix: `T ${pb.name}`.slice(0, 30) }));
  if (!opt.ok) { step("CRM build", false, opt.why); return done(); }
  const ci = await op((c) => crmInput(c, id));
  if (!ci.ok) { step("CRM build", false, ci.why); return done(); }
  const run = await runCrm(ci.input, true);
  await op((c) => saveCrm(c, id, run, "sandbox"));
  if (!step("CRM build", !run.error, run.error ? `GHL: ${run.error}` : `the ${pb.name} pipelines and fields, prefixed "T ${pb.name}"`)) return done();

  await op(async (c) => {
    if (env.agreementTemplate) await setText(c, id, "crm.agreement_template", "id", Buffer.from(env.agreementTemplate));
    if (env.anthropicKey && !(await one(c, "select 1 from bindings where company_id=$1 and key='secret.anthropic_key'", [id]))) await setText(c, id, "secret.anthropic_key", "secret", encrypt(env.anthropicKey));
  });
  const inst = await runInstall(op, id, slug, adapters, "sandbox");
  if (!step("install", inst.ok, inst.ok ? `${inst.installed.length} workflow(s), every one off` : inst.why)) return done();

  // the sandbox's own GHL workflows would see the test contact: said, not gated (it is Tyler's own account)
  const theirs = await readTheirWorkflows(op, id);
  const on = theirs.ok ? theirs.list.filter((w) => isOn(w.status)) : [];
  step("sandbox workflows", true, !theirs.ok ? `could not list them: ${theirs.why}` : on.length ? `published in the sandbox, and they will see the test contact: ${on.map((w) => w.name).join(", ")}` : "none published");

  const tc = await createTestContact(op, adapters, id, { email: env.testEmail, by: "sandbox" });
  if (!step("test contact", tc.ok, tc.ok ? `${tc.email} (${tc.created ? "made" : "found"})` : tc.why)) return done();

  const pr = await prepareTests(op, id, { contactId: tc.ok ? tc.id : undefined, rung: "test", by: "sandbox" });
  if (!step("test rung", pr.ok, pr.ok ? `${pr.on.length} workflow(s) on${pr.left_off.length ? `; off: ${pr.left_off.map((w) => `${w.name} (${w.why})`).join("; ")}` : ""}` : pr.why)) return done();
  return done(true);
}

/** One journey on the template business's test contact. */
export async function runSandboxJourney(op: Op, adapters: Adapters, playbook: string, scenario: string): Promise<{ ok: true; result: ScenarioResult } | { ok: false; status: number; why: string }> {
  const co = await op((c) => one<{ id: string }>(c, "select id from companies where slug=$1 and status='template'", [templateSlug(playbook)]));
  if (!co) return { ok: false, status: 404, why: "set it up first (setup)" };
  return runScenario(op, adapters, co.id, scenario, "sandbox");
}

/** Where the template business's tests stand: each journey, each workflow, and what publish still needs. */
export async function sandboxStatus(playbook: string) {
  return asOperator(async (c) => {
    const co = await one<{ id: string; mode: string }>(c, "select id, mode from companies where slug=$1 and status='template'", [templateSlug(playbook)]);
    if (!co) return null;
    const s = await testsState(c, co.id);
    return { slug: templateSlug(playbook), mode: co.mode, sandbox: s?.sandbox, journeys: s?.scenarios.map((x) => ({ id: x.id, label: x.label, result: s.tests.results?.[x.id] ?? null })), workflows: s?.workflows, todo: s?.todo, publish_needs: await untested(c, co.id) };
  });
}
