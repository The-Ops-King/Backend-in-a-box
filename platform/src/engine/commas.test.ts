/** D319: Commas payments into the ledger: the transaction list is the record, read every 10 minutes; a webhook only asks for a read. */
import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "./crypto";
import { loadCompany } from "./context";
import { fakeAdapters } from "./test-install";
import { commasFailedInput, commasPaymentInputs, commasPhone, verifyCommasSignature, type CommasTransaction } from "@/adapters/commas/client";
import { importCommasHistory, syncCommas } from "./commas";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const tx = (id: number, email: string, amount: number, when: string, o: Partial<CommasTransaction> = {}): CommasTransaction => ({ id, transaction_date: when, amount, fan: { id: `fan${id}`, name: "X", email, phone: "3055550100", country_code: "1" }, service: { id: "NLxj6", title: "VIP Matchmaking", price: "5000" }, servicePayment: { id: "sp", payment_type: "onetime" }, refunds: [], ...o });

describe("D319: Commas, read as the ledger wants it", () => {
  it("a transaction is a payment keyed by its id, its refunds negative rows of their own; the product's name rides along", () => {
    const [p, r] = commasPaymentInputs(tx(919049, "ana@x.com", 2000, "2026-11-05T15:00:00Z", { refunds: [{ id: "d8Kw2", amount: 500, created_at: "2026-11-06T10:00:00Z", status: "success" }] }));
    expect(p).toMatchObject({ provider: "commas", providerPaymentId: "919049", amount: 2000, status: "succeeded", email: "ana@x.com", phone: "+13055550100", memberId: "fan919049", raw: { product_name: "VIP Matchmaking", product_id: "NLxj6" } });
    expect(r).toMatchObject({ providerPaymentId: "919049:refund:d8Kw2", amount: -500, status: "refunded", raw: { payment_id: "919049" } });
    expect(commasPhone("13055550100", "1")).toBe("+13055550100");
    expect(commasPhone(null, "1")).toBeUndefined();
  });
  it("the signature is HMAC-SHA256 of the raw body, hex; anything else is refused", () => {
    const body = '{"id":"e1","type":"payment.succeeded"}', sig = createHmac("sha256", "whsk_x").update(body).digest("hex");
    expect(verifyCommasSignature("whsk_x", body, sig)).toBe(true);
    expect(verifyCommasSignature("whsk_x", body + " ", sig)).toBe(false);
    expect(verifyCommasSignature("whsk_y", body, sig)).toBe(false);
    expect(verifyCommasSignature("whsk_x", body, null)).toBe(false);
    expect(verifyCommasSignature("whsk_x", body, "zz")).toBe(false);
  });
  it("a failed charge comes from its webhook, keyed by its order id", () => {
    expect(commasFailedInput({ id: "e2", type: "payment.failed", data: { payment_id: "ORD-1", customer_id: "user_1", failure_reason: "card_declined", timestamp: "2026-11-05T15:00:00Z" } }))
      .toMatchObject({ provider: "commas", providerPaymentId: "ORD-1", status: "failed", memberId: "user_1", raw: { failure_reason: "card_declined" } });
    expect(commasFailedInput({ id: "e3", type: "payment.succeeded", data: {} })).toBeNull();
  });
});

