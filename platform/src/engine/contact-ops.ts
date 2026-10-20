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

/**
 * D204: one offer's contacts handed to one team member in GHL (Tyler: "assign Nonie to all the contacts that mitch is assigned to
 * and have the 'dating' tag", then "reassign all NON NELLY contacts to camwall"). Whose: `from` (one owner), or `except` (anyone's,
 * no owner included, but these people's and the new owner's own). The list is the replica's (which holds only the offer's contacts),
 * carrying `tag`; each contact is read live in GHL first and changed only if it still matches, so one reassigned or untagged since
 * is left alone and said. A dry run (the default) lists them, grouped by current owner; re-running moves only what is left. Audited
 * once with every contact moved.
 */
export async function contactsReassign(c: PoolClient, adapters: Adapters, a: { company: string; from?: string; except?: string[]; to: string; tag: string; why: string; dryRun?: boolean }):
  Promise<{ ok: true; dryRun: boolean; from: string; to: string; count: number; byOwner: Record<string, number>; moved: number; contacts: string[]; skipped: { who: string; why: string }[] } | Fail> {
  if ((!a.from && !a.except?.length) || (a.from && a.except?.length) || !a.to || !a.tag?.trim() || !a.why?.trim()) return { ok: false, status: 400, error: "to, tag, why, and one of from (an owner) or except (owners to leave alone) are required" };
  const co = await company(c, a.company); if (!co) return { ok: false, status: 404, error: "no such company" };
  const who = (email: string) => one<{ name: string; ghl_user_id: string | null }>(c, "select name, ghl_user_id from users where company_id=$1 and lower(email)=lower($2)", [co.id, email.trim()]);
  const to = await who(a.to);
  if (!to?.ghl_user_id) return { ok: false, status: 404, error: `${a.to} is not a GHL user on this offer's roster: add them in GHL, then to the team (/team add)` };
  let from: { name: string; ghl_user_id: string } | null = null; const keep: string[] = [to.ghl_user_id]; const kept: string[] = [];
  if (a.from) { const f = await who(a.from); if (!f?.ghl_user_id) return { ok: false, status: 404, error: `${a.from} is not a GHL user on this offer's roster` }; from = { name: f.name, ghl_user_id: f.ghl_user_id }; }
  for (const e of a.except ?? []) { const k = await who(e); if (!k?.ghl_user_id) return { ok: false, status: 404, error: `${e} is not a GHL user on this offer's roster` }; keep.push(k.ghl_user_id); kept.push(k.name); }
  const matches = (owner: string | null | undefined) => (from ? owner === from.ghl_user_id : !keep.includes(owner ?? ""));
  const list = (await many<{ id: string; ghl_contact_id: string; who: string; owner: string | null; owner_name: string | null }>(c, `select ct.id, ct.ghl_contact_id, coalesce(nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''), ct.ghl_contact_id) as who,
      ct.assigned_ghl_user_id as owner, u.name as owner_name from contacts ct left join users u on u.company_id=ct.company_id and u.ghl_user_id=ct.assigned_ghl_user_id
    where ct.company_id=$1 and $2 = any(ct.tags) and ct.ghl_contact_id is not null and ct.gone_at is null and ct.merged_into is null order by who`, [co.id, a.tag.trim()]))
    .filter((x) => matches(x.owner));
  const byOwner: Record<string, number> = {};
  for (const x of list) { const k = x.owner_name ?? (x.owner ? `someone not on the roster (${x.owner})` : "no owner"); byOwner[k] = (byOwner[k] ?? 0) + 1; }
  const base = { from: from ? from.name : `anyone but ${[...kept, to.name].join(" and ")}`, to: to.name, count: list.length, byOwner };
  if (a.dryRun !== false) return { ok: true, dryRun: true, ...base, moved: 0, contacts: list.map((x) => x.who), skipped: [] };
  const { adapterCompany: ac } = await loadCompany(c, co.id);
  const moved: { id: string; who: string }[] = [], skipped: { who: string; why: string }[] = [];
  for (const x of list) {
    try {
      const live = await adapters.read.getContact(ac, x.ghl_contact_id);
      if (!live) { skipped.push({ who: x.who, why: "gone from GHL" }); continue; }
      if (!matches(live.assignedTo)) { skipped.push({ who: x.who, why: live.assignedTo === to.ghl_user_id ? `already ${to.name}'s` : live.assignedTo ? "owned by someone else now" : "has no owner now" }); continue; }
      if (!live.tags.includes(a.tag.trim())) { skipped.push({ who: x.who, why: `no longer tagged ${a.tag}` }); continue; }
      await adapters.write.updateContact(ac, x.ghl_contact_id, { assignedUserId: to.ghl_user_id });
      await c.query("update contacts set assigned_ghl_user_id=$2, updated_at=now() where id=$1", [x.id, to.ghl_user_id]);
      moved.push(x);
    } catch (e) { skipped.push({ who: x.who, why: `GHL refused: ${String((e as Error).message).slice(0, 120)}` }); }
  }
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'contacts.reassigned','user',$2,$3,$4)",
    [co.id, to.ghl_user_id, { owner: from?.ghl_user_id ?? null, except: keep, tag: a.tag }, { owner: to.ghl_user_id, why: a.why, contacts: moved.map((m) => m.id), skipped: skipped.length }]);
  return { ok: true, dryRun: false, ...base, moved: moved.length, contacts: moved.map((m) => m.who), skipped };
}

