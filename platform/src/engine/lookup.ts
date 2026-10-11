import type { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many } from "@/db/client";
import type { LookupQuery } from "./definition";
import { timeParam } from "./waitrule";

/**
 * D85. The questions a `lookup` step may ask of the ledger, each a fixed read-only query the engine owns: a template picks one
 * and gives it filters, never SQL. Always about the run's company, and the run's contact (or its appointment); answers are
 * plain data a later step reads from vars.<into>: a list's { count, any, items, first, last }, an event's { found, count, … }.
 */

/** What a booking is, in the words a template filters on: its kind (the calendar's call type; none is a closing call, as D79 counts), how it was booked, and when. */
export const APPOINTMENT_FACTS = `a.id, a.starts_at, a.ends_at, a.booked_at, a.status, coalesce(t.category, 'closing') as kind,
  case when a.self_booked then 'self' when a.self_booked = false then 'setter' end as booking_source, a.set_by, a.source, u.name as closer, ot.category as outcome`;
export const APPOINTMENT_JOINS = "left join company_terms t on t.id=a.appointment_term left join users u on u.id=a.assigned_user_id left join company_terms ot on ot.id=a.outcome_term";
const plain = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
export const appointmentRow = plain;

export type LookupScope = { companyId: string; contactId: string | null; appointmentId: string | null; now: DateTime };
type Answer = { value: Record<string, unknown> } | { error: string };

const list = (v?: string) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
const listOf = (rows: Record<string, unknown>[]) => { const items = rows.map(plain); return { count: items.length, any: items.length > 0, items, first: items[0] ?? null, last: items.at(-1) ?? null }; };

/** Every param is text (rendered); a blank one is no filter. Times take "<time>", "<time> +30m" or "-7d" (from now). */
export async function runLookup(c: PoolClient, s: LookupScope, query: LookupQuery, p: Record<string, string>): Promise<Answer> {
  const time = (k: string): Date | null | { bad: string } => { if (!p[k]) return null; const t = timeParam(p[k], s.now); return t ? t.toJSDate() : { bad: `${k} "${p[k]}" is not a time` }; };
  const times = (keys: string[]): { at: Record<string, Date | null> } | { bad: string } => { const at: Record<string, Date | null> = {}; for (const k of keys) { const t = time(k); if (t && "bad" in t) return t; at[k] = t; } return { at }; };
  switch (query) {
    case "appointments_for_contact": {
      if (!s.contactId) return { error: "the run is not about a contact" };
      const r = times(["booked_since", "booked_until", "starts_since", "starts_until"]); if ("bad" in r) return { error: r.bad }; const t = r.at;
      if (p.booking_source && !["setter", "self"].includes(p.booking_source)) return { error: `booking_source is setter or self, not "${p.booking_source}"` };
      if (p.order && !["starts_at", "booked_at"].includes(p.order)) return { error: `order is starts_at or booked_at, not "${p.order}"` };
      const rows = await many<Record<string, unknown>>(c, `select ${APPOINTMENT_FACTS} from appointments a ${APPOINTMENT_JOINS}
        where a.company_id=$1 and a.contact_id=$2 and ($3::timestamptz is null or a.booked_at >= $3) and ($4::timestamptz is null or a.booked_at <= $4)
          and ($5::timestamptz is null or a.starts_at >= $5) and ($6::timestamptz is null or a.starts_at <= $6) and (cardinality($7::text[]) = 0 or coalesce(t.category, 'closing') = any($7))
          and ($8::boolean is null or a.self_booked = $8) and (cardinality($9::text[]) = 0 or a.status = any($9)) and not (a.status = any($10::text[])) and ($11::uuid is null or a.id <> $11)
        order by a.${p.order === "booked_at" ? "booked_at" : "starts_at"}, a.id limit 500`,
        [s.companyId, s.contactId, t.booked_since, t.booked_until, t.starts_since, t.starts_until, list(p.kind), p.booking_source ? p.booking_source === "self" : null, list(p.status), list(p.status_not), p.exclude || null]);
      return { value: listOf(rows) };
    }
    case "calls_for_contact": {
      if (!s.contactId) return { error: "the run is not about a contact" };
      const r = times(["since", "until"]); if ("bad" in r) return { error: r.bad }; const t = r.at;
      if (p.kind && !["phone", "meeting"].includes(p.kind)) return { error: `kind is phone or meeting, not "${p.kind}"` };
      if (p.connected && !["true", "false"].includes(p.connected)) return { error: `connected is true or false, not "${p.connected}"` };
      const rows = await many<Record<string, unknown>>(c, `select r.id, r.provider, case when r.raw->>'kind'='phone' then 'phone' else 'meeting' end as kind, r.started_at, r.ended_at, r.duration_min,
          coalesce((r.raw->>'duration_sec')::int, r.duration_min*60) as duration_sec, r.raw->>'direction' as direction, r.raw->>'call_status' as status, coalesce(r.raw->>'call_status' = 'connected', false) as connected,
          coalesce(u.name, r.recorded_by_name) as caller, r.recorded_by_email as caller_email, r.title, r.appointment_id
        from recordings r left join users u on u.company_id=r.company_id and lower(u.email)=r.recorded_by_email
        where r.company_id=$1 and r.contact_id=$2 and ($3::timestamptz is null or r.started_at >= $3) and ($4::timestamptz is null or r.started_at <= $4)
          and (cardinality($5::text[]) = 0 or r.provider = any($5)) and ($6::text is null or lower(coalesce(u.name, r.recorded_by_name, '')) = lower($6) or lower(coalesce(r.recorded_by_email, '')) = lower($6))
          and ($7::text is null or (case when r.raw->>'kind'='phone' then 'phone' else 'meeting' end) = $7) and ($8::boolean is null or coalesce(r.raw->>'call_status' = 'connected', false) = $8)
        order by r.started_at, r.id limit 500`,
        [s.companyId, s.contactId, t.since, t.until, list(p.provider), p.caller || null, p.kind || null, p.connected ? p.connected === "true" : null]);
      return { value: listOf(rows) };
    }
    case "last_event": {
      if (!p.type) return { error: "last_event needs a type" };
      const about = p.about || "contact";
      if (!["contact", "appointment"].includes(about)) return { error: `about is contact or appointment, not "${about}"` };
      const id = about === "appointment" ? s.appointmentId : s.contactId;
      if (!id) return { error: `the run is not about ${about === "appointment" ? "an appointment" : "a contact"}` };
      const r = times(["since", "until"]); if ("bad" in r) return { error: r.bad }; const t = r.at;
      const rows = await many<{ id: string; event_type: string; occurred_at: Date; source: string; data: Record<string, unknown>; n: number }>(c, `select id::text, event_type, occurred_at, source, data, count(*) over ()::int as n from events
        where company_id=$1 and ${about === "appointment" ? "appointment_id" : "contact_id"}=$2 and event_type = any($3::text[]) and ($4::timestamptz is null or occurred_at >= $4) and ($5::timestamptz is null or occurred_at <= $5)
        order by occurred_at desc, id desc limit 1`, [s.companyId, id, list(p.type), t.since, t.until]);
      const e = rows[0];
      return { value: e ? { found: true, count: e.n, id: Number(e.id), type: e.event_type, at: e.occurred_at.toISOString(), source: e.source, data: e.data } : { found: false, count: 0 } };
    }
  }
}
