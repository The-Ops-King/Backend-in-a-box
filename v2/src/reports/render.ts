import { z } from "zod";
import type { VendorReads } from "@/engine/reads";
import type { Tx } from "@/engine/store";
import type { OfferRow } from "@/engine/types";
import { formatDate } from "@/workflow/dates";
import type { RenderEnv } from "@/workflow/filters";
import { render } from "@/workflow/template";
import { personView } from "@/projections/derived";
import type { PersonRow } from "@/projections/tables";
import { type GroupBy, type MetricCtx, labelOf, metric, metricDef } from "./metrics";
import { type Period, type PeriodKind, dayStart, nextDay, periodFor, plusDays, todayIn } from "./periods";

/**
 * report@1: an offer's report definition (data) rendered from the metric layer into a variable. A wrap-up is its
 * metrics put in the definition's own layout; the leaderboard ranks closers and setters by metrics split by person; the
 * end-of-day due list is a closer's calls still to file. A report only a vendor can answer (calendar availability, the
 * health sweep) is read through the vendor's connector.
 */

export type ReportDeps = { tx: Tx; offer: OfferRow; settings: Record<string, unknown>; now: Date; reads?: VendorReads };

const Kind = z.enum(["daily", "weekly", "monthly"]);
const Line = z.string();
export const Layout = z.object({
  heading: z.record(Line), empty: z.record(Line), failed: Line.optional(), footer: Line.optional(),
  sections: z.array(z.object({ title: Line, lines: z.array(Line).optional(), table: z.array(z.tuple([Line, Line])).optional() }).strict()),
}).strict();
export type Layout = z.infer<typeof Layout>;

const WrapUp = z.object({
  kind: z.literal("wrap_up"), period: Kind, v1: z.string(),
  /** The numbers the layout reads as report.n / report.raw, by metric name. */
  metrics: z.array(z.string()),
  /** The calls due and how they went (report.calls), by metric name. */
  calls: z.object({ booked: z.string(), showed: z.string(), noshow: z.string(), cancelled: z.string(), missing: z.string(), rescheduled: z.string() }).strict().optional(),
  /**
   * report.rates: whole percents of one number over another, each a path in the facts ("calls.showed", "n.closes"):
   * nothing without a denominator, and, with `blankWhenZero`, nothing when the number is zero too (v1's close rate;
   * its show rate says 0%).
   */
  rates: z.record(z.object({ num: z.string(), den: z.string(), blankWhenZero: z.boolean().optional() }).strict()).default({}),
  /** report.by.closer / report.by.setter: per person, each value a metric, only for the splits listed in breakdowns. */
  breakdowns: z.array(z.enum(["closer", "setter"])).default([]),
  by: z.object({ closer: z.record(z.string()).optional(), setter: z.record(z.string()).optional() }).strict().default({}),
  /** report.said: what the period's new bookings answered on the booking form. */
  said: z.boolean().default(false),
  layout: Layout,
}).strict();

const Leaderboard = z.object({
  kind: z.literal("leaderboard"), period: Kind, v1: z.string(),
  closers: z.object({ cash: z.string(), closeRate: z.string() }).strict(),
  setters: z.object({ sets: z.string(), showRate: z.string() }).strict(),
  words: z.object({ heading: z.string(), closers: z.string(), setters: z.string(), noClosers: z.string(), noSetters: z.string(), close: z.string(), closes: z.string(), set: z.string(), sets: z.string(), showed: z.string() }).strict(),
}).strict();

const EodDue = z.object({
  kind: z.literal("eod_due"), v1: z.string(),
  /** The setting that holds the dashboard's address, which a day's link starts with. */
  linkBase: z.string(),
}).strict();

const Vendor = z.object({ kind: z.enum(["availability", "health_check"]), v1: z.string() }).passthrough();

export const ReportDef = z.union([WrapUp, Leaderboard, EodDue, Vendor]);
export type ReportDef = z.infer<typeof ReportDef>;

