import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { checkpoint, many, one } from "@/db/client";
import { bookingFor, type Adapters, type BookingMode } from "@/adapters/types";
import { watchCalendar } from "./install";
import { closerOptions } from "./sales-call";
import { loadCompany } from "./context";
import { callOutcome } from "./recordings";
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
 * `calledTo` (Tyler: "if they've had a call, let's keep them assigned to Mitch"): a contact who has had a call goes to that person
 * instead. Had a call: a booking of theirs whose time has passed and was not cancelled (the replica's), or a call in their GHL
 * conversations that connected for more than 0 seconds (read live, the dry run too, since the replica's history starts later).
 */
export async function contactsReassign(c: PoolClient, adapters: Adapters, a: { company: string; from?: string; except?: string[]; to: string; calledTo?: string; tag: string; why: string; dryRun?: boolean }):
  Promise<{ ok: true; dryRun: boolean; from: string; to: string; count: number; byOwner: Record<string, number>; moved: number; contacts: string[]; skipped: { who: string; why: string }[]; called?: { to: string; count: number; contacts: string[] } } | Fail> {
  if ((!a.from && !a.except?.length) || (a.from && a.except?.length) || !a.to || !a.tag?.trim() || !a.why?.trim()) return { ok: false, status: 400, error: "to, tag, why, and one of from (an owner) or except (owners to leave alone) are required" };
  const co = await company(c, a.company); if (!co) return { ok: false, status: 404, error: "no such company" };
  const who = (email: string) => one<{ name: string; ghl_user_id: string | null }>(c, "select name, ghl_user_id from users where company_id=$1 and lower(email)=lower($2)", [co.id, email.trim()]);
  const to = await who(a.to);
  if (!to?.ghl_user_id) return { ok: false, status: 404, error: `${a.to} is not a GHL user on this offer's roster: add them in GHL, then to the team (/team add)` };
  const calledTo = a.calledTo ? await who(a.calledTo) : null;
  if (a.calledTo && !calledTo?.ghl_user_id) return { ok: false, status: 404, error: `${a.calledTo} is not a GHL user on this offer's roster` };
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
  const { adapterCompany: ac } = await loadCompany(c, co.id);
  // who has had a call: a past booking of theirs not cancelled, else a connected call in GHL (read only when it decides something)
  const booked = new Set((await many<{ contact_id: string }>(c, "select distinct contact_id from appointments where company_id=$1 and starts_at < now() and status <> 'cancelled' and contact_id = any($2::uuid[])", [co.id, list.map((x) => x.id)])).map((r) => r.contact_id));
  const hadCall = async (x: { id: string; ghl_contact_id: string }) => {
    if (booked.has(x.id)) return true;
    if (!adapters.read.contactCalls) throw new Error("this CRM cannot list a contact's calls");
    return (await adapters.read.contactCalls(ac, x.ghl_contact_id)).some((m) => callOutcome(m.call?.status ?? m.status ?? "") === "connected" && (m.call?.durationSec ?? 0) > 0);
  };
  const plan: { x: (typeof list)[number]; target: { name: string; ghl_user_id: string } }[] = [];
  const skipped: { who: string; why: string }[] = [];
  for (const x of list) {
    let target = { name: to.name, ghl_user_id: to.ghl_user_id };
    if (calledTo?.ghl_user_id) {
      try { if (await hadCall(x)) target = { name: calledTo.name, ghl_user_id: calledTo.ghl_user_id }; }
      catch (e) { skipped.push({ who: x.who, why: `couldn't read their calls in GHL: ${String((e as Error).message).slice(0, 100)}` }); continue; }
    }
    if (x.owner === target.ghl_user_id) continue;   // already where they belong
    plan.push({ x, target });
  }
  const said = (moved: typeof plan) => ({ count: moved.filter((p) => p.target.ghl_user_id === to.ghl_user_id).length, contacts: moved.filter((p) => p.target.ghl_user_id === to.ghl_user_id).map((p) => p.x.who),
    ...(calledTo ? { called: { to: calledTo.name, count: moved.filter((p) => p.target.ghl_user_id !== to.ghl_user_id).length, contacts: moved.filter((p) => p.target.ghl_user_id !== to.ghl_user_id).map((p) => p.x.who) } } : {}) });
  if (a.dryRun !== false) return { ok: true, dryRun: true, ...base, moved: 0, ...said(plan), skipped };
  const moved: typeof plan = [];
  for (const p of plan) {
    const x = p.x;
    try {
      const live = await adapters.read.getContact(ac, x.ghl_contact_id);
      if (!live) { skipped.push({ who: x.who, why: "gone from GHL" }); continue; }
      if (live.assignedTo === p.target.ghl_user_id) { skipped.push({ who: x.who, why: `already ${p.target.name}'s` }); continue; }
      if (!matches(live.assignedTo)) { skipped.push({ who: x.who, why: live.assignedTo === to.ghl_user_id ? `already ${to.name}'s` : live.assignedTo ? "owned by someone else now" : "has no owner now" }); continue; }
      if (!live.tags.includes(a.tag.trim())) { skipped.push({ who: x.who, why: `no longer tagged ${a.tag}` }); continue; }
      await adapters.write.updateContact(ac, x.ghl_contact_id, { assignedUserId: p.target.ghl_user_id });
      // each contact committed on its own (D204: one transaction held across hundreds of GHL calls collided with the contacts poll
      // and lost every replica write at the end; the poll reads the owner back from GHL anyway)
      await checkpoint(c, (c) => c.query("update contacts set assigned_ghl_user_id=$2, updated_at=now() where id=$1", [x.id, p.target.ghl_user_id]));
      moved.push(p);
    } catch (e) { skipped.push({ who: x.who, why: `GHL refused: ${String((e as Error).message).slice(0, 120)}` }); }
  }
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'contacts.reassigned','user',$2,$3,$4)",
    [co.id, to.ghl_user_id, { owner: from?.ghl_user_id ?? null, except: keep, tag: a.tag }, { owner: to.ghl_user_id, called_to: calledTo?.ghl_user_id ?? null, why: a.why, contacts: moved.map((m) => ({ id: m.x.id, to: m.target.ghl_user_id })), skipped: skipped.length }]);
  return { ok: true, dryRun: false, ...base, moved: moved.length, ...said(moved), skipped };
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

/**
 * D205: a calendar's calls split by time (Tyler: "Anything future assign to Nonie, anything past to mitch"): each booking whose time
 * is ahead belongs to `future`, each one passed to `past`, in the replica (who took or takes it: their end of day, their numbers) and
 * on its Discovery Call record in GHL (the Setter field and the record's owner, the other side's owner taken off). Each GHL record is
 * read back after the change, so an owner GHL did not swap is said, not assumed. `limit` changes only that many records (a first
 * one to prove the swap). A dry run (the default) lists what would change.
 */
export async function callsByTime(c: PoolClient, adapters: Adapters, a: { company: string; calendar: string; future: string; past: string; why: string; dryRun?: boolean; limit?: number }):
  Promise<{ ok: true; dryRun: boolean; bookings: { who: string; when: string; from: string; to: string }[]; records: { who: string; when: string; from: string; to: string; checked?: string }[]; failed: { who: string; why: string }[] } | Fail> {
  if (!a.calendar || !a.future || !a.past || !a.why?.trim()) return { ok: false, status: 400, error: "calendar, future, past and why are required" };
  const co = await company(c, a.company); if (!co) return { ok: false, status: 404, error: "no such company" };
  const who = (email: string) => one<{ id: string; name: string; ghl_user_id: string | null }>(c, "select id, name, ghl_user_id from users where company_id=$1 and lower(email)=lower($2) and active", [co.id, email.trim()]);
  const fut = await who(a.future), pst = await who(a.past);
  if (!fut?.ghl_user_id || !pst?.ghl_user_id) return { ok: false, status: 404, error: `${!fut?.ghl_user_id ? a.future : a.past} is not a GHL user on this offer's roster` };
  const { adapterCompany: ac, bindings } = await loadCompany(c, co.id);
  const objectKey = bindings["crm.object_discovery_call"] || "custom_objects.discovery_call";
  const rows = await many<{ id: string; status: string; when: string; future: boolean; assigned: string | null; owner_name: string | null; who: string; rec_id: string | null; ghl_record_id: string | null; setter: string | null }>(c, `
    select a.id, a.status, to_char(a.starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as when, a.starts_at > now() as future, a.assigned_user_id as assigned, u.name as owner_name,
      coalesce(nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''), '?') as who, r.id as rec_id, r.ghl_record_id, r.properties->>'setter' as setter
    from appointments a join calendars k on k.id=a.calendar_id left join users u on u.id=a.assigned_user_id left join contacts ct on ct.id=a.contact_id
      left join crm_records r on r.company_id=a.company_id and r.object_key=$3 and r.record_key=a.slot_key
    where a.company_id=$1 and k.active and (k.external_id=$2 or lower(k.name)=lower($2)) order by a.starts_at`, [co.id, a.calendar.trim(), objectKey]);
  if (!rows.length) return { ok: false, status: 404, error: `no bookings on a watched calendar ${a.calendar}` };
  // the other side's owner comes off the record; when both sides are one person there is no other side (D212)
  const otherOf = (mine: string, theirs: string) => (mine === theirs ? null : theirs);
  const side = (r: { future: boolean }) => (r.future ? { id: fut.id, name: fut.name, ghl: fut.ghl_user_id!, other: otherOf(fut.ghl_user_id!, pst.ghl_user_id!) } : { id: pst.id, name: pst.name, ghl: pst.ghl_user_id!, other: otherOf(pst.ghl_user_id!, fut.ghl_user_id!) });
  const bookings = rows.filter((r) => r.assigned !== side(r).id).map((r) => ({ r, to: side(r) }));
  const records = rows.filter((r) => r.ghl_record_id && r.setter !== side(r).name).map((r) => ({ r, to: side(r) })).slice(0, a.limit && a.limit > 0 ? a.limit : undefined);
  const say = (x: { r: (typeof rows)[number]; to: { name: string } }, from: string | null) => ({ who: x.r.who, when: x.r.when, from: from ?? "nobody", to: x.to.name });
  if (a.dryRun !== false) return { ok: true, dryRun: true, bookings: bookings.map((b) => say(b, b.r.owner_name)), records: records.map((x) => say(x, x.r.setter)), failed: [] };
  const failed: { who: string; why: string }[] = [], doneRecords: { who: string; when: string; from: string; to: string; checked?: string }[] = [];
  for (const b of bookings) await checkpoint(c, (c) => c.query("update appointments set assigned_user_id=$2 where id=$1", [b.r.id, b.to.id]));
  for (const x of records) {
    try {
      await adapters.write.updateRecord(ac, objectKey, x.r.ghl_record_id!, { setter: x.to.name }, x.to.ghl, x.to.other ? [x.to.other] : undefined);
      await checkpoint(c, (c) => c.query("update crm_records set properties = properties || jsonb_build_object('setter', $2::text) where id=$1", [x.r.rec_id, x.to.name]));
      const back = adapters.read.objectRecord ? await adapters.read.objectRecord(ac, objectKey, x.r.ghl_record_id!) : undefined;
      const checked = back === undefined ? "not read back" : !back ? "gone from GHL" : !back.owners.includes(x.to.ghl) ? `GHL owners: ${back.owners.join(", ") || "none"} (${x.to.name} not added)` : x.to.other && back.owners.includes(x.to.other) ? `GHL kept the other owner too (${back.owners.join(", ")})` : "owner swapped";
      doneRecords.push({ ...say(x, x.r.setter), checked });
    } catch (e) { failed.push({ who: x.r.who, why: `GHL refused: ${String((e as Error).message).slice(0, 160)}` }); }
  }
  await checkpoint(c, (c) => c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'calls.by_time','calendar',$2,$3)",
    [co.id, a.calendar, { future: fut.name, past: pst.name, why: a.why, bookings: bookings.map((b) => ({ id: b.r.id, to: b.to.name })), records: doneRecords.length, failed: failed.length }]));
  return { ok: true, dryRun: false, bookings: bookings.map((b) => say(b, b.r.owner_name)), records: doneRecords, failed };
}

