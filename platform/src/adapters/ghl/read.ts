import { DateTime } from "luxon";
import { ghl, GhlError } from "./client";
import type { AppointmentSnapshot, Attribution, BookingRead, CalendarSnapshot, CallMedia, ContactSnapshot, CrmRead, DocumentSnapshot, LiveCard, MessageSnapshot, ObjectRecord, OppSnapshot, Touch, UserSnapshot, WonOpportunity } from "../types";

type RawTouch = Record<string, unknown> & { isFirst?: boolean; isLast?: boolean };
export type RawContact = { id: string; firstName?: string; lastName?: string; email?: string; phone?: string; timezone?: string; assignedTo?: string | null; tags?: string[]; source?: string; customFields?: { id: string; value: unknown }[]; dateUpdated: string; dateAdded: string;
  attributionSource?: RawTouch | null; lastAttributionSource?: RawTouch | null; attributions?: RawTouch[] | null };
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
function mapTouch(t: RawTouch | null | undefined): Touch | undefined {
  if (!t || typeof t !== "object") return undefined;
  const out: Touch = { utmSource: str(t.utmSource), utmMedium: str(t.utmMedium), utmCampaign: str(t.campaign) ?? str(t.utmCampaign), utmContent: str(t.utmContent), utmTerm: str(t.utmTerm) ?? str(t.utmKeyword),
    fbclid: str(t.fbclid), medium: str(t.medium), sessionSource: str(t.sessionSource), url: str(t.url), referrer: str(t.referrer) };
  const kept = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Touch;
  return Object.keys(kept).length ? kept : undefined;
}
/** GHL's first touch (`attributionSource`) and latest touch (`lastAttributionSource`); the list form (`attributions`, flagged isFirst / isLast) when only that is sent. Keys verified in ghl/02-api-facts.md. */
export function mapAttribution(c: Pick<RawContact, "attributionSource" | "lastAttributionSource" | "attributions">): Attribution | undefined {
  const list = Array.isArray(c.attributions) ? c.attributions.filter((t) => t && typeof t === "object") : [];
  const first = mapTouch(c.attributionSource ?? list.find((t) => t.isFirst) ?? list[0]);
  const last = mapTouch(c.lastAttributionSource ?? list.find((t) => t.isLast) ?? (list.length > 1 ? list[list.length - 1] : undefined));
  return first || last ? { ...(first ? { first } : {}), ...(last ? { last } : {}) } : undefined;
}
export const mapContact = (c: RawContact): ContactSnapshot => {
  const attribution = mapAttribution(c);
  return {
    id: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, timezone: c.timezone, assignedTo: c.assignedTo ?? undefined,
    tags: c.tags ?? [], ...(c.source ? { source: c.source } : {}), customFields: Object.fromEntries((c.customFields ?? []).map((f) => [f.id, f.value])),
    dateUpdated: c.dateUpdated, dateAdded: c.dateAdded, ...(attribution ? { attribution } : {}),
  };
};
type RawEvent = { id: string; calendarId: string; contactId: string; assignedUserId?: string; startTime: string; endTime: string; appointmentStatus: string; title?: string; dateUpdated?: string; dateAdded?: string };
const mapAppt = (e: RawEvent): AppointmentSnapshot => ({ id: e.id, calendarId: e.calendarId, contactId: e.contactId, assignedUserId: e.assignedUserId, startTime: e.startTime, endTime: e.endTime, status: e.appointmentStatus, title: e.title, dateUpdated: e.dateUpdated, dateAdded: e.dateAdded, raw: e as unknown as Record<string, unknown> });

