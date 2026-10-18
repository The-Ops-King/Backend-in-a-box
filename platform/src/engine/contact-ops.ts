import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { loadCompany } from "./context";
import { testContactSql, testDomains, TEST_DOMAINS_KEY } from "./mode";

type Fail = { ok: false; status: number; error: string };
const company = (c: PoolClient, slug: string) => one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
const contactOf = (c: PoolClient, companyId: string, ref: string) =>
  one<{ id: string; ghl_contact_id: string | null; who: string; tags: string[] }>(c, "select id, ghl_contact_id, trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) as who, tags from contacts where company_id=$1 and (ghl_contact_id=$2 or id::text=$2) and merged_into is null", [companyId, ref]);

/**
 * D142 (Tyler: "clean up everything from tests"): a test contact (tagged sys-test, or an email on a test domain; never anyone
 * else) taken out: the custom object records the engine made for them deleted from GHL, then the GHL contact (GHL takes its
 * cards, tasks and notes with it), then the engine's runs, bookings, records and cards about them; the contact row stays, marked
 * gone. Audited with the why.
 */
export async function removeTestContact(c: PoolClient, adapters: Adapters, a: { company: string; contact: string; why: string; dryRun?: boolean }): Promise<{ ok: true; dryRun: boolean; who: string; ghl_contact_id: string | null; records: number; runs: number; appointments: number } | Fail> {
  if (!a.contact || !a.why?.trim()) return { ok: false, status: 400, error: "contact and why are required" };
  const co = await company(c, a.company); if (!co) return { ok: false, status: 404, error: "no such company" };
  const ct = await contactOf(c, co.id, a.contact); if (!ct) return { ok: false, status: 404, error: "no such contact" };
  const domains = testDomains({ [TEST_DOMAINS_KEY]: (await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key=$2", [co.id, TEST_DOMAINS_KEY]))?.value.toString("utf8") ?? "" });
  if (!(await one(c, `select 1 from contacts ct where ct.id=$1 and ${testContactSql("ct", "$2")}`, [ct.id, domains]))) return { ok: false, status: 409, error: `${ct.who || ct.id} is not a test contact (no sys-test tag, no email on a test domain): never removed from here` };
  const records = await many<{ id: string; object_key: string; ghl_record_id: string }>(c, "select id, object_key, ghl_record_id from crm_records where company_id=$1 and contact_id=$2 and ghl_record_id is not null and not adopted", [co.id, ct.id]);
  const runs = (await many<{ id: string }>(c, "select id from runs where company_id=$1 and contact_id=$2", [co.id, ct.id])).map((r) => r.id);
  const appts = (await many<{ id: string }>(c, "select id from appointments where company_id=$1 and contact_id=$2", [co.id, ct.id])).map((r) => r.id);
  const plan = { who: ct.who, ghl_contact_id: ct.ghl_contact_id, records: records.length, runs: runs.length, appointments: appts.length };
  if (a.dryRun !== false) return { ok: true, dryRun: true, ...plan };
  const { adapterCompany: ac } = await loadCompany(c, co.id);
  for (const r of records) { if (!adapters.write.deleteRecord) throw new Error("this CRM adapter cannot delete records"); await adapters.write.deleteRecord(ac, r.object_key, r.ghl_record_id); }
  if (ct.ghl_contact_id) { if (!adapters.write.deleteContact) throw new Error("this CRM adapter cannot delete contacts"); await adapters.write.deleteContact(ac, ct.ghl_contact_id); }
  const n = (sql: string, arg: unknown) => c.query(sql, [arg]);
  if (runs.length) {
    await n("update runs set triggered_by_event=null where triggered_by_event in (select id from events where run_id = any($1::uuid[]))", runs);
    for (const t of ["events", "sends", "run_steps", "step_effects"]) await n(`delete from ${t} where run_id = any($1::uuid[])`, runs);
    await n("delete from runs where id = any($1::uuid[])", runs);
  }
  if (appts.length) {
    await n("update runs set appointment_id=null where appointment_id = any($1::uuid[])", appts);
    for (const t of ["events", "recordings", "form_submissions"]) await n(`delete from ${t} where appointment_id = any($1::uuid[])`, appts);
    await n("delete from appointments where id = any($1::uuid[])", appts);
  }
  await c.query("delete from crm_records where company_id=$1 and contact_id=$2", [co.id, ct.id]);
  await c.query("delete from pipeline_cards where company_id=$1 and contact_id=$2", [co.id, ct.id]);
  await c.query("update contacts set gone_at=now(), updated_at=now() where id=$1", [ct.id]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'contact.test_removed','contact',$2,$3,$4)", [co.id, ct.id, plan, { why: a.why }]);
  return { ok: true, dryRun: false, ...plan };
}

/** D142: tags put on or taken off one contact by the operator, in GHL and on the replica. Audited with the why. */
export async function contactTags(c: PoolClient, adapters: Adapters, a: { company: string; contact: string; add?: string[]; remove?: string[]; why: string; dryRun?: boolean }): Promise<{ ok: true; dryRun: boolean; who: string; add: string[]; remove: string[] } | Fail> {
  if (!a.contact || !a.why?.trim() || !(a.add?.length || a.remove?.length)) return { ok: false, status: 400, error: "contact, why and add or remove are required" };
  const co = await company(c, a.company); if (!co) return { ok: false, status: 404, error: "no such company" };
  const ct = await contactOf(c, co.id, a.contact); if (!ct?.ghl_contact_id) return { ok: false, status: 404, error: "no such contact in GHL" };
  const add = (a.add ?? []).filter((t) => !ct.tags.includes(t)), remove = (a.remove ?? []).filter((t) => ct.tags.includes(t));
  if (a.dryRun !== false) return { ok: true, dryRun: true, who: ct.who, add, remove };
  const { adapterCompany: ac } = await loadCompany(c, co.id);
  for (const t of add) await adapters.write.addTag(ac, ct.ghl_contact_id, t);
  for (const t of remove) await adapters.write.removeTag(ac, ct.ghl_contact_id, t);
  await c.query("update contacts set tags = array(select distinct unnest(array_cat(array(select x from unnest(tags) x where not x = any($3::text[])), $2::text[]))), updated_at=now() where id=$1", [ct.id, add, remove]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'contact.tags','contact',$2,$3)", [co.id, ct.id, { add, remove, why: a.why }]);
  return { ok: true, dryRun: false, who: ct.who, add, remove };
}