/**
 * D213 (Tyler: "update the engine alerts to point to the two new Calendly links"): whether a watched calendar's availability is
 * alerted on. Off, its bookings are still watched (reminders, cancels, the end of day), but the health check and the availability
 * alerts leave it out: an old link kept for the calls already on it. A dry run (the default) says what would change.
 */
export async function calendarAlerts(c: PoolClient, a: { company: string; calendar: string; alerts: boolean; why: string; dryRun?: boolean }):
  Promise<{ ok: true; dryRun: boolean; calendar: string; was: boolean; alerts: boolean; upcoming: number } | Fail> {
  if (!a.calendar || typeof a.alerts !== "boolean" || !a.why?.trim()) return { ok: false, status: 400, error: "calendar, alerts (true or false) and why are required" };
  const co = await company(c, a.company); if (!co) return { ok: false, status: 404, error: "no such company" };
  const cal = await one<{ id: string; name: string; alerts: string | null }>(c, "select id, name, config->>'alerts' as alerts from calendars where company_id=$1 and active and (external_id=$2 or lower(name)=lower($2))", [co.id, a.calendar.trim()]);
  if (!cal) return { ok: false, status: 404, error: `no watched calendar is ${a.calendar}` };
  const was = cal.alerts !== "false";
  const upcoming = Number((await one<{ n: string }>(c, "select count(*) as n from appointments where calendar_id=$1 and starts_at > now() and status <> 'cancelled'", [cal.id]))?.n ?? 0);
  if (a.dryRun !== false) return { ok: true, dryRun: true, calendar: cal.name, was, alerts: a.alerts, upcoming };
  await c.query(a.alerts ? "update calendars set config = config - 'alerts' where id=$1" : "update calendars set config = config || '{\"alerts\": false}'::jsonb where id=$1", [cal.id]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'calendar.alerts','calendar',$2,$3,$4)", [co.id, cal.id, { alerts: was }, { alerts: a.alerts, why: a.why }]);
  return { ok: true, dryRun: false, calendar: cal.name, was, alerts: a.alerts, upcoming };
}

