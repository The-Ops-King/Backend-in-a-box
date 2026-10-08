import { DateTime } from "luxon";
import type { Schedule } from "./definition";

/** The schedule trigger's arithmetic and words. Pure (no database): the outline and the chart import it in the browser. */
const EVERY = /^(\d+)(m|h|d)$/;
export const everyMinutes = (s: string): number => { const m = EVERY.exec(s); if (!m) throw new Error(`bad schedule every ${s}`); return Number(m[1]) * { m: 1, h: 60, d: 1440 }[m[2] as "m" | "h" | "d"]; };

/** The period this schedule is in at `local` (company time) when it is due, else null: "every 60m" buckets the clock; "at 18:00" is the date once the time has passed. */
export function periodOf(s: Schedule, local: DateTime): string | null {
  if (s.every) return String(Math.floor(local.toMillis() / (everyMinutes(s.every) * 60_000)));
  const [hh, mm] = s.at!.split(":").map(Number);
  if (local.hour * 60 + local.minute < hh * 60 + mm) return null;
  if (s.days?.length && !s.days.includes(local.weekday)) return null;
  if (s.day_of_month && local.day !== s.day_of_month) return null;
  return local.toISODate()!;
}

/** Words for the outline: "every hour", "at 6:00 PM on weekdays, for each closer". */
export function scheduleWords(s: Schedule): string {
  const who = s.for === "closer" ? ", one run per closer" : "";
  if (s.every) { const m = everyMinutes(s.every); const span = m % 1440 === 0 ? `${m / 1440 === 1 ? "day" : `${m / 1440} days`}` : m % 60 === 0 ? `${m / 60 === 1 ? "hour" : `${m / 60} hours`}` : `${m} minutes`; return `every ${span}${who}`; }
  const t = DateTime.fromFormat(s.at!, "HH:mm").toFormat("h:mm a");
  const days = s.day_of_month ? ` on day ${s.day_of_month} of the month` : s.days?.length ? (s.days.length === 5 && [1, 2, 3, 4, 5].every((d) => s.days!.includes(d)) ? " on weekdays" : ` on ${s.days.map((d) => DateTime.fromObject({ weekday: d as 1 }).toFormat("ccc")).join(", ")}`) : " every day";
  return `at ${t}${days}${who}`;
}

