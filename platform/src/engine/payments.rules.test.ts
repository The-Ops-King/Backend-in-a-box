/** D268: what a payment is, by the offer's own settings; nothing is the engine's own number or word. */
import { describe, it, expect } from "vitest";
import { deriveKind, fullPriceFor, fullPriceOf, namedDeposit, payRulesOf, listSetting } from "./payments";

// PMU's settings as Tyler gave them (2026-10-30)
const PMU = payRulesOf({ "payments.full_prices": "[10000, 12000]", "payments.price_slack": "3", "payments.deposit_under": "500", "payments.deposit_words": "deposit", "payments.full_reasons": "one_time, subscription_create" });
const kind = (amount: number, prior = 0, deal: number | null = null, reason: string | null = "one_time", deposit = false) => deriveKind(amount, prior, deal, "succeeded", deposit, { ...PMU, reason });

describe("D268: payment rules are the offer's settings", () => {
  it("reads the settings, as JSON or words with commas; an unset one is no rule", () => {
    expect(PMU).toEqual({ fullPrices: [10000, 12000], slack: 3, depositUnder: 500, depositWords: ["deposit"], fullReasons: ["one_time", "subscription_create"] });
    expect(payRulesOf({})).toEqual({ fullPrices: [], slack: 0, depositUnder: null, depositWords: [], fullReasons: [] });
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
});
