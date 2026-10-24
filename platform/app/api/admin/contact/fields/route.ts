import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { contactFields } from "@/engine/contact-ops";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/** D233: POST { company, contact (GHL id or ours), fields: { <field binding or GHL field id>: value }, why, dryRun = true }: one contact's custom fields in GHL and the replica. Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; contact?: string; fields?: Record<string, string | number>; why?: string; dryRun?: boolean } | null;
  if (!b?.company) return NextResponse.json({ error: "company, contact, fields and why are required" }, { status: 400 });
  try {
    const r = await asOperator((c) => contactFields(c, liveAdapters, { company: b.company!, contact: b.contact ?? "", fields: b.fields ?? {}, why: b.why ?? "", dryRun: b.dryRun }));
    return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
  } catch (e) { return NextResponse.json({ error: `GHL refused: ${String((e as Error).message).slice(0, 300)}` }, { status: 502 }); }
}
