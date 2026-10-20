import { NextResponse } from "next/server";
import { asOperator, many, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { replayBookings } from "@/engine/replay";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/**
 * D138. POST { company, appointments?: [ids], upcoming_without_runs?: true, baseline?: true, dryRun = true } with Authorization:
 * Bearer $CRON_SECRET: hand upcoming bookings to the booked-call workflows as the poll would (see `replayBookings`). `upcoming_without_runs`
 * picks every booking of the company whose call is ahead and has no run. `again: true` (named appointments only, D142) hands on one whose runs are all over;
 * what its earlier runs already sent the person is not sent again unless `force: true` (D193).
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; appointments?: string[]; upcoming_without_runs?: boolean; baseline?: boolean; again?: boolean; force?: boolean; dryRun?: boolean } | null;
  if (b?.again && !b.appointments?.length) return NextResponse.json({ error: "again: true needs the appointments named" }, { status: 400 });
  if (!b?.company || (!b.appointments?.length && !b.upcoming_without_runs)) return NextResponse.json({ error: "company, and appointments or upcoming_without_runs" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const ids = b.appointments?.length ? b.appointments : (await many<{ id: string }>(c, "select a.id from appointments a where a.company_id=$1 and a.source<>'test' and a.starts_at > now() and a.status<>'cancelled' and not exists (select 1 from runs r where r.appointment_id=a.id)", [co.id])).map((r) => r.id);
    const rows = await replayBookings(c, co.id, ids, { dryRun: b.dryRun !== false, baseline: b.baseline === true, again: b.again === true, force: b.again === true && b.force === true });
    return NextResponse.json({ ok: true, dryRun: b.dryRun !== false, count: rows.length, replay: rows.filter((r) => r.would === "replay").length, rows });
  });
}
