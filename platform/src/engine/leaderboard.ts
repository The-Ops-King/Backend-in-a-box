import type { PoolClient } from "pg";
import { liveGhlReads, type GhlReads } from "@/adapters/ghl/metrics";
import { LEDGER, getMetric, type MetricResult, type Period } from "./metric-registry";
import { GHL_SOURCE } from "./ghl-metrics";
import { memoReads } from "./ghl-graph";

/**
 * D94: the leaderboard. Closers ranked by cash collected, with their closes and close rate; setters ranked by sets (calls
 * a setter booked), with the show rate of those sets. Every number is a registry metric split by person (D70), so it can
 * never disagree with what the bot or the wrap-up says: `cash_collected` and `close_rate` (closes ÷ shows) by closer,
 * `booked_set` and `show_rate` by setter. Only people with something in the period are listed; nobody is "unassigned".
 */
export type LeaderCloser = { key: string; name: string; cash: number | null; closes: number; shows: number; /** whole percent; null with no shows */ close_rate: number | null };
export type LeaderSetter = { key: string; name: string; sets: number; due: number; shows: number; /** whole percent of their sets whose call time has passed; null when none has */ show_rate: number | null };
export type Leaderboard = {
  metric: "leaderboard"; label: string; source: string; period_label: string; period_name: string; from: string; to: string; timezone: string;
  closers: LeaderCloser[]; setters: LeaderSetter[];
  /** Said instead of cash when GHL holds no Payment records yet (D75: never $0); closers are then ranked by closes. */
  cash_unavailable?: string;
};

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null);
const rowsOf = (r: MetricResult) => new Map((r.rows ?? []).filter((x) => x.key).map((x) => [x.key, x]));

/** The period's leaderboard for one company. GHL is read once for the whole board. */
export async function getLeaderboard(c: PoolClient, companyId: string, q: { period: Period; now?: Date }, reads: GhlReads = liveGhlReads): Promise<Leaderboard> {
  const once = memoReads(reads);
  const m = (metric: string, groupBy: "closer" | "setter") => getMetric(c, companyId, { metric, period: q.period, groupBy, now: q.now }, once);
  const cash = await m("cash_collected", "closer"), closeRate = await m("close_rate", "closer");
  const sets = await m("booked_set", "setter"), showRate = await m("show_rate", "setter");

  const cashBy = rowsOf(cash), rateBy = rowsOf(closeRate);
  const closers: LeaderCloser[] = [...new Set([...cashBy.keys(), ...rateBy.keys()])].map((key) => {
    const r = rateBy.get(key), closes = r?.numerator ?? 0, shows = r?.denominator ?? 0;
    return { key, name: cashBy.get(key)?.label ?? r?.label ?? key, cash: cash.unavailable ? null : cashBy.get(key)?.value ?? 0, closes, shows, close_rate: pct(closes, shows) };
  }).filter((x) => (x.cash ?? 0) !== 0 || x.closes > 0 || x.shows > 0)
    .sort((a, b) => (b.cash ?? 0) - (a.cash ?? 0) || b.closes - a.closes || (b.close_rate ?? -1) - (a.close_rate ?? -1) || a.name.localeCompare(b.name));

  const setBy = rowsOf(sets), showBy = rowsOf(showRate);
  const setters: LeaderSetter[] = [...new Set([...setBy.keys(), ...showBy.keys()])].map((key) => {
    const r = showBy.get(key), shows = r?.numerator ?? 0, due = r?.denominator ?? 0;
    return { key, name: setBy.get(key)?.label ?? r?.label ?? key, sets: setBy.get(key)?.value ?? 0, due, shows, show_rate: pct(shows, due) };
  }).filter((x) => x.sets > 0 || x.due > 0)
    .sort((a, b) => b.sets - a.sets || (b.show_rate ?? -1) - (a.show_rate ?? -1) || a.name.localeCompare(b.name));

  return { metric: "leaderboard", label: "Leaderboard", source: `${GHL_SOURCE} and ${LEDGER}`, period_label: q.period.label, period_name: q.period.name, from: q.period.from, to: q.period.to, timezone: cash.timezone,
    closers, setters, ...(cash.unavailable ? { cash_unavailable: cash.unavailable } : {}) };
}

