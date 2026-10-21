import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/db/client";
import { chain, flow, harness, STORES, window } from "@/test/harness";
import { clearBreaker, MAX_TRIES, RETRY_DELAYS_MS, resumeConnection } from "./dispatcher";

type N = Record<string, unknown>;
const trig = (): N => ({ id: "t1", type: "trigger@1", title: "Start", on: { event: "appointment.booked" } });
const text = (id: string, extra: N = {}): N => ({ id, type: "message@1", title: `Text ${id}`, to: { contact: "sms" }, content: `c.${id}`, kind: "transactional", ...extra });
const end = (id = "x1", reason = "done"): N => ({ id, type: "end@1", title: "End", reason });
const tag = (id: string, extra: N = {}): N => ({ id, type: "action@1", title: `Tag ${id}`, action: "crm.add_tag", params: { tags: [id] }, ...extra });
const content = { "c.m1": { channel: "sms" as const, body: "Hi {{contact.first_name}}" }, "c.m2": { channel: "sms" as const, body: "Again" } };
const oneText = (extra: N = {}) => flow("w", [trig(), text("m1", extra), end()], chain("t1", "m1", "x1"), { sendWindow: window });
const payload = { appointment: "a1", payload: { contact: { first_name: "Ana" } } };

afterAll(async () => { await closeDb(); });

