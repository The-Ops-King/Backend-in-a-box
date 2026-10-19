/**
 * D151 (#49 P1): the wizard's test passes. Each scenario is a sales journey the offer has (a lead, a self-booked call that shows
 * and closes, a no-show, a cancel, a reschedule, a setter's dial, a deposit, an application), staged on one test contact through
 * the harness (D23: the fact is ours, source 'test'; only a test contact, D97), the company's runs then ticked, and every run it
 * started read back: its workflow, how it ended, the step that failed. Scheduled workflows are fired by hand. A scenario starts
 * with `reset`, so each one is the contact's first time through.
 *
 * Before the passes, the workflows the offer uses are turned on (the fit report's off and build ones stay off, as does any
 * missing a required setting), and the company stands on the rung Tyler picks: ghost (nothing written anywhere, every run says
 * what it would do) or test (the test contact's runs really write and send; anyone else's stay ghost). A takeover's test rung is
 * confirmed first: their own GHL workflows see the test contact's tags and stage moves (step 9 filters them).
 *
 * The step is done when every workflow turned on has a clean run (completed, exited or waiting, no failed or paused step) and none
 * failed, or Tyler has accepted it with a note (a workflow no scenario reaches: a payment that fails, a recording with no match).
 * Re-running a scenario replaces its result, so a fix clears what it fixed; the step's done mark follows the results both ways.
 */
import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { loadCompany } from "@/engine/context";
import { simulate, type SimAction } from "@/engine/simulate";
import { tick } from "@/engine/runner";
import { fireNow } from "@/engine/clock";
import { parseDefinition } from "@/engine/definition";
import { companyReadiness } from "@/engine/readiness";
import { setCompanyMode } from "@/engine/golive";
import { testContactSql, TEST_DOMAINS_KEY, TEST_TAG, testDomains } from "@/engine/mode";
import { loadEodForm } from "@/engine/eod";
import { valueFor } from "@/engine/eod-form";
import type { FitReport, Intake } from "./intake";

type Op = <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;
export type TestRung = "ghost" | "test";
type Act = { action: SimAction; startsAt?: "past" | "future"; outcome?: string; deposit?: boolean; calendar?: string };
export type Scenario = { id: string; label: string; about: string; acts: Act[] };
export type RunSeen = { workflow: string; status: string; exit_reason: string | null; steps: number; problem: string | null };
export type ScenarioResult = { at: string; by: string; rung: string; acts: { action: SimAction; ok: boolean; why?: string; runs: number }[]; runs: RunSeen[]; passed: boolean };
export type Tests = { contact?: { id: string; name: string }; prepared?: { at: string; by: string; rung: TestRung; on: string[]; left_off: LeftOff[] }; results?: Record<string, ScenarioResult>; accepted?: Record<string, { note: string; at: string; by: string }> };
/** A workflow not turned on: `blocking` when the offer uses it but it cannot run yet (a missing setting), not when the fit report has it off. */
export type LeftOff = { name: string; why: string; blocking: boolean };
export type WorkflowState = { name: string; state: "clean" | "failing" | "not reached" | "accepted"; clean: number; problems: string[]; note?: string };

