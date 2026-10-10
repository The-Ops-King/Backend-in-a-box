import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { CompanyRow } from "./context";
import { readMetrics, rollupRange, type Breakdown, type Totals } from "./metrics";
import { testContactSql, testDomains } from "./mode";
import type { GhlReads } from "@/adapters/ghl/metrics";

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
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number, of: number) => `${Math.round((n / of) * 100)}%`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function heading(kind: ReportKind, period: Period, tz: string, toDate: boolean): string {
  const s = DateTime.fromISO(period.start, { zone: tz }), e = DateTime.fromISO(period.end, { zone: tz });
  if (kind === "daily") return `What happened today — ${s.toFormat("cccc, LLL d")}`;
  if (kind === "weekly") return `${toDate ? "This week so far" : "Last week"} — ${s.toFormat("LLL d")} to ${e.toFormat("LLL d")}`;
  return `${toDate ? `${s.toFormat("LLLL")} so far` : s.toFormat("LLLL yyyy")}`;
}
const when = (kind: ReportKind, toDate: boolean) => (kind === "daily" ? "today" : kind === "weekly" ? (toDate ? "this week" : "last week") : toDate ? "this month" : "last month");

export type Said = { label: string; answered: number; top: [string, number][]; rest: number; restKinds: number }[];
/** What the period's new bookings answered on the booking form, tallied per question. Reads the questions the booking source carries (D24); no list to maintain. Test contacts out (D73). */
export async function whatTheySaid(c: PoolClient, companyId: string, period: Period, tz: string, domains: string[] = []): Promise<Said> {
  const from = DateTime.fromISO(period.start, { zone: tz }).startOf("day").toJSDate(), to = DateTime.fromISO(period.end, { zone: tz }).endOf("day").toJSDate();
  const rows = await many<{ answers: Record<string, unknown> }>(c, `select a.answers from appointments a join contacts ct on ct.id=a.contact_id where a.company_id=$1 and a.source<>'test' and a.booked_at>=$2 and a.booked_at<=$3 and a.answers<>'{}'::jsonb and not ${testContactSql("ct", "$4")}`, [companyId, from, to, domains]);
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

/** The period's numbers by registry name (null: not read, or nothing to say); `calls` the show-rate breakdown. */
export type Numbers = Record<string, number | null>;
export type CallsSeen = { booked: number; showed: number; noshow: number; cancelled: number; missing: number; rescheduled: number };

/**
 * D76 (Tyler: "if no actual calls happened today, we don't need to say that… show only what actually happened"): a line only
 * for a number that is not zero, a section only when it has a line, a rate only when its denominator is not zero, no
 * definitions (those are /help's). Nothing at all: one line, so silence never looks like a broken engine. A GHL read that
 * failed says so, never a 0.
 */
export function renderReport(args: { kind: ReportKind; period: Period; tz: string; toDate: boolean; numbers: Numbers; calls?: CallsSeen | null; said: Said; ghlError?: string }): string {
  const { numbers: n, kind, toDate } = args;
  const v = (k: string) => n[k] ?? 0;
  const parts = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" · ");
  const sections: [string, string[]][] = [];
  const add = (title: string, ...lines: (string | false | null | undefined)[]) => { const l = lines.filter((x): x is string => !!x); if (l.length) sections.push([title, l]); };
  add("Leads", v("leads") > 0 && parts(`New leads: ${v("leads")}`, v("mqls") > 0 && `MQLs ${v("mqls")}`));
  add("Bookings", v("booked") > 0 && parts(`Calls booked: ${v("booked")}`, v("booked_self") > 0 && `self-booked ${v("booked_self")}`, v("booked_set") > 0 && `setter-booked ${v("booked_set")}`), v("reschedules") > 0 && `Rescheduled: ${v("reschedules")}`);
  const k = args.calls;
  add("Sales calls", !!k && k.booked > 0 && parts(`Calls due: ${k.booked}`, k.showed > 0 && `showed ${k.showed}`, k.noshow > 0 && `no-show ${k.noshow}`, k.cancelled > 0 && `cancelled ${k.cancelled}`, k.missing > 0 && `not filed ${k.missing}`, `show rate ${pct(k.showed, k.booked)}`),
    !!k && k.rescheduled > 0 && `Rescheduled away: ${k.rescheduled}`);
  add("Setter calls", v("dials") > 0 && parts(`Dials: ${v("dials")}`, v("connected") > 0 && `connected ${v("connected")}`), n.speed_to_lead != null && n.speed_to_lead > 0 && `Speed to lead: ${Math.round(n.speed_to_lead)} min`);
  add("Deals", v("closes") > 0 && parts(`Closes: ${v("closes")}`, v("revenue") > 0 && `revenue ${money(v("revenue"))}`, !!k && k.showed > 0 && `close rate ${pct(v("closes"), k.showed)}`));
  add("Cash", (v("cash_gross") > 0 || v("refunds") > 0) && parts(`Cash collected: ${money(v("cash_collected"))}`, v("refunds") > 0 && `refunds ${money(v("refunds"))}`));
  if (args.said.length) add("What they said", ...args.said.slice(0, 10).flatMap((q) => [`*${q.label}*`, ...q.top.map(([a, c]) => `    • ${a.length > 62 ? `${a.slice(0, 59)}…` : a}: ${c}`), q.rest ? `    • ${q.rest} spread across ${plural(q.restKinds, "other answer")}` : ""]));
  const failed = args.ghlError ? `_couldn't read GHL: ${args.ghlError}_` : "";
  if (!sections.length) return failed ? `*${heading(kind, args.period, args.tz, toDate)}*\n${failed}` : `Nothing ${when(kind, toDate)}: no leads, bookings, calls or payments.`;
  return [`*${heading(kind, args.period, args.tz, toDate)}*`, ...sections.map(([title, lines]) => `\n*${title}*\n${lines.join("\n")}`), ...(failed ? [`\n${failed}`] : [])].join("\n");
}

