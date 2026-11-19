import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { callSetter } from "@/engine/contact-ops";
import { liveAdapters } from "@/adapters";
export const dynamic = "force-dynamic";

/** D351: POST { company, appointments: [id, booking id or slot key], setter: email, via?: "dm" | "ghl", why, dryRun = true }: who set these calls, everywhere Call booked wrote it (the booking, its Sales Call's Setter, Set Via and Booking Source, the person's Setter field, the Setter Owner on their open cards). Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; appointments?: string[]; setter?: string; via?: string; why?: string; dryRun?: boolean } | null;
  if (!b?.company) return NextResponse.json({ error: "company, appointments, setter and why are required" }, { status: 400 });
  const r = await asOperator((c) => callSetter(c, liveAdapters, { company: b.company!, appointments: b.appointments ?? [], setter: b.setter ?? "", via: b.via, why: b.why ?? "", dryRun: b.dryRun }));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
