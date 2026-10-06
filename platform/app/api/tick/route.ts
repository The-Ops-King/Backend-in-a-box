import { NextResponse } from "next/server";
import { liveAdapters } from "@/adapters";
import { pollAll } from "@/engine/poll";
import { tick } from "@/engine/runner";
import { withTickLock } from "@/engine/lock";
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
  return NextResponse.json({ ok: true, mode, ms: Date.now() - started, ...out.result });
}
