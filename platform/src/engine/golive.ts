import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { companyReadiness, type Issue } from "./readiness";

/**
 * Go live (D51). Every rung below live was rehearsal: no run born there survives the switch — the runs,
 * their steps, their would-sends and the events they wrote. Refused while readiness has a blocker, so a company
 * cannot go live half-wired. Back to shadow is just the mode flag.
 */
export type Cleared = { runs: number; steps: number; sends: number; events: number; appointments: number };
/** The clean slate (item 9): every run not born live, and every synthetic appointment the test harness made, with what pointed at them. Real CRM facts (contacts, their tags, real appointments) stay: the CRM is the truth about those. */
export async function clearRehearsalRuns(c: PoolClient, companyId: string): Promise<Cleared> {
  const out: Cleared = { runs: 0, steps: 0, sends: 0, events: 0, appointments: 0 };
  const ids = (await many<{ id: string }>(c, "select id from runs where company_id=$1 and born_in<>'live'", [companyId])).map((r) => r.id);
  const n = async (sql: string, arg: unknown) => (await c.query(sql, [arg])).rowCount ?? 0;
  if (ids.length) {
    out.events += await n("delete from events where run_id = any($1::uuid[])", ids);
    out.sends = await n("delete from sends where run_id = any($1::uuid[])", ids);
    out.steps = await n("delete from run_steps where run_id = any($1::uuid[])", ids);
    out.runs = await n("delete from runs where id = any($1::uuid[])", ids);
  }
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
