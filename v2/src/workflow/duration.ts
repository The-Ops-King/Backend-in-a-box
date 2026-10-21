import { z } from "zod";

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
type Unit = keyof typeof UNIT_MS;

/** A length of time written as a whole number and a unit: "90s", "15m", "2h", "1d", "1w". Always positive. */
export const Duration = z.string().regex(/^[1-9]\d*(s|m|h|d|w)$/, { message: 'a duration is a whole number and a unit: "90s", "15m", "2h", "1d", "1w"' });
export type Duration = z.infer<typeof Duration>;

/** A signed shift from an anchor time: "-24h" (a day before), "+15m" (a quarter hour after). */
export const Offset = z.string().regex(/^[+-][1-9]\d*(s|m|h|d|w)$/, { message: 'an offset is a sign, a whole number and a unit: "-24h", "+15m"' });
export type Offset = z.infer<typeof Offset>;

/** A time of day on a 24-hour clock, "08:00" to "23:59". */
export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'a time of day is "HH:MM" on a 24-hour clock' });
export type ClockTime = z.infer<typeof ClockTime>;

/** Milliseconds in a duration ("2h") or an offset ("-24h", negative). Throws on anything else. */
export function toMs(s: string): number {
  const m = /^([+-]?)(\d+)(s|m|h|d|w)$/.exec(s);
  if (!m) throw new Error(`not a duration: ${s}`);
  return (m[1] === "-" ? -1 : 1) * Number(m[2]) * UNIT_MS[m[3] as Unit];
}

/** Minutes since midnight for "HH:MM". */
export const clockMinutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
