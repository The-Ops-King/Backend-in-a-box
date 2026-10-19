import { DateTime } from "luxon";
import { METRICS, type Availability, type ClosesList, type MetricResult, type Unit } from "./metric-registry";
import { NO_ANSWER, type Analysis, type Group } from "./ghl-graph";
import { NO_PAYMENTS } from "./ghl-metrics";
import { accuracyWords } from "./setter-result";

/**
 * Everything the Slack bot posts is rendered here from tool results, never written by the model (D70). D95: the owner
 * reads it on a phone, so an answer is the answer first (one bold line), then only the detail asked for, then one footer
 * line with the period, where it was read and when. Each fact appears once; rates are whole percents; a monospace table
 * never runs wider than a phone shows; a warning appears only when there is something to fix.
 */
export const MAX_ROWS = 25;
/** Slack's phone app wraps a code block at about this many characters, and a wrapped table can't be read. */
export const PHONE_WIDTH = 34;

export function fmt(unit: Unit, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (unit === "money") return `${v < 0 ? "−" : ""}$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
  if (unit === "rate") return `${Math.round(v * 100)}%`;
  if (unit === "minutes") return v >= 90 ? `${Math.floor(v / 60)} h ${Math.round(v % 60)} min` : `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)} min`;
  return Math.round(v).toLocaleString("en-US");
}

const cut = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(1, w - 1))}…` : s);
/** A monospace table that fits a phone: the first column left and cut to make room, the rest right. Over MAX_ROWS rows the rest are counted, never dropped silently. */
export function table(head: string[] | null, rows: string[][], width = PHONE_WIDTH): string {
  const clean = (r: string[]) => r.map((x) => (x ?? "").replace(/`/g, "'"));
  const all = [...(head ? [clean(head)] : []), ...rows.slice(0, MAX_ROWS).map(clean)];
  if (!all.length) return "";
  const n = Math.max(...all.map((r) => r.length));
  const w = Array.from({ length: n }, (_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  w[0] = Math.max(6, Math.min(w[0], width - w.slice(1).reduce((s, x) => s + x + 2, 0)));
  const line = (r: string[]) => r.map((x, i) => (i === 0 ? cut(x ?? "", w[0]).padEnd(w[0]) : (x ?? "").padStart(w[i]))).join("  ").trimEnd();
  const out = all.map(line);
  if (rows.length > MAX_ROWS) out.push(`… ${rows.length - MAX_ROWS} more`);
  return "```\n" + out.join("\n") + "\n```";
}
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const and = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// ---- the footer ----------------------------------------------------------------------------------------------------------
export type Foot = { now?: DateTime; tz?: string; askedBy?: string; compare?: string };
type Dated = { period_label: string; timezone: string; source?: string };
const sourceWords = (s: string) => s.split(/ and /).map((x) => x.replace(/, read just now$/, "").replace(/^the engine's ledger$/, "the engine").trim()).filter(Boolean);
/** One line under every answer: the period(s), where the numbers were read and when, and who asked a shortcut. */
export function footer(items: Dated[], o: Foot = {}): string {
  const tz = items[0]?.timezone ?? o.tz ?? "UTC";
  const periods = [...new Set(items.map((r) => r.period_label).filter(Boolean))];
  const sources = [...new Set(items.flatMap((r) => (r.source ? sourceWords(r.source) : [])))];
  const at = (o.now ?? DateTime.now()).setZone(tz).toFormat("h:mm a ZZZZ");
  const parts = [periods.length ? periods.join(" · ") + (o.compare ? ` vs ${o.compare}` : "") : "", sources.length ? `From ${and(sources)}, read ${at}` : `Read ${at}`, o.askedBy ? `Asked by <@${o.askedBy}>` : ""];
  return `_${parts.filter(Boolean).join(" · ")}_`;
}
const availabilityDated = (a: Availability): Dated => ({ period_label: `${a.days[0]?.label ?? ""} to ${a.days[a.days.length - 1]?.label ?? ""}`, timezone: a.timezone, source: a.source });

// ---- a metric ----------------------------------------------------------------------------------------------------------
/** The answer line: "*Close rate: 33%* (1 of 3 shows)". */
export function keyLine(r: MetricResult): string {
  if (r.unavailable) return `*${r.label}:* ${r.unavailable}`;
  const who = r.filters && Object.keys(r.filters).length ? ` (${Object.values(r.filters).join(", ")})` : "";
  const ratio = r.unit === "rate" && r.denominator !== undefined ? ` (${fmt("count", r.numerator)} of ${fmt("count", r.denominator)}${r.denominator_label ? ` ${r.denominator_label}` : ""})` : "";
  return `*${r.label}${who}: ${fmt(r.unit, r.value)}*${ratio}`;
}
/** A split metric as a narrow table under "*By closer*": a rate with its "1/3", anything else its value. No totals row: the answer line is the total. */
export function metricTable(r: MetricResult): string[] {
  if (!r.rows?.length || r.unavailable) return [];
  const rows = r.rows.map((x) => (r.unit === "rate" ? [x.label, fmt("rate", x.value), `${fmt("count", x.numerator)}/${fmt("count", x.denominator)}`] : [x.label, fmt(r.unit, x.value)]));
  return [`*By ${r.group_by ?? r.rows_by}*`, table(null, rows)];
}
/** What a number carries besides itself: Jev's accuracy counts. */
export function detailLines(r: MetricResult): string[] {
  return r.setter_accuracy ? [accuracyWords(r.setter_accuracy)] : [];
}
const NAMES_SHOWN = 15;
const names = (list: string[]) => (list.length <= NAMES_SHOWN ? list.join(", ") : `${list.slice(0, NAMES_SHOWN).join(", ")} and ${list.length - NAMES_SHOWN} more`);
const CLASS_WORDS: Record<string, string> = { showed: "showed", noshow: "no-show", cancelled: "cancelled", rescheduled: "rescheduled" };
/** Only what someone has to fix. */
export function warnings(r: MetricResult): string[] {
  const L: string[] = [];
  const q = r.qualification;
  if (q?.unrecognized) L.push(`⚠️ ${q.unrecognized} work-situation answer${q.unrecognized === 1 ? "" : "s"} not recognised: ${q.unrecognized_answers.map((a) => `"${a}"`).join(", ")}`);
  const b = r.shows_breakdown;
  if (b?.missing) L.push(`⚠️ No EOD outcome yet: ${names(b.missing_names)}`);
  for (const m of b?.mismatches ?? []) L.push(`⚠️ ${m.name}: GHL says ${CLASS_WORDS[m.ghl] ?? m.ghl}, ${m.booking_source} says cancelled (fix the Sales Call in GHL)`);
  return L;
}

// ---- an analysis (D75) ---------------------------------------------------------------------------------------------------
const UNIT_WORDS = { lead: ["lead", "leads"], call: ["call", "calls"], close: ["close", "closes"] } as const;
const plural = (n: number, u: keyof typeof UNIT_WORDS) => `${n.toLocaleString("en-US")} ${UNIT_WORDS[u][n === 1 ? 0 : 1]}`;
const unitCount = (a: Analysis, g: Group) => (a.unit === "call" ? g.calls : g.count);
const pc = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const money = (v: number) => fmt("money", v);
export function analysisKey(a: Analysis): string {
  const where = a.filters.length ? ` where ${a.filters.map((f) => `"${f.name}" is ${f.equals}`).join(" and ")}` : "";
  return `*${cap(plural(unitCount(a, a.total), a.unit))}${where}${a.split ? `, by "${a.split.name}"` : ""}*`;
}
/** The counted bullets: "• 2 — I have significant thinning…", most first, no answer last. Not split: who. */
export function analysisBreakdown(a: Analysis): string[] {
  if (!unitCount(a, a.total)) return [`_No ${UNIT_WORDS[a.unit][1]} in this period._`];
  if (!a.split) return analysisList(a);
  const rows = a.rows.filter((g) => unitCount(a, g) > 0).sort((x, y) => (x.value === NO_ANSWER ? 1 : 0) - (y.value === NO_ANSWER ? 1 : 0) || unitCount(a, y) - unitCount(a, x));
  return [...rows.map((g) => `• ${unitCount(a, g)} — ${g.value === NO_ANSWER ? "no answer" : g.value}`), ...(a.split.multi ? ["_More than one answer could be picked._"] : [])];
}
/** The same split as a narrow table, with the rate the question is about. */
export function analysisTable(a: Analysis): string[] {
  if (!a.split || !unitCount(a, a.total)) return analysisBreakdown(a);
  const rate = a.rate ?? (a.unit === "lead" ? "booked_rate" : a.unit === "call" ? "show_rate" : null);
  const rateHead = rate === "booked_rate" ? "Booked" : rate === "show_rate" ? "Showed" : rate === "close_rate" ? "Closed" : "";
  const head = ["Answer", cap(UNIT_WORDS[a.unit][1]), ...(rate ? [rateHead] : a.payments ? ["Cash"] : [])];
  const rows = a.rows.map((g) => [g.value === NO_ANSWER ? "no answer" : g.value, String(unitCount(a, g)), ...(rate ? [pc(g[rate])] : a.payments ? [money(g.cash)] : [])]);
  return [table(head, rows), ...(a.test ? [`_${a.test.verdict}_`] : [])];
}
/** Who: split, the counted bullets with the names under each ("• 2 — answer" / "_Lynton Thompson, Lakshan Gunaratne_"); not split, one bullet per person with their outcome unless every one is the same. */
export function analysisList(a: Analysis): string[] {
  if (!a.list?.length) return [];
  if (a.split) {
    const by = new Map<string, string[]>();
    for (const x of a.list) for (const v of x.values.length ? x.values : [NO_ANSWER]) by.set(v, [...(by.get(v) ?? []), x.name]);
    const order = [...by].sort(([x, p], [y, q]) => (x === NO_ANSWER ? 1 : 0) - (y === NO_ANSWER ? 1 : 0) || q.length - p.length);
    return [...order.flatMap(([v, who]) => [`• ${who.length} — ${v === NO_ANSWER ? "no answer" : v}`, `      _${who.join(", ")}_`]), ...(a.list.length < a.total.count ? [`_First ${a.list.length} of ${a.total.count}._`] : [])];
  }
  const sameOutcome = new Set(a.list.map((x) => x.outcome)).size <= 1;
  return [...a.list.map((x) => `• ${x.name}${x.value ? ` — ${x.value}` : ""}${sameOutcome ? "" : ` — ${x.outcome}`}`), ...(a.list.length < a.total.count ? [`_First ${a.list.length} of ${a.total.count}._`] : [])];
}

/** What is off in GHL behind an analysis, only when the asker asks ("anything off?", "what's missing?"): who has no answer, links that are missing, records that disagree. */
export function analysisIssues(a: Analysis): string[] {
  const L: string[] = [];
  const more = (n: number) => (n > 15 ? ` and ${n - 15} more` : "");
  if (a.split && a.unanswered.length) L.push(`*No answer on ${plural(a.unanswered.length, a.unit)}:* ${a.unanswered.slice(0, 15).map((u) => `${u.name} (${u.date}${u.booked ? `, ${u.booked.toLowerCase()}` : ""})`).join(", ")}${more(a.unanswered.length)}`);
  for (const k of a.links.filter((x) => x.linked < x.of)) L.push(`*Links:* ${plural(k.of, a.unit)} · ${k.linked} linked to ${k.what} · missing: ${k.missing.slice(0, 15).join(", ")}${more(k.of - k.linked)}`);
  const kinds = [["won_no_payment", "Closer card won, no payment in GHL"], ["payment_no_won", "Payment in GHL, no won closer card"], ["cash_field", "Total Cash Collected on the contact is not the sum of their payments"]] as const;
  for (const [k, words] of kinds) {
    const list = a.mismatches.filter((m) => m.kind === k);
    if (list.length) L.push(`⚠️ ${words}: ${list.slice(0, 15).map((m) => (k === "cash_field" ? `${m.name} (contact ${money(m.contact_cash ?? 0)} · payments ${money(m.payments ?? 0)})` : k === "payment_no_won" ? `${m.name} (${money(m.payments ?? 0)}, ${m.date})` : `${m.name} (won ${m.date})`)).join(", ")}${more(list.length)}`);
  }
  return L.length ? L : ["Nothing off: every record links up and agrees."];
}

// ---- closes, availability --------------------------------------------------------------------------------------------------
/** "*Closes: 1*", then each closer's closes: "• Lynton Thompson — $750 / $750 — Mon Oct 5" (cash collected / revenue). */
export const closesKey = (k: ClosesList) => `*Closes${k.filters?.closer ? ` (${k.filters.closer})` : ""}: ${k.count}*`;
export function closesBody(k: ClosesList): string[] {
  if (!k.closes.length) return ["_No closes in this period._"];
  const by = new Map<string, ClosesList["closes"]>();
  for (const x of k.closes) by.set(x.closer, [...(by.get(x.closer) ?? []), x]);
  return [...by].flatMap(([closer, list], i) => [...(i ? [""] : []), `*${closer}*`, ...list.map((x) => `• ${x.name} — ${x.cash === null ? "—" : money(x.cash)} / ${money(x.value)} — ${x.won}`)]);
}
export const formatCloses = (k: ClosesList, o: Foot = {}) => [`📊 ${closesKey(k)}`, ...closesBody(k), "", footer([k], o)].join("\n");

/** Availability (D72): the days down the side, a column per closer, then the day's total. */
export function availabilityBody(a: Availability): string {
  const L: string[] = [];
  const total = ["Total", ...a.closers.map((c) => String(c.total)), String(a.total)];
  L.push(table(["Day", ...a.closers.map((c) => c.short), "All"], [...a.days.map((d, i) => [d.label, ...a.closers.map((c) => String(c.per_day[i])), String(d.total)]), total], 40));
  if (a.split_error) L.push(a.split_error);
  if (a.unreadable.length) L.push(`⚠️ Couldn't read ${a.unreadable.map((u) => `${u.calendar} (${u.error})`).join("; ")}, so it isn't in the numbers.`);
  return L.join("\n");
}
export const availabilityKey = (a: Availability) => `*Open slots, next ${a.days.length} days: ${a.total.toLocaleString("en-US")}*`;
export const formatAvailability = (a: Availability, o: Foot = {}) => [availabilityKey(a), availabilityBody(a), footer([availabilityDated(a)], o)].join("\n");

// ---- a whole answer ------------------------------------------------------------------------------------------------------
/** How much the asker sees under the answer: nothing, counted bullets, a narrow table, the people by name, or what is off in GHL. */
export type Detail = "none" | "breakdown" | "table" | "list" | "issues";
export const DETAILS: Detail[] = ["none", "breakdown", "table", "list", "issues"];
export type AnswerParts = {
  /** The model's one-line answer (its numbers already checked against the results); without it the answer lines are ours. */
  headline?: string; detail?: Detail; note?: string;
  availability?: Availability[]; closes?: ClosesList[]; analyses?: Analysis[];
  adhoc?: { why: string; columns: string[]; rows: unknown[][]; truncated: boolean }[];
} & Foot;
export function formatAnswer(results: MetricResult[], o: AnswerParts = {}): string {
  const an = o.analyses ?? [], cl = o.closes ?? [], av = o.availability ?? [], ah = o.adhoc ?? [];
  const keys = [...new Set([...results.map(keyLine), ...cl.map(closesKey), ...av.map(availabilityKey), ...an.map(analysisKey)])];
  const headline = o.headline?.trim().replace(/\*/g, "");
  const detail: Detail = o.detail ?? "breakdown";
  // a headline with no number and nothing under it would answer nothing: our answer lines stay under it
  const bare = !!headline && detail === "none" && !/\d/.test(headline);
  const L: string[] = headline ? [`*${headline}*`, ...(bare ? keys : [])] : keys;
  if (detail !== "none" || !headline) {
    for (const r of results) L.push(...detailLines(r));
    for (const r of results) { const t = metricTable(r); if (t.length) L.push("", ...t); }
    for (const a of an) { const d = detail === "table" ? analysisTable(a) : detail === "issues" ? analysisIssues(a) : detail === "list" && analysisList(a).length ? analysisList(a) : analysisBreakdown(a); if (d.length) L.push("", ...d); }
    for (const k of cl) L.push("", ...closesBody(k));
  }
  for (const a of av) L.push(availabilityBody(a));
  if (detail !== "none" || !headline) for (const q of ah) L.push("", `_${q.why} (from the engine's own records)_`, adhocTable(q));
  const warn = [...new Set(results.flatMap(warnings))];
  if (o.note?.trim()) L.push("", o.note.trim());
  if (warn.length) L.push("", ...warn);
  L.push("", footer([...results, ...cl, ...an, ...av.map(availabilityDated)], o));
  return L.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
/** Every number any view of these results shows: what the model's headline and note may repeat (they may never make one up). */
export function allNumbersText(results: MetricResult[], o: AnswerParts): string {
  const an = o.analyses ?? [];
  // the footer's read time is not a number of the answer ("read 2:17 PM" must not let a made-up 17% through); its period is
  const shown = formatAnswer(results, { ...o, headline: undefined, note: undefined, detail: "breakdown" }).split("\n").slice(0, -1).join("\n");
  const periods = [...results, ...(o.closes ?? []), ...an].map((r) => r.period_label);
  return [shown, ...periods,
    ...an.flatMap((a) => [...analysisTable(a), ...analysisList(a), ...analysisIssues(a), ...[a.total, ...a.rows].map((g) => `${g.count} ${g.calls} ${g.booked} ${g.showed} ${g.noshow} ${g.cancelled} ${g.closed} ${money(g.cash)} ${money(g.card_value)} ${pc(g.show_rate)} ${pc(g.close_rate)} ${pc(g.booked_rate)} ${pc(g.share)}`)])].join("\n");
}

function adhocTable(q: { columns: string[]; rows: unknown[][]; truncated: boolean }): string {
  if (!q.rows.length) return "_No rows._";
  const s = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return table(q.columns, q.rows.map((r) => r.map(s)), 60) + (q.truncated ? "\n_More rows than shown._" : "");
}

// ---- the shortcuts ---------------------------------------------------------------------------------------------------------
const SHORT: Record<string, string> = { calls_booked_due: "Booked", cash_collected: "Cash", marketing_dqs: "DQs", cash_gross: "Paid", refunds: "Refunds" };
const short = (r: MetricResult) => SHORT[r.metric] ?? r.label;
function delta(r: MetricResult, p: MetricResult): string {
  if (r.value === null || p.value === null || r.value === undefined || p.value === undefined || r.unavailable || p.unavailable) return "";
  const d = r.unit === "rate" ? Math.round(r.value * 100) - Math.round(p.value * 100) : Math.round(r.value) - Math.round(p.value);
  if (!d) return "same";
  return `${d > 0 ? "▲" : "▼"} ${r.unit === "rate" ? `${Math.abs(d)} pts` : fmt(r.unit, Math.abs(d))}`;
}
/** /mtd, /weekly, /monthly: one narrow table of the key numbers with the change beside each, then the top source. */
export function formatSummary(title: string, cur: MetricResult[], prev: MetricResult[] | null, extra: string[] = [], o: Foot = {}): string {
  const rows = cur.map((r) => { const p = prev?.find((x) => x.metric === r.metric); return [short(r), r.unavailable ? "—" : fmt(r.unit, r.value), p ? delta(r, p) : ""]; });
  const unread = cur.filter((r) => r.unavailable).map((r) => `${r.label}: ${r.unavailable}`);
  const warn = [...new Set(cur.flatMap(warnings))];
  return [`📊 *${title}*`, table(null, rows), ...extra, ...(unread.length || warn.length ? ["", ...unread, ...warn] : []), "", footer([cur[0]], { ...o, compare: prev?.[0]?.period_label })].join("\n").replace(/\n{3,}/g, "\n\n");
}
/** /show-rate, /close-rate: the answer line, then a narrow table per split. */
export function formatSplits(results: MetricResult[], o: Foot = {}): string {
  const tables = results.flatMap((r) => { const t = metricTable(r); return t.length ? ["", ...t] : []; });
  const warn = [...new Set(results.flatMap(warnings))];
  return [`📊 ${keyLine(results[0])}`, ...tables, ...(warn.length ? ["", ...warn] : []), "", footer([results[0]], o)].join("\n").replace(/\n{3,}/g, "\n\n");
}
/** /cash, /leads: the first metric is the answer, the others one line under it, then one table with a column each. */
export function formatCombined(results: MetricResult[], o: Foot = {}): string {
  const [first, ...rest] = results;
  const L: string[] = [`📊 ${keyLine(first)}`];
  if (rest.length) L.push(rest.map((r) => `${r.label} ${r.unavailable ? "—" : fmt(r.unit, r.value)}`).join(" · "));
  const by = results.every((r) => r.unavailable) ? undefined : first.group_by;
  if (by) {
    const keys = new Map<string, string>();
    for (const r of results) for (const x of r.rows ?? []) if (!keys.has(x.key)) keys.set(x.key, x.label);
    const val = (r: MetricResult, k: string) => r.rows?.find((x) => x.key === k)?.value ?? (r.unit === "rate" ? null : 0);
    const order = [...keys.keys()].sort((a, b) => (val(first, b) ?? 0) - (val(first, a) ?? 0) || keys.get(a)!.localeCompare(keys.get(b)!));
    L.push("", table([cap(by), ...results.map(short)], order.map((k) => [keys.get(k)!, ...results.map((r) => fmt(r.unit, val(r, k)))])));
  }
  const unread = rest.filter((r) => r.unavailable).map((r) => `${r.label}: ${r.unavailable}`);
  const warn = [...new Set(results.flatMap(warnings))];
  if (unread.length || warn.length) L.push("", ...unread, ...warn);
  L.push("", footer([first], o));
  return L.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** `hint`: what Slack shows after the command as it is typed (D174: the Slack app manifest is made from this list). */
export const SHORTCUTS: { command: string; about: string; example: string; hint?: string }[] = [
  { command: "/mtd", about: "month to date: leads, MQLs, booked, show rate, close rate, deposits, cash, top source, vs the same days last month", example: "/mtd" },
  { command: "/weekly", about: "last full week (or `this week`), the same numbers, vs the week before", example: "/weekly this week", hint: "[this week]" },
  { command: "/monthly", about: "last full month (or `this month`), the same numbers, vs the month before", example: "/monthly", hint: "[this month]" },
  { command: "/show-rate", about: "show rate by closer and by source, and whose calls have no EOD outcome (default this month)", example: "/show-rate last month", hint: "[last month]" },
  { command: "/close-rate", about: "close rate by closer and by source (default this month)", example: "/close-rate last 30 days", hint: "[last month]" },
  { command: "/cash", about: "cash collected, payments and refunds, by closer (default this month)", example: "/cash last week", hint: "[last week]" },
  { command: "/availability", about: "open slots for the next 7 days (or fewer), per day and per closer", example: "/availability 3", hint: "[days, up to 7]" },
  { command: "/leads", about: "leads, MQLs and marketing DQs by source (default this month)", example: "/leads yesterday", hint: "[yesterday]" },
  { command: "/closes", about: "every close by closer: who, cash collected / revenue, the day it was won (default this month)", example: "/closes last month", hint: "[last month]" },
  { command: "/leaderboard", about: "closers ranked by cash (closes and close rate beside), setters ranked by sets (show rate of their sets beside) (default this week)", example: "/leaderboard last week", hint: "[last week]" },
];
export function helpText(botMention = "@bot"): string {
  return [
    "*What I can answer*",
    ...SHORTCUTS.map((s) => `• \`${s.command}\` — ${s.about}  _e.g._ \`${s.example}\``),
    "",
    "Each shortcut takes a period in plain words: `today`, `yesterday`, `this week`, `last week`, `this month`, `last month`, `last 30 days`, `Sep 1 to Sep 15`, `2026-09-01..2026-09-30`. This month is the calendar month in the company's time zone.",
    "",
    `*Or just ask me* (mention ${botMention}, or DM me). For example:`,
    `• ${botMention} what's our close rate this month?`,
    `• ${botMention} who showed this month and how did they describe their hair loss?`,
    `• ${botMention} what did Lynton pay?`,
    `• ${botMention} show rate by closer last month, as a table`,
    `• ${botMention} what does our calendar availability look like?`,
    "",
    "*What the numbers mean*",
    ...HELP_METRICS.map((m) => `• *${METRICS[m].label}*: ${METRICS[m].definition}`),
    "",
    "\"My\" means you: _what is my close rate last month_ answers for you. I answer in the thread (in a DM, privately); ask for more there (\"who?\", \"as a table\", \"by source\"). If I'm not sure what you mean I'll ask; if I can't get the number I'll say so and ping someone who can.",
  ].join("\n");
}

const HELP_METRICS = ["leads", "mqls", "marketing_dqs", "calls_booked_due", "show_rate", "sales_dqs", "closes", "close_rate", "cash_collected"];

export { NO_ANSWER, NO_PAYMENTS };
export const ESCALATE_UNSURE = (who: string) => `I'm not sure how to get that information. Let me ping ${who} real quick.`;
export const ESCALATE_PING = (slackId: string) => `Hey <@${slackId}>, can you help?`;
