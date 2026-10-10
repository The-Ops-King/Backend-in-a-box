import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { liveGhlReads, type GhlReads } from "@/adapters/ghl/metrics";
import { dayBounds, setterMetrics, type SetterStats } from "./metrics";
import { AvailabilityUnreadable, readAvailability, type Availability, type HealthProbes } from "./health";
import { loadCompany } from "./context";
import { testContactSql, testDomains } from "./mode";
import { GHL_SOURCE, closesFor, ghlRows, showBreakdown, type GhlCtx, type GhlEntity, type QualificationSummary, type ShowBreakdown } from "./ghl-metrics";

/**
 * The metric layer (D70): every number the Slack bot says has ONE definition here, written once in SQL against the
 * ledger or, for people, deals, calls (D73) and cash (D75), read live from GHL, with the plain-words sentence the model and /help use.
 * Test contacts (D52's rule) never count anywhere. Definitions follow what the wrap-ups (rollups, D29)
 * and setter metrics (D64) already count; nothing is re-invented. Counts and sums are computed per group; a rate is
 * always two of them divided where it is read (never an average of averages).
 */
export type GroupBy = "source" | "closer" | "setter" | "day" | "week" | "month";
export const GROUP_BYS: GroupBy[] = ["source", "closer", "setter", "day", "week", "month"];
export type Filters = { closer?: string; setter?: string; source?: string; userId?: string };
export type Unit = "count" | "money" | "rate" | "minutes";
export type Period = { from: string; to: string; label: string; name: string };   // inclusive ISO dates in the company's zone
export type MetricRow = { key: string; label: string; value: number | null; numerator?: number; denominator?: number };
export type MetricResult = {
  metric: string; label: string; definition: string; unit: Unit; period_label: string; period_name: string; from: string; to: string; timezone: string;
  value: number | null; numerator?: number; denominator?: number; numerator_label?: string; denominator_label?: string;
  group_by?: GroupBy; rows?: MetricRow[]; filters?: Record<string, string>;
  /** Where the number was read: GHL live (people, deals, calls) or the engine's ledger (bookings, cash, dials as polled and received). */
  source: string;
  /** MQLs: how the period's leads answered the work-situation question. */
  qualification?: QualificationSummary;
  /** Show rate: every due call by outcome, who has none filed, and where GHL and the booking source disagree. */
  shows_breakdown?: ShowBreakdown;
  /** Said instead of a number when GHL holds nothing to count yet (D75: no Payment records is never $0). */
  unavailable?: string;
};
export const LEDGER = "the engine's ledger";
export class MetricError extends Error {}

// ---- periods ----------------------------------------------------------------------------------------------------------
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthIndex = (s: string) => { const i = MONTHS.indexOf(s.slice(0, 3)); return i < 0 || !/^[a-z]+\.?$/.test(s) ? null : i + 1; };

export function rangeLabel(from: string, to: string, tz: string, now: DateTime = DateTime.now()): string {
  const a = DateTime.fromISO(from, { zone: tz }), b = DateTime.fromISO(to, { zone: tz }), cur = now.setZone(tz).year;
  const yr = (d: DateTime) => (d.year !== cur ? `, ${d.year}` : "");
  if (from === to) return `${a.toFormat("LLL d")}${yr(a)}`;
  if (a.year === b.year && a.month === b.month) return `${a.toFormat("LLL d")}–${b.day}${yr(b)}`;
  if (a.year === b.year) return `${a.toFormat("LLL d")} – ${b.toFormat("LLL d")}${yr(b)}`;
  return `${a.toFormat("LLL d, yyyy")} – ${b.toFormat("LLL d, yyyy")}`;
}

