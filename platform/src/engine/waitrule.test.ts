import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { computeWaitUntil, deferIntoWindow } from "./waitrule";

const tz = "America/Phoenix";
const now = DateTime.fromISO("2026-10-06T12:00:00", { zone: tz });
const t = (ctx: Record<string, unknown>) => ({ now, contactTz: tz, companyTz: tz, ctx });

describe("D14 wait rules", () => {
  it("morning of, in their timezone", () => {
    const r = computeWaitUntil({ anchor: "appointment.starts_at", offset: "day_of@08:00", tz: "contact" }, t({ appointment: { starts_at: "2026-10-08T21:00:00Z" } })); // 2pm Phoenix on the 8th
    expect(r.at.setZone(tz).toISO()).toBe("2026-10-08T08:00:00.000-07:00"); expect(r.usedFallback).toBe(false);
  });
  it("…unless it's before 10am → evening before (the guard + fallback)", () => {
    const r = computeWaitUntil({ anchor: "appointment.starts_at", offset: "day_of@08:00", tz: "contact", guard: { min_lead: "2h", fallback: "day_before@19:00" } }, t({ appointment: { starts_at: "2026-10-08T16:00:00Z" } })); // 9am Phoenix
    expect(r.at.setZone(tz).toISO()).toBe("2026-10-07T19:00:00.000-07:00"); expect(r.usedFallback).toBe(true);
  });
  it("earliest / latest: four hours before a 7am call is 8am, not 3am; a day before an 11pm call is 9pm, not 11pm; a 2pm call keeps 10am", () => {
    const at = (starts: string, rule: Partial<Parameters<typeof computeWaitUntil>[0]>) => computeWaitUntil({ anchor: "appointment.starts_at", offset: "-4h", tz: "contact", ...rule }, t({ appointment: { starts_at: starts } })).at.setZone(tz).toFormat("yyyy-MM-dd HH:mm");
    expect(at("2026-10-08T07:00:00-07:00", { earliest: "08:00", latest: "21:00" })).toBe("2026-10-08 08:00");
    expect(at("2026-10-08T23:00:00-07:00", { offset: "-1d", earliest: "08:00", latest: "21:00" })).toBe("2026-10-07 21:00");
    expect(at("2026-10-08T14:00:00-07:00", { offset: "-1h", earliest: "07:00" })).toBe("2026-10-08 13:00");
    expect(at("2026-10-08T14:00:00-07:00", { earliest: "08:00", latest: "21:00" })).toBe("2026-10-08 10:00");
  });
  it("relative offsets from now", () => expect(computeWaitUntil({ anchor: "now", offset: "+4h", tz: "contact" }, t({})).at.toISO()).toBe(now.plus({ hours: 4 }).toISO()));
  it("never returns the past (a late rule fires now)", () => {
    const r = computeWaitUntil({ anchor: "appointment.starts_at", offset: "-1d", tz: "contact" }, t({ appointment: { starts_at: now.plus({ hours: 3 }).toISO() } }));
    expect(r.at.toISO()).toBe(now.toISO());
  });
});

describe("D5d send window: defer forward only", () => {
  it("inside the window: unchanged", () => expect(deferIntoWindow(now, tz, "08:00", "20:00")).toEqual({ at: now, deferred: false }));
  it("2am → 8am same day", () => { const r = deferIntoWindow(DateTime.fromISO("2026-10-06T02:00", { zone: tz }), tz, "08:00", "20:00"); expect(r.deferred).toBe(true); expect(r.at.toISO()).toBe("2026-10-06T08:00:00.000-07:00"); });
  it("9pm → 8am tomorrow, never backward", () => { const r = deferIntoWindow(DateTime.fromISO("2026-10-06T21:00", { zone: tz }), tz, "08:00", "20:00"); expect(r.at.toISO()).toBe("2026-10-07T08:00:00.000-07:00"); });
});
