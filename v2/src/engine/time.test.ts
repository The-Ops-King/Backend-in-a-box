import { describe, expect, it } from "vitest";
import { SendWindow } from "@/workflow/definition";
import { TimeRule } from "@/workflow/primitives/common";
import { atClock, computeTimeRule, fitSendWindow, inWindow, localDay, localToInstant, nextOpen, partsIn } from "./time";

const NY = "America/New_York";
const iso = (d: Date | undefined) => d?.toISOString();
const w = (x: Partial<SendWindow> = {}) => SendWindow.parse({ zone: "contact", opens: "08:00", closes: "20:00", outside: "earlier_same_day", transactional: "any_hour", ...x });

describe("clock arithmetic in a zone", () => {
  it("reads an instant's local parts and turns a local time back into the instant", () => {
    const t = new Date("2026-10-29T18:00:00Z");
    expect(partsIn(t, NY)).toEqual({ y: 2026, m: 10, d: 29, h: 14, mi: 0, weekday: 4 });
    expect(iso(localToInstant(2026, 10, 29, 14, 0, NY))).toBe("2026-10-29T18:00:00.000Z");
  });
  it("keeps the wall clock across a daylight-saving change", () => {
    expect(iso(localToInstant(2026, 11, 2, 9, 0, NY))).toBe("2026-11-02T14:00:00.000Z"); // EST after fall back
    expect(iso(atClock(new Date("2026-10-31T18:00:00Z"), "09:00", NY, 2))).toBe("2026-11-02T14:00:00.000Z");
    expect(iso(localToInstant(2026, 3, 8, 12, 0, NY))).toBe("2026-03-08T16:00:00.000Z"); // EDT after spring forward
    expect(partsIn(localToInstant(2026, 3, 8, 2, 30, NY), NY).h).toBe(3); // 2:30 does not exist that night
  });
  it("gives a local day's bounds", () => {
    const d = localDay(new Date("2026-10-27T03:30:00Z"), NY);
    expect(d).toEqual({ day: "2026-10-26", start: new Date("2026-10-26T04:00:00Z"), end: new Date("2026-10-27T04:00:00Z") });
  });
});

describe("a time rule worked out", () => {
  const ctx = { appointment: { starts_at: "2026-10-29T18:00:00Z", booked_at: "2026-10-26T14:00:00Z" }, contact: { timezone: NY } };
  const env = { now: new Date("2026-10-26T14:00:00Z"), offerZone: "America/Denver", contactZone: NY };
  const rule = (r: Record<string, unknown>) => TimeRule.parse({ zone: "contact", ...r });
  const at = (r: Record<string, unknown>, reached = env.now) => iso(computeTimeRule(rule(r), ctx, env, reached)?.at);
  it("shifts the anchor by its offset", () => {
    expect(at({ anchor: "appointment.starts_at", offset: "-24h" })).toBe("2026-10-28T18:00:00.000Z");
    expect(at({ anchor: "now", offset: "+2h" })).toBe("2026-10-26T16:00:00.000Z");
    expect(at({ anchor: "appointment.starts_at" })).toBe("2026-10-29T18:00:00.000Z");
  });
  it("puts a day rule at that clock time on the anchor's day in the rule's zone", () => {
    expect(at({ anchor: "appointment.starts_at", offset: "day_before@19:00" })).toBe("2026-10-28T23:00:00.000Z");
    expect(at({ anchor: "appointment.starts_at", offset: "day_of@08:00", zone: "offer" })).toBe("2026-10-29T14:00:00.000Z");
    expect(at({ anchor: "appointment.starts_at", offset: "day_after@09:00" })).toBe("2026-10-30T13:00:00.000Z");
  });
  it("takes one {{…}} expression as the anchor, for time arithmetic", () => {
    expect(at({ anchor: "{{appointment.starts_at | minus:30m}}" })).toBe("2026-10-29T17:30:00.000Z");
    expect(at({ anchor: "{{appointment.booked_at | plus:1d}}", offset: "+1h" })).toBe("2026-10-27T15:00:00.000Z");
  });
  it("falls back to `fallback` from when the step was reached when the anchor was closer than minLead then", () => {
    const g = { anchor: "appointment.starts_at", offset: "-4h", guard: { minLead: "6h", fallback: "+15m" } };
    expect(at(g, new Date("2026-10-29T14:00:00Z"))).toBe("2026-10-29T14:15:00.000Z");
    expect(at(g, new Date("2026-10-29T10:00:00Z"))).toBe("2026-10-29T14:00:00.000Z");
    const later = { ...env, now: new Date("2026-10-29T14:10:00Z") };
    expect(iso(computeTimeRule(rule(g), ctx, later, new Date("2026-10-29T14:00:00Z"))?.at)).toBe("2026-10-29T14:15:00.000Z");
  });
  it("keeps the time between earliest and latest on that day", () => {
    const early = { ...ctx, appointment: { starts_at: "2026-10-29T11:00:00Z" } }; // 7am New York
    expect(iso(computeTimeRule(rule({ anchor: "appointment.starts_at", offset: "-4h", earliest: "08:00" }), early, env, env.now)?.at)).toBe("2026-10-29T12:00:00.000Z");
    expect(at({ anchor: "appointment.starts_at", offset: "+8h", latest: "21:00" })).toBe("2026-10-30T01:00:00.000Z");
  });
  it("has no time when the anchor is not a date-time", () => {
    expect(computeTimeRule(rule({ anchor: "appointment.ends_at" }), ctx, env, env.now)).toBeUndefined();
  });
});

