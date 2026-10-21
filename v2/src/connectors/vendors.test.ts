import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { install } from "@/engine/testkit";
import { connectorKit, factsOf, type Kit } from "./testkit/kit";
import { FakeCalendly, FakeFathom, FakeWhop } from "./testkit/fake-vendors";
import { signCalendly, signStandardWebhook, signTypeform, verifyCalendly, verifyStandardWebhook, verifyTypeform } from "./framework/signatures";
import { FieldMap, formatValue } from "./framework/field-map";
import { door } from "./doors";
import { connectorPorts, processDelivery, reconcile } from "./registry";
import { connectorReads } from "./framework/transcripts";
import { normalizeCalendly, pollCalendly } from "./calendly";
import { FakePorts } from "@/engine/fake-ports";
import type { J } from "./framework/types";

const now = new Date("2026-10-26T14:00:00Z");
const ts = Math.floor(now.getTime() / 1000);

describe("door signatures", () => {
  it("Standard Webhooks (Whop, Fathom, the generic door): whsec_ secrets base64-decoded, a rotation's several signatures, five minutes", () => {
    const secret = `whsec_${crypto.randomBytes(24).toString("base64")}`;
    const raw = '{"a":1}';
    const sig = signStandardWebhook(secret, "msg_1", ts, raw);
    expect(verifyStandardWebhook(secret, { id: "msg_1", timestamp: String(ts), signature: sig }, raw, now)).toEqual({ ok: true });
    expect(verifyStandardWebhook(secret, { id: "msg_1", timestamp: String(ts), signature: `v1,bogus ${sig}` }, raw, now)).toEqual({ ok: true });
    expect(verifyStandardWebhook(secret, { id: "msg_1", timestamp: String(ts), signature: sig }, raw + " ", now).ok).toBe(false);
    expect(verifyStandardWebhook(secret, { id: "msg_2", timestamp: String(ts), signature: sig }, raw, now).ok).toBe(false);
    expect(verifyStandardWebhook(secret, { id: "msg_1", timestamp: String(ts - 301), signature: signStandardWebhook(secret, "msg_1", ts - 301, raw) }, raw, now)).toEqual({ ok: false, why: "timestamp outside five minutes" });
    expect(verifyStandardWebhook(secret, { id: null, timestamp: String(ts), signature: sig }, raw, now).ok).toBe(false);
    // a plain (non-whsec) secret is used as given
    expect(verifyStandardWebhook("plain", { id: "m", timestamp: String(ts), signature: signStandardWebhook("plain", "m", ts, raw) }, raw, now).ok).toBe(true);
  });
  it("Typeform: sha256= base64 HMAC of the raw body", () => {
    expect(verifyTypeform("s", signTypeform("s", "body"), "body")).toEqual({ ok: true });
    expect(verifyTypeform("s", signTypeform("t", "body"), "body").ok).toBe(false);
    expect(verifyTypeform("s", null, "body").ok).toBe(false);
  });
  it("Calendly: t=,v1= hex HMAC of \"t.body\", five minutes", () => {
    expect(verifyCalendly("k", signCalendly("k", ts, "b"), "b", now)).toEqual({ ok: true });
    expect(verifyCalendly("k", signCalendly("k", ts, "b"), "c", now).ok).toBe(false);
    expect(verifyCalendly("k", signCalendly("k", ts - 600, "b"), "b", now).ok).toBe(false);
    expect(verifyCalendly("k", "garbage", "b", now).ok).toBe(false);
  });
});

