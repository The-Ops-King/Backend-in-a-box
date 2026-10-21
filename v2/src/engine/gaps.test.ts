import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/db/client";
import { chain, flow, harness, STORES, window } from "@/test/harness";

/**
 * The format gaps Hair's translation found, closed in the engine: lists in posts, a persona from a value, a channel the
 * fact names (only one of the offer's), edit in place, a run starting its own workflow again, what we last sent, tags
 * from a list in a variable (and `keep`), a reply in a DM's thread, and steps that do without an unset setting.
 */

type N = Record<string, unknown>;
const trig = (event = "appointment.booked"): N => ({ id: "t1", type: "trigger@1", title: "Start", on: { event } });
const end = (id = "x1", reason = "done"): N => ({ id, type: "end@1", title: "End", reason });
const post = (id: string, extra: N = {}): N => ({ id, type: "message@1", title: `Post ${id}`, to: { slack: { channel: "{{setting.slack.channel.ops}}" } }, content: `c.${id}`, ...extra });
const act = (id: string, action: string, params: N, extra: N = {}): N => ({ id, type: "action@1", title: `Do ${id}`, action, params, ...extra });
const slack = (id: string, body: string, extra: N = {}) => ({ [`c.${id}`]: { channel: "slack" as const, body, ...extra } });
const SETTINGS = { "slack.channel.ops": "C-OPS", "slack.channel.alerts": "C-ALERTS", "slack.channel.test": "C-TEST" };
const slackCalls = (h: { fp: { effects: (p?: "slack") => { method: string; args: unknown }[] } }) => h.fp.effects("slack").map((c) => ({ method: c.method, ...(c.args as N) }) as N & { method: string });

afterAll(async () => { await closeDb(); });