describe("the send window", () => {
  const at = (s: string) => new Date(s);
  it("knows inside from outside, on the window's days", () => {
    expect(inWindow(at("2026-10-26T14:00:00Z"), w(), NY)).toBe(true); // Mon 10am
    expect(inWindow(at("2026-10-26T11:59:00Z"), w(), NY)).toBe(false); // 7:59am
    expect(inWindow(at("2026-10-27T00:00:00Z"), w(), NY)).toBe(false); // 8pm sharp: closed
    expect(inWindow(at("2026-10-31T14:00:00Z"), w({ days: [1, 2, 3, 4, 5] }), NY)).toBe(false); // Saturday
  });
  it("opens next: today's opening before it, tomorrow's after closing, the next open day on a shut one", () => {
    expect(iso(nextOpen(at("2026-10-26T10:00:00Z"), w(), NY))).toBe("2026-10-26T12:00:00.000Z");
    expect(iso(nextOpen(at("2026-10-27T01:00:00Z"), w(), NY))).toBe("2026-10-27T12:00:00.000Z");
    expect(iso(nextOpen(at("2026-10-31T14:00:00Z"), w({ days: [1, 2, 3, 4, 5] }), NY))).toBe("2026-11-02T13:00:00.000Z");
    expect(iso(nextOpen(at("2026-10-26T14:00:00Z"), w(), NY))).toBe("2026-10-26T14:00:00.000Z");
  });
  it("moves a time before opening to the opening that day", () => {
    expect(fitSendWindow(at("2026-10-28T11:00:00Z"), w(), NY)).toEqual({ at: at("2026-10-28T12:00:00Z"), moved: "to_opening" });
  });
  it("moves a time at or after closing to a minute before closing the same day, or to the next opening", () => {
    expect(fitSendWindow(at("2026-10-29T01:00:00Z"), w(), NY)).toEqual({ at: at("2026-10-28T23:59:00Z"), moved: "earlier_same_day" });
    expect(fitSendWindow(at("2026-10-29T00:00:00Z"), w(), NY)).toEqual({ at: at("2026-10-28T23:59:00Z"), moved: "earlier_same_day" });
    expect(fitSendWindow(at("2026-10-29T01:00:00Z"), w({ outside: "next_open" }), NY)).toEqual({ at: at("2026-10-29T12:00:00Z"), moved: "next_open" });
  });
  it("leaves a time inside alone, and moves one on a shut day to the next opening", () => {
    expect(fitSendWindow(at("2026-10-28T18:00:00Z"), w(), NY)).toEqual({ at: at("2026-10-28T18:00:00Z"), moved: "no" });
    expect(fitSendWindow(at("2026-11-01T18:00:00Z"), w({ days: [1, 2, 3, 4, 5] }), NY).moved).toBe("next_open");
  });
});