/**
 * D204: a watched calendar's owner (D142: its bookings are its call type and its owner's), changed on its own without a re-install:
 * the calendar's `owner`, and its upcoming bookings given to the new owner as install gives them (a past call stays whoever took it).
 * New bookings then name the new owner (their pre-call texts, the contact's owner, the end of day). A dry run (the default) says how many.
 */
export async function calendarOwner(c: PoolClient, a: { company: string; calendar: string; owner: string; why: string; dryRun?: boolean }):
  Promise<{ ok: true; dryRun: boolean; calendar: string; was: string | null; owner: string; upcoming: number } | Fail> {
  if (!a.calendar || !a.owner || !a.why?.trim()) return { ok: false, status: 400, error: "calendar, owner and why are required" };
  const co = await company(c, a.company); if (!co) return { ok: false, status: 404, error: "no such company" };
  const cal = await one<{ id: string; name: string; config: Record<string, unknown> }>(c, "select id, name, config from calendars where company_id=$1 and active and (external_id=$2 or lower(name)=lower($2))", [co.id, a.calendar.trim()]);
  if (!cal) return { ok: false, status: 404, error: `no watched calendar is ${a.calendar}` };
  const owner = await one<{ id: string; name: string }>(c, "select id, name from users where company_id=$1 and lower(email)=lower($2) and active", [co.id, a.owner.trim()]);
  if (!owner) return { ok: false, status: 404, error: `${a.owner} is not on this offer's roster` };
  const was = typeof cal.config.owner === "string" ? (await one<{ name: string }>(c, "select name from users where id=$1", [cal.config.owner]))?.name ?? null : null;
  const upcoming = Number((await one<{ n: string }>(c, "select count(*) as n from appointments where calendar_id=$1 and starts_at > now() and assigned_user_id is distinct from $2", [cal.id, owner.id]))?.n ?? 0);
  if (a.dryRun !== false) return { ok: true, dryRun: true, calendar: cal.name, was, owner: owner.name, upcoming };
  await c.query("update calendars set config = config || jsonb_build_object('owner', $2::text) where id=$1", [cal.id, owner.id]);
  await c.query("update appointments set assigned_user_id=$2 where calendar_id=$1 and starts_at > now() and assigned_user_id is distinct from $2", [cal.id, owner.id]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'calendar.owner','calendar',$2,$3,$4)", [co.id, cal.id, { owner: cal.config.owner ?? null }, { owner: owner.id, why: a.why, upcoming }]);
  return { ok: true, dryRun: false, calendar: cal.name, was, owner: owner.name, upcoming };
}
