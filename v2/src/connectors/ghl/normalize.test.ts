import { describe, expect, it } from "vitest";
import { type Kit, connectorKit, factsOf } from "../testkit/kit";
import { processDelivery } from "../registry";
import { ghlPortsFor } from "./index";
import type { J } from "../framework/types";

/**
 * GHL webhook deliveries through the inbox and the normalizer. The payloads are modelled on GHL's webhook docs and
 * v1's verified API reads; UNVERIFIED against a real delivery until the Phase 0 checks (docs/phase-0.md): the exact
 * top-level keys of Contact*, Opportunity* and Record* events (flat, as the docs show), AppointmentCreate's nested
 * `appointment`, and calls arriving as Inbound/OutboundMessage with messageType CALL.
 */

let n = 0;
async function deliver(k: Kit, body: J, webhookId?: string): Promise<string> {
  const r = await k.state.recordDelivery({ source: "ghl", deliveryId: webhookId ?? `w-${++n}`, eventType: String(body.type), locationId: String(body.locationId ?? ""), connectionId: null, offerId: null, headers: {}, body: JSON.stringify(body), receivedAt: k.http.now() });
  return processDelivery(k.hub, r.id);
}
const types = async (k: Kit, offerId = k.offerId) => (await factsOf(k.store, offerId)).map((f) => f.type);

async function bench(o: { offers?: number } = {}) {
  const k = await connectorKit(o);
  await k.connectGhl();
  await k.state.setFieldMap([
    { offerId: k.offerId, provider: "ghl", object: "contact", canonicalField: "lead_source", providerFieldId: "CF-SRC", valueType: "text", options: {} },
    { offerId: k.offerId, provider: "ghl", object: "calendar", canonicalField: "closing", providerFieldId: "CAL-CLOSE", valueType: "id", options: {} },
  ]);
  return k;
}

const contact = (over: J = {}): J => ({ type: "ContactCreate", locationId: "LOC1", id: "c1", firstName: "Ana", lastName: "Lopez", email: "Ana@Example.com", phone: "+15550100001", tags: ["lead"], customFields: [{ id: "CF-SRC", value: "fb" }], dateAdded: "2026-10-26T13:00:00.000Z", dateUpdated: "2026-10-26T13:00:00.000Z", ...over });

describe("GHL contacts", () => {
  it("ContactCreate is contact.created, with its tags added, the contact in canonical words (custom fields through the field map)", async () => {
    const k = await bench();
    expect(await deliver(k, contact())).toMatch(/^2 facts/);
    const facts = await factsOf(k.store, k.offerId);
    expect(facts.map((f) => f.type)).toEqual(["contact.created", "tag.added"]);
    expect(facts[0]).toMatchObject({ contactId: "c1", source: "ghl", dedupeKey: "ghl:contact:c1:created" });
    expect(facts[0]!.payload.contact).toEqual({ ghl_contact_id: "c1", crm_id: "c1", first_name: "Ana", last_name: "Lopez", name: "Ana Lopez", email: "ana@example.com", phone: "+15550100001", tags: ["lead"], fields: { lead_source: "fb" } });
    expect(facts[1]!.payload).toMatchObject({ tag: "lead", by: "crm" });
    // the projection now knows them by email and phone
    expect(await k.hub.matchContact(k.offerId, { email: "ana@example.com" })).toEqual({ id: "c1", by: "email" });
  });

  it("ContactUpdate says the tags added and removed, and DND turned on, against the last state seen", async () => {
    const k = await bench();
    await deliver(k, contact());
    await deliver(k, contact({ type: "ContactTagUpdate", tags: ["booked"], dateUpdated: "2026-10-26T14:00:00.000Z" }));
    await deliver(k, contact({ type: "ContactDndUpdate", tags: ["booked"], dnd: false, dndSettings: { SMS: { status: "active" } }, dateUpdated: "2026-10-26T14:05:00.000Z" }));
    expect(await types(k)).toEqual(["contact.created", "tag.added", "tag.added", "tag.removed", "contact.updated", "contact.opted_out", "contact.updated"]);
    const facts = await factsOf(k.store, k.offerId);
    expect(facts[2]!.payload.tag).toBe("booked");
    expect(facts[3]!.payload.tag).toBe("lead");
    expect(facts[5]!.payload.channel).toBe("sms");
  });

  it("an update for a contact never seen says no tag change (GHL does not say which tag changed); it learns the state", async () => {
    const k = await bench();
    await deliver(k, contact({ type: "ContactUpdate", tags: ["vip"] }));
    expect(await types(k)).toEqual(["contact.updated"]);
    await deliver(k, contact({ type: "ContactUpdate", tags: ["vip", "hot"], dateUpdated: "2026-10-26T15:00:00.000Z" }));
    expect(await types(k)).toEqual(["contact.updated", "tag.added", "contact.updated"]);
  });

  it("drops a stale update: one older than the state already seen (deliveries arrive out of order)", async () => {
    const k = await bench();
    await deliver(k, contact());
    await deliver(k, contact({ type: "ContactUpdate", tags: ["lead", "new"], dateUpdated: "2026-10-26T15:00:00.000Z" }));
    expect(await deliver(k, contact({ type: "ContactUpdate", tags: [], dateUpdated: "2026-10-26T14:00:00.000Z" }))).toBe("stale");
    expect(await types(k)).toEqual(["contact.created", "tag.added", "tag.added", "contact.updated"]);
  });

  it("a delivery GHL retries is one inbox row; the same change through another delivery is the same fact", async () => {
    const k = await bench();
    const body = contact();
    expect((await deliver(k, body, "w-same")).startsWith("2 facts")).toBe(true);
    expect(await deliver(k, body, "w-same")).toBe("already read");
    expect(await deliver(k, body, "w-other")).toMatch(/\(0 new\)/);
    expect(await types(k)).toEqual(["contact.created", "tag.added"]);
  });

  it("ContactDelete is contact.deleted", async () => {
    const k = await bench();
    await deliver(k, { type: "ContactDelete", locationId: "LOC1", id: "c1" });
    expect(await types(k)).toEqual(["contact.deleted"]);
  });
});

