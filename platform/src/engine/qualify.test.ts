/** D200: what MQL means is the offer's own (its qualifying question and answer lists), told to the bot per offer; an offer with none is told so. */
import { describe, it, expect } from "vitest";
import { qualifyWords } from "./bot";
import { qualifyConfig } from "./ghl-metrics";

describe("the offer's qualifying question", () => {
  it("is read from qualify.field, never from a field named for one offer", () => {
    expect(qualifyConfig({ "crm.field_contact_work_situation": "WS" })).toBeNull();
    expect(qualifyConfig({ "qualify.field": "Q", "qualify.question": "Budget?", "qualify.mql_answers": '["Yes"]', "qualify.dq_answers": "No" })).toEqual({ field: "Q", question: "Budget?", mql: ["Yes"], dq: ["No"], unansweredIsMql: false });
  });
  it("is told to the bot in the offer's own words, or that there is none", () => {
    expect(qualifyWords(null)).toMatch(/not defined for this offer/);
    expect(qualifyWords({ field: "Q", question: "Budget?", mql: ["Yes"], dq: ["No"], unansweredIsMql: true })).toBe('This offer\'s qualifying question is "Budget?". MQL answers: "Yes". Marketing DQ answers: "No". A blank answer counts as an MQL.');
  });
});
