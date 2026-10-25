import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { opportunityStatus } from "@/engine/contact-ops";
export const dynamic = "force-dynamic";

/** D233: POST { company, contact (GHL id or ours), status: "won" | "open", at?, why, dryRun = true }: the person's deal in the engine. Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; contact?: string; status?: "won" | "open"; at?: string; why?: string; dryRun?: boolean } | null;
  if (!b?.company) return NextResponse.json({ error: "company, contact, status and why are required" }, { status: 400 });
  const r = await asOperator((c) => opportunityStatus(c, { company: b.company!, contact: b.contact ?? "", status: b.status as "won", at: b.at, why: b.why ?? "", dryRun: b.dryRun }));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
