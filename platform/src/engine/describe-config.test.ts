import { describe, it, expect } from "vitest";
import { buildPrompt, Proposal } from "./describe-config";
describe("describe-it-in-text setup", () => {
  it("the model is shown every calendar with its questions and hosts, the roster, and what is mapped now", () => {
    const { system, user } = buildPrompt({ calendars: [{ id: "c1", name: "45 Min Strategy Call - S", teamMemberIds: [], pooling: "round_robin", hosts: [{ name: "James", email: "james@x.com" }], questions: [{ name: "Phone Number", type: "phone_number" }, { name: "Setter", type: "single_select", choices: ["Luis", "Maria"] }] }],
      mapped: [{ external_id: "c1", term_category: "closing", booking: "setter" }], users: [{ id: "U1", name: "James", email: "james@x.com" }], catalog: null, terms: [{ name: "Closing", category: "closing" }] }, "The - S calendar is for setter bookings; the Setter question says who.");
    expect(system).toMatch(/never invent calendars/);
    expect(user).toContain('"45 Min Strategy Call - S"'); expect(user).toContain('"Setter" (single_select) [Luis / Maria]'); expect(user).toContain("hosts: James <james@x.com>"); expect(user).toContain('"booking":"setter"');
    expect(user).toContain("The - S calendar is for setter bookings");
  });
  it("a proposal is only operations the engine can apply", () => {
    const p = Proposal.parse({ summary: "ok", operations: [{ op: "map_calendar", calendar_id: "c1", call_type: "closing", booking: "question", questions: { setter: "Setter", phone: "Phone Number" }, why: "the - S calendar" }], questions: ["Which calendar is the self-booking link?"] });
    expect(p.operations[0]).toMatchObject({ op: "map_calendar", active: true });
    expect(() => Proposal.parse({ summary: "x", operations: [{ op: "delete_everything" }], questions: [] })).toThrow();
  });
});
