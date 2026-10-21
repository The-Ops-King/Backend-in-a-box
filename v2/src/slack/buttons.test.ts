import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db/client";
import { alerts, slackAlertState, slackAudit, slackMessages } from "@/db/schema";
import { booked, cardContent, cardFlow, reactContent, reactFlow, unlinkedContent, unlinkedFlow } from "./fixtures";
import { raiseAlert } from "./outbox";
import { announceAlerts } from "./alerts";
import { signValue } from "./signed";
import { type Bench, TEST_ENV, slackBench } from "./testkit";

/**
 * Presses: Confirm / Cancel / Reschedule answer the run's waiting ask; Retry / Resolve / Pause act on an alert; Link
 * opens a contact search and links. Each press is acked, then the message is edited to say who pressed what and when,
 * its buttons gone; a stale press is told who handled it; who may press is their role on that offer.
 */
const SETTINGS = { "slack.channel.bookings": "C-BOOK", "slack.channel.calls": "C-CALLS", "slack.channel.payments": "C-PAY", "slack.channel.alerts": "C-ALERTS" };
const CONTENT = { ...cardContent, ...reactContent, ...unlinkedContent };

describe.skipIf(!process.env.DATABASE_URL)("buttons and the ask step", () => {
  afterAll(closeDb);
  let b: Bench;
  beforeEach(async () => {
    b = await slackBench({ offers: [{ slug: "acme", settings: SETTINGS, content: CONTENT, workflows: [cardFlow(), reactFlow(), unlinkedFlow()] }, { slug: "pmu" }] });
    await b.workspace();
    for (const [ch, slot] of [["C-BOOK", "bookings"], ["C-CALLS", "calls"], ["C-PAY", "payments"], ["C-ALERTS", "alerts"]] as const) await b.channel("acme", ch, [slot]);
    await b.person("acme", { id: "carly", name: "Carly Closer", roles: ["closer"], slack: "U-CARLY" });
    await b.person("acme", { id: "mitch", name: "Mitch Setter", roles: ["setter"], slack: "U-MITCH" });
    await b.person("acme", { id: "mona", name: "Mona Manager", roles: ["manager"], slack: "U-MONA" });
    await b.person("acme", { id: "vic", name: "Vic Viewer", roles: ["viewer"], slack: "U-VIC" });
    await b.person("pmu", { id: "pam", name: "Pam Owner", roles: ["owner"], slack: "U-PAM" });
  });
  const cardPost = () => [...b.fake.messages.values()].find((m) => m.text.startsWith("New call"))!;
  const run = async () => (await b.store.tx((tx) => tx.runs({ offerId: b.offerId }))).find((r) => r.workflowId === b.wfs["acme/booking-card"]!.id)!;

  it("Confirm answers the waiting ask: acked at once, the run goes on that branch, the card says who and when with its buttons gone", async () => {
    await b.ingest("acme", "appointment.booked", booked());
    const card = cardPost();
    const r = await b.press({ user: "U-CARLY", channel: card.channel, ts: card.ts, label: "Confirm" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
    await b.drain();
    expect(await run()).toMatchObject({ status: "completed" });
    expect((await run()).context.vars.decision).toMatchObject({ value: "confirm", person: "carly" });
    const thread = [...b.fake.messages.values()].find((m) => m.threadTs === card.ts)!;
    expect(thread.text).toBe("Confirmed by carly");
    const edited = b.fake.message(card.channel, card.ts)!;
    expect((edited.blocks as { type: string }[]).some((x) => x.type === "actions")).toBe(false);
    expect(JSON.stringify(edited.blocks)).toMatch(/\*Confirm\* · pressed by <@U-CARLY> · Oct 26, 10:00 AM/);
    expect(edited.text).toBe("New call: Ana");
    expect((await db().select().from(slackMessages).where(eq(slackMessages.ts, card.ts)))[0]!.settled).toMatchObject({ user: "U-CARLY", value: "confirm", label: "Confirm" });
  });

  it("Cancel and Reschedule take the other branch", async () => {
    await b.ingest("acme", "appointment.booked", booked());
    await b.press({ user: "U-MITCH", channel: cardPost().channel, ts: cardPost().ts, label: "Reschedule" });
    await b.drain();
    expect((await run()).context.vars.decision).toMatchObject({ value: "reschedule", person: "mitch" });
    expect([...b.fake.messages.values()].some((m) => m.text === "Not confirmed: reschedule")).toBe(true);
  });

  it("a second press, on an answered card, is told privately who handled it, and changes nothing", async () => {
    await b.ingest("acme", "appointment.booked", booked());
    const card = cardPost();
    const old = { text: card.text, blocks: card.blocks };
    await b.press({ user: "U-CARLY", channel: card.channel, ts: card.ts, label: "Confirm" });
    // a press from the copy Slack showed before the edit
    b.fake.messages.set(`${card.channel}:${card.ts}`, { ...card, ...old });
    await b.press({ user: "U-MONA", channel: card.channel, ts: card.ts, label: "Cancel" });
    await b.drain();
    expect(b.privately()).toEqual(["Already handled by <@U-CARLY> (Confirm)."]);
    expect((await b.store.tx((tx) => tx.events({ offerId: b.offerId, types: ["ask.answered"] })))).toHaveLength(1);
    expect((await run()).context.vars.decision).toMatchObject({ value: "confirm" });
  });

  it("two presses at the same moment: one answer, the other told", async () => {
    await b.ingest("acme", "appointment.booked", booked());
    const card = cardPost();
    await b.press({ user: "U-CARLY", channel: card.channel, ts: card.ts, label: "Confirm" });
    await b.press({ user: "U-MITCH", channel: card.channel, ts: card.ts, label: "Cancel" });
    const jobs = b.queue.splice(0);
    const { runSlackJob } = await import("./http");
    await Promise.all(jobs.map((j) => runSlackJob(b.app, j.task, j.payload)));
    await b.drain();
    expect(await b.store.tx((tx) => tx.events({ offerId: b.offerId, types: ["ask.answered"] }))).toHaveLength(1);
    expect(b.privately()).toHaveLength(1);
    expect(b.privately()[0]).toMatch(/^Already handled by <@U-/);
  });

  it("someone whose role may not answer is refused privately, the refusal recorded, the card untouched", async () => {
    await b.ingest("acme", "appointment.booked", booked());
    const card = cardPost();
    await b.press({ user: "U-VIC", channel: card.channel, ts: card.ts, label: "Confirm" });
    await b.press({ user: "U-STRANGER", channel: card.channel, ts: card.ts, label: "Confirm" });
    await b.press({ user: "U-PAM", channel: card.channel, ts: card.ts, label: "Confirm" });   // an owner, but of another offer
    await b.drain();
    expect(b.privately()).toEqual(Array(3).fill("Only a closer, setter, manager or owner can do that."));
    expect((await db().select().from(slackAudit)).filter((a) => a.action === "slack.refused").map((a) => a.userId)).toEqual(["U-VIC", "U-STRANGER", "U-PAM"]);
    expect((await run()).status).toBe("waiting");
    expect((b.fake.message(card.channel, card.ts)!.blocks as { type: string }[]).some((x) => x.type === "actions")).toBe(true);
  });

  it("a press whose value is not ours, or names another run or offer, is refused; the offer never comes from free text", async () => {
    await b.ingest("acme", "appointment.booked", booked());
    const card = cardPost();
    const r = await run();
    await b.press({ user: "U-CARLY", channel: card.channel, ts: card.ts, value: "forged.value" });
    await b.press({ user: "U-CARLY", channel: card.channel, ts: card.ts, value: signValue("other-secret", "button", { o: b.offerId, a: "ask", v: "confirm", r: r.id, s: "q1" }) });
    await b.press({ user: "U-CARLY", channel: card.channel, ts: card.ts, value: signValue(TEST_ENV.stateSecret, "button", { o: b.offers.pmu, a: "ask", v: "confirm", r: r.id, s: "q1" }) });
    await b.press({ user: "U-CARLY", channel: card.channel, ts: card.ts, value: signValue(TEST_ENV.stateSecret, "button", { o: b.offerId, a: "ask", v: "confirm", r: r.id, s: "p_ok" }) });
    await b.drain();
    expect(b.privately()).toEqual(["That button isn't one of mine, or it has expired.", "That button isn't one of mine, or it has expired.", "I can't find the question this button belongs to.", "I can't find the question this button belongs to."]);
    expect((await run()).status).toBe("waiting");
  });

  it("a press after the question closed (the run ended) is told so, and the card is settled as closed", async () => {
    await b.ingest("acme", "appointment.booked", booked());
    const card = cardPost();
    await b.engine.end((await run()).id, "cancelled");
    await b.press({ user: "U-CARLY", channel: card.channel, ts: card.ts, label: "Confirm" });
    await b.drain();
    expect(b.privately()).toEqual(["Already handled by the workflow (it closed)."]);
    expect(JSON.stringify(b.fake.message(card.channel, card.ts)!.blocks)).toContain("This question closed before it was answered.");
  });

  it("a reaction answers a question that takes reactions, from someone who may; another reaction or person changes nothing", async () => {
    await b.ingest("acme", "appointment.booked", booked());
    const q = [...b.fake.messages.values()].find((m) => m.text.startsWith("Did Ana"))!;
    await b.event({ type: "reaction_added", user: "U-VIC", reaction: "white_check_mark", item: { type: "message", channel: q.channel, ts: q.ts } });
    await b.event({ type: "reaction_added", user: "UBOT", reaction: "x", item: { type: "message", channel: q.channel, ts: q.ts } });
    await b.event({ type: "reaction_added", user: "U-MITCH", reaction: "tada", item: { type: "message", channel: q.channel, ts: q.ts } });
    await b.event({ type: "reaction_added", user: "U-MITCH", reaction: "white_check_mark::skin-tone-3", item: { type: "message", channel: q.channel, ts: q.ts } });
    await b.event({ type: "reaction_added", user: "U-CARLY", reaction: "x", item: { type: "message", channel: q.channel, ts: q.ts } });
    await b.drain();
    expect(b.results).toEqual(["refused", "own reaction", "not an answer", "answered", "already answered"]);
    expect([...b.fake.messages.values()].some((m) => m.text === "Answer: white_check_mark")).toBe(true);
  });

  describe("on an alert", () => {
    const alertPost = () => [...b.fake.messages.values()].find((m) => m.channel === "C-ALERTS" && !m.threadTs)!;
    const raise = async () => {
      const a = await raiseAlert(db(), { offerId: b.offerId, key: "auth:crm", kind: "connection_auth", message: "The crm connection refused its token", at: b.clock.now() });
      await db().insert((await import("@/db/schema")).connections).values({ offerId: b.offerId, port: "crm", status: "paused_auth", reason: "x", pausedAt: b.clock.now() });
      await announceAlerts(b.app); await b.drain();
      return a.id;
    };

    it("Resolve (a manager) closes it, edits the post, and the ✅ follows in its thread", async () => {
      const id = await raise();
      const p = alertPost();
      expect((p.blocks as { type: string; elements?: { action_id: string }[] }[]).find((x) => x.type === "actions")!.elements!.map((e) => e.action_id)).toEqual(["alert_retry", "alert_resolve", "alert_pause"]);
      await b.press({ user: "U-MONA", channel: p.channel, ts: p.ts, label: "Resolve" });
      await b.drain();
      expect((await db().select().from(alerts).where(eq(alerts.id, id)))[0]!.resolvedAt).not.toBeNull();
      expect(JSON.stringify(b.fake.message(p.channel, p.ts)!.blocks)).toContain("✅ Resolved by <@U-MONA>");
      await announceAlerts(b.app); await b.drain();
      expect([...b.fake.messages.values()].find((m) => m.threadTs === p.ts)!.text).toMatch(/^✅ Resolved/);
      expect(b.fake.message(p.channel, p.ts)!.reactions).toEqual(["white_check_mark"]);
      await b.press({ user: "U-MONA", channel: p.channel, ts: p.ts, label: "Pause", value: signValue(TEST_ENV.stateSecret, "button", { o: b.offerId, a: "alert_pause", v: String(id) }), actionId: "alert_pause" });
      await b.drain();
      expect(b.privately()).toEqual(["Already handled: this alert was resolved."]);
    });

    it("Pause stops its repeats while it stays open; a second Pause is told who paused it", async () => {
      const id = await raise();
      const p = alertPost();
      await b.press({ user: "U-MONA", channel: p.channel, ts: p.ts, label: "Pause" });
      await b.drain();
      expect((await db().select().from(slackAlertState))[0]).toMatchObject({ alertId: id, pausedBy: "<@U-MONA>" });
      b.clock.advance("3h"); await announceAlerts(b.app); await b.drain();
      expect([...b.fake.messages.values()].filter((m) => m.threadTs === p.ts)).toHaveLength(0);
      await b.press({ user: "U-MONA", channel: p.channel, ts: p.ts, value: signValue(TEST_ENV.stateSecret, "button", { o: b.offerId, a: "alert_pause", v: String(id) }), actionId: "alert_pause", label: "Pause" });
      await b.drain();
      expect(b.privately()).toEqual(["Already handled: paused by <@U-MONA>."]);
    });

    it("Retry with no single step to retry says so; a closer may not press", async () => {
      await raise();
      const p = alertPost();
      await b.press({ user: "U-CARLY", channel: p.channel, ts: p.ts, label: "Resolve" });
      await b.press({ user: "U-MONA", channel: p.channel, ts: p.ts, label: "Retry" });
      await b.drain();
      expect(b.privately()).toEqual(["Only a manager, an owner or the operator can do that.", "This alert has no single step to retry. Fix the cause, then press Resolve."]);
    });

    it("the operator may press on any offer's alert", async () => {
      await raise();
      await b.operator("U-TYLER");
      const p = alertPost();
      await b.press({ user: "U-TYLER", channel: p.channel, ts: p.ts, label: "Resolve" });
      await b.drain();
      expect(JSON.stringify(b.fake.message(p.channel, p.ts)!.blocks)).toContain("Resolved by <@U-TYLER>");
    });
  });

  describe("Link (an unlinked payment)", () => {
    const linkPost = async () => {
      await b.ingest("acme", "payment.unlinked", { contact: null, payload: { payment_id: "pay-9", amount: 500, payment: { id: "pay-9", amount: 500, paid_at: "2026-10-26T15:00:00Z", customer: { email: "who@example.com" } } } });
      return [...b.fake.messages.values()].find((m) => m.channel === "C-PAY")!;
    };
    const contacts = async () => {
      await b.ingest("acme", "lead.created", { contact: "c-rae", payload: { contact: { name: "Rae Smith", email: "rae@example.com", phone: "+1 555 010 2000" } } });
      await b.ingest("acme", "lead.created", { contact: "c-ray", payload: { contact: { name: "Ray Jones", email: "ray@example.com" } } });
      await b.ingest("pmu", "lead.created", { contact: "c-other", payload: { contact: { name: "Rae Elsewhere", email: "rae2@example.com" } } });
    };

    it("opens the contact-search modal at once, its offer and payment signed into the metadata", async () => {
      const p = await linkPost();
      const r = await b.press({ user: "U-MONA", channel: p.channel, ts: p.ts, label: "Link to a contact", trigger: "trig-link" });
      expect(r.status).toBe(200);
      const opened = b.fake.ok("views.open")[0]!;
      expect(opened.body.trigger_id).toBe("trig-link");
      const view = opened.body.view as { callback_id: string; private_metadata: string; blocks: { element?: { type: string } }[] };
      expect(view.callback_id).toBe("link_contact");
      expect(view.blocks.find((x) => x.element)!.element!.type).toBe("external_select");
      const { openValue } = await import("./signed");
      expect(openValue(TEST_ENV.stateSecret, "modal", view.private_metadata, b.clock.now())).toMatchObject({ o: b.offerId, k: "payment", id: "pay-9", ch: "C-PAY", ts: p.ts });
      expect(b.queue.filter((j) => j.task === "slack_inbox")).toHaveLength(0);
    });

    it("the search reads the offer's own contacts by name, email or phone, for someone who may link", async () => {
      await contacts();
      const p = await linkPost();
      await b.press({ user: "U-MONA", channel: p.channel, ts: p.ts, label: "Link to a contact" });
      const meta = (b.fake.ok("views.open")[0]!.body.view as { private_metadata: string }).private_metadata;
      const options = async (user: string, value: string) => ((await (await b.send("options", new URLSearchParams({ payload: JSON.stringify({ type: "block_suggestion", team: { id: "T1" }, user: { id: user }, action_id: "contact", value, view: { private_metadata: meta } }) }).toString())).json()) as { options: { value: string; text: { text: string } }[] }).options;
      expect((await options("U-MONA", "ra")).map((o) => o.value).sort()).toEqual(["c-rae", "c-ray"]);
      expect((await options("U-MONA", "ra"))[0]!.text.text).toBe("Rae Smith · rae@example.com");
      expect((await options("U-MONA", "5550102")).map((o) => o.value)).toEqual(["c-rae"]);
      expect((await options("U-MONA", "rae2@")).map((o) => o.value)).toEqual([]);
      expect(await options("U-CARLY", "ra")).toEqual([]);
      expect(await options("U-MONA", "r")).toEqual([]);
    });
    it("the submission is checked at once (an error goes back into the form), then linked by a fact that says who, with a ✅ in the thread", async () => {
      await contacts();
      const p = await linkPost();
      await b.press({ user: "U-MONA", channel: p.channel, ts: p.ts, label: "Link to a contact" });
      const meta = (b.fake.ok("views.open")[0]!.body.view as { private_metadata: string }).private_metadata;
      const submit = (user: string, contact: string | null) => b.interaction({ type: "view_submission", team: { id: "T1" }, user: { id: user }, view: { id: `V-${user}-${contact}`, hash: "h", callback_id: "link_contact", private_metadata: meta, state: { values: { who: { contact: { type: "external_select", selected_option: contact ? { value: contact } : null } } } } } });
      expect(await (await submit("U-MONA", null)).json()).toEqual({ response_action: "errors", errors: { who: "Pick a contact from the list." } });
      expect(await (await submit("U-MONA", "c-other")).json()).toEqual({ response_action: "errors", errors: { who: "Pick a contact from the list." } });
      expect(await (await submit("U-CARLY", "c-rae")).json()).toEqual({ response_action: "errors", errors: { who: "Only a manager, an owner or the operator can do that." } });
      const ok = await submit("U-MONA", "c-rae");
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("");
      await b.drain();
      const fact = (await b.store.tx((tx) => tx.events({ offerId: b.offerId, types: ["payment.linked"] })))[0]!;
      expect(fact).toMatchObject({ contactId: "c-rae", source: "slack", payload: { payment_id: "pay-9", by: "mona", by_slack_user: "U-MONA" } });
      expect((await b.store.tx((tx) => tx.projGet("payments", b.offerId, "pay-9")))).toMatchObject({ contactId: "c-rae", linkedBy: "mona" });
      expect([...b.fake.messages.values()].find((m) => m.threadTs === p.ts)!.text).toBe("✅ Linked to Rae Smith by <@U-MONA>.");
      expect(b.fake.message(p.channel, p.ts)!.reactions).toEqual(["white_check_mark"]);
      const edited = b.fake.message(p.channel, p.ts)!;
      expect((edited.blocks as { type: string }[]).some((x) => x.type === "actions")).toBe(false);
      expect(JSON.stringify(edited.blocks)).toContain("A payment of 500 matched nobody");
    });

    it("a closer pressing Link is refused privately (no modal)", async () => {
      const p = await linkPost();
      await b.press({ user: "U-CARLY", channel: p.channel, ts: p.ts, label: "Link to a contact" });
      await b.drain();
      expect(b.fake.ok("views.open")).toHaveLength(0);
      expect(b.privately()).toEqual(["Only a manager, an owner or the operator can do that."]);
    });
  });
});