/** One date the way people type it: 2026-10-03, 10/3, 10/3/2026, Oct 3, October 3 2026. A year-less date never lands in the future. */
function parseDay(s: string, today: DateTime): DateTime | null {
  s = s.trim().replace(/,/g, " ").replace(/\s+/g, " ").replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) { const d = today.set({ year: +m[1], month: +m[2], day: +m[3] }); return d.isValid && d.month === +m[2] ? d : null; }
  let month: number | null = null, day: number | null = null, year: number | null = null;
  if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s))) { month = +m[1]; day = +m[2]; year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null; }
  else if ((m = /^([a-z]+)\.? (\d{1,2})(?: (\d{4}))?$/.exec(s)) && monthIndex(m[1])) { month = monthIndex(m[1]); day = +m[2]; year = m[3] ? +m[3] : null; }
  else return null;
  if (!month || !day || month > 12 || day > 31) return null;
  let d = today.set({ year: year ?? today.year, month, day });
  if (!d.isValid || d.month !== month) return null;
  if (!year && d > today) d = d.minus({ years: 1 });
  return d;
}

/**
 * A period in plain words, in the company's zone, as inclusive local dates. "This month" is the calendar month so far
 * (Tyler: "this month = this calendar month"). Null when the words are not a period this parser knows: the bot then asks
 * rather than guessing.
 */
export function parsePeriod(text: string | null | undefined, tz: string, now: DateTime = DateTime.now()): Period | null {
  const t = (text ?? "").toLowerCase().trim().replace(/[?.!]+$/, "").replace(/^(?:for|in|over|during|from)\s+/, "").replace(/^the\s+/, "").replace(/\s+/g, " ");
  if (!t) return null;
  const today = now.setZone(tz).startOf("day");
  const mk = (a: DateTime, b: DateTime, name: string): Period | null => {
    if (b > today) b = today;
    if (a > b) return null;
    const from = a.toISODate()!, to = b.toISODate()!;
    return { from, to, name, label: rangeLabel(from, to, tz, now) };
  };
  if (t === "today") return mk(today, today, "Today");
  if (t === "yesterday") return mk(today.minus({ days: 1 }), today.minus({ days: 1 }), "Yesterday");
  if (/^(this week|wtd|week to date|week-to-date|so far this week|current week)$/.test(t)) return mk(today.startOf("week"), today, "This week");
  if (/^(last week|previous week|prior week)$/.test(t)) { const w = today.startOf("week").minus({ weeks: 1 }); return mk(w, w.plus({ days: 6 }), "Last week"); }
  if (/^(this month|mtd|month to date|month-to-date|this calendar month|so far this month|current month)$/.test(t)) return mk(today.startOf("month"), today, "This month");
  if (/^(last month|previous month|prior month|last calendar month)$/.test(t)) { const m = today.startOf("month").minus({ months: 1 }); return mk(m, m.endOf("month").startOf("day"), "Last month"); }
  if (/^(this quarter|qtd|quarter to date)$/.test(t)) return mk(today.startOf("quarter"), today, "This quarter");
  if (/^(last quarter|previous quarter)$/.test(t)) { const q = today.startOf("quarter").minus({ quarters: 1 }); return mk(q, q.endOf("quarter").startOf("day"), "Last quarter"); }
  if (/^(this year|ytd|year to date)$/.test(t)) return mk(today.startOf("year"), today, "This year");
  if (/^(last year|previous year)$/.test(t)) { const y = today.startOf("year").minus({ years: 1 }); return mk(y, y.endOf("year").startOf("day"), "Last year"); }
  let m = /^(?:last|past|previous|trailing) (\d{1,3}) days?$/.exec(t);
  if (m && +m[1] >= 1) return mk(today.minus({ days: +m[1] - 1 }), today, `Last ${m[1]} days`);
  if (/^(?:last|past) (?:7 days|seven days)$/.test(t)) return mk(today.minus({ days: 6 }), today, "Last 7 days");
  m = /^([a-z]+)\.?(?: (\d{4}))?$/.exec(t);
  if (m && monthIndex(m[1])) {
    let start = today.set({ month: monthIndex(m[1])!, day: 1, year: m[2] ? +m[2] : today.year });
    if (!m[2] && start > today) start = start.minus({ years: 1 });
    return mk(start, start.endOf("month").startOf("day"), start.toFormat(start.year === today.year ? "LLLL" : "LLLL yyyy"));
  }
  m = /^since (.+)$/.exec(t);
  if (m) { const a = parseDay(m[1], today); return a ? mk(a, today, `Since ${a.toFormat("LLL d")}`) : null; }
  // "Sep 1-15", "oct 3 – 9"
  m = /^([a-z]+)\.? (\d{1,2}) ?[-–—] ?(\d{1,2})(?: (\d{4}))?$/.exec(t);
  if (m && monthIndex(m[1])) {
    const a = parseDay(`${m[1]} ${m[2]}${m[4] ? ` ${m[4]}` : ""}`, today), b = a ? a.set({ day: +m[3] }) : null;
    return a && b?.isValid && b.month === a.month ? mk(a, b, "Custom") : null;
  }
  const parts = t.split(/\s+(?:to|through|thru|until|till|and)\s+|\s+[-–—]\s+|\.\.|\s*[–—]\s*/).map((p) => p.replace(/^between\s+/, ""));
  if (parts.length === 2) { const a = parseDay(parts[0], today), b = parseDay(parts[1], today); return a && b ? mk(a, b, "Custom") : null; }
  const one = parseDay(t, today);
  return one ? mk(one, one, one.toFormat("cccc")) : null;
}

