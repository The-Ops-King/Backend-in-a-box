/**
 * D119 addendum: a payment is a deposit when its Whop product's or plan's name has the word "deposit" in it (a naming
 * convention, read exactly); declared deposit products still work and, declared, are the whole truth. The names come in the
 * payload (Whop's line_items, a Zap's fields) or are read from Whop with the company's key and cached; a name that cannot be
 * had leaves the payment not a deposit, flagged, with an alert, and never held. Past payments keep their kinds.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "./crypto";
import { recordPayment as recordAny, isDeposit, type PaymentInput } from "./payments";
/** Every payment here is real money: never the skipped $0 kind (D270). */
const recordPayment = async (...a: Parameters<typeof recordAny>) => { const r = await recordAny(...a); if (r.outcome === "skipped") throw new Error(r.why); return r; };
import { saysDeposit, uncheckedAlertKey } from "./deposit-names";
import { parseWhopEvent } from "./webhooks/whop";
import { parseZapierPayment } from "./webhooks/zapier";
import { paymentInputs, whopNames } from "@/adapters/whop/client";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");

describe("D119 addendum: the word", () => {
  it("is the whole word deposit, in any case; a word that only contains it is not", () => {
    for (const n of ["Deposit", "deposit", "DEPOSIT", "VIP Deposit", "Deposit - $250", "Hair Deposit (refundable)", "vip-deposit", "Deposit:Hair", "$250 deposit"]) expect(saysDeposit(n), n).toBe(true);
    for (const n of ["deposited", "nondeposit", "Deposits", "Redeposit fee", "Beauty Moguls Method", "Dep0sit", "", null, undefined, 42]) expect(saysDeposit(n), String(n)).toBe(false);
  });
  it("a declared list wins: declared, only its products are deposits whatever they are called; undeclared, the names tell", () => {
    expect(isDeposit({ product_id: "prod_MAIN", product_name: "Hair Program", plan_name: "Deposit" }, [])).toBe(true);
    expect(isDeposit({ product_id: "prod_MAIN", product_name: "VIP Deposit" }, [])).toBe(true);
    expect(isDeposit({ product_id: "prod_MAIN", product_name: "Deposited funds" }, [])).toBe(false);
    expect(isDeposit({ product_id: "prod_MAIN", product_name: "VIP Deposit" }, ["prod_DEP"])).toBe(false);
    expect(isDeposit({ product_id: "prod_DEP", product_name: "Hair Program" }, ["prod_DEP"])).toBe(true);
    expect(isDeposit({ product_id: "prod_MAIN" }, [])).toBe(false);
    expect(isDeposit(null, [])).toBe(false);
  });
});

