/** D270: what a payment is, by the offer's own settings; nothing is the engine's own number or word. */
import { describe, it, expect } from "vitest";
import { deriveKind, fullPriceFor, fullPriceOf, namedDeposit, payRulesOf, listSetting, priorFromCash } from "./payments";

// PMU's settings as Tyler gave them (2026-10-30)
const PMU = payRulesOf({ "payments.full_prices": "[10000, 12000]", "payments.price_slack": "3", "payments.deposit_under": "500", "payments.deposit_words": "deposit", "payments.full_reasons": "one_time, subscription_create" });
const kind = (amount: number, prior = 0, deal: number | null = null, reason: string | null = "one_time", deposit = false) => deriveKind(amount, prior, deal, "succeeded", deposit, { ...PMU, reason });

describe("D270: payment rules are the offer's settings", () => {
  it("reads the settings, as JSON or words with commas; an unset one is no rule", () => {
    expect(PMU).toEqual({ fullPrices: [10000, 12000], slack: 3, depositUnder: 500, depositWords: ["deposit"], fullReasons: ["one_time", "subscription_create"], depositUpTo: null, fullBy: "price", priceFrom: [], askDeposit: false });
    expect(payRulesOf({})).toEqual({ fullPrices: [], slack: 0, depositUnder: null, depositWords: [], fullReasons: [], depositUpTo: null, fullBy: "price", priceFrom: [], askDeposit: false });
    expect(listSetting("$10,000")).toEqual(["$10", "000"]);   // a list is JSON or words with commas: a price with a comma is written in JSON
    expect(payRulesOf({ "payments.full_prices": "[\"$10,000\"]" }).fullPrices).toEqual([10000]);
  });

  it("paid in full: one payment of a full price, or up to the slack under it, for a counted reason", () => {
    expect(kind(10000)).toBe("paid_in_full");
    expect(kind(9997)).toBe("paid_in_full");
    expect(kind(11998, 0, null, "subscription_create")).toBe("paid_in_full");
    expect(kind(9990)).toBe("installment");                           // more than $3 under
    expect(kind(10000, 0, null, "subscription_cycle")).toBe("balance");   // a renewal charge is not a purchase in full; it does clear the price
    expect(kind(10000, 0, null, null)).toBe("paid_in_full");          // a payment that names no reason is not held to it
  });

  it("a deposit: under the offer's threshold, or a product named with its word; a $250 then $9,750 is a deposit and its balance", () => {
    expect(kind(250)).toBe("deposit");
    expect(kind(499.99)).toBe("deposit");
    expect(kind(500)).toBe("installment");
    expect(namedDeposit({ product_name: "Beauty Moguls Deposit" }, PMU.depositWords)).toBe(true);
    expect(namedDeposit({ product_name: "Beauty Moguls Method" }, PMU.depositWords)).toBe(false);
    expect(kind(9750, 250, 10000)).toBe("balance");
    expect(kind(3333, 0, null)).toBe("installment");
  });

  it("the deal's full price: the one the payment is, else the deal's when it is one, else the offer's first", () => {
    expect(fullPriceOf(11999, PMU)).toBe(12000);
    expect(fullPriceFor(3333, null, PMU)).toBe(10000);
    expect(fullPriceFor(4000, 12000, PMU)).toBe(12000);
    expect(fullPriceFor(9997, 12000, PMU)).toBe(10000);
  });

  it("an offer with no full prices set goes by its rules from before (D119)", () => {
    expect(deriveKind(250, 0, 10000, "succeeded", false, undefined)).toBe("installment");
    expect(deriveKind(10000, 0, 10000, "succeeded", false, undefined)).toBe("paid_in_full");
  });

  it("what was paid before is GHL's Cash records dated before this payment: a deposit linked after its balance never counts the balance", () => {
    const rec = (id: string, amount: number, extra: Record<string, unknown>) => ({ id, createdAt: "", properties: { transaction_id: id, amount, contact_id: "G-JEN", ...extra } });
    const cash = [rec("dep", 250, { type: "deposit", occurred_at: "2026-10-22T19:25:41Z" }), rec("bal", 9750, { occurred_at: "2026-10-23T00:04:34Z" }), rec("old", 100, { paid_date: "2026-10-01" }), rec("undated", 50, {})];
    expect(priorFromCash(cash, { ghlId: "G-JEN" }, "dep", new Date("2026-10-22T19:25:41Z"))).toEqual({ total: 150, nonDeposit: 150 });
    expect(priorFromCash(cash, { ghlId: "G-JEN" }, "bal", new Date("2026-10-23T00:04:34Z"))).toEqual({ total: 400, nonDeposit: 150 });
    expect(priorFromCash(cash, { ghlId: "G-JEN" }, "dep")).toEqual({ total: 9900, nonDeposit: 9900 });   // no time given: every other record
  });
});

