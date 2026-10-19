/** D171: the wizard's intake: what is asked, what is refused, and how the answers pick a playbook and say what fits. */
import { describe, it, expect } from "vitest";
import { fitReport, intakeProblems, emailsOf, type Intake } from "@/onboarding/intake";
import { templates } from "@/templates";

const pmuLike: Intake = { business: "Beauty Moguls", price: "10000", deposits: true, payment_plans: false, lead_paths: ["ads_vsl_application", "ads_direct_book"], application: "none", setters: true, triage: false, boards: "one",
  journey: "Ads to a VSL, they book a call with Carly, she closes on the call.", crm: "ghl", booking: "calendly", payments: "whop", recording: "fathom", agreement: "ghl_documents" };
const fit = (r: ReturnType<typeof fitReport>, slug: string) => r.workflows.find((w) => w.slug === slug)!;

describe("the intake", () => {
  it("complete answers pass; each problem is one line naming the question", () => {
    expect(intakeProblems(pmuLike)).toEqual([]);
    expect(intakeProblems({ ...pmuLike, price: "ten grand", booking: "zoom", deposits: "yes", nope: 1 })).toEqual([
      "nope: not a question the wizard asks", "Program price ($): an amount in dollars, like 5000", "Takes deposits: yes or no", "Booking: one of Calendly, GHL calendars, iClosed, Other"]);
    expect(intakeProblems({ business: "x" })).toContain("Program price ($): required");
    expect(intakeProblems({ ...pmuLike, setters: false, triage: true })).toEqual(["A triage call is a setter's call: with no setters, there is no triage call"]);
    expect(emailsOf("Carly@x.com\n annabelle@x.com, nope")).toEqual(["carly@x.com", "annabelle@x.com"]);
  });

  it("PMU's answers pick the one-board playbook exactly; every workflow fits but Setter call logged (one board has no setter card), its copies named", () => {
    const r = fitReport(pmuLike);
    expect(r).toMatchObject({ playbook: "one-board", gaps: ["Setter call logged on one board: it moves a setter card, and one board has none (a one-board copy is to build)"], notes: [] });
    expect(r.workflows).toHaveLength(templates.length);
    expect(r.workflows.filter((w) => w.fit !== "fits").map((w) => [w.slug, w.fit])).toEqual([["setter-call-logged", "build"]]);
    expect(fitReport({ ...pmuLike, setters: false }).workflows.every((w) => w.fit === "fits" || (w.slug === "setter-call-logged" && w.fit === "off"))).toBe(true);
    expect(fit(r, "call-booked").why).toBe("the One board playbook's own copy");
    expect(fit(r, "eod-reminder").why).toBe("as shipped");
  });

  it("Dating's answers pick application and triage; Hair's pick setter and closer", () => {
    expect(fitReport({ ...pmuLike, application: "typeform", triage: true, boards: "setter_and_closer" }).playbook).toBe("application-triage");
    expect(fitReport({ ...pmuLike, boards: "setter_and_closer" }).playbook).toBe("setter-closer");
  });

  it("no exact playbook: the closest, with the differences on the build list", () => {
    const r = fitReport({ ...pmuLike, boards: "one", application: "typeform", triage: true });
    expect(r.playbook).toBe("one-board");
    expect(r.notes[0]).toMatch(/^No playbook matches exactly: One board is the closest \(it has no application form; this offer has one; it has no triage call; this offer has one\)/);
    expect(r.gaps).toEqual(["Playbook: it has no application form; this offer has one", "Playbook: it has no triage call; this offer has one", "Setter call logged on one board: it moves a setter card, and one board has none (a one-board copy is to build)"]);
  });

  it("software the engine does not read is a tweak (a Zap door exists) or a build (it does not); what is not used is off", () => {
    const r = fitReport({ ...pmuLike, booking: "iclosed", payments: "stripe", recording: "none", agreement: "none", setters: false, payment_plans: true, lead_paths: ["organic_dm"] });
    expect(fit(r, "call-booked")).toMatchObject({ fit: "build", why: "bookings come from iClosed, which the engine does not read yet" });
    expect(fit(r, "payment-recorded")).toMatchObject({ fit: "tweak", why: expect.stringMatching(/Stripe come in through a Zap/) });
    expect(fit(r, "call-recorded").fit).toBe("off");
    expect(fit(r, "agreement-chase").fit).toBe("off");
    expect(fit(r, "deal-closed").fit).toBe("tweak");
    expect(fit(r, "setter-call-logged").fit).toBe("off");
    expect(fit(r, "new-lead").fit).toBe("tweak");
    expect(r.gaps).toEqual(expect.arrayContaining(["Bookings from iClosed: the engine reads Calendly and GHL calendars", "DM leads: nothing brings an Instagram DM lead into the CRM yet (problem 7)"]));
  });

  it("another CRM: every workflow waits on its connector, said once; a takeover says how it differs", () => {
    const r = fitReport({ ...pmuLike, crm: "hubspot" }, "takeover");
    expect(r.workflows.every((w) => w.fit === "build" && w.why === "needs a HubSpot connector")).toBe(true);
    expect(r.notes).toEqual([expect.stringMatching(/^A takeover/), "The engine reads and writes GoHighLevel. HubSpot needs its own CRM connector before any workflow can run (#53)."]);
  });
});
