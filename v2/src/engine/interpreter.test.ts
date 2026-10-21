import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/db/client";
import { chain, flow, harness, STORES, window } from "@/test/harness";
import { saveVersion } from "./config";

type N = Record<string, unknown>;
const trig = (event = "appointment.booked", extra: N = {}): N => ({ id: "t1", type: "trigger@1", title: "Start", on: { event, ...extra } });
const text = (id: string, content = `c.${id}`, extra: N = {}): N => ({ id, type: "message@1", title: `Text ${id}`, to: { contact: "sms" }, content, kind: "transactional", ...extra });
const post = (id: string, extra: N = {}): N => ({ id, type: "message@1", title: `Post ${id}`, to: { slack: { channel: "{{setting.slack.channel.ops}}" } }, content: `c.${id}`, ...extra });
const end = (id = "x1", reason = "done"): N => ({ id, type: "end@1", title: "End", reason });
const branch = (id: string): N => ({ id, type: "branch@1", title: `Branch ${id}` });
const set = (id: string, v: string, value: unknown): N => ({ id, type: "set@1", title: `Set ${v}`, var: v, value });
const wait = (id: string, extra: N): N => ({ id, type: "wait@1", title: `Wait ${id}`, ...extra });
const act = (id: string, action: string, params: N, extra: N = {}): N => ({ id, type: "action@1", title: `Do ${id}`, action, params, ...extra });
const sms = (id: string, body: string) => ({ [`c.${id}`]: { channel: "sms" as const, body } });
const slack = (id: string, body: string, labels?: Record<string, string>) => ({ [`c.${id}`]: { channel: "slack" as const, body, ...(labels ? { labels } : {}) } });
const booked = (starts = "2026-10-29T18:00:00Z", extra: N = {}) => ({ appointment: "a1", payload: { contact: { first_name: "Ana", timezone: "America/New_York" }, appointment: { starts_at: starts, status: "booked", call_type: "closing", ...extra } } });
const SETTINGS = { "slack.channel.ops": "C-OPS", "slack.channel.test": "C-TEST" };

afterAll(async () => { await closeDb(); });

