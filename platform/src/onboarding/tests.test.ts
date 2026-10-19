/**
 * D179: the test passes. Refused before install and without a test contact; then the offer's workflows go on (the fit report's off
 * ones stay off), the company stands in ghost, each scenario runs on the test contact and its runs are read back; the step is done
 * once every workflow turned on has a clean run or is accepted with a note, and undone when a re-run fails.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { fakeAdapters } from "@/engine/test-install";
import { fakeGhl, LOC } from "@/adapters/ghl/fake-ghl";
import { crmInput, runCrm, saveCrm } from "@/onboarding/crm";
import { createClient, onboardingState, saveIntake } from "@/onboarding/store";
import { runInstall } from "@/onboarding/install";
import { acceptWorkflow, prepareTests, runScenario, testsState, testsTodo, workflowStates, type Tests } from "@/onboarding/tests";
import type { Intake } from "@/onboarding/intake";
import type { Research } from "@/onboarding/research";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const intake: Intake = { business: "Tests Co", price: "9000", deposits: true, payment_plans: false, lead_paths: ["ads_direct_book"], application: "none", setters: false, triage: false, boards: "one",
  journey: "Ads, they book, the closer closes.", crm: "ghl", booking: "ghl", payments: "whop", recording: "none", agreement: "ghl_documents" };
const research: Research = { at: "2026-10-18T00:00:00Z", source: "ghl", calendars: [{ id: "CAL", name: "Closer", teamMemberIds: [] }, { id: "OLD", name: "Old", teamMemberIds: [] }],
  users: [{ id: "u1", name: "Carly Vu", email: "carly@tests.co" }, { id: "u2", name: "Ops", email: "ops@tests.co" }], pipelines: [], objects: [], workflows: [], errors: [], proposal: null,
  answers: { calendars: { CAL: { call_type: "closing", booking: "self" }, OLD: { call_type: "ignore" } }, closerCall: "CAL", team: { u1: "closer", u2: "manager" } }, done: { at: "2026-10-18T00:00:00Z", by: "t" } };
const done = (steps: string[]) => JSON.stringify(Object.fromEntries(steps.map((s) => [s, { done_at: "2026-10-18T00:00:00Z", by: "t" }])));

describe.skipIf(!process.env.DATABASE_URL)("D179: the test passes", () => {
  let id: string;
  const adapters = fakeAdapters();
  adapters.read.listUsers = async () => [{ id: "u1", name: "Carly Vu", email: "carly@tests.co" }, { id: "u2", name: "Ops", email: "ops@tests.co" }];
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => { const co = await one<{ id: string }>(c, "select id from companies where slug='tests-co'"); if (!co) return;
      // test passes leave rows in many tables (runs, steps, records, payments, cards): every table with a company_id, emptied in whatever order its foreign keys allow
      await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]);
      await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
      let left = (await many<{ t: string }>(c, "select table_name as t from information_schema.columns where column_name='company_id' and table_schema='public' and table_name not in ('companies')")).map((r) => r.t);
      for (let pass = 0; left.length && pass < 12; pass++) {
        const still: string[] = [];
        for (const t of left) { await c.query("savepoint d"); try { await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("release savepoint d"); } catch { await c.query("rollback to savepoint d"); still.push(t); } }
        left = still;
      }
      await c.query("delete from companies where id=$1", [co.id]); });
    id = (await asOperator((c) => createClient(c, { name: "Tests Co", timezone: "America/New_York" })) as { id: string }).id;
    await asOperator((c) => saveIntake(c, id, { intake }));
    await asOperator(async (c) => {
      for (const [k, kind, v] of [["crm.location_id", "id", LOC], ["secret.ghl_pit", "secret", "pit-x"]] as const) await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4)", [id, k, kind, kind === "secret" ? encrypt(v) : Buffer.from(v)]);
      await c.query("update onboarding set research=$2, steps = steps || $3::jsonb where company_id=$1", [id, research, done(["connections", "research"])]);
    });
  });

  let contactId: string;
  const stepDone = async () => (await asOperator((c) => onboardingState(c, "tests-co")))!.steps.find((x) => x.id === "test")!.done;

  it("is refused before install, and without a test contact", async () => {
    expect(await prepareTests(asOperator, id, {})).toMatchObject({ ok: false, status: 409, why: expect.stringContaining("install first") });
    const input = await asOperator((c) => crmInput(c, id)); if (!input.ok) throw new Error(input.why);
    await asOperator(async (c) => saveCrm(c, id, await runCrm(input.input, true, fakeGhl().http)));
    await asOperator((c) => c.query("update onboarding set steps = steps || $2::jsonb where company_id=$1", [id, done(["slack"])]));
    expect(await runInstall(asOperator, id, "tests-co", adapters, "test")).toMatchObject({ ok: true });
    expect(await prepareTests(asOperator, id, {})).toMatchObject({ ok: false, status: 422, why: expect.stringContaining("tagged sys-test") });
    const real = await asOperator(async (c) => (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'c-real','Real','Person') returning id", [id]))!.id);
    expect(await prepareTests(asOperator, id, { contactId: real })).toMatchObject({ ok: false, status: 422, why: expect.stringContaining("not a test contact") });
    expect(await prepareTests(asOperator, id, { rung: "live" })).toMatchObject({ ok: false, status: 400 });
    contactId = await asOperator(async (c) => {
      const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, tags) values ($1,'c-test','Tess','Tester','{sys-test}') returning id", [id]))!.id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','tess@tests.co')", [id, ct]);
      return ct;
    });
    // the messages are not approved: the test rung (real sends to the test contact) waits for them; ghost does not
    expect(await prepareTests(asOperator, id, { contactId, rung: "test" })).toMatchObject({ ok: false, status: 409, why: expect.stringContaining("approve the messages") });
  });

  it("turns on the offer's workflows (recording none: its two stay off) and keeps the company in ghost", async () => {
    let r = await prepareTests(asOperator, id, { contactId, rung: "ghost" });
    if (!r.ok) throw new Error(r.why);
    // a workflow the offer uses but cannot run yet blocks the step, named with what it misses; one the fit report has off does not
    expect(r.left_off).toEqual(expect.arrayContaining([{ name: "Sales call recorded", why: "calls are not recorded", blocking: false }, { name: "Setter call logged", why: "no setters", blocking: false },
      { name: "Payment recorded", why: "missing crm.agreement_template", blocking: true }, { name: "Deal closed", why: "missing secret.anthropic_key", blocking: true }]));
    expect((await asOperator((c) => testsState(c, id)))!.todo).toContain("Deal closed is off: missing secret.anthropic_key; set it, then turn the workflows on again");
    await asOperator(async (c) => {
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'crm.agreement_template','id',$2)", [id, Buffer.from("tmpl-1")]);
      await c.query("insert into bindings (company_id, key, kind, value) values ($1,'secret.anthropic_key','secret',$2)", [id, encrypt("sk-test")]);
    });
    r = await prepareTests(asOperator, id, { rung: "ghost" });   // the contact chosen before is kept
    if (!r.ok) throw new Error(r.why);
    expect(r.left_off.filter((x) => x.blocking)).toEqual([]);
    const on = await asOperator((c) => many<{ name: string }>(c, "select name from workflows where company_id=$1 and enabled order by name", [id]));
    expect(on.map((w) => w.name).sort()).toEqual([...r.on].sort());
    expect(on.map((w) => w.name)).not.toContain("Sales call recorded");
    expect(await asOperator((c) => one(c, "select mode from companies where id=$1", [id]))).toEqual({ mode: "ghost" });
    const s = (await asOperator((c) => testsState(c, id)))!;
    expect(s.contacts.map((x) => x.id)).toEqual([contactId]);
    expect(s.scenarios.map((x) => x.id)).toEqual(["lead", "won", "deposit", "noshow", "cancel", "reschedule", "scheduled"]);   // no setters, no application form
    expect(s.scenarios.find((x) => x.id === "won")!.acts.map((a) => a.action)).toEqual(["book-self", "outcome", "pay", "agreement", "sign"]);   // not recorded
    expect(s.done).toBe(false);
  });

  it("runs a journey on the test contact and reads back every run it started", async () => {
    const r = await runScenario(asOperator, adapters, id, "cancel", "test");
    if (!r.ok) throw new Error(r.why);
    expect(r.result.acts).toEqual([{ action: "book-self", ok: true, runs: expect.any(Number) }, { action: "cancel", ok: true, runs: expect.any(Number) }]);
    expect(r.result.runs.length).toBeGreaterThan(0);
    expect(r.result.runs.map((x) => x.workflow)).toEqual(expect.arrayContaining(["Call booked"]));
    expect(r.result.rung).toBe("ghost");
    const again = await runScenario(asOperator, adapters, id, "cancel", "test");   // reset first: the same journey again is the contact's first time through
    if (!again.ok) throw new Error(again.why);
    expect(again.result.runs.map((x) => x.workflow).sort()).toEqual(r.result.runs.map((x) => x.workflow).sort());
    expect(await runScenario(asOperator, adapters, id, "setter-call", "test")).toMatchObject({ ok: false, status: 400 });   // no setters, no such journey
  });

  it("is done once every workflow turned on is clean or accepted, and undone when one fails", async () => {
    // "scheduled" is left out here: the leaderboard and wrap-ups read GHL over HTTP, which the fake adapters do not stand in for
    for (const s of ["lead", "won", "deposit", "noshow", "reschedule"]) { const r = await runScenario(asOperator, adapters, id, s, "test"); if (!r.ok) throw new Error(`${s}: ${r.why}`); }
    let st = (await asOperator((c) => testsState(c, id)))!;
    expect(st.todo).toContain('run "Scheduled workflows"');
    await asOperator((c) => c.query("update onboarding set tests = jsonb_set(tests, '{results,scheduled}', $2::jsonb) where company_id=$1", [id, JSON.stringify({ at: "2026-10-19T00:00:00Z", by: "test", rung: "ghost", acts: [], runs: [], passed: true })]));
    const stopped = Object.entries(st.tests.results!).filter(([, x]) => x.acts.some((a) => !a.ok));
    expect(stopped).toEqual([]);
    for (const w of st.workflows.filter((x) => x.state === "not reached")) expect(await asOperator((c) => acceptWorkflow(c, id, { workflow: w.name, note: "checked by hand", by: "test" }))).toEqual({ ok: true });
    expect(await asOperator((c) => acceptWorkflow(c, id, { workflow: "Sales call recorded", note: "x" }))).toMatchObject({ ok: false, status: 400 });   // not turned on
    st = (await asOperator((c) => testsState(c, id)))!;
    expect(st.workflows.filter((x) => x.state === "failing")).toEqual([]);
    expect(st.todo).toEqual([]);
    expect(await stepDone()).toMatchObject({ by: "tests" });
    // a step that now fails: the re-run says so and the step is no longer done
    await asOperator((c) => c.query("insert into run_steps (run_id, node_id, node_type, status, error) select id, 'x', 'add_tag', 'failed', 'GHL said no' from runs where company_id=$1 and contact_id=$2 limit 1", [id, contactId]));
    const t = st.tests; const name = Object.values(t.results!).flatMap((x) => x.runs)[0].workflow;
    const failed: Tests = { ...t, results: { ...t.results, lead: { ...t.results!.lead, runs: [{ workflow: name, status: "failed", exit_reason: null, steps: 1, problem: "x (add_tag): GHL said no" }] } } };
    expect(workflowStates(failed).find((w) => w.name === name)).toMatchObject({ state: "failing", problems: ["x (add_tag): GHL said no"] });
    expect(testsTodo(failed, st.scenarios)).toContain(`${name}: x (add_tag): GHL said no`);
    await asOperator((c) => c.query("update onboarding set tests=$2 where company_id=$1", [id, JSON.stringify(failed)]));
    expect(await asOperator((c) => acceptWorkflow(c, id, { workflow: name, note: "", by: "test" }))).toEqual({ ok: true });   // any change re-reads the results
    expect(await stepDone()).toBeNull();
  });
});
