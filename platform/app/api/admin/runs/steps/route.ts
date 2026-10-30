import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * Read only, for an audit of what an offer's workflows did or would have done (Tyler, 2026-10-30: "do an audit of the last few weeks
 * and see how the engine WOULD have done"). GET ?company=<slug>&workflow=<name>&days=21&limit=200: each run in the window, newest
 * first, with its person, status, exit reason and every step's status and result (a ghost step's "would" included). Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams, slug = q.get("company"), name = q.get("workflow");
  const days = Math.min(90, Math.max(1, Number(q.get("days") ?? 21) || 21)), limit = Math.min(1000, Math.max(1, Number(q.get("limit") ?? 200) || 200));
  if (!slug || !name) return NextResponse.json({ error: "company and workflow are required" }, { status: 400 });
  const out = await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return null;
    const runs = await many<{ id: string; started_at: Date; status: string; exit_reason: string | null; mode: string | null; contact: string | null; ghl_contact_id: string | null; appointment_id: string | null; trigger: string | null }>(c, `
      select r.id, r.started_at, r.status, r.exit_reason, r.context->>'mode' as mode, nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), '') as contact, ct.ghl_contact_id, r.appointment_id::text,
             (select e.event_type from events e where e.id = (r.context->'event'->>'id')::bigint) as trigger
      from runs r join workflows w on w.id=r.workflow_id left join contacts ct on ct.id=r.contact_id
      where r.company_id=$1 and w.name=$2 and r.started_at > now() - make_interval(days => $3) order by r.started_at desc limit $4`, [co.id, name, days, limit]);
    const steps = runs.length ? await many<{ run_id: string; node_id: string; status: string; result: unknown; error: string | null }>(c,
      "select run_id::text, node_id, status, result, left(error, 500) as error from run_steps where run_id = any($1::uuid[]) order by started_at, id", [runs.map((r) => r.id)]) : [];
    return runs.map((r) => ({ ...r, steps: steps.filter((s) => s.run_id === r.id).map(({ run_id: _r, ...s }) => s) }));
  });
  return out ? NextResponse.json({ ok: true, runs: out }) : NextResponse.json({ error: "no such company" }, { status: 404 });
}
