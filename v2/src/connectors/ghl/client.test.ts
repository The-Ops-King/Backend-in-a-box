import { describe, expect, it } from "vitest";
import { PortError } from "@/engine/ports";
import { connectorKit } from "../testkit/kit";
import { USER_AGENT, versionFor } from "./api";
import { ghlApi, ghlPortsFor } from "./index";
import { targetOf } from "./api";
import { refreshDue, refreshLocation } from "./auth";

const call = { offerId: "", idempotencyKey: "k1" };

describe("the GHL client", () => {
  it("sets the Version header per endpoint family", () => {
    expect(versionFor("/calendars/events")).toBe("2021-04-15");
    expect(versionFor("/calendars/events/appointments/a1")).toBe("2021-04-15");
    expect(versionFor("/conversations/messages")).toBe("2021-04-15");
    expect(versionFor("/conversations/search")).toBe("2021-04-15");
    expect(versionFor("/contacts/c1")).toBe("2021-07-28");
    expect(versionFor("/opportunities/search")).toBe("2021-07-28");
    expect(versionFor("/objects/custom_objects.x/records")).toBe("2021-07-28");
    expect(versionFor("/proposals/document")).toBe("2021-07-28");
  });

  it("sends a browser-like user agent and the right version, so GHL (and its Cloudflare) answer", async () => {
    const k = await connectorKit();
    const conn = await k.connectGhl();
    const c = k.ghl.seedContact({ locationId: "LOC1", email: "ana@example.com" });
    const ports = await ghlPortsFor(k.hub, conn);
    expect(await ports.crm.getContact({ ...call, offerId: k.offerId }, c.id)).toMatchObject({ id: c.id, email: "ana@example.com" });
    const req = k.http.requests.at(-1)!;
    expect(req.headers["user-agent"]).toBe(USER_AGENT);
    expect(req.headers.version).toBe("2021-07-28");
    await ports.scheduling.setStatus({ ...call, offerId: k.offerId }, { appointmentId: k.ghl.seedAppointment({ locationId: "LOC1", contactId: c.id, calendarId: "CAL1" }).id, status: "showed" });
    expect(k.http.requests.at(-1)!.headers.version).toBe("2021-04-15");
  });

  it("a Cloudflare 1010 refusal is a permanent failure naming the user agent, not an auth pause", async () => {
    const k = await connectorKit();
    const conn = await k.connectGhl();
    k.http.once("GET", /^\/contacts\//, { status: 403, body: "error code: 1010" });
    const e = await ghlApi(k.hub).call(targetOf(conn), { method: "GET", path: "/contacts/x" }).catch((x) => x);
    expect(e).toBeInstanceOf(PortError);
    expect(e).toMatchObject({ failure: "permanent" });
    expect(e.message).toMatch(/1010.*user agent/);
    expect((await k.state.connection(k.offerId, "crm"))!.status).toBe("connected");
  });

  it("keeps each location inside 100 requests per 10 seconds by waiting, never by failing", async () => {
    const k = await connectorKit();
    const conn = await k.connectGhl();
    const c = k.ghl.seedContact({ locationId: "LOC1" });
    const t = targetOf(conn);
    const start = k.http.now().getTime();
    for (let i = 0; i < 250; i++) await ghlApi(k.hub).call(t, { method: "GET", path: `/contacts/${c.id}` });
    expect(k.http.to("GET", `/contacts/${c.id}`)).toHaveLength(250);
    // 250 requests at 100 per 10 s take at least 20 s of waiting, and GHL never answered 429
    expect(k.http.now().getTime() - start).toBeGreaterThanOrEqual(20_000);
    const perWindow = new Map<number, number>();
    for (const r of k.http.requests) { const w = Math.floor((r.at.getTime() - start) / 10_000); perWindow.set(w, (perWindow.get(w) ?? 0) + 1); }
    expect(Math.max(...perWindow.values())).toBeLessThanOrEqual(100);
  });

  it("stops when GHL says none are left (X-RateLimit-Remaining 0) until its window has passed", async () => {
    const k = await connectorKit();
    const conn = await k.connectGhl();
    const c = k.ghl.seedContact({ locationId: "LOC1" });
    k.http.once("GET", `/contacts/${c.id}`, { status: 200, body: { contact: { id: c.id } }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-interval-milliseconds": "10000" } });
    const t = targetOf(conn);
    await ghlApi(k.hub).call(t, { method: "GET", path: `/contacts/${c.id}` });
    const before = k.http.now().getTime();
    await ghlApi(k.hub).call(t, { method: "GET", path: `/contacts/${c.id}` });
    expect(k.http.now().getTime() - before).toBeGreaterThanOrEqual(10_000);
  });

  it("waits out a 429 (Retry-After) and tries again; a read that times out or meets a 5xx is tried again with jitter", async () => {
    const k = await connectorKit();
    const conn = await k.connectGhl();
    const c = k.ghl.seedContact({ locationId: "LOC1" });
    const ports = await ghlPortsFor(k.hub, conn);
    k.http.once("GET", `/contacts/${c.id}`, { status: 429, body: {}, headers: { "retry-after": "2" } });
    k.http.once("GET", `/contacts/${c.id}`, { status: 502, body: "bad gateway" });
    k.http.once("GET", `/contacts/${c.id}`, { timeout: true, sent: true });
    k.http.once("GET", `/contacts/${c.id}`, { status: 503, body: "" });
    // three tries per call: the 429 and the 502 spend two, the timeout the third: transient for the dispatcher to try later
    await expect(ports.crm.getContact({ ...call, offerId: k.offerId }, c.id)).rejects.toMatchObject({ failure: "transient" });
    expect(k.http.waits[0]).toBe(2000);
    // the next call meets the 503, then GHL's real answer
    expect(await ports.crm.getContact({ ...call, offerId: k.offerId }, c.id)).toMatchObject({ id: c.id });
  });

  it("a create that times out is re-read, never sent again blind: found is done, a send that cannot be found is unknown", async () => {
    const k = await connectorKit();
    const conn = await k.connectGhl();
    const ports = await ghlPortsFor(k.hub, conn);
    const ctx = { ...call, offerId: k.offerId };
    // GHL made the contact, then the answer was lost
    k.http.once("POST", "/contacts/", (req) => { k.ghl.seedContact({ locationId: "LOC1", email: (req.body as { email: string }).email }); return { timeout: true, sent: true }; });
    const r = await ports.crm.findOrCreateContact(ctx, null, { match: ["email"], create: true, fillBlank: { email: "new@example.com", first_name: "New" } });
    expect(r.action).toBe("created");
    expect(k.http.to("POST", "/contacts/")).toHaveLength(1);
    expect([...k.ghl.contacts.values()].filter((x) => x.email === "new@example.com")).toHaveLength(1);
    // made, but GHL's search has not caught up: not found is not "not made", so it is unknown, never sent again
    k.http.once("POST", "/contacts/", (req) => { k.ghl.seedContact({ locationId: "LOC1", email: (req.body as { email: string }).email, indexedAt: k.http.now().getTime() }); return { timeout: true, sent: true }; });
    await expect(ports.crm.findOrCreateContact(ctx, null, { match: ["email"], create: true, fillBlank: { email: "lagging@example.com" } })).rejects.toMatchObject({ failure: "ambiguous" });
    expect(k.http.to("POST", "/contacts/")).toHaveLength(2);
    expect([...k.ghl.contacts.values()].filter((x) => x.email === "lagging@example.com")).toHaveLength(1);
    // a text whose answer is lost and that is not in the thread: unknown (the outbox never sends it again)
    const contact = k.ghl.seedContact({ locationId: "LOC1", phone: "+15550100001" });
    k.http.once("POST", "/conversations/messages", { timeout: true, sent: true });
    await expect(ports.messaging.sendSms(ctx, { contactId: contact.id, to: "+15550100001", body: "hi" })).rejects.toMatchObject({ failure: "ambiguous" });
    expect(k.http.to("POST", "/conversations/messages")).toHaveLength(1);
    // one that did go out is found in the thread: done, its id kept
    k.http.once("POST", "/conversations/messages", (req) => { k.ghl.messages.push({ id: "ms-found", conversationId: "cv9", contactId: contact.id, direction: "outbound", messageType: "TYPE_SMS", body: (req.body as { message: string }).message, dateAdded: k.http.now().toISOString() }); return { timeout: true, sent: true }; });
    expect(await ports.messaging.sendSms(ctx, { contactId: contact.id, to: "+15550100001", body: "second" })).toEqual({ id: "ms-found" });
    expect(k.http.to("POST", "/conversations/messages")).toHaveLength(2);
  });

  it("a request that never left (refused) is tried again, even a write", async () => {
    const k = await connectorKit();
    const conn = await k.connectGhl();
    const c = k.ghl.seedContact({ locationId: "LOC1", phone: "+15550100001" });
    k.http.once("POST", "/conversations/messages", { refused: true });
    const ports = await ghlPortsFor(k.hub, conn);
    expect((await ports.messaging.sendSms({ ...call, offerId: k.offerId }, { contactId: c.id, to: "+15550100001", body: "hi" })).id).toMatch(/^ms/);
    expect(k.ghl.messages).toHaveLength(1);
  });
});

describe("GHL auth: OAuth and private token behind one port", () => {
  it("OAuth: a 401 forces one refresh, the request goes again with the new token, and the pair is saved", async () => {
    const k = await connectorKit();
    const conn = await k.connectGhl({ mode: "oauth" });
    const c = k.ghl.seedContact({ locationId: "LOC1" });
    k.ghl.tokens.delete("oauth-token-LOC1");   // GHL no longer takes the token
    const ports = await ghlPortsFor(k.hub, conn);
    expect(await ports.crm.getContact({ ...call, offerId: k.offerId }, c.id)).toMatchObject({ id: c.id });
    expect(k.ghl.refreshCalls).toBe(1);
    const row = (await k.state.ghlToken("LOC1"))!;
    expect(row.accessToken).not.toBe("oauth-token-LOC1");
    expect(row.refreshToken).not.toBe("refresh-LOC1");
    expect(k.ghl.spentRefreshTokens.has("refresh-LOC1")).toBe(true);
  });

  it("OAuth: refused again after the refresh, every offer's GHL connection on that location pauses, with an alert", async () => {
    const k = await connectorKit({ offers: 2 });
    const conn = await k.connectGhl({ offerId: k.offers[0] });
    await k.connectGhl({ offerId: k.offers[1] });
    k.http.on("GET", /^\/contacts\//, { status: 401, body: { message: "Invalid JWT" } });
    const ports = await ghlPortsFor(k.hub, conn);
    await expect(ports.crm.getContact({ ...call, offerId: k.offers[0]! }, "c1")).rejects.toMatchObject({ failure: "auth" });
    expect(k.ghl.refreshCalls).toBe(1);
    for (const o of k.offers) for (const port of ["crm", "messaging", "scheduling", "esign"]) expect((await k.state.connection(o, port))!.status).toBe("paused");
    const alerts = await k.store.tx((tx) => tx.alerts({ open: true }));
    expect(alerts.map((a) => a.offerId).sort()).toEqual([...k.offers].sort());
  });

  it("private token: nothing to refresh; a 401 pauses only that offer's GHL connection", async () => {
    const k = await connectorKit({ offers: 2 });
    const conn = await k.connectGhl({ offerId: k.offers[0], mode: "pit", token: "pit-1", locationId: "LOC1" });
    await k.connectGhl({ offerId: k.offers[1], mode: "pit", token: "pit-2", locationId: "LOC1" });
    k.ghl.tokens.delete("pit-1");
    const ports = await ghlPortsFor(k.hub, conn);
    await expect(ports.crm.getContact({ ...call, offerId: k.offers[0]! }, "c1")).rejects.toMatchObject({ failure: "auth" });
    expect(k.ghl.refreshCalls).toBe(0);
    expect((await k.state.connection(k.offers[0]!, "crm"))!.status).toBe("paused");
    expect((await k.state.connection(k.offers[1]!, "crm"))!.status).toBe("connected");
  });

  it("the same port answers in either mode: nothing above the connector knows which", async () => {
    for (const mode of ["oauth", "pit"] as const) {
      const k = await connectorKit();
      const conn = await k.connectGhl({ mode });
      const c = k.ghl.seedContact({ locationId: "LOC1", email: "a@b.c" });
      const ports = await ghlPortsFor(k.hub, conn);
      expect(await ports.crm.getContact({ ...call, offerId: k.offerId }, c.id)).toMatchObject({ id: c.id, email: "a@b.c" });
    }
  });

  it("the refresh job renews a token with less than 4 hours left, and leaves one with more alone", async () => {
    const k = await connectorKit();
    await k.connectGhl({ locationId: "LOC1", expiresInMs: 3 * 3_600_000 });
    await k.connectGhl({ locationId: "LOC2", offerId: k.offerId, expiresInMs: 10 * 3_600_000 });
    const r = await refreshDue(k.hub);
    expect(r.refreshed).toEqual(["LOC1"]);
    expect((await k.state.ghlToken("LOC1"))!.expiresAt.getTime()).toBeGreaterThan(k.http.now().getTime() + 23 * 3_600_000);
    expect((await k.state.ghlToken("LOC2"))!.accessToken).toBe("oauth-token-LOC2");
    // it runs again four hours before the next expiry, at most an hour away
    expect(k.queue.jobs.find((j) => j.task === "ghl_refresh")!.runAt.getTime()).toBeLessThanOrEqual(k.http.now().getTime() + 3_600_000);
  });

  it("two refreshes at once spend the single-use refresh token once: the second finds the new token and uses it", async () => {
    const k = await connectorKit();
    await k.connectGhl({ locationId: "LOC1" });
    const [a, b] = await Promise.all([refreshLocation(k.hub, "LOC1", "oauth-token-LOC1"), refreshLocation(k.hub, "LOC1", "oauth-token-LOC1")]);
    expect(k.ghl.refreshCalls).toBe(1);
    expect(a).toBe(b);
    expect((await k.state.ghlToken("LOC1"))!.status).toBe("connected");
  });

  it("a refresh whose answer is lost leaves the location needing a reinstall: its work is held and Tyler is told", async () => {
    const k = await connectorKit();
    await k.connectGhl({ locationId: "LOC1" });
    k.ghl.loseNextRefresh = true;
    expect(await refreshLocation(k.hub, "LOC1", "oauth-token-LOC1")).toBeNull();
    expect((await k.state.ghlToken("LOC1"))!.status).toBe("needs_reinstall");
    expect((await k.state.connection(k.offerId, "crm"))!.status).toBe("needs_reinstall");
    const [alert] = await k.store.tx((tx) => tx.alerts({ open: true }));
    expect(alert!.message).toMatch(/needs reinstall.*Reinstall the GHL app/);
    // nothing tries the spent token again
    expect(k.ghl.refreshCalls).toBe(1);
  });
});
