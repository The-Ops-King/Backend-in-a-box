import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";

/**
 * Daily rollups (D29). Every number a wrap-up or the bot needs is a count or a sum per company, per local day, per
 * dimension (total, a setter, a closer). Rates are computed where they are read. The ledger (events, appointments,
 * recordings, payments, opportunities) is the source; a day is recomputed in full, so the table is a cache that can be
 * rebuilt at any time. Harness rows (source 'test', raw.simulated) never count.
 */
export type MetricRow = { dimension: "total" | "setter" | "closer"; dimension_id: string; metric: string; value: number };
export type Totals = Record<string, number>;
export type Breakdown = { id: string; name: string; values: Totals };

export const METRIC_LABELS: Record<string, string> = {
  leads_new: "new leads", leads_booked_same_day: "booked the same day", stl_n: "leads reached", stl_sum: "seconds to first touch (sum)",
  dials: "dials", connects: "connected", talk_sec: "talk seconds", calls_set: "set from a call", calls_setting: "setting calls", calls_confirmation: "confirmation calls",
  booked: "calls booked", booked_self: "self-booked", booked_set: "setter-booked",
  scheduled: "on the calendar", showed: "showed", noshow: "no-show", cancelled: "cancelled",
  payments: "payments", cash: "cash collected", refunds: "refunds", refunded: "refunded", deals_won: "deals won", revenue: "revenue contracted",
};

