import { NextResponse } from "next/server";
import { liveAdapters } from "@/adapters";
import { pollAll } from "@/engine/poll";
import { tick } from "@/engine/runner";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Vercel cron hits this every minute with Authorization: Bearer $CRON_SECRET. One tick = poll everything, then run what's due. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  const poll = await pollAll(liveAdapters);
  const runs = await tick(liveAdapters);
  return NextResponse.json({ ok: true, ms: Date.now() - started, poll, runs });
}