/** The same days one step back, for "vs last month": the previous month (or week) clipped to as many days as this one has. */
export function previousPeriod(p: Period, unit: "month" | "week", tz: string, now: DateTime = DateTime.now()): Period {
  const a = DateTime.fromISO(p.from, { zone: tz }).minus(unit === "month" ? { months: 1 } : { weeks: 1 });
  const len = DateTime.fromISO(p.to, { zone: tz }).diff(DateTime.fromISO(p.from, { zone: tz }), "days").days;
  const whole = unit === "month" && p.from.endsWith("-01") && DateTime.fromISO(p.to, { zone: tz }).plus({ days: 1 }).day === 1;
  let b = whole ? a.endOf("month").startOf("day") : a.plus({ days: len });
  if (unit === "month" && b.month !== a.month) b = a.endOf("month").startOf("day");
  const from = a.toISODate()!, to = b.toISODate()!;
  return { from, to, name: whole ? "Month before" : unit === "month" ? "Same days last month" : "Week before", label: rangeLabel(from, to, tz, now) };
}

// ---- the registry -----------------------------------------------------------------------------------------------------
type Entity = "contact" | "appointment_booked" | "appointment_due" | "reschedule";
type Q = { companyId: string; start: Date; end: Date; tz: string; sourceField: string; now: Date; domains: string[]; groupBy?: GroupBy; filters: { closer?: string; setter?: string; source?: string } };

// a person's source: the CRM's lead-source field the company bound (crm.field_contact_lead_source), else the UTM source on their latest booking
const SOURCE = (ct: string) => `coalesce(nullif(${ct}.ghl_fields->>$5::text,''), (select nullif(sa.tracking->>'utm_source','') from appointments sa where sa.company_id=${ct}.company_id and sa.contact_id=${ct}.id and sa.source<>'test' and coalesce(sa.tracking->>'utm_source','')<>'' order by sa.booked_at desc limit 1), 'unknown')`;
// $7: the company's test domains; every entity leaves test contacts out (D73)
const NOT_TEST = `not ${testContactSql("ct", "$7")}`;
const ENTITIES: Record<Entity, { from: string; where: string; time: string; closer?: string; setter?: string; source: string }> = {
  contact: { from: "contacts ct", where: `ct.company_id=$1 and ct.merged_into is null and ${NOT_TEST}`, time: "ct.ghl_added_at", source: SOURCE("ct") },
  appointment_booked: { from: "appointments a join contacts ct on ct.id=a.contact_id left join company_terms ot on ot.id=a.outcome_term left join company_terms cot on cot.id=a.call_outcome_term",
    where: `a.company_id=$1 and a.source<>'test' and ${NOT_TEST}`, time: "a.booked_at", closer: "a.assigned_user_id",
    setter: "(select su.id from users su where su.company_id=a.company_id and lower(su.name)=lower(a.set_by) limit 1)", source: SOURCE("ct") },
  appointment_due: { from: "appointments a join contacts ct on ct.id=a.contact_id left join company_terms ot on ot.id=a.outcome_term left join company_terms cot on cot.id=a.call_outcome_term",
    where: `a.company_id=$1 and a.source<>'test' and ${NOT_TEST}`, time: "a.starts_at", closer: "a.assigned_user_id",
    setter: "(select su.id from users su where su.company_id=a.company_id and lower(su.name)=lower(a.set_by) limit 1)", source: SOURCE("ct") },
  reschedule: { from: "events e join appointments a on a.id=e.appointment_id join contacts ct on ct.id=a.contact_id", where: `e.company_id=$1 and e.event_type='appointment.rescheduled' and e.source<>'test' and a.source<>'test' and ${NOT_TEST}`,
    time: "e.occurred_at", closer: "a.assigned_user_id", source: SOURCE("ct") },
};

