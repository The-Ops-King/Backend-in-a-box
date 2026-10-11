import type { PoolClient } from "pg";
import { one } from "@/db/client";
import { indexDefinition, onwardEdge, parseDefinition } from "./definition";
import { resolve } from "./alerts";
import type { Adapters } from "@/adapters/types";

/**
 * D66: the human in the loop. A run that paused at a step (the vendor kept failing, the token died, the step was told no)
 * waits for a person: Retry gives the step a fresh set of tries now; Skip marks the step skipped by that person and the
 * run goes on along the step's plain edge. Both work on an engine-bug `failed` run too, so nothing is ever stuck for good.
 * D77: Retry with `node` names a step the run skipped after its tries and went on without; only that step runs again (runner.ts › rerunStep).
 */
type Row = { id: string; company_id: string; status: string; current_node: string | null; workflow_id: string; workflow_version: number };
type Outcome = { ok: true; run_id: string; node: string | null; next?: string } | { ok: false; status: number; error: string };

const load = (c: PoolClient, id: string) => one<Row>(c, "select id, company_id, status, current_node, workflow_id, workflow_version from runs where id=$1", [id]);
const actionable = (r: Row) => r.status === "paused" || r.status === "failed";

export async function retryStep(c: PoolClient, runId: string, by: string, opts: { node?: string; adapters?: Adapters } = {}): Promise<Outcome> {
  const r = await load(c, runId);
  if (!r) return { ok: false, status: 404, error: "no such run" };
  if (opts.node && !(actionable(r) && opts.node === r.current_node)) {
    if (!opts.adapters) return { ok: false, status: 500, error: "retrying one skipped step needs the vendors" };
    const { rerunStep } = await import("./runner");
    const out = await rerunStep(c, opts.adapters, runId, opts.node, by);
    return out.ok ? { ok: true, run_id: runId, node: out.node } : out;
  }
  if (!actionable(r)) return { ok: false, status: 409, error: `this run is ${r.status}; only a paused or failed run can be retried` };
  await c.query("update runs set status='waiting', next_run_at=now(), step_attempt=0, step_error=null, step_held=false, exit_reason=null, finished_at=null, claimed_at=null, claimed_by=null where id=$1", [runId]);
  await resolve(c, r.company_id, `run:${runId}:paused`, new Date(), true);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'run.retried','run',$2,$3)", [r.company_id, runId, { node: r.current_node, by, was: r.status }]);
  return { ok: true, run_id: runId, node: r.current_node };
}

export async function skipStep(c: PoolClient, runId: string, by: string): Promise<Outcome> {
  const r = await load(c, runId);
  if (!r) return { ok: false, status: 404, error: "no such run" };
  if (!actionable(r)) return { ok: false, status: 409, error: `this run is ${r.status}; only a paused or failed run can skip its step` };
  if (!r.current_node) return { ok: false, status: 409, error: "this run has no current step to skip" };
  const v = await one<{ definition: unknown }>(c, "select definition from workflow_versions where workflow_id=$1 and version=$2", [r.workflow_id, r.workflow_version]);
  const def = v ? parseDefinition(v.definition) : null;
  const node = def?.nodes.find((n) => n.id === r.current_node);
  if (!def || !node) return { ok: false, status: 409, error: `step ${r.current_node} is not in this run's workflow version; retry it instead` };
  const edge = onwardEdge(indexDefinition(def).edgesFrom(node.id));
  if (!edge) return { ok: false, status: 409, error: `step ${node.id} (${node.type}) has no plain way on (a question or a gate); retry it instead` };
  await c.query("insert into run_steps (run_id, node_id, node_type, status, result, finished_at) values ($1,$2,$3,'skipped',$4,now())", [runId, node.id, node.type, { kind: "skipped_by", by, why: `skipped by ${by}` }]);
  await c.query("update runs set status='waiting', next_run_at=now(), current_node=$2, step_attempt=0, step_error=null, step_held=false, exit_reason=null, finished_at=null, claimed_at=null, claimed_by=null where id=$1", [runId, edge.to]);
  await resolve(c, r.company_id, `run:${runId}:paused`, new Date(), true);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'run.step_skipped','run',$2,$3)", [r.company_id, runId, { node: node.id, to: edge.to, by, was: r.status }]);
  return { ok: true, run_id: runId, node: node.id, next: edge.to };
}
