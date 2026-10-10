/** The ledger: identity ladder, unlinked payments, healing, manual linking, derived kinds, idempotency, webhook verification. */
import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { recordPayment, linkPayment, deriveKind, resolvePayer, unlinkedPayments } from "./payments";
import { verifyWhopSignature, parseWhopEvent } from "./webhooks/whop";
import { parseZapierPayment } from "./webhooks/zapier";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId: string, ann: string, bob: string;
const pay = (id: string, over: Record<string, unknown> = {}) => ({ providerPaymentId: id, amount: 1000, currency: "usd", status: "succeeded" as const, paidAt: new Date(), ...over });
const events = (contact: string | null, type?: string) => asOperator((c) => many<{ event_type: string; data: Record<string, unknown> }>(c,
  contact ? `select event_type, data from events where company_id=$1 and contact_id=$2 ${type ? "and event_type=$3" : ""} order by id` : `select event_type, data from events where company_id=$1 and contact_id is null ${type ? "and event_type=$3" : ""} order by id`,
  type ? (contact ? [companyId, contact, type] : [companyId, null, type].filter((x, i) => i !== 1)) : contact ? [companyId, contact] : [companyId]));

describe.skipIf(!process.env.DATABASE_URL)("payments ledger", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug='pay'");
      if (co) { for (const t of ["events", "sends", "crm_records", "payments", "pipeline_cards", "opportunities", "contact_identifiers", "contacts", "webhook_deliveries"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); }
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, contract_value_default) values ('Pay','pay','America/New_York', 2999) returning id"))!.id;
      ann = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GA','Ann') returning id", [companyId]))!.id;
      bob = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GB','Bob') returning id", [companyId]))!.id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','ann@x.com'),($1,$2,'phone','+1 (602) 555-0101'),($1,$3,'email','bob@x.com'),($1,$3,'phone','6025550102')", [companyId, ann, bob]);
    });
  });

  it("derives the kind from the ledger, never from the provider", () => {
    expect(deriveKind(2999, 0, 2999, "succeeded")).toBe("paid_in_full");
    expect(deriveKind(2998.995, 0, 2999, "succeeded")).toBe("paid_in_full");   // rounding cent
    expect(deriveKind(1500, 0, 2999, "succeeded")).toBe("deposit");
    expect(deriveKind(1000, 1000, 2999, "succeeded")).toBe("installment");
    expect(deriveKind(999, 2000, 2999, "succeeded")).toBe("balance");
    expect(deriveKind(-500, 2999, 2999, "refunded")).toBe("refund");
    expect(deriveKind(1500, 0, null, "succeeded")).toBe("deposit");   // no price known: nothing can clear
    expect(deriveKind(0, 0, 2999, "failed")).toBe("failed");
  });

  it("email matches exactly; a deposit opens a pursuit priced at the company default and marks it won", async () => {
    const r = await asOperator((c) => recordPayment(c, companyId, pay("pay_1", { amount: 1500, email: "Ann@X.com", memberId: "mber_ann" })));
    expect(r.outcome).toBe("linked"); if (r.outcome !== "linked") return;
    expect(r.contactId).toBe(ann); expect(r.payment.kind).toBe("deposit"); expect(r.payment.linked_by).toBe("email");
    expect(r.event.data).toMatchObject({ kind: "deposit", running_total: 1500, contract_value: 2999, outstanding: 1499, cleared: false });
    const opp = await asOperator((c) => one<{ status: string; contract_value: string }>(c, "select status, contract_value from opportunities where company_id=$1 and contact_id=$2", [companyId, ann]));
    expect(opp).toEqual({ status: "won", contract_value: "2999.00" });
  });

  it("the member id links the next payment even when the email changed; the balance clears the deal and fires paid_in_full once", async () => {
    const r = await asOperator((c) => recordPayment(c, companyId, pay("pay_2", { amount: 1499, email: "ann.new@other.com", memberId: "mber_ann" })));
    expect(r.outcome).toBe("linked"); if (r.outcome !== "linked") return;
    expect(r.payment).toMatchObject({ contact_id: ann, kind: "balance", linked_by: "member_id" });
    expect(r.event.data).toMatchObject({ running_total: 2999, outstanding: 0, cleared: true });
    expect((await events(ann, "payment.paid_in_full"))).toHaveLength(1);
  });

  it("phone matches on the last ten digits", async () => {
    const r = await asOperator((c) => recordPayment(c, companyId, pay("pay_3", { amount: 2999, phone: "(602) 555-0102" })));
    expect(r.outcome).toBe("linked"); if (r.outcome !== "linked") return;
    expect(r.payment).toMatchObject({ contact_id: bob, linked_by: "phone", kind: "paid_in_full" });
  });

  it("an email nobody has → unlinked, with a contact-less event, visible on the unlinked list", async () => {
    // identities are unique per company (contact_identifiers), so the ladder can never be ambiguous; it can only find nobody
    const r = await asOperator((c) => recordPayment(c, companyId, pay("pay_4", { amount: 500, email: "nobody@x.com" })));
    expect(r.outcome).toBe("unlinked"); if (r.outcome !== "unlinked") return;
    expect(r.payment).toMatchObject({ contact_id: null, link_status: "unlinked", customer_email: "nobody@x.com" });
    expect(r.event.event_type).toBe("payment.unlinked"); expect(r.event.contact_id).toBeNull();
    expect(await asOperator((c) => unlinkedPayments(c, companyId))).toHaveLength(1);
  });

  it("a stranger's payment is unlinked; a later payment that resolves the same member heals it", async () => {
    const first = await asOperator((c) => recordPayment(c, companyId, pay("pay_5", { amount: 1000, email: "typo@gmial.com", memberId: "mber_cat" })));
    expect(first.outcome).toBe("unlinked");
    const cat = await asOperator(async (c) => { const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GC','Cat') returning id", [companyId]))!.id; await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','cat@x.com')", [companyId, id]); return id; });
    const second = await asOperator((c) => recordPayment(c, companyId, pay("pay_6", { amount: 1000, email: "cat@x.com", memberId: "mber_cat" })));
    expect(second.outcome).toBe("linked"); if (second.outcome !== "linked") return;
    expect(second.healed).toBe(1);
    expect(second.event.data).toMatchObject({ prior_total: 1000, running_total: 2000, kind: "installment" });   // the healed deposit counts
    const healed = await asOperator((c) => one<{ contact_id: string; link_status: string; linked_by: string }>(c, "select contact_id, link_status, linked_by from payments where company_id=$1 and whop_payment_id='pay_5'", [companyId]));
    expect(healed).toEqual({ contact_id: cat, link_status: "linked", linked_by: "heal" });
    expect(await events(cat, "payment.linked")).toHaveLength(1);
  });

  it("a person links an orphan by hand: it settles as if it had matched, and the email is remembered", async () => {
    const orphan = (await asOperator((c) => unlinkedPayments(c, companyId))).find((p) => p.whop_payment_id === "pay_4")!;
    const out = await asOperator((c) => linkPayment(c, companyId, orphan.id, bob));
    expect(out.event.event_type).toBe("payment.received"); expect(out.event.contact_id).toBe(bob);
    expect(await asOperator((c) => unlinkedPayments(c, companyId))).toHaveLength(0);
    await expect(asOperator((c) => linkPayment(c, companyId, orphan.id, bob))).rejects.toThrow(/already linked/);
  });

  it("the same provider payment id twice is a duplicate: no second row, no second event", async () => {
    const before = (await events(ann)).length;
    const r = await asOperator((c) => recordPayment(c, companyId, pay("pay_1", { amount: 1500, email: "ann@x.com" })));
    expect(r.outcome).toBe("duplicate");
    expect((await events(ann)).length).toBe(before);
  });

  it("a refund is a negative row that lowers the running total", async () => {
    const r = await asOperator((c) => recordPayment(c, companyId, pay("ref_1", { amount: -500, status: "refunded", email: "ann@x.com" })));
    expect(r.outcome).toBe("linked"); if (r.outcome !== "linked") return;
    expect(r.payment.kind).toBe("refund"); expect(r.event.event_type).toBe("payment.refunded");
    expect(r.event.data).toMatchObject({ running_total: 2499, cleared: false });
  });

  it("a refund that carries no buyer identity (sweep 2026-10-10) belongs to whoever made the payment it reverses: linked through that payment's id, so Payment recorded writes its minus line", async () => {
    const r = await asOperator((c) => recordPayment(c, companyId, pay("ref_2", { amount: -250, status: "refunded", raw: { payment_id: "pay_2" } })));
    expect(r.outcome).toBe("linked"); if (r.outcome !== "linked") return;
    expect(r.contactId).toBe(ann); expect(r.payment).toMatchObject({ kind: "refund", linked_by: "refunded_payment" });
    // a refund pointing at a payment the ledger has not linked (or does not know) is not guessed
    expect((await asOperator((c) => recordPayment(c, companyId, pay("ref_3", { amount: -100, status: "refunded", raw: { payment_id: "pay_nobody" } })))).outcome).toBe("unlinked");
  });

  it("resolvePayer: nothing to match on → null", async () => {
    expect(await asOperator((c) => resolvePayer(c, companyId, {}))).toBeNull();
  });
});

