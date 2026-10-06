import { NextResponse } from "next/server";
import { migrate } from "@/db/migrate";
import { db } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
export const dynamic = "force-dynamic"; export const maxDuration = 120;
/** POST with Authorization: Bearer $CRON_SECRET. Applies engine/schema.sql if absent, forces RLS, creates engine_state. Idempotent. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const r = await migrate();
    return NextResponse.json({ ok: true, ...r });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
