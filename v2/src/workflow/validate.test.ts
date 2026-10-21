import { describe, expect, it } from "vitest";
import { type ProblemCode, validateWorkflow } from "./validate";

type N = Record<string, unknown>;
const trigger = (id = "t1", title = "Payment failed"): N => ({ id, type: "trigger@1", title, on: { event: "payment.failed" } });
const post = (id = "n1", extra: N = {}): N => ({ id, type: "message@1", title: "Post it", to: { slack: { channel: "{{setting.slack.channel.payments}}" } }, content: "payment_failed.slack_alert", ...extra });
const text = (id: string, extra: N = {}): N => ({ id, type: "message@1", title: "Text them", to: { contact: "sms" }, content: `texts.${id}`, ...extra });
const end = (id = "x1", reason = "done"): N => ({ id, type: "end@1", title: "Done", reason });
const branch = (id: string): N => ({ id, type: "branch@1", title: "Which way?" });
const window = { zone: "contact", opens: "08:00", closes: "20:00", outside: "earlier_same_day", transactional: "any_hour" };

const wf = (nodes: N[], edges: N[], header: N = {}) => ({ schema: 2, id: "test-flow", name: "Test flow", reentry: { policy: "always" }, ...header, nodes, edges });
const minimal = () => wf([trigger(), post(), end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]);

const codes = (raw: unknown) => validateWorkflow(raw).problems.map((p) => p.code);
const expectOnly = (raw: unknown, code: ProblemCode) => {
  const r = validateWorkflow(raw);
  expect(r.ok).toBe(false);
  expect(r.problems.map((p) => p.code), JSON.stringify(r.problems)).toEqual([code]);
  return r.problems[0]!;
};

describe("a valid workflow", () => {
  it("passes with nothing to say, its defaults written out, and what it needs listed", () => {
    const r = validateWorkflow(minimal());
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.workflow.delivery).toEqual({ kind: "human", whenStale: "skip" });
    expect(r.workflow.nodes.map((n) => n.id)).toEqual(["t1", "n1", "x1"]);
    expect(r.requires).toEqual({ settings: ["slack.channel.payments"], optionalSettings: [], content: ["payment_failed.slack_alert"], reports: [], forms: [], workflows: [], secrets: [] });
  });
});

describe("the workflow's own fields", () => {
  it("refuses something that is not a definition at all", () => {
    expectOnly("nope", "schema");
    expectOnly([], "schema");
  });
  it("needs schema 2: a v1 definition is not read as v2", () => {
    expect(expectOnly({ ...minimal(), schema: 1 }, "schema").path).toEqual(["schema"]);
  });
  it("needs a workflow id in lowercase", () => {
    expectOnly({ ...minimal(), id: "Payment Failed" }, "schema");
  });
  it("needs a re-entry policy, with a window only for the windowed one", () => {
    expectOnly({ ...minimal(), reentry: undefined }, "schema");
    expectOnly({ ...minimal(), reentry: { policy: "once_per_contact_per_window" } }, "schema");
    expectOnly({ ...minimal(), reentry: { policy: "once_per_contact", window: "90d" } }, "schema");
    expect(validateWorkflow({ ...minimal(), reentry: { policy: "once_per_contact_per_window", window: "90d" } }).ok).toBe(true);
    expectOnly({ ...minimal(), reentry: { policy: "always", key: "{{appointment.starts_at}}" } }, "schema");
  });
  it("needs a send window that opens before it closes", () => {
    expectOnly({ ...minimal(), sendWindow: { ...window, opens: "20:00", closes: "08:00" } }, "schema");
    expectOnly({ ...minimal(), sendWindow: { ...window, outside: "tomorrow" } }, "schema");
  });
  it("takes a premise with a label, a condition and the reason a run ends when it stops holding", () => {
    expect(validateWorkflow({ ...minimal(), premise: { label: "Still a contact", holds: { exists: "contact.id" }, endReason: "contact_gone" } }).ok).toBe(true);
    expect(codes({ ...minimal(), premise: { holds: { exists: "contact.id" } } })).toEqual(["schema", "schema"]);
  });
  it("refuses a field it does not know, including a delivery state: only Tyler sets that, beside the definition", () => {
    expectOnly({ ...minimal(), live: true }, "schema");
    expectOnly({ ...minimal(), delivery: { kind: "human", state: "live" } }, "schema");
  });
});