export function reportDef(raw: unknown, key: string): ReportDef {
  if (raw === undefined) throw new Error(`the offer has no report definition ${key}`);
  const r = ReportDef.safeParse(raw);
  if (!r.success) throw new Error(`report ${key} does not validate: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

export async function renderReport(d: ReportDeps, x: { key: string; period: "just_ended" | "in_progress"; params: Record<string, unknown>; ctx: Record<string, unknown> }): Promise<unknown> {
  const def = reportDef(await d.tx.reportDefinition(d.offer.id, "report", x.key), x.key);
  if (def.kind === "availability" || def.kind === "health_check") {
    if (!d.reads?.vendorReport) throw new Error(`report ${x.key} is read from a vendor (${def.kind}), and no connector answers it here`);
    return d.reads.vendorReport(d.offer.id, { key: x.key, kind: def.kind, params: x.params, now: d.now });
  }
  const people = await d.tx.projFind("people", d.offer.id);
  const mc: MetricCtx = { tx: d.tx, offerId: d.offer.id, settings: d.settings, now: d.now, defs: await d.tx.reportDefinitions(d.offer.id, "metric"), people, cache: new Map() };
  if (def.kind === "wrap_up") return wrapUp(d, mc, def as z.infer<typeof WrapUp>, periodFor(def.period as PeriodKind, x.period, d.now, d.offer.zone), x.ctx);
  if (def.kind === "leaderboard") return leaderboard(mc, def as z.infer<typeof Leaderboard>, periodFor(def.period as PeriodKind, x.period, d.now, d.offer.zone));
  return eodDue(d, people, def as z.infer<typeof EodDue>, x.params, x.ctx);
}

// ---- wrap-ups -------------------------------------------------------------------------------------------------------------

const nz = (x: number | null | undefined) => (x ? x : null);
/** v1's wrap-up percent: nothing when either side is zero. */
const pct = (a: number, of: number) => (a > 0 && of > 0 ? Math.round((a / of) * 100) : null);
/** v1's leaderboard percent: nothing only without a denominator (0 of 3 shows is 0%). */
const boardPct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null);
const getPath = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);

async function wrapUp(d: ReportDeps, mc: MetricCtx, def: z.infer<typeof WrapUp>, p: Period, ctx: Record<string, unknown>) {
  const numbers: Record<string, number | null> = {};
  for (const m of def.metrics) { const r = await metric(mc, m, p); numbers[m] = r.unavailable ? null : r.value; }
  let calls: Record<string, number> | null = null;
  if (def.calls) {
    calls = {};
    for (const [k, m] of Object.entries(def.calls)) calls[k] = (await metric(mc, m, p)).value ?? 0;
  }
  const by: { closer: unknown[]; setter: unknown[] } = { closer: [], setter: [] };
  for (const side of def.breakdowns) {
    const values = def.by[side] ?? {};
    const people = new Map<string, Record<string, number>>();
    for (const [name, m] of Object.entries(values)) for (const [k, v] of (await metric(mc, m, p, side as GroupBy)).rows) { if (!k) continue; people.set(k, { ...(people.get(k) ?? {}), [name]: v }); }
    by[side] = [...people].map(([k, v]) => ({ key: k, name: labelOf(k, mc.people), values: v })).sort((a, b) => a.name.localeCompare(b.name));
  }
  const said = def.said ? await whatTheySaid(d, p) : [];
  const v = (k: string) => numbers[k] ?? 0;
  const facts: Record<string, unknown> = {
    kind: def.period, to_date: p.toDate, start: dayStart(p.from, d.offer.zone).toISOString(), end: dayStart(p.to, d.offer.zone).toISOString(), read_at: d.now.toISOString(),
    period: { start: p.from, end: p.to, name: p.name, label: p.label },
    n: Object.fromEntries(Object.entries(numbers).map(([k, x]) => [k, nz(x)])), raw: Object.fromEntries(Object.keys(numbers).map((k) => [k, v(k)])),
    calls: calls ? Object.fromEntries(Object.entries(calls).map(([k, x]) => [k, nz(x)])) : null,
    money_moved: v("cash_gross") > 0 || v("refunds") > 0 ? true : null, said, by, ghl_error: null,
  };
  const rawFacts = { ...facts, calls: calls ?? {}, n: Object.fromEntries(Object.keys(numbers).map((k) => [k, v(k)])) };
  facts.rates = Object.fromEntries(Object.entries(def.rates).map(([k, r]) => {
    const n = Number(getPath(rawFacts, r.num) ?? 0), dd = Number(getPath(rawFacts, r.den) ?? 0);
    return [k, r.blankWhenZero ? pct(n, dd) : boardPct(n, dd)];
  }));
  const counts = [...Object.values(numbers), ...Object.values(calls ?? {}), ...[...by.closer, ...by.setter].flatMap((x) => Object.values((x as { values: Record<string, number> }).values))];
  const nothing = !said.length && counts.every((x) => !x) ? true : null;
  facts.nothing = nothing;
  const env: RenderEnv = { now: d.now, offerZone: d.offer.zone };
  const body = renderLayout(def.layout, facts, ctx, env, `${def.period}${p.toDate ? "_to_date" : ""}`, def.period);
  return { body, empty: nothing === true, nothing, numbers, calls, period: facts.period };
}

/** What the period's new bookings answered on the booking form, per question: the top four answers and the rest counted (v1). */
async function whatTheySaid(d: ReportDeps, p: Period) {
  const rows = await d.tx.projFind("appointments", d.offer.id, { range: { col: "bookedAt", from: p.start, to: p.end } });
  const tally = new Map<string, Map<string, number>>(), asked = new Map<string, number>();
  for (const a of rows) {
    const answers = a.attrs.answers;
    if (!answers || typeof answers !== "object") continue;
    for (const [q, raw] of Object.entries(answers as Record<string, unknown>)) {
      if (raw === null || raw === undefined || raw === "" || /^(phone|email|name|first_name|last_name)$/i.test(q)) continue;
      asked.set(q, (asked.get(q) ?? 0) + 1);
      const bucket = tally.get(q) ?? new Map<string, number>(); tally.set(q, bucket);
      for (const one of Array.isArray(raw) ? raw : [raw]) { const s = String(one).trim(); if (s) bucket.set(s, (bucket.get(s) ?? 0) + 1); }
    }
  }
  return [...tally.entries()].map(([q, bucket]) => {
    const sorted = [...bucket].sort((a, b) => b[1] - a[1]), rest = sorted.slice(4);
    return { label: q.replace(/[_-]+/g, " "), answered: asked.get(q) ?? 0, top: sorted.slice(0, 4).map(([answer, count]) => ({ answer: answer.length > 62 ? `${answer.slice(0, 59)}…` : answer, count })), rest: rest.reduce((n, [, c]) => n + c, 0), rest_kinds: rest.length };
  }).sort((a, b) => b.answered - a.answered).slice(0, 10);
}

/** Slack on a phone wraps a code block at about this many characters (v1's PHONE_WIDTH). */
export const PHONE_WIDTH = 34;
const MAX_ROWS = 25;
const cut = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(1, w - 1))}…` : s);
/** A monospace table that fits a phone: the first column left and cut to make room, the rest right (v1's bot-format table). */
export function table(rows: string[][], width = PHONE_WIDTH): string {
  const all = rows.slice(0, MAX_ROWS).map((r) => r.map((x) => (x ?? "").replace(/`/g, "'")));
  if (!all.length) return "";
  const n = Math.max(...all.map((r) => r.length));
  const w = Array.from({ length: n }, (_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  w[0] = Math.max(6, Math.min(w[0]!, width - w.slice(1).reduce((s, x) => s + x + 2, 0)));
  const out = all.map((r) => r.map((x, i) => (i === 0 ? cut(x ?? "", w[0]!).padEnd(w[0]!) : (x ?? "").padStart(w[i]!))).join("  ").trimEnd());
  if (rows.length > MAX_ROWS) out.push(`… ${rows.length - MAX_ROWS} more`);
  return "```\n" + out.join("\n") + "\n```";
}

/**
 * The body from a layout, as v1 put one together: a line that renders blank is left out, a section with no line is left
 * out, nothing at all is the layout's `empty` line. The heading and the empty line are picked by `<kind>_to_date`, else
 * `<kind>`. The layout's words are templates over `report` (the facts) and the run's context.
 */
export function renderLayout(layout: Layout, facts: Record<string, unknown>, ctx: Record<string, unknown>, env: RenderEnv, pickKey: string, kind: string): string {
  const c = { ...ctx, report: facts };
  const r = (t: string) => render(t, c, env, { extraRoots: ["report"] }).text;
  const pick = (m: Record<string, string>) => m[pickKey] ?? m[kind] ?? "";
  const rows = (t: [string, string][]) => t.map(([label, value]) => [r(label), r(value)]).filter(([, x]) => x!.trim() !== "");
  const sections = layout.sections.map((sec) => {
    const t = sec.table ? rows(sec.table) : [];
    return { title: r(sec.title), lines: [...(t.length ? [table(t as string[][])] : []), ...(sec.lines ?? []).map(r).filter((l) => l.trim() !== "")] };
  }).filter((sec) => sec.lines.length);
  const heading = r(pick(layout.heading)), foot = layout.footer ? r(layout.footer) : "";
  if (!sections.length) return r(pick(layout.empty));
  return [heading, ...sections.map((sec) => `\n${sec.title.trim() ? `${sec.title}\n` : ""}${sec.lines.join("\n")}`), ...(foot ? [`\n${foot}`] : [])].join("\n");
}

// ---- the leaderboard ---------------------------------------------------------------------------------------------------

type Words = z.infer<typeof Leaderboard>["words"];
async function leaderboard(mc: MetricCtx, def: z.infer<typeof Leaderboard>, p: Period) {
  const cash = await metric(mc, def.closers.cash, p, "closer"), sets = await metric(mc, def.setters.sets, p, "setter");
  // a rate's two counts by person: the board shows them beside the percent
  const rateParts = async (name: string, by: GroupBy) => {
    const r = metricDef(mc.defs, name);
    if (!("rate" in r)) throw new Error(`${name} is not a rate`);
    return { num: await metric(mc, r.rate.num, p, by), den: await metric(mc, r.rate.den, p, by) };
  };
  const cr = await rateParts(def.closers.closeRate, "closer"), sr = await rateParts(def.setters.showRate, "setter");
  const closers = [...new Set([...cash.rows.keys(), ...cr.num.rows.keys(), ...cr.den.rows.keys()])].filter(Boolean).map((k) => {
    const closes = cr.num.rows.get(k) ?? 0, shows = cr.den.rows.get(k) ?? 0;
    return { key: k, name: labelOf(k, mc.people), cash: cash.unavailable ? null : cash.rows.get(k) ?? 0, closes, shows, close_rate: boardPct(closes, shows) };
  }).filter((x) => (x.cash ?? 0) !== 0 || x.closes > 0 || x.shows > 0)
    .sort((a, b) => (b.cash ?? 0) - (a.cash ?? 0) || b.closes - a.closes || (b.close_rate ?? -1) - (a.close_rate ?? -1) || a.name.localeCompare(b.name));
  const setters = [...new Set([...sets.rows.keys(), ...sr.num.rows.keys(), ...sr.den.rows.keys()])].filter(Boolean).map((k) => {
    const shows = sr.num.rows.get(k) ?? 0, due = sr.den.rows.get(k) ?? 0;
    return { key: k, name: labelOf(k, mc.people), sets: sets.rows.get(k) ?? 0, due, shows, show_rate: boardPct(shows, due) };
  }).filter((x) => x.sets > 0 || x.due > 0).sort((a, b) => b.sets - a.sets || (b.show_rate ?? -1) - (a.show_rate ?? -1) || a.name.localeCompare(b.name));
  const nothing = closers.some((x) => (x.cash ?? 0) !== 0 || x.closes > 0) || setters.some((x) => x.sets > 0) ? null : true;
  return { body: boardText(def.words, closers, setters), period_name: p.name, period_label: p.label, closers, setters, nothing, ...(cash.unavailable ? { cash_unavailable: cash.unavailable } : {}) };
}

const BOARD_WIDTH = 34, MAX_PEOPLE = 20;
const dollars = (v: number | null) => {
  if (v === null) return "—";
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  return `${s}$${a >= 999_500 ? `${(Math.round(a / 100_000) / 10).toString()}M` : a >= 100_000 ? `${Math.round(a / 1000)}k` : Math.round(a).toLocaleString("en-US")}`;
};
const counted = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
function shortNames(names: string[]): string[] {
  const first = (n: string) => n.trim().split(/\s+/)[0] ?? n;
  const count = new Map<string, number>();
  for (const n of names) count.set(first(n).toLowerCase(), (count.get(first(n).toLowerCase()) ?? 0) + 1);
  return names.map((n) => { const parts = n.trim().split(/\s+/); return (count.get(first(n).toLowerCase()) ?? 0) > 1 && parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]}.` : first(n); });
}
/** A narrow ranked block (v1's leaderboard board): rank, name cut to fit, then the columns. No line over BOARD_WIDTH. */
function board(names: string[], cols: { cells: string[]; left?: boolean }[]): string {
  const shown = names.slice(0, MAX_PEOPLE), short = shortNames(shown);
  const rank = shown.map((_, i) => `${i + 1}.`), rw = Math.max(...rank.map((r) => r.length));
  const widths = cols.map((c) => Math.max(0, ...c.cells.slice(0, shown.length).map((x) => x.length)));
  const longest = Math.max(...short.map((n) => n.length));
  const lay = (gap: number) => ({ gap, nameW: Math.min(longest, BOARD_WIDTH - (rw + 1 + widths.reduce((a, w) => a + w + gap, 0))) });
  let { gap, nameW } = lay(2);
  if (nameW < Math.min(longest, 8)) ({ gap, nameW } = lay(1));
  nameW = Math.max(1, nameW);
  const lines = shown.map((_, i) => [rank[i]!.padEnd(rw), " ", cut(short[i]!, nameW).padEnd(nameW), ...cols.flatMap((c, j) => [" ".repeat(gap), c.left ? c.cells[i]!.padEnd(widths[j]!) : c.cells[i]!.padStart(widths[j]!)])].join("").trimEnd().slice(0, BOARD_WIDTH));
  if (names.length > MAX_PEOPLE) lines.push(`… ${names.length - MAX_PEOPLE} more`);
  return "```\n" + lines.join("\n") + "\n```";
}
function boardText(w: Words, closers: { name: string; cash: number | null; closes: number; close_rate: number | null }[], setters: { name: string; sets: number; show_rate: number | null }[]): string {
  const L = [w.heading, w.closers];
  const k = closers.slice(0, MAX_PEOPLE);
  L.push(closers.length ? board(closers.map((x) => x.name), [
    { cells: k.map((x) => dollars(x.cash)) },
    { cells: k.map((x) => counted(x.closes, w.close, w.closes)), left: true },
    { cells: k.map((x) => (x.close_rate === null ? "" : `${x.close_rate}%`)) },
  ]) : w.noClosers);
  L.push(w.setters);
  const s = setters.slice(0, MAX_PEOPLE);
  L.push(setters.length ? board(setters.map((x) => x.name), [
    { cells: s.map((x) => counted(x.sets, w.set, w.sets)), left: true },
    { cells: s.map((x) => (x.show_rate === null ? "" : `${x.show_rate}% ${w.showed}`)) },
  ]) : w.noSetters);
  return L.join("\n");
}

// ---- the end-of-day due list ----------------------------------------------------------------------------------------------

/**
 * A closer's days still to file (v1's eod_due step and eodFacts): each day in the lookback with their held calls that have
 * no answer yet (no call outcome, and not a no-show, a reschedule or a cancellation), not filed that day; today only when
 * the step says so. The CRM's Sales Calls still blank (a CRM read) add the calls the ledger does not hold, and name the
 * ones overdue for the operator.
 */
async function eodDue(d: ReportDeps, people: PersonRow[], def: z.infer<typeof EodDue>, params: Record<string, unknown>, ctx: Record<string, unknown>) {
  const who = ctx.person as { id?: string; name?: string } | undefined;
  const empty = { days: [], count: 0, overdue: [], overdue_count: 0 };
  if (!who?.id) return empty;
  const lookback = Number(params.lookback_days);
  if (!Number.isInteger(lookback) || lookback < 0) throw new Error(`eod_due needs lookback_days, a whole number of days, not "${String(params.lookback_days ?? "")}"`);
  const withToday = String(params.include_today) === "true";
  const overdueAfter = params.overdue_after_days === undefined || params.overdue_after_days === "none" || params.overdue_after_days === "" ? null : Number(params.overdue_after_days);
  const zone = d.offer.zone, today = todayIn(d.now, zone), from = plusDays(today, -lookback);
  const person = people.find((p) => p.id === who.id);
  const keys = new Set([person?.crmUserId ? `crm:${person.crmUserId}` : "", `name:${person?.name ?? who.name ?? ""}`].filter((k) => k && k !== "name:"));
  const filed = new Set(person?.eodDays ?? []);
  const base = String(d.settings[def.linkBase] ?? "").replace(/\/$/, "");
  const label = (day: string) => formatDate(dayStart(day, zone), "short_day", zone);
  const rows = (await d.tx.projFind("appointments", d.offer.id, { range: { col: "startsAt", from: dayStart(from, zone), to: dayStart(nextDay(today), zone) } }))
    .filter((a) => keys.has(a.closerKey ?? "") && a.status !== "cancelled" && a.status !== "invalid" && !a.callOutcome && !["noshow", "rescheduled", "cancelled"].includes(a.outcome ?? ""));
  const byDay = new Map<string, Set<string>>();
  for (const a of rows) { const day = todayIn(a.startsAt!, zone); byDay.set(day, (byDay.get(day) ?? new Set()).add(a.id)); }
  const blank = d.reads?.salesCallsBlank ? await d.reads.salesCallsBlank(d.offer.id, { closer: { ...(person ? personView(person) : {}), ...who }, from, to: today }) : [];
  const days: Record<string, unknown>[] = [];
  for (let day = from; day <= today; day = nextDay(day)) {
    if (filed.has(day) || (day === today && !withToday)) continue;
    const ledger = byDay.get(day) ?? new Set<string>();
    const extra = blank.filter((b) => b.day === day && !(b.appointment_id && ledger.has(b.appointment_id))).length;
    if (!ledger.size && !extra) continue;
    days.push({ day, label: label(day), when: day === today ? "Today" : label(day), url: base ? `${base}/eod/${who.id}${day === today ? "" : `?day=${day}`}` : undefined, today: day === today, calls: ledger.size, ghl_blank: extra, both: ledger.size > 0 && extra > 0 });
  }
  const overdue = overdueAfter === null ? [] : [...new Set(blank.filter((b) => b.day <= plusDays(today, -overdueAfter)).map((b) => b.day))].sort()
    .map((day) => ({ day, label: label(day), names: blank.filter((b) => b.day === day).map((b) => b.name) }));
  return { days, count: days.reduce((n, x) => n + (x.calls as number) + (x.ghl_blank as number), 0), overdue, overdue_count: overdue.length };
}