/** The journeys this offer has, from its answers and the company's end-of-day form. */
export async function scenariosFor(c: PoolClient, companyId: string, intake: Intake): Promise<Scenario[]> {
  const fields = await loadEodForm(c, companyId);
  const closed = valueFor(fields, { call_outcome: "closed" }), deposit = valueFor(fields, { call_outcome: "deposit" }), noShow = valueFor(fields, { attendance: "noshow" });
  const paid = intake.payments !== "none", recorded = intake.recording !== "none", signed = intake.agreement === "ghl_documents", setters = intake.setters === true;
  const out: Scenario[] = [{ id: "lead", label: "New lead", about: "a lead lands in the CRM", acts: [{ action: "create" }] }];
  if (intake.application === "typeform") out.push({ id: "application", label: "Application", about: "they apply through the mapped form", acts: [{ action: "form" }] });
  if (closed) out.push({ id: "won", label: "Books, shows, closes", about: `books themselves, the call happens${recorded ? " and is recorded" : ""}, the closer files it closed${paid ? ", they pay" : ""}${signed ? ", they sign" : ""}`,
    acts: [{ action: "book-self", startsAt: "past" }, ...(recorded ? [{ action: "record" } as Act] : []), { action: "outcome", outcome: closed }, ...(paid ? [{ action: "pay" } as Act] : []), ...(signed ? [{ action: "agreement" } as Act, { action: "sign" } as Act] : [])] });
  if (intake.deposits === true && deposit && paid) out.push({ id: "deposit", label: "Deposit", about: "the closer files a deposit and it is paid", acts: [{ action: "book-self", startsAt: "past" }, { action: "outcome", outcome: deposit }, { action: "pay", deposit: true }] });
  if (noShow) out.push({ id: "noshow", label: "No-show", about: `${setters ? "a setter books the call" : "they book"}, they do not show, the closer files it`, acts: [{ action: setters ? "book" : "book-self", startsAt: "past" }, { action: "outcome", outcome: noShow }] });
  out.push({ id: "cancel", label: "Cancels", about: "they book, then cancel before the call", acts: [{ action: "book-self", startsAt: "future" }, { action: "cancel" }] });
  out.push({ id: "reschedule", label: "Reschedules", about: "they book, then move the call", acts: [{ action: "book-self", startsAt: "future" }, { action: "reschedule" }] });
  if (setters) out.push({ id: "setter-call", label: "Setter's dial", about: "a setter's connected call, transcribed and classified", acts: [{ action: "call" }] });
  out.push({ id: "scheduled", label: "Scheduled workflows", about: "every scheduled workflow turned on, fired now (end of day, wrap-ups, sweeps)", acts: [] });
  return out;
}

