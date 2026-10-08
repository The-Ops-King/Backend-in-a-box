import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { CompanyRow } from "./context";
import { readMetrics, rollupRange, type Breakdown, type Totals } from "./metrics";

/**
 * Wrap-ups (D29): "what happened today / this week / this month", computed from the daily rollups and posted to Slack
 * on the company's own schedule. Every number names its denominator; a rate with no denominator is "—", not 0%.
 * Nothing here is a constant: the time, the day, the channel, the breakdowns and sections are the wrap-ups workflow's
 * steps (a schedule trigger, a report step, a slack_post), edited like any other workflow (D35).
 */
export type ReportKind = "daily" | "weekly" | "monthly";
export const REPORT_KINDS: ReportKind[] = ["daily", "weekly", "monthly"];
export type Period = { start: string; end: string };   // inclusive ISO dates in the company's zone

/** The period a scheduled run covers when it fires at `now` (company zone): today; last Monday–Sunday; last month. `toDate` = the period in progress, for on-demand. */
export function periodFor(kind: ReportKind, now: DateTime<boolean>, toDate = false): Period {
  if (kind === "daily") return { start: now.toISODate()!, end: now.toISODate()! };
  if (kind === "weekly") { const w = toDate ? now.startOf("week") : now.startOf("week").minus({ weeks: 1 }); return { start: w.toISODate()!, end: (toDate ? now : w.plus({ days: 6 })).toISODate()! }; }
  const m = toDate ? now.startOf("month") : now.startOf("month").minus({ months: 1 });
  return { start: m.toISODate()!, end: (toDate ? now : m.endOf("month")).toISODate()! };
}