describe("echoes of the platform's own writes", () => {
  it("a tag the platform added comes back by: platform; one a person added is by: crm; an echo matches once", async () => {
    const k = await bench();
    await deliver(k, contact());
    k.ghl.seedContact({ locationId: "LOC1", id: "c1", tags: ["lead"] });
    const ports = await ghlPortsFor(k.hub, (await k.state.connection(k.offerId, "crm"))!);
    await ports.crm.addTags({ offerId: k.offerId, idempotencyKey: "outbox:7" }, "c1", ["booked"]);
    await deliver(k, contact({ type: "ContactTagUpdate", tags: ["lead", "booked"], dateUpdated: "2026-10-26T14:00:01.000Z" }));
    await deliver(k, contact({ type: "ContactTagUpdate", tags: ["lead", "booked", "vip"], dateUpdated: "2026-10-26T14:00:02.000Z" }));
    const tags = (await factsOf(k.store, k.offerId)).filter((f) => f.type === "tag.added").map((f) => [f.payload.tag, f.payload.by]);
    expect(tags).toEqual([["lead", "crm"], ["booked", "platform"], ["vip", "crm"]]);
    // the tag-only update that echoed the platform's write is the platform's too
    const updates = (await factsOf(k.store, k.offerId)).filter((f) => f.type === "contact.updated").map((f) => f.payload.by);
    expect(updates).toEqual(["platform", "crm"]);
  });

  it("a contact the platform made comes back as contact.created by: platform", async () => {
    const k = await bench();
    const ports = await ghlPortsFor(k.hub, (await k.state.connection(k.offerId, "crm"))!);
    const { id } = await ports.crm.findOrCreateContact({ offerId: k.offerId, idempotencyKey: "o9" }, null, { match: ["email"], create: true, fillBlank: { email: "made@example.com" } });
    k.http.advance(1_000);
    await deliver(k, { type: "ContactCreate", locationId: "LOC1", ...k.ghl.contactJson(id), tags: [] });
    expect((await factsOf(k.store, k.offerId))[0]!.payload.by).toBe("platform");
  });

  it("an echo is only expected inside its window: a matching change long after is a person's", async () => {
    const k = await bench();
    await deliver(k, contact());
    k.ghl.seedContact({ locationId: "LOC1", id: "c1", tags: ["lead"] });
    const ports = await ghlPortsFor(k.hub, (await k.state.connection(k.offerId, "crm"))!);
    await ports.crm.addTags({ offerId: k.offerId, idempotencyKey: "outbox:8" }, "c1", ["booked"]);
    k.http.advance(16 * 60_000);
    await deliver(k, contact({ type: "ContactTagUpdate", tags: ["lead", "booked"], dateUpdated: "2026-10-26T14:30:00.000Z" }));
    expect((await factsOf(k.store, k.offerId)).find((f) => f.type === "tag.added" && f.payload.tag === "booked")!.payload.by).toBe("crm");
  });

  it("a card the platform moved and a status it set come back by: platform", async () => {
    const k = await bench();
    k.ghl.seedContact({ locationId: "LOC1", id: "c1" });
    const ports = await ghlPortsFor(k.hub, (await k.state.connection(k.offerId, "crm"))!);
    const card = await ports.crm.moveDeal({ offerId: k.offerId, idempotencyKey: "o1" }, "c1", { pipeline: "P1", stage: "S1", ifMissing: "create", pick: "open", name: "Ana" });
    await deliver(k, { type: "OpportunityCreate", locationId: "LOC1", ...k.ghl.oppJson(card!.id) });
    const appt = k.ghl.seedAppointment({ locationId: "LOC1", contactId: "c1", calendarId: "CAL-CLOSE" });
    await deliver(k, { type: "AppointmentCreate", locationId: "LOC1", appointment: k.ghl.apptJson(appt.id) });
    await ports.scheduling.setStatus({ offerId: k.offerId, idempotencyKey: "o2" }, { appointmentId: appt.id, status: "showed" });
    await deliver(k, { type: "AppointmentUpdate", locationId: "LOC1", appointment: { ...k.ghl.apptJson(appt.id), dateUpdated: "2026-10-26T14:10:00.000Z" } });
    const facts = await factsOf(k.store, k.offerId);
    expect(facts.find((f) => f.type === "card.moved")!.payload.by).toBe("platform");
    expect(facts.find((f) => f.type === "appointment.status_changed")!.payload).toMatchObject({ by: "platform", status: { from: "confirmed", to: "showed" } });
  });
});

