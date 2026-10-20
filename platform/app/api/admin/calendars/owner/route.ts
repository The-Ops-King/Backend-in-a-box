import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { calendarOwner } from "@/engine/contact-ops";
export const dynamic = "force-dynamic";

/** D204: POST { company, calendar: external id or name, owner: email, why, dryRun = true }: who a watched calendar's calls belong to, its upcoming bookings too. Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; calendar?: string; owner?: string; why?: string; dryRun?: boolean } | null;
  if (!b?.company) return NextResponse.json({ error: "company, calendar, owner and why are required" }, { status: 400 });
  const r = await asOperator((c) => calendarOwner(c, { company: b.company!, calendar: b.calendar ?? "", owner: b.owner ?? "", why: b.why ?? "", dryRun: b.dryRun }));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
