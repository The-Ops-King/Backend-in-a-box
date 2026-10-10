import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { testContactSql, testDomains } from "./mode";

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
  leads_new: "new leads", leads_booked_same_day: "booked the same day", leads_called: "leads called", stl_sum: "seconds to first dial (sum)", leads_reached: "leads reached",
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
  // D73: the company's test contacts count nowhere; their domains ride as $4 in every statement below
  const domains = testDomains({ "test.domains": (await one<{ v: Buffer }>(c, "select value as v from bindings where company_id=$1 and key='test.domains'", [companyId]))?.v.toString("utf8") ?? "" });
  const p = [companyId, start, end, domains];
  const real = (contactCol: string) => `not exists (select 1 from contacts tc where tc.id=${contactCol} and ${testContactSql("tc", "$4")})`;
  const rows: MetricRow[] = [];
  const totals: Totals = {};
  const add = (dimension: MetricRow["dimension"], id: string, metric: string, value: number) => {
    const v = Number(value) || 0;
    if (dimension === "total") totals[metric] = (totals[metric] ?? 0) + v;
    else if (v) rows.push({ dimension, dimension_id: id, metric, value: v });
  };

  // leads: contacts by the CRM's own arrival time (so history counts the same way as today); same-day = an appointment booked after they arrived, that day
  const leads = await one<{ n: number; same: number }>(c, `
    select count(*)::int as n,
           count(*) filter (where exists (select 1 from appointments a where a.company_id=ct.company_id and a.contact_id=ct.id and a.source<>'test' and a.booked_at>=ct.ghl_added_at and a.booked_at<$3))::int as same
    from contacts ct where ct.company_id=$1 and ct.merged_into is null and ct.ghl_added_at>=$2 and ct.ghl_added_at<$3 and ${real("ct.id")}`, p);
  add("total", "", "leads_new", leads?.n ?? 0); add("total", "", "leads_booked_same_day", leads?.same ?? 0);

  // speed to lead (Tyler, 2026-10-07): from the lead arriving to the FIRST DIAL, answered or not; "reached" = a connected call at least reached_seconds long
  const reachedSec = (await one<{ s: number }>(c, "select reached_seconds as s from companies where id=$1", [companyId]))?.s ?? 60;
  const stl = await one<{ called: number; sum: number; reached: number }>(c, `
    select count(*) filter (where first_dial is not null)::int as called, coalesce(sum(extract(epoch from (first_dial - ghl_added_at))) filter (where first_dial is not null),0)::float as sum,
           count(*) filter (where reached)::int as reached
    from (
      select ct.id, ct.ghl_added_at,
             (select min(r.started_at) from recordings r where r.company_id=ct.company_id and r.contact_id=ct.id and r.provider='ghl' and coalesce(r.raw->>'simulated','')='' and r.started_at>=ct.ghl_added_at) as first_dial,
             exists (select 1 from recordings r where r.company_id=ct.company_id and r.contact_id=ct.id and r.provider='ghl' and coalesce(r.raw->>'simulated','')='' and r.started_at>=ct.ghl_added_at and r.raw->>'call_status'='connected' and (r.raw->>'duration_sec')::int >= $5) as reached
      from contacts ct where ct.company_id=$1 and ct.merged_into is null and ct.ghl_added_at>=$2 and ct.ghl_added_at<$3 and ${real("ct.id")}) x`, [...p, reachedSec]);
  add("total", "", "leads_called", stl?.called ?? 0); add("total", "", "stl_sum", stl?.sum ?? 0); add("total", "", "leads_reached", stl?.reached ?? 0);

  // dialer calls by setter (the user who dialed); a call "set" when a booking followed within a day
  const calls = await many<{ setter: string; dials: number; connects: number; talk_sec: number; calls_set: number; calls_setting: number; calls_confirmation: number }>(c, `
    select coalesce(u.id::text, 'unknown') as setter, count(*)::int as dials,
           count(*) filter (where r.raw->>'call_status'='connected')::int as connects,
           coalesce(sum((r.raw->>'duration_sec')::int) filter (where r.raw->>'call_status'='connected'),0)::int as talk_sec,
           count(*) filter (where r.raw->>'call_status'='connected' and exists (select 1 from appointments a where a.company_id=r.company_id and a.contact_id=r.contact_id and a.source<>'test' and a.booked_at>=r.started_at and a.booked_at<r.started_at+interval '1 day'))::int as calls_set,
           count(*) filter (where r.analysis->'classify'->>'call_type'='setting')::int as calls_setting,
           count(*) filter (where r.analysis->'classify'->>'call_type'='confirmation')::int as calls_confirmation
    from recordings r left join users u on u.company_id=r.company_id and u.ghl_user_id=r.raw->>'caller_ghl_user_id'
    where r.company_id=$1 and r.provider='ghl' and coalesce(r.raw->>'simulated','')='' and r.started_at>=$2 and r.started_at<$3 and ${real("r.contact_id")} group by u.id`, p);
  for (const m of ["dials", "connects", "talk_sec", "calls_set", "calls_setting", "calls_confirmation"] as const) { let t = 0; for (const r of calls) { add("setter", r.setter, m, r[m]); t += Number(r[m]) || 0; } add("total", "", m, t); }

  // bookings made (the act of booking happened that day), by the closer they were booked with; setter-booked also credited to the setter named on the booking
  const booked = await many<{ closer: string; booked: number; booked_self: number; booked_set: number }>(c, `
    select coalesce(assigned_user_id::text,'unknown') as closer, count(*)::int as booked, count(*) filter (where self_booked)::int as booked_self, count(*) filter (where self_booked=false)::int as booked_set
    from appointments a where a.company_id=$1 and a.source<>'test' and a.booked_at>=$2 and a.booked_at<$3 and ${real("a.contact_id")} group by a.assigned_user_id`, p);
  for (const m of ["booked", "booked_self", "booked_set"] as const) { let t = 0; for (const r of booked) { add("closer", r.closer, m, r[m]); t += Number(r[m]) || 0; } add("total", "", m, t); }
  for (const r of await many<{ setter: string; n: number }>(c, `
    select coalesce(u.id::text,'unknown') as setter, count(*)::int as n from appointments a left join users u on u.company_id=a.company_id and lower(u.name)=lower(a.set_by)
    where a.company_id=$1 and a.source<>'test' and a.self_booked=false and a.booked_at>=$2 and a.booked_at<$3 and ${real("a.contact_id")} group by u.id`, p)) add("setter", r.setter, "booked_set", r.n);

  // calls on the calendar that day (booked earlier, due that day) and how they ended
  const sched = await many<{ closer: string; scheduled: number; showed: number; noshow: number; cancelled: number }>(c, `
    select coalesce(a.assigned_user_id::text,'unknown') as closer, count(*)::int as scheduled,
           count(*) filter (where t.category='showed' or a.status='showed')::int as showed,
           count(*) filter (where t.category='noshow' or a.status='noshow')::int as noshow,
           count(*) filter (where a.status='cancelled' or t.category='cancelled')::int as cancelled
    from appointments a left join company_terms t on t.id=a.outcome_term
    where a.company_id=$1 and a.source<>'test' and a.starts_at>=$2 and a.starts_at<$3 and ${real("a.contact_id")} group by a.assigned_user_id`, p);
  for (const m of ["scheduled", "showed", "noshow", "cancelled"] as const) { let t = 0; for (const r of sched) { add("closer", r.closer, m, r[m]); t += Number(r[m]) || 0; } add("total", "", m, t); }

  // money: cash is what arrived, revenue is what was contracted (they diverge on every payment plan)
  const money = await one<{ payments: number; cash: number; refunds: number; refunded: number }>(c, `
    select count(*) filter (where status='succeeded')::int as payments, coalesce(sum(amount) filter (where status='succeeded'),0)::float as cash,
           count(*) filter (where status='refunded')::int as refunds, coalesce(-sum(amount) filter (where status='refunded'),0)::float as refunded
    from payments py where py.company_id=$1 and coalesce(py.raw->>'simulated','')='' and py.paid_at>=$2 and py.paid_at<$3 and ${real("py.contact_id")}`, p);
  for (const m of ["payments", "cash", "refunds", "refunded"] as const) add("total", "", m, money?.[m] ?? 0);
  const won = await many<{ closer: string; deals_won: number; revenue: number }>(c, `
    select coalesce((select a.assigned_user_id::text from appointments a where a.company_id=o.company_id and (a.opportunity_id=o.id or a.contact_id=o.contact_id) and a.source<>'test' order by a.starts_at desc limit 1),'unknown') as closer,
           count(*)::int as deals_won, coalesce(sum(o.contract_value),0)::float as revenue
    from opportunities o where o.company_id=$1 and o.status='won' and o.won_at>=$2 and o.won_at<$3 and ${real("o.contact_id")} group by 1`, p);
  for (const m of ["deals_won", "revenue"] as const) { let t = 0; for (const r of won) { add("closer", r.closer, m, r[m]); t += Number(r[m]) || 0; } add("total", "", m, t); }

  for (const [metric, value] of Object.entries(totals)) rows.push({ dimension: "total", dimension_id: "", metric, value });
  await c.query("delete from rollups_daily where company_id=$1 and day=$2", [companyId, day]);
  for (const r of rows) await c.query("insert into rollups_daily (company_id, day, dimension, dimension_id, metric, value) values ($1,$2,$3,$4,$5,$6)", [companyId, day, r.dimension, r.dimension_id, r.metric, r.value]);
  return rows;
}

