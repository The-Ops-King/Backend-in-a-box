import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { calendarWatch } from "@/engine/contact-ops";
import { liveAdapters } from "@/adapters";
import type { BookingMode } from "@/adapters/types";
export const dynamic = "force-dynamic";

/** D215: POST { company, calendar: external id or name, term: closing | first_call | qualifying | follow_up, name?, owner?: email, booking?, why, dryRun = true }: one more of the booking tool's calendars watched, mapped as install maps one. Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; calendar?: string; term?: string; name?: string; owner?: string; booking?: BookingMode; why?: string; dryRun?: boolean } | null;
  if (!b?.company) return NextResponse.json({ error: "company, calendar, term and why are required" }, { status: 400 });
  const r = await asOperator((c) => calendarWatch(c, liveAdapters, { company: b.company!, calendar: b.calendar ?? "", term: b.term ?? "", name: b.name, owner: b.owner, booking: b.booking, why: b.why ?? "", dryRun: b.dryRun }));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