let co: string;
// GHL decides the buyer (D270): its contact search finds Ana by her email
const ghl = () => { const b = fakeAdapters(); return { ...b, read: { ...b.read, findDuplicate: async (_c: unknown, q: { email?: string }) => (q.email === "ana@x.com" ? { id: "GANA", email: "ana@x.com", firstName: "Ana", tags: [], customFields: {}, dateAdded: "2026-10-01T00:00:00Z", dateUpdated: "2026-10-01T00:00:00Z" } : null) } } as unknown as ReturnType<typeof fakeAdapters>; };
const loaded = () => asOperator(async (c) => { const l = await loadCompany(c, co); return { row: l.row, adapterCompany: l.adapterCompany, bindings: l.bindings }; });
describe.skipIf(!process.env.DATABASE_URL)("D319: the Commas read", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const old = await one<{ id: string }>(c, "select id from companies where slug='commasco'");
      if (old) { for (const t of ["events", "payments", "opportunities", "alerts", "audit_log", "contact_identifiers", "contacts", "bindings"]) await c.query(`delete from ${t} where company_id=$1`, [old.id]); await c.query("delete from engine_state where key like $1", [`commas_%:${old.id}`]); await c.query("delete from companies where id=$1", [old.id]); }
      co = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, status) values ('Commas Co','commasco','UTC','active') returning id"))!.id;
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'secret.commas_api_key','secret',$2)", [co, encrypt("ck")]);
      const ana = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GANA','Ana') returning id", [co]))!.id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','ana@x.com')", [co, ana]);
    });
  });

  it("the first read only marks where reading starts; then a new payment is recorded once, linked; a repeat is a duplicate", async () => {
    const list = async () => [tx(1001, "ana@x.com", 2000, new Date().toISOString())];
    const first = await asOperator(async (c) => syncCommas(c, await loaded(), ghl(), new Date(), list));
    expect(first).toMatchObject({ baseline: true, recorded: 0 });
    const second = await asOperator(async (c) => syncCommas(c, await loaded(), ghl(), new Date(), list));
    expect(second).toMatchObject({ recorded: 1, linked: 1, unlinked: 0 });
    const rows = await asOperator((c) => many<{ provider: string; whop_payment_id: string; link_status: string; amount: string }>(c, "select provider, whop_payment_id, link_status, amount from payments where company_id=$1", [co]));
    expect(rows).toEqual([{ provider: "commas", whop_payment_id: "1001", link_status: "linked", amount: "2000.00" }]);
    expect(await asOperator(async (c) => syncCommas(c, await loaded(), ghl(), new Date(), list))).toMatchObject({ recorded: 0, duplicates: 1 });
  });

  it("a read that fails changes nothing; three in a row is an alert, closed by the next read that works", async () => {
    const down = async (): Promise<CommasTransaction[]> => { throw new Error("commas 503 on /checkout-sessions/transactions"); };
    for (let i = 0; i < 3; i++) expect(await asOperator(async (c) => syncCommas(c, await loaded(), fakeAdapters(), new Date(), down))).toMatchObject({ error: expect.stringMatching(/503/) });
    const open = () => asOperator((c) => one<{ resolved_at: Date | null }>(c, "select resolved_at from alerts where company_id=$1 and key='commas:read' order by first_seen desc limit 1", [co]));
    expect((await open())?.resolved_at).toBeNull();
    await asOperator(async (c) => syncCommas(c, await loaded(), fakeAdapters(), new Date(), async () => []));
    expect((await open())?.resolved_at).not.toBeNull();
  });

  it("history: the dry run says what it would add and adds nothing; the import records rows only and starts nothing", async () => {
    const list = async () => [tx(1001, "ana@x.com", 2000, "2026-11-05T15:00:00Z"), tx(900, "nobody@x.com", 250, "2026-10-03T15:00:00Z")];
    const dry = await asOperator(async (c) => importCommasHistory(c, await loaded(), new Date("2026-10-01"), true, list));
    expect(dry.rows.map((r) => [r.id, r.result])).toEqual([["900", "would record"], ["1001", "already recorded"]]);
    expect(await asOperator((c) => many(c, "select 1 from payments where company_id=$1 and whop_payment_id='900'", [co]))).toHaveLength(0);
    const events = async () => Number((await asOperator((c) => one<{ n: string }>(c, "select count(*) n from runs where company_id=$1", [co])))!.n);
    const before = await events();
    const done = await asOperator(async (c) => importCommasHistory(c, await loaded(), new Date("2026-10-01"), false, list));
    expect(done.rows.map((r) => [r.id, r.result])).toEqual([["900", "recorded, unlinked"], ["1001", "already recorded"]]);
    expect(await events()).toBe(before);
  });
});
