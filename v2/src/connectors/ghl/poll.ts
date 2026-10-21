import type { Hub } from "../framework/hub";
import type { Connection, J } from "../framework/types";
import { RECONCILE_ALERT_OVER } from "../framework/hub";
import { type GhlTarget, targetOf } from "./api";
import { ghlApi } from "./index";
import { type GhlEvent, type GhlSource, normalizeGhl } from "./normalize";
import { type RawAppointment, type RawContact, type RawOpportunity, iso, oppUpdated, str } from "./shapes";

/**
 * Reading GHL instead of being told: the private-token mode's poll (an offer past the 5-agency cap has no webhooks) and
 * the nightly reconcile (every connection, to catch what webhooks missed). Both read the entities that changed, build
 * the event GHL would have sent for each, and pass it through the same normalizer as a webhook: so a poll produces the
 * same facts, with the same dedupe keys, as the webhooks it stands in for, and the reconcile's facts are new only where a
 * webhook never came.
 *
 * Reads (v1's verified polling surface, ghl/02-api-facts.md):
 * - contacts: POST /contacts/search, dateUpdated range (`operator: "range"`, a {gte} object), oldest first;
 * - appointments: GET /calendars/events per calendar (one of calendarId, userId or groupId is required) in a window;
 * - opportunities: GET /opportunities/search?location_id&date=MM-DD-YYYY (snake_case; no updated-since filter);
 * - conversations (poll only): threads by last message date, then each thread's messages.
 * The contact search lags writes by about 10 s, so each read starts a minute before the last cursor; what it sees twice
 * is the same fact twice, one row.
 */

export const POLL_EVERY_MS = 60_000;
const OVERLAP_MS = 60_000;
const RECONCILE_WINDOW_MS = 26 * 3_600_000;

type Read = { events: GhlEvent[]; maxAt?: string };