type Base = { kind: "base"; label: string; unit: Unit; definition: string; entity: Entity; value: string; where?: string };
type Rate = { kind: "rate"; label: string; definition: string; num: string; den: string };
type Setter = { kind: "setter"; label: string; unit: Unit; definition: string; pick: (s: SetterStats) => number | null; count: (s: SetterStats) => number };
/** Read live from GHL (D73): the computation is in ghl-metrics.ts, keyed by the metric's name. */
type Ghl = { kind: "ghl"; label: string; unit: Unit; definition: string; entity: GhlEntity };
type Def = Base | Rate | Setter | Ghl;

const DUE = "a.starts_at < $6 and a.status not in ('cancelled','invalid') and coalesce(ot.category,'') not in ('cancelled','rescheduled')";

export const METRICS: Record<string, Def> = {
  leads: { kind: "ghl", label: "Leads", unit: "count", entity: "lead", definition: "people who entered their information: GHL contacts by the date GHL added them" },
  mqls: { kind: "ghl", label: "MQLs", unit: "count", entity: "lead", definition: "leads whose answer to the work-situation question meets the employment standard (an MQL answer in the company's list); a blank answer is not an MQL unless the company counts it, and an answer outside both lists is never counted" },
  leads_booked: { kind: "base", label: "Leads who booked", unit: "count", entity: "contact", value: "count(*)", where: "exists (select 1 from appointments la where la.company_id=ct.company_id and la.contact_id=ct.id and la.source<>'test')", definition: "leads that arrived in the period and have booked a call (any time since), from the ledger" },
  leads_showed: { kind: "base", label: "Leads who showed", unit: "count", entity: "contact", value: "count(*)", where: "exists (select 1 from appointments la left join company_terms lt on lt.id=la.outcome_term where la.company_id=ct.company_id and la.contact_id=ct.id and la.source<>'test' and (lt.category='showed' or la.status='showed'))", definition: "leads that arrived in the period and have showed on a call (any time since), from the ledger" },
  mql_rate: { kind: "rate", label: "MQL rate", num: "mqls", den: "leads", definition: "MQLs ÷ leads, both by the date GHL added them" },
  marketing_dqs: { kind: "ghl", label: "Marketing DQs", unit: "count", entity: "lead", definition: "leads filtered out before a sales call on financial signals: their answer to the work-situation question is a DQ answer (e.g. currently between jobs, employed part-time). Also called DQLs" },
  booked: { kind: "base", label: "Bookings made", unit: "count", entity: "appointment_booked", value: "count(*)", definition: "bookings made in the period (the act of booking), any call type, by the closer they were booked with, from the booking source" },
  booked_self: { kind: "base", label: "Self-booked", unit: "count", entity: "appointment_booked", value: "count(*)", where: "a.self_booked", definition: "bookings made in the period that the person booked themselves, from the booking source" },
  booked_set: { kind: "base", label: "Setter-booked", unit: "count", entity: "appointment_booked", value: "count(*)", where: "a.self_booked = false", definition: "bookings made in the period that a setter booked, from the booking source" },
  calls_booked_due: { kind: "ghl", label: "Calls booked", unit: "count", entity: "call", definition: "Sales Call records in GHL whose call time fell in the period and has passed, cancellations included (future calls are not counted; a slot the call was rescheduled away from is listed, not counted)" },
  calls_due: { kind: "base", label: "Calls due", unit: "count", entity: "appointment_due", value: "count(*)", where: DUE, definition: "ledger: calls whose start time fell in the period and has passed, not cancelled or rescheduled" },
  shows: { kind: "ghl", label: "Shows", unit: "count", entity: "call", definition: "calls booked in the period whose GHL Sales Call outcome is showed" },
  no_shows: { kind: "ghl", label: "No-shows", unit: "count", entity: "call", definition: "calls booked in the period whose GHL Sales Call outcome is no-show" },
  show_rate: { kind: "rate", label: "Show rate", num: "shows", den: "calls_booked_due", definition: "shows ÷ calls booked whose time has passed, cancellations included, rescheduled slots not; a call with no outcome filed is missing from EOD disposition and counts as not showed" },
  cancellations: { kind: "ghl", label: "Cancellations", unit: "count", entity: "call", definition: "calls booked in the period that were cancelled: the Sales Call outcome cancelled or late cancel, or the booking source saying cancelled (which wins)" },
  reschedules: { kind: "base", label: "Reschedules", unit: "count", entity: "reschedule", value: "count(*)", definition: "times a booked call was moved to a new time, by when it was moved, from the booking source" },
  sales_dqs: { kind: "ghl", label: "Sales DQs", unit: "count", entity: "call", definition: "people who got on a sales call and were disqualified for any reason: Sales Call records in GHL whose call time fell in the period with a DQ disposition" },
  closes: { kind: "ghl", label: "Closes", unit: "count", entity: "close", definition: "new people we collected cash from: distinct people with a won card on the Closer pipeline in GHL, by when it was won (the setter pipeline's won is a show, not a sale); credited to the closer of their latest call, else the card's owner" },
  close_rate: { kind: "rate", label: "Close rate", num: "closes", den: "shows", definition: "closes ÷ shows in the same period" },
  revenue: { kind: "ghl", label: "Revenue", unit: "money", entity: "close", definition: "value of the won Closer-pipeline cards in GHL in the period" },
  cash_collected: { kind: "ghl", label: "Cash collected", unit: "money", entity: "payment", definition: "GHL Payment records by when they occurred: succeeded payments in, refunds and chargebacks out; credited to the record's closer (and setter)" },
  cash_gross: { kind: "ghl", label: "Payments", unit: "money", entity: "payment", definition: "succeeded GHL Payment records in the period, before refunds" },
  refunds: { kind: "ghl", label: "Refunds", unit: "money", entity: "payment", definition: "refunds and chargebacks in GHL's Payment records in the period" },
  speed_to_lead: { kind: "setter", label: "Speed to lead", unit: "minutes", pick: (s) => s.stl_median_min, count: (s) => s.leads_dialled_first, definition: "median minutes from a lead arriving to the first outbound dial, credited to whoever dialled (leads never dialled are not counted)" },
  dials: { kind: "setter", label: "Dials", unit: "count", pick: (s) => s.dials, count: (s) => s.dials, definition: "outbound dialer calls made in the period" },
  connected: { kind: "setter", label: "Connected calls", unit: "count", pick: (s) => s.connected, count: (s) => s.connected, definition: "outbound dials the CRM marked connected and at least the company's reached-seconds long" },
};
export const METRIC_NAMES = Object.keys(METRICS);