describe.each(STORES)("the closed format gaps, on %s", (kind) => {
  it("lays a list out in a post, each item its own line, and holds the post when an item has a blank", async () => {
    const body = "Which booking?\n{{event.options | each:\"{{number}}. {{item.when}} with {{item.closer | default:no closer}} ({{item.status}})\" | join:\"\\n\" | default:None booked.}}";
    const h = await harness(kind, { settings: SETTINGS, workflows: [flow("w", [trig("call.closing"), post("p1"), end()], chain("t1", "p1", "x1"))], content: slack("p1", body) });
    await h.ingest("call.closing", { payload: { options: [{ when: "Thu", closer: "Luis", status: "booked" }, { when: "Fri", status: "booked" }] } });
    await h.ingest("call.closing", { payload: { options: [] } });
    await h.ingest("call.closing", { payload: { options: [{ when: "Sat", closer: "Ana" }] } });
    const rows = await h.outbox();
    expect(rows.map((r) => r.status)).toEqual(["sent", "sent", "held"]);
    expect(rows.map((r) => r.payload.text)).toEqual(["Which booking?\n1. Thu with Luis (booked)\n2. Fri with no closer (booked)", "Which booking?\nNone booked.", "Which booking?\n1. Sat with Ana ()"]);
    expect((rows[2]!.payload.render as { blanks: { expr: string; path: string }[] }).blanks).toEqual([{ expr: "item.status (item 1 of event.options)", path: "event.options.0.status", reason: "missing" }]);
  });

  it("renders the persona's name and icons from values, and holds a post whose persona has a blank", async () => {
    const h = await harness(kind, {
      settings: SETTINGS, workflows: [flow("w", [trig("alert.raised"), { id: "s1", type: "set@1", title: "Icon", var: "icon", value: { $pick: "{{event.level}}", cases: { error: ":rotating_light:" }, else: ":warning:" } }, post("p1"), end()], chain("t1", "s1", "p1", "x1"))],
      content: slack("p1", "{{event.text}}", { as: "{{event.as_name | default:Engine alerts}}", icons: ["{{vars.icon}}"] }),
    });
    await h.ingest("alert.raised", { payload: { level: "error", text: "Broke", as_name: "Hair alerts" } });
    await h.ingest("alert.raised", { payload: { level: "warning", text: "Slow" } });
    expect(slackCalls(h).map((c) => [c.as, c.icons])).toEqual([["Hair alerts", [":rotating_light:"]], ["Engine alerts", [":warning:"]]]);
  });

  it("posts in the channel the fact names only when it is one of the offer's channels; any other is held with an alert", async () => {
    const p = { id: "p1", type: "message@1", title: "Post where the alert says", to: { slack: { channelFromFact: "{{event.channel}}" } }, content: "c.p1" };
    const h = await harness(kind, { settings: SETTINGS, workflows: [flow("w", [trig("alert.raised"), p, end()], chain("t1", "p1", "x1"))], content: slack("p1", "Alert") });
    await h.ingest("alert.raised", { payload: { channel: "C-ALERTS" } });
    await h.ingest("alert.raised", { payload: { channel: "C-SOMEONE-ELSES" } });
    await h.ingest("alert.raised", { payload: { channel: "C-TEST" } });
    const rows = await h.outbox();
    expect(rows.map((r) => r.status)).toEqual(["sent", "held", "held"]);
    expect(rows[0]!.gates[0]).toMatchObject({ check: "channel", result: "pass", why: "C-ALERTS is the offer's slack.channel.alerts" });
    expect(rows[1]!.gates[0]).toMatchObject({ check: "channel", result: "hold" });
    expect(slackCalls(h).map((c) => c.channel)).toEqual(["C-ALERTS"]);
    expect((await h.alerts()).map((a) => a.kind)).toEqual(["unmapped_channel", "unmapped_channel"]);
  });

  it("a channel with a fallback posts to the fallback while the offer leaves the first unset", async () => {
    const p = { id: "p1", type: "message@1", title: "Ask for attention", to: { slack: { channel: "{{setting.slack.channel.attention}}", fallbackChannel: "{{setting.slack.channel.ops}}" } }, content: "c.p1" };
    const def = flow("w", [trig("call.closing"), p, end()], chain("t1", "p1", "x1"));
    const h = await harness(kind, { settings: SETTINGS, workflows: [def], content: slack("p1", "Look") });
    await h.ingest("call.closing");
    await h.store.tx((tx) => tx.setSetting(h.offerId, "slack.channel.attention", "C-ATTENTION", "test"));
    await h.ingest("call.closing");
    expect(slackCalls(h).map((c) => c.channel)).toEqual(["C-OPS", "C-ATTENTION"]);
  });

  it("says a post again by editing it in place, when the post remembered under its tag is there; else posts it", async () => {
    const p = post("p1", { remember: "review:{{event.call}}", edit: true });
    const reply = post("p2", { thread: { node: "p1" } });
    const h = await harness(kind, { settings: SETTINGS, workflows: [flow("w", [trig("call.reviewed"), p, reply, end()], chain("t1", "p1", "p2", "x1"))], content: { ...slack("p1", "Review {{event.version}}"), ...slack("p2", "Scorecard {{event.version}}") } });
    await h.ingest("call.reviewed", { payload: { call: "k1", version: 1 } });
    await h.ingest("call.reviewed", { payload: { call: "k1", version: 2 } });
    await h.ingest("call.reviewed", { payload: { call: "k2", version: 1 } });
    const calls = slackCalls(h);
    expect(calls.map((c) => `${c.method} ${c.text}`)).toEqual(["post Review 1", "post Scorecard 1", "update Review 2", "post Scorecard 2", "post Review 1", "post Scorecard 1"]);
    const posts = await h.posts();
    // the edited post is one post, now the second run's, and the second run's reply threads under it
    expect(posts.filter((x) => x.tag === "review:k1")).toHaveLength(1);
    expect(calls[3]!.threadTs).toBe(posts.find((x) => x.tag === "review:k1")!.ts);
  });

  it("a fact a run records starts its own workflow again only when the step says so, and never past the depth limit", async () => {
    const relink = (startsThisWorkflow: boolean) => flow("w", [
      trig("call.closing"),
      { id: "b1", type: "branch@1", title: "Linked yet?" },
      act("f1", "facts.record", { type: "call.closing", data: { linked: "yes" }, startsWorkflows: true, ...(startsThisWorkflow ? { startsThisWorkflow: true } : {}), appointment: "a9" }),
      end("x_linked", "linked"), end("x_handed", "handed_on"),
    ], [{ from: "t1", to: "b1" }, { from: "b1", to: "x_linked", when: { exists: "appointment.id" } }, { from: "b1", to: "f1", else: true }, { from: "f1", to: "x_handed" }]);
    const off = await harness(kind, { workflows: [relink(false)] });
    await off.ingest("call.closing");
    expect((await off.runs()).map((r) => r.endReason).sort()).toEqual(["handed_on"]);
    const on = await harness(kind, { workflows: [relink(true)] });
    await on.ingest("call.closing");
    const runs = await on.runs();
    expect(runs.map((r) => r.endReason).sort()).toEqual(["handed_on", "linked"]);
    expect(runs.find((r) => r.endReason === "linked")!.appointmentId).toBe("a9");
    const loop = flow("loop", [trig("call.closing"), act("f1", "facts.record", { type: "call.closing", data: {}, startsWorkflows: true, startsThisWorkflow: true }), end()], chain("t1", "f1", "x1"));
    const deep = await harness(kind, { workflows: [loop] });
    await deep.ingest("call.closing");
    // the first run and eight more, one per level; the deepest one's fact starts nothing (the step is skipped, as it says)
    const deepRuns = await deep.runs();
    expect(deepRuns).toHaveLength(9);
    expect((await deep.store.tx(async (tx) => (await Promise.all(deepRuns.map((r) => tx.steps(r.id)))).flat())).filter((x) => x.status === "skipped").map((x) => x.error)).toEqual(["facts recorded by runs started by facts, more than 8 deep"]);
  });

  it("knows what we last sent the contact, from the outbox: the latest text or email that went out", async () => {
    const nodes = [
      trig(),
      { id: "m1", type: "message@1", title: "Text", to: { contact: "sms" }, content: "c.m1", kind: "transactional" },
      { id: "w1", type: "wait@1", title: "Reply?", reply: { channel: "any" }, timeout: "1d" },
      post("p1"), end(), end("x2", "no_reply"),
    ];
    const edges = [...chain("t1", "m1", "w1"), { from: "w1", to: "p1", on: "arrived" }, { from: "w1", to: "x2", on: "timeout" }, { from: "p1", to: "x1" }];
    const h = await harness(kind, { settings: SETTINGS, workflows: [flow("w", nodes, edges, { sendWindow: window })], content: { "c.m1": { channel: "sms", body: "You're booked for Thursday." }, ...slack("p1", "*We sent:*\n> {{reply.last_outbound.body}}\n*They wrote:*\n> {{reply.body}}") } });
    await h.ingest("appointment.booked");
    await h.advance("5m");
    await h.engine.ingest({ offerId: h.offerId, type: "message.received", source: "test", dedupeKey: "r1", contactId: "c1", payload: { channel: "sms", body: "Can we move it?" } });
    await h.due();
    expect(slackCalls(h).map((c) => c.text)).toEqual(["*We sent:*\n> You're booked for Thursday.\n*They wrote:*\n> Can we move it?"]);
  });

  it("takes tags from a list held in a variable, and keep takes its tags out of what is removed", async () => {
    const nodes = [
      trig(),
      { id: "s1", type: "set@1", title: "Before", var: "before", value: ["stat-showed", "stat-closed"] },
      { id: "s2", type: "set@1", title: "Now", var: "now_tags", value: ["stat-closed"] },
      act("r1", "crm.remove_tag", { tags: "{{vars.before}}", keep: "{{vars.now_tags}}" }),
      act("a1", "crm.add_tag", { tags: ["vip", "{{vars.now_tags}}"] }),
      end(),
    ];
    const h = await harness(kind, { workflows: [flow("w", nodes, chain("t1", "s1", "s2", "r1", "a1", "x1"))] });
    await h.ingest("appointment.booked");
    expect(h.fp.effects("crm").map((c) => [c.method, (c.args as { tags: string[] }).tags])).toEqual([["removeTags", ["stat-showed"]], ["addTags", ["vip", "stat-closed"]]]);
    expect((await h.outbox())[0]!.payload.params).toMatchObject({ tags: ["stat-showed"], kept: ["stat-closed"] });
  });

  it("replies in the thread of a DM another run posted, in that DM, as v1 replied under a post wherever it was", async () => {
    const remind = flow("remind", [trig("eod.due"), { id: "d1", type: "message@1", title: "DM", to: { slack: { dm: "{{event.user}}" } }, content: "c.d1", remember: "eod:{{event.user}}" }, end()], chain("t1", "d1", "x1"));
    const ack = flow("ack", [trig("eod.filed"), { id: "d2", type: "message@1", title: "Got it", to: { slack: { dm: "{{event.user}}" } }, content: "c.d2", thread: { tag: "eod:{{event.user}}" } }, end()], chain("t1", "d2", "x1"));
    const h = await harness(kind, { settings: SETTINGS, workflows: [remind, ack], content: { ...slack("d1", "File your day"), ...slack("d2", "Got it") } });
    await h.ingest("eod.due", { contact: null, payload: { user: "U1" } });
    await h.ingest("eod.filed", { contact: null, payload: { user: "U1" } });
    const calls = slackCalls(h);
    expect(calls[1]).toMatchObject({ method: "post", channel: "D-U1", text: "Got it", threadTs: (await h.posts()).find((p) => p.tag === "eod:U1")!.ts });
    // a reply to a DM with nothing to reply under is a plain DM
    await h.ingest("eod.filed", { contact: null, payload: { user: "U2" } });
    expect(slackCalls(h)[2]).toMatchObject({ method: "dm", user: "U2" });
  });

  it("a step that can do without a setting skips itself while the offer leaves it unset, and the workflow enables without it", async () => {
    const nodes = [trig(), act("k1", "crm.move_deal", { pipeline: "P1", stage: "{{setting.crm.stage_dq}}", ifMissing: "skip", pick: "open" }, { skipWhenUnset: ["crm.stage_dq"] }), act("k2", "crm.set_deal_status", { pipeline: "P1", status: "lost" }, { skipWhenUnset: ["crm.stage_dq"] }), end()];
    const h = await harness(kind, { workflows: [flow("w", nodes, chain("t1", "k1", "k2", "x1"))] });
    await h.ingest("appointment.booked");
    expect(h.fp.effects("crm")).toEqual([]);
    expect((await h.steps()).filter((s) => s.node.startsWith("k")).map((s) => [s.status, s.result.skipped])).toEqual([["skipped", "not set: crm.stage_dq"], ["skipped", "not set: crm.stage_dq"]]);
    await h.store.tx((tx) => tx.setSetting(h.offerId, "crm.stage_dq", "ST-DQ", "test"));
    await h.ingest("appointment.booked");
    expect(h.fp.effects("crm").map((c) => c.method)).toEqual(["moveDeal", "setDealStatus"]);
  });
});