/** The candidates: contacts that pass as the team's own test contact (tagged sys-test, or an email on a test domain). */
export async function testContacts(c: PoolClient, companyId: string): Promise<{ id: string; name: string; email: string | null }[]> {
  const domains = testDomains({ [TEST_DOMAINS_KEY]: (await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key=$2", [companyId, TEST_DOMAINS_KEY]))?.value.toString("utf8") ?? "" });
  return many(c, `select ct.id, coalesce(nullif(trim(coalesce(ct.first_name,'') || ' ' || coalesce(ct.last_name,'')), ''), 'Unnamed') as name,
    (select value from contact_identifiers i where i.contact_id=ct.id and i.kind='email' and i.retired_at is null order by created_at limit 1) as email
    from contacts ct where ct.company_id=$1 and ${testContactSql("ct", "$2")} order by ct.created_at desc limit 20`, [companyId, domains]);
}

async function loadTests(c: PoolClient, companyId: string) {
  return one<{ tests: Tests; intake: Intake; fit: FitReport | null; kind: "new" | "takeover"; steps: Record<string, unknown>; slug: string }>(c,
    "select o.tests, o.intake, o.fit, o.kind, o.steps, co.slug from onboarding o join companies co on co.id=o.company_id where o.company_id=$1", [companyId]);
}
const saveTests = (c: PoolClient, companyId: string, t: Tests) => c.query("update onboarding set tests=$2 where company_id=$1", [companyId, JSON.stringify(t)]);

/** The workflows the offer uses: installed, and not off or still to build in the fit report. */
async function inScope(c: PoolClient, companyId: string, fit: FitReport | null) {
  const skip = new Map((fit?.workflows ?? []).filter((w) => w.fit === "off" || w.fit === "build").map((w) => [w.slug, w.why]));
  const rows = await many<{ id: string; name: string; slug: string | null; enabled: boolean }>(c, "select w.id, w.name, t.slug, w.enabled from workflows w left join workflow_templates t on t.id=w.template_id where w.company_id=$1 order by w.stage nulls last, w.sort, w.name", [companyId]);
  return { use: rows.filter((r) => !r.slug || !skip.has(r.slug)), skipped: rows.filter((r) => r.slug && skip.has(r.slug)).map((r): LeftOff => ({ name: r.name, why: skip.get(r.slug!)!, blocking: false })) };
}

export type PrepareResult = { ok: true; on: string[]; left_off: LeftOff[] } | { ok: false; status: number; why: string };

/**
 * The test contact chosen, the offer's workflows turned on (in one transaction), then the company onto the rung (its own, as the
 * mode route does). Refused before install, for a contact that is not a test contact, and for a takeover's test rung unconfirmed.
 */
export async function prepareTests(op: Op, companyId: string, args: { contactId?: unknown; rung?: unknown; confirm?: unknown; by?: string }): Promise<PrepareResult> {
  const rung: TestRung | null = args.rung === "test" ? "test" : args.rung === undefined || args.rung === "ghost" ? "ghost" : null;
  if (!rung) return { ok: false, status: 400, why: "rung is ghost or test" };
  const first = await op(async (c) => {
    const o = await loadTests(c, companyId);
    if (!o) return { ok: false as const, status: 404, why: "this company is not being onboarded" };
    if (!o.steps.install) return { ok: false as const, status: 409, why: "install first: the workflows are not there yet" };
    if (rung === "test" && !o.steps.messages) return { ok: false as const, status: 409, why: "approve the messages first: on the test rung they are really sent to the test contact" };
    const co = (await one<{ mode: string }>(c, "select mode from companies where id=$1", [companyId]))!;
    if (co.mode !== "ghost" && co.mode !== "test") return { ok: false as const, status: 409, why: `the company is ${co.mode}: test passes run in ghost or test, before go-live` };
    if (rung === "test" && o.kind === "takeover" && args.confirm !== true) return { ok: false as const, status: 409, why: `on the test rung the test contact's tags and stage moves are real, and their own GHL workflows see them: confirm the test contact is filtered out of their automations (step 9), or that what reaches it is harmless` };
    const pick = typeof args.contactId === "string" ? args.contactId : o.tests.contact?.id;
    const contact = pick ? (await testContacts(c, companyId)).find((x) => x.id === pick) : undefined;
    if (!contact) return { ok: false as const, status: 422, why: pick ? "that contact is not a test contact: tag them sys-test in GHL, or give them an email on a test domain" : `choose a test contact: make one in their GHL tagged ${TEST_TAG} (the engine reads it within a minute)` };
    const { use, skipped } = await inScope(c, companyId, o.fit);
    const ready = await companyReadiness(c, companyId, `/app/c/${o.slug}`);
    const left_off = [...skipped], on: string[] = [];
    for (const w of use) {
      const r = ready.workflows.find((x) => x.id === w.id);
      if (r?.parseError) { left_off.push({ name: w.name, why: r.parseError, blocking: true }); continue; }
      if (r?.missing.length) { left_off.push({ name: w.name, why: `missing ${r.missing.join(", ")}`, blocking: true }); continue; }
      if (!w.enabled) {
        await c.query("update workflows set enabled=true where id=$1", [w.id]);
        await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'workflow.enabled','workflow',$2,$3,$4)", [companyId, w.id, { enabled: false }, { enabled: true, via: "onboarding.tests", by: args.by ?? "dashboard" }]);
      }
      on.push(w.name);
    }
    const tests: Tests = { ...o.tests, contact: { id: contact.id, name: contact.name }, prepared: { at: new Date().toISOString(), by: args.by ?? "dashboard", rung, on, left_off } };
    await saveTests(c, companyId, tests);
    return { ok: true as const, on, left_off, slug: o.slug };
  });
  if (!first.ok) return first;
  const m = await op((c) => setCompanyMode(c, companyId, rung, `/app/c/${first.slug}`, "onboarding.tests"));
  if (!m.ok) return { ok: false, status: 409, why: `the workflows are on, but the company could not go ${rung}: ${m.blockers.map((b) => b.text).join(" ")}` };
  await op((c) => syncDone(c, companyId));
  return { ok: true, on: first.on, left_off: first.left_off };
}

/** What a run did, in a line: the failed or paused step and its error, a step still retrying, or nothing. */
async function runsSince(c: PoolClient, companyId: string, where: { contactId?: string; ids?: string[] }, since: Date): Promise<RunSeen[]> {
  const rows = await many<{ id: string; workflow: string; status: string; exit_reason: string | null; step_error: string | null; current_node: string | null; steps: number; bad: string | null }>(c,
    `select r.id, w.name as workflow, r.status, r.exit_reason, r.step_error, r.current_node,
       (select count(*)::int from run_steps s where s.run_id=r.id) as steps,
       (select s.node_id || ' (' || s.node_type || '): ' || coalesce(s.error, s.status) from run_steps s where s.run_id=r.id and s.status in ('failed','paused') order by s.started_at desc limit 1) as bad
     from runs r join workflows w on w.id=r.workflow_id where r.company_id=$1 and r.started_at >= $2 and (r.contact_id=$3 or r.id = any($4::uuid[])) order by r.started_at, w.name`,
    [companyId, since, where.contactId ?? null, where.ids ?? []]);
  return rows.map((r) => ({ workflow: r.workflow, status: r.status, exit_reason: r.exit_reason, steps: r.steps,
    problem: r.bad ?? (r.status === "failed" || r.status === "paused" ? `${r.status} at ${r.current_node ?? "?"}${r.step_error ? `: ${r.step_error}` : ""}` : r.step_error ? `retrying ${r.current_node ?? "?"}: ${r.step_error}` : null) }));
}

export type RunResult = { ok: true; result: ScenarioResult } | { ok: false; status: number; why: string };

/** One scenario on the chosen test contact: reset, each act in its own transaction with the company ticked after it, the runs read back. */
export async function runScenario(op: Op, adapters: Adapters, companyId: string, scenarioId: string, by = "dashboard"): Promise<RunResult> {
  const pre = await op(async (c) => {
    const o = await loadTests(c, companyId);
    if (!o) return { ok: false as const, status: 404, why: "this company is not being onboarded" };
    if (!o.tests.prepared || !o.tests.contact) return { ok: false as const, status: 409, why: "turn the workflows on and choose the test contact first" };
    const s = (await scenariosFor(c, companyId, o.intake)).find((x) => x.id === scenarioId);
    if (!s) return { ok: false as const, status: 400, why: `no scenario "${scenarioId}" for this offer` };
    const tz = (await one<{ timezone: string }>(c, "select timezone from companies where id=$1", [companyId]))!.timezone;
    return { ok: true as const, s, contactId: o.tests.contact.id, tz };
  });
  if (!pre.ok) return pre;
  const since = new Date(Date.now() - 1000), acts: ScenarioResult["acts"] = [];
  let fired: string[] = [];
  const settle = async () => { await tick(adapters, DateTime.now(), companyId); };
  if (pre.s.id === "scheduled") {
    const ids = await op(async (c) => {
      const rows = await many<{ id: string; definition: unknown }>(c, "select w.id, v.definition from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1 and w.enabled order by w.name", [companyId]);
      const out: string[] = [];
      for (const r of rows) { let def; try { def = parseDefinition(r.definition); } catch { continue; } if (def.nodes.some((n) => n.type === "trigger" && n.schedule)) out.push(...(await fireNow(c, companyId, r.id)).started); }
      return out;
    });
    fired = ids;
    await settle();
  } else {
    const reset = await op(async (c) => simulate({ c, company: (await loadCompany(c, companyId)).row, contactId: pre.contactId }, "reset"));
    if (!reset.ok) return { ok: false, status: 409, why: reset.why };
    for (const a of pre.s.acts) {
      const startsAt = a.startsAt === "past" ? DateTime.now().setZone(pre.tz).minus({ minutes: 30 }).toISO()! : a.startsAt === "future" ? DateTime.now().setZone(pre.tz).plus({ days: 2 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 }).toISO()! : undefined;
      const r = await op(async (c) => simulate({ c, company: (await loadCompany(c, companyId)).row, contactId: pre.contactId, adapters, startsAt, outcome: a.outcome, deposit: a.deposit, calendar: a.calendar }, a.action));
      acts.push(r.ok ? { action: a.action, ok: true, runs: r.runsStarted } : { action: a.action, ok: false, why: r.why, runs: 0 });
      if (!r.ok) break;   // the rest of the journey rests on this step
      await settle();
    }
  }
  await settle();
  return op(async (c) => {
    const runs = await runsSince(c, companyId, { contactId: pre.s.id === "scheduled" ? undefined : pre.contactId, ids: fired }, since);
    const o = (await loadTests(c, companyId))!;
    const mode = (await one<{ mode: string }>(c, "select mode from companies where id=$1", [companyId]))!.mode;
    const result: ScenarioResult = { at: new Date().toISOString(), by, rung: mode, acts, runs, passed: acts.every((a) => a.ok) && runs.every((r) => !r.problem) };
    await saveTests(c, companyId, { ...o.tests, results: { ...(o.tests.results ?? {}), [scenarioId]: result } });
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'onboarding.test','company',$2,$3)", [companyId, companyId, { scenario: scenarioId, passed: result.passed, runs: runs.length, problems: runs.filter((r) => r.problem).length, by }]);
    await syncDone(c, companyId);
    return { ok: true as const, result };
  });
}

/** A workflow no scenario reaches, accepted with a note (how it was checked, or why it waits); an empty note takes the acceptance back. */
export async function acceptWorkflow(c: PoolClient, companyId: string, args: { workflow?: unknown; note?: unknown; by?: string }): Promise<{ ok: true } | { ok: false; status: number; why: string }> {
  const o = await loadTests(c, companyId);
  if (!o?.tests.prepared) return { ok: false, status: 409, why: "turn the workflows on first" };
  const name = typeof args.workflow === "string" ? args.workflow : "";
  if (!o.tests.prepared.on.includes(name)) return { ok: false, status: 400, why: `"${name}" is not one of the workflows turned on for the tests` };
  const note = typeof args.note === "string" ? args.note.trim() : "";
  const accepted = { ...(o.tests.accepted ?? {}) };
  if (note) accepted[name] = { note, at: new Date().toISOString(), by: args.by ?? "dashboard" }; else delete accepted[name];
  await saveTests(c, companyId, { ...o.tests, accepted });
  await syncDone(c, companyId);
  return { ok: true };
}

/** Each workflow turned on, from the latest result of every scenario: failing beats clean; accepted only where nothing failed. */
export function workflowStates(t: Tests): WorkflowState[] {
  const runs = Object.values(t.results ?? {}).flatMap((r) => r.runs);
  return (t.prepared?.on ?? []).map((name) => {
    const mine = runs.filter((r) => r.workflow === name), problems = mine.flatMap((r) => (r.problem ? [r.problem] : [])), clean = mine.filter((r) => !r.problem).length;
    const acc = t.accepted?.[name];
    const state: WorkflowState["state"] = problems.length ? "failing" : clean ? "clean" : acc ? "accepted" : "not reached";
    return { name, state, clean, problems, ...(acc ? { note: acc.note } : {}) };
  });
}

export type TestsState = { tests: Tests; scenarios: Scenario[]; workflows: WorkflowState[]; contacts: { id: string; name: string; email: string | null }[]; done: boolean; todo: string[] };

/** What is left before the step is done, one line each; none means done. */
export function testsTodo(t: Tests, scenarios: Scenario[]): string[] {
  if (!t.prepared) return ["turn the workflows on and choose the test contact"];
  const out: string[] = t.prepared.left_off.filter((w) => w.blocking).map((w) => `${w.name} is off: ${w.why}; set it, then turn the workflows on again`);
  for (const s of scenarios) { const r = t.results?.[s.id]; if (!r) out.push(`run "${s.label}"`); else if (r.acts.some((a) => !a.ok)) out.push(`"${s.label}" stopped: ${r.acts.find((a) => !a.ok)!.why}`); }
  for (const w of workflowStates(t)) if (w.state === "failing") out.push(`${w.name}: ${w.problems[0]}`); else if (w.state === "not reached") out.push(`${w.name}: no scenario reached it; check it by hand and accept it with a note`);
  return out;
}

export async function testsState(c: PoolClient, companyId: string): Promise<TestsState | null> {
  const o = await loadTests(c, companyId);
  if (!o) return null;
  const scenarios = await scenariosFor(c, companyId, o.intake), todo = testsTodo(o.tests, scenarios);
  return { tests: o.tests, scenarios, workflows: workflowStates(o.tests), contacts: await testContacts(c, companyId), done: !todo.length, todo };
}

/** The step's done mark follows the results: set when nothing is left, taken off when a re-run fails. */
async function syncDone(c: PoolClient, companyId: string) {
  const s = (await testsState(c, companyId))!;
  if (s.done) await c.query("update onboarding set steps = steps || jsonb_build_object('test', jsonb_build_object('done_at', now(), 'by', 'tests')) where company_id=$1 and not steps ? 'test'", [companyId]);
  else await c.query("update onboarding set steps = steps - 'test' where company_id=$1", [companyId]);
}
