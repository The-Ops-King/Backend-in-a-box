import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { repairUnfinishedCalls } from "@/engine/call-repair";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/** D273: POST { company, why, dryRun = true, limit = 50 }: calls left "ringing" by the poll, read from GHL again and corrected silently (see `repairUnfinishedCalls`). Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; why?: string; dryRun?: boolean; limit?: number } | null;
  if (!b?.company) return NextResponse.json({ error: "company and why are required" }, { status: 400 });
  try {
    const r = await asOperator((c) => repairUnfinishedCalls(c, liveAdapters, { company: b.company!, why: b.why ?? "", dryRun: b.dryRun !== false, limit: typeof b.limit === "number" ? b.limit : undefined }));
    return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