describe("GHL appointments, cards, messages, records", () => {
  it("appointments: booked, moved, status changed, cancelled, deleted", async () => {
    const k = await bench();
    const a = { id: "a1", calendarId: "CAL-CLOSE", contactId: "c1", assignedUserId: "U1", startTime: "2026-10-28T15:00:00.000Z", endTime: "2026-10-28T15:30:00.000Z", appointmentStatus: "confirmed", appoinmentStatus: "confirmed", title: "Call", dateAdded: "2026-10-26T13:00:00.000Z", dateUpdated: "2026-10-26T13:00:00.000Z" };
    await deliver(k, { type: "AppointmentCreate", locationId: "LOC1", appointment: a });
    await deliver(k, { type: "AppointmentUpdate", locationId: "LOC1", appointment: { ...a, startTime: "2026-10-29T15:00:00.000Z", dateUpdated: "2026-10-26T14:00:00.000Z" } });
    await deliver(k, { type: "AppointmentUpdate", locationId: "LOC1", appointment: { ...a, startTime: "2026-10-29T15:00:00.000Z", appointmentStatus: "noshow", dateUpdated: "2026-10-26T15:00:00.000Z" } });
    await deliver(k, { type: "AppointmentUpdate", locationId: "LOC1", appointment: { ...a, startTime: "2026-10-29T15:00:00.000Z", appointmentStatus: "cancelled", dateUpdated: "2026-10-26T16:00:00.000Z" } });
    await deliver(k, { type: "AppointmentDelete", locationId: "LOC1", appointment: { id: "a2", contactId: "c1" } });
    const facts = await factsOf(k.store, k.offerId);
    expect(facts.map((f) => f.type)).toEqual(["appointment.booked", "appointment.rescheduled", "appointment.status_changed", "appointment.cancelled", "appointment.cancelled"]);
    expect(facts[0]).toMatchObject({ contactId: "c1", appointmentId: "a1", payload: { appointment: { starts_at: "2026-10-28T15:00:00.000Z", status: "booked", kind: "closing", term: { category: "closing" }, closer: { ghl_user_id: "U1" } } } });
    const row = await k.store.tx((tx) => tx.projGet("appointments", k.offerId, "a1"));
    expect(row).toMatchObject({ status: "cancelled", reschedules: 1, kind: "closing" });
  });

  it("opportunities are cards (never the ledger's deals): made, moved, won, value changed", async () => {
    const k = await bench();
    const o = { id: "o1", contactId: "c1", pipelineId: "P1", pipelineStageId: "S1", status: "open", monetaryValue: 1000, assignedTo: "U1", name: "Ana", updatedAt: "2026-10-26T13:00:00.000Z" };
    await deliver(k, { type: "OpportunityCreate", locationId: "LOC1", ...o });
    await deliver(k, { type: "OpportunityStageUpdate", locationId: "LOC1", ...o, pipelineStageId: "S2", updatedAt: "2026-10-26T14:00:00.000Z" });
    await deliver(k, { type: "OpportunityStatusUpdate", locationId: "LOC1", id: "o1", contactId: "c1", status: "won", updatedAt: "2026-10-26T15:00:00.000Z" });
    await deliver(k, { type: "OpportunityMonetaryValueUpdate", locationId: "LOC1", ...o, pipelineStageId: "S2", status: "won", monetaryValue: 2999, updatedAt: "2026-10-26T16:00:00.000Z" });
    const facts = await factsOf(k.store, k.offerId);
    expect(facts.map((f) => f.type)).toEqual(["card.moved", "card.moved", "card.moved", "card.updated"]);
    expect(facts[1]!.payload).toMatchObject({ deal_id: "o1", pipeline_id: "P1", from_stage: "S1", to_stage: "S2", to_status: "open" });
    expect(facts[2]!.payload).toMatchObject({ from_status: "open", to_status: "won", to_stage: "S2" });
    const card = await k.store.tx((tx) => tx.projGet("deals", k.offerId, "card:o1"));
    expect(card).toMatchObject({ kind: "card", stage: "S2", status: "won", value: 2999 });
    expect(await k.store.tx((tx) => tx.projFind("daily_facts", k.offerId, { where: { metric: "closes" } }))).toEqual([]);
  });

  it("an inbound text is message.received; an outbound one is ours (ignored); a dialer call is call.logged and its transcript is looked for", async () => {
    const k = await bench();
    await deliver(k, { type: "InboundMessage", locationId: "LOC1", messageId: "m1", contactId: "c1", conversationId: "cv1", messageType: "SMS", direction: "inbound", body: "yes", dateAdded: "2026-10-26T14:00:00.000Z" });
    expect(await deliver(k, { type: "OutboundMessage", locationId: "LOC1", messageId: "m2", contactId: "c1", messageType: "SMS", direction: "outbound", body: "hi" })).toMatch(/outbound/);
    await deliver(k, { type: "OutboundMessage", locationId: "LOC1", messageId: "m3", contactId: "c1", conversationId: "cv1", messageType: "CALL", direction: "outbound", callDuration: 120, callStatus: "completed", userId: "U-MIA", dateAdded: "2026-10-26T14:10:00.000Z" });
    const facts = await factsOf(k.store, k.offerId);
    expect(facts.map((f) => f.type)).toEqual(["message.received", "call.logged"]);
    expect(facts[0]!.payload).toMatchObject({ channel: "sms", body: "yes", message_id: "m1" });
    expect(facts[1]!.payload).toMatchObject({ recording_id: "ghl:m3", duration_sec: 120, recording: { kind: "phone", status: "connected", direction: "outbound", started_at: "2026-10-26T14:08:00.000Z", caller: { ghl_user_id: "U-MIA" } } });
    expect((await k.store.tx((tx) => tx.projFind("calls", k.offerId)))[0]).toMatchObject({ source: "dialer", connected: true, durationSec: 120 });
    // the transcript: none at 1 and 3 minutes, there at 10
    expect(k.queue.jobs.map((j) => j.task)).toContain("transcript_wait");
    await k.runJobs(new Date(k.http.now().getTime() + 5 * 60_000));
    k.ghl.transcripts.set("m3", [{ speaker: 0, transcript: "Hi Ana" }, { speaker: 1, transcript: "Hi" }]);
    await k.runJobs(new Date(k.http.now().getTime() + 15 * 60_000));
    expect((await types(k)).at(-1)).toBe("recording.transcript_ready");
    expect(k.http.to("GET", /\/transcription$/)).toHaveLength(3);
  });

  it("a transcript that never comes is given up on after 1, 3 and 10 minutes, and flagged", async () => {
    const k = await bench();
    await deliver(k, { type: "InboundMessage", locationId: "LOC1", messageId: "m9", contactId: "c1", messageType: "CALL", direction: "inbound", callDuration: 60, callStatus: "completed", dateAdded: "2026-10-26T14:00:00.000Z" });
    const t0 = k.http.now().getTime();
    await k.runJobs(new Date(t0 + 60 * 60_000));
    const looks = k.http.to("GET", /\/transcription$/).map((r) => Math.round((r.at.getTime() - t0) / 60_000));
    expect(looks).toEqual([1, 4, 14]);
    expect((await types(k)).at(-1)).toBe("recording.transcript_missing");
    expect((await k.store.tx((tx) => tx.alerts({ open: true })))[0]!.kind).toBe("transcript_missing");
  });

  it("records, notes and users", async () => {
    const k = await bench();
    await deliver(k, { type: "RecordCreate", locationId: "LOC1", id: "r1", objectKey: "custom_objects.sales_call", properties: [{ key: "custom_objects.sales_call.outcome", valueString: "showed" }], dateAdded: "2026-10-26T14:00:00.000Z" });
    await deliver(k, { type: "NoteCreate", locationId: "LOC1", id: "n1", contactId: "c1", body: "called" });
    await deliver(k, { type: "UserCreate", locationId: "LOC1", id: "U9", firstName: "Mia", lastName: "Chen", email: "mia@x.com" });
    const facts = await factsOf(k.store, k.offerId);
    expect(facts.map((f) => f.type)).toEqual(["record.created", "note.added", "person.changed"]);
    expect(facts[0]!.payload).toMatchObject({ object: "custom_objects.sales_call", record_id: "r1", properties: { outcome: "showed" } });
    expect(facts[2]!.payload).toMatchObject({ change: "created", crm_user_id: "U9", name: "Mia Chen" });
    // a GHL user is never a team member by itself
    expect(await k.store.tx((tx) => tx.projFind("people", k.offerId))).toEqual([]);
  });
});