describe("the doors", () => {
  it("an unknown connection, or a door of another vendor, is 404 and keeps nothing; a connection with no secret is 503; a body that is not JSON is 400", async () => {
    const k = await connectorKit();
    const whop = await k.state.upsertConnection({ offerId: k.offerId, port: "payments", provider: "whop", credentials: { webhook_secret: "s" } });
    const bare = await k.state.upsertConnection({ offerId: k.offerId, port: "recording", provider: "fathom" });
    const req = (body = "{}", headers: Record<string, string> = {}) => new Request("https://x/in", { method: "POST", body, headers });
    expect((await door(k.hub, "whop", crypto.randomUUID(), req())).status).toBe(404);
    expect((await door(k.hub, "whop", "not-a-uuid", req())).status).toBe(404);
    expect((await door(k.hub, "fathom", whop.id, req())).status).toBe(404);
    expect((await door(k.hub, "fathom", bare.id, req())).status).toBe(503);
    const raw = "not json";
    const t = Math.floor(k.http.now().getTime() / 1000);
    expect((await door(k.hub, "whop", whop.id, req(raw, { "webhook-id": "m", "webhook-timestamp": String(t), "webhook-signature": signStandardWebhook("s", "m", t, raw) }))).status).toBe(400);
    expect(await k.state.unprocessed()).toHaveLength(0);
  });
});

describe("the field map", () => {
  const rows = [
    { offerId: "o", provider: "ghl" as const, object: "contact", canonicalField: "lead_source", providerFieldId: "F1", valueType: "text" as const, options: {} },
    { offerId: "o", provider: "ghl" as const, object: "calendar", canonicalField: "closing", providerFieldId: "CAL-1", valueType: "id" as const, options: {} },
  ];
  it("canonical names out, the provider's ids in; back again on reading; a calendar's call type", () => {
    const m = new FieldMap(rows);
    expect(m.write("contact", { lead_source: "fb" })).toEqual([{ id: "F1", value: "fb", row: rows[0] }]);
    expect(m.read("contact", { F1: "ig", F9: "unknown" })).toEqual({ lead_source: "ig" });
    expect(m.calendarKind("CAL-1")).toBe("closing");
    expect(m.calendarKind("CAL-2")).toBeUndefined();
    expect(() => m.write("contact", { setter: "x" })).toThrow(/no contact field for "setter"/);
  });
  it("each value in its field's type", () => {
    const t = (valueType: string, v: unknown, options = {}) => formatValue({ valueType: valueType as never, options }, v);
    expect(t("date", "2026-10-16T02:00:00Z", { zone: "America/New_York" })).toBe("2026-10-15");
    expect(t("date", "2026-10-16")).toBe("2026-10-16");
    expect(t("money", "$2,999.50")).toBe(2999.5);
    expect(t("number", 3)).toBe(3);
    expect(t("checkbox", "yes")).toEqual(["yes"]);
    expect(t("options", ["a", "b"])).toEqual(["a", "b"]);
    expect(t("datetime", "2026-10-16T02:00:00-04:00")).toBe("2026-10-16T06:00:00.000Z");
    expect(() => t("money", "lots")).toThrow(/not a number/);
  });
});

describe("routing the engine's ports", () => {
  it("each port goes to the offer's provider for it; an offer with none is refused for good; a paused one is an auth failure", async () => {
    const k = await connectorKit();
    const f = new FakePorts(k.http.now).ports();
    const ports = connectorPorts(k.hub, { slack: f.slack, http: f.http });
    const c = { offerId: k.offerId, idempotencyKey: "x" };
    await expect(ports.crm.addTags(c, "c1", ["a"])).rejects.toMatchObject({ failure: "permanent", message: expect.stringMatching(/no crm connection/) });
    await k.connectGhl();
    await k.state.setStatus({ provider: "ghl", offerId: k.offerId }, "paused", "x", k.http.now());
    await expect(ports.crm.addTags(c, "c1", ["a"])).rejects.toMatchObject({ failure: "auth" });
    // ai: one provider per verb on one port
    await k.state.upsertConnection({ offerId: k.offerId, port: "ai", provider: "jev", credentials: { api_key: "k" } });
    await expect(ports.ai.summarize(c, { prompt: "p", input: "i", format: "text" })).rejects.toMatchObject({ failure: "permanent", message: expect.stringMatching(/jev cannot serve the ai.summarize port/) });
  });
});

// ---- Whop -------------------------------------------------------------------------------------------------------------

