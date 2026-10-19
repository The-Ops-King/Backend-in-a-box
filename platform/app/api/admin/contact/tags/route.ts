import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { contactTags } from "@/engine/contact-ops";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/** D142: POST { company, contact (GHL id or ours), add?: [tags], remove?: [tags], why, dryRun = true }: one contact's tags in GHL and the replica. Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; contact?: string; add?: string[]; remove?: string[]; why?: string; dryRun?: boolean } | null;
  if (!b?.company) return NextResponse.json({ error: "company, contact, why and add or remove are required" }, { status: 400 });
  const r = await asOperator((c) => contactTags(c, liveAdapters, { company: b.company!, contact: b.contact ?? "", add: b.add, remove: b.remove, why: b.why ?? "", dryRun: b.dryRun }));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