const unitOf = (d: Def): Unit => (d.kind === "rate" ? "rate" : d.unit);
/** Which ways a metric can be split. */
export function dimsOf(name: string): GroupBy[] {
  const d = METRICS[name]; if (!d) return [];
  if (d.kind === "setter") return ["setter"];
  if (d.kind === "rate") { const a = dimsOf(d.num), b = dimsOf(d.den); return a.filter((x) => b.includes(x)); }
  if (d.kind === "ghl") return GROUP_BYS.filter((g) => (g !== "setter" || d.entity === "payment") && (g !== "closer" || d.entity !== "lead"));
  const e = ENTITIES[d.entity];
  return GROUP_BYS.filter((g) => (g === "closer" ? !!e.closer : g === "setter" ? !!e.setter : true));
}
/** The one-line catalogue the model and /help read. */
export const catalogue = () => METRIC_NAMES.map((n) => `${n}: ${METRICS[n].label} — ${METRICS[n].definition} (split by: ${dimsOf(n).join(", ") || "none"})`).join("\n");

function buildBase(d: Base, q: Q): { sql: string; params: unknown[] } {
  const e = ENTITIES[d.entity];
  const params: unknown[] = [q.companyId, q.start, q.end, q.tz, q.sourceField, q.now, q.domains];
  const where = [e.where, `${e.time} >= $2 and ${e.time} < $3`, d.where ? `(${d.where})` : ""].filter(Boolean);
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (q.filters.closer) { if (!e.closer) throw new MetricError(`${d.label} cannot be filtered by closer`); where.push(`${e.closer} = ${bind(q.filters.closer)}::uuid`); }
  if (q.filters.setter) { if (!e.setter) throw new MetricError(`${d.label} cannot be filtered by setter`); where.push(`${e.setter} = ${bind(q.filters.setter)}::uuid`); }
  if (q.filters.source) where.push(`lower(${e.source}) = lower(${bind(q.filters.source)})`);
  const g = q.groupBy;
  const key = !g ? "''" : g === "source" ? e.source : g === "closer" ? `${e.closer}::text` : g === "setter" ? `${e.setter}::text`
    : `to_char(date_trunc('${g}', ${e.time} at time zone $4), '${g === "month" ? "YYYY-MM" : "YYYY-MM-DD"}')`;
  // $4..$6 are bound on every statement; the trailing checks give each a type even where the metric does not read it
  return { sql: `select ${key} as g, (${d.value})::float as n from ${e.from} where ${where.join(" and ")} and $4::text is not null and $5::text is not null and $6::timestamptz is not null group by 1`, params };
}