/** D124: nothing happened on the board: no closer has cash or a close, and no setter has a set (true, else null). From the numbers, never the words. */
export const nothingOnBoard = (lb: Pick<Leaderboard, "closers" | "setters">): true | null =>
  lb.closers.some((x) => (x.cash ?? 0) !== 0 || x.closes > 0) || lb.setters.some((x) => x.sets > 0) ? null : true;

// ---- the words ------------------------------------------------------------------------------------------------------------
/** Slack on a phone wraps a code block at about this many characters; every line inside one stays within it. */
export const BOARD_WIDTH = 34;
const MAX_PEOPLE = 20;
/** Dollars, whole; from $100k up in k and M so a name still fits beside it. */
const money = (v: number | null) => {
  if (v === null) return "—";
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  return `${s}$${a >= 999_500 ? `${(Math.round(a / 100_000) / 10).toString()}M` : a >= 100_000 ? `${Math.round(a / 1000)}k` : Math.round(a).toLocaleString("en-US")}`;
};
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const fit = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(1, w - 1))}…` : s);

/** First names, unless two people on the same board share one: then the last initial too. */
function shortNames(names: string[]): string[] {
  const first = (n: string) => n.trim().split(/\s+/)[0] ?? n;
  const count = new Map<string, number>();
  for (const n of names) count.set(first(n).toLowerCase(), (count.get(first(n).toLowerCase()) ?? 0) + 1);
  return names.map((n) => { const parts = n.trim().split(/\s+/); return (count.get(first(n).toLowerCase()) ?? 0) > 1 && parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : first(n); });
}

/** A narrow ranked block: rank, name (cut to fit), then the given columns (right-aligned unless `left`). No line over BOARD_WIDTH. */
function board(names: string[], cols: { cells: string[]; left?: boolean }[]): string {
  const shown = names.slice(0, MAX_PEOPLE), short = shortNames(shown);
  const rank = shown.map((_, i) => `${i + 1}.`), rw = Math.max(...rank.map((r) => r.length));
  const widths = cols.map((c) => Math.max(0, ...c.cells.slice(0, shown.length).map((x) => x.length)));
  const longest = Math.max(...short.map((n) => n.length));
  const lay = (gap: number) => ({ gap, nameW: Math.min(longest, BOARD_WIDTH - (rw + 1 + widths.reduce((a, w) => a + w + gap, 0))) });
  // two spaces between columns, one when that is what keeps a name readable
  let { gap, nameW } = lay(2);
  if (nameW < Math.min(longest, 8)) ({ gap, nameW } = lay(1));
  nameW = Math.max(1, nameW);
  const lines = shown.map((_, i) => [rank[i].padEnd(rw), " ", fit(short[i], nameW).padEnd(nameW), ...cols.flatMap((c, j) => [" ".repeat(gap), c.left ? c.cells[i].padEnd(widths[j]) : c.cells[i].padStart(widths[j])])].join("").trimEnd().slice(0, BOARD_WIDTH));
  if (names.length > MAX_PEOPLE) lines.push(`… ${names.length - MAX_PEOPLE} more`);
  return "```\n" + lines.join("\n") + "\n```";
}

/** The body only: no period, no source, no definitions (the caller adds its own footer). Rates are whole percents. */
export function formatLeaderboard(lb: Leaderboard): string {
  const L = ["🏆 *Leaderboard*", "*Closers* (by cash)"];
  const k = lb.closers.slice(0, MAX_PEOPLE);
  L.push(lb.closers.length ? board(lb.closers.map((x) => x.name), [
    { cells: k.map((x) => money(x.cash)) },
    { cells: k.map((x) => plural(x.closes, "close", "closes")), left: true },
    { cells: k.map((x) => (x.close_rate === null ? "" : `${x.close_rate}%`)) },
  ]) : "_No closes yet._");
  L.push("*Setters* (by sets)");
  const s = lb.setters.slice(0, MAX_PEOPLE);
  L.push(lb.setters.length ? board(lb.setters.map((x) => x.name), [
    { cells: s.map((x) => plural(x.sets, "set", "sets")), left: true },
    { cells: s.map((x) => (x.show_rate === null ? "" : `${x.show_rate}% showed`)) },
  ]) : "_No sets yet._");
  return L.join("\n");
}