/**
 * D215: one more of the booking tool's calendars watched (Tyler: "JP's Strategy is an individual calendar for follow up / reschedule
 * if needed. track it."), mapped exactly as install maps one (`watchCalendar`): its call type, how it is booked, its owner. The poll's
 * first read of it is a baseline (its bookings land as rows, nothing starts), so the history and Sales Call backfills follow for the
 * calls it already held. A dry run (the default) says what it would map; a calendar already watched answers so and changes nothing.
 */
export async function calendarWatch(c: PoolClient, adapters: Adapters, a: { company: string; calendar: string; term: string; name?: string; owner?: string; booking?: BookingMode; why: string; dryRun?: boolean }):
  Promise<{ ok: true; dryRun: boolean; calendar: string; id: string; was: "watched" | "not watched"; maps: string } | Fail> {
  if (!a.calendar || !a.term || !a.why?.trim()) return { ok: false, status: 400, error: "calendar, term and why are required" };
  const co = await company(c, a.company); if (!co) return { ok: false, status: 404, error: "no such company" };
  const { adapterCompany: ac } = await loadCompany(c, co.id);
  const want = a.calendar.trim().toLowerCase();
  const k = (await bookingFor(adapters, ac).listCalendars(ac)).find((x) => x.id.toLowerCase() === want || x.name.trim().toLowerCase() === want);
  if (!k) return { ok: false, status: 404, error: `the booking tool has no calendar ${a.calendar}` };
  const terms = await many<{ id: string; category: string }>(c, "select id, category from company_terms where company_id=$1 and domain='appointment_type' and is_default", [co.id]);
  if (!a.name?.trim() && !terms.some((t) => t.category === a.term)) return { ok: false, status: 400, error: `term: one of ${terms.map((t) => t.category).join(", ")}` };
  if (a.owner && !(await one(c, "select 1 from users where company_id=$1 and lower(email)=lower($2) and active", [co.id, a.owner.trim()]))) return { ok: false, status: 404, error: `${a.owner} is not on this offer's roster` };
  const was = (await one(c, "select 1 from calendars where company_id=$1 and source=$2 and external_id=$3 and active", [co.id, ac.booking.source, k.id])) ? "watched" as const : "not watched" as const;
  const m = { term: a.term, ...(a.name?.trim() ? { name: a.name.trim() } : {}), ...(a.owner ? { owner: a.owner.trim() } : {}), ...(a.booking ? { booking: a.booking } : {}) };
  if (a.dryRun !== false || was === "watched") return { ok: true, dryRun: a.dryRun !== false, calendar: k.name, id: k.id, was, maps: was === "watched" ? "already watched: nothing changed" : JSON.stringify(m) };
  const maps = await watchCalendar(c, co.id, ac.booking.source, k, m, terms);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'calendar.watched','calendar',$2,$3)", [co.id, k.id, { ...m, maps, why: a.why }]);
  return { ok: true, dryRun: false, calendar: k.name, id: k.id, was, maps };
}

