import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { companyReadiness, workflowLiveBlockers, type Issue } from "./readiness";
import { runMode, testContactSql, testDomains, TEST_DOMAINS_KEY, type Mode } from "./mode";

/**
 * Go live (D51). Every rung below live was rehearsal: no run born there survives the switch — the runs,
 * their steps, their would-sends and the events they wrote. Refused while readiness has a blocker, so a company
 * cannot go live half-wired. Back to shadow is just the mode flag.
 */
export type Cleared = { runs: number; steps: number; sends: number; events: number; appointments: number };
/**
 * The clean slate (item 9): every run not born live, and every synthetic appointment the test harness made, with what pointed at them. Real CRM facts (contacts, their tags, real appointments) stay: the CRM is the truth about those.
 * D92: for the company, only the runs of workflows that will run live (those on their own shadow or test rung keep rehearsing); for one workflow going live on its own, only its runs, and the synthetic bookings stay for the rest.
 */
export async function clearRehearsalRuns(c: PoolClient, companyId: string, workflowId?: string): Promise<Cleared> {
  const out: Cleared = { runs: 0, steps: 0, sends: 0, events: 0, appointments: 0 };
  const ids = (await many<{ id: string }>(c, workflowId
    ? "select id from runs where company_id=$1 and workflow_id=$2 and born_in<>'live'"
    : "select r.id from runs r join workflows w on w.id=r.workflow_id where r.company_id=$1 and r.born_in<>'live' and coalesce(w.mode,'live')='live'", workflowId ? [companyId, workflowId] : [companyId])).map((r) => r.id);
  const n = async (sql: string, arg: unknown) => (await c.query(sql, [arg])).rowCount ?? 0;
  if (ids.length) {
    out.events += await n("delete from events where run_id = any($1::uuid[])", ids);
    out.sends = await n("delete from sends where run_id = any($1::uuid[])", ids);
    out.steps = await n("delete from run_steps where run_id = any($1::uuid[])", ids);
    out.runs = await n("delete from runs where id = any($1::uuid[])", ids);
  }
  if (workflowId) return out;
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

export async function goLive(c: PoolClient, companyId: string, slugPrefix: string, via: string): Promise<{ ok: true; cleared: Cleared } | { ok: false; blockers: Issue[] }> {
  const r = await companyReadiness(c, companyId, slugPrefix);
  const blockers = r.issues.filter((i) => i.level === "blocker");
  if (blockers.length) return { ok: false, blockers };
  const co = (await one<{ mode: string }>(c, "select mode from companies where id=$1", [companyId]))!;
  await c.query("begin");
  try {
    const cleared = await clearRehearsalRuns(c, companyId);
    await c.query("update companies set mode='live' where id=$1", [companyId]);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'company.mode','company',$4,$2,$3)", [companyId, { mode: co.mode }, { mode: "live", via, cleared }, companyId]);
    await c.query("commit");
    return { ok: true, cleared };
  } catch (e) { await c.query("rollback"); throw e; }
}

export type WorkflowModeChange = { ok: true; changed: boolean; mode: Mode | null; runs_in: Mode; cleared?: Cleared } | { ok: false; status: number; error: string; blockers?: Issue[] };
/**
 * D92: a workflow's own rung, or null to follow the company again. Whatever puts its runs live (its own live, or back to a
 * live company) passes the go-live gate narrowed to this workflow and clears its runs not born live, as Go live does (D51).
 * `by` is who asked, `via` the door; both go to the audit log with the rung before and after.
 */
export async function setWorkflowMode(c: PoolClient, workflowId: string, mode: Mode | null, by: string, via: string): Promise<WorkflowModeChange> {
  const w = await one<{ company_id: string; name: string; own: Mode | null; company: Mode; slug: string }>(c, "select w.company_id, w.name, w.mode as own, co.mode as company, co.slug from workflows w join companies co on co.id=w.company_id where w.id=$1", [workflowId]);
  if (!w) return { ok: false, status: 404, error: "no such workflow" };
  const from = runMode(w.company, w.own), to = runMode(w.company, mode);
  if (w.own === mode) return { ok: true, changed: false, mode, runs_in: to };
  const goesLive = to === "live" && from !== "live";
  if (goesLive) {
    const blockers = await workflowLiveBlockers(c, w.company_id, workflowId, `/app/c/${w.slug}`);
    if (blockers.length) return { ok: false, status: 409, error: `${w.name} is not ready to go live: ${blockers.map((b) => b.text).join(" ")}`, blockers };
  }
  await c.query("begin");
  try {
    const cleared = goesLive ? await clearRehearsalRuns(c, w.company_id, workflowId) : undefined;
    await c.query("update workflows set mode=$2 where id=$1", [workflowId, mode]);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'workflow.mode','workflow',$2,$3,$4)",
      [w.company_id, workflowId, { mode: w.own, runs_in: from }, { mode, runs_in: to, by, via, ...(cleared ? { cleared } : {}) }]);
    await c.query("commit");
    return { ok: true, changed: true, mode, runs_in: to, ...(cleared ? { cleared } : {}) };
  } catch (e) { await c.query("rollback"); throw e; }
}