describe.each(STORES)("the interpreter, on %s", (kind) => {
  describe("trigger@1", () => {
    it("starts a run on an event its match holds for, and not on one it refuses", async () => {
      const h = await harness(kind, { workflows: [flow("w", [trig("appointment.booked", { match: { eq: ["{{appointment.call_type}}", "closing"] } }), end()], chain("t1", "x1"))] });
      expect((await h.ingest("appointment.booked", booked())).started).toHaveLength(1);
      expect((await h.ingest("appointment.booked", { appointment: "a2", payload: { appointment: { call_type: "triage" } } })).started).toHaveLength(0);
      expect((await h.ingest("appointment.cancelled", booked())).started).toHaveLength(0);
      expect((await h.run()).status).toBe("completed");
    });
    it("starts nothing for a workflow that is not enabled, and nothing twice for the same fact", async () => {
      const h = await harness(kind, { workflows: [flow("w", [trig(), end()], chain("t1", "x1"))] });
      expect((await h.ingest("appointment.booked", { ...booked(), key: "same" })).started).toHaveLength(1);
      expect(await h.ingest("appointment.booked", { ...booked(), key: "same" })).toMatchObject({ duplicate: true, started: [] });
      await h.store.tx((tx) => tx.updateWorkflow(h.wfs.w!.id, { enabled: false }));
      expect((await h.ingest("appointment.booked", booked())).started).toHaveLength(0);
    });
    it("the echo of the platform's own write (by: platform) is recorded but starts nothing, unless the trigger has includeOwnWrites", async () => {
      const h = await harness(kind, { workflows: [
        flow("plain", [trig("tag.added"), end()], chain("t1", "x1")),
        flow("matched", [trig("tag.added", { match: { eq: ["{{event.tag}}", "vip"] } }), end()], chain("t1", "x1")),
        flow("own", [trig("tag.added", { includeOwnWrites: true }), end()], chain("t1", "x1")),
        flow("refused", [trig("tag.added", { includeOwnWrites: false }), end()], chain("t1", "x1")),
      ] });
      const echo = await h.ingest("tag.added", { contact: "c1", key: "echo", payload: { tag: "vip", by: "platform" } });
      expect(echo.duplicate).toBe(false);
      expect(echo.event.payload).toMatchObject({ by: "platform" });
      expect((await h.runs()).map((r) => r.workflowId)).toEqual([h.wfs.own!.id]);
      // a person's (or the vendor's) change starts every one of them, as before
      const human = await h.ingest("tag.added", { contact: "c1", key: "human", payload: { tag: "vip", by: "crm" } });
      expect(human.started).toHaveLength(4);
      const unsaid = await h.ingest("tag.added", { contact: "c2", key: "unsaid", payload: { tag: "vip" } });
      expect(unsaid.started).toHaveLength(4);
    });
  });

  describe("branch@1 and set@1", () => {
    it("takes the first edge whose condition holds, else the else edge", async () => {
      const nodes = [trig(), branch("b1"), end("x_vip", "vip"), end("x_big", "big"), end("x_other", "other")];
      const edges = [{ from: "t1", to: "b1" }, { from: "b1", to: "x_vip", when: { has: ["{{contact.tags}}", "vip"] } }, { from: "b1", to: "x_big", when: { gt: ["{{event.amount}}", 1000] } }, { from: "b1", to: "x_other", else: true }];
      const h = await harness(kind, { workflows: [flow("w", nodes, edges)] });
      await h.ingest("appointment.booked", { contact: "c1", payload: { contact: { tags: ["vip"] }, amount: 5000 } });
      await h.ingest("appointment.booked", { contact: "c2", payload: { amount: 5000 } });
      await h.ingest("appointment.booked", { contact: "c3", payload: { amount: 10 } });
      expect((await h.runs()).map((r) => r.endReason).sort()).toEqual(["big", "other", "vip"]);
    });
    it("computes variables later steps read: typed values, text, $pick and $if", async () => {
      const nodes = [trig(), set("s1", "n", "{{event.amount}}"), set("s2", "label", { $pick: "{{event.kind}}", cases: { refund: "Refund" }, else: "Payment" }),
        set("s3", "big", { $if: { gt: ["{{vars.n}}", 100] }, then: true, else: false }), set("s4", "line", "{{vars.label}} of {{vars.n | money}}"), branch("b1"), end("x_big", "big"), end("x_small", "small")];
      const edges = [...chain("t1", "s1", "s2", "s3", "s4", "b1"), { from: "b1", to: "x_big", when: { eq: ["{{vars.big}}", true] } }, { from: "b1", to: "x_small", else: true }];
      const h = await harness(kind, { workflows: [flow("w", nodes, edges)] });
      await h.ingest("appointment.booked", { payload: { amount: 1500, kind: "refund" } });
      const r = await h.run();
      expect(r.context.vars).toEqual({ n: 1500, label: "Refund", big: true, line: "Refund of 1,500" });
      expect(r.endReason).toBe("big");
    });
  });

  describe("message@1", () => {
    it("writes a text as an outbox row with its rendered words, and goes on once it is delivered", async () => {
      const h = await harness(kind, { workflows: [flow("w", [trig(), text("m1"), end()], chain("t1", "m1", "x1"), { sendWindow: window })], content: sms("m1", "Hi {{contact.first_name}}, see you {{appointment.starts_at | date:long}}") });
      await h.ingest("appointment.booked", booked());
      const [row] = await h.outbox();
      expect(row).toMatchObject({ kind: "message.sms", status: "sent", node: "m1", contactId: "c1" });
      expect(row!.payload).toMatchObject({ contentKey: "c.m1", text: "Hi Ana, see you Thursday, October 29 at 2:00 PM" });
      expect(h.texts()).toEqual(["Hi Ana, see you Thursday, October 29 at 2:00 PM"]);
      expect((await h.run()).status).toBe("completed");
    });
    it("skips a message that is too late, or sends its stale words instead", async () => {
      const validity = { before: "appointment.starts_at", minLead: "15m" };
      const nodes = [trig(), text("m1", "c.m1", { validity }), text("m2", "c.m2", { validity, whenStale: { send: "c.late" } }), end()];
      const h = await harness(kind, { workflows: [flow("w", nodes, chain("t1", "m1", "m2", "x1"), { sendWindow: window })], content: { ...sms("m1", "On time"), ...sms("m2", "Also on time"), "c.late": { channel: "sms", body: "Sorry, this came late" } } });
      await h.ingest("appointment.booked", booked("2026-10-26T14:10:00Z"));
      expect(h.texts()).toEqual(["Sorry, this came late"]);
      expect((await h.steps()).find((s) => s.node === "m1")).toMatchObject({ status: "skipped", result: { stale: "too late for this message: skipped" } });
    });
    it("waits for the send window to open before a human message, then sends it", async () => {
      const h = await harness(kind, { start: "2026-10-27T01:00:00Z", workflows: [flow("w", [trig(), text("m1", "c.m1", { kind: "human" }), end()], chain("t1", "m1", "x1"), { sendWindow: window })], content: sms("m1", "Morning") });
      await h.ingest("appointment.booked", booked());
      expect(await h.outbox()).toHaveLength(0);
      expect((await h.run()).nextWakeAt?.toISOString()).toBe("2026-10-27T12:00:00.000Z");
      await h.advance("12h");
      expect((await h.outbox())[0]!.sentAt?.toISOString()).toBe("2026-10-27T12:00:00.000Z");
    });
    it("shows only the buttons whose condition holds, each with its label", async () => {
      const buttons = [{ action: "link_payment", value: "{{payment.id}}", when: { not: { exists: "payment.contact_id" } } }, { action: "alert_resolve", value: "{{payment.id}}" }];
      const h = await harness(kind, { settings: SETTINGS, workflows: [flow("w", [trig("payment.failed"), post("p1", { buttons }), end()], chain("t1", "p1", "x1"))], content: slack("p1", "Failed: {{payment.id}}", { link_payment: "Link it", alert_resolve: "Resolved" }) });
      await h.ingest("payment.failed", { payload: { payment: { id: "pay1" } } });
      await h.ingest("payment.failed", { payload: { payment: { id: "pay2", contact_id: "c1" } } });
      const calls = h.fp.effects("slack").map((c) => (c.args as { buttons: { action: string; label: string }[] }).buttons.map((b) => `${b.action}:${b.label}`));
      expect(calls).toEqual([["link_payment:Link it", "alert_resolve:Resolved"], ["alert_resolve:Resolved"]]);
    });
    it("replies under a post the run made; with threadOnly and no such post, posts nothing", async () => {
      const nodes = [trig("payment.failed"), branch("b0"), post("p1"), post("p2", { thread: { node: "p1" } }), post("p3", { thread: { tag: "nope:{{payment.id}}" }, threadOnly: true }), end()];
      const edges = [{ from: "t1", to: "b0" }, { from: "b0", to: "p1", when: { exists: "payment.id" } }, { from: "b0", to: "p2", else: true }, ...chain("p1", "p2", "p3", "x1")];
      const h = await harness(kind, { settings: SETTINGS, workflows: [flow("w", nodes, edges)], content: { ...slack("p1", "Top"), ...slack("p2", "Reply"), ...slack("p3", "Never") } });
      await h.ingest("payment.failed", { payload: { payment: { id: "pay1" } } });
      const posts = h.fp.effects("slack").map((c) => c.args as { text: string; threadTs?: string });
      expect(posts.map((p) => p.text)).toEqual(["Top", "Reply"]);
      expect(posts[1]!.threadTs).toBe((await h.posts()).find((p) => p.node === "p1")!.ts);
      expect((await h.outbox()).find((o) => o.node === "p3")).toMatchObject({ status: "suppressed", lastError: "there is no post to reply under" });
    });
  });

  describe("ask@1 and listeners", () => {
    const askNode = (then: string, extra: N = {}): N => ({ id: "q1", type: "ask@1", title: "Keep or cancel?", to: { channel: "{{setting.slack.channel.ops}}" }, content: "c.q1", answers: { buttons: [{ value: "keep" }, { value: "cancel" }] }, into: "decision", then, remember: "decision:{{appointment.id}}", ...extra });
    const content = { ...slack("q1", "Keep {{contact.first_name}}'s call?", { keep: "Keep", cancel: "Cancel" }), ...slack("p1", "Decided: {{vars.decision.value}}"), ...slack("p2", "Nobody answered"), ...sms("m1", "Reminder") };
    const answer = async (h: Awaited<ReturnType<typeof harness>>, value: string) => {
      const p = (await h.posts()).find((x) => x.node === "q1")!;
      return h.engine.answer({ offerId: h.offerId, channel: p.channel, ts: p.ts, value, person: "U1" });
    };
    it("posts the question, parks on it, and leaves by answered with the answer kept", async () => {
      const h = await harness(kind, { settings: SETTINGS, content, workflows: [flow("w", [trig(), askNode("wait", { timeout: "2h" }), post("p1"), end()], [{ from: "t1", to: "q1" }, { from: "q1", to: "p1", on: "answered" }, { from: "q1", to: "x1", on: "timeout" }, { from: "p1", to: "x1" }])] });
      await h.ingest("appointment.booked", booked());
      expect((await h.run()).status).toBe("waiting");
      await expect(answer(h, "maybe")).rejects.toThrow("not one of this question's answers");
      await answer(h, "cancel");
      await h.due();
      expect((await h.run()).context.vars.decision).toMatchObject({ value: "cancel", person: "U1" });
      expect(h.fp.effects("slack").map((c) => (c.args as { text: string }).text)).toEqual(["Keep Ana's call?", "Decided: cancel"]);
      expect((await h.events("ask.answered"))[0]!.payload).toMatchObject({ tag: "decision:a1", value: "cancel", node: "q1" });
    });
    it("leaves by timeout, with nothing kept, when nobody answers in time", async () => {
      const h = await harness(kind, { settings: SETTINGS, content, workflows: [flow("w", [trig(), askNode("wait", { timeout: "2h" }), post("p1"), end("x_t", "nobody")], [{ from: "t1", to: "q1" }, { from: "q1", to: "p1", on: "answered" }, { from: "q1", to: "x_t", on: "timeout" }, { from: "p1", to: "x_t" }])] });
      await h.ingest("appointment.booked", booked());
      await h.advance("2h");
      expect(await h.run()).toMatchObject({ status: "completed", endReason: "nobody" });
      expect((await h.run()).context.vars.decision).toBeNull();
    });
    it("goes on after asking; a later wait for the answer takes one given meanwhile at once", async () => {
      const nodes = [trig(), askNode("go_on"), wait("w1", { for: "1h" }), wait("w2", { answer: { ask: "q1" }, timeout: "1d", into: "got" }), end("x_yes", "answered"), end("x_no", "no_answer")];
      const edges = [...chain("t1", "q1", "w1", "w2"), { from: "w2", to: "x_yes", on: "arrived" }, { from: "w2", to: "x_no", on: "timeout" }];
      const h = await harness(kind, { settings: SETTINGS, content, workflows: [flow("w", nodes, edges)] });
      await h.ingest("appointment.booked", booked());
      await h.advance("10m");
      await answer(h, "keep");
      await h.advance("1h");
      expect(await h.run()).toMatchObject({ endReason: "answered" });
      expect((await h.run()).context.vars.got).toMatchObject({ value: "keep" });
    });
    it("a listener's answer takes the run off its wait along answered, and $resume returns it to the wait, which keeps its time", async () => {
      const nodes = [trig(), askNode("listen", { until: { anchor: "appointment.starts_at", zone: "contact" } }), wait("w1", { until: { anchor: "appointment.starts_at", offset: "-1h", zone: "contact" } }), text("m1", "c.m1"), branch("b1"), post("p1"), end("x_cancelled", "cancelled"), end()];
      const edges = [...chain("t1", "q1", "w1", "m1", "x1"), { from: "q1", to: "b1", on: "answered" }, { from: "q1", to: "$resume", on: "expired" },
        { from: "b1", to: "x_cancelled", when: { eq: ["{{vars.decision.value}}", "cancel"] } }, { from: "b1", to: "p1", else: true }, { from: "p1", to: "$resume" }];
      const h = await harness(kind, { settings: SETTINGS, content, workflows: [flow("w", nodes, edges, { sendWindow: window })] });
      await h.ingest("appointment.booked", booked());
      expect((await h.run()).wake).toMatchObject({ kind: "time", node: "w1" });
      await h.advance("1h");
      await answer(h, "keep");
      await h.due();
      const r = await h.run();
      expect(r).toMatchObject({ status: "waiting", currentNode: "w1" });
      expect(r.nextWakeAt?.toISOString()).toBe("2026-10-29T17:00:00.000Z");
      expect(h.fp.effects("slack").map((c) => (c.args as { text: string }).text)).toEqual(["Keep Ana's call?", "Decided: keep"]);
      await h.advance("4d");
      expect(await h.run()).toMatchObject({ status: "completed", endReason: "done" });
      expect(h.texts()).toEqual(["Reminder"]);
    });
    it("a listener's answer can end the run instead", async () => {
      const nodes = [trig(), askNode("listen", { timeout: "1d" }), wait("w1", { for: "2d" }), end(), end("x_cancelled", "cancelled")];
      const edges = [...chain("t1", "q1", "w1", "x1"), { from: "q1", to: "x_cancelled", on: "answered" }, { from: "q1", to: "$resume", on: "expired" }];
      const h = await harness(kind, { settings: SETTINGS, content, workflows: [flow("w", nodes, edges)] });
      await h.ingest("appointment.booked", booked());
      await answer(h, "cancel");
      await h.due();
      expect(await h.run()).toMatchObject({ status: "completed", endReason: "cancelled" });
      expect((await h.steps()).find((s) => s.node === "w1")).toMatchObject({ status: "skipped" });
    });
    it("at the listener's deadline the run is taken along expired, then back", async () => {
      const nodes = [trig(), askNode("listen", { timeout: "1h" }), wait("w1", { for: "1d" }), post("p2"), end()];
      const edges = [...chain("t1", "q1", "w1", "x1"), { from: "q1", to: "x1", on: "answered" }, { from: "q1", to: "p2", on: "expired" }, { from: "p2", to: "$resume" }];
      const h = await harness(kind, { settings: SETTINGS, content, workflows: [flow("w", nodes, edges)] });
      await h.ingest("appointment.booked", booked());
      expect((await h.run()).nextWakeAt?.toISOString()).toBe("2026-10-26T15:00:00.000Z");
      await h.advance("1h");
      expect(h.fp.effects("slack")).toHaveLength(2);
      expect((await h.run()).nextWakeAt?.toISOString()).toBe("2026-10-27T14:00:00.000Z");
      await h.advance("1d");
      expect((await h.run()).status).toBe("completed");
    });
    it("a run reaching its end with a listener still armed takes the expired path first", async () => {
      const nodes = [trig(), askNode("listen"), wait("w1", { for: "1h" }), post("p2"), end()];
      const edges = [...chain("t1", "q1", "w1", "x1"), { from: "q1", to: "x1", on: "answered" }, { from: "q1", to: "p2", on: "expired" }, { from: "p2", to: "$resume" }];
      const h = await harness(kind, { settings: SETTINGS, content, workflows: [flow("w", nodes.map((n) => (n.id === "q1" ? { ...n, timeout: "1d" } : n)), edges)] });
      await h.ingest("appointment.booked", booked());
      await h.advance("1h");
      expect(h.fp.effects("slack").map((c) => (c.args as { text: string }).text)).toEqual(["Keep Ana's call?", "Nobody answered"]);
      expect(await h.run()).toMatchObject({ status: "completed", endReason: "done" });
    });
    it("waits on a question another run asked, by the tag it was remembered under", async () => {
      const asker = flow("asker", [trig(), askNode("go_on"), end()], chain("t1", "q1", "x1"));
      const waiter = flow("waiter", [trig("appointment.rescheduled"), wait("w1", { answer: { tag: "decision:{{appointment.id}}" }, timeout: "1d", into: "d" }), end("x_got", "got"), end("x_none", "none")],
        [{ from: "t1", to: "w1" }, { from: "w1", to: "x_got", on: "arrived" }, { from: "w1", to: "x_none", on: "timeout" }]);
      const h = await harness(kind, { settings: SETTINGS, content, workflows: [asker, waiter] });
      await h.ingest("appointment.booked", booked());
      await h.ingest("appointment.rescheduled", booked());
      await h.advance("5m");
      await answer(h, "keep");
      await h.due();
      const w = (await h.runs()).find((r) => r.workflowId === h.wfs.waiter!.id)!;
      expect(w).toMatchObject({ endReason: "got" });
      expect(w.context.vars.d).toMatchObject({ value: "keep" });
    });
  });

  describe("action@1", () => {
    it("an action's effect is an outbox row; what it gives back is kept in into", async () => {
      const nodes = [trig(), act("a1", "crm.move_deal", { pipeline: "{{setting.crm.pipeline}}", stage: "booked", ifMissing: "create", pick: "open" }, { into: "deal" }), act("a2", "crm.add_tag", { tags: ["deal-{{vars.deal.id}}"] }), end()];
      const h = await harness(kind, { settings: { "crm.pipeline": "Sales" }, workflows: [flow("w", nodes, chain("t1", "a1", "a2", "x1"))] });
      await h.ingest("appointment.booked", booked());
      const calls = h.fp.effects("crm");
      expect(calls.map((c) => c.method)).toEqual(["moveDeal", "addTags"]);
      expect(calls[0]!.args).toMatchObject({ id: "c1", pipeline: "Sales", stage: "booked" });
      expect(calls[1]!.args).toMatchObject({ tags: [`deal-${(await h.run()).context.vars.deal && ((await h.run()).context.vars.deal as { id: string }).id}`] });
    });
    it("leaves a CRM field alone when its value renders empty, never blanking it", async () => {
      const h = await harness(kind, { workflows: [flow("w", [trig(), act("a1", "crm.update_contact", { set: { lead_source: "{{event.source_name}}", call_type: "{{appointment.call_type}}" } }), end()], chain("t1", "a1", "x1"))] });
      await h.ingest("appointment.booked", booked());
      expect(h.fp.effects("crm")[0]!.args).toEqual({ id: "c1", set: { call_type: "closing" } });
      expect((await h.outbox())[0]!.payload.leftAlone).toEqual(["set.lead_source"]);
    });
    it("records a fact that starts the workflows listening for it, but never its own", async () => {
      const recorder = flow("recorder", [trig("payment.succeeded"), act("f1", "facts.record", { type: "payment.paid_in_full", data: { amount: "{{event.amount}}" }, startsWorkflows: true }), end()], chain("t1", "f1", "x1"));
      const listener = flow("listener", [trig("payment.paid_in_full"), end()], chain("t1", "x1"));
      const self = flow("self", [trig("payment.paid_in_full"), act("f1", "facts.record", { type: "payment.paid_in_full", data: {}, startsWorkflows: true }), end()], chain("t1", "f1", "x1"));
      const h = await harness(kind, { workflows: [recorder, listener, self] });
      await h.ingest("payment.succeeded", { payload: { amount: 3000 } });
      const runs = await h.runs();
      const of = (k: string) => runs.filter((r) => r.workflowId === h.wfs[k]!.id).length;
      expect([of("recorder"), of("listener"), of("self")]).toEqual([1, 2, 1]);
      expect((await h.events("payment.paid_in_full")).map((e) => e.payload)).toEqual([{ amount: 3000 }, {}]);
    });
    it("looks up the last fact of a kind about the contact", async () => {
      const h = await harness(kind, { workflows: [flow("w", [trig("call.held"), act("l1", "facts.lookup", { query: "last_event", params: { type: "payment.succeeded" } }, { into: "last" }), end()], chain("t1", "l1", "x1"))] });
      await h.ingest("payment.succeeded", { payload: { amount: 1 } });
      await h.ingest("payment.succeeded", { payload: { amount: 2 } });
      await h.ingest("call.held", {});
      expect((await h.run()).context.vars.last).toMatchObject({ amount: 2, type: "payment.succeeded" });
    });
    it("pauses the contact's other waiting runs; an operator puts them back on their wait", async () => {
      const waiting = flow("waiting", [trig(), wait("w1", { for: "1d" }), end()], chain("t1", "w1", "x1"));
      const taker = flow("taker", [trig("contact.replied"), act("p1", "runs.pause_others", { scope: "contact" }), end()], chain("t1", "p1", "x1"));
      const h = await harness(kind, { workflows: [waiting, taker] });
      await h.ingest("appointment.booked", booked());
      await h.ingest("contact.replied", {});
      const paused = (await h.runs()).find((r) => r.workflowId === h.wfs.waiting!.id)!;
      expect(paused).toMatchObject({ status: "paused", nextWakeAt: null });
      await h.engine.resume(paused.id);
      await h.advance("1d");
      expect((await h.runs()).find((r) => r.id === paused.id)).toMatchObject({ status: "completed" });
    });
  });

  describe("call@1", () => {
    it("starts another workflow about the same subject, with `with` as its event", async () => {
      const callee = flow("callee", [{ id: "t1", type: "trigger@1", title: "By hand", on: { manual: { about: "contact" } } }, set("s1", "why", "{{event.reason}} for {{contact.first_name}}"), act("f1", "facts.record", { type: "contact.handed_on", data: {}, startsWorkflows: false }), end()], chain("t1", "s1", "f1", "x1"), { reentry: { policy: "once_per_contact" } });
      const caller = flow("caller", [trig(), { id: "k1", type: "call@1", title: "Hand on", workflow: "callee", with: { reason: "no show" } }, { id: "k2", type: "call@1", title: "Again", workflow: "callee" }, end()], chain("t1", "k1", "k2", "x1"));
      const h = await harness(kind, { workflows: [callee, caller] });
      await h.ingest("appointment.booked", booked());
      const called = (await h.runs()).filter((r) => r.workflowId === h.wfs.callee!.id);
      expect(called).toHaveLength(1);
      expect(called[0]!.context.vars.why).toBe("no show for Ana");
      expect(called[0]).toMatchObject({ contactId: "c1", appointmentId: "a1" });
    });
  });

  it("a workflow that calls itself stops at the depth limit: the deepest run is held for a person", async () => {
    const loop = flow("loop", [{ id: "t1", type: "trigger@1", title: "By hand", on: { manual: { about: "contact" } } }, { id: "t2", type: "trigger@1", title: "Booked", on: { event: "appointment.booked" } }, { id: "k1", type: "call@1", title: "Again", workflow: "loop" }, end()], [...chain("t1", "k1", "x1"), { from: "t2", to: "k1" }]);
    const h = await harness(kind, { workflows: [loop] });
    await h.ingest("appointment.booked", booked());
    const runs = await h.runs();
    expect(runs).toHaveLength(9);
    expect(runs.filter((r) => r.status === "paused")).toHaveLength(1);
    expect((await h.store.tx((tx) => tx.steps(runs.find((r) => r.status === "paused")!.id))).find((x) => x.node === "k1")!.error).toContain("nested more than 8 deep");
  });

  describe("end@1 and failures", () => {
    it("a step that cannot run holds the run for a person; retry runs it again, skip goes on", async () => {
      const nodes = [trig(), { id: "r1", type: "report@1", title: "The wrap-up", report: "wrap.daily", period: "just_ended", into: "rep" }, end()];
      const h = await harness(kind, { workflows: [flow("w", nodes, chain("t1", "r1", "x1"))] });
      await h.ingest("appointment.booked", booked());
      const r = await h.run();
      expect(r).toMatchObject({ status: "paused", wake: { kind: "hold", node: "r1" } });
      expect((await h.alerts()).map((a) => a.kind)).toEqual(["run_held"]);
      await h.engine.resume(r.id, "retry");
      expect((await h.run()).status).toBe("paused");
      await h.engine.resume(r.id, "skip");
      expect(await h.run()).toMatchObject({ status: "completed", endReason: "done" });
      expect((await h.steps()).map((s) => `${s.node}:${s.status}`)).toEqual(["t1:ok", "r1:failed", "r1:skipped", "x1:ok"]);
    });
    it("an operator ends a run where it waits", async () => {
      const h = await harness(kind, { workflows: [flow("w", [trig(), wait("w1", { for: "1d" }), end()], chain("t1", "w1", "x1"))] });
      await h.ingest("appointment.booked", booked());
      await h.engine.end((await h.run()).id, "not_needed");
      expect(await h.run()).toMatchObject({ status: "ended", endReason: "not_needed", nextWakeAt: null });
    });
  });

  describe("reentry", () => {
    const once = (policy: string, extra: N = {}) => flow("w", [trig(), wait("w1", { for: "1h" }), text("m1"), end()], chain("t1", "w1", "m1", "x1"), { reentry: { policy, ...extra }, sendWindow: window });
    const content = sms("m1", "Hi");
    it("once_per_contact: a second trigger for the same contact starts nothing, even after the first run ends", async () => {
      const h = await harness(kind, { content, workflows: [once("once_per_contact")] });
      await h.ingest("appointment.booked", booked());
      expect((await h.ingest("appointment.booked", { appointment: "a2" })).started).toHaveLength(0);
      await h.advance("2h");
      expect((await h.ingest("appointment.booked", { appointment: "a3" })).started).toHaveLength(0);
      expect((await h.ingest("appointment.booked", { contact: "c2", appointment: "a4" })).started).toHaveLength(1);
    });
    it("once_per_appointment and once_per_deal: once per subject", async () => {
      const h = await harness(kind, { content, workflows: [once("once_per_appointment")] });
      await h.ingest("appointment.booked", booked());
      expect((await h.ingest("appointment.booked", { appointment: "a1" })).started).toHaveLength(0);
      expect((await h.ingest("appointment.booked", { appointment: "a2" })).started).toHaveLength(1);
      const d = await harness(kind, { content, workflows: [once("once_per_deal")] });
      await d.ingest("appointment.booked", { deal: "d1" });
      expect((await d.ingest("appointment.booked", { deal: "d1" })).started).toHaveLength(0);
      expect((await d.ingest("appointment.booked", { deal: "d2" })).started).toHaveLength(1);
    });
    it("a key refines the once: the same appointment at a new time is a new run once the first is over, never while it is in flight", async () => {
      const h = await harness(kind, { content, workflows: [once("once_per_appointment", { key: "{{appointment.starts_at}}" })] });
      await h.ingest("appointment.booked", booked("2026-10-29T18:00:00Z"));
      expect((await h.ingest("appointment.booked", booked("2026-10-30T18:00:00Z"))).started).toHaveLength(0);
      await h.advance("2h");
      expect((await h.ingest("appointment.booked", booked("2026-10-29T18:00:00Z"))).started).toHaveLength(0);
      expect((await h.ingest("appointment.booked", booked("2026-10-31T18:00:00Z"))).started).toHaveLength(1);
    });
    it("once_per_contact_per_window: once within the window, again after it", async () => {
      const h = await harness(kind, { content, workflows: [once("once_per_contact_per_window", { window: "1d" })] });
      await h.ingest("appointment.booked", booked());
      await h.advance("2h");
      expect((await h.ingest("appointment.booked", {})).started).toHaveLength(0);
      await h.advance("1d");
      expect((await h.ingest("appointment.booked", {})).started).toHaveLength(1);
    });
    it("always: every fact is its own run", async () => {
      const h = await harness(kind, { content, workflows: [once("always")] });
      await h.ingest("appointment.booked", booked());
      expect((await h.ingest("appointment.booked", booked())).started).toHaveLength(1);
    });
    it("a run that ends before doing anything releases its key: the next trigger gets its turn", async () => {
      const nodes = [trig(), branch("b1"), text("m1"), end("x_gate", "no_phone"), end()];
      const edges = [{ from: "t1", to: "b1" }, { from: "b1", to: "m1", when: { exists: "event.phone" } }, { from: "b1", to: "x_gate", else: true }, { from: "m1", to: "x1" }];
      const h = await harness(kind, { content, workflows: [flow("w", nodes, edges, { reentry: { policy: "once_per_contact" }, sendWindow: window })] });
      await h.ingest("appointment.booked", {});
      expect((await h.ingest("appointment.booked", { payload: { phone: "+1555" } })).started).toHaveLength(1);
      expect((await h.ingest("appointment.booked", { payload: { phone: "+1555" } })).started).toHaveLength(0);
      expect((await h.runs()).map((r) => r.endReason).sort()).toEqual(["done", "no_phone"]);
    });
    it("a trigger refused while a run held the key is replayed when that run ends having done nothing", async () => {
      const nodes = [trig("payment.succeeded"), { id: "t2", type: "trigger@1", title: "Signed", on: { event: "agreement.signed" } }, wait("w1", { event: { type: "agreement.signed", about: "contact" }, timeout: "1h" }), text("m1"), end("x_gate", "not_signed"), end()];
      const edges = [{ from: "t1", to: "w1" }, { from: "t2", to: "m1" }, { from: "w1", to: "m1", on: "arrived" }, { from: "w1", to: "x_gate", on: "timeout" }, { from: "m1", to: "x1" }];
      const h = await harness(kind, { content, workflows: [flow("w", nodes, edges, { reentry: { policy: "once_per_contact" }, sendWindow: window })] });
      await h.ingest("payment.succeeded", {});
      await h.advance("10m");
      await h.store.tx(async (tx) => { const r = (await tx.runs({ offerId: h.offerId }))[0]!; await tx.updateRun(r.id, { wake: { ...(r.wake as object), type: "agreement.countersigned" } as never }); });
      expect((await h.ingest("agreement.signed", {})).started).toHaveLength(0);
      await h.advance("1h");
      const runs = await h.runs();
      expect(runs.map((r) => `${r.triggerNode}:${r.endReason}`).sort()).toEqual(["t1:not_signed", "t2:done"]);
      expect(h.texts()).toEqual(["Hi"]);
    });
  });

  describe("the premise", () => {
    const premise = { label: "The call is still on", holds: { and: [{ ne: ["{{appointment.status}}", "cancelled"] }, { gt: ["{{appointment.starts_at}}", "{{now}}"] }] }, endReason: "call_not_on" };
    it("ends a waiting run as soon as a fact makes it false, before anything else is sent", async () => {
      const h = await harness(kind, { content: sms("m1", "Reminder"), workflows: [flow("w", [trig(), wait("w1", { for: "1d" }), text("m1"), end()], chain("t1", "w1", "m1", "x1"), { premise, sendWindow: window })] });
      await h.ingest("appointment.booked", booked());
      await h.advance("2h");
      await h.ingest("appointment.cancelled", { appointment: "a1", payload: { appointment: { status: "cancelled" } } });
      await h.due();
      expect(await h.run()).toMatchObject({ status: "ended", endReason: "call_not_on" });
      expect((await h.steps()).find((s) => s.node === "w1")).toMatchObject({ status: "skipped", result: { premise: "no longer holds" } });
      await h.advance("2d");
      expect(h.texts()).toEqual([]);
    });
    it("is checked again before a step that reaches outside: a call already past ends the run before its text", async () => {
      const h = await harness(kind, { content: sms("m1", "Hi"), workflows: [flow("w", [trig(), set("s1", "x", 1), text("m1"), end()], chain("t1", "s1", "m1", "x1"), { premise, sendWindow: window, reentry: { policy: "once_per_appointment" } })] });
      await h.ingest("appointment.booked", booked("2026-10-26T13:00:00Z"));
      expect(await h.run()).toMatchObject({ status: "ended", endReason: "call_not_on" });
      expect(await h.outbox()).toHaveLength(0);
      expect((await h.run()).reentryKey).toContain("~released~");
    });
  });

  describe("wait@1", () => {
    it("waits a length of time", async () => {
      const h = await harness(kind, { workflows: [flow("w", [trig(), wait("w1", { for: "90m" }), end()], chain("t1", "w1", "x1"))] });
      await h.ingest("appointment.booked", booked());
      expect((await h.run()).nextWakeAt?.toISOString()).toBe("2026-10-26T15:30:00.000Z");
      await h.advance("89m");
      expect((await h.run()).status).toBe("waiting");
      await h.advance("1m");
      expect((await h.run()).status).toBe("completed");
    });
    it("waits until a time rule, moved into the send window, and records what it computed", async () => {
      const h = await harness(kind, { workflows: [flow("w", [trig(), wait("w1", { until: { anchor: "appointment.starts_at", offset: "-24h", zone: "contact" } }), end()], chain("t1", "w1", "x1"), { sendWindow: window })] });
      await h.ingest("appointment.booked", booked("2026-10-29T11:00:00Z")); // 7am New York
      const step = (await h.steps()).find((s) => s.node === "w1")!;
      expect(step.result).toMatchObject({ computed: "2026-10-28T11:00:00.000Z", moved: "to_opening", fitted: "2026-10-28T12:00:00.000Z", wakeAt: "2026-10-28T12:00:00.000Z" });
    });
    it("does not move a time that fitSendWindow: false keeps", async () => {
      const h = await harness(kind, { workflows: [flow("w", [trig(), wait("w1", { until: { anchor: "appointment.starts_at", offset: "-24h", zone: "contact" }, fitSendWindow: false }), end()], chain("t1", "w1", "x1"), { sendWindow: window })] });
      await h.ingest("appointment.booked", booked("2026-10-29T11:00:00Z"));
      expect((await h.run()).nextWakeAt?.toISOString()).toBe("2026-10-28T11:00:00.000Z");
    });
    it("goes on at once when the time has already come", async () => {
      const h = await harness(kind, { workflows: [flow("w", [trig(), wait("w1", { until: { anchor: "appointment.starts_at", offset: "-24h", zone: "contact" } }), end()], chain("t1", "w1", "x1"))] });
      await h.ingest("appointment.booked", booked("2026-10-27T10:00:00Z"));
      expect(await h.run()).toMatchObject({ status: "completed" });
      expect((await h.steps()).find((s) => s.node === "w1")!.result.passed).toBeDefined();
    });
    it("follows a moved anchor: a rescheduled call moves its reminder", async () => {
      const h = await harness(kind, { workflows: [flow("w", [trig(), wait("w1", { until: { anchor: "appointment.starts_at", offset: "-1h", zone: "contact" } }), end()], chain("t1", "w1", "x1"))] });
      await h.ingest("appointment.booked", booked("2026-10-29T18:00:00Z"));
      await h.ingest("appointment.rescheduled", { appointment: "a1", payload: { appointment: { starts_at: "2026-10-28T15:00:00Z" } } });
      await h.due();
      expect((await h.run()).nextWakeAt?.toISOString()).toBe("2026-10-28T14:00:00.000Z");
    });
    it("waits for an event about the run's subject, kept in into; one its match refuses does not count", async () => {
      const nodes = [trig(), wait("w1", { event: { type: "payment.succeeded", about: "contact", match: { gte: ["{{event.amount}}", 100] } }, timeout: "1d", into: "paid" }), end("x_paid", "paid"), end("x_not", "not_paid")];
      const edges = [{ from: "t1", to: "w1" }, { from: "w1", to: "x_paid", on: "arrived" }, { from: "w1", to: "x_not", on: "timeout" }];
      const h = await harness(kind, { workflows: [flow("w", nodes, edges)] });
      await h.ingest("appointment.booked", booked());
      await h.advance("1h");
      await h.ingest("payment.succeeded", { payload: { amount: 50 } });
      await h.ingest("payment.succeeded", { contact: "c2", payload: { amount: 500 } });
      await h.due();
      expect((await h.run()).status).toBe("waiting");
      await h.ingest("payment.succeeded", { payload: { amount: 500 } });
      await h.due();
      expect(await h.run()).toMatchObject({ endReason: "paid" });
      expect((await h.run()).context.vars.paid).toMatchObject({ amount: 500 });
    });
    it("leaves by timeout when the event does not come; with since, counts one that came before", async () => {
      const mk = (since?: string) => flow("w", [trig("call.held"), wait("w1", { event: { type: "payment.succeeded", about: "contact", ...(since ? { since } : {}) }, timeout: "1h" }), end("x_paid", "paid"), end("x_not", "not_paid")], [{ from: "t1", to: "w1" }, { from: "w1", to: "x_paid", on: "arrived" }, { from: "w1", to: "x_not", on: "timeout" }]);
      const a = await harness(kind, { workflows: [mk()] });
      await a.ingest("payment.succeeded", {});
      await a.advance("1m");
      await a.ingest("call.held", {});
      await a.advance("1h");
      expect((await a.runs())[0]).toMatchObject({ endReason: "not_paid" });
      const b = await harness(kind, { workflows: [mk("{{event.occurred_at | minus:1d}}")] });
      await b.ingest("payment.succeeded", {});
      await b.advance("1m");
      await b.ingest("call.held", {});
      expect((await b.runs())[0]).toMatchObject({ endReason: "paid" });
    });
    it("waits for the contact's reply, and for the rest of what they are typing", async () => {
      const nodes = [trig(), wait("w1", { reply: { channel: "sms", settle: "90s" }, timeout: "4h", into: "answer" }), end("x_r", "replied"), end("x_t", "silent")];
      const h = await harness(kind, { workflows: [flow("w", nodes, [{ from: "t1", to: "w1" }, { from: "w1", to: "x_r", on: "arrived" }, { from: "w1", to: "x_t", on: "timeout" }])] });
      await h.ingest("appointment.booked", booked());
      await h.advance("10m");
      await h.ingest("message.received", { payload: { channel: "email", body: "not this one" } });
      await h.ingest("message.received", { payload: { channel: "sms", body: "Yes" } });
      await h.advance("1m");
      await h.ingest("message.received", { payload: { channel: "sms", body: "see you then" } });
      await h.advance("1m");
      expect((await h.run()).status).toBe("waiting");
      await h.advance("1m");
      expect(await h.run()).toMatchObject({ endReason: "replied" });
      expect((await h.run()).context.vars.answer).toMatchObject({ body: "Yes\nsee you then", channel: "sms" });
    });
    it("looks again every interval until the condition holds (a bounded recheck loop)", async () => {
      const nodes = [trig("lead.created"), wait("w1", { check: { holds: { exists: "contact.phone" }, every: "1h" }, timeout: "24h" }), end("x_ok", "has_phone"), end("x_no", "no_phone")];
      const edges = [{ from: "t1", to: "w1" }, { from: "w1", to: "x_ok", on: "arrived" }, { from: "w1", to: "x_no", on: "timeout" }];
      const h = await harness(kind, { workflows: [flow("w", nodes, edges)] });
      await h.ingest("lead.created", { payload: { contact: { first_name: "Ana" } } });
      expect((await h.run()).nextWakeAt?.toISOString()).toBe("2026-10-26T15:00:00.000Z");
      await h.advance("2h30m");
      await h.store.tx(async (tx) => { const r = (await tx.runs({ offerId: h.offerId }))[0]!; await tx.updateRun(r.id, { nextWakeAt: new Date("2026-10-26T17:00:00Z") }); });
      await h.ingest("contact.updated", { payload: { contact: { phone: "+1555" } } });
      await h.advance("30m");
      expect(await h.run()).toMatchObject({ endReason: "has_phone" });
      expect((await h.steps()).find((s) => s.node === "w1")!.result.checks).toBe(4);
    });
    it("gives up at the deadline of a recheck loop and leaves by timeout", async () => {
      const nodes = [trig("lead.created"), wait("w1", { check: { holds: { exists: "contact.phone" }, every: "5h" }, timeout: "12h" }), end("x_ok", "has_phone"), end("x_no", "no_phone")];
      const h = await harness(kind, { workflows: [flow("w", nodes, [{ from: "t1", to: "w1" }, { from: "w1", to: "x_ok", on: "arrived" }, { from: "w1", to: "x_no", on: "timeout" }])] });
      await h.ingest("lead.created", {});
      await h.advance("11h");
      expect((await h.run()).nextWakeAt?.toISOString()).toBe("2026-10-27T02:00:00.000Z");
      await h.advance("1h");
      expect(await h.run()).toMatchObject({ endReason: "no_phone" });
    });
    it("pauses for a person until an operator resumes it, then leaves by resumed", async () => {
      const nodes = [trig(), wait("w1", { person: { reason: "check_by_hand" } }), end("x_r", "resumed")];
      const h = await harness(kind, { workflows: [flow("w", nodes, [{ from: "t1", to: "w1" }, { from: "w1", to: "x_r", on: "resumed" }])] });
      await h.ingest("appointment.booked", booked());
      expect(await h.run()).toMatchObject({ status: "paused", nextWakeAt: null, wake: { kind: "person", reason: "check_by_hand" } });
      await h.advance("3d");
      expect((await h.run()).status).toBe("paused");
      await h.engine.resume((await h.run()).id);
      expect(await h.run()).toMatchObject({ status: "completed", endReason: "resumed" });
    });
  });

  describe("pinned versions", () => {
    it("a run keeps the version it started on when a new one is saved", async () => {
      const v1 = flow("w", [trig(), wait("w1", { for: "1h" }), end("x1", "v1")], chain("t1", "w1", "x1"));
      const h = await harness(kind, { workflows: [v1] });
      await h.ingest("appointment.booked", booked());
      await h.store.tx((tx) => saveVersion(tx, { offerId: h.offerId, definition: flow("w", [trig(), end("x1", "v2")], chain("t1", "x1")), by: "test", why: "v2", now: h.clock.now() }));
      await h.ingest("appointment.booked", { appointment: "a2" });
      await h.advance("1h");
      expect((await h.runs()).map((r) => r.endReason).sort()).toEqual(["v1", "v2"]);
    });
  });
});
