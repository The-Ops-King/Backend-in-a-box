/** Coverage by construction: every node type declares what it needs from outside; every shipped template's needs are kinds the sweep verifies or openly calls unverifiable. */
import { describe, it, expect } from "vitest";
import { NODE_NEEDS, NODE_TYPES, VERIFIES, workflowRefs } from "./coverage";
import { parseDefinition } from "./definition";
import { templates } from "@/templates";

describe("coverage (D33)", () => {
  it("every node type in the schema says what it needs (add it to NODE_NEEDS when adding a step type)", () => {
    for (const t of NODE_TYPES) expect(NODE_NEEDS, `NODE_NEEDS is missing ${t}`).toHaveProperty(t);
    expect(Object.keys(NODE_NEEDS).sort()).toEqual([...NODE_TYPES].sort());
  });
  it("every kind of outside dependency is either verified live or declared unverifiable", () => {
    const kinds = new Set<string>();
    for (const t of templates) for (const r of workflowRefs(parseDefinition(t.definition))) kinds.add(r.kind);
    for (const k of kinds) expect(VERIFIES, `VERIFIES is missing ${k}`).toHaveProperty(k);
  });
  it("lists what a real template depends on: its bindings, its trigger events, Slack, the AI key, custom objects, links", () => {
    const refs = workflowRefs(parseDefinition(templates.find((t) => t.slug === "deal-closed")!.definition));
    const by = (k: string) => refs.filter((r) => r.kind === k).map((r) => r.value).sort();
    expect(by("event")).toEqual(["agreement.signed", "payment.received"]);
    expect(by("binding")).toEqual(expect.arrayContaining(["crm.location_id", "crm.pipeline_closer", "crm.stage_closer_closed_won", "crm.pipeline_setter", "slack.channel.deals", "prompt.close_cheer"]));
    expect(by("slack")).toEqual(["connection"]); expect(by("anthropic")).toEqual(["key"]);
    expect(by("custom_object")).toEqual(["custom_objects.sales_call"]);
    expect(by("url").every((u) => /^https:\/\//.test(u))).toBe(true);   // the welcome email's fixed links; the contact link carries {{crm.location_id}} and is not one
    expect(refs.some((r) => r.kind === "url" && /gohighlevel/.test(r.value))).toBe(false);
    const cr = workflowRefs(parseDefinition(templates.find((t) => t.slug === "call-recorded")!.definition));
    expect(cr.some((r) => r.kind === "classify_domain" || r.kind === "anthropic")).toBe(true);
  });
  it("a binding the template gives a default is optional: the step runs without it, so leaving it unbound is not a fault", () => {
    const refs = workflowRefs(parseDefinition(templates.find((t) => t.slug === "setter-call-logged")!.definition)).filter((r) => r.kind === "binding");
    const opt = (v: string) => refs.filter((r) => r.value === v).map((r) => !!r.optional);
    expect(opt("crm.stage_setter_not_interested")).toEqual([true]);
    expect(opt("crm.stage_setter_dq")).toEqual([true]);
    expect(opt("crm.pipeline_setter").every((o) => !o)).toBe(true);
  });
  it("a fixed link in copy is a url ref; a templated one is not", () => {
    const def = parseDefinition({ schema: 1, reentry: "always", premise: { check: "contact_exists" }, nodes: [{ id: "t", type: "trigger", event: "lead.created" }, { id: "s", type: "send_sms", template: "Book here: https://cal.example.com/book?x=1. Or {{calendar.booking.url}}" }, { id: "x", type: "exit", reason: "done" }], edges: [{ from: "t", to: "s" }, { from: "s", to: "x" }] });
    const refs = workflowRefs(def);
    expect(refs.filter((r) => r.kind === "url").map((r) => r.value)).toEqual(["https://cal.example.com/book?x=1"]);
    expect(refs.filter((r) => r.kind === "binding").map((r) => r.value)).toEqual(["calendar.booking"]);
  });
});