describe("nodes", () => {
  it("needs a list of nodes", () => {
    expect(codes({ ...minimal(), nodes: [] })).toContain("schema");
  });
  it("needs a string id and type on each", () => {
    expect(codes(wf([trigger(), post(), end(), { title: "?" }], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]))).toEqual(["schema"]);
  });
  it("refuses two nodes with one id", () => {
    const p = expectOnly(wf([trigger(), post(), post(), end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]), "duplicate_node_id");
    expect(p).toMatchObject({ node: "n1", path: ["nodes", 2, "id"] });
  });
  it("refuses a primitive that does not exist, or a type with no version", () => {
    expectOnly(wf([trigger(), { id: "n1", type: "loop@1", title: "Loop" }, end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]), "unknown_primitive");
    expectOnly(wf([trigger(), { ...post(), type: "message" }, end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]), "unknown_primitive");
  });
  it("refuses a version of a primitive that does not exist", () => {
    expectOnly(wf([trigger(), { ...post(), type: "message@2" }, end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]), "unknown_version");
  });
  it("refuses a node its primitive's schema refuses, at that node", () => {
    const p = expectOnly(wf([trigger(), post("n1", { content: "Inline words!" }), end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]), "schema");
    expect(p).toMatchObject({ node: "n1", path: ["nodes", 1, "content"] });
  });
  it("refuses an action verb that does not exist, and params a verb refuses", () => {
    const act = (action: string, params: N): N => ({ id: "a1", type: "action@1", title: "Act", action, params });
    const edges = [{ from: "t1", to: "a1" }, { from: "a1", to: "x1" }];
    expectOnly(wf([trigger(), act("crm.tag", { tags: ["x"] }), end()], edges), "unknown_action");
    expectOnly(wf([trigger(), act("crm.add_tag", { tags: [] }), end()], edges), "action_params");
  });
});

describe("the graph", () => {
  it("needs at least one trigger", () => {
    expectOnly(wf([post(), end()], [{ from: "n1", to: "x1" }]), "no_trigger");
  });
  it("needs at least one end", () => {
    expectOnly(wf([trigger(), post()], [{ from: "t1", to: "n1" }, { from: "n1", to: "n1" }]), "no_end");
  });
  it("needs a way on from every node but an end", () => {
    const edges = [{ from: "t1", to: "b1" }, { from: "b1", to: "n1", when: { exists: "contact.email" } }, { from: "b1", to: "x1", else: true }];
    expect(expectOnly(wf([trigger(), branch("b1"), post(), end()], edges), "no_outgoing_edge").node).toBe("n1");
  });
  it("needs an edge for each way a node can leave", () => {
    const w = { id: "w1", type: "wait@1", title: "Wait for a reply", reply: { channel: "sms" }, timeout: "4h" };
    const p = expectOnly(wf([trigger(), w, end()], [{ from: "t1", to: "w1" }, { from: "w1", to: "x1", on: "arrived" }]), "missing_outcome_edge");
    expect(p.message).toContain('"timeout"');
    expect(validateWorkflow(wf([trigger(), w, end()], [{ from: "t1", to: "w1" }, { from: "w1", to: "x1", on: "arrived" }, { from: "w1", to: "x1", on: "timeout" }])).ok).toBe(true);
  });
  it("refuses an edge for a way the node cannot leave, and any edge out of an end", () => {
    expectOnly(wf([trigger(), post(), end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }, { from: "n1", to: "x1", on: "timeout" }]), "unknown_outcome");
    expect(expectOnly(wf([trigger(), post(), end(), end("x2")], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }, { from: "x1", to: "x2" }]), "unknown_outcome").message).toContain("is an end");
  });
  it("refuses two edges for the same way out of a step that is not a branch", () => {
    expectOnly(wf([trigger(), post(), end(), end("x2")], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }, { from: "n1", to: "x2" }]), "duplicate_outcome_edge");
  });
  it("refuses an edge to or from a node that does not exist", () => {
    expect(expectOnly(wf([trigger(), post(), end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }, { from: "ghost", to: "x1" }]), "edge_unknown_node").path).toEqual(["edges", 2, "from"]);
    const r = validateWorkflow(wf([trigger(), post(), end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }, { from: "t1", to: "nowhere", on: "next" }]));
    expect(r.problems.filter((p) => p.code === "edge_unknown_node").map((p) => p.path)).toEqual([["edges", 2, "to"]]);
  });
  it("refuses an edge into a trigger", () => {
    expectOnly(wf([trigger(), branch("b1"), end()], [{ from: "t1", to: "b1" }, { from: "b1", to: "t1", when: { exists: "contact.id" } }, { from: "b1", to: "x1", else: true }]), "edge_into_trigger");
  });
  it("refuses a node no trigger leads to", () => {
    expect(expectOnly(wf([trigger(), post(), post("n2"), end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }, { from: "n2", to: "x1" }]), "unreachable_node").node).toBe("n2");
  });
  it("lets several triggers lead into the same steps", () => {
    expect(validateWorkflow(wf([trigger(), trigger("t2", "Also"), post(), end()], [{ from: "t1", to: "n1" }, { from: "t2", to: "n1" }, { from: "n1", to: "x1" }])).ok).toBe(true);
  });
});

