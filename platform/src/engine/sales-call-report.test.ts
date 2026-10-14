/** D115: the review page says every written value with its evidence, every blank with its most likely reading, and escapes what the CRM said. */
import { describe, it, expect } from "vitest";
import { salesCallReportHtml } from "./sales-call-report";
import type { SalesCallReport } from "./sales-call-backfill";

const report: SalesCallReport = { company: "pmu", from: "2026-09-14T00:00:00Z", to: "2026-10-14T20:00:00Z", closer: "carly@x.com", dry_run: true, complete: false, resume_from: "2026-10-01T15:00:00.000Z", plan_id: "42", errors: [],
  summary: { calls: 2, skipped: 1, outcome_unknown: 1, unknown_fields: 1, outcome_showed: 0 },
  rows: [
    { slot_key: "evt-2", kind: "booking", appointment_id: "a2", contact: { id: "c2", ghl_contact_id: "G2", name: "Zed <script>", email: "z@x.com" }, starts_at: "2026-09-20T15:00:00Z", call_date: "2026-09-20", time: "11:00 AM", calendar: "Consultation", closer: "Carly Vu",
      fields: { closer: "carly", cash_collected: 10000 }, evidence: { closer: [{ source: "booking source", detail: "the host" }], cash_collected: [{ source: "payments ledger", detail: "$10,000 & more" }] },
      unknown: [{ field: "outcome", likely: "noshow", why: "the card sits in No Show" }], remarks: ["moved here"], write: null },
    { slot_key: "evt-1", kind: "booking", appointment_id: null, contact: { id: "c1", ghl_contact_id: null, name: "Amy", email: null }, starts_at: "2026-09-18T15:00:00Z", call_date: "2026-09-18", time: "11:00 AM", calendar: "Demo", closer: null, fields: {}, evidence: {}, unknown: [], remarks: [], write: null, skipped: "a test contact" },
  ] };

describe("the Sales Call review page (D115)", () => {
  it("lists calls by time, evidence beside each value, the most likely reading for a blank, and escapes", () => {
    const html = salesCallReportHtml([report], { generatedAt: new Date("2026-10-14T20:00:00Z") });
    expect(html.indexOf("Amy")).toBeLessThan(html.indexOf("Zed"));
    expect(html).toContain("Zed &lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("$10,000");
    expect(html).toContain("$10,000 &amp; more");
    expect(html).toMatch(/Most likely <b>noshow<\/b>.*because the card sits in No Show/s);
    expect(html).toContain("Not written: a test contact");
    expect(html).toContain("run again from 2026-10-01T15:00:00.000Z");
    expect(html).toContain("<code>42</code>");
  });
});