describe("D119 addendum: the names in the payload", () => {
  const item = (o: Record<string, unknown>) => ({ id: "li_1", quantity: 1, ...o });
  it("Whop: line_items carry product_title and plan_title (the item for the payment's own product first); null is no name, absent is not carried", () => {
    const ev = parseWhopEvent({ id: "msg_1", type: "payment.succeeded", data: { id: "pay_1", total: { amount: "250", currency: "usd" }, product_id: "prod_DEP", plan_id: "plan_D",
      line_items: [item({ product_id: "prod_OTHER", product_title: "Other", plan_title: "Other plan" }), item({ product_id: "prod_DEP", product_title: "Hair Deposit", plan_id: "plan_D", plan_title: null })] } });
    expect(ev!.raw).toMatchObject({ product_id: "prod_DEP", plan_id: "plan_D", product_name: "Hair Deposit", plan_name: null });
    const bare = parseWhopEvent({ id: "msg_2", type: "payment.succeeded", data: { id: "pay_2", total: { amount: "250" }, product_id: "prod_DEP", plan_id: "plan_D" } });
    expect("product_name" in bare!.raw!).toBe(false); expect("plan_name" in bare!.raw!).toBe(false);
    expect(whopNames({ product: { id: "prod_x", title: "Deposit" }, plan: { id: "plan_x", title: " " } })).toEqual({ product_name: "Deposit", plan_name: null });
    // the payment list the backfill reads is the same Payment
    const [p] = paymentInputs({ id: "pay_3", status: "paid", total: { amount: "10000.00" }, created_at: "2026-10-05T12:00:00Z", product_id: "prod_3", plan_id: "plan_7", line_items: [{ product_id: "prod_3", product_title: "Beauty Moguls Method", plan_id: "plan_7", plan_title: null }] });
    expect(p.raw).toMatchObject({ product_name: "Beauty Moguls Method", plan_name: null });
  });
  it("Zapier: product_name / plan_name (or _title, or camelCase); a product or plan that is not a Whop id is its name, one that is is the id", () => {
    const a = parseZapierPayment({ transaction_id: "z1", amount: "250", product_name: "VIP Deposit", planTitle: "Pay in full" });
    expect(a.ok && a.input.raw).toMatchObject({ product_name: "VIP Deposit", plan_name: "Pay in full" });
    const b = parseZapierPayment({ transaction_id: "z2", amount: "250", product: "Hair Deposit" });
    expect(b.ok && b.input.raw).toMatchObject({ product_name: "Hair Deposit" }); expect(b.ok && b.input.raw?.product_id).toBeUndefined();
    const c = parseZapierPayment({ transaction_id: "z3", amount: "250", product: "prod_ABC", plan: "plan_XYZ" });
    expect(c.ok && c.input.raw).toMatchObject({ product_id: "prod_ABC", plan_id: "plan_XYZ" }); expect(c.ok && c.input.raw?.product_name).toBeUndefined();
  });
});

// ---- through the ledger, with a fake Whop -------------------------------------------------------------------------------------
type Fake = { titles: Record<string, string | null>; down: Set<string>; calls: string[] };
const whop: Fake = { titles: {}, down: new Set(), calls: [] };
const realFetch = globalThis.fetch;
function fakeWhop() {
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const m = /^https:\/\/api\.whop\.com\/api\/v1\/(products|plans)\/([^/?]+)$/.exec(u);
    if (!m) return realFetch(url, init);
    whop.calls.push(`${m[1]}/${m[2]}`);
    if ((init?.headers as Record<string, string>)?.Authorization !== "Bearer apik_test") return new Response("unauthorized", { status: 401 });
    if (whop.down.has(m[2])) return new Response("upstream down", { status: 503 });
    if (!(m[2] in whop.titles)) return new Response("not found", { status: 404 });
    return Response.json({ id: m[2], title: whop.titles[m[2]] });
  });
}

async function wipe(slug: string) {
  await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return;
    for (const t of ["alerts", "events", "payments", "opportunities", "contact_identifiers", "contacts", "bindings"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
    await c.query("delete from engine_state where key=$1", [`whop_names:${co.id}`]);
    await c.query("delete from companies where id=$1", [co.id]);
  });
}
async function company(slug: string, bind: Record<string, string>): Promise<{ id: string; who: string }> {
  await wipe(slug);
  return asOperator(async (c) => {
    const id = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, contract_value_default) values ($1,$1,'America/New_York', 5000) returning id", [slug]))!.id;
    for (const [k, v] of Object.entries(bind)) await c.query("insert into bindings (company_id, key, kind, value) values ($1,$2,$3,$4)", [id, k, k.startsWith("secret.") ? "secret" : "text", k.startsWith("secret.") ? encrypt(v) : Buffer.from(v)]);
    const who = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'G1','Payer') returning id", [id]))!.id;
    return { id, who };
  });
}
/** Each payment from its own person, so one payment's kind never depends on another's total. */
const someone = (c: import("pg").PoolClient, co: string, key: string) => one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,$2,'Payer') returning id", [co, `G-${key}`]).then((r) => r!.id);
const pay = (co: { id: string; who: string }, id: string, raw: Record<string, unknown>, over: Partial<PaymentInput> = {}) =>
  asOperator(async (c) => recordPayment(c, co.id, { providerPaymentId: id, amount: 500, status: "succeeded", paidAt: new Date(), raw, ...over }, await someone(c, co.id, id)));
