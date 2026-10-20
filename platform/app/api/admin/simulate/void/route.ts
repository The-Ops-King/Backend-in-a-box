import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { voidStagedBookings } from "@/engine/simulate";
export const dynamic = "force-dynamic";

/**
 * POST { company: <slug>, appointments: [ids], dryRun?: boolean, by? } with Authorization: Bearer $CRON_SECRET: void staged (test)
 * bookings left over from a rehearsal, so they leave the end-of-day form and the numbers without starting any workflow. A real
 * booking is refused. Audited.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; appointments?: unknown; dryRun?: boolean; by?: string } | null;
  const ids = Array.isArray(b?.appointments) ? b!.appointments.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)) : [];
  if (!b?.company || !ids.length) return NextResponse.json({ error: "company and appointments (booking ids) are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]);
    if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    return NextResponse.json({ ok: true, dryRun: !!b.dryRun, ...(await voidStagedBookings(c, co.id, ids, b.by || "operator", !!b.dryRun)) });
  });
}