/**
 * D218: who took a call, set on calls already held (D204 moves a calendar's upcoming ones; this is for one call, past or ahead).
 * Tyler: Ana Magno, Fabiola E and Christie Laney were hosted on a shared Calendly seat; "assume that it's probably JP." The booking's
 * closer in the replica (their end of day lists it, their numbers count it) and the Closer field on its Sales Call in GHL, by the
 * company's option key (D118). A dry run (the default) lists each call and what changes.
 */
export async function callCloser(c: PoolClient, adapters: Adapters, a: { company: string; appointments: string[]; closer: string; why: string; dryRun?: boolean }):
  Promise<{ ok: true; dryRun: boolean; closer: string; calls: { id: string; who: string; when: string; was: string | null; sales_call: string | null; ghl_closer?: string }[] } | Fail> {
  if (!a.appointments?.length || !a.closer || !a.why?.trim()) return { ok: false, status: 400, error: "appointments, closer and why are required" };
  const co = await company(c, a.company); if (!co) return { ok: false, status: 404, error: "no such company" };
  const { adapterCompany: ac, bindings } = await loadCompany(c, co.id);
  const to = await one<{ id: string; name: string; email: string; ghl_user_id: string | null }>(c, "select id, name, email, ghl_user_id from users where company_id=$1 and lower(email)=lower($2) and active", [co.id, a.closer.trim()]);
  if (!to) return { ok: false, status: 404, error: `${a.closer} is not on this offer's roster` };
  const object = bindings["crm.object_sales_call"];
  const roster = await many<{ name: string; email: string | null; ghl_user_id: string | null }>(c, "select name, email, ghl_user_id from users where company_id=$1", [co.id]);
  const key = (closerOptions(bindings, roster) ?? {})[to.name.trim().toLowerCase()] ?? to.name;
  const calls: { id: string; who: string; when: string; was: string | null; sales_call: string | null; ghl_closer?: string }[] = [];
  for (const ref of a.appointments) {
    const ap = await one<{ id: string; who: string; starts_at: Date; was: string | null; slot: string }>(c, `select a.id, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as who, a.starts_at, u.name as was, coalesce(a.slot_key, a.external_id) as slot
      from appointments a join contacts ct on ct.id=a.contact_id left join users u on u.id=a.assigned_user_id where a.company_id=$1 and (a.id::text=$2 or a.external_id=$2 or a.slot_key=$2)`, [co.id, ref.trim()]);
    if (!ap) return { ok: false, status: 404, error: `no booking ${ref}` };
    const rec = object ? await one<{ ghl_record_id: string | null }>(c, "select ghl_record_id from crm_records where company_id=$1 and object_key=$2 and record_key=$3", [co.id, object, ap.slot]) : null;
    calls.push({ id: ap.id, who: ap.who, when: DateTime.fromJSDate(ap.starts_at).setZone(ac.timezone ?? "UTC").toFormat("ccc LLL d, h:mm a"), was: ap.was, sales_call: rec?.ghl_record_id ?? null, ...(rec?.ghl_record_id ? { ghl_closer: key } : {}) });
  }
  if (a.dryRun !== false) return { ok: true, dryRun: true, closer: to.name, calls };
  for (const k of calls) {
    await c.query("update appointments set assigned_user_id=$2 where id=$1", [k.id, to.id]);
    if (k.sales_call && object) {
      await adapters.write.updateRecord(ac, object, k.sales_call, { closer: key });
      await c.query("update crm_records set properties = properties || jsonb_build_object('closer', $3::text), updated_at=now() where company_id=$1 and ghl_record_id=$2", [co.id, k.sales_call, key]);
    }
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'call.closer','appointment',$2,$3,$4)", [co.id, k.id, { closer: k.was }, { closer: to.name, sales_call: k.sales_call, why: a.why }]);
  }
  return { ok: true, dryRun: false, closer: to.name, calls };
}