async function signed(k: Kit, vendor: "whop" | "fathom" | "generic", connId: string, body: J, id: string) {
  const raw = JSON.stringify(body);
  const t = Math.floor(k.http.now().getTime() / 1000);
  const res = await door(k.hub, vendor, connId, new Request("https://x", { method: "POST", body: raw, headers: { "webhook-id": id, "webhook-timestamp": String(t), "webhook-signature": signStandardWebhook("sec", id, t, raw) } }));
  await k.runJobs();
  return res;
}
const known = (k: Kit, id: string, contact: J) => k.engine.ingest({ offerId: k.offerId, type: "contact.created", source: "test", dedupeKey: `known:${id}`, contactId: id, payload: { contact } });

describe("Whop", () => {
  it("links by the member a person already linked, then email, then phone; one hit or none", async () => {
    const k = await connectorKit();
    const conn = await k.state.upsertConnection({ offerId: k.offerId, port: "payments", provider: "whop", credentials: { webhook_secret: "sec" } });
    await known(k, "c1", { email: "ana@example.com" });
    await known(k, "c2", { email: "dup@example.com" });
    await known(k, "c3", { email: "dup@example.com" });
    const pay = (id: string, d: J) => ({ type: "payment.succeeded", data: { id, total: { amount: "100" }, paid_at: "2026-10-26T13:00:00Z", ...d } });
    await signed(k, "whop", conn.id, pay("p1", { customer_email: "ana@example.com", member_id: "mem_1" }), "e1");
    await k.engine.ingest({ offerId: k.offerId, type: "payment.linked", source: "slack", dedupeKey: "lk", contactId: "c1", payload: { payment_id: "whop:p1", by: "person" } });
    await signed(k, "whop", conn.id, pay("p2", { customer_email: "other@example.com", member_id: "mem_1" }), "e2");
    await signed(k, "whop", conn.id, pay("p3", { customer_email: "dup@example.com" }), "e3");
    const facts = (await factsOf(k.store, k.offerId)).filter((f) => f.type.startsWith("payment.") && f.type !== "payment.linked");
    expect(facts.map((f) => [f.payload.provider_payment_id, f.type, f.contactId, f.payload.linked_by ?? null])).toEqual([
      ["p1", "payment.received", "c1", "email"], ["p2", "payment.received", "c1", "member"], ["p3", "payment.unlinked", null, null],
    ]);
    expect(facts[0]!.payload).toMatchObject({ amount: 100, currency: "USD", whop_member_id: "mem_1", customer_email: "ana@example.com" });
  });

  it("the product's and plan's names ride along (a deposit is told by its name, by the offer's rule)", async () => {
    const k = await connectorKit();
    const conn = await k.state.upsertConnection({ offerId: k.offerId, port: "payments", provider: "whop", credentials: { webhook_secret: "sec" } });
    await signed(k, "whop", conn.id, { type: "payment.succeeded", data: { id: "p1", total: { amount: 500 }, product_id: "prod_9", line_items: [{ product_id: "prod_9", product_title: "Deposit - Hair", plan_title: null }] } }, "e1");
    expect((await factsOf(k.store, k.offerId))[0]!.payload).toMatchObject({ product_id: "prod_9", product_name: "Deposit - Hair", plan_name: null });
  });

  it("the reconcile records a payment whose webhook never came, once", async () => {
    const k = await connectorKit();
    const whop = new FakeWhop(k.http);
    const conn = await k.state.upsertConnection({ offerId: k.offerId, port: "payments", provider: "whop", credentials: { webhook_secret: "sec", api_key: "key" } });
    whop.payments.push({ id: "p1", status: "paid", total: { amount: "100" }, created_at: "2026-10-26T10:00:00Z", paid_at: "2026-10-26T10:00:00Z", customer_email: "x@y.z" }, { id: "p2", status: "open", total: { amount: "5" }, created_at: "2026-10-26T10:00:00Z" });
    await signed(k, "whop", conn.id, { type: "payment.succeeded", data: { id: "p1", total: { amount: "100" }, paid_at: "2026-10-26T10:00:00Z", customer_email: "x@y.z" } }, "e1");
    expect((await reconcile(k.hub, conn.id)).missed).toBe(0);
    whop.payments.push({ id: "p3", status: "paid", total: { amount: "250" }, created_at: "2026-10-26T11:00:00Z", paid_at: "2026-10-26T11:00:00Z" });
    expect((await reconcile(k.hub, conn.id)).missed).toBe(1);
    expect((await factsOf(k.store, k.offerId)).map((f) => [f.payload.provider_payment_id, f.source])).toEqual([["p1", "whop"], ["p3", "reconcile"]]);
  });
});

