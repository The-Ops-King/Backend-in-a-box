import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { CompanyRow } from "./context";
import { readMetrics, rollupRange, type Breakdown, type Totals } from "./metrics";
import { testContactSql, testDomains } from "./mode";
import type { GhlReads } from "@/adapters/ghl/metrics";
import { render, type RenderEnv } from "./template";
import { table } from "./bot-format";
import dailyWrapUp from "@/templates/daily-wrap-up.json";
import weeklyWrapUp from "@/templates/weekly-wrap-up.json";
import monthlyWrapUp from "@/templates/monthly-wrap-up.json";

/**
 * Wrap-ups (D29): "what happened today / this week / this month", computed from the daily rollups and posted to Slack
 * on the company's own schedule. Nothing here is a constant: the time, the day, the channel, the numbers read, the breakdowns
 * and every word of the body (the report step's layout, D88) are the workflow's, edited like any other workflow (D35). D96: the daily, weekly
 * and monthly wrap-ups are three workflows, each with its own switch, mode, channel and words.
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

// ---- the numbers, and the words the template puts them in (D88 A8) ------------------------------------------------------
/** The period's numbers by registry name (null: not read, or nothing to say); `calls` the show-rate breakdown. */
export type Numbers = Record<string, number | null>;
export type CallsSeen = { booked: number; showed: number; noshow: number; cancelled: number; missing: number; rescheduled: number };
/** The report step's `layout` (definition.ts): the heading and the empty line by kind, the sections with their lines, the line when GHL could not be read. */
/** D95: a section is lines, or a `table` of [label, value] rows set as one narrow monospace block (a row whose value renders blank is left out); a blank title prints none. */
export type Layout = { heading: Record<string, string>; sections: { title: string; lines?: string[]; table?: [string, string][] }[]; empty: Record<string, string>; failed?: string; footer?: string };
/**
 * What a layout's templates read under `report.*`. Every count the template words is here: `n` (a registry number, null when it is
 * zero or unread, so a line about it says nothing), `raw` (the same with 0), `calls` (the show-rate breakdown, null when zero), `rates`
 * (show and close rate in whole percent, null without a denominator), `money_moved` (cash came in or went out), `said` (the first ten
 * booking questions, each with its top four answers and the rest counted), `by` (per closer / setter, when the step asks for it).
 * `nothing` (D124): true when nothing happened (every number read is zero or unread, the show-rate breakdown is all zero,
 * nothing was said on a form, no per-person number, and GHL was read), else null; a company quiet when empty posts nothing then.
 */
export type ReportFacts = { kind: ReportKind; to_date: boolean; start: string; end: string; read_at: string; period: Period; n: Numbers; raw: Record<string, number>; calls: Record<keyof CallsSeen, number | null> | null; rates: { show_rate: number | null; close_rate: number | null }; money_moved: true | null;
  said: { label: string; answered: number; top: { answer: string; count: number }[]; rest: number; rest_kinds: number }[]; by: { closer: Breakdown[]; setter: Breakdown[] }; ghl_error: string | null; nothing: true | null };

/** D124: nothing happened in the period, from the numbers (never the words): see `ReportFacts.nothing`. A GHL read that failed is not nothing: what it would have said is not known. */
export function nothingHappened(a: { numbers: Numbers; calls?: CallsSeen | null; said: Said; ghlError?: string; by?: { closer: Breakdown[]; setter: Breakdown[] } }): true | null {
  const k = a.calls, calls = k ? [k.booked, k.showed, k.noshow, k.cancelled, k.missing, k.rescheduled] : [];   // the counts only: GHL's breakdown carries name lists too
  const counts = [...Object.values(a.numbers), ...calls, ...[...(a.by?.closer ?? []), ...(a.by?.setter ?? [])].flatMap((p) => Object.values(p.values))];
  return !a.ghlError && !a.said.length && counts.every((x) => !x) ? true : null;
}

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

