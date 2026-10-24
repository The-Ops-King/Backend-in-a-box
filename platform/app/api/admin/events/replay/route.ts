import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { dispatchEvent, type EventRow } from "@/engine/dispatch";
import { findCompanyWorkflow } from "@/engine/definitions";
import { runCompanyNow } from "@/api/run-soon";
import { after } from "next/server";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/**
 * D232. POST { company, workflow (name | id | slug), events: [event ids], dryRun = true } with Authorization: Bearer $CRON_SECRET:
 * events the engine recorded but started nothing for (a relinked payment, D229) run through that one workflow, as if they had
 * just happened, in the workflow's own mode. The dry run says, for each, whether that workflow takes it and whether it already
 * ran for it; an event it already ran for is never run again. Audited.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json()) as { company?: string; workflow?: string; events?: number[]; dryRun?: boolean };
  if (!body.company || !body.workflow || !body.events?.length) return NextResponse.json({ error: "company, workflow and events are required" }, { status: 400 });
  const dryRun = body.dryRun !== false;
  try {
    const r = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]); if (!co) throw new Error("company not found");
      const w = await findCompanyWorkflow(c, co.id, body.workflow!); if (!w.ok) throw new Error(w.why);
      const evs = await many<EventRow>(c, "select * from events where company_id=$1 and id = any($2::bigint[]) order by occurred_at, id", [co.id, body.events]);
      const rows = [];
      for (const e of evs) {
        const takes = await one(c, "select 1 from workflow_triggers where workflow_id=$1 and event_type=$2 and enabled", [w.id, e.event_type]);
        const ran = await one(c, "select 1 from runs where workflow_id=$1 and triggered_by_event=$2", [w.id, e.id]);
        const row: Record<string, unknown> = { event: e.id, type: e.event_type, occurred_at: e.occurred_at, data: e.data, takes: !!takes, already_ran: !!ran };
        if (!dryRun && takes && !ran) row.runs = await dispatchEvent(c, e, e.contact_id ? { contact: { id: e.contact_id } } : {}, { workflowId: w.id });
        rows.push(row);
      }
      if (!dryRun) await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'events.replayed','workflow',$2,$3)", [co.id, w.id, { events: body.events, rows: rows.map((x) => ({ event: x.event, runs: x.runs ?? [] })) }]);
      return { companyId: co.id, workflow: w.id, rows };
    });
    if (!dryRun) after(() => runCompanyNow(r.companyId));
    return NextResponse.json({ ok: true, dryRun, workflow: r.workflow, rows: r.rows });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