describe("branches", () => {
  const nodes = [trigger(), branch("b1"), post("n1"), post("n2"), end()];
  const tail = [{ from: "t1", to: "b1" }, { from: "n1", to: "x1" }, { from: "n2", to: "x1" }];
  it("takes edges with when, and one else last", () => {
    expect(validateWorkflow(wf(nodes, [...tail, { from: "b1", to: "n1", when: { exists: "contact.email" } }, { from: "b1", to: "n2", else: true }])).ok).toBe(true);
  });
  it("refuses an edge with neither when nor else", () => {
    expectOnly(wf(nodes, [...tail, { from: "b1", to: "n1" }, { from: "b1", to: "n2", else: true }]), "branch_edge_needs_condition");
  });
  it("needs exactly one else: none leaves a run with nowhere to go", () => {
    expectOnly(wf(nodes, [...tail, { from: "b1", to: "n1", when: { exists: "contact.email" } }, { from: "b1", to: "n2", when: { exists: "contact.phone" } }]), "branch_needs_one_else");
    expect(codes(wf(nodes, [...tail, { from: "b1", to: "n1", else: true }, { from: "b1", to: "n2", else: true }]))).toEqual(["branch_needs_one_else"]);
  });
  it("needs the else last: edges after it are never taken", () => {
    expectOnly(wf(nodes, [...tail, { from: "b1", to: "n1", else: true }, { from: "b1", to: "n2", when: { exists: "contact.email" } }]), "else_not_last");
  });
  it("refuses when or else on an edge out of anything but a branch", () => {
    expectOnly(wf([trigger(), post(), end()], [{ from: "t1", to: "n1", when: { exists: "contact.id" } }, { from: "n1", to: "x1" }]), "condition_outside_branch");
  });
  it("refuses an edge with both when and else", () => {
    expect(codes(wf(nodes, [...tail, { from: "b1", to: "n1", when: { exists: "contact.email" }, else: true }, { from: "b1", to: "n2", else: true }]))).toContain("schema");
  });
});

