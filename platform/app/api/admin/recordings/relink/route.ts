import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { relinkRecording, type RelinkAsk } from "@/engine/recording-relink";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/**
 * D227: POST { company, recording, to: "rules" | "none" | <contact id>, why, dryRun = true, backfill = false }: a recording linked to the wrong person is
 * moved, and what it set off on them is put back (their booking's outcome, the tags, the card, what the runs made, the call note, the
 * Slack posts). D274: backfill links the right person without starting their workflows. The dry run says every part. Audited. Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as Partial<RelinkAsk> | null;
  if (!b?.company || !b.recording || !b.to) return NextResponse.json({ error: "company, recording, to and why are required" }, { status: 400 });
  const r = await asOperator((c) => relinkRecording(c, liveAdapters, b as RelinkAsk));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
