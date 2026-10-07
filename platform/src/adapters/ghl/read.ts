import { DateTime } from "luxon";
import { ghl, GhlError } from "./client";
import type { AppointmentSnapshot, BookingRead, CalendarSnapshot, CallMedia, ContactSnapshot, CrmRead, MessageSnapshot, OppSnapshot, UserSnapshot } from "../types";

type RawContact = { id: string; firstName?: string; lastName?: string; email?: string; phone?: string; timezone?: string; tags?: string[]; customFields?: { id: string; value: unknown }[]; dateUpdated: string; dateAdded: string };
const mapContact = (c: RawContact): ContactSnapshot => ({
  id: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, timezone: c.timezone,
  tags: c.tags ?? [], customFields: Object.fromEntries((c.customFields ?? []).map((f) => [f.id, f.value])),
  dateUpdated: c.dateUpdated, dateAdded: c.dateAdded,
});
type RawEvent = { id: string; calendarId: string; contactId: string; assignedUserId?: string; startTime: string; endTime: string; appointmentStatus: string; title?: string; dateUpdated?: string; dateAdded?: string };
const mapAppt = (e: RawEvent): AppointmentSnapshot => ({ id: e.id, calendarId: e.calendarId, contactId: e.contactId, assignedUserId: e.assignedUserId, startTime: e.startTime, endTime: e.endTime, status: e.appointmentStatus, title: e.title, dateUpdated: e.dateUpdated, dateAdded: e.dateAdded, raw: e as unknown as Record<string, unknown> });

