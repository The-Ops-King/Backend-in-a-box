import { describe, expect, it } from "vitest";
import { type Kit, connectorKit, factsOf } from "../testkit/kit";
import { processDelivery, reconcile } from "../registry";
import type { J } from "../framework/types";
import { ghlPortsFor } from "./index";
import { FAST_MS, SLOW_MS } from "./agreements";
import { pollGhl } from "./poll";

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
let n = 0;
async function deliver(k: Kit, body: J) {
  const r = await k.state.recordDelivery({ source: "ghl", deliveryId: `w-${++n}`, eventType: String(body.type), locationId: String(body.locationId), connectionId: null, offerId: null, headers: {}, body: JSON.stringify(body), receivedAt: k.http.now() });
  return processDelivery(k.hub, r.id);
}

describe("the agreement check (ADR 0003): 10 s for an hour, then 5 min up to 30 days, one request per location", () => {
  it("is looked for every 10 seconds for its first hour, then every 5 minutes, and stops when it is signed", async () => {
    const k = await connectorKit();
    const conn = await k.connectGhl();
    const c = k.ghl.seedContact({ locationId: "LOC1" });
    const ports = await ghlPortsFor(k.hub, conn);
    const sent = k.http.now().getTime();
    const { id } = await ports.esign.send({ offerId: k.offerId, idempotencyKey: "o1" }, { contactId: c.id, template: "TPL", name: "Purchase agreement" });
    expect(k.queue.jobs).toContainEqual(expect.objectContaining({ task: "ghl_agreements", runAt: new Date(sent + FAST_MS), jobKey: "ghl_agreements:LOC1" }));
    await k.runJobs(new Date(sent + 2 * HOUR));
    const at = k.http.to("GET", "/proposals/document").map((r) => r.at.getTime() - sent);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    expect(at[0]).toBe(FAST_MS);
    expect(at.filter((t) => t <= HOUR)).toHaveLength(360);
    expect(new Set(gaps.slice(0, 359))).toEqual(new Set([FAST_MS]));
    expect(new Set(gaps.slice(360))).toEqual(new Set([SLOW_MS]));
    k.ghl.sign(id);
    await k.runJobs(new Date(sent + 3 * HOUR));
    const facts = await factsOf(k.store, k.offerId);
    expect(facts.map((f) => f.type)).toEqual(["agreement.signed"]);
    expect(facts[0]).toMatchObject({ contactId: c.id, dedupeKey: `ghl:agreement:${id}:signed`, payload: { agreement: { id, name: "Purchase agreement", status: "signed" } } });
    const after = k.http.to("GET", "/proposals/document").length;
    await k.runJobs(new Date(sent + 5 * HOUR));
    expect(k.http.to("GET", "/proposals/document")).toHaveLength(after);
    expect((await k.store.tx((tx) => tx.projGet("contacts_index", k.offerId, c.id)))!.agreement).toMatchObject({ status: "signed" });
  });

  it("one request a check covers every agreement the location is waiting on, whichever offer sent it", async () => {
    const k = await connectorKit({ offers: 2 });
    const a = await k.connectGhl({ offerId: k.offers[0] });
    const b = await k.connectGhl({ offerId: k.offers[1] });
    const c = k.ghl.seedContact({ locationId: "LOC1" });
    const pa = await ghlPortsFor(k.hub, a), pb = await ghlPortsFor(k.hub, b);
    const start = k.http.now().getTime();
    await pa.esign.send({ offerId: k.offers[0]!, idempotencyKey: "a1" }, { contactId: c.id, template: "T" });
    await pa.esign.send({ offerId: k.offers[0]!, idempotencyKey: "a2" }, { contactId: c.id, template: "T" });
    await pb.esign.send({ offerId: k.offers[1]!, idempotencyKey: "b1" }, { contactId: c.id, template: "T" });
    await k.runJobs(new Date(start + 10 * MIN));
    const reqs = k.http.to("GET", "/proposals/document");
    expect(reqs.length).toBe(60);
    expect(new Set(reqs.map((r) => r.at.getTime())).size).toBe(reqs.length);
    expect(await k.state.agreementChecks({ status: "waiting" })).toHaveLength(3);
  });

  it("stops looking 30 days after it was sent", async () => {
    const k = await connectorKit();
    const conn = await k.connectGhl({ expiresInMs: 400 * DAY });
    const c = k.ghl.seedContact({ locationId: "LOC1" });
    const sent = k.http.now().getTime();
    await (await ghlPortsFor(k.hub, conn)).esign.send({ offerId: k.offerId, idempotencyKey: "o1" }, { contactId: c.id, template: "T" });
    await k.runJobs(new Date(sent + 31 * DAY));
    const at = k.http.to("GET", "/proposals/document").map((r) => r.at.getTime() - sent);
    expect(Math.max(...at)).toBeLessThanOrEqual(30 * DAY);
    expect(at.length).toBe(360 + Math.floor((30 * DAY - HOUR) / SLOW_MS));
    expect((await k.state.agreementChecks({}))[0]!.status).toBe("expired");
    expect(k.queue.jobs.filter((j) => j.task === "ghl_agreements")).toHaveLength(0);
  });

  it("a voided agreement is agreement.voided, and stops being looked for", async () => {
    const k = await connectorKit();
    const conn = await k.connectGhl();
    const c = k.ghl.seedContact({ locationId: "LOC1" });
    const { id } = await (await ghlPortsFor(k.hub, conn)).esign.send({ offerId: k.offerId, idempotencyKey: "o1" }, { contactId: c.id, template: "T" });
    k.ghl.documents.find((d) => d._id === id)!.status = "voided";
    await k.runJobs(new Date(k.http.now().getTime() + MIN));
    expect((await factsOf(k.store, k.offerId)).map((f) => f.type)).toEqual(["agreement.voided"]);
    expect(k.http.to("GET", "/proposals/document")).toHaveLength(1);
  });
});

