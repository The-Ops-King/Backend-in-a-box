import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { loadCompany } from "./context";

/** D142: what the operator asked to take back (see app/api/admin/runs/undo). */
export type UndoAsk = { company: string; runs: string[]; nodes?: string[]; why: string; dryRun?: boolean; by?: string };
type Write = { run_id: string; node_id: string; kind: "card" | "task" | "record"; external_id: string; contact_ghl: string | null; object?: string; our_id?: string };
export type UndoResult = { ok: true; dryRun: boolean; writes: (Write & { done?: boolean; error?: string })[]; kept: string[] } | { ok: false; status: number; error: string };

/**
 * Takes back what a run made in the CRM, from the engine's own ledger of what it created (step_effects, D66): a card (the
 * opportunity), a task, a custom object record. Only what the run made, never what it found or updated; a note or a sent
 * document is not taken back (said in `kept`). `nodes` narrows it to those steps. Each removal is audited with the why.
 */
export async function undoRunWrites(c: PoolClient, adapters: Adapters, a: UndoAsk): Promise<UndoResult> {
  if (!a.runs?.length || !a.why?.trim()) return { ok: false, status: 400, error: "runs and why are required" };
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [a.company]); if (!co) return { ok: false, status: 404, error: "no such company" };
  const effects = await many<{ run_id: string; node_id: string; kind: string; external_id: string | null; contact_ghl: string | null }>(c,
    `select e.run_id::text, e.node_id, e.kind, e.external_id, ct.ghl_contact_id as contact_ghl from step_effects e join runs r on r.id=e.run_id left join contacts ct on ct.id=r.contact_id
     where e.company_id=$1 and e.run_id = any($2::uuid[]) and e.done_at is not null and ($3::text[] is null or e.node_id = any($3::text[])) order by e.run_id, e.node_id`, [co.id, a.runs, a.nodes?.length ? a.nodes : null]);
  const writes: Write[] = [], kept: string[] = [];
  for (const e of effects) {
    if (!e.external_id) continue;
    if (e.kind === "card" || e.kind === "task") writes.push({ run_id: e.run_id, node_id: e.node_id, kind: e.kind, external_id: e.external_id, contact_ghl: e.contact_ghl });
    else if (e.kind === "record") {
      const rec = await one<{ id: string; object_key: string; adopted: boolean }>(c, "select id, object_key, adopted from crm_records where company_id=$1 and ghl_record_id=$2", [co.id, e.external_id]);
      if (rec && !rec.adopted) writes.push({ run_id: e.run_id, node_id: e.node_id, kind: "record", external_id: e.external_id, contact_ghl: e.contact_ghl, object: rec.object_key, our_id: rec.id });
      else kept.push(`${e.node_id}: record ${e.external_id} (${rec ? "taken over from GHL" : "no longer the engine's"})`);
    } else kept.push(`${e.node_id}: the ${e.kind} ${e.external_id} (a ${e.kind} is not taken back)`);
  }
  if (a.dryRun !== false) return { ok: true, dryRun: true, writes, kept };
  const { adapterCompany: ac } = await loadCompany(c, co.id);
  const out: (Write & { done?: boolean; error?: string })[] = [];
  for (const w of writes) {
    try {
      if (w.kind === "card") {
        if (!adapters.write.deleteOpportunity) throw new Error("this CRM adapter cannot delete cards");
        await adapters.write.deleteOpportunity(ac, w.external_id);
        await c.query("delete from pipeline_cards where company_id=$1 and ghl_opportunity_id=$2", [co.id, w.external_id]);
      } else if (w.kind === "task") {
        if (!adapters.write.deleteTask) throw new Error("this CRM adapter cannot delete tasks");
        if (!w.contact_ghl) throw new Error("the run's contact has no CRM id");
        await adapters.write.deleteTask(ac, w.contact_ghl, w.external_id);
      } else {
        if (!adapters.write.deleteRecord) throw new Error("this CRM adapter cannot delete records");
        await adapters.write.deleteRecord(ac, w.object!, w.external_id);
        await c.query("delete from crm_records where id=$1", [w.our_id]);
      }
      await c.query("delete from step_effects where run_id=$1 and node_id=$2 and kind=$3", [w.run_id, w.node_id, w.kind]);
      await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'run.undone','run',$2,$3,$4)", [co.id, w.run_id, { node: w.node_id, kind: w.kind, id: w.external_id }, { why: a.why, by: a.by ?? "operator" }]);
      out.push({ ...w, done: true });
    } catch (e) { out.push({ ...w, error: String((e as Error).message).slice(0, 300) }); }
  }
  return { ok: true, dryRun: false, writes: out, kept };
}
