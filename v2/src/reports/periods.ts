import { addDays, localToInstant, partsIn } from "@/engine/time";

/**
 * Report periods on the offer's clock, as inclusive local dates: a day, a Monday-to-Sunday week, a calendar month;
 * the one that just ended, or the one in progress (to today). As v1's reports.ts and metric-registry.ts had them.
 */

export type PeriodKind = "daily" | "weekly" | "monthly";
export type Period = { kind: PeriodKind; toDate: boolean; from: string; to: string; start: Date; end: Date; name: string; label: string };

type Day = { y: number; m: number; d: number };
const isoOf = (p: Day) => `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
export const dayOf = (iso: string): Day => { const [y, m, d] = iso.split("-").map(Number); return { y: y!, m: m!, d: d! }; };
/** The instant a local day starts in the zone. */
export const dayStart = (iso: string, zone: string): Date => { const p = dayOf(iso); return localToInstant(p.y, p.m, p.d, 0, 0, zone); };
export const nextDay = (iso: string) => isoOf(addDays(dayOf(iso), 1));
export const plusDays = (iso: string, n: number) => isoOf(addDays(dayOf(iso), n));
export const todayIn = (now: Date, zone: string) => isoOf(partsIn(now, zone));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (p: Day) => `${MONTHS[p.m - 1]} ${p.d}`;

/** "Oct 12–18", "Sep 28 – Oct 4", "Oct 26": v1's rangeLabel, the year written only when it is not this year's. */
export function rangeLabel(from: string, to: string, now: Date, zone: string): string {
  const a = dayOf(from), b = dayOf(to), cur = partsIn(now, zone).y;
  const yr = (p: Day) => (p.y !== cur ? `, ${p.y}` : "");
  if (from === to) return `${short(a)}${yr(a)}`;
  if (a.y === b.y && a.m === b.m) return `${short(a)}–${b.d}${yr(b)}`;
  if (a.y === b.y) return `${short(a)} – ${short(b)}${yr(b)}`;
  return `${short(a)}, ${a.y} – ${short(b)}, ${b.y}`;
}

/** The period a report covers at `now`: the one that just ended, or the one in progress. */
export function periodFor(kind: PeriodKind, which: "just_ended" | "in_progress", now: Date, zone: string): Period {
  const today = todayIn(now, zone), t = partsIn(now, zone);
  const toDate = which === "in_progress";
  let from: string, to: string, name: string;
  if (kind === "daily") {
    from = to = toDate ? today : plusDays(today, -1);
    name = toDate ? "Today" : "Yesterday";
  } else if (kind === "weekly") {
    const monday = plusDays(today, -(t.weekday - 1));
    from = toDate ? monday : plusDays(monday, -7);
    to = toDate ? today : plusDays(monday, -1);
    name = toDate ? "This week" : "Last week";
  } else {
    const first = isoOf({ y: t.y, m: t.m, d: 1 });
    const prev = t.m === 1 ? { y: t.y - 1, m: 12, d: 1 } : { y: t.y, m: t.m - 1, d: 1 };
    from = toDate ? first : isoOf(prev);
    to = toDate ? today : plusDays(first, -1);
    name = toDate ? "This month" : "Last month";
  }
  return { kind, toDate, from, to, start: dayStart(from, zone), end: dayStart(nextDay(to), zone), name, label: rangeLabel(from, to, now, zone) };
}

/** The local days from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = nextDay(d)) out.push(d);
  return out;
}
