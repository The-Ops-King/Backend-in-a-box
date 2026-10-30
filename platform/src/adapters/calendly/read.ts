import type { AppointmentSnapshot, BookingRead, CalendarConfig, CalendarSnapshot, Company } from "../types";
import { calendly, calendlyAll, calendlyPost, eventUuidOfInvitee, uuidOf } from "./client";

export type RawEventType = { uri: string; name: string; active: boolean; scheduling_url: string; internal_note?: string | null; pooling_type?: string | null; duration: number; custom_questions?: { name: string; type?: string; position?: number; enabled?: boolean; required?: boolean; answer_choices?: string[] }[]; profile?: { type?: string; name?: string; owner?: string } | null };
export type RawEvent = { uri: string; name: string; status: "active" | "canceled"; start_time: string; end_time: string; event_type: string; created_at: string; updated_at: string; event_memberships: { user: string; user_email?: string; user_name?: string }[]; invitees_counter: { total: number; active: number }; location?: { type?: string; join_url?: string | null; location?: string | null; status?: string | null } | null };
export type RawInvitee = { uri: string; email: string; name: string; first_name?: string | null; last_name?: string | null; status: "active" | "canceled"; timezone?: string | null; rescheduled: boolean; old_invitee?: string | null; new_invitee?: string | null; text_reminder_number?: string | null; no_show?: { uri: string; created_at: string } | null; cancellation?: { canceled_by?: string; reason?: string | null; canceler_type?: string; created_at?: string } | null; questions_and_answers?: { question: string; answer: string }[]; reschedule_url?: string | null; cancel_url?: string | null; tracking?: Record<string, string | null> | null; updated_at: string };

const DEFAULT_PHONE_QUESTION = "phone number";
const DEFAULT_SETTER_QUESTION = "setter";
const cfg = (c: Company) => { if (c.booking.source !== "calendly") throw new Error(`company ${c.id} does not book through Calendly`); return c.booking; };

/**
 * Calendly's cancel-then-create reschedule shows up on the invitee: the old one points at `new_invitee`, the new one at `old_invitee`.
 * Questions differ per event type and sit in different orders, so answers are read by question text from the calendar's own
 * config (D24) — `questions: { setter: "Who set this call?", phone: "Best number", hair_loss: "…" }` — falling back to the
 * company-level phone/setter questions. A question text matches on a case-insensitive prefix, so trailing punctuation or a
 * "(required)" suffix on the form does not break it.
 * D198: a phone is taken whatever its question says (Tyler: "fix the engine to take any phone number"). The configured question
 * wins; then a question the event type makes a phone field (`phoneFields`, its labels); then any question whose label says phone.
 */
