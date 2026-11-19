import { DateTime } from "luxon";
import type { WaitRule } from "./definition";
import { parseDuration, resolvePath } from "./template";

export type TimeCtx = { now: DateTime; contactTz: string; companyTz: string; ctx: Record<string, unknown> };

function anchorOf(rule: WaitRule, t: TimeCtx): DateTime {
  if (rule.anchor === "now") return t.now;
  const v = resolvePath(t.ctx, rule.anchor);
  const dt = typeof v === "string" ? DateTime.fromISO(v) : v instanceof Date ? DateTime.fromJSDate(v) : DateTime.invalid("x");
  if (!dt.isValid) throw new Error(`wait anchor ${rule.anchor} is not a datetime`);
  return dt;
}

function applyOffset(anchor: DateTime, offset: string, tz: string): DateTime {
  const m = /^(day_of|day_before|day_after)@(\d{2}):(\d{2})$/.exec(offset);
  if (m) {
    const base = anchor.setZone(tz).startOf("day").plus({ days: m[1] === "day_before" ? -1 : m[1] === "day_after" ? 1 : 0 });
    return base.set({ hour: +m[2], minute: +m[3] });
  }
  return anchor.plus(parseDuration(offset));
}

/** D14: anchor + offset in a timezone, with a guarded fallback. Never returns a time in the past. */
export function computeWaitUntil(rule: WaitRule, t: TimeCtx): { at: DateTime; usedFallback: boolean } {
  const tz = rule.tz === "company" ? t.companyTz : t.contactTz;
  const anchor = anchorOf(rule, t);
  let at = applyOffset(anchor, rule.offset, tz);
  let usedFallback = false;
  if (rule.guard && rule.anchor !== "now") {
    const minLead = parseDuration(rule.guard.min_lead);
    if (at > anchor.minus(minLead)) { at = applyOffset(anchor, rule.guard.fallback, tz); usedFallback = true; }
  }
  const forward = rule.after_latest === "next_day" || !!rule.skip_days?.length || !!rule.skip_holidays;
  at = forward ? permittedTime(at, tz, rule) : clampToWindow(at, tz, rule.earliest, rule.latest);
  if (at < t.now) at = forward ? permittedTime(t.now, tz, rule) : t.now;
  return { at, usedFallback };
}

const hm = (s: string) => s.split(":").map(Number) as [number, number];
/**
 * D351: the first moment at or after `at` that is a permitted time: inside [earliest, latest] (after `latest`: the next day's
 * `earliest` when `after_latest` is next_day, else back to `latest` as clampToWindow does), on a day that is neither in
 * `skip_days` nor, with `skip_holidays`, a US federal holiday (observed). A skipped day moves to the next one at `earliest`.
 */
export function permittedTime(at: DateTime, tz: string, rule: Pick<WaitRule, "earliest" | "latest" | "after_latest" | "skip_days" | "skip_holidays">): DateTime {
  let local: DateTime = at.setZone(tz) as DateTime;
  const startOf = (d: DateTime): DateTime => (rule.earliest ? d.set({ hour: hm(rule.earliest)[0], minute: hm(rule.earliest)[1], second: 0, millisecond: 0 }) : d.startOf("day"));
  for (let i = 0; i < 31; i++) {
    if (rule.earliest && local < startOf(local)) local = startOf(local);
    if (rule.latest) {
      const close = local.set({ hour: hm(rule.latest)[0], minute: hm(rule.latest)[1], second: 0, millisecond: 0 });
      if (local > close) { if (rule.after_latest === "next_day") { local = startOf(local.plus({ days: 1 })); continue; } local = close; }
    }
    const skip = rule.skip_days?.includes(local.weekday) || (rule.skip_holidays === "us_federal" && isUsFederalHoliday(local));
    if (!skip) return local;
    local = startOf(local.plus({ days: 1 }));
  }
  return local;
}

