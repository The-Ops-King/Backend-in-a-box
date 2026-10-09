import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { companyReadiness, type Issue } from "./readiness";

/**
 * Go live (D51). Shadow was rehearsal: every run born there is fiction, so none of it survives the switch — the runs,
 * their steps, their would-sends and the events they wrote. Refused while readiness has a blocker, so a company
 * cannot go live half-wired. Back to shadow is just the mode flag.
 */
export type Cleared = { runs: number; steps: number; sends: number; events: number };
export async function clearShadowRuns(c: PoolClient, companyId: string): Promise<Cleared> {
  const ids = (await many<{ id: string }>(c, "select id from runs where company_id=$1 and born_in='shadow'", [companyId])).map((r) => r.id);
  if (!ids.length) return { runs: 0, steps: 0, sends: 0, events: 0 };
  const n = async (sql: string) => (await c.query(sql, [ids])).rowCount ?? 0;
  const events = await n("delete from events where run_id = any($1::uuid[])");
  const sends = await n("delete from sends where run_id = any($1::uuid[])");
  const steps = await n("delete from run_steps where run_id = any($1::uuid[])");
  const runs = await n("delete from runs where id = any($1::uuid[])");
  return { runs, steps, sends, events };
}

export async function goLive(c: PoolClient, companyId: string, slugPrefix: string, via: string): Promise<{ ok: true; cleared: Cleared } | { ok: false; blockers: Issue[] }> {
  const r = await companyReadiness(c, companyId, slugPrefix);
  const blockers = r.issues.filter((i) => i.level === "blocker");
  if (blockers.length) return { ok: false, blockers };
  const co = (await one<{ mode: string }>(c, "select mode from companies where id=$1", [companyId]))!;
  await c.query("begin");
  try {
    const cleared = await clearShadowRuns(c, companyId);
    await c.query("update companies set mode='live' where id=$1", [companyId]);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'company.mode','company',$4,$2,$3)", [companyId, { mode: co.mode }, { mode: "live", via, cleared }, companyId]);
    await c.query("commit");
    return { ok: true, cleared };
  } catch (e) { await c.query("rollback"); throw e; }
}
