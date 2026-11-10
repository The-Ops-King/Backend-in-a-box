/** D327: GHL refuses a second card for a person on a board and names the one it has; the step takes that card. */
import { describe, it, expect } from "vitest";
import { duplicateCard } from "./executor";
import { GhlError } from "@/adapters/ghl/client";

describe("D327: GHL's existing card on a duplicate refusal", () => {
  it("reads the card GHL names", () => {
    const e = new GhlError(400, JSON.stringify({ statusCode: 400, message: "Can not create duplicate opportunity for the contact.", code: "OPPORTUNITY_NO_DUPLICATE", meta: { existingId: "fIFHXCjEKBQ1O4vKwAjk" } }), "/opportunities/");
    expect(duplicateCard(e)).toBe("fIFHXCjEKBQ1O4vKwAjk");
  });
  it("anything else is not a duplicate", () => {
    expect(duplicateCard(new GhlError(400, '{"message":"pipelineStageId is invalid"}', "/opportunities/"))).toBeNull();
    expect(duplicateCard(new GhlError(400, '{"code":"OPPORTUNITY_NO_DUPLICATE"}', "/opportunities/"))).toBeNull();   // no card named: nothing to take
    expect(duplicateCard(new Error("boom"))).toBeNull();
  });
});
