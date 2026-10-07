import { NextResponse } from "next/server";
import { liveAdapters } from "@/adapters";
import { pollAll } from "@/engine/poll";
import { tick } from "@/engine/runner";
import { withTickLock } from "@/engine/lock";
import { asOperator } from "@/db/client";
import { announce, collectProblems } from "@/engine/alerts";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Vercel cron hits this every minute with Authorization: Bearer $CRON_SECRET. One tick = poll everything, then run what's due. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  const mode = new URL(req.url).searchParams.get("mode") ?? "tick";   // "sweep" = Vercel daily cron; "tick" = the minute/5-minute scheduler
  const out = await withTickLock(async () => ({ poll: await pollAll(liveAdapters), runs: await tick(liveAdapters) }));
  if (out.busy) return NextResponse.json({ ok: true, mode, busy: true, ms: Date.now() - started });   // another tick holds the lease; nothing to do
  // the engine reports its own problems to the operator; a failure here must never fail the tick
  const alerted = await asOperator(async (c) => announce(c, await collectProblems(c, out.result.poll, out.result.runs))).catch(() => []);
  return NextResponse.json({ ok: true, mode, ms: Date.now() - started, ...out.result, alerted: alerted.length });
}
