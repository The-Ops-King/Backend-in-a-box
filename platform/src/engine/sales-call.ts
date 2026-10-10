import { DateTime } from "luxon";

/**
 * A Sales Call's start: an ISO stamp, or the display text an outside integration writes ("Mon Oct 5 · 10:00 AM EDT") read
 * on the record's call_date in the company's zone, trusted only when its zone abbreviation is the company zone's on that
 * day. Null when neither holds: the record then matches by person and day.
 */
export function callTime(v: unknown, day: DateTime | null, tz: string): DateTime | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { const d = DateTime.fromISO(s); return d.isValid ? d.setZone(tz) : null; }
  const m = /(\d{1,2}):(\d{2})\s*([AP]M)\s*([A-Z]{2,5})?\s*$/i.exec(s);
  if (!m || !day) return null;
  const h = (Number(m[1]) % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0);
  const at = day.set({ hour: h, minute: Number(m[2]), second: 0, millisecond: 0 });
  return !m[4] || at.toFormat("ZZZZ").toUpperCase() === m[4].toUpperCase() ? at : null;
}

/**
 * What the engine writes on a Sales Call's `outcome`, in the company's own option keys: the inverse of `sales_call.outcomes`
 * (value → meaning), so no write sends an option the CRM's picklist lacks. A key spelled as the engine's own meaning
 * ("noshow") is an alias kept to read the engine's older writes; the company's own spelling ("no_show") wins. Of the keys
 * meaning cancelled, the one spelled "cancelled" is a cancel before the call; another ("late_cancel") is a cancel on the
 * call. `rescheduled` is the slot a moved call left (D76). "Rescheduled / cancelled on the call" from the end-of-day form
 * (`on_call`) is the key meaning rescheduled, else that late cancel. A meaning the map has no key for is "": the step leaves
 * the field alone. No map at all: the engine's own words.
 */
export type SalesCallValues = { scheduled: string; showed: string; noshow: string; cancelled: string; late_cancel: string; rescheduled: string; on_call: string };
export function salesCallValues(bindings: Record<string, string>): SalesCallValues {
  let map: Record<string, unknown> = {};
  try { const j = JSON.parse(bindings["sales_call.outcomes"] ?? "{}") as unknown; if (j && typeof j === "object" && !Array.isArray(j)) map = j as Record<string, unknown>; } catch { map = {}; }
  if (!Object.keys(map).length) return { scheduled: "scheduled", showed: "showed", noshow: "noshow", cancelled: "cancelled", late_cancel: "cancelled", rescheduled: "rescheduled", on_call: "rescheduled" };
  const norm = (k: string) => k.trim().toLowerCase();
  const keys = (meaning: string) => Object.entries(map).filter(([, v]) => v === meaning).map(([k]) => k.trim()).filter(Boolean);
  const own = (meaning: string) => { const ks = keys(meaning); return ks.find((k) => norm(k) !== meaning) ?? ks[0] ?? ""; };
  const cancels = keys("cancelled"), plain = cancels.find((k) => norm(k) === "cancelled") ?? cancels[0] ?? "", late = cancels.find((k) => k !== plain) ?? plain;
  const moved = keys("rescheduled")[0] ?? "";
  return { scheduled: keys("scheduled")[0] ?? "", showed: own("showed"), noshow: own("noshow"), cancelled: plain, late_cancel: late, rescheduled: moved, on_call: moved || late };
}

/** The company's option keys for how a call was booked (`sales_call.booking_sources`, e.g. {"setter":"setter_set","self":"self_booked"}); empty when unbound, so nothing is written. */
export function bookingSourceValues(bindings: Record<string, string>): { setter: string; self: string } {
  try { const j = JSON.parse(bindings["sales_call.booking_sources"] ?? "{}") as Record<string, unknown>; return { setter: typeof j.setter === "string" ? j.setter : "", self: typeof j.self === "string" ? j.self : "" }; }
  catch { return { setter: "", self: "" }; }
}

/** The meaning a Sales Call's own outcome value carries by the company's map (`sales_call.outcomes`): null when blank or unmapped ("scheduled"), i.e. nobody filed it. */
export function filedMeaning(outcome: unknown, bindings: Record<string, string>): string | null {
  const v = String(Array.isArray(outcome) ? outcome.join(", ") : outcome ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!v) return null;
  let map: Record<string, unknown> = {};
  try { map = JSON.parse(bindings["sales_call.outcomes"] ?? "{}") as Record<string, unknown>; } catch { map = {}; }
  const hit = Object.entries(map).find(([k]) => k.trim().toLowerCase() === v)?.[1];
  return typeof hit === "string" && ["showed", "noshow", "cancelled", "rescheduled"].includes(hit) ? hit : null;
}