describe("a listening ask and $resume", () => {
  const ask: N = { id: "q1", type: "ask@1", title: "Keep, cancel or move?", to: { channel: "{{setting.slack.channel.attention}}" }, content: "pre_call.decide", answers: { buttons: [{ value: "keep" }, { value: "cancel" }] }, into: "decision", then: "listen", until: { anchor: "appointment.starts_at", zone: "contact" } };
  const wait: N = { id: "w1", type: "wait@1", title: "Until an hour before", until: { anchor: "appointment.starts_at", offset: "-1h", zone: "contact" } };
  const nodes = [trigger(), ask, wait, text("m1"), branch("b1"), { id: "c1", type: "action@1", title: "Cancel it", action: "scheduling.cancel", params: { appointment: "{{appointment.id}}" } }, { id: "g1", type: "action@1", title: "Tag confirmed", action: "crm.add_tag", params: { tags: ["stat-confirmed"] } }, end(), end("x_cancelled", "cancelled")];
  const edges = [
    { from: "t1", to: "q1" }, { from: "q1", to: "w1" }, { from: "w1", to: "m1" }, { from: "m1", to: "x1" },
    { from: "q1", to: "b1", on: "answered" }, { from: "q1", to: "$resume", on: "expired" },
    { from: "b1", to: "c1", when: { eq: ["{{vars.decision.value}}", "cancel"] } }, { from: "b1", to: "g1", else: true },
    { from: "c1", to: "x_cancelled" }, { from: "g1", to: "$resume" },
  ];
  it("lets the paths a listening ask takes the run along return it with $resume", () => {
    const r = validateWorkflow(wf(nodes, edges, { sendWindow: window }));
    expect(r.problems).toEqual([]);
  });
  it("refuses $resume anywhere a listening ask did not lead", () => {
    const bad = edges.map((e) => (e.from === "m1" ? { from: "m1", to: "$resume" } : e));
    const r = validateWorkflow(wf(nodes, bad, { sendWindow: window }));
    expect(r.problems.filter((p) => p.code === "resume_outside_listener").map((p) => p.path)).toEqual([["edges", 3, "to"]]);
  });
  it("needs the listening ask's answered and expired edges", () => {
    expect(codes(wf(nodes, edges.filter((e) => e.on !== "expired"), { sendWindow: window }))).toEqual(["missing_outcome_edge"]);
  });
});

describe("the format gaps closed in piece 2", () => {
  it("waits for an answer by tag, which names no node of this workflow", () => {
    const w = { id: "w1", type: "wait@1", title: "Wait for the decision", answer: { tag: "decision:{{appointment.id}}" }, timeout: "2h", into: "decision" };
    const r = validateWorkflow(wf([trigger(), w, post(), end()], [{ from: "t1", to: "w1" }, { from: "w1", to: "n1", on: "arrived" }, { from: "w1", to: "x1", on: "timeout" }, { from: "n1", to: "x1" }]));
    expect(r.problems).toEqual([]);
  });
  it("checks the condition a recheck loop looks at", () => {
    const w = (holds: N) => ({ id: "w1", type: "wait@1", title: "Look again for a phone", check: { holds, every: "1h" }, timeout: "24h" });
    const edges = [{ from: "t1", to: "w1" }, { from: "w1", to: "n1", on: "arrived" }, { from: "w1", to: "x1", on: "timeout" }, { from: "n1", to: "x1" }];
    expect(validateWorkflow(wf([trigger(), w({ exists: "contact.phone" }), post(), end()], edges)).problems).toEqual([]);
    expectOnly(wf([trigger(), w({ exists: "company.phone" }), post(), end()], edges), "bad_template");
    expectOnly(wf([trigger(), w({ eq: ["{{vars.nope}}", 1] }), post(), end()], edges), "unknown_var");
  });
  it("needs the resumed edge of a wait for a person", () => {
    const w = { id: "w1", type: "wait@1", title: "A person looks at it", person: { reason: "no_phone" } };
    expect(validateWorkflow(wf([trigger(), w, post(), end()], [{ from: "t1", to: "w1" }, { from: "w1", to: "n1", on: "resumed" }, { from: "n1", to: "x1" }])).problems).toEqual([]);
    expect(codes(wf([trigger(), w, post(), end()], [{ from: "t1", to: "w1" }, { from: "w1", to: "n1" }, { from: "n1", to: "x1" }]))).toEqual(["unknown_outcome", "missing_outcome_edge"]);
  });
  it("checks a button's condition", () => {
    const flow = (when: N) => wf([trigger(), post("n1", { buttons: [{ action: "link_payment", value: "{{payment.id}}", when }] }), end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]);
    expect(validateWorkflow(flow({ not: { exists: "payment.contact_id" } })).problems).toEqual([]);
    expectOnly(flow({ not: { exists: "pay.contact_id" } }), "bad_template");
  });
  it("checks a templated anchor and a within", () => {
    const w = (anchor: string) => ({ id: "w1", type: "wait@1", title: "Until then", until: { anchor, zone: "contact" } });
    expect(validateWorkflow(wf([trigger(), w("{{appointment.starts_at | minus:30m}}"), end()], [{ from: "t1", to: "w1" }, { from: "w1", to: "x1" }])).problems).toEqual([]);
    expectOnly(wf([trigger(), w("{{appointment.starts_at | minus:soon}}"), end()], [{ from: "t1", to: "w1" }, { from: "w1", to: "x1" }]), "bad_template");
    const nodes = [trigger(), branch("b1"), post(), end()];
    const edges = (when: N) => [{ from: "t1", to: "b1" }, { from: "b1", to: "n1", when }, { from: "b1", to: "x1", else: true }, { from: "n1", to: "x1" }];
    expect(validateWorkflow(wf(nodes, edges({ within: ["{{payment.total}}", "{{deal.contract_value}}", 0.01] }))).problems).toEqual([]);
    expectOnly(wf(nodes, edges({ within: ["{{payment.total}}", "{{dealz.contract_value}}", 0.01] })), "bad_template");
  });
});