const openAlerts = (co: string) => asOperator((c) => many<{ key: string; text: string }>(c, "select key, text from alerts where company_id=$1 and resolved_at is null order by first_seen", [co]));
const kindOf = (co: string, id: string) => asOperator(async (c) => (await one<{ kind: string }>(c, "select kind from payments where company_id=$1 and whop_payment_id=$2", [co, id]))?.kind);

describe.skipIf(!process.env.DATABASE_URL)("D119 addendum: through the ledger", () => {
  let keyed: { id: string; who: string }, keyless: { id: string; who: string }, declared: { id: string; who: string };
  beforeAll(async () => {
    await migrate();
    keyed = await company("d119n-keyed", { "secret.whop_api_key": "apik_test" });
    keyless = await company("d119n-keyless", {});
    declared = await company("d119n-declared", { "secret.whop_api_key": "apik_test", "payments.deposit_products": JSON.stringify(["prod_DECL"]) });
    whop.titles = { prod_DEP: "Hair Deposit", prod_MAIN: "Hair Program", plan_MAIN: null, plan_DEPPLAN: "Deposit - $250", prod_LATER: "Hair Extras" };
  });
  afterEach(() => { vi.unstubAllGlobals(); whop.calls = []; whop.down.clear(); });

  it("the payload's names are used as they come: no call to Whop", async () => {
    fakeWhop();
    expect((await pay(keyed, "p-payload-dep", { product_id: "prod_X", plan_id: "plan_X", product_name: "VIP Deposit", plan_name: null })).payment.kind).toBe("deposit");
    expect((await pay(keyed, "p-payload-full", { product_id: "prod_Y", plan_id: "plan_Y", product_name: "Hair Program", plan_name: null }, { amount: 5000 })).payment.kind).toBe("paid_in_full");
    expect(whop.calls).toEqual([]);
  });

  it("ids only: the names are read from Whop with the company's key, kept on the payment, and cached for the company", async () => {
    fakeWhop();
    const r = await pay(keyed, "p-lookup-dep", { product_id: "prod_DEP", plan_id: "plan_MAIN" });
    expect(r.payment.kind).toBe("deposit");
    expect(r.payment.raw).toMatchObject({ product_name: "Hair Deposit", names_from: "whop" });
    expect(whop.calls).toEqual(["products/prod_DEP"]);   // the product's name already says deposit: the plan is not asked
    const r2 = await pay(keyed, "p-lookup-plan", { product_id: "prod_MAIN", plan_id: "plan_DEPPLAN" });
    expect(r2.payment.kind).toBe("deposit"); expect(r2.payment.raw).toMatchObject({ product_name: "Hair Program", plan_name: "Deposit - $250" });
    const r3 = await pay(keyed, "p-lookup-main", { product_id: "prod_MAIN", plan_id: "plan_MAIN" });
    expect(r3.payment.kind).toBe("installment"); expect(r3.payment.raw).toMatchObject({ product_name: "Hair Program", plan_name: null });
    expect(whop.calls).toEqual(["products/prod_DEP", "products/prod_MAIN", "plans/plan_DEPPLAN", "plans/plan_MAIN"]);   // prod_MAIN the second time from the cache
    await pay(keyed, "p-lookup-dep-2", { product_id: "prod_DEP", plan_id: "plan_MAIN" });
    expect(whop.calls).toHaveLength(4);
    expect(await openAlerts(keyed.id)).toEqual([]);
  });

  it("a name Whop cannot give: not a deposit, recorded and settled all the same (never held), flagged on the payment, and an alert says what it means", async () => {
    fakeWhop(); whop.down.add("prod_NEW");
    const r = await pay(keyed, "p-down", { product_id: "prod_NEW", plan_id: "plan_MAIN" }, { email: "x@y.com" });
    expect(r.outcome).toBe("linked"); if (r.outcome !== "linked") return;
    expect(r.payment.kind).toBe("installment");
    expect(r.event.event_type).toBe("payment.received");
    expect((r.payment.raw as { deposit_check?: { failed: string } }).deposit_check?.failed).toMatch(/product prod_NEW.*503/);
    const alerts = await openAlerts(keyed.id);
    expect(alerts.map((a) => a.key)).toEqual([uncheckedAlertKey(r.payment.id)]);
    expect(alerts[0].text).toMatch(/could not be checked for a deposit.*taken as not a deposit.*agreement goes out/);
    // an unknown id is the same
    const r2 = await pay(keyed, "p-404", { product_id: "prod_GONE" });
    expect(r2.payment.kind).toBe("installment"); expect((await openAlerts(keyed.id))).toHaveLength(2);
    // a failed payment or a refund is never looked up: its kind is never a deposit
    whop.calls = [];
    await pay(keyed, "p-failed", { product_id: "prod_NEW" }, { status: "failed" });
    await pay(keyed, "p-refund", { product_id: "prod_NEW", payment_id: "p-down" }, { status: "refunded", amount: -500 });
    expect(whop.calls).toEqual([]);
  });

  it("no Whop key bound: the same, flagged and alerted; with names in the payload there is nothing to look up", async () => {
    fakeWhop();
    const r = await pay(keyless, "k-ids", { product_id: "prod_DEP" });
    expect(r.payment.kind).toBe("installment");
    expect((r.payment.raw as { deposit_check?: { failed: string } }).deposit_check?.failed).toMatch(/no Whop API key/);
    expect((await pay(keyless, "k-named", { product_id: "prod_DEP", product_name: "Hair Deposit" })).payment.kind).toBe("deposit");
    expect((await pay(keyless, "k-nothing", { simulated: true })).payment.kind).toBe("installment");   // no product at all: nothing to check
    expect(whop.calls).toEqual([]);
    expect((await openAlerts(keyless.id))).toHaveLength(1);
  });

  it("declared deposit products win: only they are deposits, and the names are not read", async () => {
    fakeWhop();
    expect((await pay(declared, "d-named", { product_id: "prod_DEP", product_name: "Hair Deposit" })).payment.kind).toBe("installment");
    expect((await pay(declared, "d-ids", { product_id: "prod_DEP" })).payment.kind).toBe("installment");
    expect((await pay(declared, "d-decl", { product_id: "prod_DECL", product_name: "Hair Program" })).payment.kind).toBe("deposit");
    expect(whop.calls).toEqual([]);
    expect(await openAlerts(declared.id)).toEqual([]);
  });

  it("the Zapier door: the names a Zap sends tell it; a Zap that sends only the ids has them read from Whop", async () => {
    fakeWhop();
    const named = parseZapierPayment({ transaction_id: "zap-named", amount: "250", email: "z@y.com", product_name: "VIP Deposit" });
    if (!named.ok) throw new Error(named.why);
    expect((await asOperator(async (c) => recordPayment(c, keyed.id, named.input, await someone(c, keyed.id, "zap-named")))).payment.kind).toBe("deposit");
    const ids = parseZapierPayment({ transaction_id: "zap-ids", amount: "250", product: "prod_DEP" });
    if (!ids.ok) throw new Error(ids.why);
    const r = await asOperator(async (c) => recordPayment(c, keyed.id, ids.input, await someone(c, keyed.id, "zap-ids")));
    expect(r.payment.kind).toBe("deposit"); expect(r.payment.raw).toMatchObject({ via: "zapier", product_id: "prod_DEP", product_name: "Hair Deposit" });
  });

  it("past payments keep their kind: a product renamed to say deposit changes only the payments after it", async () => {
    fakeWhop();
    expect((await pay(keyed, "p-before", { product_id: "prod_LATER" })).payment.kind).toBe("installment");
    whop.titles.prod_LATER = "Hair Deposit";
    await asOperator((c) => c.query("delete from engine_state where key=$1", [`whop_names:${keyed.id}`]));   // the hour is up
    expect((await pay(keyed, "p-after", { product_id: "prod_LATER" })).payment.kind).toBe("deposit");
    expect(await kindOf(keyed.id, "p-before")).toBe("installment");
  });
});
