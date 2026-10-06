import type { AppointmentSnapshot, BookingRead, CalendarSnapshot, Company } from "../types";
import { calendly, calendlyAll, eventUuidOfInvitee, uuidOf } from "./client";

export type RawEventType = { uri: string; name: string; active: boolean; scheduling_url: string; internal_note?: string | null; pooling_type?: string | null; duration: number };
export type RawEvent = { uri: string; name: string; status: "active" | "canceled"; start_time: string; end_time: string; event_type: string; created_at: string; updated_at: string; event_memberships: { user: string; user_email?: string; user_name?: string }[]; invitees_counter: { total: number; active: number } };
export type RawInvitee = { uri: string; email: string; name: string; first_name?: string | null; last_name?: string | null; status: "active" | "canceled"; timezone?: string | null; rescheduled: boolean; old_invitee?: string | null; new_invitee?: string | null; text_reminder_number?: string | null; no_show?: { uri: string; created_at: string } | null; questions_and_answers?: { question: string; answer: string }[]; reschedule_url?: string | null; cancel_url?: string | null; tracking?: Record<string, string | null> | null; updated_at: string };

const DEFAULT_PHONE_QUESTION = "phone number";
const DEFAULT_SETTER_QUESTION = "setter";
const cfg = (c: Company) => { if (c.booking.source !== "calendly") throw new Error(`company ${c.id} does not book through Calendly`); return c.booking; };

/** Calendly's cancel-then-create reschedule shows up on the invitee: the old one points at `new_invitee`, the new one at `old_invitee`. */
export function mapEvent(e: RawEvent, inv: RawInvitee | undefined, phoneQuestion = DEFAULT_PHONE_QUESTION, setterQuestion = DEFAULT_SETTER_QUESTION): AppointmentSnapshot {
  const answerTo = (label: string) => inv?.questions_and_answers?.find((x) => x.question.trim().toLowerCase() === label.trim().toLowerCase())?.answer?.trim() || undefined;
  const phone = inv?.text_reminder_number || answerTo(phoneQuestion);
  const setBy = answerTo(setterQuestion);
  const [first, ...rest] = (inv?.name ?? "").trim().split(/\s+/);
  const host = e.event_memberships?.[0];
  const status = e.status === "canceled" ? "cancelled" : inv?.no_show ? "noshow" : "confirmed";
  return {
    id: uuidOf(e.uri), calendarId: uuidOf(e.event_type),
    invitee: inv ? { email: inv.email?.trim().toLowerCase() || undefined, phone, firstName: inv.first_name ?? first ?? undefined, lastName: inv.last_name ?? (rest.length ? rest.join(" ") : undefined), timezone: inv.timezone ?? undefined } : undefined,
    assignedUserEmail: host?.user_email?.toLowerCase(), assignedUserId: undefined, setBy,
    rescheduleUrl: inv?.reschedule_url ?? undefined, cancelUrl: inv?.cancel_url ?? undefined,
    tracking: inv?.tracking ? Object.fromEntries(Object.entries(inv.tracking).filter((kv): kv is [string, string] => !!kv[1])) : undefined,
    startTime: e.start_time, endTime: e.end_time, status, title: e.name,
    dateUpdated: inv && inv.updated_at > e.updated_at ? inv.updated_at : e.updated_at, dateAdded: e.created_at,
    rescheduledFrom: inv?.old_invitee ? eventUuidOfInvitee(inv.old_invitee) : undefined,
    rescheduledTo: e.status === "canceled" && inv?.rescheduled && inv.new_invitee ? eventUuidOfInvitee(inv.new_invitee) : undefined,
    raw: { event: e, invitee: inv } as unknown as Record<string, unknown>,
  };
}