// ---- private-token mode: the poll stands in for webhooks and says the same facts -------------------------------------

/** One world of changes, made in a fake GHL step by step; `after` is told each change (to deliver its webhook, or poll). */
async function world(k: Kit, after: (events: J[]) => Promise<void>) {
  const g = k.ghl;
  k.http.advance(2 * MIN);
  const c = g.seedContact({ id: "c1", locationId: "LOC1", firstName: "Ana", email: "ana@example.com", phone: "+15550100001", tags: ["lead"], dateAdded: k.http.now().toISOString(), dateUpdated: k.http.now().toISOString() });
  await after([{ type: "ContactCreate", locationId: "LOC1", ...g.contactJson(c.id) }]);
  k.http.advance(2 * MIN);
  const a = g.seedAppointment({ id: "a1", locationId: "LOC1", contactId: "c1", calendarId: "CAL-CLOSE", startTime: "2026-10-28T15:00:00.000Z", endTime: "2026-10-28T15:30:00.000Z" });
  const o = g.seedOpp({ id: "o1", locationId: "LOC1", contactId: "c1", pipelineId: "P1", pipelineStageId: "S1", name: "Ana" });
  g.messages.push({ id: "m1", conversationId: "cv1", contactId: "c1", direction: "inbound", messageType: "TYPE_SMS", body: "yes please", dateAdded: k.http.now().toISOString() });
  await after([
    { type: "AppointmentCreate", locationId: "LOC1", appointment: g.apptJson(a.id) },
    { type: "OpportunityCreate", locationId: "LOC1", ...g.oppJson(o.id) },
    { type: "InboundMessage", locationId: "LOC1", messageId: "m1", contactId: "c1", conversationId: "cv1", messageType: "SMS", direction: "inbound", body: "yes please", dateAdded: k.http.now().toISOString() },
  ]);
  k.http.advance(2 * MIN);
  Object.assign(g.contacts.get("c1")!, { tags: ["lead", "booked"], dateUpdated: k.http.now().toISOString(), indexedAt: k.http.now().getTime() });
  Object.assign(g.appts.get("a1")!, { startTime: "2026-10-29T15:00:00.000Z", dateUpdated: k.http.now().toISOString() });
  Object.assign(g.opps.get("o1")!, { pipelineStageId: "S2", updatedAt: k.http.now().toISOString() });
  g.messages.push({ id: "m2", conversationId: "cv1", contactId: "c1", direction: "outbound", messageType: "TYPE_CALL", status: "completed", meta: { call: { duration: 95, status: "completed" } }, userId: "U-MIA", dateAdded: k.http.now().toISOString() });
  await after([
    { type: "ContactTagUpdate", locationId: "LOC1", ...g.contactJson("c1") },
    { type: "AppointmentUpdate", locationId: "LOC1", appointment: g.apptJson("a1") },
    { type: "OpportunityStageUpdate", locationId: "LOC1", ...g.oppJson("o1") },
    { type: "OutboundMessage", locationId: "LOC1", messageId: "m2", contactId: "c1", conversationId: "cv1", messageType: "CALL", direction: "outbound", callDuration: 95, callStatus: "completed", userId: "U-MIA", dateAdded: k.http.now().toISOString() },
  ]);
}

