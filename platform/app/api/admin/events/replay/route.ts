import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { dispatchEvent, eventMatchContext, workflowTakes, type EventRow } from "@/engine/dispatch";
import { findCompanyWorkflow } from "@/engine/definitions";
import { runCompanyNow } from "@/api/run-soon";
import { after } from "next/server";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/**
 * D232. POST { company, workflow (name | id | slug), events: [event ids], dryRun = true } with Authorization: Bearer $CRON_SECRET:
 * events the engine recorded but started nothing for (a relinked payment, D229) run through that one workflow, as if they had
 * just happened, in the workflow's own mode. The dry run says, for each, whether that workflow takes it and whether it already
 * ran for it; an event it already ran for is never run again. Audited. D256: each is matched with what it was first dispatched with
 * (its booking and the booking's call type, its recording), and "takes" is the trigger's own answer, its match included.
 * D257: `again: true` with `why` runs an event the workflow already ran for once more (a step added since); still audited.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json()) as { company?: string; workflow?: string; events?: number[]; dryRun?: boolean; again?: boolean; why?: string };
  if (!body.company || !body.workflow || !body.events?.length) return NextResponse.json({ error: "company, workflow and events are required" }, { status: 400 });
  // D257: an event the workflow already ran for is run again only when the operator says so, with why (a step added since, e.g. a closer card)
  if (body.again && !body.why?.trim()) return NextResponse.json({ error: "again needs why" }, { status: 400 });
  const dryRun = body.dryRun !== false;
  try {
    const r = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]); if (!co) throw new Error("company not found");
      const w = await findCompanyWorkflow(c, co.id, body.workflow!); if (!w.ok) throw new Error(w.why);
      const evs = await many<EventRow>(c, "select * from events where company_id=$1 and id = any($2::bigint[]) order by occurred_at, id", [co.id, body.events]);
      const rows = [];
      for (const e of evs) {
        // D256: matched as it was the first time (its booking with the call type, its recording), and "takes" is the trigger's own answer
        const ctx = await eventMatchContext(c, e);
        const takes = await workflowTakes(c, e, ctx, w.id);
        const ran = await one(c, "select 1 from runs where workflow_id=$1 and triggered_by_event=$2", [w.id, e.id]);
        const row: Record<string, unknown> = { event: e.id, type: e.event_type, occurred_at: e.occurred_at, data: e.data, takes, already_ran: !!ran };
        // D257: again only after the earlier run is over (a run still going is never doubled); its re-entry key is retired, as D210's restart does
        const going = ran && body.again ? await one(c, "select 1 from runs where workflow_id=$1 and triggered_by_event=$2 and status not in ('completed','exited','failed')", [w.id, e.id]) : null;
        if (ran && body.again) { row.again = !going; if (going) row.why = "its earlier run is still going"; }
        if (!dryRun && takes && (!ran || (body.again && !going))) {
          if (ran) await c.query("update runs set reentry_key = reentry_key || ':again:' || id::text where workflow_id=$1 and triggered_by_event=$2 and reentry_key not like '%:again:%'", [w.id, e.id]);
          row.runs = await dispatchEvent(c, e, ctx, { workflowId: w.id });
        }
        rows.push(row);
      }
      if (!dryRun) await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'events.replayed','workflow',$2,$3)", [co.id, w.id, { events: body.events, ...(body.again ? { again: true, why: body.why } : {}), rows: rows.map((x) => ({ event: x.event, runs: x.runs ?? [] })) }]);
      return { companyId: co.id, workflow: w.id, rows };
    });
    if (!dryRun) after(() => runCompanyNow(r.companyId));
    return NextResponse.json({ ok: true, dryRun, workflow: r.workflow, rows: r.rows });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