describe("Whop webhook verification and parsing", () => {
  const secret = "ws_0123456789abcdef0123456789abcdef";
  const body = JSON.stringify({ id: "msg_1", type: "payment.succeeded", api_version: "v1", data: { id: "pay_9", total: { amount: "2999.00", currency: "usd" }, currency: "usd", customer_email: "Marcus@Shine.example", customer_phone: "+15125550142", member_id: "mber_1", paid_at: "2026-01-01T12:00:00.000Z", plan_id: "plan_1", metadata: { a: 1 } } });
  const sign = (id: string, ts: string, raw: string, key = secret) => "v1," + createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  it("accepts a correctly signed, fresh delivery and rejects tampering, stale timestamps and missing headers", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifyWhopSignature(secret, { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) }, body)).toEqual({ ok: true });
    expect(verifyWhopSignature(secret, { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body + " ") }, body).ok).toBe(false);
    expect(verifyWhopSignature(secret, { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body, "ws_other") }, body).ok).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect(verifyWhopSignature(secret, { id: "msg_1", timestamp: old, signature: sign("msg_1", old, body) }, body)).toEqual({ ok: false, why: "timestamp outside tolerance" });
    expect(verifyWhopSignature(secret, { id: null, timestamp: ts, signature: null }, body).ok).toBe(false);
    // several signatures in the header (key rotation) → any valid one passes
    expect(verifyWhopSignature(secret, { id: "msg_1", timestamp: ts, signature: `${sign("msg_1", ts, body, "ws_old")} ${sign("msg_1", ts, body)}` }, body)).toEqual({ ok: true });
  });
  it("parses the v1 envelope: total.amount as a number, buyer identity, member id, paid_at; failed and refund events; ignores others", () => {
    const p = parseWhopEvent(JSON.parse(body))!;
    expect(p).toMatchObject({ deliveryId: "msg_1", providerPaymentId: "pay_9", amount: 2999, status: "succeeded", email: "Marcus@Shine.example", phone: "+15125550142", memberId: "mber_1", currency: "usd" });
    expect(p.paidAt.toISOString()).toBe("2026-01-01T12:00:00.000Z");
    const f = parseWhopEvent({ id: "msg_2", type: "payment.failed", data: { id: "pay_10", total: { amount: "1000.00" }, failure_message: "card declined", customer_email: "a@b.c" } })!;
    expect(f).toMatchObject({ status: "failed", amount: 1000 }); expect(f.raw).toMatchObject({ failure_message: "card declined" });
    const r = parseWhopEvent({ id: "msg_3", type: "refund.created", data: { id: "rfnd_1", payment_id: "pay_9", amount: { amount: "500.00" }, created_at: "2026-02-01T00:00:00Z" } })!;
    expect(r).toMatchObject({ providerPaymentId: "rfnd_1", amount: -500, status: "refunded" });
    expect(parseWhopEvent({ id: "msg_4", type: "membership.activated", data: {} })).toBeNull();
  });
});

