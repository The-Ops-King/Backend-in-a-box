import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { backfillPitched } from "@/engine/pitched-backfill";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/**
 * D226 backfill. POST { company, from, to, exclude?: [closer emails], dryRun = true, decide?: { appointment id: true | false } } with
 * Authorization: Bearer $CRON_SECRET. The dry run reads each recorded closing call nobody has answered for and says whether it was
 * pitched, with the line that shows it. The write sets only the bookings named in `decide`, where nobody has said yet. Audited.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json()) as { company?: string; from?: string; to?: string; exclude?: string[]; dryRun?: boolean; decide?: Record<string, boolean> };
  if (!body.company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  const dryRun = body.dryRun !== false;
  const from = new Date(body.from ?? ""), to = body.to ? new Date(body.to) : new Date();
  if (dryRun && (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to)) return NextResponse.json({ error: "from and to must be times, from before to" }, { status: 400 });
  if (!dryRun && !body.decide) return NextResponse.json({ error: "the write takes decide: { appointment id: true | false }" }, { status: 400 });
  try {
    const r = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]); if (!co) throw new Error("company not found");
      return backfillPitched(c, liveAdapters, co.id, { from, to, exclude: body.exclude, dryRun, decide: body.decide });
    });
    return NextResponse.json({ ok: true, dryRun, ...r });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