export function mapEvent(e: RawEvent, inv: RawInvitee | undefined, phoneQuestion = DEFAULT_PHONE_QUESTION, setterQuestion = DEFAULT_SETTER_QUESTION, cal?: CalendarConfig, phoneFields: string[] = []): AppointmentSnapshot {
  const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, " ");
  const answerTo = (label: string) => inv?.questions_and_answers?.find((x) => { const q = norm(x.question), l = norm(label); return q === l || q.startsWith(l); })?.answer?.trim() || undefined;
  const answerWhere = (hit: (question: string) => boolean) => inv?.questions_and_answers?.find((x) => hit(norm(x.question)) && x.answer?.trim())?.answer.trim();
  const q = cal?.questions ?? {};
  const phone = inv?.text_reminder_number || answerTo(q.phone ?? phoneQuestion)
    || answerWhere((x) => phoneFields.some((f) => norm(f) === x)) || answerWhere((x) => /\bphone\b/.test(x));
  const setBy = answerTo(q.setter ?? setterQuestion);
  const answers: Record<string, string> = {};
  for (const [key, label] of Object.entries(q)) { const a = answerTo(label); if (a) answers[key] = a; }
  const [first, ...rest] = (inv?.name ?? "").trim().split(/\s+/);
  const host = e.event_memberships?.[0];
  const status = e.status === "canceled" ? "cancelled" : inv?.no_show ? "noshow" : "confirmed";
  return {
    id: uuidOf(e.uri), calendarId: uuidOf(e.event_type),
    invitee: inv ? { email: inv.email?.trim().toLowerCase() || undefined, phone, firstName: inv.first_name ?? first ?? undefined, lastName: inv.last_name ?? (rest.length ? rest.join(" ") : undefined), timezone: inv.timezone ?? undefined } : undefined,
    assignedUserEmail: host?.user_email?.toLowerCase(), assignedUserId: undefined, setBy, answers: Object.keys(answers).length ? answers : undefined,
    rescheduleUrl: inv?.reschedule_url ?? undefined, cancelUrl: inv?.cancel_url ?? undefined,
    // a conferencing integration's link is join_url; a custom location typed by the host may be a link too (meetingKey ignores one that is not)
    meetingUrl: e.location?.join_url || e.location?.location || undefined,
    meetingFailed: e.location?.status === "failed" ? (e.location.type || "meeting") : undefined,
    cancellation: inv?.cancellation ? { by: inv.cancellation.canceled_by, reason: inv.cancellation.reason ?? undefined, byType: inv.cancellation.canceler_type, at: inv.cancellation.created_at ?? undefined } : undefined,
    // utm_source, utm_medium, utm_campaign, utm_content, utm_term (and any other key Calendly passes, fbclid included), blanks dropped; captured onto the contact by Call booked (D78)
    tracking: inv?.tracking ? Object.fromEntries(Object.entries(inv.tracking).map(([k, v]) => [k, typeof v === "string" ? v.trim() : ""]).filter(([, v]) => v)) : undefined,
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

// D198: the labels of an event type's phone-number questions. A form changes rarely, so this is cached for ten minutes; a failed
// read is no phone fields (the label rules still apply), never a failed poll.
const phoneFieldCache = new Map<string, { at: number; labels: string[] }>();
async function phoneFieldsOf(token: string, eventType: string): Promise<string[]> {
  const hit = phoneFieldCache.get(eventType);
  if (hit && Date.now() - hit.at < 600_000) return hit.labels;
  let labels: string[] = [];
  try { labels = ((await calendly<{ resource: RawEventType }>(token, eventType)).resource.custom_questions ?? []).filter((q) => q.type === "phone_number").map((q) => q.name); }
  catch { return hit?.labels ?? []; }
  if (phoneFieldCache.size > 500) phoneFieldCache.clear();
  phoneFieldCache.set(eventType, { at: Date.now(), labels });
  return labels;
}

// One listing per company per tick serves every event type; cached for a few seconds so the per-calendar calls share it.
const listCache = new Map<string, { at: number; events: RawEvent[] }>();
async function eventsInWindow(c: Company, from: Date, to: Date): Promise<RawEvent[]> {
  const b = cfg(c);
  const key = `${c.id}:${from.toISOString()}:${to.toISOString()}`;
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.events;
  // organization-wide: bookings on every host's calendars; the calendar filter happens in appointmentsInWindow
  const q = new URLSearchParams({ organization: b.organization, min_start_time: from.toISOString(), max_start_time: to.toISOString(), count: "100", sort: "start_time:asc" });
  const events = await calendlyAll<RawEvent>(b.token, `/scheduled_events?${q}`);
  listCache.set(key, { at: Date.now(), events });
  return events;
}

export const calendlyBooking: BookingRead = {
  async listCalendars(c) {
    const b = cfg(c);
    // Round-robin (team) event types are missing from the organization listing (verified), and an offer can have twenty
    // calendars across many hosts, so every member's event types are listed and merged; a type shared by several hosts
    // (round robin) is one calendar with several hosts.
    // `calendly.user` used to scope this to one host; an offer with many hosts needs them all, so every member is listed (D26)
    const members = await calendlyAll<{ user: { uri: string; email: string; name?: string } }>(b.token, `/organization_memberships?organization=${encodeURIComponent(b.organization)}&count=100`);
    const byId = new Map<string, CalendarSnapshot>();
    for (const m of members) {
      let types: RawEventType[] = [];
      try { types = await calendlyAll<RawEventType>(b.token, `/event_types?user=${encodeURIComponent(m.user.uri)}&count=100`); } catch { continue; }   // a deactivated member's listing can 403; the rest still count
      for (const t of types) {
        const id = uuidOf(t.uri); const host = { name: m.user.name ?? m.user.email, email: m.user.email };
        const cur = byId.get(id);
        if (cur) { if (host.email && !cur.hosts?.some((h) => h.email === host.email)) cur.hosts = [...(cur.hosts ?? []), host]; continue; }
        byId.set(id, { id, name: t.name.trim(), teamMemberIds: [], bookingUrl: t.scheduling_url, note: t.internal_note ?? undefined, active: t.active, pooling: t.pooling_type ?? undefined, hosts: host.email ? [host] : [],
          questions: (t.custom_questions ?? []).filter((q) => q.enabled !== false).sort((a, z) => (a.position ?? 0) - (z.position ?? 0)).map((q) => ({ name: q.name, type: q.type, position: q.position, required: q.required, choices: q.answer_choices?.length ? q.answer_choices : undefined })) });
      }
    }
    // D243: a member's own listing also carries team (round robin) types they only own or administer: Calendly listed Mary Emily
    // (team@) under PMU's three round robins whose hosts are Carly and Jose. A shared type's hosts are what Calendly says hosts it;
    // the listing is kept only when that read is refused (the hosts endpoint takes a personal access token)
    // D258: a one-host type shows up under its owner and under every admin who can see it (Tyler, on Taylor's own consultation): the same read decides it
    for (const cal of byId.values()) {
      if (!cal.pooling && (cal.hosts?.length ?? 0) < 2) continue;
      try {
        const ms = await calendlyAll<{ member: { email?: string; name?: string } }>(b.token, `/event_type_memberships?event_type=${encodeURIComponent(`https://api.calendly.com/event_types/${cal.id}`)}&count=100`);
        const hosts = ms.filter((m) => m.member.email).map((m) => ({ name: m.member.name ?? m.member.email!, email: m.member.email! }));
        if (hosts.length) cal.hosts = hosts;
      } catch { /* keep the listing's */ }
    }
    return [...byId.values()].sort((a, z) => a.name.localeCompare(z.name));
  },
  async appointmentsInWindow(c, calendarId, from, to, delta) {
    const b = cfg(c);
    const mine = (await eventsInWindow(c, from, to)).filter((e) => uuidOf(e.event_type) === calendarId);
    const out: AppointmentSnapshot[] = [];
    const seen = new Set<string>();
    for (const e of mine) {
      if (delta) delta.seen[uuidOf(e.uri)] = e.updated_at;
      // D234: unchanged since the last pass that took it in: no invitee read, nothing to apply
      if (delta?.known && delta.known[uuidOf(e.uri)] === e.updated_at) continue;
      const inv = await inviteeOf(b.token, e);
      const snap = mapEvent(e, inv, b.phoneQuestion, b.setterQuestion, b.calendars?.[calendarId], await phoneFieldsOf(b.token, e.event_type));
      out.push(snap); seen.add(snap.id);
      // the replacement of a rescheduled booking may sit outside the window; fetch it so the move happens in the same pass
      if (snap.rescheduledTo && !seen.has(snap.rescheduledTo) && !mine.some((x) => uuidOf(x.uri) === snap.rescheduledTo)) {
        const repl = await calendlyBooking.getAppointment(c, snap.rescheduledTo);
        if (repl && repl.calendarId === calendarId) { out.push(repl); seen.add(repl.id); }
      }
    }
    return out;
  },
  /** D196: Calendly's own cancellation (it tells the invitee); the poll then sees it cancelled like any other. */
  async cancel(c, id, reason) {
    const b = cfg(c);
    await calendlyPost(b.token, `/scheduled_events/${id}/cancellation`, { reason: reason.slice(0, 1000) });
  },
  async getAppointment(c, id) {
    const b = cfg(c);
    try {
      const { resource } = await calendly<{ resource: RawEvent }>(b.token, `/scheduled_events/${id}`);
      return mapEvent(resource, await inviteeOf(b.token, resource), b.phoneQuestion, b.setterQuestion, b.calendars?.[uuidOf(resource.event_type)], await phoneFieldsOf(b.token, resource.event_type));
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
