import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import type { CompanyRow } from "./context";
import { raise, resolve } from "./alerts";
import { callSetting } from "./call-settings";
import { OUTBOUND_DIAL } from "./metrics";

/**
 * D121. A booking the engine took as setter-booked (self_booked false: a setter calendar, or the company's rule, D24) whose
 * setter nobody can name is an error, never a quiet "unknown": one alert per booking, `setter:missing:<appointment id>`.
 * The setter is known by, in this order: the booking itself (`set_by`: Calendly's setter question, D24); a connected dial of
 * a team member to that person with the booking made during it or within the Set window after (D87, the rule the setter
 * numbers already use); the contact's Setter field (`crm.field_contact_setter`) filled in after the booking. The alert closes
 * the minute one of them answers, and the name goes on the booking (`set_by`) so the numbers count it. An alert is not a run:
 * it is raised in ghost and test as in live (D76, D88).
 */
export const SETTER_ALERT = "setter:missing:";
export const setterAlertKey = (appointmentId: string) => `${SETTER_ALERT}${appointmentId}`;
/** How often an open alert's contact is read back from the CRM (a booker the tagged contacts poll does not see, D117). */
export const LIVE_EVERY_MIN = 5;

const text = (v: unknown) => (Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : "").trim();

async function settings(c: PoolClient, companyId: string): Promise<{ field?: string; within: number }> {
  const b = Object.fromEntries((await many<{ key: string; value: Buffer }>(c, "select key, value from bindings where company_id=$1 and key in ('crm.field_contact_setter','setter_result.set_within_min')", [companyId])).map((r) => [r.key, r.value.toString("utf8")]));
  return { field: b["crm.field_contact_setter"]?.trim() || undefined, within: callSetting(b, "setter_result.set_within_min") };
}

/** D87: the team member whose connected dial to this person the booking came during, or within the Set window after; the latest such call. */
async function setterByCall(c: PoolClient, appointmentId: string, within: number): Promise<string | null> {
  const r = await one<{ name: string }>(c, `select u.name from appointments a
    join recordings r on r.company_id=a.company_id and r.contact_id=a.contact_id and ${OUTBOUND_DIAL} and r.raw->>'call_status'='connected' and coalesce((r.raw->>'duration_sec')::int, 1) > 0
      and a.booked_at >= r.started_at and a.booked_at <= coalesce(r.ended_at, r.started_at) + make_interval(mins => $2::int)
    join users u on u.company_id=a.company_id and u.ghl_user_id=r.raw->>'caller_ghl_user_id'
    where a.id=$1 order by r.started_at desc limit 1`, [appointmentId, within]);
  return r?.name?.trim() || null;
}

/** Called once, when a new setter-booked booking with no setter is first seen (not on a baseline). Raises nothing when a dial already says who set it. */
export async function raiseSetterMissing(c: PoolClient, co: CompanyRow, appointmentId: string): Promise<"raised" | "by_call"> {
  const s = await settings(c, co.id);
  const byCall = await setterByCall(c, appointmentId, s.within);
  if (byCall) { await c.query("update appointments set set_by=$2 where id=$1 and nullif(trim(coalesce(set_by,'')),'') is null", [appointmentId, byCall]); return "by_call"; }
  const a = await one<{ contact_id: string; starts_at: Date; calendar: string | null; name: string | null; email: string | null; fields: Record<string, unknown> | null }>(c, `
    select a.contact_id, a.starts_at, cal.name as calendar, nullif(trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')),'') as name, ct.ghl_fields as fields,
      (select i.value from contact_identifiers i where i.contact_id=ct.id and i.kind='email' and i.retired_at is null limit 1) as email
    from appointments a join contacts ct on ct.id=a.contact_id left join calendars cal on cal.id=a.calendar_id where a.id=$1`, [appointmentId]);
  if (!a) return "raised";
  const who = a.name ?? a.email ?? "someone", when = DateTime.fromJSDate(a.starts_at).setZone(co.timezone).toFormat("ccc LLL d, h:mm a ZZZZ");
  const before = s.field ? text(a.fields?.[s.field]) : "";
  const say = s.field
    ? `Say who set it: put the setter's name in ${who}'s Setter field in GHL and this clears.${before ? ` Their Setter field already says "${before}" from before this booking: if ${before} set this one too, resolve this alert.` : ""}`
    : "Say who set it, then resolve this alert.";
  await raise(c, { companyId: co.id, key: setterAlertKey(appointmentId), level: "error", source: "engine", href: `/app/c/${co.slug}`,
    text: `Setter-booked call with no setter: ${who}, ${when} on ${a.calendar ?? "a setter calendar"}. ${say}`,
    detail: { appointment_id: appointmentId, contact_id: a.contact_id, calendar: a.calendar, starts_at: a.starts_at.toISOString(), setter_field_before: before || null } });
  return "raised";
}

/**
 * Each poll: every open setter alert of the company asks again whether its setter is known now. Cheap when there are none
 * (one select). The contact's Setter field is the replica's, and the CRM's own (read every `LIVE_EVERY_MIN`) for a person
 * with a CRM id, since a booker in scope only by their booking is not in the tagged contacts poll. Returns how many closed.
 */
export async function settleSetterAlerts(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, now = new Date()): Promise<number> {
  const open = await many<{ key: string; detail: { setter_field_before?: string | null; checked_at?: string } }>(c, "select key, detail from alerts where company_id=$1 and key like $2 and resolved_at is null", [co.id, `${SETTER_ALERT}%`]);
  if (!open.length) return 0;
  const s = await settings(c, co.id);
  let closed = 0;
  for (const o of open) {
    const id = o.key.slice(SETTER_ALERT.length);
    const a = await one<{ set_by: string | null; ghl: string | null; fields: Record<string, unknown> | null }>(c, "select a.set_by, ct.ghl_contact_id as ghl, ct.ghl_fields as fields from appointments a join contacts ct on ct.id=a.contact_id where a.id=$1", [id]);
    if (!a) { await resolve(c, co.id, o.key, now, true); continue; }   // the booking is gone from the ledger: nothing left to ask
    let name = text(a.set_by) || (await setterByCall(c, id, s.within)) || "";
    if (!name && s.field) {
      let typed = text(a.fields?.[s.field]);
      const last = Date.parse(o.detail.checked_at ?? "") || 0;
      if (a.ghl && now.getTime() - last >= LIVE_EVERY_MIN * 60e3) {
        try { const live = await adapters.read.getContact(ac, a.ghl); if (live) typed = text(live.customFields[s.field]); } catch { /* the replica's answer stands; asked again next time */ }
        await c.query("update alerts set detail = detail || $3::jsonb where company_id=$1 and key=$2 and resolved_at is null", [co.id, o.key, JSON.stringify({ checked_at: now.toISOString() })]);
      }
      if (typed && typed.toLowerCase() !== text(o.detail.setter_field_before).toLowerCase()) name = typed;
    }
    if (!name) continue;
    await c.query("update appointments set set_by=$2 where id=$1 and nullif(trim(coalesce(set_by,'')),'') is null", [id, name]);
    if (await resolve(c, co.id, o.key, now)) closed++;
  }
  return closed;
}
