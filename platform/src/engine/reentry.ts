import type { Definition } from "./definition";

export type ReentryInput = { contactId: string; appointmentId?: string | null; opportunityId?: string | null; eventId: string | number; now: Date };

/** D4: the unique (workflow_id, reentry_key) constraint on runs is what prevents double-texting off two triggers. */
export function reentryKey(def: Pick<Definition, "reentry" | "reentry_window">, i: ReentryInput): string {
  switch (def.reentry) {
    case "once_per_contact": return `contact:${i.contactId}`;
    case "once_per_appointment": return i.appointmentId ? `appointment:${i.appointmentId}` : `contact:${i.contactId}`;
    case "once_per_opportunity": return i.opportunityId ? `opportunity:${i.opportunityId}` : `contact:${i.contactId}`;
    case "once_per_contact_per_window":
      // sliding window: startRun checks for a run on this contact inside the window; the key only has to be unique per start
      return `contact:${i.contactId}:${i.now.getTime()}`;
    case "always": return `event:${i.eventId}`;
  }
}
export function windowInterval(s: string): string {
  const m = /^(\d+)(h|d|w)$/.exec(s); if (!m) throw new Error(`bad reentry_window ${s}`);
  return `${m[1]} ${{ h: "hours", d: "days", w: "weeks" }[m[2] as "h" | "d" | "w"]}`;
}
