import { NextResponse } from "next/server";
import { liveAdapters } from "@/adapters";
import { pollAll } from "@/engine/poll";
import { tick } from "@/engine/runner";
import { withTickLock } from "@/engine/lock";
import { asOperator } from "@/db/client";
import { tickAlerts } from "@/engine/alerts";
import { runDueReports } from "@/engine/reports";
import { runDueHealth, checkCalendarsAfterBookings } from "@/engine/health";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Vercel cron hits this every minute with Authorization: Bearer $CRON_SECRET. One tick = poll everything, then run what's due. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  const mode = new URL(req.url).searchParams.get("mode") ?? "tick";   // "sweep" = Vercel daily cron; "tick" = the minute/5-minute scheduler
  const out = await withTickLock(async () => ({ poll: await pollAll(liveAdapters), runs: await tick(liveAdapters),
    reports: await asOperator((c) => runDueReports(c)).catch((e) => ({ generated: [], errors: [{ company: "*", error: String((e as Error).message) }] })),
    health: await asOperator((c) => runDueHealth(c, liveAdapters)).catch((e) => ({ swept: [], errors: [{ company: "*", error: String((e as Error).message) }] })),
    calendars: await asOperator((c) => checkCalendarsAfterBookings(c, liveAdapters)).catch((e) => ({ checked: [], error: String((e as Error).message).slice(0, 200) })) }));
  if (out.busy) return NextResponse.json({ ok: true, mode, busy: true, ms: Date.now() - started });   // another tick holds the lease; nothing to do
  // the engine reports its own problems to the operator (D33); a failure here must never fail the tick
  const alerts = await asOperator((c) => tickAlerts(c, liveAdapters, out.result.poll, out.result.runs)).catch((e) => ({ error: String((e as Error).message).slice(0, 200) }));
  return NextResponse.json({ ok: true, mode, ms: Date.now() - started, ...out.result, alerts });
}
