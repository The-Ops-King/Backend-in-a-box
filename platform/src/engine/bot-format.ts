import type { Availability, MetricResult, MetricRow, Unit } from "./metric-registry";

/**
 * Everything the Slack bot posts is rendered here from tool results, never written by the model (D70): key numbers first
 * as short bold lines, then tables as aligned monospace blocks (at most 25 rows and a totals row), then what each number
 * means and the period it covers in the company's zone.
 */
export const MAX_ROWS = 25;

export function fmt(unit: Unit, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (unit === "money") return `${v < 0 ? "−" : ""}$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
  if (unit === "rate") return `${Math.round(v * 1000) / 10}%`;
  if (unit === "minutes") return v >= 90 ? `${Math.floor(v / 60)} h ${Math.round(v % 60)} min` : `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)} min`;
  return Math.round(v).toLocaleString("en-US");
}

const cell = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);
/** An aligned monospace table: first column left, the rest right. Over MAX_ROWS rows the rest are counted, never dropped silently. */
export function table(head: string[], rows: string[][], total?: string[]): string {
  const shown = rows.slice(0, MAX_ROWS);
  const all = [head, ...shown, ...(total ? [total] : [])].map((r) => r.map((x, i) => (i === 0 ? cell(x.replace(/`/g, "'"), 24) : x)));
  const w = head.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((x, i) => (i === 0 ? (x ?? "").padEnd(w[i]) : (x ?? "").padStart(w[i]))).join("  ").trimEnd();
  const out = [line(all[0]), ...all.slice(1, 1 + shown.length).map(line)];
  if (rows.length > MAX_ROWS) out.push(`… ${rows.length - MAX_ROWS} more`);
  if (total) out.push("-".repeat(Math.max(...out.map((l) => l.length))), line(all[all.length - 1]));
  return "```\n" + out.join("\n") + "\n```";
}

/** The bold line a number gets on top: "*Close rate: 32%*  ·  8 closes ÷ 25 shows". */
export function keyLine(r: MetricResult): string {
  const who = r.filters && Object.keys(r.filters).length ? ` (${Object.values(r.filters).join(", ")})` : "";
  const ratio = r.unit === "rate" && r.denominator !== undefined ? `  ·  ${fmt("count", r.numerator)} ${r.numerator_label} ÷ ${fmt("count", r.denominator)} ${r.denominator_label}` : "";
  return `*${r.label}${who}: ${fmt(r.unit, r.value)}*${ratio}  · _from ${r.source}_`;
}

export function metricTable(r: MetricResult): string | null {
  if (!r.rows?.length) return null;
  const by = r.group_by ?? "group";
  const rate = r.unit === "rate";
  const head = rate ? [cap(by), r.label, cap(r.numerator_label ?? ""), cap(r.denominator_label ?? "")] : [cap(by), r.label];
  const row = (x: MetricRow) => (rate ? [x.label, fmt("rate", x.value), fmt("count", x.numerator), fmt("count", x.denominator)] : [x.label, fmt(r.unit, x.value)]);
  // a median per setter does not add up to the company's median; the totals line is the company's own figure either way
  const total = rate ? ["Total", fmt("rate", r.value), fmt("count", r.numerator), fmt("count", r.denominator)] : ["Total", fmt(r.unit, r.value)];
  return table(head, r.rows.map(row), total);
}
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const periodLine = (r: { period_label: string; timezone: string }) => `Period: ${r.period_label} (${r.timezone})`;

