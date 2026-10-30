/** D243: a round robin's hosts are the ones Calendly says host it, not every member whose own listing carries the type. */
import { describe, it, expect, afterEach, vi } from "vitest";
import { calendlyBooking } from "./read";
import type { Company } from "@/adapters/types";

const page = (collection: unknown[]) => ({ collection, pagination: { next_page: null } });
const serve = (routes: Array<[string, unknown]>) => vi.stubGlobal("fetch", async (url: string) => {
  const hit = routes.find(([k]) => url.includes(k));
  if (!hit) return new Response("not found", { status: 404 });
  return typeof hit[1] === "number" ? new Response("refused", { status: hit[1] }) : new Response(JSON.stringify(hit[1]), { status: 200 });
});
afterEach(() => vi.unstubAllGlobals());
const co = { id: "C", booking: { source: "calendly", token: "tok", organization: "https://api.calendly.com/organizations/O" } } as unknown as Company;
const RR = { uri: "https://api.calendly.com/event_types/RR1", name: "Consultation RR", scheduling_url: "x", active: true, pooling_type: "round_robin" };
const members = page([{ user: { uri: "U1", email: "carly@x.co", name: "Carly" } }, { user: { uri: "U2", email: "jp@x.co", name: "Jose" } }, { user: { uri: "U3", email: "team@x.co", name: "Mary Emily" } }]);
const listings: Array<[string, unknown]> = [["/organization_memberships", members], ["event_types?user=U1", page([RR])], ["event_types?user=U2", page([RR])], ["event_types?user=U3", page([RR])]];

describe("D243: round-robin hosts", () => {
  it("the hosts endpoint's answer, not everyone whose listing carries the type", async () => {
    serve([["/event_type_memberships", page([{ member: { email: "carly@x.co", name: "Carly" } }, { member: { email: "jp@x.co", name: "Jose" } }])], ...listings]);
    const [cal] = await calendlyBooking.listCalendars(co);
    expect(cal.hosts?.map((h) => h.email)).toEqual(["carly@x.co", "jp@x.co"]);
  });
  it("when the hosts endpoint refuses the token, the listings are kept", async () => {
    serve([["/event_type_memberships", 403], ...listings]);
    const [cal] = await calendlyBooking.listCalendars(co);
    expect(cal.hosts?.map((h) => h.email)).toEqual(["carly@x.co", "jp@x.co", "team@x.co"]);
  });
});

describe("D258: a one-host type an admin can also see", () => {
  it("is hosted by whom Calendly says, not by the admin whose listing also carries it", async () => {
    const own = { uri: "https://api.calendly.com/event_types/T1", name: "Dating Consultation with Taylor", scheduling_url: "x", active: true };
    serve([["/organization_memberships", page([{ user: { uri: "U1", email: "taylor@x.co", name: "Taylor" } }, { user: { uri: "U2", email: "admin@x.co", name: "Tyler" } }])],
      ["event_types?user=U1", page([own])], ["event_types?user=U2", page([own])], ["/event_type_memberships", page([{ member: { email: "taylor@x.co", name: "Taylor" } }])]]);
    const [cal] = await calendlyBooking.listCalendars(co);
    expect(cal.hosts?.map((h) => h.email)).toEqual(["taylor@x.co"]);
  });
});
