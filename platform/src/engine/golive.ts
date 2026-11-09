import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { companyReadiness, workflowLiveBlockers, type Issue } from "./readiness";
import { MODES, runMode, testContactSql, testDomains, TEST_DOMAINS_KEY, type Mode } from "./mode";
import { afterOwn, relianceBlockers } from "./golive-deps";
import { parseDefinition } from "./definition";
import { render } from "./template";

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
/** `periods`: scheduled reports' runs kept as closed-out markers, so the period they ran in is not run again (D201) */
export type Cleared = { runs: number; steps: number; sends: number; events: number; appointments: number; periods?: number; /** D289: the ghost runs' would-be records it made (no CRM id) */ leftovers?: number };

/**
 * D289: the records a workflow's ghost runs would have made: rows with no CRM id, of the objects its record steps write. Nothing was
 * made in GHL; left, they only stand in a repair's way (Johanny Restrepo's Sales Call, 2026-10-31). Cleared when it goes up.
 */
export async function clearGhostRecords(c: PoolClient, companyId: string, workflowId: string): Promise<number> {
  const v = await one<{ definition: unknown }>(c, "select v.definition from workflow_versions v join workflows w on w.id=v.workflow_id and w.current_version=v.version where w.id=$1", [workflowId]);
  if (!v) return 0;
  let objects: string[] = [];
  try {
    const crm = Object.fromEntries((await many<{ key: string; value: Buffer }>(c, "select key, value from bindings where company_id=$1 and key like 'crm.%'", [companyId])).map((b) => [b.key.slice(4), b.value.toString("utf8")]));
    objects = parseDefinition(v.definition).nodes.flatMap((n) => (n.type === "crm_record" ? [render(n.object, { crm }, { tz: "UTC" } as never).trim()] : [])).filter((o) => o && !o.includes("{{"));
  } catch { return 0; }
  if (!objects.length) return 0;
  return (await c.query("delete from crm_records where company_id=$1 and ghl_record_id is null and object_key = any($2::text[])", [companyId, [...new Set(objects)]])).rowCount ?? 0;
}
/**
 * The clean slate (item 9): every run not born live, and every synthetic appointment the test harness made, with what pointed at them. Real CRM facts (contacts, their tags, real appointments) stay: the CRM is the truth about those.
 * D92: for the company, only the runs of workflows that will run live (those on their own lower rung keep rehearsing); for one workflow going live on its own, only its runs, and the synthetic bookings stay for the rest.
 * D201: a scheduled run (a report: the wrap-ups, the leaderboard, the end-of-day nudges) is cleared of what it did but its row is
 * kept, closed out (exited), so the clock counts its period as run. Deleting it let the clock fire that period again the moment the
 * workflow went up (Nelly's weekly wrap-up and leaderboard, 2026-10-19: run on quiet at 8 and 9am, posted again at 7:12pm when they
 * went live). Tyler: no re-fire; the next post is the next scheduled one.
 */
export async function clearRehearsalRuns(c: PoolClient, companyId: string, workflowId?: string, to: Mode = "live"): Promise<Cleared> {
  const out: Cleared = { runs: 0, steps: 0, sends: 0, events: 0, appointments: 0 };
  const below = bornBelow(to);
  const ids = (await many<{ id: string }>(c, workflowId
    ? "select id from runs where company_id=$1 and workflow_id=$2 and born_in = any($3::text[])"
    : "select r.id from runs r join workflows w on w.id=r.workflow_id where r.company_id=$1 and r.born_in = any($3::text[]) and coalesce(w.mode,$2)=$2", workflowId ? [companyId, workflowId, below] : [companyId, to, below])).map((r) => r.id);
  const n = async (sql: string, arg: unknown) => (await c.query(sql, [arg])).rowCount ?? 0;
  const scheduled = ids.length ? new Set((await many<{ id: string }>(c, "select id from runs where id = any($1::uuid[]) and reentry_key like 'schedule:%'", [ids])).map((r) => r.id)) : new Set<string>();
  if (ids.length) {
    // a run started by an event a cleared run wrote (New from Typeform's lead.created starting New lead) lets go of it first; a run that stays keeps its history, not the pointer
    await n("update runs set triggered_by_event=null where triggered_by_event in (select id from events where run_id = any($1::uuid[]))", ids);
    out.events += await n("delete from events where run_id = any($1::uuid[])", ids);
    out.sends = await n("delete from sends where run_id = any($1::uuid[])", ids);
    out.steps = await n("delete from run_steps where run_id = any($1::uuid[])", ids);
    const gone = ids.filter((id) => !scheduled.has(id));
    out.runs = gone.length ? await n("delete from runs where id = any($1::uuid[])", gone) : 0;
    // a finished one keeps how it ended; one still going is closed out, so nothing picks up halfway with its first steps gone
    if (scheduled.size) {
      await n(`update runs set status='exited', exit_reason='cleared at the move up: its period ran on a lower rung', next_run_at=null, wake_on_reply=false,
        wake_on_tag=null, wake_on_event=null, resume_node=null, resume_at=null, claimed_at=null, claimed_by=null, step_held=false, finished_at=now()
        where id = any($1::uuid[]) and status in ('active','waiting','paused')`, [...scheduled]);
      out.periods = scheduled.size;
    }
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
    // D289: every enabled workflow that will run on the new rung, against what it relies on, as the rungs will stand after the move
    const ids = (await many<{ id: string }>(c, "select id from workflows where company_id=$1 and enabled", [companyId])).map((w) => w.id);
    blockers.push(...(await relianceBlockers(c, companyId, ids, (w) => runMode(to, w.own), slugPrefix)));
    if (blockers.length) return { ok: false, blockers };
  }
  await c.query("begin");
  try {
    // D192 (over D180): a move up no longer waits for a fresh check of their GHL workflows; the hourly Health check says a new or changed one
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
    blockers.push(...(await relianceBlockers(c, w.company_id, [workflowId], afterOwn(w.company, workflowId, mode), `/app/c/${w.slug}`)));   // D289
    if (blockers.length) return { ok: false, status: 409, error: `${w.name} is not ready to go ${to}: ${blockers.map((b) => b.text).join(" ")}`, blockers };
  }
  await c.query("begin");
  try {
    const cleared = up ? await clearRehearsalRuns(c, w.company_id, workflowId, to) : undefined;
    if (cleared) cleared.leftovers = await clearGhostRecords(c, w.company_id, workflowId);   // D289
    await c.query("update workflows set mode=$2 where id=$1", [workflowId, mode]);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'workflow.mode','workflow',$2,$3,$4)",
      [w.company_id, workflowId, { mode: w.own, runs_in: from }, { mode, runs_in: to, by, via, ...(cleared ? { cleared } : {}) }]);
    await c.query("commit");
    return { ok: true, changed: true, mode, runs_in: to, ...(cleared ? { cleared } : {}) };
  } catch (e) { await c.query("rollback"); throw e; }
}
