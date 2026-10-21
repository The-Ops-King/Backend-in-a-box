import crypto from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, db } from "@/db/client";
import { connectorKit, factsOf } from "./testkit/kit";
import { refreshLocation, resumeLocation } from "./ghl/auth";
import { ghlPortsFor } from "./ghl";
import { signStandardWebhook } from "./framework/signatures";
import { door } from "./doors";
import { processDelivery } from "./registry";

/** The connectors on Postgres: the row lock, sealed credentials, the shared connections table, the inbox. */
describe.skipIf(!process.env.DATABASE_URL)("connectors on Postgres", () => {
  afterAll(closeDb);

  it("two workers refreshing one location at once spend its single-use refresh token once (select ... for update)", async () => {
    const k = await connectorKit({ pg: true });
    await k.connectGhl({ locationId: "LOC1" });
    const results = await Promise.all([1, 2, 3].map(() => refreshLocation(k.hub, "LOC1", "oauth-token-LOC1")));
    expect(k.ghl.refreshCalls).toBe(1);
    expect(new Set(results).size).toBe(1);
    const row = (await k.state.ghlToken("LOC1"))!;
    expect(row.accessToken).toBe(results[0]);
    expect(k.ghl.refreshTokens.has(row.refreshToken)).toBe(true);
  });

  it("credentials and tokens are sealed at rest", async () => {
    const k = await connectorKit({ pg: true });
    await k.connectGhl({ mode: "pit", token: "pit-secret-123" });
    const rows = await db().execute(sql`select credentials_enc from connections where provider = 'ghl'`);
    for (const r of rows.rows as { credentials_enc: string }[]) expect(r.credentials_enc).not.toContain("pit-secret-123");
    expect((await k.state.connection(k.offerId, "crm"))!.credentials.token).toBe("pit-secret-123");
  });

  it("the engine's pause of a port and the connection's status are one row: an auth failure holds the port; a reinstall resumes it", async () => {
    const k = await connectorKit({ pg: true });
    const conn = await k.connectGhl();
    k.http.on("GET", /^\/contacts\//, { status: 401, body: {} });
    await expect((await ghlPortsFor(k.hub, conn)).crm.getContact({ offerId: k.offerId, idempotencyKey: "x" }, "c1")).rejects.toMatchObject({ failure: "auth" });
    expect((await k.store.tx((tx) => tx.connection(k.offerId, "crm")))!.status).toBe("paused");
    expect(await resumeLocation(k.hub, "LOC1")).toEqual([k.offerId]);
    expect((await k.store.tx((tx) => tx.connection(k.offerId, "crm")))!.status).toBe("connected");
    expect(await k.store.tx((tx) => tx.alerts({ open: true }))).toEqual([]);
  });

  it("a door keeps a delivery once in the inbox, and its job reads it into facts once", async () => {
    const k = await connectorKit({ pg: true });
    const secret = `whsec_${crypto.randomBytes(24).toString("base64")}`;
    const conn = await k.state.upsertConnection({ offerId: k.offerId, port: "payments", provider: "whop", credentials: { webhook_secret: secret } });
    const raw = JSON.stringify({ type: "payment.succeeded", data: { id: "pay_1", total: { amount: "99.50" }, customer_email: "a@b.c", paid_at: "2026-10-26T13:00:00Z" } });
    const t = Math.floor(k.http.now().getTime() / 1000);
    const send = () => door(k.hub, "whop", conn.id, new Request("https://x", { method: "POST", body: raw, headers: { "webhook-id": "msg_1", "webhook-timestamp": String(t), "webhook-signature": signStandardWebhook(secret, "msg_1", t, raw) } }));
    expect(await (await send()).json()).toEqual({ ok: true, duplicate: false });
    expect(await (await send()).json()).toEqual({ ok: true, duplicate: true });
    const rows = await db().execute(sql`select id, source, delivery_id, connection_id, offer_id from inbox`);
    expect(rows.rows).toEqual([expect.objectContaining({ source: "whop", delivery_id: `${conn.id}:msg_1`, connection_id: conn.id, offer_id: k.offerId })]);
    await k.runJobs();
    const id = Number((rows.rows[0] as { id: number }).id);
    expect(await processDelivery(k.hub, id)).toBe("already read");
    expect((await factsOf(k.store, k.offerId)).map((f) => [f.type, f.payload.amount])).toEqual([["payment.unlinked", 99.5]]);
  });

  it("echoes, entity versions, agreement checks and transcript waits round-trip", async () => {
    const k = await connectorKit({ pg: true });
    const at = k.http.now();
    await k.state.addEcho({ offerId: k.offerId, provider: "ghl", entity: "contact", entityId: "c1", change: { tag_added: "x" }, outboxKey: "o", createdAt: at, expiresAt: new Date(at.getTime() + 60_000) });
    const e = await k.state.findEcho({ offerId: k.offerId, provider: "ghl", entity: "contact", entityId: "c1", change: { tag_added: "x", other: 1 }, at });
    expect(e).toBeDefined();
    await k.state.markEcho(e!, at);
    expect(await k.state.findEcho({ offerId: k.offerId, provider: "ghl", entity: "contact", entityId: "c1", change: { tag_added: "x" }, at })).toBeUndefined();
    await k.state.putVersion({ offerId: k.offerId, provider: "ghl", kind: "contact", entityId: "c1", versionAt: at, state: { tags: ["a"] }, updatedAt: at });
    expect((await k.state.version(k.offerId, "ghl", "contact", "c1"))!.state).toEqual({ tags: ["a"] });
    const conn = await k.connectGhl();
    const a = await k.state.addAgreementCheck({ offerId: k.offerId, connectionId: conn.id, locationId: "LOC1", agreementId: "d1", contactId: "c1", name: null, sentAt: at, nextCheckAt: at });
    expect((await k.state.addAgreementCheck({ offerId: k.offerId, connectionId: conn.id, locationId: "LOC1", agreementId: "d1", contactId: "c1", name: null, sentAt: at, nextCheckAt: at })).id).toBe(a.id);
    await k.state.updateAgreementCheck(a.id, { status: "signed", settledAt: at });
    expect(await k.state.agreementChecks({ status: "waiting" })).toEqual([]);
    const w = await k.state.addTranscriptWait({ offerId: k.offerId, connectionId: conn.id, provider: "ghl", recordingId: "m1", tries: 0, nextAt: at, status: "waiting", fact: {}, updatedAt: at });
    expect(await k.state.addTranscriptWait({ offerId: k.offerId, connectionId: conn.id, provider: "ghl", recordingId: "m1", tries: 0, nextAt: at, status: "waiting", fact: {}, updatedAt: at })).toBeUndefined();
    expect((await k.state.transcriptWait(w!.id))!.status).toBe("waiting");
  });

  it("the migration turned the engine's old pause states into the connection's", async () => {
    const r = await db().execute(sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'connections_status'`);
    expect(String((r.rows[0] as { def: string }).def)).toMatch(/connected.*paused.*needs_reinstall.*uninstalled/);
  });
});
