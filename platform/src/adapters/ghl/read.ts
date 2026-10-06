import { DateTime } from "luxon";
import { ghl } from "./client";
import type { AppointmentSnapshot, CalendarSnapshot, Company, ContactSnapshot, CrmRead, MessageSnapshot, OppSnapshot, UserSnapshot } from "../types";

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
  async appointmentsInWindow(c, calendarId, from, to) {
    const r = await ghl<{ events: RawEvent[] }>(c.pit, "GET", `/calendars/events?locationId=${c.locationId}&calendarId=${calendarId}&startTime=${from.getTime()}&endTime=${to.getTime()}`);
    return (r.events ?? []).map(mapAppt);
  },
  async inboundSince(c, sinceIso) {
    const r = await ghl<{ conversations: { id: string; contactId: string; lastMessageDate: string | number; lastMessageDirection?: string; lastMessageType?: string }[] }>(
      c.pit, "GET", `/conversations/search?locationId=${c.locationId}&sortBy=last_message_date&sort=desc&limit=50`, { version: "2021-04-15" });   // no direction filter: a human reply after the contact's text must not hide the text
    const since = DateTime.fromISO(sinceIso);
    const out: MessageSnapshot[] = [];
    for (const conv of r.conversations ?? []) {
      const last = typeof conv.lastMessageDate === "number" ? DateTime.fromMillis(conv.lastMessageDate) : DateTime.fromISO(String(conv.lastMessageDate));
      if (last <= since) break;
      const m = await ghl<{ messages: { messages: { id: string; direction: string; messageType: string; body?: string; subject?: string; status?: string; dateAdded: string }[] } }>(
        c.pit, "GET", `/conversations/${conv.id}/messages?limit=20`, { version: "2021-04-15" });
      for (const msg of m.messages?.messages ?? []) {
        if (DateTime.fromISO(msg.dateAdded) <= since) continue;
        out.push({ id: msg.id, conversationId: conv.id, contactId: conv.contactId, channel: msg.messageType === "TYPE_EMAIL" ? "email" : "sms", direction: msg.direction as "inbound" | "outbound", body: msg.messageType === "TYPE_EMAIL" ? undefined : msg.body, subject: msg.subject, status: msg.status, dateAdded: msg.dateAdded });
      }
    }
    return out;
  },
  async opportunitiesSince(c, since) {
    const d = DateTime.fromJSDate(since).toFormat("MM-dd-yyyy");
    const r = await ghl<{ opportunities: { id: string; contact?: { id: string }; pipelineId: string; pipelineStageId: string; status: string; monetaryValue?: number; updatedAt: string }[] }>(c.pit, "GET", `/opportunities/search?location_id=${c.locationId}&date=${d}&limit=100`);
    return (r.opportunities ?? []).map((o) => ({ id: o.id, contactId: o.contact?.id ?? "", pipelineId: o.pipelineId, stageId: o.pipelineStageId, status: o.status, monetaryValue: o.monetaryValue, updatedAt: o.updatedAt }));
  },
  async getAppointment(c, id) {
    try { const r = await ghl<{ appointment?: RawEvent; event?: RawEvent }>(c.pit, "GET", `/calendars/events/appointments/${id}`, { version: "2021-04-15" }); const e = r.appointment ?? r.event; return e ? mapAppt(e) : null; }
    catch (e) { if ((e as { status?: number }).status === 404) return null; throw e; }
  },
  async getContact(c, id) {
    try { const r = await ghl<{ contact: RawContact }>(c.pit, "GET", `/contacts/${id}`); return mapContact(r.contact); }
    catch (e) { if ((e as { status?: number }).status === 404) return null; throw e; }
  },
  async listCalendars(c) {
    const r = await ghl<{ calendars: { id: string; name: string; teamMembers?: { userId: string }[] }[] }>(c.pit, "GET", `/calendars/?locationId=${c.locationId}`);
    return r.calendars.map((k): CalendarSnapshot => ({ id: k.id, name: k.name, teamMemberIds: (k.teamMembers ?? []).map((t) => t.userId) }));
  },
  async listUsers(c) {
    const r = await ghl<{ users: { id: string; email?: string; name?: string; firstName?: string; lastName?: string }[] }>(c.pit, "GET", `/users/?locationId=${c.locationId}`);
    return r.users.map((u): UserSnapshot => ({ id: u.id, email: u.email, name: u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() }));
  },
};
