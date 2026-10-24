import type { PoolClient } from "pg";
import { one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import { loadCompany } from "./context";
import { propertyValue } from "./executor";

/** D137: what the operator asked of one record (see app/api/admin/crm-record). */
export type RecordRepair = { company: string; object: string; record_id: string; why: string; dryRun?: boolean; properties?: Record<string, unknown>; delete?: boolean; force?: boolean; key?: string;
  /** D233: make a record the engine should have made, under its key, with `properties`, related as a workflow step would ({ association: binding or id, first?, second? }: the other side's GHL id; the new record is the side left out) */
  create?: { key: string; contact_id?: string; relate?: Array<{ association: string; first?: string; second?: string }> } };
export type RepairResult = { ok: true; dryRun: boolean; object: string; record: { id: string; properties: Record<string, unknown> }; change: Record<string, unknown> } | { ok: false; status: number; error: string };

/**
 * One GHL custom object record, put right by the operator: its fields set, a record the engine made removed (never one GHL or a
 * person made: a record the engine only took over is `adopted`), or a record made the engine's for a booking (adopted when the
 * engine did not make it). The record the engine had for that booking stays known as the engine's under a `replaced:` key.
 */
export async function repairRecord(c: PoolClient, adapters: Adapters, b: RecordRepair): Promise<RepairResult> {
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return { ok: false, status: 404, error: "no such company" };
  const { adapterCompany, bindings } = await loadCompany(c, co.id);
  const object = bindings[b.object] || b.object;
  if (b.create) return createRecordFor(c, adapters, co.id, adapterCompany, bindings, object, b);
  const acts = [b.properties ? "properties" : null, b.delete ? "delete" : null, b.key ? "key" : null].filter(Boolean);
  if (acts.length !== 1) return { ok: false, status: 400, error: "one of properties, delete, key or create" };
  const rec = (await adapters.read.objectRecords(adapterCompany, object)).find((r) => r.id === b.record_id);
  if (!rec) return { ok: false, status: 404, error: `no record ${b.record_id} in ${object}` };
  const ours = await one<{ id: string; record_key: string; adopted: boolean }>(c, "select id, record_key, adopted from crm_records where company_id=$1 and ghl_record_id=$2", [co.id, b.record_id]);
  if (b.delete && ours?.adopted) return { ok: false, status: 409, error: "GHL or a person made this record and the engine only took it over: it is never deleted from here" };
  if (b.delete && !ours && b.force !== true) return { ok: false, status: 409, error: "the engine has no record of making this: it is not deleted unless you say force (and why)" };
  // each field as its type wants it (a money field is { currency, value }, as a workflow step writes it); a field the object does not
  // have is refused here, dry run included, since GHL would refuse the whole write over it
  const typed = await typedProperties(adapters, adapterCompany, object, b.properties);
  if (typed && "error" in typed) return { ok: false, status: 400, error: typed.error };
  const properties = typed?.properties;
  const change = properties ? { properties } : b.delete ? { delete: true, record_key: ours?.record_key ?? null, ...(ours ? {} : { forced: true }) } : { key: b.key };
  const plan = { object, record: { id: rec.id, properties: rec.properties }, change };
  if (b.dryRun !== false) return { ok: true, dryRun: true, ...plan };
  if (properties) {
    try { await adapters.write.updateRecord(adapterCompany, object, b.record_id, properties); }
    catch (e) { return { ok: false, status: 502, error: `GHL refused the write: ${String((e as Error).message).slice(0, 300)}` }; }
  }
  if (b.delete) {
    if (!adapters.write.deleteRecord) return { ok: false, status: 501, error: "this CRM adapter cannot delete records" };
    await adapters.write.deleteRecord(adapterCompany, object, b.record_id);
    if (ours) await c.query("delete from crm_records where id=$1", [ours.id]);
  }
  if (b.key) {
    // the record it replaces stays known as the engine's (so it may still be removed), under a key no booking has
    await c.query("update crm_records set record_key='replaced:' || record_key || ':' || coalesce(ghl_record_id,''), updated_at=now() where company_id=$1 and object_key=$2 and record_key=$3 and ghl_record_id is distinct from $4", [co.id, object, b.key, b.record_id]);
    await c.query(`insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id, adopted) values ($1,$2,$3,$4,(select ct.id from contacts ct where ct.company_id=$1 and ct.ghl_contact_id=$5 limit 1), $6)
      on conflict (company_id, object_key, record_key) do update set ghl_record_id=excluded.ghl_record_id, adopted=excluded.adopted, updated_at=now()`, [co.id, object, b.key, b.record_id, String(rec.properties.contact_id ?? ""), !ours || ours.adopted]);
  }
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'crm_record.repair','crm_record',$2,$3,$4)", [co.id, null, { record: b.record_id, properties: rec.properties }, { ...change, why: b.why, via: "api" }]);
  return { ok: true, dryRun: false, ...plan };
}