// Invitee data is one request per event. An event's invitee only changes when the event does, so the lookup is cached
// by (event uri, updated_at). A fresh serverless instance refetches once, then settles.
const inviteeCache = new Map<string, RawInvitee | undefined>();
async function inviteeOf(token: string, e: RawEvent): Promise<RawInvitee | undefined> {
  const key = `${e.uri}@${e.updated_at}`;
  if (inviteeCache.has(key)) return inviteeCache.get(key);
  const list = await calendlyAll<RawInvitee>(token, `${e.uri}/invitees?count=10`);
  const inv = list.find((i) => i.status === "active") ?? list[0];   // the one who is still coming; a lone cancelled invitee carries the reschedule pointer
  if (inviteeCache.size > 5000) inviteeCache.clear();
  inviteeCache.set(key, inv);
  return inv;
}

// One listing per company per tick serves every event type; cached for a few seconds so the per-calendar calls share it.
const listCache = new Map<string, { at: number; events: RawEvent[] }>();
async function eventsInWindow(c: Company, from: Date, to: Date): Promise<RawEvent[]> {
  const b = cfg(c);
  const key = `${c.id}:${from.toISOString()}:${to.toISOString()}`;
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.events;
  const q = new URLSearchParams({ organization: b.organization, min_start_time: from.toISOString(), max_start_time: to.toISOString(), count: "100", sort: "start_time:asc" });
  if (b.user) q.set("user", b.user);
  const events = await calendlyAll<RawEvent>(b.token, `/scheduled_events?${q}`);
  listCache.set(key, { at: Date.now(), events });
  return events;
}

export const calendlyBooking: BookingRead = {
  async listCalendars(c) {
    const b = cfg(c);
    // Round-robin (team) event types are missing from the organization listing (verified); listing by user includes them.
    const path = b.user ? `/event_types?user=${encodeURIComponent(b.user)}&count=100` : `/event_types?organization=${encodeURIComponent(b.organization)}&count=100`;
    return (await calendlyAll<RawEventType>(b.token, path)).map((t): CalendarSnapshot => ({ id: uuidOf(t.uri), name: t.name.trim(), teamMemberIds: [], bookingUrl: t.scheduling_url, note: t.internal_note ?? undefined, active: t.active }));
  },
  async appointmentsInWindow(c, calendarId, from, to) {
    const b = cfg(c);
    const mine = (await eventsInWindow(c, from, to)).filter((e) => uuidOf(e.event_type) === calendarId);
    const out: AppointmentSnapshot[] = [];
    const seen = new Set<string>();
    for (const e of mine) {
      const inv = await inviteeOf(b.token, e);
      const snap = mapEvent(e, inv, b.phoneQuestion, b.setterQuestion);
      out.push(snap); seen.add(snap.id);
      // the replacement of a rescheduled booking may sit outside the window; fetch it so the move happens in the same pass
      if (snap.rescheduledTo && !seen.has(snap.rescheduledTo) && !mine.some((x) => uuidOf(x.uri) === snap.rescheduledTo)) {
        const repl = await calendlyBooking.getAppointment(c, snap.rescheduledTo);
        if (repl && repl.calendarId === calendarId) { out.push(repl); seen.add(repl.id); }
      }
    }
    return out;
  },
  async getAppointment(c, id) {
    const b = cfg(c);
    try {
      const { resource } = await calendly<{ resource: RawEvent }>(b.token, `/scheduled_events/${id}`);
      return mapEvent(resource, await inviteeOf(b.token, resource), b.phoneQuestion, b.setterQuestion);
    } catch (e) { if ((e as { status?: number }).status === 404) return null; throw e; }
  },
};

/** Install-time helpers: who the token belongs to, and the org member a host email resolves to. */
export async function calendlyWhoAmI(token: string): Promise<{ user: string; organization: string; email: string; name: string }> {
  const { resource } = await calendly<{ resource: { uri: string; current_organization: string; email: string; name: string } }>(token, "/users/me");
  return { user: resource.uri, organization: resource.current_organization, email: resource.email, name: resource.name };
}
export async function calendlyUserByEmail(token: string, organization: string, email: string): Promise<string | undefined> {
  const members = await calendlyAll<{ user: { uri: string; email: string } }>(token, `/organization_memberships?organization=${encodeURIComponent(organization)}&count=100`);
  return members.find((m) => m.user.email.toLowerCase() === email.trim().toLowerCase())?.user.uri;
}