/** The facts a layout reads, from the period's numbers. Pure. */
export function reportFacts(args: { kind: ReportKind; period: Period; tz: string; toDate: boolean; numbers: Numbers; calls?: CallsSeen | null; said: Said; ghlError?: string; by?: { closer: Breakdown[]; setter: Breakdown[] }; readAt?: Date }): ReportFacts {
  const { numbers } = args, k = args.calls ?? null;
  const v = (key: string) => numbers[key] ?? 0, nz = (x: number | null | undefined) => (x ? x : null);
  const pct = (a: number, of: number) => (a > 0 && of > 0 ? Math.round((a / of) * 100) : null);
  const at = (d: string) => DateTime.fromISO(d, { zone: args.tz }).toISO()!;
  return {
    kind: args.kind, to_date: args.toDate, start: at(args.period.start), end: at(args.period.end), read_at: DateTime.fromJSDate(args.readAt ?? new Date()).setZone(args.tz).toISO()!, period: args.period,
    n: Object.fromEntries(Object.entries(numbers).map(([key, x]) => [key, nz(x)])), raw: Object.fromEntries(Object.entries(numbers).map(([key]) => [key, v(key)])),
    calls: k ? { booked: nz(k.booked), showed: nz(k.showed), noshow: nz(k.noshow), cancelled: nz(k.cancelled), missing: nz(k.missing), rescheduled: nz(k.rescheduled) } : null,
    rates: { show_rate: k && k.booked > 0 ? Math.round((k.showed / k.booked) * 100) : null, close_rate: k ? pct(v("closes"), k.showed) : null },
    money_moved: v("cash_gross") > 0 || v("refunds") > 0 ? true : null,
    said: args.said.slice(0, 10).map((q) => ({ label: q.label, answered: q.answered, top: q.top.map(([a, n]) => ({ answer: a.length > 62 ? `${a.slice(0, 59)}…` : a, count: n })), rest: q.rest, rest_kinds: q.restKinds })),
    by: args.by ?? { closer: [], setter: [] }, ghl_error: args.ghlError ?? null,
    nothing: nothingHappened(args),
  };
}

/**
 * The body from a layout (a wrap-up template's report step). The words are the layout's; the engine only puts them together:
 * a line that renders blank is left out, a section with no line is left out, nothing at all is the layout's `empty` line, and a
 * GHL read that failed is the `failed` line, never a 0. The heading and the empty line are picked by `<kind>_to_date`, else `<kind>`.
 */
export function renderLayout(layout: Layout, facts: ReportFacts, ctx: Record<string, unknown>, env: RenderEnv): string {
  const c = { ...ctx, report: facts }, r = (t: string) => render(t, c, env);
  const pick = (m: Record<string, string>) => m[`${facts.kind}${facts.to_date ? "_to_date" : ""}`] ?? m[facts.kind] ?? "";
  const rows = (t: [string, string][]) => t.map(([label, value]) => [r(label), r(value)]).filter(([, v]) => v.trim() !== "");
  const sections = layout.sections.map((sec) => { const t = sec.table ? rows(sec.table) : [];
    return { title: r(sec.title), lines: [...(t.length ? [table(null, t)] : []), ...(sec.lines ?? []).map(r).filter((l) => l.trim() !== "")] }; }).filter((sec) => sec.lines.length);
  const failed = facts.ghl_error && layout.failed ? r(layout.failed) : "";
  const heading = r(pick(layout.heading)), foot = layout.footer ? r(layout.footer) : "";
  if (!sections.length) return failed ? `${heading}\n${failed}` : r(pick(layout.empty));
  return [heading, ...sections.map((sec) => `\n${sec.title.trim() ? `${sec.title}\n` : ""}${sec.lines.join("\n")}`), ...(failed ? [`\n${failed}`] : []), ...(foot ? [`\n${foot}`] : [])].join("\n");
}
const SHIPPED: Record<ReportKind, { definition: { nodes: unknown[] } }> = { daily: dailyWrapUp, weekly: weeklyWrapUp, monthly: monthlyWrapUp };
/** A report step with no layout of its own (a copy from before D88) is worded by the shipped template of its kind (D96). */
export function shippedLayout(kind: ReportKind = "daily"): Layout {
  const node = (SHIPPED[kind].definition.nodes as { type: string; layout?: Layout }[]).find((n) => n.type === "report");
  if (!node?.layout) throw new Error(`the shipped ${kind} wrap-up template has no report layout`);
  return node.layout;
}

