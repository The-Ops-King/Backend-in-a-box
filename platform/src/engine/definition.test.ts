import { describe, it, expect } from "vitest";
import { parseDefinition, extractManifest } from "./definition";
import { reentryKey } from "./reentry";
import { evaluate } from "./predicate";
import { templates } from "@/templates";

describe("definitions", () => {
  it("every shipped template parses and extracts a manifest", () => {
    for (const t of templates) {
      const def = parseDefinition(t.definition);
      const m = extractManifest(def);
      expect(m.bindings.find((b) => b.key === "crm.location_id")?.required).toBe(true);
      if (t.slug === "pre-call-sequence") {
        expect(m.bindings.map((b) => b.key)).toEqual(["calendar.closer_call", "crm.location_id", "slack.channel.bookings"]);   // D44: replies land in the booking post's thread
        expect(m.bindings.find((b) => b.key === "slack.channel.bookings")?.required).toBe(false);
        expect(m.bindings.find((b) => b.key === "calendar.closer_call")?.resolves).toBe("calendars");
      }
    }
  });
  it("rejects an edge to a missing node, a workflow with no trigger, duplicate ids", () => {
    const base = { schema: 1, reentry: "always", nodes: [{ id: "t", type: "trigger", event: "x" }, { id: "e", type: "exit", reason: "r" }], edges: [{ from: "t", to: "e" }] };
    expect(() => parseDefinition(base)).not.toThrow();
    expect(() => parseDefinition({ ...base, edges: [{ from: "t", to: "nope" }] })).toThrow(/not a node/);
    expect(() => parseDefinition({ ...base, nodes: base.nodes.slice(1) })).toThrow(/trigger/);
    expect(() => parseDefinition({ ...base, nodes: [...base.nodes, { id: "t", type: "exit", reason: "dup" }] })).toThrow(/duplicate/);
    expect(() => parseDefinition({ ...base, nodes: [...base.nodes, { id: "lonely", type: "set_tag", tag: "x" }] })).toThrow(/no outgoing edge/);
  });
  it("tags: one step adds and removes; a tag or a list on either side; neither side is refused; set_tag / remove_tag still parse for installed copies", () => {
    const with_ = (node: Record<string, unknown>) => ({ schema: 1, reentry: "always", nodes: [{ id: "t", type: "trigger", event: "x" }, { id: "g", ...node }, { id: "e", type: "exit", reason: "r" }], edges: [{ from: "t", to: "g" }, { from: "g", to: "e" }] });
    expect(parseDefinition(with_({ type: "tags", add: ["stat-booked", "stat-set"], remove: "seq-nurture" })).nodes[1]).toMatchObject({ type: "tags", add: ["stat-booked", "stat-set"], remove: "seq-nurture" });
    expect(() => parseDefinition(with_({ type: "tags", add: "stat-new" }))).not.toThrow();
    expect(() => parseDefinition(with_({ type: "tags", remove: ["opt-in lead"] }))).not.toThrow();
    expect(() => parseDefinition(with_({ type: "tags" }))).toThrow(/adds nothing and removes nothing/);
    expect(() => parseDefinition(with_({ type: "tags", add: [] }))).toThrow();
    expect(() => parseDefinition(with_({ type: "set_tag", tag: ["a", "b"] }))).not.toThrow();
    expect(() => parseDefinition(with_({ type: "remove_tag", tag: "a" }))).not.toThrow();
  });
});

describe("predicates", () => {
  const ctx = { reply: { intent: "confirmed" }, appointment: { term: { category: "closing" } }, n: 5 };
  it("eq/in/and/or/not/exists with {{refs}}", () => {
    expect(evaluate({ eq: ["{{reply.intent}}", "confirmed"] }, ctx)).toBe(true);
    expect(evaluate({ in: ["{{appointment.term.category}}", ["closing", "follow_up"]] }, ctx)).toBe(true);
    expect(evaluate({ and: [{ gt: ["{{n}}", 3] }, { not: { exists: "reply.nope" } }] }, ctx)).toBe(true);
    expect(evaluate({ or: [{ eq: ["{{reply.intent}}", "cancelled"] }, { lt: ["{{n}}", 1] }] }, ctx)).toBe(false);
  });
});

describe("reentry keys (D4)", () => {
  const i = { contactId: "c1", appointmentId: "a1", opportunityId: "o1", eventId: 9, now: new Date("2026-10-06T00:00:00Z") };
  it("per policy", () => {
    expect(reentryKey({ reentry: "once_per_contact" }, i)).toBe("contact:c1");
    expect(reentryKey({ reentry: "once_per_appointment" }, i)).toBe("appointment:a1");
    expect(reentryKey({ reentry: "once_per_appointment" }, { ...i, appointmentId: null })).toBe("contact:c1");
    expect(reentryKey({ reentry: "always" }, i)).toBe("event:9");
    expect(reentryKey({ reentry: "once_per_contact_per_window", reentry_window: "90d" }, i)).toMatch(/^contact:c1:\d+$/);   // sliding window is enforced in startRun
  });
});