export type MetricQuery = { metric: string; period: Period; groupBy?: GroupBy; filters?: Filters; now?: Date };
/** Runs one named metric for one company over a period, optionally split and filtered. Throws MetricError when the ask does not fit the metric. */
export async function getMetric(c: PoolClient, companyId: string, q: MetricQuery, reads: GhlReads = liveGhlReads): Promise<MetricResult> {
  const def = METRICS[q.metric];
  if (!def) throw new MetricError(`no metric named "${q.metric}"; known: ${METRIC_NAMES.join(", ")}`);
  if (q.groupBy && !dimsOf(q.metric).includes(q.groupBy)) throw new MetricError(`${def.label} cannot be split by ${q.groupBy}; it can be split by: ${dimsOf(q.metric).join(", ") || "nothing"}`);
  const co = await one<{ id: string }>(c, "select id from companies where id=$1", [companyId]);
  if (!co) throw new MetricError("company not found");
  const { row, adapterCompany: ac, bindings } = await loadCompany(c, companyId);
  const tz = row.timezone;
  const roster = await many<{ id: string; name: string; role: string }>(c, "select id::text as id, name, role from users where company_id=$1", [companyId]);
  const nameOf = (id: string) => roster.find((u) => u.id === id)?.name;
  const filters = resolveFilters(q.metric, q.filters ?? {}, roster);
  const sourceField = bindings["crm.field_contact_lead_source"] ?? "", domains = testDomains(bindings);
  const start = dayBounds(q.period.from, tz).start, end = dayBounds(q.period.to, tz).end, now = q.now ?? new Date();
  const base: Omit<Q, "groupBy"> = { companyId, start, end, tz, sourceField, now, domains, filters };
  const ghl: GhlCtx = { c, companyId, ac, bindings, reads, tz, start, end, now, sourceField, domains, filters, memo: { sources: new Map() } };
  const isGhl = (name: string): boolean => { const d = METRICS[name]; return d.kind === "ghl" || (d.kind === "rate" && isGhl(d.num) && isGhl(d.den)); };
  const fromGhl = (name: string): boolean => { const d = METRICS[name]; return d.kind === "ghl" || (d.kind === "rate" && (fromGhl(d.num) || fromGhl(d.den))); };
  const head = { source: isGhl(q.metric) ? GHL_SOURCE : fromGhl(q.metric) ? `${GHL_SOURCE} and ${LEDGER}` : LEDGER, metric: q.metric, label: def.label, definition: def.definition, unit: unitOf(def), period_label: q.period.label, period_name: q.period.name, from: q.period.from, to: q.period.to, timezone: tz, group_by: q.groupBy,
    filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v).map(([k, v]) => [k, k === "source" ? v! : nameOf(v!) ?? v!])) };
  const label = (g: GroupBy | undefined, k: string) => (g === "closer" || g === "setter" ? (k ? nameOf(k) ?? k : "unassigned") : g === "day" ? DateTime.fromISO(k, { zone: tz }).toFormat("ccc LLL d") : g === "week" ? `week of ${DateTime.fromISO(k, { zone: tz }).toFormat("LLL d")}` : g === "month" ? DateTime.fromISO(`${k}-01`, { zone: tz }).toFormat("LLLL yyyy") : k);

  if (def.kind === "setter") {
    if (filters.closer || filters.source) throw new MetricError(`${def.label} can only be filtered by setter`);
    const m = await setterMetrics(c, companyId, { from: q.period.from, to: q.period.to }, { testDomains: domains });
    const only = filters.setter ? m.setters.find((s) => s.id === filters.setter) : null;
    const value = filters.setter ? (only ? def.pick(only) : def.unit === "minutes" ? null : 0) : def.pick(m.totals);
    const rows = q.groupBy === "setter" ? m.setters.filter((s) => !filters.setter || s.id === filters.setter).map((s) => ({ key: s.id, label: s.name, value: def.pick(s), numerator: def.count(s) })) : undefined;
    return { ...head, value, rows };
  }
  let qualification: QualificationSummary | undefined, unavailable: string | undefined;
  const runBase = async (name: string, groupBy?: GroupBy): Promise<Map<string, number>> => {
    const g = METRICS[name];
    if (g.kind === "ghl") { const r = await ghlRows(ghl, name, g.entity, g.label, groupBy); qualification ??= r.qualification; unavailable ??= r.unavailable; return r.rows; }
    const d = g as Base;
    const { sql, params } = buildBase(d, { ...base, groupBy });
    const r = await many<{ g: string | null; n: number }>(c, sql, params);
    return new Map(r.map((x) => [x.g ?? "", Number(x.n) || 0]));
  };
  const extra = async () => ({ ...(qualification ? { qualification } : {}), ...(q.metric === "show_rate" ? { shows_breakdown: await showBreakdown(ghl) } : {}) });
  if (def.kind === "base" || def.kind === "ghl") {
    const total = (await runBase(q.metric)).get("") ?? 0;
    if (unavailable) return { ...head, value: null, unavailable };
    const rows = q.groupBy ? [...(await runBase(q.metric, q.groupBy)).entries()].map(([k, v]) => ({ key: k, label: label(q.groupBy, k), value: v })) : undefined;
    return { ...head, value: total, rows: rows && sortRows(rows, q.groupBy), ...(await extra()) };
  }
  const rate = (n: number, d: number) => (d > 0 ? n / d : null);
  const n = (await runBase(def.num)).get("") ?? 0, d = (await runBase(def.den)).get("") ?? 0;
  let rows: MetricRow[] | undefined;
  if (q.groupBy) {
    const ns = await runBase(def.num, q.groupBy), ds = await runBase(def.den, q.groupBy);
    rows = sortRows([...new Set([...ns.keys(), ...ds.keys()])].map((k) => ({ key: k, label: label(q.groupBy, k), value: rate(ns.get(k) ?? 0, ds.get(k) ?? 0), numerator: ns.get(k) ?? 0, denominator: ds.get(k) ?? 0 })), q.groupBy);
  }
  return { ...head, value: rate(n, d), numerator: n, denominator: d, numerator_label: METRICS[def.num].label.toLowerCase(), denominator_label: METRICS[def.den].label.toLowerCase(), rows, ...(await extra()) };
}

