import type { PoolClient } from "pg";
import { DateTime } from "luxon";
import { many, one } from "@/db/client";
import { dispatchEvent, emitEvent } from "./dispatch";

/**
 * D253: a call handed from one closer to another (Tyler: "if Jose essentially assigns one of his calls to Minerva ... it appears
 * on the correct closer's end of day. It gets reassigned in the backend"). The doors only ask: the end of day's "Taken by another
 * closer", `/reassign` in Slack and the different-closer alert's ✅ each emit `appointment.reassign_requested` with who from, who
 * to, who asked and through which door. What a reassignment does (the booking, the Sales Call, the owner, the card, the new
 * closer's DM) is the offer's own workflow on that event (Call reassigned), so it can be read and changed like any other.
 */
export type ReassignVia = "eod" | "slack" | "alert" | "operator";
type Person = { id: string; name: string; email: string };
const SOURCE: Record<ReassignVia, string> = { eod: "disposition", slack: "slack", alert: "slack", operator: "user" };   // events.source's own words

export async function requestReassign(c: PoolClient, companyId: string, a: { appointmentId: string; toUserId: string; via: ReassignVia; by: string; why?: string }):
  Promise<{ ok: true; eventId: number; runs: number; from: Person | null; to: Person } | { ok: false; status: number; error: string }> {
  const ap = await one<{ id: string; contact_id: string; opportunity_id: string | null; starts_at: Date; status: string; from_id: string | null; from_name: string | null; from_email: string | null; term: { name: string; category: string } | null }>(c, `
    select a.id, a.contact_id, o.id as opportunity_id, a.starts_at, a.status, u.id as from_id, u.name as from_name, u.email as from_email,
           json_build_object('name', t.name, 'category', t.category) as term
    from appointments a left join users u on u.id=a.assigned_user_id left join company_terms t on t.id=a.appointment_term
         left join lateral (select id from opportunities where company_id=a.company_id and contact_id=a.contact_id order by opened_at desc limit 1) o on true
    where a.company_id=$1 and a.id=$2`, [companyId, a.appointmentId]);
  if (!ap) return { ok: false, status: 404, error: "no such booking" };
  const to = await one<Person>(c, "select id, name, email from users where company_id=$1 and id=$2 and active", [companyId, a.toUserId]);
  if (!to) return { ok: false, status: 404, error: "that person is not on this offer's team" };
  if (ap.from_id === to.id) return { ok: false, status: 409, error: `${to.name} already has this call` };
  const from = ap.from_id ? { id: ap.from_id, name: ap.from_name!, email: ap.from_email! } : null;
  const ev = await emitEvent(c, { company_id: companyId, contact_id: ap.contact_id, opportunity_id: ap.opportunity_id, appointment_id: ap.id, event_type: "appointment.reassign_requested", source: SOURCE[a.via],
    data: { from: from ? { name: from.name, email: from.email } : null, to: { name: to.name, first_name: to.name.split(" ")[0], email: to.email }, via: a.via, by: a.by, ...(a.why ? { why: a.why } : {}), past: ap.starts_at.getTime() <= Date.now() } });
  const runs = await dispatchEvent(c, ev, { contact: { id: ap.contact_id }, appointment: { id: ap.id, starts_at: ap.starts_at.toISOString(), status: ap.status, term: ap.term ?? undefined } });
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'call.reassign_requested','appointment',$2,$3,$4)", [companyId, ap.id, { closer: from?.name ?? null }, { closer: to.name, via: a.via, by: a.by, why: a.why ?? null, runs: runs.length }]);
  return { ok: true, eventId: ev.id, runs: runs.length, from, to };
}

/** `/reassign`'s list: one person's calls on a day (company time), cancelled ones left out; `upcoming` keeps only those not started yet. */
export async function callsOf(c: PoolClient, companyId: string, userId: string, day: string, tz: string, opts: { upcoming?: boolean } = {}) {
  const start = DateTime.fromISO(day, { zone: tz }).startOf("day"), end = start.plus({ days: 1 });
  return many<{ id: string; who: string; starts_at: Date; term: string | null }>(c, `select a.id, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as who, a.starts_at, t.name as term
    from appointments a join contacts ct on ct.id=a.contact_id left join company_terms t on t.id=a.appointment_term
    where a.company_id=$1 and a.assigned_user_id=$2 and a.status not in ('cancelled','invalid') and a.starts_at >= $3 and a.starts_at < $4 ${opts.upcoming ? "and a.starts_at > now()" : ""}
    order by a.starts_at`, [companyId, userId, start.toJSDate(), end.toJSDate()]);
}