/** US federal holidays: each on its date and, when that is a weekend, its observed weekday (Friday before / Monday after), for the date in its own zone. */
export function isUsFederalHoliday(d: DateTime): boolean {
  const key = d.toFormat("yyyy-MM-dd");
  return [d.year - 1, d.year, d.year + 1].some((y) => usFederalHolidays(y).has(key));
}
const holidayCache = new Map<number, Set<string>>();
export function usFederalHolidays(year: number): Set<string> {
  const hit = holidayCache.get(year); if (hit) return hit;
  const nth = (month: number, weekday: number, n: number) => { let d = DateTime.utc(year, month, 1); while (d.weekday !== weekday) d = d.plus({ days: 1 }); return d.plus({ weeks: n - 1 }); };
  const last = (month: number, weekday: number) => { let d = DateTime.utc(year, month, 1).endOf("month").startOf("day"); while (d.weekday !== weekday) d = d.minus({ days: 1 }); return d; };
  const observed = (d: DateTime) => (d.weekday === 6 ? d.minus({ days: 1 }) : d.weekday === 7 ? d.plus({ days: 1 }) : d);
  // a fixed-date holiday is skipped both on its own date and on the weekday it is observed (July 4th on a Saturday: Fri 3 and Sat 4)
  const fixed = [[1, 1], [6, 19], [7, 4], [11, 11], [12, 25]].flatMap(([m, d]) => { const x = DateTime.utc(year, m, d); return [x, observed(x)]; });
  const days = [...fixed, nth(1, 1, 3), nth(2, 1, 3), last(5, 1), nth(9, 1, 1), nth(10, 1, 2), nth(11, 4, 4)];
  const out = new Set(days.map((d) => d.toFormat("yyyy-MM-dd")));
  holidayCache.set(year, out); return out;
}

/** The wait's own daily window: before `earliest` → that time the same day; after `latest` → that time the same day (the message still goes out the right day, at a human hour). */
export function clampToWindow(at: DateTime, tz: string, earliest?: string, latest?: string): DateTime {
  const local = at.setZone(tz);
  if (earliest) { const [h, m] = earliest.split(":").map(Number); const e = local.set({ hour: h, minute: m, second: 0, millisecond: 0 }); if (local < e) return e; }
  if (latest) { const [h, m] = latest.split(":").map(Number); const l = local.set({ hour: h, minute: m, second: 0, millisecond: 0 }); if (local > l) return l; }
  return at;
}

/** D193: a time at or after the window's close that day moves back to a minute before it closes; any other time is left as it is. */
export function pullBackIntoWindow(at: DateTime, tz: string, start: string, end: string): DateTime {
  const local = at.setZone(tz);
  const [sh, sm] = start.split(":").map(Number), [eh, em] = end.split(":").map(Number);
  const open = local.set({ hour: sh, minute: sm, second: 0, millisecond: 0 }), close = local.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  return local >= close && close > open ? close.minus({ minutes: 1 }) : at;
}

/** D5d: send window. Returns the same instant if inside the window, else the next opening — always forward. */
export function deferIntoWindow(at: DateTime, tz: string, start: string, end: string): { at: DateTime; deferred: boolean } {
  const local = at.setZone(tz);
  const [sh, sm] = start.split(":").map(Number), [eh, em] = end.split(":").map(Number);
  const open = local.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  const close = local.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  if (local >= open && local < close) return { at, deferred: false };
  if (local < open) return { at: open, deferred: true };
  return { at: open.plus({ days: 1 }), deferred: true };
}

/** A time a step is given as text (D85): an ISO time or "now", either with an offset ("<time> +30m"), or an offset alone from now ("-7d"). Null when blank or unreadable. */
export function timeParam(v: unknown, now: DateTime): DateTime | null {
  if (v instanceof Date) return DateTime.fromJSDate(v);
  if (typeof v !== "string" || !v.trim()) return null;
  const m = /^(.*?)\s*([+-]\s*\d+\s*[smhdw])?$/.exec(v.trim())!;
  const base = !m[1] || m[1] === "now" ? now : DateTime.fromISO(m[1], { setZone: true });
  if (!base.isValid) return null;
  return m[2] ? base.plus(parseDuration(m[2].replace(/\s+/g, ""))) : base;
}
