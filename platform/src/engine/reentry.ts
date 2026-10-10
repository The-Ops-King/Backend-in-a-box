import type { Definition } from "./definition";

export type ReentryInput = { contactId: string | null; userId?: string | null; appointmentId?: string | null; opportunityId?: string | null; eventId: string | number; now: Date; schedule?: string; suffix?: string };

/** D4: the unique (workflow_id, reentry_key) constraint on runs is what prevents double-texting off two triggers. */
export function reentryKey(def: Pick<Definition, "reentry" | "reentry_window">, i: ReentryInput): string {
  // a schedule fires once per period per subject whatever the policy says: the period is the key
  if (i.schedule) return `schedule:${i.schedule}${i.userId ? `:${i.userId}` : ""}`;
  const base = baseKey(def, i);
  return i.suffix ? `${base}@${i.suffix}` : base;
}
function baseKey(def: Pick<Definition, "reentry" | "reentry_window">, i: ReentryInput): string {
  // a run about a person, not a contact (eod.filed): the policy's "contact" is that person
  const who = i.contactId ? `contact:${i.contactId}` : i.userId ? `user:${i.userId}` : `event:${i.eventId}`;
  switch (def.reentry) {
    case "once_per_contact": return who;
    case "once_per_appointment": return i.appointmentId ? `appointment:${i.appointmentId}` : who;
    case "once_per_opportunity": return i.opportunityId ? `opportunity:${i.opportunityId}` : who;
    case "once_per_contact_per_window":
      // sliding window: startRun checks for a run on this contact inside the window; the key only has to be unique per start
      return `${who}:${i.now.getTime()}`;
    case "always": return `event:${i.eventId}`;
  }
}
export function windowInterval(s: string): string {
  const m = /^(\d+)(h|d|w)$/.exec(s); if (!m) throw new Error(`bad reentry_window ${s}`);
  return `${m[1]} ${{ h: "hours", d: "days", w: "weeks" }[m[2] as "h" | "d" | "w"]}`;
}
