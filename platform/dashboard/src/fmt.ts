/** Dates as short as they can be (design guide §2.10), in the company's zone. */
const dayKey = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export function shortDate(iso: string | Date | null | undefined, tz: string, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso); const k = dayKey(d, tz), today = dayKey(now, tz), yest = dayKey(new Date(now.getTime() - 86_400_000), tz);
  if (k === today) return "Today"; if (k === yest) return "Yesterday";
  const sameYear = k.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(d);
}
export const timeOf = (iso: string | Date | null | undefined, tz: string) => iso ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "";
/** "Today · 2:14 PM", "Oct 8 · 4:41 PM". */
export const when = (iso: string | Date | null | undefined, tz: string, now = new Date()) => iso ? `${shortDate(iso, tz, now)} · ${timeOf(iso, tz)}` : "";
/** "Thu Oct 9 · 2:00 PM": a call's time, with the weekday. */
export const callTime = (iso: string | Date | null | undefined, tz: string) => iso ? `${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(new Date(iso))} · ${timeOf(iso, tz)}` : "";
export const ago = (iso: string | Date | null | undefined, now = new Date()) => { if (!iso) return ""; const m = Math.round((now.getTime() - new Date(iso).getTime()) / 60e3); if (m < 1) return "just now"; if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`; const d = Math.round(h / 24); return `${d} day${d === 1 ? "" : "s"} ago`; };
export const money = (n: number) => `$${Number(n || 0).toLocaleString("en-US")}`;
