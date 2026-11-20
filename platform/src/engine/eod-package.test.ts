/** D356: the end of day's Package answer, read from the products of the call's payments by the offer's rules, first match wins. */
import { describe, it, expect } from "vitest";
import { packageOf } from "./eod";

// TRC's rules (eod.package_from_product): the bundles before their parts
const RULES: Array<[RegExp, string]> = [
  [/4M Mastermind \+ 6 Month Ignite/i, "4M Mastermind + 6 Month Ignite Coaching"],
  [/Ignite MLO Academy \+ 4M/i, "Ignite MLO Academy + 4M Mastermind"],
  [/ignite/i, "Ignite"], [/4M|mastermind/i, "4M"], [/leap/i, "Leap"],
];

describe("D356: package from Whop", () => {
  it("names the package by the first rule a product matches", () => {
    expect(packageOf(["**Ignite MLO Academy **"], RULES)).toBe("Ignite");
    expect(packageOf(["**Ignite MLO Academy + 4M Mastermind **"], RULES)).toBe("Ignite MLO Academy + 4M Mastermind");
    expect(packageOf(["Clarity Pay: 4M Mastermind + 6 Month Ignite Coaching"], RULES)).toBe("4M Mastermind + 6 Month Ignite Coaching");
  });
  it("a product no rule names (a custom amount like \"9997 **\"), or no rules, says nothing", () => {
    expect(packageOf(["9997 **"], RULES)).toBe("");
    expect(packageOf(["**Ignite MLO Academy **"], [])).toBe("");
  });
});