type RawOpp = { id: string; contact?: { id: string }; contactId?: string; pipelineId: string; pipelineStageId: string; status: string; name?: string; assignedTo?: string | null; updatedAt: string; lastStageChangeAt?: string; updatedBy?: string; lastStageChangeBy?: string };
// the stage-change stamp outranks updatedAt when the CRM gives both: a note or a field edit also bumps updatedAt
const mapCard = (o: RawOpp): LiveCard => ({ id: o.id, pipelineId: o.pipelineId, stageId: o.pipelineStageId, status: o.status, name: o.name ?? "", assignedUserId: o.assignedTo ?? undefined, updatedAt: o.updatedAt, contactId: o.contact?.id ?? o.contactId, updatedBy: o.lastStageChangeBy ?? o.updatedBy });

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
  async contactsAddedBetween(c, from, to) {
    const out: ContactSnapshot[] = [];
    for (let page = 1; page < 50; page++) {
      const r = await ghl<{ contacts: RawContact[] }>(c.pit, "POST", "/contacts/search", { body: { locationId: c.locationId, page, pageLimit: 100, filters: [{ field: "dateAdded", operator: "range", value: { gte: from.toISOString(), lte: to.toISOString() } }], sort: [{ field: "dateAdded", direction: "asc" }] } });
      out.push(...r.contacts.map(mapContact));
      if (r.contacts.length < 100) break;
    }
    return out;
  },
  /** Every call entry in every thread touched inside the window. Threads are read newest-first and the walk stops once a thread's last activity predates the window. */
  async callsBetween(c, from, to) {
    const out: MessageSnapshot[] = [];
    let startAfter: number | undefined;
    for (let page = 0; page < 20; page++) {
      const q = `/conversations/search?locationId=${c.locationId}&sortBy=last_message_date&sort=desc&limit=100${startAfter ? `&startAfterDate=${startAfter}` : ""}`;
      const r = await ghl<{ conversations: { id: string; contactId: string; lastMessageDate: string | number }[] }>(c.pit, "GET", q, { version: "2021-04-15" });
      const convs = r.conversations ?? []; if (!convs.length) break;
      let stop = false;
      for (const conv of convs) {
        const lastMs = typeof conv.lastMessageDate === "number" ? conv.lastMessageDate : Date.parse(String(conv.lastMessageDate));
        if (lastMs < from.getTime()) { stop = true; break; }
        const m = await ghl<{ messages: { messages: { id: string; direction: string; messageType: string; status?: string; dateAdded: string; userId?: string; meta?: { call?: { status?: string; duration?: number } } }[] } }>(c.pit, "GET", `/conversations/${conv.id}/messages?limit=100`, { version: "2021-04-15" });
        for (const msg of m.messages?.messages ?? []) {
          if (msg.messageType !== "TYPE_CALL") continue;
          const t = Date.parse(msg.dateAdded); if (t < from.getTime() || t > to.getTime()) continue;
          const call = msg.meta?.call ?? {};
          out.push({ id: msg.id, conversationId: conv.id, contactId: conv.contactId, channel: "call", direction: msg.direction as "inbound" | "outbound", status: msg.status, dateAdded: msg.dateAdded, call: { status: String(call.status ?? msg.status ?? ""), durationSec: typeof call.duration === "number" ? call.duration : undefined, userId: msg.userId } });
        }
        const last = typeof conv.lastMessageDate === "number" ? conv.lastMessageDate : Date.parse(String(conv.lastMessageDate));
        startAfter = last;
      }
      if (stop || convs.length < 100) break;
    }
    return out;
  },
  async wonOpportunities(c, from, to) {
    const out: WonOpportunity[] = [];
    for (let page = 1; page < 50; page++) {
      const r = await ghl<{ opportunities: { id: string; contact?: { id: string }; pipelineId: string; pipelineStageId: string; status: string; monetaryValue?: number; lastStageChangeAt?: string; lastStatusChangeAt?: string; updatedAt: string; createdAt: string; customFields?: { id: string; fieldValue?: unknown; value?: unknown }[] }[] }>(
        c.pit, "GET", `/opportunities/search?location_id=${c.locationId}&status=won&limit=100&page=${page}`);
      const opps = r.opportunities ?? [];
      for (const o of opps) {
        const wonAt = o.lastStatusChangeAt ?? o.lastStageChangeAt ?? o.updatedAt;
        const t = Date.parse(wonAt); if (t < from.getTime() || t > to.getTime()) continue;
        out.push({ id: o.id, contactId: o.contact?.id ?? "", pipelineId: o.pipelineId, stageId: o.pipelineStageId, wonAt, createdAt: o.createdAt, monetaryValue: o.monetaryValue, customFields: Object.fromEntries((o.customFields ?? []).map((f) => [f.id, f.fieldValue ?? f.value])) });
      }
      if (opps.length < 100) break;
    }
    return out;
  },
  async objectRecords(c, objectKey) {
    const out: ObjectRecord[] = [];
    for (let page = 1; page < 50; page++) {
      const r = await ghl<{ records: { id: string; createdAt: string; properties: Record<string, unknown> }[] }>(c.pit, "POST", `/objects/${objectKey}/records/search`, { body: { locationId: c.locationId, page, pageLimit: 100, query: "" } });
      const recs = r.records ?? []; out.push(...recs.map((x) => ({ id: x.id, createdAt: x.createdAt, properties: x.properties ?? {} })));
      if (recs.length < 100) break;
    }
    return out;
  },
  /** Documents & Contracts (verified 2026-10-07): `GET /proposals/document?locationId&limit<=21&skip`; status sent | viewed | completed; recipients[] carries the signer contact id, hasCompleted, signedDate. */
  async documents(c) {
    const out: DocumentSnapshot[] = [];
    for (let skip = 0; skip < 21 * 40; skip += 21) {
      const r = await ghl<{ documents: { _id: string; name?: string; status: string; createdAt: string; updatedAt?: string; recipients?: { id: string; entityName?: string; isPrimary?: boolean; role?: string; hasCompleted?: boolean; signedDate?: string | null }[] }[]; total?: number }>(
        c.pit, "GET", `/proposals/document?locationId=${c.locationId}&limit=21&skip=${skip}`);
      const docs = r.documents ?? [];
      for (const d of docs) {
        const signer = (d.recipients ?? []).find((x) => x.entityName === "contacts" && (x.isPrimary || x.role === "signer")) ?? (d.recipients ?? []).find((x) => x.entityName === "contacts");
        out.push({ id: d._id, name: d.name, status: d.status, contactId: signer?.id, createdAt: d.createdAt, updatedAt: d.updatedAt, signedAt: signer?.signedDate ?? undefined, raw: { recipients: (d.recipients ?? []).map((x) => ({ id: x.id, hasCompleted: x.hasCompleted, signedDate: x.signedDate })) } });
      }
      if (docs.length < 21 || (r.total !== undefined && out.length >= r.total)) break;
    }
    return out;
  },
  async opportunitiesSince(c, since) {
    const d = DateTime.fromJSDate(since).toFormat("MM-dd-yyyy");
    const r = await ghl<{ opportunities: { id: string; contact?: { id: string }; pipelineId: string; pipelineStageId: string; status: string; monetaryValue?: number; updatedAt: string }[] }>(c.pit, "GET", `/opportunities/search?location_id=${c.locationId}&date=${d}&limit=100`);
    return (r.opportunities ?? []).map((o) => ({ id: o.id, contactId: o.contact?.id ?? "", pipelineId: o.pipelineId, stageId: o.pipelineStageId, status: o.status, monetaryValue: o.monetaryValue, updatedAt: o.updatedAt }));
  },
  async openCards(c, ghlContactId) {
    // snake_case params on this endpoint (ghl/02-api-facts.md); the index lags a few seconds behind a create, so callers never treat absence as deletion
    const r = await ghl<{ opportunities: RawOpp[] }>(c.pit, "GET", `/opportunities/search?location_id=${c.locationId}&contact_id=${encodeURIComponent(ghlContactId)}&limit=100`);
    return (r.opportunities ?? []).map(mapCard);
  },
  /** The whole board, newest page first is not promised, so every page is read (capped: ten pages, a thousand cards). The search has no updated-since filter, so the diff is the poll's. */
  async pipelineCards(c, pipelineId) {
    const out: LiveCard[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await ghl<{ opportunities: RawOpp[] }>(c.pit, "GET", `/opportunities/search?location_id=${c.locationId}&pipeline_id=${encodeURIComponent(pipelineId)}&limit=100&page=${page}`);
      const opps = r.opportunities ?? []; out.push(...opps.map(mapCard));
      if (opps.length < 100) break;
    }
    return out;
  },
  async getContact(c, id) {
    try { const r = await ghl<{ contact: RawContact }>(c.pit, "GET", `/contacts/${id}`); return mapContact(r.contact); }
    // the CRM says "not found" with a 404 on this endpoint and a 400 on others; either way the record is gone, not an outage
    catch (e) { if ((e as { status?: number }).status === 404 || /\bcontact (with id \S+ )?not found\b/i.test(String((e as Error).message))) return null; throw e; }
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
    // the CRM says "not found" with a 404 on this endpoint and a 400 on others; either way the record is gone, not an outage
    catch (e) { if ((e as { status?: number }).status === 404 || /\bcontact (with id \S+ )?not found\b/i.test(String((e as Error).message))) return null; throw e; }
  },
  async listCalendars(c) {
    const r = await ghl<{ calendars: { id: string; name: string; teamMembers?: { userId: string }[] }[] }>(c.pit, "GET", `/calendars/?locationId=${c.locationId}`);
    return r.calendars.map((k): CalendarSnapshot => ({ id: k.id, name: k.name, teamMemberIds: (k.teamMembers ?? []).map((t) => t.userId) }));
  },
};