// ---- Fathom -------------------------------------------------------------------------------------------------------------

describe("Fathom", () => {
  const meeting = (x: J = {}): J => ({ recording_id: 77, title: "Ana <> Luis", recording_start_time: "2026-10-26T13:00:00Z", recording_end_time: "2026-10-26T13:30:00Z", calendar_invitees: [{ email: "ana@example.com", is_external: true }, { email: "luis@team.com", is_external: false }], recorded_by: { email: "luis@team.com", name: "Luis" }, share_url: "https://fathom.video/share/x", ...x });

  it("a recording is on the prospect's booking nearest it (within a day); the team's own emails are never the prospect", async () => {
    const k = await connectorKit();
    const conn = await k.state.upsertConnection({ offerId: k.offerId, port: "recording", provider: "fathom", credentials: { webhook_secret: "sec", api_key: "fathom-key" } });
    await known(k, "c1", { email: "ana@example.com" });
    await k.engine.ingest({ offerId: k.offerId, type: "person.added", source: "test", dedupeKey: "p", payload: { person: { id: "u-luis", name: "Luis", email: "luis@team.com", roles: ["closer"] } } });
    await known(k, "c-luis", { email: "luis@team.com" });
    await k.engine.ingest({ offerId: k.offerId, type: "appointment.booked", source: "test", dedupeKey: "b", contactId: "c1", appointmentId: "a1", payload: { appointment: { starts_at: "2026-10-26T13:00:00Z" } } });
    await signed(k, "fathom", conn.id, meeting({ transcript: [{ speaker: { display_name: "Luis" }, text: "hi" }] }), "m1");
    const f = (await factsOf(k.store, k.offerId)).find((x) => x.type === "recording.received")!;
    expect(f).toMatchObject({ contactId: "c1", appointmentId: "a1", dedupeKey: "fathom:recording:77", payload: { recording_id: "fathom:77", recording: { provider: "fathom", external_id: "77", duration_min: 30, has_transcript: true, kind: "meeting" } } });
    // one call, not two: the booked call carries the recording
    expect((await k.store.tx((tx) => tx.projFind("calls", k.offerId))).map((c) => [c.id, c.recordingId])).toEqual([["a1", "fathom:77"]]);
    expect(k.queue.jobs.filter((j) => j.task === "transcript_wait")).toHaveLength(0);
  });

  it("delivered without its transcript: looked for at 1, 3 and 10 minutes; the words come from Fathom when a step asks, never stored", async () => {
    const k = await connectorKit();
    const fathom = new FakeFathom(k.http);
    const conn = await k.state.upsertConnection({ offerId: k.offerId, port: "recording", provider: "fathom", credentials: { webhook_secret: "sec", api_key: "fathom-key" } });
    await known(k, "c1", { email: "ana@example.com" });
    const t0 = k.http.now().getTime();
    await signed(k, "fathom", conn.id, meeting(), "m1");
    await k.runJobs(new Date(t0 + 2 * 60_000));
    fathom.transcripts.set("77", [{ speaker: { display_name: "Luis" }, text: "Welcome, Ana" }]);
    await k.runJobs(new Date(t0 + 30 * 60_000));
    expect(k.http.to("GET", /\/transcript$/).map((r) => Math.round((r.at.getTime() - t0) / 60_000))).toEqual([1, 4]);
    expect((await factsOf(k.store, k.offerId)).at(-1)!.type).toBe("recording.transcript_ready");
    expect(await connectorReads(k.hub).transcripts!(k.offerId, ["fathom:77", "ghl:nope"])).toEqual({ "fathom:77": "Luis: Welcome, Ana" });
  });
});