describe("the format gaps Hair found, closed in piece 4", () => {
  const one = (node: N) => wf([trigger(), node, end()], [{ from: "t1", to: node.id as string }, { from: node.id as string, to: "x1" }]);
  const requires = (raw: unknown) => { const r = validateWorkflow(raw); expect(r.problems).toEqual([]); return r.requires; };
  it("reads the variables, settings and filters inside an each, and refuses an unknown variable there", () => {
    const n = post("n1", { remember: '{{vars.x | each:"{{item.id}}:{{setting.scope.tag}}" | join}}' });
    expectOnly(one(n), "unknown_var");
    const ok = wf([trigger(), { id: "s1", type: "set@1", title: "List", var: "x", value: [] }, n, end()], [{ from: "t1", to: "s1" }, { from: "s1", to: "n1" }, { from: "n1", to: "x1" }]);
    expect(requires(ok).settings).toEqual(["scope.tag", "slack.channel.payments"]);
  });
  it("lists the settings a workflow can do without as optional: a step that skips itself, a channel with a fallback, a picklist option", () => {
    const skip = { id: "k1", type: "action@1", title: "Card lost", action: "crm.move_deal", params: { pipeline: "{{setting.crm.pipeline_setter}}", stage: "{{setting.crm.stage_setter_dq}}", ifMissing: "skip", pick: "open" }, skipWhenUnset: ["crm.stage_setter_dq"] };
    expect(requires(one(skip))).toMatchObject({ settings: ["crm.pipeline_setter"], optionalSettings: ["crm.stage_setter_dq"] });
    const fallback = post("n1", { to: { slack: { channel: "{{setting.slack.channel.attention}}", fallbackChannel: "{{setting.slack.channel.ops}}" } } });
    expect(requires(one(fallback))).toMatchObject({ settings: ["slack.channel.ops"], optionalSettings: ["slack.channel.attention"] });
    const option = { id: "s1", type: "set@1", title: "Disposition", var: "d", value: "{{appointment.call_outcome | option:sales_call_disposition | optional}}" };
    expect(requires(one(option))).toMatchObject({ settings: [], optionalSettings: ["picklist.sales_call_disposition"] });
    // read without the skip elsewhere, it is required
    const both = wf([trigger(), skip, post("n1", { remember: "{{setting.crm.stage_setter_dq}}" }), end()], [{ from: "t1", to: "k1" }, { from: "k1", to: "n1" }, { from: "n1", to: "x1" }]);
    expect(requires(both)).toMatchObject({ optionalSettings: [] });
    expect(requires(both).settings).toContain("crm.stage_setter_dq");
  });
  it("refuses a skip on a step with no plain way on", () => {
    const ask = { id: "q1", type: "ask@1", title: "Ask", to: { channel: "{{setting.slack.channel.payments}}" }, content: "c.q", answers: { reactions: ["x"] }, into: "r", then: "wait", timeout: "1d", skipWhenUnset: ["a.b"] };
    expectOnly(wf([trigger(), ask, end()], [{ from: "t1", to: "q1" }, { from: "q1", to: "x1", on: "answered" }, { from: "q1", to: "x1", on: "timeout" }]), "skip_needs_next");
  });
  it("takes a channel from the triggering fact only as one {{event.<field>}}", () => {
    expect(validateWorkflow(one(post("n1", { to: { slack: { channelFromFact: "{{event.channel}}" } } }))).problems).toEqual([]);
    for (const bad of ["{{contact.channel}}", "C0BT26R4695", "{{event.channel | default:C1}}", "#{{event.channel}}"]) expect(codes(one(post("n1", { to: { slack: { channelFromFact: bad } } })))).toContain("schema");
  });
  it("edits in place only a post it remembers, and only in Slack", () => {
    expect(validateWorkflow(one(post("n1", { remember: "review:{{event.id}}", edit: true }))).problems).toEqual([]);
    expect(codes(one(post("n1", { edit: true })))).toEqual(["schema"]);
    expect(codes(wf([trigger(), text("m1", { edit: true }), end()], [{ from: "t1", to: "m1" }, { from: "m1", to: "x1" }], { sendWindow: window }))).toEqual(["schema"]);
  });
  it("starts its own workflow again only with startsWorkflows on as well", () => {
    const rec = (p: N) => ({ id: "f1", type: "action@1", title: "Link it", action: "facts.record", params: { type: "call.closing", data: {}, ...p } });
    expect(validateWorkflow(one(rec({ startsWorkflows: true, startsThisWorkflow: true }))).problems).toEqual([]);
    expect(codes(one(rec({ startsWorkflows: false, startsThisWorkflow: true })))).toEqual(["action_params"]);
  });
  it("takes tags as a list, or as one {{…}} that holds a list, with keep", () => {
    const tags = (p: N) => ({ id: "r1", type: "action@1", title: "Tags off", action: "crm.remove_tag", params: p });
    const withVars = (node: N) => wf([trigger(), { id: "s1", type: "set@1", title: "Tags", var: "tags", value: ["a"] }, node, end()], [{ from: "t1", to: "s1" }, { from: "s1", to: "r1" }, { from: "r1", to: "x1" }]);
    expect(validateWorkflow(withVars(tags({ tags: "{{vars.tags}}", keep: ["{{vars.tags}}"] }))).problems).toEqual([]);
    expect(codes(withVars(tags({ tags: "stat-showed" })))).toEqual(["action_params"]);
  });
});

