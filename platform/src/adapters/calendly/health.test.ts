import { describe, it, expect, afterEach, vi } from "vitest";
import { calendlyBusyTimes, calendlyEventTypeHosts, calendlyEventTypeSchedules } from "./health";

/** D72's three reads against canned Calendly answers: what each path asks for and what is kept. */
const serve = (routes: Record<string, unknown>) => {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return new Response("not found", { status: 404 });
    return typeof hit[1] === "number" ? new Response("refused", { status: hit[1] }) : new Response(JSON.stringify(hit[1]), { status: 200 });
  });
  return asked;
};
afterEach(() => vi.unstubAllGlobals());
const page = (collection: unknown[]) => ({ collection, pagination: { next_page: null } });
const ET = "https://api.calendly.com/event_types/ET1";

describe("Calendly reads for per-closer availability (D72)", () => {
  it("busy times: a Calendly booking counts with its buffers, an external event as it is", async () => {
    const asked = serve({ "/user_busy_times": { collection: [
      { type: "calendly", start_time: "2026-10-12T15:00:00Z", end_time: "2026-10-12T15:45:00Z", buffered_start_time: "2026-10-12T14:45:00Z", buffered_end_time: "2026-10-12T16:00:00Z" },
      { type: "external", start_time: "2026-10-12T18:00:00Z", end_time: "2026-10-12T19:00:00Z" }] } });
    const r = await calendlyBusyTimes("tok", "https://api.calendly.com/users/U1", new Date("2026-10-10T12:00:00Z"), new Date("2026-10-17T11:59:00Z"));
    expect(r).toEqual({ ok: true, busy: [{ start: "2026-10-12T14:45:00Z", end: "2026-10-12T16:00:00Z" }, { start: "2026-10-12T18:00:00Z", end: "2026-10-12T19:00:00Z" }] });
    expect(asked[0]).toContain("user=https%3A%2F%2Fapi.calendly.com%2Fusers%2FU1");
  });
  it("schedules: the event type's own, one per host when each host has their own, shared when there is no user", async () => {
    serve({ "/event_type_availability_schedules": page([
      { event_type: ET, availability_setting: "host", availability_rule: { timezone: "America/Chicago", user: "https://api.calendly.com/users/U1", rules: [{ type: "wday", wday: "monday", intervals: [{ from: "09:00", to: "17:00" }] }] } },
      { event_type: ET, availability_rule: { timezone: "America/New_York", rules: [] } }]) });
    expect(await calendlyEventTypeSchedules("tok", ET)).toEqual({ ok: true, schedules: [
      { user: "https://api.calendly.com/users/U1", timezone: "America/Chicago", rules: [{ type: "wday", wday: "monday", intervals: [{ from: "09:00", to: "17:00" }] }] },
      { user: undefined, timezone: "America/New_York", rules: [] }] });
  });
  it("hosts: the event type's host list with its duration; when that endpoint refuses the token, each member's own listing", async () => {
    serve({ "/event_types/ET1": { resource: { duration: 45 } }, "/event_type_memberships": page([{ member: { uri: "U1", email: "james@x.co", name: "James" } }, { member: { uri: "U2", email: "josh@x.co", name: "Josh" } }]) });
    expect(await calendlyEventTypeHosts("tok", ET)).toEqual({ ok: true, duration: 45, hosts: [{ uri: "U1", email: "james@x.co", name: "James" }, { uri: "U2", email: "josh@x.co", name: "Josh" }] });
    serve({ "/event_types/ET1": { resource: { duration: 30 } }, "/event_type_memberships": 403,
      "/organization_memberships": page([{ user: { uri: "U1", email: "james@x.co", name: "James" } }, { user: { uri: "U3", email: "sam@x.co", name: "Sam" } }]),
      "/event_types?user=U1": page([{ uri: ET }]), "/event_types?user=U3": page([{ uri: "https://api.calendly.com/event_types/OTHER" }]) });
    expect(await calendlyEventTypeHosts("tok", ET, "https://api.calendly.com/organizations/O1")).toEqual({ ok: true, duration: 30, hosts: [{ uri: "U1", email: "james@x.co", name: "James" }] });
    expect(await calendlyEventTypeHosts("tok", ET)).toMatchObject({ ok: false, error: expect.stringMatching(/403/) });
  });
});