// D315: PMU from 2026-11-05 (Tyler: "we're giving out links left and right, so it should be whether or not it's a one time payment
// or a subscription start"; a subscription start is a close, not a purchase in full; $500 or less is a deposit)
const BY_REASON = payRulesOf({ "payments.full_prices": "[10000,11500,12000]", "payments.price_slack": "3", "payments.deposit_under": "500", "payments.deposit_up_to": "500", "payments.deposit_words": "deposit", "payments.full_reasons": "one_time", "payments.full_by": "billing_reason" });
const byReason = (amount: number, prior = 0, priorPaid = prior, reason: string | null = "one_time", deal: number | null = null) => deriveKind(amount, prior, deal, "succeeded", false, { ...BY_REASON, reason, priorPaid });

describe("D315: an offer that goes by billing reason", () => {
  it("reads the two settings; anything but billing_reason goes by price", () => {
    expect(BY_REASON).toMatchObject({ fullBy: "billing_reason", depositUpTo: 500, fullReasons: ["one_time"] });
    expect(payRulesOf({ "payments.full_by": "Billing reason" }).fullBy).toBe("billing_reason");
    expect(payRulesOf({ "payments.full_by": "price" }).fullBy).toBe("price");
    expect(payRulesOf({ "payments.full_by": "billing_reason" }).fullPrices).toEqual([]);   // ruled by reason alone, no prices needed
    expect(deriveKind(7000, 0, null, "succeeded", false, { ...payRulesOf({ "payments.full_by": "billing_reason", "payments.full_reasons": "one_time" }), reason: "one_time", priorPaid: 0 })).toBe("paid_in_full");
  });

  it("a one-time payment at any price is paid in full; after a deposit it is the balance", () => {
    expect(byReason(11500)).toBe("paid_in_full");
    expect(byReason(8000)).toBe("paid_in_full");
    expect(byReason(9750, 250, 0)).toBe("balance");
  });

  it("D321: after a deposit, a deal that already has its price is paid off only by what reaches it", () => {
    expect(byReason(3000, 1000, 0, "one_time", 10000)).toBe("installment");   // Carmen: $1,000 deposit, $3,000 of a $10,000 plan
    expect(byReason(9000, 1000, 0, "one_time", 10000)).toBe("balance");
    expect(byReason(8997, 1000, 0, "one_time", 10000)).toBe("balance");       // within the $3 slack
    expect(byReason(3000, 1000, 0, "one_time", null)).toBe("balance");        // no price yet: deposit + this is the purchase
  });

  it("a subscription start or renewal is an installment until it clears the deal", () => {
    expect(byReason(4000, 0, 0, "subscription_create")).toBe("installment");
    expect(byReason(11500, 0, 0, "subscription_create")).toBe("installment");          // no money before it: never a balance on its own
    expect(byReason(4000, 4000, 4000, "subscription_cycle", 12000)).toBe("installment");
    expect(byReason(4000, 8000, 8000, "subscription_cycle", 12000)).toBe("balance");
    expect(byReason(4000, 8000, 8000, "one_time", 12000)).toBe("balance");             // a one-time charge after installments is not a new purchase
    expect(byReason(1000, 4000, 4000, "one_time", 12000)).toBe("installment");
  });

  it("$500 or less is a deposit", () => {
    expect(byReason(500)).toBe("deposit");
    expect(byReason(250)).toBe("deposit");
    expect(byReason(500.01)).toBe("paid_in_full");
  });

  it("a payment that names no reason goes by price", () => {
    expect(byReason(11500, 0, 0, null)).toBe("paid_in_full");
    expect(byReason(8000, 0, 0, null)).toBe("installment");
  });

  it("an offer that goes by price is as it was (PMU before, every other offer)", () => {
    expect(kind(11500)).toBe("balance");                                             // the old rule: not a full price, so a "balance" with nothing before it
    expect(kind(11998, 0, null, "subscription_create")).toBe("paid_in_full");
    expect(kind(500)).toBe("installment");
  });
});