// ---- Typeform -------------------------------------------------------------------------------------------------------------

describe("Typeform", () => {
  it("a form the connection does not map is kept and read as nothing; each answer kind is read as words", async () => {
    const k = await connectorKit();
    const conn = await k.state.upsertConnection({ offerId: k.offerId, port: "forms", provider: "typeform", config: { forms: { F1: { answers: { r1: "email", r2: "income", r3: "has_children", r4: "goals", r5: "age" } } } }, credentials: { webhook_secret: "tf" } });
    const send = async (body: J) => {
      const raw = JSON.stringify(body);
      const res = await door(k.hub, "typeform", conn.id, new Request("https://x", { method: "POST", body: raw, headers: { "typeform-signature": signTypeform("tf", raw) } }));
      await k.runJobs();
      return res;
    };
    await send({ event_id: "e0", event_type: "form_response", form_response: { form_id: "OTHER", token: "t0", answers: [] } });
    expect((await k.state.unprocessed()).length).toBe(0);
    await send({ event_id: "e1", event_type: "form_response", form_response: { form_id: "F1", token: "t1", submitted_at: "2026-10-26T13:00:00Z", answers: [
      { field: { ref: "r1" }, type: "email", email: "a@b.c" }, { field: { ref: "r2" }, type: "choice", choice: { other: "about 90k" } }, { field: { ref: "r3" }, type: "boolean", boolean: false },
      { field: { ref: "r4" }, type: "choices", choices: { labels: ["Love", "Kids"] } }, { field: { ref: "r5" }, type: "number", number: 34 },
    ] } });
    const facts = await factsOf(k.store, k.offerId);
    expect(facts.map((f) => f.type)).toEqual(["form.submitted"]);
    expect(facts[0]!.payload).toMatchObject({ form_id: "F1", response_id: "t1", contact: { email: "a@b.c" }, fields: { income: "about 90k", has_children: "No", goals: "Love, Kids", age: "34" } });
  });
});

// ---- Calendly -------------------------------------------------------------------------------------------------------------