export type ClosesList = { metric: "closes_list"; label: string; source: string; period_label: string; period_name: string; timezone: string; count: number; filters?: Record<string, string>;
  closes: { name: string; closer: string; won: string; value: number }[] };
/** Each close of a period, newest first: the person, the closer credited, the day it was won. The same people `closes` counts. */
export async function getCloses(c: PoolClient, companyId: string, q: { period: Period; filters?: Filters; now?: Date }, reads: GhlReads = liveGhlReads): Promise<ClosesList> {
  const { row, adapterCompany: ac, bindings } = await loadCompany(c, companyId);
  const tz = row.timezone;
  const roster = await many<{ id: string; name: string; role: string }>(c, "select id::text as id, name, role from users where company_id=$1", [companyId]);
  const filters = resolveFilters("closes", q.filters ?? {}, roster);
  const start = dayBounds(q.period.from, tz).start, end = dayBounds(q.period.to, tz).end;
  const x: GhlCtx = { c, companyId, ac, bindings, reads, tz, start, end, now: q.now ?? new Date(), sourceField: bindings["crm.field_contact_lead_source"] ?? "", domains: testDomains(bindings), filters, memo: { sources: new Map() } };
  const list = await closesFor(x);
  const nameOf = (id: string) => (id ? roster.find((u) => u.id === id)?.name ?? id : "unassigned");
  return { metric: "closes_list", label: "Closes", source: GHL_SOURCE, period_label: q.period.label, period_name: q.period.name, timezone: tz, count: list.length,
    ...(filters.closer ? { filters: { closer: nameOf(filters.closer) } } : {}), closes: list.map((k) => ({ name: k.name, closer: nameOf(k.closer), won: k.at.toFormat("ccc LLL d"), value: k.value })) };
}

