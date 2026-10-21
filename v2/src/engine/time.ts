import { toInstant, isZone } from "@/workflow/dates";
import { clockMinutes, toMs } from "@/workflow/duration";
import type { RenderEnv } from "@/workflow/filters";
import type { SendWindow } from "@/workflow/definition";
import type { TimeRule } from "@/workflow/primitives/common";
import { type Context, evaluateExpr, resolvePath, wholeExpr } from "@/workflow/template";

/**
 * Clock arithmetic in a named time zone, with the platform's own Intl (no date library): the instant of a local time,
 * a time rule worked out, and the send window applied.
 */

export type LocalParts = { y: number; m: number; d: number; h: number; mi: number; weekday: number };

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function partsIn(at: Date, zone: string): LocalParts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short", hourCycle: "h23" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(at)) p[x.type] = x.value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), weekday: WEEKDAYS[p.weekday!]! };
}

/** How far the zone's clock is ahead of UTC at that instant, in milliseconds. */
function offsetMs(at: Date, zone: string): number {
  const p = partsIn(at, zone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, at.getUTCSeconds());
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant a local clock time names in a zone. A time that does not exist (inside a spring-forward gap) comes out
 * as the same wall time after the jump; a time that exists twice (fall back) as its first occurrence.
 */
export function localToInstant(y: number, m: number, d: number, h: number, mi: number, zone: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off1 = offsetMs(new Date(guess), zone);
  let t = guess - off1;
  const off2 = offsetMs(new Date(t), zone);
  if (off2 !== off1) {
    const t2 = guess - off2;
    const p = partsIn(new Date(t2), zone);
    t = p.h === h && p.mi === mi ? Math.min(t, t2) : Math.max(t, t2);
  }
  return new Date(t);
}

/** The local calendar day `n` days from the one given. */
export function addDays(p: Pick<LocalParts, "y" | "m" | "d">, n: number): { y: number; m: number; d: number; weekday: number } {
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n, 12));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), weekday: ((dt.getUTCDay() + 6) % 7) + 1 };
}

/** That clock time ("08:00") on the local day of `at`, `days` days on. */
export function atClock(at: Date, clock: string, zone: string, days = 0): Date {
  const p = addDays(partsIn(at, zone), days);
  const mins = clockMinutes(clock);
  return localToInstant(p.y, p.m, p.d, Math.floor(mins / 60), mins % 60, zone);
}

/** The zone a contact's dates are read in: theirs when they have a known one, else the offer's. */
export const contactZoneOf = (contact: unknown, offerZone: string): string => {
  const z = (contact as { timezone?: unknown } | undefined)?.timezone;
  return typeof z === "string" && isZone(z) ? z : offerZone;
};

export const windowZone = (w: SendWindow, env: RenderEnv): string => (w.zone === "contact" ? env.contactZone ?? env.offerZone : env.offerZone);

const allowedDay = (w: SendWindow, weekday: number) => !w.days || w.days.includes(weekday);

/** Whether an instant is inside the send window. */
export function inWindow(at: Date, w: SendWindow, zone: string): boolean {
  const p = partsIn(at, zone);
  const mins = p.h * 60 + p.mi;
  return allowedDay(w, p.weekday) && mins >= clockMinutes(w.opens) && mins < clockMinutes(w.closes);
}

/** The window's next opening at or after `at` (`at` itself when it is inside the window). */
export function nextOpen(at: Date, w: SendWindow, zone: string): Date {
  if (inWindow(at, w, zone)) return at;
  const p = partsIn(at, zone);
  const mins = p.h * 60 + p.mi;
  for (let n = 0; n <= 8; n++) {
    const day = addDays(p, n);
    if (!allowedDay(w, day.weekday)) continue;
    if (n === 0 && mins >= clockMinutes(w.opens)) continue;
    const o = clockMinutes(w.opens);
    return localToInstant(day.y, day.m, day.d, Math.floor(o / 60), o % 60, zone);
  }
  throw new Error("the send window has no open day");
}