describe("references", () => {
  it("refuses a Slack thread under a node that is not a Slack post in this workflow", () => {
    expect(expectOnly(wf([trigger(), post("n1", { thread: { node: "nope" } }), end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]), "unknown_node_ref").message).toContain('"nope"');
  });
  it("refuses waiting for the answer to something that is not an ask that went on", () => {
    const w = { id: "w1", type: "wait@1", title: "Wait for the answer", answer: { ask: "n1" }, timeout: "1h" };
    expectOnly(wf([trigger(), post(), w, end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "w1" }, { from: "w1", to: "x1", on: "arrived" }, { from: "w1", to: "x1", on: "timeout" }]), "unknown_node_ref");
  });
  it("refuses a template mistake wherever it is", () => {
    expectOnly(wf([trigger(), post("n1", { to: { slack: { dm: "{{contact.owner.slack | shout}}" } } }), end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]), "bad_template");
    expectOnly({ ...minimal(), premise: { label: "x", holds: { exists: "company.id" }, endReason: "gone" } }, "bad_template");
    expectOnly({ ...minimal(), reentry: { policy: "once_per_contact", key: "{{appointment.starts_at | date:yyyy}}" } }, "bad_template");
    const nodes = [trigger(), branch("b1"), post(), end()];
    expectOnly(wf(nodes, [{ from: "t1", to: "b1" }, { from: "b1", to: "n1", when: { exists: "nope.x" } }, { from: "b1", to: "x1", else: true }, { from: "n1", to: "x1" }]), "bad_template");
    expectOnly(wf([{ ...trigger(), on: { event: "payment.failed", match: { eq: ["{{event.amount | money:x}}", "1"] } } }, post(), end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]), "bad_template");
  });
  it("checks the paths a time rule and a validity name, too", () => {
    const w = { id: "w1", type: "wait@1", title: "Until the call", until: { anchor: "meeting.starts_at", zone: "contact" } };
    expectOnly(wf([trigger(), w, end()], [{ from: "t1", to: "w1" }, { from: "w1", to: "x1" }]), "bad_template");
    const flow = wf([trigger(), text("m1", { validity: { before: "vars.when", minLead: "1h" } }), end()], [{ from: "t1", to: "m1" }, { from: "m1", to: "x1" }], { sendWindow: window });
    expectOnly(flow, "unknown_var");
  });
  it("refuses a variable no step sets", () => {
    const nodes = [trigger(), branch("b1"), post(), end(), { id: "s1", type: "set@1", title: "Remember", var: "kind", value: "{{event.kind}}" }];
    const edges = [{ from: "t1", to: "s1" }, { from: "s1", to: "b1" }, { from: "b1", to: "n1", when: { eq: ["{{vars.knd}}", "x"] } }, { from: "b1", to: "x1", else: true }, { from: "n1", to: "x1" }];
    expect(expectOnly(wf(nodes, edges), "unknown_var").message).toContain("vars.knd");
    expect(validateWorkflow(wf(nodes, edges.map((e) => (e.when ? { ...e, when: { eq: ["{{vars.kind}}", "x"] } } : e)))).ok).toBe(true);
  });
  it("allows a secret only in an http.request, and lists it", () => {
    const http = (params: N): N => ({ id: "h1", type: "action@1", title: "Call the Zap", action: "http.request", params: { url: "https://hooks.zapier.com/x", method: "POST", onError: "skip", ...params } });
    const edges = [{ from: "t1", to: "h1" }, { from: "h1", to: "x1" }];
    const r = validateWorkflow(wf([trigger(), http({ headers: { authorization: "Bearer {{secret.zap_key}}" } }), end()], edges));
    expect(r.ok).toBe(true);
    expect(r.requires.secrets).toEqual(["zap_key"]);
    expectOnly(wf([trigger(), post("n1", { to: { slack: { dm: "{{secret.zap_key}}" } } }), end()], [{ from: "t1", to: "n1" }, { from: "n1", to: "x1" }]), "secret_outside_http");
  });
  it("needs a send window once anything messages the contact", () => {
    const flow = wf([trigger(), text("m1"), end()], [{ from: "t1", to: "m1" }, { from: "m1", to: "x1" }]);
    expect(expectOnly(flow, "no_send_window").node).toBe("m1");
    expect(validateWorkflow({ ...flow, sendWindow: window }).ok).toBe(true);
  });
});

