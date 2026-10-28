import { describe, expect, it } from "vitest";
import { APP_COMPLETE, APP_PARTIAL, NOT_BOOKED, peopleOf, personOf, tagChange } from "./application-tags";
import type { TfResponse } from "@/adapters/typeform/client";

const resp = (email: string | null, phone: string | null, at: string, first = "Ann"): TfResponse => ({ token: `${email}-${at}`, landed_at: at, submitted_at: at,
  answers: [{ field: { ref: "f" }, type: "text", text: first }, ...(phone ? [{ field: { ref: "p" }, type: "phone_number", phone_number: phone }] : []), ...(email ? [{ field: { ref: "e" }, type: "email", email }] : [])] });

describe("D250 application tags", () => {
  it("reads the person by the answers' types", () => {
    expect(personOf(resp("Ann@X.com", "+1 (602) 555-0101", "2026-10-01"))).toMatchObject({ email: "ann@x.com", name: "Ann" });
  });
  it("one submitted response makes the person complete, whichever came first; no email or phone is unidentified", () => {
    const { people, unidentified } = peopleOf([
      { r: resp("a@x.com", null, "2026-10-02"), status: "partial" }, { r: resp("a@x.com", null, "2026-10-01"), status: "complete" },
      { r: resp("b@x.com", null, "2026-10-01"), status: "partial" }, { r: resp(null, null, "2026-10-01"), status: "partial" },
    ]);
    expect(unidentified).toBe(1);
    expect(Object.fromEntries(people.map((p) => [p.key, [p.status, p.responses]]))).toEqual({ "a@x.com": ["complete", 2], "b@x.com": ["partial", 1] });
  });
  it("complete takes partial off; partial never goes on someone complete; not-booked follows the booking", () => {
    expect(tagChange([APP_PARTIAL], "complete", false)).toEqual({ add: [APP_COMPLETE, NOT_BOOKED], remove: [APP_PARTIAL] });
    expect(tagChange([APP_COMPLETE], "partial", true)).toEqual({ add: [], remove: [] });
    expect(tagChange([NOT_BOOKED], "partial", true)).toEqual({ add: [APP_PARTIAL], remove: [NOT_BOOKED] });
    expect(tagChange([APP_COMPLETE, NOT_BOOKED], "complete", false)).toEqual({ add: [], remove: [] });
  });
});
