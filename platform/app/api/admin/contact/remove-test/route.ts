import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { removeTestContact } from "@/engine/contact-ops";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/** D142: POST { company, contact (GHL id or ours), why, dryRun = true }: a test contact taken out of GHL and the engine (see `removeTestContact`). Refused for anyone not a test contact. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; contact?: string; why?: string; dryRun?: boolean } | null;
  if (!b?.company) return NextResponse.json({ error: "company, contact and why are required" }, { status: 400 });
  const r = await asOperator((c) => removeTestContact(c, liveAdapters, { company: b.company!, contact: b.contact ?? "", why: b.why ?? "", dryRun: b.dryRun }));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