describe("what a workflow needs before it can be enabled", () => {
  it("lists every setting, content key, report, form and workflow it names, once each, sorted", () => {
    const nodes = [
      trigger(),
      post("n1", { content: { pick: "{{event.level}}", cases: { error: "alerts.error", warning: "alerts.warning" }, else: "alerts.warning" } }),
      text("m1", { to: { contact: "email" }, validity: { before: "appointment.starts_at", minLead: "1h" }, whenStale: { send: "texts.late" } }),
      { id: "a1", type: "action@1", title: "Note", action: "crm.add_note", params: { content: "notes.payment" } },
      { id: "g1", type: "action@1", title: "Scope tag", action: "crm.add_tag", params: { tags: ["{{setting.scope.tag}}"] } },
      { id: "r1", type: "report@1", title: "Wrap-up", report: "wrap_up.daily", period: "just_ended", into: "report" },
      { id: "q1", type: "ask@1", title: "File your day", to: { channel: "{{setting.slack.channel.closers}}" }, content: "eod.ask", answers: { form: "eod.closer" }, into: "eod", then: "go_on" },
      { id: "c1", type: "call@1", title: "Hand off", workflow: "no-show-recovery" },
      branch("b1"),
      end(),
    ];
    const edges = [
      { from: "t1", to: "n1" }, { from: "n1", to: "m1" }, { from: "m1", to: "a1" }, { from: "a1", to: "g1" }, { from: "g1", to: "r1" },
      { from: "r1", to: "q1" }, { from: "q1", to: "c1" }, { from: "c1", to: "b1" },
      { from: "b1", to: "x1", when: { exists: "setting.feature.on" } }, { from: "b1", to: "x1", else: true },
    ];
    const r = validateWorkflow(wf(nodes, edges, { sendWindow: window }));
    expect(r.problems).toEqual([]);
    expect(r.requires).toEqual({
      settings: ["feature.on", "scope.tag", "slack.channel.closers", "slack.channel.payments"],
      optionalSettings: [],
      content: ["alerts.error", "alerts.warning", "eod.ask", "notes.payment", "texts.late", "texts.m1"],
      reports: ["wrap_up.daily"],
      forms: ["eod.closer"],
      workflows: ["no-show-recovery"],
      secrets: [],
    });
  });

  it("still lists what it needs when the workflow has problems", () => {
    const r = validateWorkflow(wf([trigger(), post()], [{ from: "t1", to: "n1" }]));
    expect(r.ok).toBe(false);
    expect(r.requires.settings).toEqual(["slack.channel.payments"]);
  });
});