/** A whole answer: every key number on top, the model's one sentence (if any), the tables, then definitions and the period. */
export function formatAnswer(results: MetricResult[], opts: { note?: string; availability?: Availability[]; adhoc?: { why: string; columns: string[]; rows: unknown[][]; truncated: boolean }[] } = {}): string {
  const L: string[] = [...new Set(results.map(keyLine))];
  for (const a of opts.availability ?? []) L.push(availabilityKey(a));
  if (opts.note) L.push(opts.note);
  for (const r of results) { const t = metricTable(r); if (t) L.push("", `*${r.label} by ${r.group_by}*`, t); }
  for (const a of opts.availability ?? []) L.push("", availabilityBody(a));
  for (const q of opts.adhoc ?? []) L.push("", `*Ad hoc, from the raw ledger:* ${q.why}`, adhocTable(q));
  const defs = [...new Map(results.map((r) => [r.metric, r])).values()];
  if (defs.length) {
    L.push("");
    for (const r of defs) L.push(`_${r.label}: ${r.definition}_`);
    const periods = [...new Set(results.map((r) => periodLine(r)))];
    L.push(`_${periods.join(" · ")}_`);
  }
  for (const a of opts.availability ?? []) L.push("", availabilityFooter(a));
  return L.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function adhocTable(q: { columns: string[]; rows: unknown[][]; truncated: boolean }): string {
  if (!q.rows.length) return "_No rows._";
  const s = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return table(q.columns, q.rows.map((r) => r.map(s))) + (q.truncated ? "\n_More rows than shown._" : "");
}

/** Availability: the total per day (light days marked), then each closer per day, then where it came from. */
export function availabilityBody(a: Availability): string {
  const L: string[] = [];
  const light = a.days.filter((d) => d.light);
  if (light.length) L.push(`*Light days:* ${light.map((d) => `${d.label} (${d.total})`).join(", ")}`);
  L.push(table(["Day", "Open slots", ""], a.days.map((d) => [d.label, String(d.total), d.light ? "light" : ""]), ["Total", String(a.total), ""]));
  if (a.closers.length) {
    const short = a.days.map((d) => d.label.split(" ").filter((_, i) => i !== 1).join(" "));   // "Fri 10"
    L.push("*By closer*", table(["Closer", ...short, "Total"], a.closers.map((c) => [c.name, ...c.per_day.map(String), String(c.total)]), ["Total", ...a.days.map((d) => String(d.total)), String(a.total)]));
  }
  if (a.unreadable.length) L.push(`_Could not read: ${a.unreadable.map((u) => `${u.calendar} (${u.error})`).join("; ")}. Those calendars are not in the numbers._`);
  return L.join("\n");
}

export function formatAvailability(a: Availability): string {
  return [availabilityKey(a), "", availabilityBody(a), "", availabilityFooter(a)].join("\n");
}
export const availabilityKey = (a: Availability) => `*Open slots, next ${a.days.length} days: ${a.total.toLocaleString("en-US")}*  · _from ${a.source}_`;
export const availabilityFooter = (a: Availability) => `_${a.label}: ${a.definition}_\n_Period: ${a.days[0]?.label ?? ""} to ${a.days[a.days.length - 1]?.label ?? ""}, read just now (${a.timezone})_`;

/** The summary shortcuts (/mtd, /weekly, /monthly): the key numbers with the comparison beside each, then definitions. */
export function formatSummary(cur: MetricResult[], prev: MetricResult[] | null, extra: string[] = []): string {
  const L: string[] = [];
  for (const r of cur) {
    const p = prev?.find((x) => x.metric === r.metric);
    L.push(`${keyLine(r)}${p ? `  ·  ${p.period_name.toLowerCase()} ${fmt(p.unit, p.value)}${delta(r, p)}` : ""}`);
  }
  L.push(...extra, "");
  for (const r of cur) L.push(`_${r.label}: ${r.definition}_`);
  L.push(`_${periodLine(cur[0])}${prev?.[0] ? ` · compared with ${prev[0].period_label}` : ""}_`);
  return L.join("\n");
}
/** Several metrics split the same way, side by side in one table: Source | Leads | MQLs | DQs. */
export function formatCombined(results: MetricResult[]): string {
  const by = results[0]?.group_by;
  const L: string[] = results.map(keyLine);
  if (by) {
    const keys = new Map<string, string>();
    for (const r of results) for (const x of r.rows ?? []) if (!keys.has(x.key)) keys.set(x.key, x.label);
    const first = results[0];
    const order = [...keys.keys()].sort((a, b) => (first.rows?.find((x) => x.key === b)?.value ?? 0) - (first.rows?.find((x) => x.key === a)?.value ?? 0) || keys.get(a)!.localeCompare(keys.get(b)!));
    const rows = order.map((k) => [keys.get(k)!, ...results.map((r) => fmt(r.unit, r.rows?.find((x) => x.key === k)?.value ?? (r.unit === "rate" ? null : 0)))]);
    L.push("", `*By ${by}*`, table([cap(by), ...results.map((r) => r.label)], rows, ["Total", ...results.map((r) => fmt(r.unit, r.value))]));
  }
  L.push("");
  for (const r of results) L.push(`_${r.label}: ${r.definition}_`);
  if (results[0]) L.push(`_${periodLine(results[0])}_`);
  return L.join("\n");
}

function delta(r: MetricResult, p: MetricResult): string {
  if (r.value === null || p.value === null || r.value === undefined || p.value === undefined) return "";
  const d = r.value - p.value;
  if (!d) return " (same)";
  const s = d > 0 ? "▲" : "▼";
  return r.unit === "rate" ? ` (${s} ${Math.round(Math.abs(d) * 1000) / 10} pts)` : ` (${s} ${fmt(r.unit, Math.abs(d))})`;
}

export const SHORTCUTS: { command: string; about: string; example: string }[] = [
  { command: "/mtd", about: "month to date: leads, MQLs, booked, shows, closes, cash, top source by cash, vs the same days last month", example: "/mtd" },
  { command: "/weekly", about: "last full week (or `this week`), the same numbers, vs the week before", example: "/weekly this week" },
  { command: "/monthly", about: "last full month (or `this month`), the same numbers, vs the month before", example: "/monthly" },
  { command: "/show-rate", about: "show rate overall, by closer and by source (default this month)", example: "/show-rate last month" },
  { command: "/close-rate", about: "close rate overall, by closer and by source (default this month)", example: "/close-rate last 30 days" },
  { command: "/cash", about: "cash collected, refunds and net, by closer (default this month)", example: "/cash last week" },
  { command: "/availability", about: "open bookable slots for the next 7 days, per day and per closer (or a number of days, up to 7)", example: "/availability 3" },
  { command: "/leads", about: "leads, MQLs and marketing DQs by source (default this month)", example: "/leads yesterday" },
];
export function helpText(botMention = "@bot"): string {
  return [
    "*What I can answer*",
    ...SHORTCUTS.map((s) => `• \`${s.command}\` — ${s.about}  _e.g._ \`${s.example}\``),
    "",
    "Each shortcut takes a period in plain words: `today`, `yesterday`, `this week`, `last week`, `this month`, `last month`, `last 30 days`, `Sep 1 to Sep 15`, `2026-09-01..2026-09-30`. This month is the calendar month in the company's time zone.",
    "",
    `*Or just ask me* (mention ${botMention}, or DM me). For example:`,
    `• ${botMention} what's our close rate this month by closer?`,
    `• ${botMention} build me a report of the leads this month that showed, sorted by source`,
    `• ${botMention} what does our calendar availability look like?`,
    "",
    "\"My\" means you: _what is my close rate last month_ answers for you. I answer in the thread (in a DM, privately). If I'm not sure what you mean I'll ask; if I can't get the number I'll say so and ping someone who can.",
  ].join("\n");
}

export const ESCALATE_UNSURE = (who: string) => `I'm not sure how to get that information. Let me ping ${who} real quick.`;
export const ESCALATE_PING = (slackId: string) => `Hey <@${slackId}>, can you help?`;
