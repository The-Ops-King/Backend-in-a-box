import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { callCloser } from "@/engine/contact-ops";
import { liveAdapters } from "@/adapters";
export const dynamic = "force-dynamic";

/** D218: POST { company, appointments: [id, booking id or slot key], closer: email, why, dryRun = true }: who took these calls, past ones too: the booking's closer and its Sales Call's Closer field. Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; appointments?: string[]; closer?: string; why?: string; dryRun?: boolean } | null;
  if (!b?.company) return NextResponse.json({ error: "company, appointments, closer and why are required" }, { status: 400 });
  const r = await asOperator((c) => callCloser(c, liveAdapters, { company: b.company!, appointments: b.appointments ?? [], closer: b.closer ?? "", why: b.why ?? "", dryRun: b.dryRun }));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