/** Recomputes every local day in [from, to] (inclusive ISO dates). */
export async function rollupRange(c: PoolClient, companyId: string, from: string, to: string, tz: string): Promise<void> {
  for (let d = DateTime.fromISO(from, { zone: tz }); d.toISODate()! <= to; d = d.plus({ days: 1 })) await rollupDay(c, companyId, d.toISODate()!, tz);
}

/** Sums the rollups over a period: totals plus one row per setter / closer, named from the roster. */
export async function readMetrics(c: PoolClient, companyId: string, from: string, to: string): Promise<{ totals: Totals; setters: Breakdown[]; closers: Breakdown[] }> {
  const rows = await many<{ dimension: string; dimension_id: string; metric: string; value: string }>(c, "select dimension, dimension_id, metric, sum(value)::text as value from rollups_daily where company_id=$1 and day between $2 and $3 group by 1,2,3", [companyId, from, to]);
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

// ---- setter metrics (D64) ---------------------------------------------------------------------------------------------
/**
 * "What is Luis's speed to lead, and how many calls has he actually connected?" — answered from the ledger directly, not
 * the rollups: a median needs every lead's own number, and the rollups keep sums. Per setter (the user whose GHL id the
 * dialer stamped on the call; 'unassigned' when it stamped none), over [from, to] inclusive local dates.
 */
export type SetterStats = {
  id: string; name: string;
  leads_assigned: number;        // contacts assigned to them in the CRM, arrived in the period (for totals: every lead that arrived)
  never_dialled: number;         // of those, with no outbound dial by anyone yet
  dials: number;                 // outbound dialer calls they made in the period
  answered: number;              // dials the CRM marked connected, any length
  connected: number;             // answered and at least companies.reached_seconds long
  talk_sec: number;              // seconds on connected calls
  contacts_reached: number;      // distinct people behind the connected calls
  leads_dialled_first: number;   // period leads whose first outbound dial was theirs (speed to lead is measured on these)
  stl_median_min: number | null; // minutes from contacts.ghl_added_at to that first dial, median
  stl_avg_min: number | null;    // the same, mean
  bookings: number;              // appointments booked in the period stamped set_by with their name, or within a day after one of their dials to that person
};
export type SetterMetrics = { from: string; to: string; timezone: string; reached_seconds: number; totals: SetterStats; setters: SetterStats[] };

const UNASSIGNED = "unassigned";
const OUTBOUND_DIAL = "r.provider='ghl' and r.raw->>'kind'='phone' and r.raw->>'direction'='outbound' and coalesce(r.raw->>'simulated','')=''";
const blank = (id: string, name: string): SetterStats => ({ id, name, leads_assigned: 0, never_dialled: 0, dials: 0, answered: 0, connected: 0, talk_sec: 0, contacts_reached: 0, leads_dialled_first: 0, stl_median_min: null, stl_avg_min: null, bookings: 0 });

/** `testDomains`: leave the company's test contacts out (the bot's numbers, D73); omitted, everyone counts as before. */
export async function setterMetrics(c: PoolClient, companyId: string, period: { from: string; to: string }, opts: { testDomains?: string[] } = {}): Promise<SetterMetrics> {
  const co = await one<{ timezone: string; reached_seconds: number }>(c, "select timezone, reached_seconds from companies where id=$1", [companyId]);
  if (!co) throw new Error("company not found");
  const start = dayBounds(period.from, co.timezone).start, end = dayBounds(period.to, co.timezone).end;
  // the test domains ride as the statement's last parameter ($n) only when asked for; the clauses are empty otherwise
  const tp = opts.testDomains ? [opts.testDomains] : [];
  const notTest = (ct: string, n: number) => (opts.testDomains ? `and not ${testContactSql(ct, `$${n}`)}` : "");
  const notTestRec = (n: number) => (opts.testDomains ? `and not exists (select 1 from contacts tc where tc.id=r.contact_id and ${testContactSql("tc", `$${n}`)})` : "");
  const p = [companyId, start, end];
  const setters = new Map<string, SetterStats>();
  const totals = blank("total", "everyone");
  const row = (id: string | null, name: string | null) => { const k = id ?? UNASSIGNED; if (!setters.has(k)) setters.set(k, blank(k, name ?? UNASSIGNED)); return setters.get(k)!; };
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

  // dials they made, and how many of them were a real conversation
  for (const r of await many<{ id: string | null; name: string | null; dials: number; answered: number; connected: number; talk_sec: number; contacts_reached: number }>(c, `
    select u.id::text as id, u.name, count(*)::int as dials,
           count(*) filter (where r.raw->>'call_status'='connected')::int as answered,
           count(*) filter (where r.raw->>'call_status'='connected' and coalesce((r.raw->>'duration_sec')::int,0) >= $4)::int as connected,
           coalesce(sum((r.raw->>'duration_sec')::int) filter (where r.raw->>'call_status'='connected' and coalesce((r.raw->>'duration_sec')::int,0) >= $4),0)::int as talk_sec,
           count(distinct r.contact_id) filter (where r.raw->>'call_status'='connected' and coalesce((r.raw->>'duration_sec')::int,0) >= $4)::int as contacts_reached
    from recordings r left join users u on u.company_id=r.company_id and u.ghl_user_id=r.raw->>'caller_ghl_user_id'
    where r.company_id=$1 and ${OUTBOUND_DIAL} and r.started_at>=$2 and r.started_at<$3 ${notTestRec(5)} group by u.id, u.name`, [...p, co.reached_seconds, ...tp])) {
    const s = row(r.id, r.name);
    for (const m of ["dials", "answered", "connected", "talk_sec", "contacts_reached"] as const) { s[m] = Number(r[m]); totals[m] += Number(r[m]); }
  }
  totals.contacts_reached = Number((await one<{ n: number }>(c, `select count(distinct r.contact_id)::int as n from recordings r where r.company_id=$1 and ${OUTBOUND_DIAL} and r.started_at>=$2 and r.started_at<$3 and r.raw->>'call_status'='connected' and coalesce((r.raw->>'duration_sec')::int,0) >= $4 ${notTestRec(5)}`, [...p, co.reached_seconds, ...tp]))?.n ?? 0);

  // leads the CRM assigned to them, and the ones nobody has dialled
  for (const r of await many<{ id: string | null; name: string | null; n: number; never: number }>(c, `
    select u.id::text as id, u.name, count(*)::int as n,
           count(*) filter (where not exists (select 1 from recordings r where r.company_id=ct.company_id and r.contact_id=ct.id and ${OUTBOUND_DIAL} and r.started_at>=ct.ghl_added_at))::int as never
    from contacts ct left join users u on u.company_id=ct.company_id and u.ghl_user_id=ct.assigned_ghl_user_id
    where ct.company_id=$1 and ct.merged_into is null and ct.ghl_added_at>=$2 and ct.ghl_added_at<$3 ${notTest("ct", 4)} group by u.id, u.name`, [...p, ...tp])) {
    const s = row(r.id, r.name); s.leads_assigned = Number(r.n); s.never_dialled = Number(r.never);
    totals.leads_assigned += Number(r.n); totals.never_dialled += Number(r.never);
  }

  // speed to lead: arrival → the first outbound dial to that person, credited to whoever made it; grouping sets give the company-wide line in the same pass
  for (const r of await many<{ id: string | null; name: string | null; is_total: number; n: number; median: string | null; avg: string | null }>(c, `
    with lead as (select ct.id, ct.ghl_added_at, d.started_at, d.caller from contacts ct
      join lateral (select r.started_at, r.raw->>'caller_ghl_user_id' as caller from recordings r where r.company_id=ct.company_id and r.contact_id=ct.id and ${OUTBOUND_DIAL} and r.started_at>=ct.ghl_added_at order by r.started_at limit 1) d on true
      where ct.company_id=$1 and ct.merged_into is null and ct.ghl_added_at>=$2 and ct.ghl_added_at<$3 ${notTest("ct", 4)})
    select u.id::text as id, u.name, grouping(u.id, u.name) as is_total, count(*)::int as n,
           percentile_cont(0.5) within group (order by extract(epoch from (lead.started_at - lead.ghl_added_at))/60)::text as median,
           avg(extract(epoch from (lead.started_at - lead.ghl_added_at))/60)::text as avg
    from lead left join users u on u.company_id=$1 and u.ghl_user_id=lead.caller group by grouping sets ((u.id, u.name), ())`, [...p, ...tp])) {
    const s = Number(r.is_total) ? totals : row(r.id, r.name);
    s.leads_dialled_first = Number(r.n); s.stl_median_min = num(r.median); s.stl_avg_min = num(r.avg);
  }

  const notTestAppt = opts.testDomains ? `and not exists (select 1 from contacts tc where tc.id=a.contact_id and ${testContactSql("tc", "$4")})` : "";
  // bookings that followed: the booking source named them (set_by), or the person booked within a day of one of their dials
  for (const r of await many<{ id: string | null; name: string | null; is_total: number; n: number }>(c, `
    with mine as (
      select a.id as appt, u.id as uid, u.name from appointments a
        join recordings r on r.company_id=a.company_id and r.contact_id=a.contact_id and ${OUTBOUND_DIAL} and r.started_at<=a.booked_at and a.booked_at<r.started_at+interval '1 day'
        left join users u on u.company_id=a.company_id and u.ghl_user_id=r.raw->>'caller_ghl_user_id'
        where a.company_id=$1 and a.source<>'test' and a.booked_at>=$2 and a.booked_at<$3 ${notTestAppt}
      union
      select a.id, u.id, u.name from appointments a join users u on u.company_id=a.company_id and lower(u.name)=lower(a.set_by)
        where a.company_id=$1 and a.source<>'test' and a.booked_at>=$2 and a.booked_at<$3 ${notTestAppt})
    select uid::text as id, name, grouping(uid, name) as is_total, count(distinct appt)::int as n from mine group by grouping sets ((uid, name), ())`, [...p, ...tp])) {
    if (Number(r.is_total)) totals.bookings = Number(r.n); else row(r.id, r.name).bookings = Number(r.n);
  }

  const list = [...setters.values()].filter((s) => s.dials || s.leads_assigned || s.bookings).sort((a, b) => b.dials - a.dials || a.name.localeCompare(b.name));
  return { from: period.from, to: period.to, timezone: co.timezone, reached_seconds: co.reached_seconds, totals, setters: list };
}