const mmddyyyy = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${d.getUTCFullYear()}`;

async function contactsSince(hub: Hub, t: GhlTarget, since: Date, known: (id: string) => Promise<boolean>): Promise<Read> {
  const events: GhlEvent[] = [];
  let maxAt: string | undefined;
  for (let page = 1; page <= 20; page++) {
    const r = await ghlApi(hub).json<{ contacts?: RawContact[] }>(t, { method: "POST", path: "/contacts/search", body: { locationId: t.locationId, page, pageLimit: 100, filters: [{ field: "dateUpdated", operator: "range", value: { gte: since.toISOString() } }], sort: [{ field: "dateUpdated", direction: "asc" }] } });
    const list = r.contacts ?? [];
    for (const c of list) {
      const isNew = !(await known(c.id)) && !!c.dateAdded && Date.parse(c.dateAdded) >= since.getTime();
      events.push({ ...c, type: isNew ? "ContactCreate" : "ContactUpdate", locationId: t.locationId });
      const at = iso(c.dateUpdated);
      if (at && (!maxAt || at > maxAt)) maxAt = at;
    }
    if (list.length < 100) break;
  }
  return { events, ...(maxAt ? { maxAt } : {}) };
}

/** The calendars to read: the field map's (a call type per calendar), else every calendar on the location. */
async function calendarsOf(hub: Hub, conn: Connection, t: GhlTarget): Promise<string[]> {
  const mapped = (await hub.state.fieldMap(conn.offerId, "ghl")).filter((r) => r.object === "calendar").map((r) => r.providerFieldId);
  if (mapped.length) return [...new Set(mapped)];
  const r = await ghlApi(hub).json<{ calendars?: { id: string }[] }>(t, { method: "GET", path: "/calendars/", query: { locationId: t.locationId } });
  return (r.calendars ?? []).map((c) => c.id);
}

async function appointmentsChanged(hub: Hub, conn: Connection, t: GhlTarget, since: Date, known: (id: string) => Promise<boolean>): Promise<Read> {
  const now = hub.now();
  const events: GhlEvent[] = [];
  for (const cal of await calendarsOf(hub, conn, t)) {
    const r = await ghlApi(hub).json<{ events?: RawAppointment[] }>(t, { method: "GET", path: "/calendars/events", query: { locationId: t.locationId, calendarId: cal, startTime: since.getTime() - 30 * 86_400_000, endTime: now.getTime() + 120 * 86_400_000 } });
    for (const e of r.events ?? []) {
      const updated = iso(e.dateUpdated) ?? iso(e.dateAdded);
      if (updated && Date.parse(updated) < since.getTime()) continue;
      events.push({ type: (await known(e.id)) ? "AppointmentUpdate" : "AppointmentCreate", locationId: t.locationId, appointment: e });
    }
  }
  return { events };
}

async function opportunitiesChanged(hub: Hub, t: GhlTarget, since: Date): Promise<Read> {
  const events: GhlEvent[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await ghlApi(hub).json<{ opportunities?: RawOpportunity[] }>(t, { method: "GET", path: "/opportunities/search", query: { location_id: t.locationId, date: mmddyyyy(since), limit: 100, page } });
    const list = r.opportunities ?? [];
    for (const o of list) {
      const at = oppUpdated(o);
      if (at && Date.parse(at) < since.getTime()) continue;
      events.push({ ...o, contactId: str(o.contactId) ?? str(o.contact?.id), type: "OpportunityUpdate", locationId: t.locationId });
    }
    if (list.length < 100) break;
  }
  return { events };
}

async function messagesSince(hub: Hub, t: GhlTarget, since: Date): Promise<Read> {
  const events: GhlEvent[] = [];
  let maxAt: string | undefined;
  const convs = await ghlApi(hub).json<{ conversations?: { id: string; contactId: string; lastMessageDate?: string | number }[] }>(t, { method: "GET", path: "/conversations/search", query: { locationId: t.locationId, sortBy: "last_message_date", sort: "asc", limit: 50, startAfterDate: since.getTime() } });
  for (const conv of convs.conversations ?? []) {
    const m = await ghlApi(hub).json<{ messages?: { messages?: J[] } }>(t, { method: "GET", path: `/conversations/${encodeURIComponent(conv.id)}/messages`, query: { limit: 50 } });
    for (const msg of m.messages?.messages ?? []) {
      const at = iso(msg.dateAdded);
      if (!at || Date.parse(at) < since.getTime()) continue;
      const type = String(msg.messageType ?? "");
      if (/^TYPE_ACTIVITY/.test(type)) continue;   // the CRM talking to itself ("opportunity moved"), not the contact
      const isCall = type === "TYPE_CALL";
      if (!isCall && msg.direction !== "inbound") continue;
      events.push({
        type: msg.direction === "outbound" ? "OutboundMessage" : "InboundMessage", locationId: t.locationId, messageId: msg.id, contactId: conv.contactId, conversationId: conv.id,
        messageType: type, direction: msg.direction, body: msg.body, subject: msg.subject, dateAdded: msg.dateAdded, userId: msg.userId, meta: msg.meta, status: msg.status,
      });
      if (!maxAt || at > maxAt) maxAt = at;
    }
  }
  return { events, ...(maxAt ? { maxAt } : {}) };
}

/** Runs built events through the normalizer and records their facts. Gives back how many facts were new. */
async function feed(hub: Hub, events: GhlEvent[], source: GhlSource, offerId: string): Promise<{ facts: number; fresh: number }> {
  let facts = 0, fresh = 0;
  for (const ev of events) {
    const n = await normalizeGhl(hub, ev, { source, receivedAt: hub.now(), only: offerId });
    for (const f of n.facts) { facts++; if (!(await hub.ingest(f)).duplicate) fresh++; }
    await n.commit?.();
  }
  return { facts, fresh };
}

const knownIn = (hub: Hub, offerId: string, kind: string) => async (id: string) => !!(await hub.state.version(offerId, "ghl", kind, id));

/** The private-token mode's poll for one connection: what changed since the last poll, as webhooks would have said it. */
export async function pollGhl(hub: Hub, conn: Connection): Promise<{ facts: number; fresh: number }> {
  if (conn.mode !== "pit" || conn.status !== "connected") return { facts: 0, fresh: 0 };
  const t = targetOf(conn);
  const now = hub.now();
  const cursorOf = async (k: string) => (await hub.state.version(conn.offerId, "ghl", "cursor", `poll:${k}`))?.versionAt ?? new Date(now.getTime() - 10 * 60_000);
  const setCursor = (k: string, at: Date) => hub.state.putVersion({ offerId: conn.offerId, provider: "ghl", kind: "cursor", entityId: `poll:${k}`, versionAt: at, state: {}, updatedAt: now });
  const since = (d: Date) => new Date(d.getTime() - OVERLAP_MS);
  const [cc, ca, co, cm] = await Promise.all(["contacts", "appointments", "opportunities", "messages"].map(cursorOf));
  const contacts = await contactsSince(hub, t, since(cc!), knownIn(hub, conn.offerId, "contact"));
  const appts = await appointmentsChanged(hub, conn, t, since(ca!), knownIn(hub, conn.offerId, "appointment"));
  const opps = await opportunitiesChanged(hub, t, since(co!));
  const msgs = await messagesSince(hub, t, since(cm!));
  // contacts first, so a scoped offer knows its people before their bookings
  const out = await feed(hub, [...contacts.events, ...appts.events, ...opps.events, ...msgs.events], "ghl_poll", conn.offerId);
  await setCursor("contacts", contacts.maxAt ? new Date(contacts.maxAt) : now);
  await setCursor("appointments", now);
  await setCursor("opportunities", now);
  await setCursor("messages", msgs.maxAt ? new Date(msgs.maxAt) : now);
  const every = Number(conn.config.poll_seconds) > 0 ? Number(conn.config.poll_seconds) * 1000 : POLL_EVERY_MS;
  await hub.enqueue("ghl_poll", { connectionId: conn.id }, { runAt: new Date(now.getTime() + every), jobKey: `ghl_poll:${conn.id}` });
  return out;
}

/**
 * The nightly reconcile for one connection: the last 26 hours of contacts, appointments and opportunities through the
 * normalizer, `source: reconcile`. A fact it records that no webhook or poll recorded was missed; more than a handful
 * means webhooks are failing, and the offer is alerted.
 */
export async function reconcileGhl(hub: Hub, conn: Connection): Promise<{ facts: number; missed: number }> {
  const t = targetOf(conn);
  const from = new Date(hub.now().getTime() - RECONCILE_WINDOW_MS);
  const contacts = await contactsSince(hub, t, from, knownIn(hub, conn.offerId, "contact"));
  const appts = await appointmentsChanged(hub, conn, t, from, knownIn(hub, conn.offerId, "appointment"));
  const opps = await opportunitiesChanged(hub, t, from);
  const r = await feed(hub, [...contacts.events, ...appts.events, ...opps.events], "reconcile", conn.offerId);
  if (r.fresh > RECONCILE_ALERT_OVER) {
    await hub.alert({ offerId: conn.offerId, key: "reconcile:ghl", kind: "reconcile_missed", message: `The nightly GHL check found ${r.fresh} changes from the last 26 hours that never arrived as webhooks. They are recorded now; GHL's webhooks to the platform may be failing.`, detail: { missed: r.fresh } });
  }
  return { facts: r.facts, missed: r.fresh };
}
