import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { callTime } from "./ghl-metrics";

const TZ = "America/New_York";
const day = DateTime.fromISO("2026-10-05", { zone: TZ });
describe("a Sales Call's start (D73)", () => {
  it("an ISO stamp is taken as is", () => expect(callTime("2026-10-05T14:00:00.000Z", day, TZ)?.toISO()).toBe("2026-10-05T10:00:00.000-04:00"));
  it("the display text an outside integration writes is read on the record's call date in the company's zone", () =>
    expect(callTime("Mon Oct 5 · 10:00 AM EDT", day, TZ)?.toISO()).toBe("2026-10-05T10:00:00.000-04:00"));
  it("12 PM is noon and 12 AM midnight", () => { expect(callTime("Mon Oct 5 · 12:00 PM EDT", day, TZ)?.hour).toBe(12); expect(callTime("Mon Oct 5 · 12:30 AM EDT", day, TZ)?.hour).toBe(0); });
  it("a zone that is not the company's on that day is not trusted, nor is text with no time or no call date", () => {
    expect(callTime("Mon Oct 5 · 10:00 AM PDT", day, TZ)).toBeNull();
    expect(callTime("Mon Oct 5", day, TZ)).toBeNull();
    expect(callTime("Mon Oct 5 · 10:00 AM EDT", null, TZ)).toBeNull();
    expect(callTime("", day, TZ)).toBeNull();
  });
});

import { permutationP } from "./ghl-graph";
describe("whether show rates differ by more than chance (D74)", () => {
  it("a stark difference on enough calls is not chance; an even split is", () => {
    expect(permutationP([{ n: 20, s: 18 }, { n: 20, s: 2 }])).toBeLessThan(0.01);
    expect(permutationP([{ n: 10, s: 5 }, { n: 10, s: 5 }])).toBeGreaterThan(0.5);
  });
  it("is deterministic: the same calls give the same answer every time", () => {
    const g = [{ n: 7, s: 5 }, { n: 9, s: 3 }, { n: 4, s: 1 }];
    expect(permutationP(g)).toBe(permutationP(g));
  });
});
