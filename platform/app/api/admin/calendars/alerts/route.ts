import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { calendarAlerts } from "@/engine/contact-ops";
export const dynamic = "force-dynamic";

/** D213: POST { company, calendar: external id or name, alerts: boolean, why, dryRun = true }: whether a watched calendar's availability is alerted on (its bookings stay watched). Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; calendar?: string; alerts?: boolean; why?: string; dryRun?: boolean } | null;
  if (!b?.company) return NextResponse.json({ error: "company, calendar, alerts and why are required" }, { status: 400 });
  const r = await asOperator((c) => calendarAlerts(c, { company: b.company!, calendar: b.calendar ?? "", alerts: b.alerts as boolean, why: b.why ?? "", dryRun: b.dryRun }));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
