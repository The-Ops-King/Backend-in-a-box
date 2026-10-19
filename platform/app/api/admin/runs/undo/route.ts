import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { undoRunWrites, type UndoAsk } from "@/engine/undo";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D142: take back what runs made in the CRM. POST { company, runs: [run ids], nodes?: [step ids], why, dryRun = true, by? }
 * → { writes: [{ run_id, node_id, kind: card | task | record, external_id }], kept }. Only what the engine's ledger says the run
 * created; never a note, a sent document or a record taken over from GHL. Audited. Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as UndoAsk | null;
  if (!b?.company) return NextResponse.json({ error: "company, runs and why are required" }, { status: 400 });
  const r = await asOperator((c) => undoRunWrites(c, liveAdapters, b));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