// ---- rendering ---------------------------------------------------------------------------------------------------------
const W = 34;
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "—");
const mins = (sec: number) => `${Math.round(sec / 60)} min`;
const row = (label: string, value: string | number, note?: string) => `${label.padEnd(W)}${String(value).padStart(6)}${note ? `   ${note}` : ""}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function heading(kind: ReportKind, period: Period, tz: string, toDate: boolean): string {
  const s = DateTime.fromISO(period.start, { zone: tz }), e = DateTime.fromISO(period.end, { zone: tz });
  if (kind === "daily") return `What happened today — ${s.toFormat("cccc, LLL d")}`;
  if (kind === "weekly") return `${toDate ? "This week so far" : "Last week"} — ${s.toFormat("LLL d")} to ${e.toFormat("LLL d")}`;
  return `${toDate ? `${s.toFormat("LLLL")} so far` : s.toFormat("LLLL yyyy")}`;
}

export type Said = { label: string; answered: number; top: [string, number][]; rest: number; restKinds: number }[];
/** What the period's new bookings answered on the booking form, tallied per question. Reads the questions the booking source carries (D24); no list to maintain. */
export async function whatTheySaid(c: PoolClient, companyId: string, period: Period, tz: string): Promise<Said> {
  const from = DateTime.fromISO(period.start, { zone: tz }).startOf("day").toJSDate(), to = DateTime.fromISO(period.end, { zone: tz }).endOf("day").toJSDate();
  const rows = await many<{ answers: Record<string, unknown> }>(c, "select answers from appointments where company_id=$1 and source<>'test' and booked_at>=$2 and booked_at<=$3 and answers<>'{}'::jsonb", [companyId, from, to]);
  const intake = await many<{ answers: Record<string, unknown> }>(c, "select attributes as answers from intake where company_id=$1 and submitted_at>=$2 and submitted_at<=$3", [companyId, from, to]);
  const tally = new Map<string, Map<string, number>>(); const asked = new Map<string, number>();
  for (const r of [...rows, ...intake]) for (const [q, raw] of Object.entries(r.answers ?? {})) {
    if (raw === null || raw === undefined || raw === "" || /^(phone|email|name|first_name|last_name)$/i.test(q)) continue;
    asked.set(q, (asked.get(q) ?? 0) + 1);
    const bucket = tally.get(q) ?? new Map<string, number>(); tally.set(q, bucket);
    for (const one of Array.isArray(raw) ? raw : [raw]) { const v = String(one).trim(); if (v) bucket.set(v, (bucket.get(v) ?? 0) + 1); }
  }
  return [...tally.entries()].map(([q, bucket]) => { const sorted = [...bucket].sort((a, b) => b[1] - a[1]); const rest = sorted.slice(4); return { label: q.replace(/[_-]+/g, " "), answered: asked.get(q) ?? 0, top: sorted.slice(0, 4), rest: rest.reduce((a, [, n]) => a + n, 0), restKinds: rest.length }; })
    .sort((a, b) => b.answered - a.answered);
}

export function renderReport(args: { kind: ReportKind; period: Period; tz: string; toDate: boolean; totals: Totals; setters: Breakdown[]; closers: Breakdown[]; breakdowns: string[]; said: Said }): string {
  const { totals: t, period, tz, kind, toDate } = args;
  const v = (k: string) => t[k] ?? 0;
  const anything = ["leads_new", "dials", "booked", "scheduled", "payments", "deals_won"].some((k) => v(k) > 0) || args.said.length > 0;
  const head = `*${heading(kind, period, tz, toDate)}*`;
  if (!anything) return `${head}\n\nNothing yet. No leads, no calls, no bookings, no money.`;
  const L: string[] = [head, "```"];
  L.push("NEW LEADS  — people who first appeared");
  L.push(row("New leads", v("leads_new")));
  L.push(row("  booked a call the same day", v("leads_booked_same_day"), `${pct(v("leads_booked_same_day"), v("leads_new"))} of them`));
  L.push(row("  called", v("leads_called"), `${pct(v("leads_called"), v("leads_new"))} of them` + (v("leads_called") ? ` · avg ${mins(v("stl_sum") / v("leads_called"))} from arrival to first dial` : "")));
  L.push(row("  reached", v("leads_reached"), `${pct(v("leads_reached"), v("leads_called"))} of those called`));
  L.push("");
  L.push("BOOKINGS MADE  — the act of booking happened in the period");
  L.push(row("Calls booked", v("booked"), "any lead, new or old"));
  L.push(row("  setter-booked", v("booked_set"), pct(v("booked_set"), v("booked"))));
  L.push(row("  self-booked", v("booked_self"), pct(v("booked_self"), v("booked"))));
  L.push("");
  L.push("SETTER CALLS  — every dial the team made or took");
  L.push(row("Dials", v("dials")));
  L.push(row("  connected", v("connects"), `${pct(v("connects"), v("dials"))} connection rate` + (v("talk_sec") ? ` · ${mins(v("talk_sec"))} talking` : "")));
  L.push(row("  led to a booking", v("calls_set"), `${pct(v("calls_set"), v("connects"))} of connects`));
  if (v("calls_setting") || v("calls_confirmation")) L.push(row("  read by the AI", v("calls_setting") + v("calls_confirmation"), `${v("calls_setting")} setting · ${v("calls_confirmation")} confirmation`));
  if (args.breakdowns.includes("setter")) for (const s of args.setters.filter((x) => (x.values.dials ?? 0) > 0)) {
    const d = s.values; L.push(row(`  ${s.name}`, d.dials ?? 0, `${d.connects ?? 0} connected (${pct(d.connects ?? 0, d.dials ?? 0)}) · ${mins(d.talk_sec ?? 0)} · ${d.calls_set ?? 0} set`));
  }
  L.push("");
  L.push("CALLS ON THE CALENDAR  — booked earlier, due in the period");
  L.push(row("Scheduled", v("scheduled")));
  L.push(row("  showed", v("showed"), `${pct(v("showed"), v("scheduled"))} show rate`));
  L.push(row("  no-show", v("noshow"), pct(v("noshow"), v("scheduled"))));
  L.push(row("  cancelled", v("cancelled"), pct(v("cancelled"), v("scheduled"))));
  const unmarked = v("scheduled") - v("showed") - v("noshow") - v("cancelled");
  if (unmarked > 0) L.push(row("  not yet marked", unmarked, "outcome missing"));
  if (args.breakdowns.includes("closer")) for (const cl of args.closers.filter((x) => (x.values.scheduled ?? 0) + (x.values.deals_won ?? 0) > 0)) {
    const d = cl.values; L.push(row(`  ${cl.name}`, d.scheduled ?? 0, `${d.showed ?? 0} showed (${pct(d.showed ?? 0, d.scheduled ?? 0)}) · ${d.deals_won ?? 0} won · ${money(d.revenue ?? 0)}`));
  }
  L.push("");
  if (args.said.length) {
    L.push("WHAT THEY SAID  — booking-form answers from the period's bookings");
    for (const q of args.said.slice(0, 10)) {
      L.push(`${q.label}  (${q.answered} answered)`);
      for (const [a, n] of q.top) L.push(`  ${String(n).padStart(3)}  ${pct(n, q.answered).padStart(4)}  ${a.length > 62 ? `${a.slice(0, 59)}…` : a}`);
      if (q.rest) L.push(`  ${String(q.rest).padStart(3)}        spread across ${plural(q.restKinds, "other answer")}`);
      L.push("");
    }
  }
  L.push("MONEY");
  L.push(row("Cash collected", money(v("cash")), plural(v("payments"), "payment")));
  if (v("refunds")) L.push(row("  refunded", money(v("refunded")), plural(v("refunds"), "refund")));
  L.push(row("Revenue contracted", money(v("revenue")), `${plural(v("deals_won"), "deal")} won`));
  if (v("revenue") > v("cash") && v("deals_won")) L.push(row("  outstanding", money(v("revenue") - v("cash")), "contracted, not yet collected"));
  L.push("```");
  return L.join("\n");
}