/** Each value as its field's type wants it (a money field is { currency, value }, as a workflow step writes it); a field the object lacks is refused, since GHL would refuse the whole write over it. */
async function typedProperties(adapters: Adapters, ac: Company, object: string, properties?: Record<string, unknown>): Promise<{ properties: Record<string, unknown> } | { error: string } | undefined> {
  if (!properties) return undefined;
  if (!object.startsWith("custom_objects.") || !adapters.read.objectFields) return { properties };
  const types = new Map((await adapters.read.objectFields(ac, object)).map((f) => [f.key, f.type] as const));
  const unknown = Object.keys(properties).filter((k) => !types.has(k));
  if (types.size && unknown.length) return { error: `${object} has no field ${unknown.join(", ")}: nothing was written` };
  return { properties: Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, typeof v === "string" || typeof v === "number" ? propertyValue(k, String(v), types.get(k)) : v])) };
}

/** D233: a record the engine should have made and did not (Jennyfer Cantrell's $250 Cash record): made under its key, kept as the engine's, related, audited. Refused when the engine already has a record under that key. */
async function createRecordFor(c: PoolClient, adapters: Adapters, companyId: string, ac: Company, bindings: Record<string, string>, object: string, b: RecordRepair): Promise<RepairResult> {
  const cr = b.create!;
  if (!cr.key?.trim()) return { ok: false, status: 400, error: "create needs a key" };
  const have = await one<{ ghl_record_id: string | null }>(c, "select ghl_record_id from crm_records where company_id=$1 and object_key=$2 and record_key=$3", [companyId, object, cr.key]);
  if (have) return { ok: false, status: 409, error: `the engine already has a record under ${cr.key}: ${have.ghl_record_id}` };
  const typed = await typedProperties(adapters, ac, object, b.properties ?? {});
  if (typed && "error" in typed) return { ok: false, status: 400, error: typed.error };
  const properties = typed?.properties ?? {};
  const relate = (cr.relate ?? []).map((r) => ({ association: bindings[r.association] || r.association, first: r.first, second: r.second }));
  const change = { create: { key: cr.key, properties, relate } };
  if (b.dryRun !== false) return { ok: true, dryRun: true, object, record: { id: "(new)", properties: {} }, change };
  let id: string;
  try { id = (await adapters.write.createRecord(ac, object, properties)).id; }
  catch (e) { return { ok: false, status: 502, error: `GHL refused the record: ${String((e as Error).message).slice(0, 300)}` }; }
  await c.query(`insert into crm_records (company_id, object_key, record_key, ghl_record_id, contact_id, properties) values ($1,$2,$3,$4,(select ct.id from contacts ct where ct.company_id=$1 and ct.ghl_contact_id=$5 limit 1),$6)`,
    [companyId, object, cr.key, id, cr.contact_id ?? null, properties]);
  const related: string[] = [], failed: string[] = [];
  for (const r of relate) {
    try { await adapters.write.relateRecords(ac, r.association, r.first ?? id, r.second ?? id); related.push(r.association); }
    catch (e) { failed.push(`${r.association}: ${String((e as Error).message).slice(0, 160)}`); }
  }
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'crm_record.created','crm_record',$2,null,$3)", [companyId, id, { ...change, why: b.why, related, failed, via: "api" }]);
  return { ok: true, dryRun: false, object, record: { id, properties }, change: { ...change, related, failed } };
}
