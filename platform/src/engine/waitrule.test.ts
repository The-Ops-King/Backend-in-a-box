import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { computeWaitUntil, deferIntoWindow, pullBackIntoWindow } from "./waitrule";

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

describe("D193: a reminder after the window closes goes back to just before it, the same day", () => {
  const tz = "America/New_York";
  const at = (s: string) => DateTime.fromISO(s, { zone: tz });
  it("after close: a minute before close that day; inside or before the window: unchanged (the forward deferral handles before-open)", () => {
    expect(pullBackIntoWindow(at("2026-10-21T20:30"), tz, "08:00", "20:00").toISO()).toBe(at("2026-10-21T19:59").toISO());
    expect(pullBackIntoWindow(at("2026-10-21T23:00"), tz, "08:00", "20:00").toISO()).toBe(at("2026-10-21T19:59").toISO());
    expect(pullBackIntoWindow(at("2026-10-21T19:00"), tz, "08:00", "20:00").toISO()).toBe(at("2026-10-21T19:00").toISO());
    expect(pullBackIntoWindow(at("2026-10-21T06:00"), tz, "08:00", "20:00").toISO()).toBe(at("2026-10-21T06:00").toISO());
  });
  it("a 9pm call (the person's time): the day-before goes at 7:59pm the night before, and the hour-before at 7:59pm, instead of the next morning", () => {
    const call = at("2026-10-22T21:00");
    for (const offset of ["-24h", "-1h"]) {
      const r = computeWaitUntil({ anchor: "appointment.starts_at", offset, tz: "contact", window: "before" }, { now: at("2026-10-20T12:00"), contactTz: tz, companyTz: "America/Los_Angeles", ctx: { appointment: { starts_at: call.toISO() } } });
      const pulled = pullBackIntoWindow(r.at, tz, "08:00", "20:00");
      expect(deferIntoWindow(pulled, tz, "08:00", "20:00")).toEqual({ at: pulled, deferred: false });
      expect(pulled.setZone(tz).toFormat("yyyy-MM-dd HH:mm")).toBe(offset === "-24h" ? "2026-10-21 19:59" : "2026-10-22 19:59");
    }
  });
});

describe("D353: calls only in the person's permitted hours and days", () => {
  const ny = "America/New_York";
  const at = (nowIso: string, rule: Record<string, unknown>) => computeWaitUntil({ anchor: "now", offset: "+0m", tz: "contact", ...rule } as never, { now: DateTime.fromISO(nowIso, { zone: ny }), contactTz: ny, companyTz: tz, ctx: {} }).at.setZone(ny).toFormat("yyyy-MM-dd HH:mm");
  const calls = { earliest: "08:00", latest: "20:00", after_latest: "next_day", skip_days: [7], skip_holidays: "us_federal" };
  it("inside the window: as it is", () => expect(at("2026-11-18T10:15:00", calls)).toBe("2026-11-18 10:15"));
  it("before 8am: 8am that day; after 8pm: 8am the next day (a call is never pulled earlier)", () => {
    expect(at("2026-11-18T06:30:00", calls)).toBe("2026-11-18 08:00");
    expect(at("2026-11-18T21:30:00", calls)).toBe("2026-11-19 08:00");
  });
  it("a Sunday moves to Monday 8am; Saturday is a calling day", () => {
    expect(at("2026-11-22T11:00:00", calls)).toBe("2026-11-23 08:00");   // Sun 22 Nov
    expect(at("2026-11-21T11:00:00", calls)).toBe("2026-11-21 11:00");   // Sat 21 Nov
  });
  it("US federal holidays as observed are skipped: Thanksgiving, Christmas, a Saturday July 4th's Friday", () => {
    expect(at("2026-11-26T09:00:00", calls)).toBe("2026-11-27 08:00");   // Thanksgiving 2026
    expect(at("2026-12-24T21:00:00", calls)).toBe("2026-12-26 08:00");   // after 8pm Christmas Eve: Christmas (Fri) skipped, Sat 26
    expect(at("2026-07-03T09:00:00", calls)).toBe("2026-07-06 08:00");   // Jul 4 2026 is a Saturday: observed Fri 3 and the 4th itself skipped, Sun 5 too
  });
  it("a rule without the new options is unchanged: the same-day clamp, never earlier than now", () => expect(at("2026-11-18T21:30:00", { earliest: "08:00", latest: "20:00" })).toBe("2026-11-18 21:30"));
});
