/**
 * Date words for messages, in a named IANA time zone, with the platform's own Intl (no date library). Every format is a
 * fixed name, so the words a format makes never depend on a pattern string written into content.
 */

export const DATE_FORMATS = ["long", "medium", "day", "short_day", "time", "time_zone", "weekday", "iso_date", "month_day", "month", "month_year"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

type Parts = { weekday: string; month: string; day: string; year: string; hour: string; minute: string; dayPeriod: string; timeZoneName: string };

function partsOf(d: Date, zone: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, weekday: "long", month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
  });
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(d)) out[p.type] = p.value;
  return out as Parts;
}

/** "2026-10-29" for the calendar day that instant falls on in that zone. */
export function isoDay(d: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** The hour of the day, 0 to 23, at that instant in that zone. */
export function localHour(d: Date, zone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(d)) % 24;
}

const clock = (p: Parts) => `${p.hour}:${p.minute} ${p.dayPeriod}`;
/** "2pm", "2:30pm": how a person writes a time in a text. */
const spokenClock = (p: Parts) => `${p.hour}${p.minute === "00" ? "" : `:${p.minute}`}${p.dayPeriod.toLowerCase()}`;

/**
 * long "Thursday, October 29 at 2:00 PM" · medium "Thu, Oct 29 at 2:00 PM" · day "Thursday, October 29" ·
 * short_day "Thu, Oct 29" · time "2:00 PM" · time_zone "2:00 PM MST" · weekday "Thursday" · iso_date "2026-10-29" ·
 * month_day "Oct 29" · month "October" · month_year "October 2026"
 */
export function formatDate(d: Date, format: DateFormat, zone: string): string {
  const p = partsOf(d, zone);
  switch (format) {
    case "long": return `${p.weekday}, ${p.month} ${p.day} at ${clock(p)}`;
    case "medium": return `${p.weekday.slice(0, 3)}, ${p.month.slice(0, 3)} ${p.day} at ${clock(p)}`;
    case "day": return `${p.weekday}, ${p.month} ${p.day}`;
    case "short_day": return `${p.weekday.slice(0, 3)}, ${p.month.slice(0, 3)} ${p.day}`;
    case "time": return clock(p);
    case "time_zone": return `${clock(p)} ${p.timeZoneName}`;
    case "weekday": return p.weekday;
    case "iso_date": return isoDay(d, zone);
    case "month_day": return `${p.month.slice(0, 3)} ${p.day}`;
    case "month": return p.month;
    case "month_year": return `${p.month} ${p.year}`;
  }
}

/**
 * Deliberately imprecise words for how far away a time is, worked out at the moment of sending: "in about 45 minutes",
 * "in about 2 hours", "today at 2pm", "tomorrow at 9:30am", "Thursday at 2pm", "Thu, Oct 29 at 2pm". A time that is not
 * in the future has no right words, so it is refused (returns undefined) rather than written as "in -30 minutes".
 */
export function relativeWords(target: Date, mode: "auto" | "minutes" | "hours", now: Date, zone: string): string | undefined {
  const mins = (target.getTime() - now.getTime()) / 60_000;
  if (mins <= 0) return undefined;
  const round5 = (n: number) => Math.max(5, Math.round(n / 5) * 5);
  const hoursWords = () => {
    const h = Math.round(mins / 30) / 2;
    return h <= 1 ? "in about an hour" : `in about ${h} hours`;
  };
  if (mode === "minutes") return `in about ${round5(mins)} minutes`;
  if (mode === "hours") return hoursWords();
  if (mins < 60) return `in about ${round5(mins)} minutes`;
  if (mins < 240) return hoursWords();
  const p = partsOf(target, zone);
  const day = isoDay(target, zone);
  if (day === isoDay(now, zone)) return `today at ${spokenClock(p)}`;
  if (day === isoDay(new Date(now.getTime() + 86_400_000), zone)) return `tomorrow at ${spokenClock(p)}`;
  if (mins < 6 * 24 * 60) return `${p.weekday} at ${spokenClock(p)}`;
  return `${p.weekday.slice(0, 3)}, ${p.month.slice(0, 3)} ${p.day} at ${spokenClock(p)}`;
}

/**
 * An instant from what a context holds: a Date, an ISO date-time, or a bare calendar day ("2026-10-29"). A bare day is
 * read as noon UTC, which is that same calendar day in every zone from UTC-11 to UTC+11, so it is never shown as the
 * day before.
 */
export function toInstant(v: unknown): Date | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  if (typeof v !== "string") return undefined;
  const s = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : v;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Whether a string names a time zone this runtime knows. */
export function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