describe("Calendly", () => {
  async function cal(mode: "webhook" | "polling", config: J = {}) {
    const k = await connectorKit();
    const fake = new FakeCalendly(k.http);
    const conn = await k.state.upsertConnection({ offerId: k.offerId, port: "scheduling", provider: "calendly", mode, externalId: "https://api.calendly.com/organizations/ORG1", config: { questions: { setter: "Who set this call?" }, ...config }, credentials: { token: "cal-token", webhook_secret: "ck" } });
    await k.state.setFieldMap([{ offerId: k.offerId, provider: "calendly", object: "calendar", canonicalField: "closing", providerFieldId: "ET1", valueType: "id", options: {} }]);
    return { k, fake, conn };
  }

  it("a paid plan's signed webhook: booked (with the setter's answer and the call type), cancelled as rescheduled, a no-show (the envelope is unverified)", async () => {
    const { k, fake, conn } = await cal("webhook");
    await known(k, "c1", { email: "ana@example.com" });
    const { event, invitee } = fake.book("EV1", { email: "ana@example.com", start: "2026-10-28T15:00:00Z", setter: "Mia", at: "2026-10-26T13:00:00Z" });
    const send = async (body: J) => {
      const raw = JSON.stringify(body);
      const res = await door(k.hub, "calendly", conn.id, new Request("https://x", { method: "POST", body: raw, headers: { "calendly-webhook-signature": signCalendly("ck", Math.floor(k.http.now().getTime() / 1000), raw) } }));
      expect(res.status).toBe(200);
      await k.runJobs();
    };
    await send({ event: "invitee.created", created_at: "2026-10-26T13:00:00Z", payload: { ...invitee, scheduled_event: event } });
    await send({ event: "invitee_no_show.created", created_at: "2026-10-28T15:20:00Z", payload: { uri: "https://api.calendly.com/invitee_no_shows/n1", invitee: invitee.uri } });
    await send({ event: "invitee.canceled", created_at: "2026-10-28T16:00:00Z", payload: { ...invitee, status: "canceled", rescheduled: true, new_invitee: "https://api.calendly.com/scheduled_events/EV2/invitees/i2", scheduled_event: { ...event, status: "canceled" }, cancellation: { canceled_by: "Ana", reason: "moving it" } } });
    const facts = await factsOf(k.store, k.offerId);
    expect(facts.slice(1).map((f) => f.type)).toEqual(["appointment.booked", "appointment.status_changed", "appointment.cancelled"]);
    expect(facts[1]).toMatchObject({ contactId: "c1", appointmentId: "EV1", payload: { appointment: { kind: "closing", set_by: "Mia", booking_source: "setter", closer: { email: "luis@team.com" }, meeting_url: "https://zoom.us/j/123456789", tracking: { utm_source: "fb" } }, contact: { email: "ana@example.com", first_name: "Ana", last_name: "Lopez", phone: "+15550100001" } } });
    expect(facts[3]!.payload).toMatchObject({ rescheduled: true, rescheduled_to: "EV2", cancellation: { reason: "moving it" } });
  });

  it("a free plan is polled only by exception: without the flag the poll refuses and says so; with it, the same facts as the webhooks", async () => {
    const { k, conn } = await cal("polling");
    expect((await pollCalendly(k.hub, conn)).refused).toMatch(/no free-plan exception/);
    expect(k.http.requests).toHaveLength(0);
    expect((await k.store.tx((tx) => tx.alerts({ open: true })))[0]!.kind).toBe("connection_config");

    const ok = await cal("polling", { free_plan_exception: { by: "Tyler", at: "2026-10-21", why: "trial client" } });
    const at = ok.k.http.now().toISOString();
    const { event, invitee } = ok.fake.book("EV1", { email: "ana@example.com", start: "2026-10-28T15:00:00Z", at });
    await pollCalendly(ok.k.hub, ok.conn);
    ok.fake.events.get("EV1")!.status = "canceled";
    ok.fake.events.get("EV1")!.updated_at = new Date(ok.k.http.now().getTime() + 1000).toISOString();
    ok.k.http.advance(120_000);
    await pollCalendly(ok.k.hub, ok.conn);
    const polled = (await factsOf(ok.k.store, ok.k.offerId)).map((f) => [f.type, f.dedupeKey]);
    expect(polled).toEqual([["appointment.booked", "calendly:EV1:booked"], ["appointment.cancelled", "calendly:EV1:cancelled"]]);
    // the webhook path's keys for the same booking are the same
    const n = await normalizeCalendly(ok.k.hub, ok.conn, { event: "invitee.created", created_at: at, payload: { ...invitee, scheduled_event: event } });
    expect(n.facts[0]!.dedupeKey).toBe("calendly:EV1:booked");
    expect(ok.k.queue.jobs.find((j) => j.task === "calendly_poll")).toBeTruthy();
  });
});

// ---- the generic door ---------------------------------------------------------------------------------------------------

describe("the generic signed door", () => {
  it("emits the configured fact with only the mapped keys; a replayed Zap (same transaction id) is one fact", async () => {
    const k = await connectorKit();
    const conn = await k.state.upsertConnection({ offerId: k.offerId, port: "forms", provider: "generic", config: { emits: "fact", type: "lead.created", map: { email: "who.email", source: "src" }, dedupe: "id" }, credentials: { webhook_secret: "sec" } });
    await signed(k, "generic", conn.id, { id: "z1", who: { email: "a@b.c", ssn: "never read" }, src: "zapier" }, "d1");
    await signed(k, "generic", conn.id, { id: "z1", who: { email: "a@b.c" }, src: "zapier" }, "d2");
    const facts = await factsOf(k.store, k.offerId);
    expect(facts).toEqual([expect.objectContaining({ type: "lead.created", dedupeKey: `generic:${conn.id}:z1`, payload: { email: "a@b.c", source: "zapier" } })]);
  });
  it("a door with no field map reads nothing", async () => {
    const k = await connectorKit();
    const conn = await k.state.upsertConnection({ offerId: k.offerId, port: "forms", provider: "generic", credentials: { webhook_secret: "sec" } });
    await signed(k, "generic", conn.id, { id: "z1" }, "d1");
    expect(await factsOf(k.store, k.offerId)).toEqual([]);
    expect((await k.state.delivery(1))?.processedAt ?? (await k.state.unprocessed()).length === 0).toBeTruthy();
  });
});

