import { asOperator, many, one } from "@/db/client";
import { parseDefinition } from "@/engine/definition";
import { buildContext, loadCompany, type RunRow } from "@/engine/context";
import { projectRun, type Projected } from "@/engine/project";

export type PlannedRun = { run_id: string; workflow_id: string; workflow: string; contact_id: string | null; contact: string; status: string; current_node: string | null; next_run_at: Date | null; started_at: Date; plan: Projected[] };

/** Every live run (active/waiting) for a contact or a workflow, with what it will do next. */
export async function plannedRuns(where: { contactId?: string; workflowId?: string }): Promise<PlannedRun[]> {
  return asOperator(async (c) => {
    const rows = await many<RunRow & { workflow: string; contact: string }>(c, `select r.*, w.name as workflow, coalesce(nullif(trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')),''), u.name, 'the company') as contact
      from runs r join workflows w on w.id=r.workflow_id left join contacts ct on ct.id=r.contact_id left join users u on u.id=r.user_id
      where r.status in ('active','waiting') and ${where.contactId ? "r.contact_id=$1" : "r.workflow_id=$1"} order by r.next_run_at nulls first, r.started_at`, [where.contactId ?? where.workflowId]);
    if (!rows.length) return [];
    const { row: company, bindings } = await loadCompany(c, rows[0].company_id);
    const defs = new Map<string, ReturnType<typeof parseDefinition> | null>();
    const out: PlannedRun[] = [];
    for (const r of rows) {
      const key = `${r.workflow_id}:${r.workflow_version}`;
      if (!defs.has(key)) { const v = await one<{ definition: unknown }>(c, "select definition from workflow_versions where workflow_id=$1 and version=$2", [r.workflow_id, r.workflow_version]); let d = null; try { d = v ? parseDefinition(v.definition) : null; } catch { d = null; } defs.set(key, d); }
      const def = defs.get(key);
      let plan: Projected[] = [];
      if (def) { try { plan = projectRun(def, r, company, await buildContext(c, r, company, bindings)); } catch { plan = []; } }
      out.push({ run_id: r.id, workflow_id: r.workflow_id, workflow: r.workflow, contact_id: r.contact_id, contact: r.contact.trim(), status: r.status, current_node: r.current_node, next_run_at: r.next_run_at, started_at: r.started_at!, plan });
    }
    return out;
  });
}
