import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { contactsReassign } from "@/engine/contact-ops";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

/** D204: POST { company, from: email, to: email, tag, why, dryRun = true }: hand one offer's contacts with that owner and tag to another team member in GHL. Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; from?: string; to?: string; tag?: string; why?: string; dryRun?: boolean } | null;
  if (!b?.company) return NextResponse.json({ error: "company, from, to, tag and why are required" }, { status: 400 });
  const r = await asOperator((c) => contactsReassign(c, liveAdapters, { company: b.company!, from: b.from ?? "", to: b.to ?? "", tag: b.tag ?? "", why: b.why ?? "", dryRun: b.dryRun }));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
