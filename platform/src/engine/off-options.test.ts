/** D302: a value a choice field does not offer is left out of a record write, so the rest is still written. */
import { describe, it, expect } from "vitest";
import { offOptions } from "./executor";

const OPTS = new Map([
  ["next_step", [{ key: "follow_up_booked", label: "Follow up booked" }, { key: "sending_info" }, { key: "nurture" }, { key: "dead" }]],
  ["objections", [{ key: "price" }, { key: "timing" }]],
]);

describe("D302: values a choice field does not offer", () => {
  it("a sentence in a single choice field is left out and named; the rest stays as it was", () => {
    const p: Record<string, unknown> = { next_step: "Continue the call at the same time tomorrow", recording_url: "https://x", closer: "minerva" };
    expect(offOptions(p, OPTS)).toEqual([{ field: "next_step", value: "Continue the call at the same time tomorrow" }]);
    expect(p).toEqual({ recording_url: "https://x", closer: "minerva" });
  });
  it("an option's key or its label, any case, is written as it was", () => {
    const p: Record<string, unknown> = { next_step: "Follow Up Booked" };
    expect(offOptions(p, OPTS)).toEqual([]);
    expect(p).toEqual({ next_step: "Follow Up Booked" });
    const q: Record<string, unknown> = { next_step: "NURTURE" };
    expect(offOptions(q, OPTS)).toEqual([]);
  });
  it("a multiple choice keeps the values it offers; none left, the field is left out", () => {
    const p: Record<string, unknown> = { objections: ["price", "spouse"] };
    expect(offOptions(p, OPTS)).toEqual([{ field: "objections", value: "spouse" }]);
    expect(p).toEqual({ objections: ["price"] });
    const q: Record<string, unknown> = { objections: ["spouse"] };
    offOptions(q, OPTS);
    expect(q).toEqual({});
  });
  it("options not known (the CRM unread, or a plain field) check nothing", () => {
    const p: Record<string, unknown> = { next_step: "anything", notes: "free text" };
    expect(offOptions(p, null)).toEqual([]);
    expect(offOptions(p, OPTS)).toEqual([{ field: "next_step", value: "anything" }]);
    expect(p).toEqual({ notes: "free text" });
  });
});
