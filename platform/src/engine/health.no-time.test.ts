/** D328: a Calendly calendar with no open time says why when a host's connected calendar holds them busy (Judith, 2026-11-10). */
import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { noTimeWhy, type HealthProbes } from "./health";
import { fakeProbes } from "./test-install";

const now = DateTime.fromISO("2026-11-10T12:00:00Z");
const probes = (busy: { start: string; end: string; type?: string }[]): HealthProbes => ({ ...fakeProbes,
  calendlyEventTypeHosts: async () => ({ ok: true, duration: 45, hosts: [{ uri: "U-J", email: "judith@x.com", name: "Judith Castro" }] }),
  calendlyBusyTimes: async () => ({ ok: true, busy }) });
const cal = { external_id: "ET1", name: "Dating Consultation with Judith" };
// two events a day, midnight to 7:30 PM and 7:30 PM to 1 AM her time (UTC-4)
const day = (d: number) => { const b = now.startOf("day").plus({ days: d, hours: 4 }); return [{ type: "external", start: b.toISO()!, end: b.plus({ hours: 19.5 }).toISO()! }, { type: "external", start: b.plus({ hours: 19.5 }).toISO()!, end: b.plus({ hours: 25 }).toISO()! }]; };

describe("D328: why a calendar has no open time", () => {
  it("a connected calendar that holds the host busy all week is named, with the fix", async () => {
    const why = await noTimeWhy(probes([-1, 0, 1, 2, 3, 4, 5, 6, 7].flatMap(day)), "tok", cal, 7, now);
    expect(why).toMatch(/a calendar connected in Calendly shows Judith Castro \(\d+% of the time\) busy/);
    expect(why).toMatch(/Check for conflicts/);
  });
  it("Calendly's own bookings, or a calendar with ordinary events, is the general sentence", async () => {
    const own = [-1, 0, 1, 2, 3, 4, 5, 6, 7].flatMap(day).map((b) => ({ ...b, type: "calendly" }));
    expect(await noTimeWhy(probes(own), "tok", cal, 7, now)).toMatch(/availability may be off, or every time is booked/);
    expect(await noTimeWhy(probes([{ type: "external", start: now.plus({ hours: 2 }).toISO()!, end: now.plus({ hours: 3 }).toISO()! }]), "tok", cal, 7, now)).toMatch(/availability may be off/);
  });
});