// ---- generate + post -----------------------------------------------------------------------------------------------------
export type Built = { id: string; body: string; numbers: { totals: Totals; setters: Breakdown[]; closers: Breakdown[] } & { registry?: Numbers }; period: Period };
/** The numbers the wrap-up says, by the same registry the bot answers from (D73/D75), so the two can never disagree. */
export const WRAPUP_METRICS = ["leads", "mqls", "booked", "booked_self", "booked_set", "reschedules", "dials", "connected", "speed_to_lead", "closes", "revenue", "cash_collected", "cash_gross", "refunds"];

/** The report step: the period's numbers from the registry (people, calls, deals and cash from GHL; bookings and dials from the ledger), rendered, kept in the wrapups ledger. Posting is the slack_post after it. */
export async function buildReport(c: PoolClient, company: CompanyRow, kind: ReportKind, period: Period, opts: { breakdowns?: string[]; sections?: Record<string, boolean>; onDemand?: boolean; toDate?: boolean; reads?: GhlReads; now?: Date } = {}): Promise<Built> {
  const { getMetric } = await import("./metric-registry");
  await rollupRange(c, company.id, period.start, period.end, company.timezone);
  const { totals, setters, closers } = await readMetrics(c, company.id, period.start, period.end);
  const p = { from: period.start, to: period.end, label: "", name: "" };
  const numbers: Numbers = {}; const errors: string[] = [];
  for (const m of WRAPUP_METRICS) {
    try { const r = await getMetric(c, company.id, { metric: m, period: p, now: opts.now }, opts.reads); numbers[m] = typeof r.value === "number" ? r.value : null; }
    catch (e) { numbers[m] = null; const msg = String((e as Error).message); if (/GHL/.test(msg) && !/no object is bound|not mapped|none is bound|not connected|no field is bound|no answers are set/.test(msg)) errors.push(msg); }
  }
  let calls: CallsSeen | null = null;
  try { const r = await getMetric(c, company.id, { metric: "show_rate", period: p, now: opts.now }, opts.reads); calls = r.shows_breakdown ?? null; }
  catch (e) { const msg = String((e as Error).message); if (/GHL could not be read/.test(msg)) errors.push(msg); }
  const domains = testDomains(Object.fromEntries((await many<{ key: string; value: Buffer }>(c, "select key, value from bindings where company_id=$1 and key='test.domains'", [company.id])).map((b) => [b.key, b.value.toString("utf8")])));
  const said = opts.sections?.what_they_said === false ? [] : await whatTheySaid(c, company.id, period, company.timezone, domains);
  const ghlError = [...new Set(errors.filter((x) => /GHL could not be read/.test(x)))][0]?.replace(/^GHL could not be read /, "").slice(0, 200);
  const body = renderReport({ kind, period, tz: company.timezone, toDate: !!opts.toDate, numbers, calls, said, ghlError });
  const rep = await one<{ id: string }>(c, "insert into wrapups (company_id, kind, period_start, period_end, on_demand, body, numbers) values ($1,$2,$3,$4,$5,$6,$7) returning id",
    [company.id, kind, period.start, period.end, !!opts.onDemand, body, { totals, setters, closers, registry: numbers }]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'report.generated','report',$2,$3)", [company.id, rep!.id, { kind, period, on_demand: !!opts.onDemand }]);
  return { id: rep!.id, body, numbers: { totals, setters, closers, registry: numbers }, period };
}

export const companyReports = (c: PoolClient, companyId: string, limit = 30) => many<{ id: string; kind: ReportKind; period_start: string; period_end: string; generated_at: Date; on_demand: boolean; body: string; send_status: string | null }>(c,
  "select r.id, r.kind, r.period_start::text, r.period_end::text, r.generated_at, r.on_demand, r.body, s.status as send_status from wrapups r left join sends s on s.id=r.send_id where r.company_id=$1 order by r.generated_at desc limit $2", [companyId, limit]);
