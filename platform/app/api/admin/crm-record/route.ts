import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D137: one GHL custom object record, put right by the operator. POST { company, object, record_id, why, dryRun = true, and one of:
 *   properties: { <key>: value }           set these fields on the record (any record);
 *   delete: true                           remove it, only when the engine made it (a crm_records row): never a record GHL or a person made;
 *   key: <booking key>                     make this record the engine's record for that booking (the slot or booking id), as if it had written it }
 * The dry run answers the record as GHL has it and what would change. Audited. Authorization: Bearer $CRON_SECRET.
 */
type Body = { company?: string; object?: string; record_id?: string; why?: string; dryRun?: boolean; properties?: Record<string, unknown>; delete?: boolean; key?: string };
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as Body | null;
  if (!b?.company || !b.object || !b.record_id || !b.why?.trim()) return NextResponse.json({ error: "company, object, record_id and why are required" }, { status: 400 });
  const acts = [b.properties ? "properties" : null, b.delete ? "delete" : null, b.key ? "key" : null].filter(Boolean);
  if (acts.length !== 1) return NextResponse.json({ error: "one of properties, delete or key" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany, bindings } = await loadCompany(c, co.id);
    const object = b.object!.startsWith("{{") ? "" : bindings[b.object!] || b.object!;
    const rec = (await liveAdapters.read.objectRecords(adapterCompany, object)).find((r) => r.id === b.record_id);
    if (!rec) return NextResponse.json({ error: `no record ${b.record_id} in ${object}` }, { status: 404 });
    const ours = await one<{ id: string; record_key: string }>(c, "select id, record_key from crm_records where company_id=$1 and ghl_record_id=$2", [co.id, b.record_id]);
    if (b.delete && !ours) return NextResponse.json({ error: "the engine did not make this record: it is never deleted from here" }, { status: 409 });
    const plan = { object, record: rec, change: b.properties ? { properties: b.properties } : b.delete ? { delete: true, record_key: ours!.record_key } : { key: b.key } };
    if (b.dryRun !== false) return NextResponse.json({ ok: true, dryRun: true, ...plan });
    if (b.properties) await liveAdapters.write.updateRecord(adapterCompany, object, b.record_id!, b.properties);
    if (b.delete) {
      if (!liveAdapters.write.deleteRecord) return NextResponse.json({ error: "this CRM adapter cannot delete records" }, { status: 501 });
      await liveAdapters.write.deleteRecord(adapterCompany, object, b.record_id!);
      await c.query("delete from crm_records where id=$1", [ours!.id]);
    }
    if (b.key) {
      await c.query("delete from crm_records where company_id=$1 and object_key=$2 and record_key=$3 and ghl_record_id<>$4", [co.id, object, b.key, b.record_id]);
      await c.query(`insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id) values ($1,$2,$3,$4,(select ct.id from contacts ct where ct.company_id=$1 and ct.ghl_contact_id=$5 limit 1))
        on conflict do nothing`, [co.id, object, b.key, b.record_id, String(rec.properties.contact_id ?? "")]);
    }
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'crm_record.repair','crm_record',$2,$3,$4)", [co.id, null, { record: b.record_id, properties: rec.properties }, { ...plan.change, why: b.why, via: "api" }]);
    return NextResponse.json({ ok: true, dryRun: false, ...plan });
  });
}
