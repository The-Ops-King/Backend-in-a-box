import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { contactMerged } from "@/engine/contact-ops";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/** D235: POST { company, gone (GHL id or ours), into (GHL id or ours), why, dryRun = true }: a merge done in GHL, followed in the engine. Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; gone?: string; into?: string; why?: string; dryRun?: boolean } | null;
  if (!b?.company) return NextResponse.json({ error: "company, gone, into and why are required" }, { status: 400 });
  const r = await asOperator((c) => contactMerged(c, liveAdapters, { company: b.company!, gone: b.gone ?? "", into: b.into ?? "", why: b.why ?? "", dryRun: b.dryRun }));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
