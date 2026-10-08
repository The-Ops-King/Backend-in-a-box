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
  at = clampToWindow(at, tz, rule.earliest, rule.latest);
  if (at < t.now) at = t.now;
  return { at, usedFallback };
}

/** The wait's own daily window: before `earliest` → that time the same day; after `latest` → that time the same day (the message still goes out the right day, at a human hour). */
export function clampToWindow(at: DateTime, tz: string, earliest?: string, latest?: string): DateTime {
  const local = at.setZone(tz);
  if (earliest) { const [h, m] = earliest.split(":").map(Number); const e = local.set({ hour: h, minute: m, second: 0, millisecond: 0 }); if (local < e) return e; }
  if (latest) { const [h, m] = latest.split(":").map(Number); const l = local.set({ hour: h, minute: m, second: 0, millisecond: 0 }); if (local > l) return l; }
  return at;
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
