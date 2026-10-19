/** #48 (D170): a workflow's starting rung follows what it does: anything that reaches a contact starts in test, the rest in quiet. */
import { describe, it, expect } from "vitest";
import { templates } from "@/templates";
import { parseDefinition } from "@/engine/definition";
import { startRung } from "@/engine/rung";

const rungOf = (slug: string) => startRung(parseDefinition(templates.find((t) => t.slug === slug)!.definition));

describe("the starting rung of a workflow", () => {
  it("every workflow that texts, emails or sends a document starts in test, saying why", () => {
    for (const slug of ["speed-to-lead", "pre-call-sequence", "no-show-recovery", "cancellation-rebook", "post-call-follow-up", "reactivation", "deal-closed", "agreement-send-manually"]) {
      const r = rungOf(slug);
      expect(r.rung, slug).toBe("test");
      expect(r.why, slug).toMatch(/texts|emails|document/);
    }
  });
  it("the team's own workflows (end of day, reports, Health check, the CRM bookkeeping) start in quiet", () => {
    for (const slug of ["eod-reminder", "eod-filed", "daily-wrap-up", "weekly-wrap-up", "monthly-wrap-up", "weekly-leaderboard", "health-check", "calendar-availability", "call-booked", "call-cancelled", "call-outcome", "card-moved", "ledger-drift"])
      expect(rungOf(slug), slug).toEqual({ rung: "quiet", why: "nothing in it reaches a contact" });
  });
  it("every shipped template gets one", () => {
    for (const t of templates) expect(["test", "quiet"]).toContain(startRung(parseDefinition(t.definition)).rung);
  });
});
