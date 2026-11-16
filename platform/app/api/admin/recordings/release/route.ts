import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { releaseBackfilled } from "@/engine/recording-release";
export const dynamic = "force-dynamic";

/**
 * D338: POST { company, recordings: [ids], why, dryRun = true }: recordings the history pass brought in silently get the event a live
 * delivery would have made (nothing runs yet; /api/admin/events/replay runs them, dry run first). Audited. Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; recordings?: string[]; why?: string; dryRun?: boolean } | null;
  if (!b?.company || !Array.isArray(b.recordings) || !b.recordings.length || !b.why) return NextResponse.json({ error: "company, recordings and why are required" }, { status: 400 });
  try {
    const r = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) throw new Error("no such company");
      return releaseBackfilled(c, co.id, b.recordings!, { dryRun: b.dryRun !== false, why: b.why! });
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message).slice(0, 300) }, { status: 400 }); }
}
