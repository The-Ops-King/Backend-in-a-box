/** D310: a teammate's calendar copied for a new member as far as Calendly's API allows; the rest is listed, never skipped quietly. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { planEventTypeCopy } from "./event-types";

const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

describe("planEventTypeCopy", () => {
  it("copies what the API takes, lists the questions and the rest by hand; refuses a round robin and a non-member", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("/organization_memberships")) return reply({ collection: url.includes("judith") ? [{ user: { uri: "https://api.calendly.com/users/JU", email: "judith@x.com" } }] : [] });
      if (url.endsWith("/event_types/RR")) return reply({ resource: { uri: "https://api.calendly.com/event_types/RR", name: "Pool", duration: 30, pooling_type: "round_robin" } });
      return reply({ resource: { uri: "https://api.calendly.com/event_types/TAY", name: "Dating Consultation with Taylor", duration: 45, description_plain: "Let's talk", color: "#8247f5", locale: "en",
        locations: [{ kind: "google_conference", location: null }], custom_questions: [{ name: "Phone", enabled: true }, { name: "Old", enabled: false }] } });
    });
    vi.stubGlobal("fetch", fetch);
    const p = await planEventTypeCopy("tok", "https://api.calendly.com/organizations/O", { from: "TAY", ownerEmail: "judith@x.com", name: "Dating Consultation with Judith" });
    expect(p).toMatchObject({ ok: true, plan: { from: { id: "TAY", duration: 45 }, create: { owner: "https://api.calendly.com/users/JU", name: "Dating Consultation with Judith", duration: 45, description: "Let's talk", locations: [{ kind: "google_conference" }], color: "#8247f5", locale: "en", active: true } } });
    if (p.ok) expect(p.plan.by_hand[0]).toBe('booking questions, as on "Dating Consultation with Taylor": Phone');
    expect(await planEventTypeCopy("tok", "O", { from: "TAY", ownerEmail: "judith@x.com", name: "Short", duration: 15 })).toMatchObject({ ok: true, plan: { create: { duration: 15 } } });
    expect(await planEventTypeCopy("tok", "O", { from: "RR", ownerEmail: "judith@x.com", name: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/round_robin/) });
    expect(await planEventTypeCopy("tok", "O", { from: "TAY", ownerEmail: "nobody@x.com", name: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/no member/) });
  });
});