export function dayBounds(day: string, tz: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(day, { zone: tz }).startOf("day");
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

export async function rollupDay(c: PoolClient, companyId: string, day: string, tz: string): Promise<MetricRow[]> {
  const { start, end } = dayBounds(day, tz);
  const p = [companyId, start, end];
  const rows: MetricRow[] = [];
  const totals: Totals = {};
  const add = (dimension: MetricRow["dimension"], id: string, metric: string, value: number) => {
    const v = Number(value) || 0;
    if (dimension === "total") totals[metric] = (totals[metric] ?? 0) + v;
    else if (v) rows.push({ dimension, dimension_id: id, metric, value: v });
  };

  // leads: lead.created events (the contacts poll, a form, never the harness); same-day = an appointment booked after the lead arrived, that day
  const leads = await one<{ n: number; same: number }>(c, `
    select count(*)::int as n,
           count(*) filter (where exists (select 1 from appointments a where a.company_id=e.company_id and a.contact_id=e.contact_id and a.source<>'test' and a.booked_at>=e.occurred_at and a.booked_at<$3))::int as same
    from events e where e.company_id=$1 and e.event_type='lead.created' and e.source<>'test' and e.occurred_at>=$2 and e.occurred_at<$3`, p);
  add("total", "", "leads_new", leads?.n ?? 0); add("total", "", "leads_booked_same_day", leads?.same ?? 0);

  // speed to lead: seconds from lead.created to the first thing the team did (a dialer call, an outbound message, a send)
  const stl = await one<{ n: number; sum: number }>(c, `
    select count(*)::int as n, coalesce(sum(secs),0)::float as sum from (
      select e.contact_id, min(extract(epoch from (t.at - e.occurred_at))) as secs
      from events e
      join lateral (
        select r.started_at as at from recordings r where r.company_id=e.company_id and r.contact_id=e.contact_id and r.provider='ghl' and coalesce(r.raw->>'simulated','')='' and r.started_at>=e.occurred_at
        union all select m.occurred_at from messages m where m.company_id=e.company_id and m.contact_id=e.contact_id and m.direction='outbound' and m.occurred_at>=e.occurred_at
        union all select s.sent_at from sends s where s.company_id=e.company_id and s.contact_id=e.contact_id and s.channel in ('sms','email') and s.status in ('sent','shadow') and s.sent_at>=e.occurred_at
      ) t on true
      where e.company_id=$1 and e.event_type='lead.created' and e.source<>'test' and e.occurred_at>=$2 and e.occurred_at<$3
      group by e.contact_id) x`, p);
  add("total", "", "stl_n", stl?.n ?? 0); add("total", "", "stl_sum", stl?.sum ?? 0);

  // dialer calls by setter (the user who dialed); a call "set" when a booking followed within a day
  const calls = await many<{ setter: string; dials: number; connects: number; talk_sec: number; calls_set: number; calls_setting: number; calls_confirmation: number }>(c, `
    select coalesce(u.id::text, 'unknown') as setter, count(*)::int as dials,
           count(*) filter (where r.raw->>'call_status'='connected')::int as connects,
           coalesce(sum((r.raw->>'duration_sec')::int) filter (where r.raw->>'call_status'='connected'),0)::int as talk_sec,
           count(*) filter (where r.raw->>'call_status'='connected' and exists (select 1 from appointments a where a.company_id=r.company_id and a.contact_id=r.contact_id and a.source<>'test' and a.booked_at>=r.started_at and a.booked_at<r.started_at+interval '1 day'))::int as calls_set,
           count(*) filter (where r.analysis->'classify'->>'call_type'='setting')::int as calls_setting,
           count(*) filter (where r.analysis->'classify'->>'call_type'='confirmation')::int as calls_confirmation
    from recordings r left join users u on u.company_id=r.company_id and u.ghl_user_id=r.raw->>'caller_ghl_user_id'
    where r.company_id=$1 and r.provider='ghl' and coalesce(r.raw->>'simulated','')='' and r.started_at>=$2 and r.started_at<$3 group by u.id`, p);
  for (const m of ["dials", "connects", "talk_sec", "calls_set", "calls_setting", "calls_confirmation"] as const) { let t = 0; for (const r of calls) { add("setter", r.setter, m, r[m]); t += Number(r[m]) || 0; } add("total", "", m, t); }

  // bookings made (the act of booking happened that day), by the closer they were booked with; setter-booked also credited to the setter named on the booking
  const booked = await many<{ closer: string; booked: number; booked_self: number; booked_set: number }>(c, `
    select coalesce(assigned_user_id::text,'unknown') as closer, count(*)::int as booked, count(*) filter (where self_booked)::int as booked_self, count(*) filter (where self_booked=false)::int as booked_set
    from appointments where company_id=$1 and source<>'test' and booked_at>=$2 and booked_at<$3 group by assigned_user_id`, p);
  for (const m of ["booked", "booked_self", "booked_set"] as const) { let t = 0; for (const r of booked) { add("closer", r.closer, m, r[m]); t += Number(r[m]) || 0; } add("total", "", m, t); }
  for (const r of await many<{ setter: string; n: number }>(c, `
    select coalesce(u.id::text,'unknown') as setter, count(*)::int as n from appointments a left join users u on u.company_id=a.company_id and lower(u.name)=lower(a.set_by)
    where a.company_id=$1 and a.source<>'test' and a.self_booked=false and a.booked_at>=$2 and a.booked_at<$3 group by u.id`, p)) add("setter", r.setter, "booked_set", r.n);

  // calls on the calendar that day (booked earlier, due that day) and how they ended
  const sched = await many<{ closer: string; scheduled: number; showed: number; noshow: number; cancelled: number }>(c, `
    select coalesce(a.assigned_user_id::text,'unknown') as closer, count(*)::int as scheduled,
           count(*) filter (where t.category='showed' or a.status='showed')::int as showed,
           count(*) filter (where t.category='noshow' or a.status='noshow')::int as noshow,
           count(*) filter (where a.status='cancelled' or t.category='cancelled')::int as cancelled
    from appointments a left join company_terms t on t.id=a.outcome_term
    where a.company_id=$1 and a.source<>'test' and a.starts_at>=$2 and a.starts_at<$3 group by a.assigned_user_id`, p);
  for (const m of ["scheduled", "showed", "noshow", "cancelled"] as const) { let t = 0; for (const r of sched) { add("closer", r.closer, m, r[m]); t += Number(r[m]) || 0; } add("total", "", m, t); }

  // money: cash is what arrived, revenue is what was contracted (they diverge on every payment plan)
  const money = await one<{ payments: number; cash: number; refunds: number; refunded: number }>(c, `
    select count(*) filter (where status='succeeded')::int as payments, coalesce(sum(amount) filter (where status='succeeded'),0)::float as cash,
           count(*) filter (where status='refunded')::int as refunds, coalesce(-sum(amount) filter (where status='refunded'),0)::float as refunded
    from payments where company_id=$1 and coalesce(raw->>'simulated','')='' and paid_at>=$2 and paid_at<$3`, p);
  for (const m of ["payments", "cash", "refunds", "refunded"] as const) add("total", "", m, money?.[m] ?? 0);
  const won = await many<{ closer: string; deals_won: number; revenue: number }>(c, `
    select coalesce((select a.assigned_user_id::text from appointments a where a.company_id=o.company_id and (a.opportunity_id=o.id or a.contact_id=o.contact_id) and a.source<>'test' order by a.starts_at desc limit 1),'unknown') as closer,
           count(*)::int as deals_won, coalesce(sum(o.contract_value),0)::float as revenue
    from opportunities o where o.company_id=$1 and o.status='won' and o.won_at>=$2 and o.won_at<$3 group by 1`, p);
  for (const m of ["deals_won", "revenue"] as const) { let t = 0; for (const r of won) { add("closer", r.closer, m, r[m]); t += Number(r[m]) || 0; } add("total", "", m, t); }

  for (const [metric, value] of Object.entries(totals)) rows.push({ dimension: "total", dimension_id: "", metric, value });
  await c.query("delete from metrics_daily where company_id=$1 and day=$2", [companyId, day]);
  for (const r of rows) await c.query("insert into metrics_daily (company_id, day, dimension, dimension_id, metric, value) values ($1,$2,$3,$4,$5,$6)", [companyId, day, r.dimension, r.dimension_id, r.metric, r.value]);
  return rows;
}

/** Recomputes every local day in [from, to] (inclusive ISO dates). */
export async function rollupRange(c: PoolClient, companyId: string, from: string, to: string, tz: string): Promise<void> {
  for (let d = DateTime.fromISO(from, { zone: tz }); d.toISODate()! <= to; d = d.plus({ days: 1 })) await rollupDay(c, companyId, d.toISODate()!, tz);
}

/** Sums the rollups over a period: totals plus one row per setter / closer, named from the roster. */
export async function readMetrics(c: PoolClient, companyId: string, from: string, to: string): Promise<{ totals: Totals; setters: Breakdown[]; closers: Breakdown[] }> {
  const rows = await many<{ dimension: string; dimension_id: string; metric: string; value: string }>(c, "select dimension, dimension_id, metric, sum(value)::text as value from metrics_daily where company_id=$1 and day between $2 and $3 group by 1,2,3", [companyId, from, to]);
  const totals: Totals = {}; const by = new Map<string, Breakdown>();
  const names = new Map((await many<{ id: string; name: string }>(c, "select id::text as id, name from users where company_id=$1", [companyId])).map((u) => [u.id, u.name]));
  for (const r of rows) {
    if (r.dimension === "total") { totals[r.metric] = Number(r.value); continue; }
    const k = `${r.dimension}:${r.dimension_id}`;
    if (!by.has(k)) by.set(k, { id: r.dimension_id, name: names.get(r.dimension_id) ?? (r.dimension_id === "unknown" ? "unknown" : r.dimension_id), values: {} });
    by.get(k)!.values[r.metric] = Number(r.value);
  }
  const pick = (dim: string) => [...by.entries()].filter(([k]) => k.startsWith(`${dim}:`)).map(([, v]) => v).sort((a, b) => a.name.localeCompare(b.name));
  return { totals, setters: pick("setter"), closers: pick("closer") };
}
