import { describe, expect, it } from "vitest";
import type { RenderEnv } from "./filters";
import { Predicate, holds, predicateErrors, predicateParts } from "./predicate";

const now = new Date("2026-10-21T15:00:00Z");
const env: RenderEnv = { now, contactZone: "America/Phoenix", offerZone: "America/New_York" };
const ctx = {
  contact: { tags: ["vip", "stat-confirmed"], first_name: "Ana", email: "", phone: null, score: 7 },
  appointment: { status: "booked", starts_at: "2026-10-22T16:00:00Z", self_booked: true, call_type: "closing" },
  event: { amount: "1500", kind: "deposit" },
};
const yes = (p: Predicate) => expect(holds(Predicate.parse(p), ctx, env)).toBe(true);
const no = (p: Predicate) => expect(holds(Predicate.parse(p), ctx, env)).toBe(false);

describe("conditions", () => {
  it("eq and ne compare a path's value with a literal", () => {
    yes({ eq: ["{{appointment.call_type}}", "closing"] });
    no({ eq: ["{{appointment.call_type}}", "follow_up"] });
    yes({ ne: ["{{appointment.status}}", "cancelled"] });
    no({ ne: ["{{appointment.status}}", "booked"] });
  });

  it("a whole {{path}} keeps its type: a boolean is not the word true", () => {
    yes({ eq: ["{{appointment.self_booked}}", true] });
    no({ eq: ["{{appointment.self_booked}}", "true"] });
  });

  it("numbers and numeric text compare as numbers", () => {
    yes({ eq: ["{{event.amount}}", 1500] });
    yes({ gt: ["{{event.amount}}", 999.99] });
    yes({ gte: ["{{contact.score}}", 7] });
    no({ lt: ["{{contact.score}}", 7] });
    yes({ lte: ["{{contact.score}}", "7"] });
  });

  it("two date-times compare as instants, so a condition can ask whether a time is still ahead", () => {
    yes({ gt: ["{{appointment.starts_at}}", "{{now}}"] });
    no({ lt: ["{{appointment.starts_at}}", "{{now}}"] });
  });

  it("a filtered side is evaluated first: hours until the call", () => {
    yes({ gte: ["{{appointment.starts_at | hours_until}}", 24] });
    no({ gte: ["{{appointment.starts_at | hours_until}}", 26] });
    yes({ gte: ["{{appointment.starts_at | hour}}", 9] });
  });

  it("text around an expression is rendered and compares as text", () => {
    yes({ eq: ["{{contact.first_name}} booked", "Ana booked"] });
  });

  it("an absent value is never greater or less than anything, and equals only another absent value", () => {
    no({ gt: ["{{contact.missing}}", 0] });
    no({ lt: ["{{contact.missing}}", 0] });
    yes({ eq: ["{{contact.missing}}", null] });
    yes({ eq: ["{{contact.email}}", ""] });
    no({ eq: ["{{contact.missing}}", 0] });
  });

  it("in tests a value against a list; has tests a list for a value", () => {
    yes({ in: ["{{event.kind}}", ["deposit", "balance"]] });
    no({ in: ["{{event.kind}}", ["refund"]] });
    yes({ has: ["{{contact.tags}}", "vip"] });
    no({ has: ["{{contact.tags}}", "dnd"] });
    no({ has: ["{{contact.first_name}}", "A"] });
  });

  it("exists holds for a value that is there and not empty", () => {
    yes({ exists: "contact.first_name" });
    no({ exists: "contact.email" });
    no({ exists: "contact.phone" });
    no({ exists: "appointment.meeting_url" });
  });

  it("and, or, not combine", () => {
    yes({ and: [{ exists: "contact.first_name" }, { eq: ["{{appointment.status}}", "booked"] }] });
    no({ and: [{ exists: "contact.first_name" }, { exists: "contact.email" }] });
    yes({ or: [{ exists: "contact.email" }, { exists: "contact.first_name" }] });
    yes({ not: { exists: "appointment.meeting_url" } });
  });
});

describe("the condition schema", () => {
  it.each([
    ["an unknown operator", { equals: ["a", "b"] }],
    ["a comparison with one side", { eq: ["a"] }],
    ["exists written as a template", { exists: "{{contact.email}}" }],
    ["an empty and", { and: [] }],
    ["an extra key", { eq: ["a", "b"], ne: ["a", "b"] }],
    ["an object as an operand", { eq: [{ path: "a" }, "b"] }],
  ])("refuses %s", (_what, p) => {
    expect(Predicate.safeParse(p).success).toBe(false);
  });

  it("gives back every template and bare path inside, for checking at save time", () => {
    const p = Predicate.parse({ and: [{ eq: ["{{a.b}}", "x"] }, { not: { exists: "vars.c" } }, { in: ["{{d.e}}", ["{{f.g}}", "h"]] }] });
    expect(predicateParts(p)).toEqual({ templates: ["{{a.b}}", "{{d.e}}", "{{f.g}}"], paths: ["vars.c"] });
  });

  it("reports template mistakes inside", () => {
    expect(predicateErrors(Predicate.parse({ or: [{ eq: ["{{company.x}}", 1] }, { exists: "nope.y" }] }))).toHaveLength(2);
  });
});
