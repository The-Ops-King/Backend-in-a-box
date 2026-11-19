import { NextResponse, after } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { dispatchEvent, emitEvent, workflowTakes } from "@/engine/dispatch";
import { findCompanyWorkflow } from "@/engine/definitions";
import { companyScopeTags, inScope } from "@/engine/scope";
import { runCompanyNow } from "@/api/run-soon";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/**
 * D352: POST { company, workflow (name | id | slug), contacts: [engine contact ids], data?: {..}, why, dryRun = true } with
 * Authorization: Bearer $CRON_SECRET: people who were already there when a workflow was built (TRC's dial cadence: Leap buyers who
 * never booked) are started in it as if they had just arrived. Each becomes one `operator.enrolled` event about them (`data` and
 * `why` as event.*), handed to that one workflow only, which must have a trigger on it. Its reentry rules hold (someone already in it
 * is not started twice); someone out of the offer's scope is refused. The dry run says, per person, whether they would start. Audited.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; workflow?: string; contacts?: string[]; data?: Record<string, unknown>; why?: string; dryRun?: boolean } | null;
  if (!b?.company || !b.workflow || !b.contacts?.length || !b.why?.trim()) return NextResponse.json({ error: "company, workflow, contacts and why are required" }, { status: 400 });
  if (b.contacts.length > 1000) return NextResponse.json({ error: "at most 1000 contacts a call" }, { status: 400 });
  const dry = b.dryRun !== false;
  try {
    const r = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) throw new Error("company not found");
      const w = await findCompanyWorkflow(c, co.id, b.workflow!); if (!w.ok) throw new Error(w.why);
      const takesIt = await one(c, "select 1 from workflow_triggers where workflow_id=$1 and event_type='operator.enrolled'", [w.id]);
      if (!takesIt) throw new Error(`${b.workflow} has no trigger on operator.enrolled`);
      const people = await many<{ id: string; name: string }>(c, "select id, coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), ghl_contact_id, id::text) as name from contacts where company_id=$1 and id = any($2::uuid[]) and merged_into is null", [co.id, b.contacts]);
      const tags = await companyScopeTags(c, co.id);
      const rows: Record<string, unknown>[] = [];
      for (const p of people) {
        const row: Record<string, unknown> = { contact: p.id, name: p.name };
        if (!(await inScope(c, p.id, tags))) { rows.push({ ...row, starts: false, why: "out of the offer's scope" }); continue; }
        const going = await one(c, "select 1 from runs where workflow_id=$1 and contact_id=$2 and status in ('active','waiting')", [w.id, p.id]);
        if (going) { rows.push({ ...row, starts: false, why: "already in it" }); continue; }
        if (dry) { rows.push({ ...row, starts: true }); continue; }
        const e = await emitEvent(c, { company_id: co.id, contact_id: p.id, opportunity_id: null, appointment_id: null, event_type: "operator.enrolled", source: "user", data: { ...(b.data ?? {}), why: b.why, workflow: w.id } });
        const ctx = { contact: { id: p.id } };
        const runs = (await workflowTakes(c, e, ctx, w.id)) ? await dispatchEvent(c, e, ctx, { workflowId: w.id }) : [];
        rows.push({ ...row, starts: runs.length > 0, ...(runs.length ? { run: runs[0] } : { why: "the workflow did not take it (its trigger's match, or its reentry)" }) });
      }
      const missing = b.contacts!.filter((id) => !people.find((p) => p.id === id));
      if (!dry) await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'workflow.enrolled','workflow',$2,$3)", [co.id, w.id, { why: b.why, data: b.data ?? {}, started: rows.filter((x) => x.starts).length, rows }]);
      return { companyId: co.id, workflow: w.id, rows, missing };
    });
    if (!dry) after(() => runCompanyNow(r.companyId));
    return NextResponse.json({ ok: true, dryRun: dry, workflow: r.workflow, would_start: r.rows.filter((x) => x.starts).length, rows: r.rows, missing: r.missing });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message).slice(0, 500) }, { status: 500 }); }
}