// ---- generate ------------------------------------------------------------------------------------------------------------
export type Built = { id: string; body: string; numbers: { totals: Totals; setters: Breakdown[]; closers: Breakdown[] } & { registry?: Numbers }; period: Period; facts: ReportFacts };
/** The numbers the wrap-up reads by default, by the same registry the bot answers from (D73/D75), so the two can never disagree. The step's `metrics` replaces the list. */
export const WRAPUP_METRICS = ["leads", "mqls", "booked", "booked_self", "booked_set", "reschedules", "dials", "connected", "speed_to_lead", "closes", "deposits", "deposit_cash", "revenue", "cash_collected", "cash_gross", "refunds"];

/** The report step: the period's numbers from the registry (people, calls, deals and cash from GHL; bookings and dials from the ledger), put in the layout's words, kept in the wrapups ledger. Posting is the slack_post after it. */
export async function buildReport(c: PoolClient, company: CompanyRow, kind: ReportKind, period: Period, opts: { breakdowns?: string[]; sections?: Record<string, boolean>; metrics?: string[]; layout?: Layout; ctx?: Record<string, unknown>; onDemand?: boolean; toDate?: boolean; reads?: GhlReads; now?: Date } = {}): Promise<Built> {
  const { getMetric } = await import("./metric-registry");
  await rollupRange(c, company.id, period.start, period.end, company.timezone);
  const { totals, setters, closers } = await readMetrics(c, company.id, period.start, period.end);
  const p = { from: period.start, to: period.end, label: "", name: "" };
  const numbers: Numbers = {}; const errors: string[] = [];
  for (const m of opts.metrics?.length ? opts.metrics : WRAPUP_METRICS) {
    try { const r = await getMetric(c, company.id, { metric: m, period: p, now: opts.now }, opts.reads); numbers[m] = typeof r.value === "number" ? r.value : null; }
    catch (e) { numbers[m] = null; const msg = String((e as Error).message); if (/GHL/.test(msg) && !/no object is bound|not mapped|none is bound|not connected|no field is bound|no answers are set/.test(msg)) errors.push(msg); }
  }
  let calls: CallsSeen | null = null;
  try { const r = await getMetric(c, company.id, { metric: "show_rate", period: p, now: opts.now }, opts.reads); calls = r.shows_breakdown ?? null; }
  catch (e) { const msg = String((e as Error).message); if (/GHL could not be read/.test(msg)) errors.push(msg); }
  const domains = testDomains(Object.fromEntries((await many<{ key: string; value: Buffer }>(c, "select key, value from bindings where company_id=$1 and key='test.domains'", [company.id])).map((b) => [b.key, b.value.toString("utf8")])));
  const said = opts.sections?.what_they_said === false ? [] : await whatTheySaid(c, company.id, period, company.timezone, domains);
  const ghlError = [...new Set(errors.filter((x) => /GHL could not be read/.test(x)))][0]?.replace(/^GHL could not be read /, "").slice(0, 200);
  // breakdowns: per closer and per setter from the ledger's rollups, for a layout that words them (D29: totals by default, per person switchable)
  const want = new Set(opts.breakdowns ?? []);
  const facts = reportFacts({ kind, period, tz: company.timezone, toDate: !!opts.toDate, numbers, calls, said, ghlError, by: { closer: want.has("closer") ? closers : [], setter: want.has("setter") ? setters : [] }, readAt: opts.now });
  const body = renderLayout(opts.layout ?? shippedLayout(kind), facts, opts.ctx ?? {}, { tz: company.timezone, companyTz: company.timezone });
  const rep = await one<{ id: string }>(c, "insert into wrapups (company_id, kind, period_start, period_end, on_demand, body, numbers) values ($1,$2,$3,$4,$5,$6,$7) returning id",
    [company.id, kind, period.start, period.end, !!opts.onDemand, body, { totals, setters, closers, registry: numbers }]);
  await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'report.generated','report',$2,$3)", [company.id, rep!.id, { kind, period, on_demand: !!opts.onDemand }]);
  return { id: rep!.id, body, numbers: { totals, setters, closers, registry: numbers }, period, facts };
}

export const companyReports = (c: PoolClient, companyId: string, limit = 30) => many<{ id: string; kind: ReportKind; period_start: string; period_end: string; generated_at: Date; on_demand: boolean; body: string; send_status: string | null }>(c,
  "select r.id, r.kind, r.period_start::text, r.period_end::text, r.generated_at, r.on_demand, r.body, s.status as send_status from wrapups r left join sends s on s.id=r.send_id where r.company_id=$1 order by r.generated_at desc limit $2", [companyId, limit]);