// ---- generate + post -----------------------------------------------------------------------------------------------------
export type Built = { id: string; body: string; numbers: { totals: Totals; setters: Breakdown[]; closers: Breakdown[] }; period: Period };

/** The report step: recompute the period's days, render, keep it in the wrapups ledger. Posting is the slack_post after it. */
export async function buildReport(c: PoolClient, company: CompanyRow, kind: ReportKind, period: Period, opts: { breakdowns?: string[]; sections?: Record<string, boolean>; onDemand?: boolean; toDate?: boolean } = {}): Promise<Built> {
  await rollupRange(c, company.id, period.start, period.end, company.timezone);
  const { totals, setters, closers } = await readMetrics(c, company.id, period.start, period.end);
  const said = opts.sections?.what_they_said === false ? [] : await whatTheySaid(c, company.id, period, company.timezone);
  const body = renderReport({ kind, period, tz: company.timezone, toDate: !!opts.toDate, totals, setters, closers, breakdowns: opts.breakdowns ?? [], said });
  const rep = await one<{ id: string }>(c, "insert into wrapups (company_id, kind, period_start, period_end, on_demand, body, numbers) values ($1,$2,$3,$4,$5,$6,$7) returning id",
    [company.id, kind, period.start, period.end, !!opts.onDemand, body, { totals, setters, closers }]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'report.generated','report',$2,$3)", [company.id, rep!.id, { kind, period, on_demand: !!opts.onDemand }]);
  return { id: rep!.id, body, numbers: { totals, setters, closers }, period };
}

export const companyReports = (c: PoolClient, companyId: string, limit = 30) => many<{ id: string; kind: ReportKind; period_start: string; period_end: string; generated_at: Date; on_demand: boolean; body: string; send_status: string | null }>(c,
  "select r.id, r.kind, r.period_start::text, r.period_end::text, r.generated_at, r.on_demand, r.body, s.status as send_status from wrapups r left join sends s on s.id=r.send_id where r.company_id=$1 order by r.generated_at desc limit $2", [companyId, limit]);