describe.each(STORES)("the outbox, on %s", (kind) => {
  describe("idempotency", () => {
    it("writes the idempotency key and marks the row sending before the vendor is called", async () => {
      const h = await harness(kind, { content, workflows: [oneText()] });
      const seen: unknown[] = [];
      const ports = h.fp.ports();
      const send = ports.messaging.sendSms;
      ports.messaging.sendSms = async (c, m) => {
        const [row] = await h.outbox();
        seen.push({ status: row!.status, key: row!.idempotencyKey, given: c.idempotencyKey, attempts: row!.attempts });
        return send(c, m);
      };
      (h.engine as unknown as { ports: typeof ports }).ports = ports;
      await h.ingest("appointment.booked", payload);
      const [row] = await h.outbox();
      expect(seen).toEqual([{ status: "sending", key: row!.idempotencyKey, given: row!.idempotencyKey, attempts: 1 }]);
      expect(row!.idempotencyKey).toBe(`${row!.runId}:m1:1`);
    });
    it("never delivers a row twice, however often it is asked to", async () => {
      const h = await harness(kind, { content, workflows: [oneText()] });
      await h.ingest("appointment.booked", payload);
      const [row] = await h.outbox();
      expect(await h.engine.deliver(row!.id)).toBe(false);
      await h.due();
      expect(h.fp.effects("messaging")).toHaveLength(1);
      expect(h.fp.duplicates()).toEqual([]);
    });
    it("gives back the row already there for an idempotency key written again", async () => {
      const h = await harness(kind, { content, workflows: [oneText()] });
      await h.ingest("appointment.booked", payload);
      const [row] = await h.outbox();
      const again = await h.store.tx((tx) => tx.insertOutbox({ offerId: row!.offerId, runId: row!.runId, stepId: row!.stepId, node: "m1", kind: "message.sms", effect: "contact", idempotencyKey: row!.idempotencyKey, payload: { text: "other" }, contactId: "c1", createdAt: new Date(), nextAttemptAt: new Date() }));
      expect(again.id).toBe(row!.id);
      expect(again.payload.text).toBe("Hi Ana");
      expect(await h.outbox()).toHaveLength(1);
    });
    it("a message whose result is unknown is never sent again, raises an alert, and the run goes on", async () => {
      const h = await harness(kind, { content, workflows: [flow("w", [trig(), text("m1"), text("m2"), end()], chain("t1", "m1", "m2", "x1"), { sendWindow: window })] });
      h.fp.failNext({ port: "messaging", failure: "ambiguous", message: "timed out after sending" });
      await h.ingest("appointment.booked", payload);
      await h.advance("1d");
      const rows = await h.outbox();
      expect(rows.map((r) => [r.node, r.status])).toEqual([["m1", "unknown"], ["m2", "sent"]]);
      expect(h.fp.calls.filter((c) => c.method === "sendSms").map((c) => c.args)).toHaveLength(2);
      expect((await h.alerts()).map((a) => a.kind)).toEqual(["outbox_unknown"]);
      expect((await h.steps()).find((s) => s.node === "m1")!.status).toBe("skipped");
      expect((await h.run()).status).toBe("completed");
    });
    it("a row left sending by a dispatcher that stopped mid-call is marked unknown, never re-sent", async () => {
      const h = await harness(kind, { content, workflows: [oneText()] });
      const ports = h.fp.ports();
      ports.messaging.sendSms = () => new Promise(() => undefined); // the call never comes back
      (h.engine as unknown as { ports: typeof ports }).ports = ports;
      void h.engine.ingest({ offerId: h.offerId, type: "appointment.booked", source: "t", dedupeKey: "e1", contactId: "c1", appointmentId: "a1", payload: payload.payload }).then(() => h.engine.runDue());
      for (let i = 0; i < 50 && (await h.outbox()).every((r) => r.status !== "sending"); i++) await new Promise((r) => setTimeout(r, 10));
      expect((await h.outbox())[0]!.status).toBe("sending");
      h.clock.advance("10m");
      expect(await h.engine.reap()).toBe(1);
      expect((await h.outbox())[0]).toMatchObject({ status: "unknown", errorClass: "ambiguous" });
      await h.due();
      expect((await h.run()).status).toBe("completed");
    });
  });

  describe("failure classes", () => {
    it("transient: tried again after backoff with jitter, and sent when it comes back", async () => {
      const h = await harness(kind, { content, workflows: [oneText()] });
      h.fp.failNext({ port: "messaging", failure: "transient", times: 2 });
      await h.ingest("appointment.booked", payload);
      let [row] = await h.outbox();
      expect(row).toMatchObject({ status: "queued", attempts: 1, errorClass: "transient" });
      expect(row!.nextAttemptAt!.getTime() - h.clock.now().getTime()).toBe(RETRY_DELAYS_MS[0]);
      await h.advance("1m");
      [row] = await h.outbox();
      expect(row!.nextAttemptAt!.getTime() - h.clock.now().getTime()).toBe(RETRY_DELAYS_MS[1]);
      await h.advance("5m");
      [row] = await h.outbox();
      expect(row).toMatchObject({ status: "sent", attempts: 3 });
      expect((await h.run()).status).toBe("completed");
    });
    it(`transient: after ${MAX_TRIES} tries it fails, and the step's failure rule applies (skip goes on)`, async () => {
      const h = await harness(kind, { content, workflows: [oneText()] });
      h.fp.failNext({ port: "messaging", failure: "transient", times: 9 });
      await h.ingest("appointment.booked", payload);
      await h.advance("1h");
      expect((await h.outbox())[0]).toMatchObject({ status: "failed", attempts: MAX_TRIES });
      expect(h.fp.calls.filter((c) => c.method === "sendSms")).toHaveLength(MAX_TRIES);
      expect(await h.run()).toMatchObject({ status: "completed" });
    });
    it("permanent: failed at once; a step marked hold holds the run for a person, and retry writes a fresh effect", async () => {
      const h = await harness(kind, { workflows: [flow("w", [trig(), tag("t-a", { onFailure: "hold" }), end()], chain("t1", "t-a", "x1"))] });
      h.fp.failNext({ port: "crm", failure: "permanent", message: "422 the tag is not allowed" });
      await h.ingest("appointment.booked", payload);
      const r = await h.run();
      expect(r).toMatchObject({ status: "paused", wake: { kind: "hold" } });
      expect((await h.outbox())[0]).toMatchObject({ status: "failed", attempts: 1, errorClass: "permanent" });
      await h.engine.resume(r.id, "retry");
      await h.due();
      expect((await h.outbox()).map((o) => o.status)).toEqual(["failed", "sent"]);
      expect((await h.alerts()).map((a) => a.kind).sort()).toEqual(["outbox_failed", "run_held"]);
      expect(await h.run()).toMatchObject({ status: "completed" });
    });
    it("auth: pauses the offer's connection on that port with one alert; everything through it waits until it is fixed", async () => {
      const h = await harness(kind, { workflows: [flow("w", [trig(), tag("t-a"), end()], chain("t1", "t-a", "x1"))] });
      h.fp.failNext({ port: "crm", failure: "auth", message: "401 token revoked" });
      await h.ingest("appointment.booked", payload);
      await h.ingest("appointment.booked", { appointment: "a2" });
      await h.advance("1h");
      expect((await h.outbox()).map((o) => o.status)).toEqual(["queued", "queued"]);
      expect((await h.alerts()).map((a) => a.kind)).toEqual(["connection_auth"]);
      expect(h.fp.calls.filter((c) => c.method === "addTags")).toHaveLength(1);
      await resumeConnection(h.store, h.offerId, "crm", h.clock.now());
      await h.due();
      expect((await h.outbox()).map((o) => o.status)).toEqual(["sent", "sent"]);
      expect((await h.alerts()).filter((a) => a.resolvedAt === null)).toHaveLength(0);
      expect((await h.runs()).map((r) => r.status)).toEqual(["completed", "completed"]);
    });
  });

  describe("the gate, end to end", () => {
    it("sandbox: a text to a contact who is not the operator is refused; one to the operator goes", async () => {
      const h = await harness(kind, { content, delivery: "sandbox", operator: { phones: ["+1 555 010 1002"] }, workflows: [oneText()],
        contacts: [{ id: "c1", phone: "+15550101001", email: null, dnd: {} }, { id: "c2", phone: "+15550101002", email: null, dnd: {} }] });
      await h.ingest("appointment.booked", payload);
      await h.ingest("appointment.booked", { ...payload, contact: "c2", appointment: "a2" });
      expect((await h.outbox()).map((o) => [o.contactId, o.status])).toEqual([["c1", "suppressed"], ["c2", "sent"]]);
      expect((await h.outbox())[0]!.gates[0]).toMatchObject({ check: "delivery", result: "suppress" });
    });
    it("sandbox: a Slack post goes to the offer's test channel, marked, and is remembered there", async () => {
      const post = flow("w", [{ id: "t1", type: "trigger@1", title: "Start", on: { event: "payment.failed" } }, { id: "p1", type: "message@1", title: "Post", to: { slack: { channel: "{{setting.slack.channel.ops}}" } }, content: "c.p1" }, end()], chain("t1", "p1", "x1"));
      const h = await harness(kind, { delivery: "sandbox", settings: { "slack.channel.ops": "C-OPS", "slack.channel.test": "C-TEST" }, content: { "c.p1": { channel: "slack", body: "Failed" } }, workflows: [post] });
      await h.ingest("payment.failed", {});
      expect(h.fp.effects("slack")[0]!.args).toMatchObject({ channel: "C-TEST", sandbox: true, text: "Failed" });
      expect((await h.posts())[0]).toMatchObject({ channel: "C-TEST", sandbox: true, node: "p1" });
    });
    it("dry: a CRM write is recorded on its row and not made", async () => {
      const h = await harness(kind, { crmWrites: "dry", workflows: [flow("w", [trig(), tag("t-a"), end()], chain("t1", "t-a", "x1"))] });
      await h.ingest("appointment.booked", payload);
      expect((await h.outbox())[0]).toMatchObject({ status: "suppressed", payload: { params: { tags: ["t-a"] } } });
      expect(h.fp.effects("crm")).toHaveLength(0);
    });
    it("reads DND from the CRM at the moment of sending", async () => {
      const h = await harness(kind, { content, workflows: [flow("w", [trig(), text("m1"), { id: "w1", type: "wait@1", title: "Later", for: "1h" }, text("m2"), end()], chain("t1", "m1", "w1", "m2", "x1"), { sendWindow: window })] });
      await h.ingest("appointment.booked", payload);
      h.fp.contacts.get("c1")!.dnd = { sms: true };
      await h.advance("1h");
      expect((await h.outbox()).map((o) => o.status)).toEqual(["sent", "suppressed"]);
    });
    it("holds the message that would break the cap, alerts, and the run goes on", async () => {
      const five = flow("w", [trig(), ...["m1", "m2", "m3", "m4", "m5", "m6"].map((id) => text(id)), end()], chain("t1", "m1", "m2", "m3", "m4", "m5", "m6", "x1"), { sendWindow: window });
      const c = Object.fromEntries(["m1", "m2", "m3", "m4", "m5", "m6"].map((id) => [`c.${id}`, { channel: "sms" as const, body: id }]));
      const h = await harness(kind, { content: c, workflows: [five] });
      await h.ingest("appointment.booked", payload);
      expect((await h.outbox()).map((o) => o.status)).toEqual(["sent", "sent", "sent", "sent", "held", "held"]);
      expect((await h.alerts()).map((a) => a.kind)).toEqual(["frequency_cap"]);
      expect((await h.run()).status).toBe("completed");
    });
    it("counts the cap across workflows and by the contact's own calendar day", async () => {
      const a = flow("a", [trig(), text("m1"), text("m2"), end()], chain("t1", "m1", "m2", "x1"), { sendWindow: window });
      const b = flow("b", [trig(), text("m1"), text("m2"), text("m3"), end()], chain("t1", "m1", "m2", "m3", "x1"), { sendWindow: window });
      const c = { "c.m1": { channel: "sms" as const, body: "1" }, "c.m2": { channel: "sms" as const, body: "2" }, "c.m3": { channel: "sms" as const, body: "3" } };
      const h = await harness(kind, { start: "2026-10-27T02:30:00Z", content: c, workflows: [a, b] }); // 10:30pm New York
      await h.ingest("appointment.booked", payload);
      expect((await h.outbox()).filter((o) => o.status === "sent")).toHaveLength(4);
      await h.advance("2h"); // past midnight in New York
      await h.ingest("appointment.booked", { appointment: "a2" });
      expect((await h.outbox()).filter((o) => o.status === "sent")).toHaveLength(8);
    });
    it("trips the circuit breaker at the offer's hourly limit: sends pause, an alert is raised, until an operator clears it", async () => {
      const h = await harness(kind, { content, settings: { "delivery.breaker_per_hour": 2 }, workflows: [oneText()],
        contacts: ["c1", "c2", "c3", "c4"].map((id) => ({ id, phone: `+1555010${id}`, email: null, dnd: {} })) });
      for (const c of ["c1", "c2", "c3", "c4"]) await h.ingest("appointment.booked", { ...payload, contact: c, appointment: `a-${c}` });
      expect((await h.outbox()).map((o) => o.status)).toEqual(["sent", "sent", "held", "held"]);
      expect((await h.outbox())[3]!.gates.at(-1)).toMatchObject({ check: "breaker", why: "sends are paused by the circuit breaker" });
      expect((await h.alerts()).map((a) => a.kind)).toEqual(["circuit_breaker"]);
      await clearBreaker(h.store, h.offerId, h.clock.now());
      await h.advance("61m");
      await h.ingest("appointment.booked", { ...payload, contact: "c1", appointment: "a-5" });
      expect((await h.outbox()).at(-1)!.status).toBe("sent");
    });
    it("holds a message with a blank variable, and says which", async () => {
      const h = await harness(kind, { content: { "c.m1": { channel: "sms", body: "Join at {{appointment.meeting_url}}" } }, workflows: [oneText()] });
      await h.ingest("appointment.booked", payload);
      const [row] = await h.outbox();
      expect(row).toMatchObject({ status: "held" });
      expect((row!.payload.render as { blanks: { path: string }[] }).blanks.map((b) => b.path)).toEqual(["appointment.meeting_url"]);
      expect(h.fp.effects("messaging")).toHaveLength(0);
    });
    it("passes a cancellation of the booking through the same gate as a message", async () => {
      const cancel = flow("w", [trig(), { id: "k1", type: "action@1", title: "Cancel the booking", action: "scheduling.cancel", params: { appointment: "{{appointment.id}}" } }, end()], chain("t1", "k1", "x1"));
      const h = await harness(kind, { delivery: "sandbox", workflows: [cancel] });
      await h.ingest("appointment.booked", payload);
      expect((await h.outbox())[0]).toMatchObject({ status: "suppressed", gates: [{ check: "delivery", result: "suppress" }] });
      expect(h.fp.effects("scheduling")).toHaveLength(0);
    });
    it("does not send a row whose run ended before it went", async () => {
      const h = await harness(kind, { content, workflows: [oneText()] });
      await h.engine.ingest({ offerId: h.offerId, type: "appointment.booked", source: "t", dedupeKey: "e1", contactId: "c1", appointmentId: "a1", payload: {} });
      await h.engine.end((await h.run()).id, "stopped");
      await h.due();
      expect((await h.outbox())[0]).toMatchObject({ status: "suppressed", lastError: "the run ended (stopped) before this went out" });
      expect(h.fp.effects("messaging")).toHaveLength(0);
    });
  });

  describe("a secret in an http.request", () => {
    it("is never written into the row, and is filled in at the moment of the call", async () => {
      const call = flow("w", [trig(), { id: "h1", type: "action@1", title: "Call the Zap", action: "http.request", params: { url: "https://hooks.example.com/x", method: "POST", headers: { authorization: "Bearer {{secret.zap_token}}" }, onError: "skip" } }, end()], chain("t1", "h1", "x1"));
      const h = await harness(kind, { workflows: [call] });
      (h.engine as unknown as { opts: { secret: (o: string, k: string) => Promise<string> } }).opts.secret = async (_o, k) => (k === "zap_token" ? "s3cr3t" : "");
      await h.ingest("appointment.booked", payload);
      expect(JSON.stringify((await h.outbox())[0]!.payload)).not.toContain("s3cr3t");
      expect(h.fp.effects("http")[0]!.args).toMatchObject({ headers: { authorization: "Bearer s3cr3t" } });
    });
  });
});