describe("GHL locations and installs", () => {
  it("an event for a location no offer is connected to is kept, not read, and Tyler is told (never guessed)", async () => {
    const k = await bench();
    expect(await deliver(k, contact({ locationId: "LOC-NOBODY" }))).toBe("unknown location");
    expect(await types(k)).toEqual([]);
    expect((await k.store.tx((tx) => tx.alerts({ open: true })))[0]).toMatchObject({ offerId: null, kind: "ghl_unknown_location" });
  });

  it("an install the platform did not start is recorded and alerted, never linked", async () => {
    const k = await bench();
    expect(await deliver(k, { type: "INSTALL", locationId: "LOC-NEW", companyId: "CO9", appId: "app" })).toMatch(/did not start/);
    expect((await k.store.tx((tx) => tx.alerts({ open: true })))[0]!.kind).toBe("ghl_install_unknown");
  });

  it("an uninstall holds every offer's GHL work on that location and tells Tyler; the facts say so", async () => {
    const k = await connectorKit({ offers: 2 });
    await k.connectGhl({ offerId: k.offers[0] });
    await k.connectGhl({ offerId: k.offers[1] });
    await deliver(k, { type: "UNINSTALL", locationId: "LOC1", appId: "app" });
    expect((await k.state.ghlToken("LOC1"))!.status).toBe("uninstalled");
    for (const o of k.offers) {
      expect((await k.state.connection(o, "crm"))!.status).toBe("uninstalled");
      expect(await types(k, o)).toEqual(["connection.uninstalled"]);
    }
  });

  it("one location, two offers: each gets the facts; with a scope tag, an offer gets only its own people's", async () => {
    const k = await connectorKit({ offers: 2 });
    await k.connectGhl({ offerId: k.offers[0] });
    await k.connectGhl({ offerId: k.offers[1], config: { scope_tag: "dating" } });
    await deliver(k, contact({ id: "c1", tags: ["lead"] }));
    await deliver(k, contact({ id: "c2", email: "b@x.com", phone: "+15550100002", tags: ["dating"] }));
    await deliver(k, { type: "AppointmentCreate", locationId: "LOC1", appointment: { id: "a1", contactId: "c1", calendarId: "CAL1", startTime: "2026-10-28T15:00:00.000Z", appointmentStatus: "confirmed" } });
    await deliver(k, { type: "AppointmentCreate", locationId: "LOC1", appointment: { id: "a2", contactId: "c2", calendarId: "CAL1", startTime: "2026-10-28T16:00:00.000Z", appointmentStatus: "confirmed" } });
    expect((await factsOf(k.store, k.offers[0]!)).filter((f) => f.type === "appointment.booked").map((f) => f.appointmentId)).toEqual(["a1", "a2"]);
    expect((await factsOf(k.store, k.offers[1]!)).filter((f) => f.type === "appointment.booked").map((f) => f.appointmentId)).toEqual(["a2"]);
    expect((await factsOf(k.store, k.offers[1]!)).filter((f) => f.type === "contact.created").map((f) => f.contactId)).toEqual(["c2"]);
  });
});