// ---- the engine, end to end, through a connector --------------------------------------------------------------------------

describe("a workflow through the GHL connector", () => {
  it("a booking's webhook starts a run; its tag step reaches GHL; GHL's echo of that tag is the platform's, so it starts nothing", async () => {
    const k = await connectorKit();
    await k.connectGhl();
    const g = k.ghl;
    g.seedContact({ id: "c1", locationId: "LOC1", email: "ana@example.com", phone: "+15550100001", tags: [] });
    const wf = (id: string, on: J, tags: string[]) => ({ schema: 2, id, name: id, reentry: { policy: "always" }, nodes: [{ id: "t1", type: "trigger@1", title: "Start", on }, { id: "a1", type: "action@1", title: "Tag", action: "crm.add_tag", params: { tags } }, { id: "x1", type: "end@1", title: "End", reason: "done" }], edges: [{ from: "t1", to: "a1" }, { from: "a1", to: "x1" }] });
    await install(k.store, k.offerId, wf("booked", { event: "appointment.booked" }, ["booked"]), { now: k.http.now(), delivery: "live", crmWrites: "real" });
    // a workflow on that tag: v1's double-fire bug was an engine-written tag starting a second run
    const onTag = await install(k.store, k.offerId, wf("on-tag", { event: "tag.added", match: { eq: ["{{event.by}}", "crm"] } }, ["followed"]), { now: k.http.now(), delivery: "live", crmWrites: "real" });
    const deliver = async (body: J) => { const r = await k.state.recordDelivery({ source: "ghl", deliveryId: crypto.randomUUID(), eventType: String(body.type), locationId: "LOC1", connectionId: null, offerId: null, headers: {}, body: JSON.stringify(body), receivedAt: k.http.now() }); return processDelivery(k.hub, r.id); };
    await deliver({ type: "ContactCreate", locationId: "LOC1", ...g.contactJson("c1") });
    g.seedAppointment({ id: "a1", locationId: "LOC1", contactId: "c1", calendarId: "CAL1" });
    await deliver({ type: "AppointmentCreate", locationId: "LOC1", appointment: g.apptJson("a1") });
    await k.engine.runDue();
    expect(g.contacts.get("c1")!.tags).toEqual(["booked"]);
    const [row] = await k.store.tx((tx) => tx.outboxRows({ offerId: k.offerId }));
    expect(row).toMatchObject({ kind: "crm.add_tag", status: "sent" });
    k.http.advance(5_000);
    await deliver({ type: "ContactTagUpdate", locationId: "LOC1", ...g.contactJson("c1") });
    const all = await factsOf(k.store, k.offerId);
    const tagFact = all.find((f) => f.type === "tag.added")!;
    expect(tagFact.payload).toMatchObject({ tag: "booked", by: "platform" });
    await k.engine.runDue();
    const runsOf = async () => (await k.store.tx((tx) => tx.runs({ workflowId: onTag.id }))).length;
    expect(await runsOf()).toBe(0);
    // a tag a person adds in GHL does start it
    k.http.advance(60_000);
    Object.assign(g.contacts.get("c1")!, { tags: ["booked", "vip"], dateUpdated: k.http.now().toISOString() });
    await deliver({ type: "ContactTagUpdate", locationId: "LOC1", ...g.contactJson("c1") });
    await k.engine.runDue();
    expect(await runsOf()).toBe(1);
    expect(g.contacts.get("c1")!.tags).toEqual(["booked", "vip", "followed"]);
  });
});
