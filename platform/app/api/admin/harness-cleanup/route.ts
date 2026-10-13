import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { clearStrayHarnessBookings } from "@/engine/golive";
import { operatorAuthorized } from "@/engine/admin-auth";
export const dynamic = "force-dynamic";

/** POST { company, dryRun? } with Authorization: Bearer $CRON_SECRET (D97): remove test-harness bookings on real people and the rehearsal runs they started. A dry run counts them and names the people. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { company?: string; dryRun?: boolean };
  if (!body.company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  try {
    const out = await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [body.company]);
      return co ? clearStrayHarnessBookings(c, co.id, !!body.dryRun) : null;
    });
    return out ? NextResponse.json({ ok: true, dryRun: !!body.dryRun, ...out }) : NextResponse.json({ error: "company not found" }, { status: 404 });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
