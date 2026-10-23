/** D229: a Whop webhook that names no buyer is read back from Whop's API by id; payments already stuck unlinked that way are relinked. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { recordPayment, markDeposit } from "./payments";
import { fillWhopBuyer, parseWhopEvent } from "./webhooks/whop";
import { relinkWhopBuyers } from "./whop-relink";
import { whopBuyer } from "@/adapters/whop/client";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
// the shape PMU's live webhooks had (2026-10-22): no flat buyer keys, the product nested
const live = (id: string, amount: string, product?: string) => ({ id: `msg_${id}`, type: "payment.succeeded", data: { id, total: { amount, currency: "usd" }, paid_at: "2026-10-22T19:25:41Z", billing_reason: "one_time", ...(product ? { product: { id: "prod_1", title: product } } : {}) } });
const whop = (email: string) => async (_k: string, id: string) => ({ id, status: "paid", customer_email: email, member_id: "mber_jen", product_id: "prod_1", line_items: [{ product_id: "prod_1", product_title: "Beauty Moguls Method", plan_title: null }] });

describe("D229: Whop buyer, in either shape", () => {
  it("reads the flat keys and the nested objects", () => {
    expect(whopBuyer({ customer_email: "a@x.com", customer_phone: "+1602", member_id: "mber_1", product_id: "prod_1", plan_id: "plan_1" })).toMatchObject({ email: "a@x.com", phone: "+1602", memberId: "mber_1", product_id: "prod_1", plan_id: "plan_1" });
    expect(whopBuyer({ user: { id: "user_1", email: "b@x.com" }, member: { id: "mber_2", phone: "+1603" }, product: { id: "prod_2", title: "X" }, plan: { id: "plan_2" }, membership: { id: "mem_2" } }))
      .toEqual({ email: "b@x.com", phone: "+1603", memberId: "mber_2", product_id: "prod_2", plan_id: "plan_2", membership_id: "mem_2" });
    expect(parseWhopEvent({ id: "m", type: "payment.succeeded", data: { id: "pay_n", total: { amount: "5" }, user: { email: "c@x.com" }, member: { id: "mber_3" } } })).toMatchObject({ email: "c@x.com", memberId: "mber_3" });
  });

  it("a webhook with no buyer is read back from Whop; one with a buyer, or a refund, is not; Whop down leaves it as it came, saying why", async () => {
    const p = parseWhopEvent(live("pay_a", "250.00", "Beauty Moguls Method"))!;
    expect(p.email).toBeUndefined();
    const filled = await fillWhopBuyer(p, "apik_x", whop("Jen@x.com"));
    expect(filled).toMatchObject({ email: "Jen@x.com", memberId: "mber_jen", raw: { product_id: "prod_1", product_name: "Beauty Moguls Method", buyer_from: "whop_api" } });
    let asked = 0; const count = async (k: string, id: string) => { asked++; return whop("x@x.com")(k, id); };
    await fillWhopBuyer({ ...p, email: "has@x.com" }, "apik_x", count);
    await fillWhopBuyer({ ...p, status: "refunded", amount: -5 }, "apik_x", count);
    expect(asked).toBe(0);
    expect((await fillWhopBuyer(p, "apik_x", async () => { throw new Error("whop: read payment pay_a 503"); })).raw).toMatchObject({ buyer_lookup: "whop: read payment pay_a 503" });
    expect((await fillWhopBuyer(p, undefined)).raw).toMatchObject({ buyer_lookup: "no buyer in the webhook and no Whop API key bound" });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D229: relinking payments stuck without a buyer", () => {
  let companyId = "", jen = "";
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone, contract_value_default) values ('D229',$1,'America/New_York',10000) returning id", [`d229-${Date.now()}`]))!.id;
      jen = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name) values ($1,'GJ','Jennyfer','C') returning id", [companyId]))!.id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','jen@x.com')", [companyId, jen]);
    });
  });

  it("dry run says who each links to and changes nothing; applied, both link to her oldest first with no workflow started, and a buyer nobody has stays unlinked", async () => {
    for (const [id, amt, prod] of [["pay_250", "250.00", "Beauty Moguls Method"], ["pay_9750", "9750.00", undefined], ["pay_other", "100.00", undefined]] as const) {
      const p = parseWhopEvent({ ...live(id, amt, prod), data: { ...live(id, amt, prod).data, paid_at: id === "pay_9750" ? "2026-10-23T00:04:34Z" : "2026-10-22T19:25:41Z" } })!;
      expect((await asOperator((c) => recordPayment(c, companyId, p))).outcome).toBe("unlinked");
    }
    const get = async (k: string, id: string) => id === "pay_other" ? { id, customer_email: "stranger@x.com" } : whop("JEN@x.com")(k, id);
    const dry = await asOperator((c) => relinkWhopBuyers(c, companyId, "apik_x", { dryRun: true, get }));
    expect(dry.map((r) => [r.whop_payment_id, r.email, r.links_to?.name ?? null])).toEqual([["pay_250", "jen@x.com", "Jennyfer C"], ["pay_other", "stranger@x.com", null], ["pay_9750", "jen@x.com", "Jennyfer C"]]);
    expect(await asOperator((c) => one(c, "select count(*)::int as n from payments where company_id=$1 and link_status='unlinked' and customer_email is null", [companyId]))).toEqual({ n: 3 });

    const done = await asOperator((c) => relinkWhopBuyers(c, companyId, "apik_x", { dryRun: false, get }));
    expect(done.map((r) => [r.whop_payment_id, r.linked])).toEqual([["pay_250", true], ["pay_other", false], ["pay_9750", true]]);
    const rows = await asOperator((c) => many<{ whop_payment_id: string; contact_id: string | null; kind: string | null; customer_email: string | null }>(c, "select whop_payment_id, contact_id, kind, customer_email from payments where company_id=$1 order by paid_at, whop_payment_id", [companyId]));
    expect(rows).toEqual([
      { whop_payment_id: "pay_250", contact_id: jen, kind: "installment", customer_email: "jen@x.com" },
      { whop_payment_id: "pay_other", contact_id: null, kind: null, customer_email: "stranger@x.com" },
      { whop_payment_id: "pay_9750", contact_id: jen, kind: "balance", customer_email: "jen@x.com" },
    ]);
    expect(await asOperator((c) => one(c, "select count(*)::int as n from runs where company_id=$1", [companyId]))).toEqual({ n: 0 });
    // read again: nothing left without a buyer
    expect(await asOperator((c) => relinkWhopBuyers(c, companyId, "apik_x", { dryRun: true, get }))).toEqual([]);
  });

  it("a payment marked a deposit by hand: the dry run lists the kind it would change, applied it is a deposit, failed payments cannot be", async () => {
    const dry = await asOperator((c) => markDeposit(c, companyId, "pay_250", { dryRun: true }));
    expect(dry.kinds).toEqual([{ whop_payment_id: "pay_250", amount: 250, from: "installment", to: "deposit" }]);
    expect(await asOperator((c) => one(c, "select kind from payments where company_id=$1 and whop_payment_id='pay_250'", [companyId]))).toEqual({ kind: "installment" });
    await asOperator((c) => markDeposit(c, companyId, "pay_250", { dryRun: false }));
    expect(await asOperator((c) => many(c, "select whop_payment_id, kind, raw->>'deposit_marked' as m from payments where company_id=$1 and contact_id is not null order by paid_at", [companyId])))
      .toEqual([{ whop_payment_id: "pay_250", kind: "deposit", m: "true" }, { whop_payment_id: "pay_9750", kind: "balance", m: null }]);
    await asOperator((c) => c.query("insert into payments (company_id, whop_payment_id, amount, status, paid_at, link_status) values ($1,'pay_fail',10000,'failed',now(),'unlinked')", [companyId]));
    await expect(asOperator((c) => markDeposit(c, companyId, "pay_fail", { dryRun: true }))).rejects.toThrow(/only a succeeded payment/);
  });

  it("marked while still unlinked, it links as a deposit", async () => {
    const p = parseWhopEvent(live("pay_d2", "250.00", "Beauty Moguls Method"))!;
    await asOperator((c) => c.query("insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GK','Kim')", [companyId]));
    await asOperator(async (c) => c.query("insert into contact_identifiers (company_id, contact_id, kind, value) select $1, id, 'email', 'kim@x.com' from contacts where company_id=$1 and ghl_contact_id='GK'", [companyId]));
    await asOperator((c) => recordPayment(c, companyId, p));
    await asOperator((c) => markDeposit(c, companyId, "pay_d2", { dryRun: false }));
    await asOperator((c) => relinkWhopBuyers(c, companyId, "apik_x", { dryRun: false, get: whop("kim@x.com") }));
    expect(await asOperator((c) => one(c, "select kind, link_status from payments where company_id=$1 and whop_payment_id='pay_d2'", [companyId]))).toEqual({ kind: "deposit", link_status: "linked" });
  });
});
