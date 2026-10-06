import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { relative, render, StaleTemplateError, UnknownPathError } from "./template";

const now = DateTime.fromISO("2026-10-06T14:00:00", { zone: "America/Phoenix" });
const at = (iso: string) => DateTime.fromISO(iso, { zone: "America/Phoenix" });

describe("relative (D5a: deliberately imprecise)", () => {
  it("rounds minutes to 5: 23 → about 20", () => expect(relative(at("2026-10-06T14:23"), "minutes", now)).toBe("in about 25 minutes"));
  it("rounds 22 → 20", () => expect(relative(at("2026-10-06T14:22"), "minutes", now)).toBe("in about 20 minutes"));
  it("hours mode", () => { expect(relative(at("2026-10-06T16:10"), "hours", now)).toBe("in about 2 hours"); expect(relative(at("2026-10-06T14:50"), "hours", now)).toBe("in about an hour"); });
  it("auto: <60m minutes, <4h hours, then today/tomorrow/weekday", () => {
    expect(relative(at("2026-10-06T14:40"), "auto", now)).toBe("in about 40 minutes");
    expect(relative(at("2026-10-06T16:30"), "auto", now)).toBe("in about 2.5 hours");
    expect(relative(at("2026-10-06T19:00"), "auto", now)).toBe("today at 7pm");
    expect(relative(at("2026-10-07T09:30"), "auto", now)).toBe("tomorrow at 9:30am");
    expect(relative(at("2026-10-09T11:00"), "auto", now)).toBe("Friday at 11am");
  });
  it("THROWS on a non-positive duration — 'in -30 minutes' cannot ship", () => {
    expect(() => relative(at("2026-10-06T13:30"), "auto", now)).toThrow(StaleTemplateError);
    expect(() => relative(now, "minutes", now)).toThrow(StaleTemplateError);
  });
});

describe("render", () => {
  const ctx = { contact: { first_name: "Jamie", timezone: "America/Phoenix" }, appointment: { starts_at: "2026-10-06T22:00:00Z", closer: { first_name: "Sam" } } };
  it("resolves paths and filters at send time", () =>
    expect(render("Hey {{contact.first_name}}, your call with {{appointment.closer.first_name}} is {{appointment.starts_at | relative:auto}}.", ctx, { now, tz: "America/Phoenix" }))
      .toBe("Hey Jamie, your call with Sam is in about an hour."));
  it("date filter honors tz", () => expect(render("{{appointment.starts_at | date:h:mma}}", ctx, { now, tz: "America/Phoenix" })).toBe("3:00PM"));
  it("unknown path throws (save-time validation relies on this)", () => expect(() => render("{{contact.nickname}}", ctx, { now, tz: "UTC" })).toThrow(UnknownPathError));
  it("default filter tolerates a missing path", () => expect(render("{{contact.nickname | default:friend}}", ctx, { now, tz: "UTC" })).toBe("friend"));
});