describe("every problem at once", () => {
  it("returns all of them, not just the first", () => {
    const raw = {
      schema: 1,
      id: "Bad Flow",
      name: "Bad",
      reentry: { policy: "sometimes" },
      nodes: [
        { id: "n1", type: "message@1", title: "Words inline", to: { contact: "sms" }, content: "Hi there" },
        { id: "n1", type: "end@1", title: "Dup", reason: "done" },
        { id: "w1", type: "wait@7", title: "Future wait", for: "1h" },
        { id: "l1", type: "loop@1", title: "Loop" },
        { id: "a1", type: "action@1", title: "Act", action: "crm.explode", params: {} },
        branch("b1"),
        text("m2", { content: "texts.{{contact.name}}" }),
        text("m3"),
        post("p1", { thread: { node: "zzz" }, to: { slack: { dm: "{{vars.nobody}}" } } }),
      ],
      edges: [
        { from: "b1", to: "ghost" },
        { from: "b1", to: "m3" },
        { from: "m3", to: "p1", when: { exists: "contact.id" } },
      ],
    };
    const r = validateWorkflow(raw);
    expect(r.ok).toBe(false);
    const found = new Set(r.problems.map((p) => p.code));
    for (const code of [
      "schema", "duplicate_node_id", "unknown_version", "unknown_primitive", "unknown_action", "no_trigger",
      "edge_unknown_node", "branch_edge_needs_condition", "branch_needs_one_else", "condition_outside_branch",
      "no_outgoing_edge", "unknown_node_ref", "unknown_var",
    ] as ProblemCode[]) expect(found, code).toContain(code);
    expect(r.problems.filter((p) => p.code === "schema").map((p) => p.path[0])).toEqual(expect.arrayContaining(["schema", "id", "reentry", "nodes"]));
  });
});
