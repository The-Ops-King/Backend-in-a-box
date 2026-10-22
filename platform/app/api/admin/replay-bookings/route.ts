import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { replayBookings } from "@/engine/replay";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/**
 * D138. POST { company, appointments?: [ids], upcoming_without_runs?: true, baseline?: true, dryRun = true } with Authorization:
 * Bearer $CRON_SECRET: hand upcoming bookings to the booked-call workflows as the poll would (see `replayBookings`). `upcoming_without_runs`
 * picks every booking of the company whose call is ahead and has no run. `again: true` (named appointments only, D142) hands on one whose runs are all over;
 * what its earlier runs already sent the person is not sent again unless `force: true` (D200).
 * D195: `workflow` (a name or template slug) with `upcoming: true` hands every real booking whose call is ahead to that one workflow only
 * (the pre-call, at the moment its sends are unlocked): no other workflow runs again; a booking with a run of it still going is skipped.
 * D210: `restart: true` with named `appointments` and a `workflow` stops that workflow's run of each and starts it afresh.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; appointments?: string[]; upcoming_without_runs?: boolean; upcoming?: boolean; workflow?: string; baseline?: boolean; again?: boolean; force?: boolean; restart?: boolean; dryRun?: boolean } | null;
  if (b?.again && !b.appointments?.length) return NextResponse.json({ error: "again: true needs the appointments named" }, { status: 400 });
  if (b?.upcoming && !b.workflow) return NextResponse.json({ error: "upcoming: true needs the workflow it hands them to" }, { status: 400 });
  if (!b?.company || (!b.appointments?.length && !b.upcoming_without_runs && !b.upcoming)) return NextResponse.json({ error: "company, and appointments, upcoming_without_runs, or upcoming with a workflow" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    let workflowId: string | undefined;
    if (b.workflow) {
      const w = await many<{ id: string }>(c, "select w.id from workflows w left join workflow_templates t on t.id=w.template_id where w.company_id=$1 and (t.slug=$2 or lower(w.name)=lower($2))", [co.id, b.workflow]);
      if (w.length !== 1) return NextResponse.json({ error: w.length ? "ambiguous workflow name" : "no such workflow for this company" }, { status: 404 });
      workflowId = w[0].id;
    }
    const ids = b.appointments?.length ? b.appointments : b.upcoming
      ? (await many<{ id: string }>(c, "select a.id from appointments a join contacts ct on ct.id=a.contact_id where a.company_id=$1 and a.source<>'test' and a.starts_at > now() and a.status<>'cancelled' and ct.gone_at is null", [co.id])).map((r) => r.id)
      : (await many<{ id: string }>(c, "select a.id from appointments a where a.company_id=$1 and a.source<>'test' and a.starts_at > now() and a.status<>'cancelled' and not exists (select 1 from runs r where r.appointment_id=a.id)", [co.id])).map((r) => r.id);
    const rows = await replayBookings(c, co.id, ids, { dryRun: b.dryRun !== false, baseline: b.baseline === true, again: b.again === true, force: b.again === true && b.force === true, workflowId, restart: b.restart === true && !!b.appointments?.length });
    return NextResponse.json({ ok: true, dryRun: b.dryRun !== false, count: rows.length, replay: rows.filter((r) => r.would === "replay").length, rows });
  });
}
