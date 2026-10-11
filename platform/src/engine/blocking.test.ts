/** D77: which steps hold a run when they keep failing (blocking) and which are skipped so the rest still runs, derived from the definition. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseDefinition, type Node } from "./definition";
import { doingWords, failureRoles } from "./blocking";

const tmpl = (slug: string) => parseDefinition(JSON.parse(readFileSync(`src/templates/${slug}.json`, "utf8")).definition);
const ACTS = new Set<Node["type"]>(["pipeline_card", "crm_record", "classify", "analyze", "webhook", "report", "eod_due", "update_appointment", "slack_post", "send_sms", "send_email", "send_document", "tags", "set_tag", "remove_tag", "note", "update_contact", "create_task", "notify_owner", "health_check", "availability_check"]);
const blockingActs = (slug: string) => { const def = tmpl(slug), roles = failureRoles(def); return def.nodes.filter((n) => ACTS.has(n.type) && roles.get(n.id)!.blocking).map((n) => n.id).sort(); };

describe("blocking steps (D77)", () => {
  it("in Hair's enabled templates, only steps a later step reads from are blocking; tags, notes, sends, Slack posts, cards and records nothing reads are not", () => {
    expect({
      "new-lead": blockingActs("new-lead"), "speed-to-lead": blockingActs("speed-to-lead"), "setter-call-logged": blockingActs("setter-call-logged"), "call-booked": blockingActs("call-booked"),
      "pre-call-sequence": blockingActs("pre-call-sequence"), "call-cancelled": blockingActs("call-cancelled"), "cancellation-rebook": blockingActs("cancellation-rebook"), "call-recorded": blockingActs("call-recorded"),
      "call-outcome": blockingActs("call-outcome"), "eod-reminder": blockingActs("eod-reminder"), "eod-filed": blockingActs("eod-filed"), "deal-closed": blockingActs("deal-closed"),
      "agreement-send-manually": blockingActs("agreement-send-manually"), "agreement-signed": blockingActs("agreement-signed"), "agreement-chase": blockingActs("agreement-chase"), "payment-recorded": blockingActs("payment-recorded"),
      "calendar-availability": blockingActs("calendar-availability"), "health-check": blockingActs("health-check"), "wrap-ups": blockingActs("wrap-ups"),
    }).toEqual({
      "new-lead": [], "speed-to-lead": [], "setter-call-logged": ["a1", "a2", "a3"], "call-booked": ["b5", "s4"],   // the closer card: the Sales Call record names it; D79: setter-call-logged's result read feeds the record, the post and the actions, Jev's DQ reason does not hold the run (a plain dq tag stands in)
      "pre-call-sequence": ["c1"], "call-cancelled": [], "cancellation-rebook": [], "call-recorded": ["a1", "a2", "a3"],
      "call-outcome": [], "eod-reminder": ["v_evening", "v_morning"], "eod-filed": [], "deal-closed": [],   // deal-closed's congratulations is optional
      "agreement-send-manually": [], "agreement-signed": [], "agreement-chase": [], "payment-recorded": [], "calendar-availability": [], "health-check": [], "wrap-ups": ["n_build"],
    });
    const booked = failureRoles(tmpl("call-booked"));
    expect(booked.get("s4")).toEqual({ blocking: true, why: "step k4 reads the closer card" });
    expect(booked.get("k4")).toMatchObject({ blocking: false });   // its own `relate` reads its own record id; nothing after it does
    expect(failureRoles(tmpl("call-outcome")).get("u1")).toEqual({ blocking: true, why: "later steps read what it remembers" });
  });

  it("the rule on small definitions: a branch reading a classify, a record id read later, a post a blocking wait waits on (a listener does not count), the override both ways", () => {
    const def = parseDefinition({ schema: 1, reentry: "always", premise: { check: "none" }, edges: [
      { from: "t1", to: "c1" }, { from: "c1", to: "b1" }, { from: "b1", to: "r1", when: { eq: ["{{vars.intent}}", "yes"] } }, { from: "b1", to: "p1", else: true },
      { from: "r1", to: "n1" }, { from: "n1", to: "x1" }, { from: "p1", to: "w1" }, { from: "w1", to: "g1" }, { from: "g1", to: "p2" }, { from: "p2", to: "w2" }, { from: "w2", to: "x1" }, { from: "w2", to: "x1", label: "tap" }],
      nodes: [{ id: "t1", type: "trigger", event: "tag.added" },
        { id: "c1", type: "classify", input: "{{event.text}}", domain: "reply_intent", into: "vars.intent" },
        { id: "b1", type: "branch" },
        { id: "r1", type: "crm_record", object: "custom_objects.x", key: "k", properties: { a: "1" } },
        { id: "n1", type: "note", template: "Record {{record.id}}", blocking: false },
        { id: "p1", type: "slack_post", channel: "C1", template: "Which?" },
        { id: "w1", type: "wait_for_reaction", of: "p1", emojis: ["white_check_mark"], timeout: "1h" },
        { id: "g1", type: "set_tag", tag: "x", blocking: true },
        { id: "p2", type: "slack_post", channel: "C1", template: "Listen" },
        { id: "w2", type: "wait_for_reaction", of: "p2", emojis: ["x"], blocking: false },
        { id: "x1", type: "exit", reason: "done" }] });
    const r = failureRoles(def);
    expect(r.get("c1")).toEqual({ blocking: true, why: "step b1 reads intent" });
    expect(r.get("r1")).toEqual({ blocking: true, why: "step n1 reads the record's id" });
    expect(r.get("n1")).toEqual({ blocking: false, why: "set on the step (blocking: false)" });
    expect(r.get("p1")).toEqual({ blocking: true, why: "step w1 reads the post" });
    expect(r.get("g1")).toEqual({ blocking: true, why: "set on the step (blocking: true)" });
    expect(r.get("p2")).toMatchObject({ blocking: false });
    expect(r.get("b1")).toMatchObject({ blocking: true });
  });

  it("says what a step does in the words after \"Couldn't\"", () => {
    const n = (x: Record<string, unknown>) => parseDefinition({ schema: 1, reentry: "always", nodes: [{ id: "t1", type: "trigger", event: "x" }, { id: "n1", ...x }, { id: "x1", type: "exit", reason: "d" }], edges: [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }] }).nodes[1];
    expect(doingWords(n({ type: "set_tag", tag: ["stat-showed"] }))).toBe("add the tag “stat-showed”");
    expect(doingWords(n({ type: "tags", add: ["a"], remove: ["b"] }))).toBe("add the tag “a” and take off “b”");
    expect(doingWords(n({ type: "send_sms", template: "Hi" }))).toBe("send the text");
    expect(doingWords(n({ type: "slack_post", channel: "C", template: "x", title: "React 👻 on the booking post" }))).toBe("react 👻 on the booking post");
    expect(doingWords(n({ type: "crm_record", object: "custom_objects.sales_call", key: "k", properties: {} }))).toBe("create the Sales Call record");
  });
});
