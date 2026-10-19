import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { companyReadiness, workflowLiveBlockers, type Issue } from "./readiness";
import { MODES, runMode, testContactSql, testDomains, TEST_DOMAINS_KEY, type Mode } from "./mode";
import { useCheck } from "@/onboarding/filters";

/**
 * Go live (D51), and D132's go quiet: the two rungs that write the CRM for everyone. Moving up into one is refused while readiness
 * has a blocker (half-wired workflows would write real people's records), and no run born on a lower rung survives the move —
 * the runs, their steps, their would-sends and the events they wrote — so nothing picks up halfway with its first steps never
 * done. Into quiet: the runs born in ghost or test. Into live: every run not born live (a quiet-born run held back its
 * messages, so a sequence must not resume mid-way), and the harness's synthetic bookings. Moving down is just the mode flag.
 */
/** The rungs that write the CRM for everyone (D132). */
export const WRITES_FOR_ALL: Mode[] = ["quiet", "live"];
const rank = (m: Mode) => MODES.indexOf(m);
/** The runs a move up to `to` leaves behind: born on a rung below it. */
const bornBelow = (to: Mode) => MODES.filter((m) => rank(m) < rank(to));
export type Cleared = { runs: number; steps: number; sends: number; events: number; appointments: number };
/**
 * The clean slate (item 9): every run not born live, and every synthetic appointment the test harness made, with what pointed at them. Real CRM facts (contacts, their tags, real appointments) stay: the CRM is the truth about those.
 * D92: for the company, only the runs of workflows that will run live (those on their own lower rung keep rehearsing); for one workflow going live on its own, only its runs, and the synthetic bookings stay for the rest.
 */
export async function clearRehearsalRuns(c: PoolClient, companyId: string, workflowId?: string, to: Mode = "live"): Promise<Cleared> {
  const out: Cleared = { runs: 0, steps: 0, sends: 0, events: 0, appointments: 0 };
  const below = bornBelow(to);
  const ids = (await many<{ id: string }>(c, workflowId
    ? "select id from runs where company_id=$1 and workflow_id=$2 and born_in = any($3::text[])"
    : "select r.id from runs r join workflows w on w.id=r.workflow_id where r.company_id=$1 and r.born_in = any($3::text[]) and coalesce(w.mode,$2)=$2", workflowId ? [companyId, workflowId, below] : [companyId, to, below])).map((r) => r.id);
  const n = async (sql: string, arg: unknown) => (await c.query(sql, [arg])).rowCount ?? 0;
  if (ids.length) {
    // a run started by an event a cleared run wrote (New from Typeform's lead.created starting New lead) lets go of it first; a run that stays keeps its history, not the pointer
    await n("update runs set triggered_by_event=null where triggered_by_event in (select id from events where run_id = any($1::uuid[]))", ids);
    out.events += await n("delete from events where run_id = any($1::uuid[])", ids);
    out.sends = await n("delete from sends where run_id = any($1::uuid[])", ids);
    out.steps = await n("delete from run_steps where run_id = any($1::uuid[])", ids);
    out.runs = await n("delete from runs where id = any($1::uuid[])", ids);
  }
  if (workflowId || to !== "live") return out;   // a quiet company's staged bookings are its test contacts' rehearsal, still real for them
  const synthetic = (await many<{ id: string }>(c, "select id from appointments where company_id=$1 and source='test'", [companyId])).map((a) => a.id);
  if (synthetic.length) {
    await n("update runs set appointment_id=null where appointment_id = any($1::uuid[])", synthetic);   // a live-born run about a synthetic booking keeps its history, loses the pointer
    out.events += await n("delete from events where appointment_id = any($1::uuid[])", synthetic);
    await n("delete from recordings where appointment_id = any($1::uuid[])", synthetic);
    await n("delete from form_submissions where appointment_id = any($1::uuid[])", synthetic);
    out.appointments = await n("delete from appointments where id = any($1::uuid[])", synthetic);
  }
  return out;
}

/**
 * D97: bookings the test harness staged on a real person (before the harness refused them), with the rehearsal runs they
 * started: off the closer's end of day, the reminders and the numbers. A live-born run about one keeps its history and loses
 * the pointer, as at go-live. A test contact's staged bookings stay: those are the team's own rehearsal.
 */
