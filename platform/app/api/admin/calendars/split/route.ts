import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { callsByTime } from "@/engine/contact-ops";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/** D205: POST { company, calendar, future: email, past: email, why, dryRun = true, limit? }: a calendar's upcoming calls to one person, its past ones to another, with their Discovery Call records in GHL. Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; calendar?: string; future?: string; past?: string; why?: string; dryRun?: boolean; limit?: number } | null;
  if (!b?.company) return NextResponse.json({ error: "company, calendar, future, past and why are required" }, { status: 400 });
  const r = await asOperator((c) => callsByTime(c, liveAdapters, { company: b.company!, calendar: b.calendar ?? "", future: b.future ?? "", past: b.past ?? "", why: b.why ?? "", dryRun: b.dryRun, limit: b.limit }));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
