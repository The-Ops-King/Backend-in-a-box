import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db/client";
import { ghlConnections, inbox } from "@/db/schema";
import { freshDb } from "@/test/db";
import { open, seal } from "@/lib/secrets";
import { verifyGhlSignature } from "./signature";
import { connectLocation } from "./oauth";
import { POST } from "../../app/in/ghl/route";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const sign = (body: string) => crypto.sign(null, Buffer.from(body), privateKey).toString("base64");
const deliver = (body: string, signature: string | null) =>
  POST(new Request("http://x/in/ghl", { method: "POST", headers: { "content-type": "application/json", ...(signature ? { "x-ghl-signature": signature } : {}) }, body }));

describe("GHL signature", () => {
  it("accepts GHL's signature over the exact body and nothing else", () => {
    const body = JSON.stringify({ type: "ContactCreate", webhookId: "w1" });
    expect(verifyGhlSignature(body, sign(body), pem)).toBe(true);
    expect(verifyGhlSignature(body + " ", sign(body), pem)).toBe(false);
    expect(verifyGhlSignature(body, null, pem)).toBe(false);
    expect(verifyGhlSignature(body, "not-base64-at-all", pem)).toBe(false);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("POST /in/ghl", () => {
  beforeAll(() => { process.env.GHL_WEBHOOK_PUBLIC_KEY = pem; });
  beforeEach(freshDb);
  afterAll(closeDb);

  it("keeps a signed delivery exactly as it arrived, once, however often GHL retries it", async () => {
    const body = JSON.stringify({ type: "AppointmentCreate", webhookId: "w-42", locationId: "LOC1", appointment: { id: "a1" } });
    const first = await deliver(body, sign(body));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, duplicate: false });
    expect(await (await deliver(body, sign(body))).json()).toEqual({ ok: true, duplicate: true });
    const rows = await db().select().from(inbox);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "ghl", deliveryId: "w-42", eventType: "AppointmentCreate", locationId: "LOC1", body });
  });

  it("refuses an unsigned or wrongly signed delivery and keeps nothing", async () => {
    const body = JSON.stringify({ type: "ContactCreate", webhookId: "w-1" });
    expect((await deliver(body, null)).status).toBe(401);
    expect((await deliver(body, sign("something else"))).status).toBe(401);
    expect(await db().select().from(inbox)).toHaveLength(0);
  });

  it("a delivery without a webhookId is still kept once, by its body", async () => {
    const body = JSON.stringify({ type: "ContactUpdate", id: "c1" });
    await deliver(body, sign(body));
    await deliver(body, sign(body));
    const rows = await db().select().from(inbox);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveryId).toMatch(/^sha256:/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("GHL install", () => {
  beforeAll(() => {
    process.env.TOKEN_KEY = crypto.randomBytes(32).toString("base64");
    Object.assign(process.env, { GHL_CLIENT_ID: "cid", GHL_CLIENT_SECRET: "csecret", GHL_REDIRECT_URI: "https://app.example/ghl/oauth/callback" });
  });
  beforeEach(freshDb);
  afterAll(closeDb);

  it("exchanges the code for the location's tokens and keeps them sealed; installing again replaces them", async () => {
    const sent: URLSearchParams[] = [];
    const fake = (access: string) => (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(init!.body as URLSearchParams);
      return new Response(JSON.stringify({ access_token: access, refresh_token: `r-${access}`, expires_in: 86399, scope: "contacts.readonly", locationId: "LOC9", companyId: "CO1", userId: "U1" }), { status: 200 });
    }) as typeof fetch;
    expect(await connectLocation("code-1", fake("access-token-1"))).toEqual({ locationId: "LOC9" });
    expect(Object.fromEntries(sent[0]!)).toEqual({ client_id: "cid", client_secret: "csecret", grant_type: "authorization_code", code: "code-1", user_type: "Location", redirect_uri: "https://app.example/ghl/oauth/callback" });
    await connectLocation("code-2", fake("access-token-2"));
    const rows = await db().select().from(ghlConnections).where(eq(ghlConnections.locationId, "LOC9"));
    expect(rows).toHaveLength(1);
    // the token is nowhere in the sealed value; it has a "-", which base64 never writes, so random ciphertext cannot
    // contain it by chance (a two-letter token did, about one run in a hundred)
    expect(rows[0]!.accessTokenEnc).not.toContain("access-token-2");
    expect(open(rows[0]!.accessTokenEnc)).toBe("access-token-2");
    expect(rows[0]).toMatchObject({ companyId: "CO1", installedBy: "U1", status: "connected", needsReview: true });
  });

  it("a code GHL refuses saves nothing", async () => {
    const refuse = (async () => new Response("invalid_grant", { status: 400 })) as typeof fetch;
    await expect(connectLocation("bad", refuse)).rejects.toThrow(/refused the code \(400\)/);
    expect(await db().select().from(ghlConnections)).toHaveLength(0);
  });
});

describe("sealed tokens", () => {
  it("open(seal(x)) is x, and a tampered value does not open", () => {
    process.env.TOKEN_KEY = crypto.randomBytes(32).toString("base64");
    const s = seal("secret-token");
    expect(open(s)).toBe("secret-token");
    const [iv, tag, data] = s.split(".");
    expect(() => open([iv, tag, Buffer.from("x").toString("base64") + data].join("."))).toThrow();
  });
});
