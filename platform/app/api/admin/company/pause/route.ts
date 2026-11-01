import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { setPaused } from "@/engine/pause";
export const dynamic = "force-dynamic";

/** D298: POST { company, paused: boolean, why, dryRun = true }: pause one offer (the engine runs nothing for it) or unpause it (its first read back is silent). Audited. Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; paused?: boolean; why?: string; dryRun?: boolean } | null;
  if (!b?.company || typeof b.paused !== "boolean") return NextResponse.json({ error: "company, paused (true or false) and why are required" }, { status: 400 });
  const r = await asOperator((c) => setPaused(c, { company: b.company!, paused: b.paused!, why: b.why ?? "", dryRun: b.dryRun }));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
