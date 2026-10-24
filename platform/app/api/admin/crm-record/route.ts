import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { repairRecord, type RecordRepair } from "@/engine/crm-repair";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D137: one GHL custom object record, put right by the operator. POST { company, object, record_id, why, dryRun = true, and one of:
 *   properties: { <key>: value }           set these fields on the record (any record);
 *   delete: true                           remove it, only when the engine made it (its crm_records row, not adopted): never a record GHL or a person made;
 *                                          force: true overrides that for a record the operator knows the engine made and lost track of (logged with why);
 *   key: <booking key>                     make this record the engine's record for that booking (the slot or booking id);
 *   create: { key, contact_id?, relate? }    D233: make a record the engine should have made (no record_id), under its key, related as a step would }
 * `object` is the binding (crm.object_sales_call) or the object key. The dry run answers the record as GHL has it and what would
 * change. Audited. Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as Partial<RecordRepair> | null;
  if (!b?.company || !b.object || (!b.record_id && !b.create) || !b.why?.trim()) return NextResponse.json({ error: "company, object, record_id (or create) and why are required" }, { status: 400 });
  const r = await asOperator((c) => repairRecord(c, liveAdapters, b as RecordRepair));
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: r.status });
}