export async function clearStrayHarnessBookings(c: PoolClient, companyId: string, dryRun = false): Promise<Cleared & { people: string[] }> {
  const domains = testDomains({ [TEST_DOMAINS_KEY]: (await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key=$2", [companyId, TEST_DOMAINS_KEY]))?.value.toString("utf8") ?? "" });
  const stray = await many<{ id: string; who: string }>(c, `select a.id, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as who from appointments a join contacts ct on ct.id=a.contact_id
    where a.company_id=$1 and a.source='test' and not ${testContactSql("ct", "$2")}`, [companyId, domains]);
  const ids = stray.map((a) => a.id), out: Cleared & { people: string[] } = { runs: 0, steps: 0, sends: 0, events: 0, appointments: 0, people: [...new Set(stray.map((a) => a.who))] };
  if (!ids.length || dryRun) return { ...out, appointments: ids.length };
  const n = async (sql: string, arg: unknown) => (await c.query(sql, [arg])).rowCount ?? 0;
  const runs = (await many<{ id: string }>(c, "select id from runs where appointment_id = any($1::uuid[]) and born_in<>'live'", [ids])).map((r) => r.id);
  if (runs.length) {
    await n("update runs set triggered_by_event=null where triggered_by_event in (select id from events where run_id = any($1::uuid[]))", runs);
    out.events += await n("delete from events where run_id = any($1::uuid[])", runs);
    out.sends = await n("delete from sends where run_id = any($1::uuid[])", runs);
    out.steps = await n("delete from run_steps where run_id = any($1::uuid[])", runs);
    out.runs = await n("delete from runs where id = any($1::uuid[])", runs);
  }
  await n("update runs set appointment_id=null where appointment_id = any($1::uuid[])", ids);
  out.events += await n("delete from events where appointment_id = any($1::uuid[])", ids);
  await n("delete from recordings where appointment_id = any($1::uuid[])", ids);
  await n("delete from form_submissions where appointment_id = any($1::uuid[])", ids);
  out.appointments = await n("delete from appointments where id = any($1::uuid[])", ids);
  await c.query("insert into audit_log (company_id, action, target_type, after) values ($1,'harness.stray_cleared','company',$2)", [companyId, out]);
  return out;
}

export type CompanyModeChange = { ok: true; changed: boolean; mode: Mode; cleared?: Cleared } | { ok: false; blockers: Issue[] };
/** The company onto a rung (D52, D132): up into quiet or live through the gate and the clean slate above; any other move is the flag. Audited. */
export async function setCompanyMode(c: PoolClient, companyId: string, to: Mode, slugPrefix: string, via: string): Promise<CompanyModeChange> {
  const co = (await one<{ mode: Mode }>(c, "select mode from companies where id=$1", [companyId]))!;
  if (co.mode === to) return { ok: true, changed: false, mode: to };
  const up = WRITES_FOR_ALL.includes(to) && rank(to) > rank(co.mode);
  if (up) {
    const blockers = (await companyReadiness(c, companyId, slugPrefix)).issues.filter((i) => i.level === "blocker");
    if (blockers.length) return { ok: false, blockers };
  }
  await c.query("begin");
  try {
    // D158: any move up, for a company onboarded through the wizard, uses a fresh check of their own GHL workflows
    const unchecked = rank(to) > rank(co.mode) ? await useCheck(c, companyId, `company → ${to}`) : null;
    if (unchecked) { await c.query("rollback"); return { ok: false, blockers: [{ level: "blocker", text: unchecked }] }; }
    const cleared = up ? await clearRehearsalRuns(c, companyId, undefined, to) : undefined;
    await c.query("update companies set mode=$2 where id=$1", [companyId, to]);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'company.mode','company',$4,$2,$3)", [companyId, { mode: co.mode }, { mode: to, via, ...(cleared ? { cleared } : {}) }, companyId]);
    await c.query("commit");
    return { ok: true, changed: true, mode: to, ...(cleared ? { cleared } : {}) };
  } catch (e) { await c.query("rollback"); throw e; }
}

export type WorkflowModeChange = { ok: true; changed: boolean; mode: Mode | null; runs_in: Mode; cleared?: Cleared } | { ok: false; status: number; error: string; blockers?: Issue[] };
/**
 * D92: a workflow's own rung, or null to follow the company again. Whatever moves its runs up into quiet or live (its own rung,
 * or back to such a company) passes the gate narrowed to this workflow and clears its runs born below, as the company's move does (D51, D132).
 * `by` is who asked, `via` the door; both go to the audit log with the rung before and after.
 */
export async function setWorkflowMode(c: PoolClient, workflowId: string, mode: Mode | null, by: string, via: string): Promise<WorkflowModeChange> {
  const w = await one<{ company_id: string; name: string; own: Mode | null; company: Mode; slug: string }>(c, "select w.company_id, w.name, w.mode as own, co.mode as company, co.slug from workflows w join companies co on co.id=w.company_id where w.id=$1", [workflowId]);
  if (!w) return { ok: false, status: 404, error: "no such workflow" };
  const from = runMode(w.company, w.own), to = runMode(w.company, mode);
  if (w.own === mode) return { ok: true, changed: false, mode, runs_in: to };
  const up = WRITES_FOR_ALL.includes(to) && rank(to) > rank(from);
  if (up) {
    const blockers = await workflowLiveBlockers(c, w.company_id, workflowId, `/app/c/${w.slug}`);
    if (blockers.length) return { ok: false, status: 409, error: `${w.name} is not ready to go ${to}: ${blockers.map((b) => b.text).join(" ")}`, blockers };
  }
  await c.query("begin");
  try {
    const unchecked = rank(to) > rank(from) ? await useCheck(c, w.company_id, `${w.name} → ${to}`) : null;
    if (unchecked) { await c.query("rollback"); return { ok: false, status: 409, error: `${w.name} cannot go ${to}: ${unchecked}`, blockers: [{ level: "blocker", text: unchecked }] }; }
    const cleared = up ? await clearRehearsalRuns(c, w.company_id, workflowId, to) : undefined;
    await c.query("update workflows set mode=$2 where id=$1", [workflowId, mode]);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'workflow.mode','workflow',$2,$3,$4)",
      [w.company_id, workflowId, { mode: w.own, runs_in: from }, { mode, runs_in: to, by, via, ...(cleared ? { cleared } : {}) }]);
    await c.query("commit");
    return { ok: true, changed: true, mode, runs_in: to, ...(cleared ? { cleared } : {}) };
  } catch (e) { await c.query("rollback"); throw e; }
}