const sortRows = (rows: MetricRow[], g?: GroupBy) => (g === "day" || g === "week" || g === "month" ? rows.sort((a, b) => a.key.localeCompare(b.key)) : rows.sort((a, b) => (b.denominator ?? b.value ?? 0) - (a.denominator ?? a.value ?? 0) || a.label.localeCompare(b.label)));

/**
 * Names to engine user ids. `userId` (the asker, for "my …") lands on the person dimension the metric has: a setter's
 * own on the setter side when the metric can be split by setter, everyone else on the closer side.
 */
function resolveFilters(metric: string, f: Filters, roster: { id: string; name: string; role: string }[]): { closer?: string; setter?: string; source?: string } {
  const dims = dimsOf(metric);
  const person = (who: string, side: "closer" | "setter") => {
    const w = who.trim().toLowerCase();
    if (/^[0-9a-f-]{36}$/.test(w) && roster.some((u) => u.id === w)) return w;
    const hits = roster.filter((u) => u.name.toLowerCase() === w);
    const loose = hits.length ? hits : roster.filter((u) => u.name.toLowerCase().split(/\s+/)[0] === w.split(/\s+/)[0] && (w.includes(" ") ? u.name.toLowerCase().startsWith(w) : true));
    if (loose.length === 1) return loose[0].id;
    const names = roster.filter((u) => side === "setter" ? ["setter", "staff", "owner", "manager"].includes(u.role) : ["closer", "owner", "manager"].includes(u.role)).map((u) => u.name);
    throw new MetricError(loose.length > 1 ? `"${who}" matches ${loose.map((u) => u.name).join(" and ")}; which one?` : `no one on the roster is called "${who}"; ${side}s on the roster: ${names.join(", ") || "none"}`);
  };
  const out: { closer?: string; setter?: string; source?: string } = {};
  if (f.closer) out.closer = person(f.closer, "closer");
  if (f.setter) out.setter = person(f.setter, "setter");
  if (f.source) out.source = f.source.trim();
  if (f.userId) {
    const me = roster.find((u) => u.id === f.userId);
    if (!me) throw new MetricError("the asker is not on the roster");
    const side = me.role === "setter" && dims.includes("setter") ? "setter" : dims.includes("closer") ? "closer" : dims.includes("setter") ? "setter" : null;
    if (!side) throw new MetricError(`${METRICS[metric].label} is a company-wide number; it is not kept per person`);
    out[side] = me.id;
  }
  return out;
}

// ---- availability ----------------------------------------------------------------------------------------------------
export type { Availability } from "./health";
/** Open slots per closer per day over the next days (D72), the same read as the low-availability thread. A source that cannot be read is an error, never zero. */
export async function getAvailability(c: PoolClient, companyId: string, probes: HealthProbes, days = 7, now: DateTime = DateTime.now()): Promise<Availability> {
  try { return await readAvailability(c, companyId, probes, days, now); }
  catch (e) { if (e instanceof AvailabilityUnreadable) throw new MetricError(e.message); throw e; }
}