export const ghlRead: CrmRead = {
  async contactsChangedSince(c, sinceIso) {
    const out: ContactSnapshot[] = [];
    let page = 1;
    for (;;) {
      const r = await ghl<{ contacts: RawContact[]; total: number }>(c.pit, "POST", "/contacts/search", {
        body: { locationId: c.locationId, page, pageLimit: 100, filters: [{ field: "dateUpdated", operator: "range", value: { gte: sinceIso } }], sort: [{ field: "dateUpdated", direction: "asc" }] },
      });
      out.push(...r.contacts.map(mapContact));
      if (r.contacts.length < 100 || out.length >= 2000) break;
      page++;
    }
    return out;
  },
  async inboundSince(c, sinceIso) {
    const r = await ghl<{ conversations: { id: string; contactId: string; lastMessageDate: string | number; lastMessageDirection?: string; lastMessageType?: string }[] }>(
      c.pit, "GET", `/conversations/search?locationId=${c.locationId}&sortBy=last_message_date&sort=desc&limit=50`, { version: "2021-04-15" });   // no direction filter: a human reply after the contact's text must not hide the text
    const since = DateTime.fromISO(sinceIso);
    const out: MessageSnapshot[] = [];
    for (const conv of r.conversations ?? []) {
      const last = typeof conv.lastMessageDate === "number" ? DateTime.fromMillis(conv.lastMessageDate) : DateTime.fromISO(String(conv.lastMessageDate));
      if (last <= since) break;
      const m = await ghl<{ messages: { messages: { id: string; direction: string; messageType: string; body?: string; subject?: string; status?: string; dateAdded: string; userId?: string; meta?: { call?: { status?: string; duration?: number } } }[] } }>(
        c.pit, "GET", `/conversations/${conv.id}/messages?limit=20`, { version: "2021-04-15" });
      for (const msg of m.messages?.messages ?? []) {
        if (DateTime.fromISO(msg.dateAdded) <= since) continue;
        const type = msg.messageType ?? "";
        if (/^TYPE_ACTIVITY/.test(type)) continue;   // "opportunity moved", "appointment booked" entries are the CRM talking to itself, not the contact
        const base = { id: msg.id, conversationId: conv.id, contactId: conv.contactId, direction: msg.direction as "inbound" | "outbound", status: msg.status, dateAdded: msg.dateAdded };
        if (type === "TYPE_CALL") { const call = msg.meta?.call ?? {}; out.push({ ...base, channel: "call", call: { status: String(call.status ?? msg.status ?? ""), durationSec: typeof call.duration === "number" ? call.duration : undefined, userId: msg.userId } }); continue; }
        out.push({ ...base, channel: type === "TYPE_EMAIL" ? "email" : "sms", body: type === "TYPE_EMAIL" ? undefined : msg.body, subject: msg.subject });
      }
    }
    return out;
  },
  /**
   * Transcription is the proof a recording exists: GHL answers 400 CONVERSATIONS_MSG_RECORDING_NOT_FOUND for a call that was
   * not recorded, and the recording endpoint itself streams the whole WAV (no HEAD), so it is never probed. Verified 2026-10-07:
   * the body is an array of {speaker, transcript, startTime, endTime} segments; speaker is 0 (the dialer's side) or 1.
   */
  async callMedia(c, messageId): Promise<CallMedia | null> {
    type Seg = { speaker?: number | string; transcript?: string; text?: string; startTime?: number };
    let segs: Seg[];
    try { const r = await ghl<Seg[] | { transcription?: Seg[]; transcript?: string }>(c.pit, "GET", `/conversations/locations/${c.locationId}/messages/${messageId}/transcription`, { version: "2021-04-15" });
      segs = Array.isArray(r) ? r : Array.isArray(r?.transcription) ? r.transcription : typeof r?.transcript === "string" ? [{ speaker: 0, transcript: r.transcript }] : []; }
    catch (e) { if (e instanceof GhlError && (e.status === 400 || e.status === 404 || e.status === 422)) return { transcript: null }; throw e; }
    const transcript = segs.map((s) => ({ speaker: String(s.speaker ?? "?"), text: String(s.transcript ?? s.text ?? "").trim(), ...(typeof s.startTime === "number" ? { timestamp: `${Math.floor(s.startTime / 60)}:${String(Math.floor(s.startTime % 60)).padStart(2, "0")}` } : {}) })).filter((s) => s.text);
    if (!transcript.length) return { transcript: null };
    return { recordingUrl: `https://services.leadconnectorhq.com/conversations/messages/${messageId}/locations/${c.locationId}/recording`, transcript };
  },
  async opportunitiesSince(c, since) {
    const d = DateTime.fromJSDate(since).toFormat("MM-dd-yyyy");
    const r = await ghl<{ opportunities: { id: string; contact?: { id: string }; pipelineId: string; pipelineStageId: string; status: string; monetaryValue?: number; updatedAt: string }[] }>(c.pit, "GET", `/opportunities/search?location_id=${c.locationId}&date=${d}&limit=100`);
    return (r.opportunities ?? []).map((o) => ({ id: o.id, contactId: o.contact?.id ?? "", pipelineId: o.pipelineId, stageId: o.pipelineStageId, status: o.status, monetaryValue: o.monetaryValue, updatedAt: o.updatedAt }));
  },
  async getContact(c, id) {
    try { const r = await ghl<{ contact: RawContact }>(c.pit, "GET", `/contacts/${id}`); return mapContact(r.contact); }
    catch (e) { if ((e as { status?: number }).status === 404) return null; throw e; }
  },
  async listUsers(c) {
    const r = await ghl<{ users: { id: string; email?: string; name?: string; firstName?: string; lastName?: string }[] }>(c.pit, "GET", `/users/?locationId=${c.locationId}`);
    return r.users.map((u): UserSnapshot => ({ id: u.id, email: u.email, name: u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() }));
  },
};

/** GHL calendars as a booking source. Same PIT, same location. */
export const ghlBooking: BookingRead = {
  async appointmentsInWindow(c, calendarId, from, to) {
    const r = await ghl<{ events: RawEvent[] }>(c.pit, "GET", `/calendars/events?locationId=${c.locationId}&calendarId=${calendarId}&startTime=${from.getTime()}&endTime=${to.getTime()}`);
    return (r.events ?? []).map(mapAppt);
  },
  async getAppointment(c, id) {
    try { const r = await ghl<{ appointment?: RawEvent; event?: RawEvent }>(c.pit, "GET", `/calendars/events/appointments/${id}`, { version: "2021-04-15" }); const e = r.appointment ?? r.event; return e ? mapAppt(e) : null; }
    catch (e) { if ((e as { status?: number }).status === 404) return null; throw e; }
  },
  async listCalendars(c) {
    const r = await ghl<{ calendars: { id: string; name: string; teamMembers?: { userId: string }[] }[] }>(c.pit, "GET", `/calendars/?locationId=${c.locationId}`);
    return r.calendars.map((k): CalendarSnapshot => ({ id: k.id, name: k.name, teamMemberIds: (k.teamMembers ?? []).map((t) => t.userId) }));
  },
};
