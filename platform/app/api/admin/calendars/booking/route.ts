import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { calendarBooking } from "@/engine/contact-ops";
export const dynamic = "force-dynamic";

/** D283: POST { company, calendar: external id or name, booking: self | setter | question | utm, why, dryRun = true }: how a watched calendar's bookings are read. Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; calendar?: string; booking?: string; why?: string; dryRun?: boolean } | null;
  if (!b?.company) return NextResponse.json({ error: "company, calendar, booking and why are required" }, { status: 400 });
  const r = await asOperator((c) => calendarBooking(c, { company: b.company!, calendar: b.calendar ?? "", booking: b.booking ?? "", why: b.why ?? "", dryRun: b.dryRun }));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
