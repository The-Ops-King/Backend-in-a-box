import type { Definition } from "./definition";

export type ReentryInput = { contactId: string; appointmentId?: string | null; opportunityId?: string | null; eventId: string | number; now: Date };

/** D4: the unique (workflow_id, reentry_key) constraint on runs is what prevents double-texting off two triggers. */
export function reentryKey(def: Pick<Definition, "reentry" | "reentry_window">, i: ReentryInput): string {
  switch (def.reentry) {
    case "once_per_contact": return `contact:${i.contactId}`;
    case "once_per_appointment": return i.appointmentId ? `appointment:${i.appointmentId}` : `contact:${i.contactId}`;
    case "once_per_opportunity": return i.opportunityId ? `opportunity:${i.opportunityId}` : `contact:${i.contactId}`;
    case "once_per_contact_per_window": {
      const ms = windowMs(def.reentry_window ?? "90d");
      return `contact:${i.contactId}:w${Math.floor(i.now.getTime() / ms)}`;
    }
    case "always": return `event:${i.eventId}`;
  }
}
function windowMs(s: string): number {
  const m = /^(\d+)(h|d|w)$/.exec(s); if (!m) throw new Error(`bad reentry_window ${s}`);
  return +m[1] * { h: 3600e3, d: 86400e3, w: 604800e3 }[m[2] as "h" | "d" | "w"];
}