async function mapped(k: Kit) {
  await k.state.setFieldMap([{ offerId: k.offerId, provider: "ghl", object: "calendar", canonicalField: "closing", providerFieldId: "CAL-CLOSE", valueType: "id", options: {} }]);
}

describe("private-token mode: the poll stands in for webhooks", () => {
  it("the poll of a private-token offer records exactly the facts the webhooks record for an app offer", async () => {
    const push = await connectorKit();
    await push.connectGhl({ mode: "oauth" });
    await mapped(push);
    await world(push, async (events) => { push.http.advance(15_000); for (const e of events) await deliver(push, e); });

    const poll = await connectorKit();
    const conn = await poll.connectGhl({ mode: "pit", token: "pit-1" });
    await mapped(poll);
    await world(poll, async () => { poll.http.advance(15_000); await pollGhl(poll.hub, conn); });

    const strip = (fs: Awaited<ReturnType<typeof factsOf>>) => fs.map(({ source: _s, ...f }) => f);
    const a = strip(await factsOf(push.store, push.offerId)), b = strip(await factsOf(poll.store, poll.offerId));
    expect(a.map((f) => f.type)).toEqual(["contact.created", "tag.added", "appointment.booked", "card.moved", "message.received", "tag.added", "contact.updated", "appointment.rescheduled", "card.moved", "call.logged"]);
    expect(b.sort((x, y) => x.dedupeKey.localeCompare(y.dedupeKey))).toEqual(a.sort((x, y) => x.dedupeKey.localeCompare(y.dedupeKey)));
    expect((await factsOf(poll.store, poll.offerId)).every((f) => f.source === "ghl_poll")).toBe(true);
  });

  it("the poll runs again every minute (the connection's poll_seconds when set) and only for a private-token connection", async () => {
    const k = await connectorKit();
    const conn = await k.connectGhl({ mode: "pit", token: "pit-1", config: { poll_seconds: 30 } });
    await pollGhl(k.hub, conn);
    expect(k.queue.jobs.find((j) => j.task === "ghl_poll")!.runAt.getTime() - k.http.now().getTime()).toBe(30_000);
    const app = await connectorKit();
    const oauth = await app.connectGhl({ mode: "oauth" });
    expect(await pollGhl(app.hub, oauth)).toEqual({ facts: 0, fresh: 0 });
    expect(app.http.requests).toHaveLength(0);
  });
});

describe("the nightly reconcile", () => {
  it("records what webhooks missed in the last 26 hours, source reconcile, and nothing twice", async () => {
    const k = await connectorKit();
    const conn = await k.connectGhl();
    await mapped(k);
    const c = k.ghl.seedContact({ id: "c1", locationId: "LOC1", tags: ["lead"] });
    await deliver(k, { type: "ContactCreate", locationId: "LOC1", ...k.ghl.contactJson(c.id) });
    k.http.advance(HOUR);
    // the tag change's webhook never came, nor the booking's
    Object.assign(k.ghl.contacts.get("c1")!, { tags: ["lead", "booked"], dateUpdated: k.http.now().toISOString(), indexedAt: k.http.now().getTime() });
    k.ghl.seedAppointment({ id: "a1", locationId: "LOC1", contactId: "c1", calendarId: "CAL-CLOSE" });
    k.http.advance(HOUR);
    const r = await reconcile(k.hub, conn.id);
    expect(r.missed).toBe(3);
    const facts = await factsOf(k.store, k.offerId);
    expect(facts.filter((f) => f.source === "reconcile").map((f) => f.type)).toEqual(["tag.added", "contact.updated", "appointment.booked"]);
    expect(k.queue.jobs.find((j) => j.task === "connector_reconcile")!.runAt.getTime()).toBe(k.http.now().getTime() + DAY);
    expect(await k.store.tx((tx) => tx.alerts({ open: true }))).toEqual([]);
    expect((await reconcile(k.hub, conn.id)).missed).toBe(0);
  });

  it("more than a handful missed means webhooks are failing: the offer is alerted", async () => {
    const k = await connectorKit();
    const conn = await k.connectGhl();
    for (let i = 0; i < 7; i++) k.ghl.seedContact({ id: `c${i}`, locationId: "LOC1", dateAdded: k.http.now().toISOString() });
    k.http.advance(MIN);
    const r = await reconcile(k.hub, conn.id);
    expect(r.missed).toBe(7);
    expect((await k.store.tx((tx) => tx.alerts({ open: true })))[0]).toMatchObject({ kind: "reconcile_missed", offerId: k.offerId });
  });
});