export type Fitted = { at: Date; moved: "no" | "to_opening" | "earlier_same_day" | "next_open" };

/**
 * Moves a computed time into the send window: before opening, to opening that day; at or after closing, a minute
 * before closing the same day (`earlier_same_day`) or to the next opening (`next_open`); on a day the window is shut,
 * to the next opening.
 */
export function fitSendWindow(at: Date, w: SendWindow, zone: string): Fitted {
  const p = partsIn(at, zone);
  const mins = p.h * 60 + p.mi;
  if (!allowedDay(w, p.weekday)) return { at: nextOpen(at, w, zone), moved: "next_open" };
  if (mins < clockMinutes(w.opens)) return { at: atClock(at, w.opens, zone), moved: "to_opening" };
  if (mins >= clockMinutes(w.closes)) {
    if (w.outside === "next_open") return { at: nextOpen(at, w, zone), moved: "next_open" };
    return { at: new Date(atClock(at, w.closes, zone).getTime() - 60_000), moved: "earlier_same_day" };
  }
  return { at, moved: "no" };
}

/** The instant a time rule's anchor names, or undefined when it is not a date-time. */
export function anchorOf(rule: Pick<TimeRule, "anchor">, ctx: Context, env: RenderEnv): Date | undefined {
  if (rule.anchor === "now") return env.now;
  const whole = wholeExpr(rule.anchor);
  const v = whole ? evaluateExpr(whole, ctx, env).value : resolvePath(ctx, rule.anchor, env);
  return toInstant(v);
}

export type Computed = { at: Date; anchor: Date; usedFallback: boolean; clamped: "no" | "earliest" | "latest" };

/**
 * A time rule worked out: the anchor, shifted by its offset or moved to its day rule's clock time; when the anchor was
 * closer than the guard's minLead at the moment the step was reached (`reached`), `fallback` from then instead; then
 * kept between earliest and latest on that day. Undefined when the anchor is not a date-time.
 */
export function computeTimeRule(rule: TimeRule, ctx: Context, env: RenderEnv, reached: Date): Computed | undefined {
  // "now" is the moment the step was reached, so a wait for "24 hours from now" does not move each time the run wakes
  const anchor = rule.anchor === "now" ? reached : anchorOf(rule, ctx, env);
  if (!anchor) return undefined;
  const zone = rule.zone === "contact" ? env.contactZone ?? env.offerZone : env.offerZone;
  let at = anchor;
  const day = rule.offset ? /^day_(before|of|after)@(\d\d:\d\d)$/.exec(rule.offset) : null;
  if (day) at = atClock(anchor, day[2]!, zone, day[1] === "before" ? -1 : day[1] === "after" ? 1 : 0);
  else if (rule.offset) at = new Date(anchor.getTime() + toMs(rule.offset));
  let usedFallback = false;
  if (rule.guard && rule.anchor !== "now" && anchor.getTime() - reached.getTime() < toMs(rule.guard.minLead)) {
    at = new Date(reached.getTime() + toMs(rule.guard.fallback));
    usedFallback = true;
  }
  let clamped: Computed["clamped"] = "no";
  const p = partsIn(at, zone);
  const mins = p.h * 60 + p.mi;
  if (rule.earliest && mins < clockMinutes(rule.earliest)) { at = atClock(at, rule.earliest, zone); clamped = "earliest"; }
  else if (rule.latest && mins > clockMinutes(rule.latest)) { at = atClock(at, rule.latest, zone); clamped = "latest"; }
  return { at, anchor, usedFallback, clamped };
}

/** The local calendar day of an instant ("2026-10-29") and the instants it starts and ends. */
export function localDay(at: Date, zone: string): { day: string; start: Date; end: Date } {
  const p = partsIn(at, zone);
  const n = addDays(p, 1);
  const day = `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  return { day, start: localToInstant(p.y, p.m, p.d, 0, 0, zone), end: localToInstant(n.y, n.m, n.d, 0, 0, zone) };
}