describe("Zapier-forwarded payments", () => {
  it("accepts the Zap's field names in either case and derives status, sign and time", () => {
    const a = parseZapierPayment({ transactionId: "txn_1", amount: "2,999.00", customerEmail: "A@B.co", whopUserId: "mber_9", paidAt: "2026-03-01T10:00:00Z" });
    expect(a.ok).toBe(true); if (!a.ok) return;
    expect(a.input).toMatchObject({ providerPaymentId: "txn_1", amount: 2999, status: "succeeded", email: "A@B.co", memberId: "mber_9", provider: "whop" });
    expect(a.input.paidAt.toISOString()).toBe("2026-03-01T10:00:00.000Z");
    const r = parseZapierPayment({ transaction_id: "txn_2", amount: 500, status: "refunded" }); expect(r.ok && r.input.amount).toBe(-500);
    const f = parseZapierPayment({ transaction_id: "txn_3", amount: 1000, event: "payment.failed" }); expect(f.ok && f.input.status).toBe("failed");
    const u = parseZapierPayment({ transaction_id: "txn_4", amount: 10, paid_at: "1760000000" }); expect(u.ok && u.input.paidAt.getUTCFullYear()).toBe(2025);
  });
  it("rejects a payment without a transaction id or with a non-numeric amount", () => {
    expect(parseZapierPayment({ amount: 10 })).toEqual({ ok: false, why: expect.stringMatching(/transaction_id/) });
    expect(parseZapierPayment({ transaction_id: "x", amount: "ten" })).toEqual({ ok: false, why: expect.stringMatching(/amount/) });
  });
});
