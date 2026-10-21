import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db/client";
import { alerts, connections, outbox, slackMessages, slackWorkspaces } from "@/db/schema";
import { open, seal } from "@/lib/secrets";
import { SANDBOX_PREFIX } from "./blocks";
import { booked, cardContent, cardFlow, postContent, postFlow } from "./fixtures";
import { openValue } from "./signed";
import { TEST_ENV, slackBench } from "./testkit";

/**
 * The platform Slack port behind the engine's outbox and gate: a run's post reaches Slack as a platform layout with its
 * persona, signed buttons and a record in slack_messages; sandbox goes to the test channel, saying so; rate limits are
 * waited out; other failures are tried three times and then alerted; a refused token holds the offer's posts.
 */
const SETTINGS = { "slack.channel.bookings": "C-BOOK", "slack.channel.test": "C-TEST", "slack.channel.alerts": "C-ALERTS" };

describe.skipIf(!process.env.DATABASE_URL)("the Slack port", () => {
  afterAll(closeDb);
  let b: Awaited<ReturnType<typeof slackBench>>;
  const setup = async (o: Parameters<typeof slackBench>[0] = {}) => {
    b = await slackBench({ offers: [{ slug: "acme", settings: SETTINGS, content: { ...postContent, ...cardContent }, workflows: [postFlow(), cardFlow()] }], ...o });
    await b.workspace();
    await b.channel("acme", "C-BOOK", ["bookings"]);
    await b.channel("acme", "C-TEST", ["test"]);
  };
  beforeEach(() => setup());

  it("posts a run's message through the outbox as a card with its persona, and records it with its run, step, workflow and tag", async () => {
    await b.ingest("acme", "appointment.booked", booked());
    const posts = b.fake.ok("chat.postMessage");
    expect(posts).toHaveLength(2);
    const plain = posts.find((p) => String(p.body.text).startsWith("Booked"))!;
    expect(plain.token).toBe("xoxb-T1");
    expect(plain.body).toMatchObject({ channel: "C-BOOK", text: "Booked: Ana", username: "Acme Ops" });
    expect([":one:", ":two:"]).toContain(plain.body.icon_emoji);
    expect((plain.body.blocks as { type: string }[])[0]).toMatchObject({ type: "section", text: { type: "mrkdwn", text: "Booked: Ana" } });
    const rows = await db().select().from(slackMessages).orderBy(slackMessages.id);
    const card = rows.find((r) => r.node === "q1")!;
    expect(card).toMatchObject({ offerId: b.offerId, teamId: "T1", channel: "C-BOOK", kind: "workflow", tag: "card:a1", app: "platform", sandbox: false });
    expect(card.runId).toBeTruthy();
    expect(card.workflowId).toBe(b.wfs["acme/booking-card"]!.id);
    const ob = (await db().select().from(outbox).where(eq(outbox.id, card.outboxId!)))[0]!;
    expect(ob).toMatchObject({ status: "sent", kind: "slack.ask" });
  });

  it("signs each button with the offer, run, step and choice; the labels are the content's", async () => {
    await b.ingest("acme", "appointment.booked", booked());
    const card = b.fake.ok("chat.postMessage").find((p) => String(p.body.text).startsWith("New call"))!;
    const actions = (card.body.blocks as { type: string; elements?: { action_id: string; value: string; text: { text: string }; style?: string }[] }[]).find((x) => x.type === "actions")!;
    expect(actions.elements!.map((e) => [e.action_id, e.text.text, e.style])).toEqual([["ask", "Confirm", "primary"], ["ask", "Cancel", "danger"], ["ask", "Reschedule", undefined]]);
    const v = openValue(TEST_ENV.stateSecret, "button", actions.elements![0]!.value)!;
    const run = (await b.store.tx((tx) => tx.runs({ offerId: b.offerId }))).find((r) => r.workflowId === b.wfs["acme/booking-card"]!.id)!;
    expect(v).toMatchObject({ o: b.offerId, a: "ask", v: "confirm", r: run.id, s: "q1" });
    expect(openValue("another-secret", "button", actions.elements![0]!.value)).toBeNull();
  });

  it("in sandbox posts in the offer's test channel, saying so first in the words and the fallback text", async () => {
    await setup({ delivery: "sandbox" });
    await b.ingest("acme", "appointment.booked", booked());
    const plain = b.fake.ok("chat.postMessage").find((p) => String(p.body.text).includes("Booked"))!;
    expect(plain.body.channel).toBe("C-TEST");
    expect(String(plain.body.text).startsWith(`${SANDBOX_PREFIX} · Booked: Ana`)).toBe(true);
    expect(JSON.stringify((plain.body.blocks as unknown[])[0])).toContain(SANDBOX_PREFIX);
    expect((await db().select().from(slackMessages)).every((r) => r.sandbox && r.channel === "C-TEST")).toBe(true);
  });

  it("waits out a rate limit for its Retry-After and posts", async () => {
    b.fake.failNext({ method: "chat.postMessage", status: 429, retryAfter: 7 });
    await b.ingest("acme", "appointment.booked", booked());
    expect(b.slept).toContain(7000);
    expect(b.fake.ok("chat.postMessage")).toHaveLength(2);
    expect((await db().select().from(outbox)).every((r) => r.status === "sent")).toBe(true);
  });

  it("a rate limit longer than it waits is transient: the dispatcher tries again later, never sooner than Slack asked", async () => {
    await setup({ maxWaitMs: 5000 });
    b.fake.failNext({ method: "chat.postMessage", status: 429, retryAfter: 40 });
    await b.ingest("acme", "appointment.booked", booked());
    const held = (await db().select().from(outbox)).find((r) => r.status === "queued")!;
    expect(held).toMatchObject({ errorClass: "transient", attempts: 1 });
    expect(held.nextAttemptAt!.getTime() - b.clock.now().getTime()).toBeGreaterThanOrEqual(40_000);
    b.clock.advance("10m");
    await b.drain();
    expect((await db().select().from(outbox)).every((r) => r.status === "sent")).toBe(true);
  });

  it("Slack's own trouble is tried three times in all, then the row fails with an alert: never dropped silently", async () => {
    b.fake.failNext({ method: "chat.postMessage", status: 503, times: 6 });
    await b.ingest("acme", "appointment.booked", booked());
    b.clock.advance("2m"); await b.drain();
    b.clock.advance("6m"); await b.drain();
    const rows = await db().select().from(outbox);
    expect(rows.map((r) => [r.status, r.attempts])).toEqual([["failed", 3], ["failed", 3]]);
    const open = await db().select().from(alerts);
    expect(open.filter((a) => a.kind === "outbox_failed")).toHaveLength(2);
    expect(open[0]!.message).toMatch(/after 3 tries/);
  });

  it("a channel Slack refuses fails at once (permanent) with an alert", async () => {
    b.fake.failNext({ method: "chat.postMessage", error: "channel_not_found" });
    await b.ingest("acme", "appointment.booked", booked());
    const failed = (await db().select().from(outbox)).filter((r) => r.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ errorClass: "permanent", attempts: 1 });
    // the row's own alert, and the run held on the step by its failure rule
    expect((await db().select().from(alerts)).map((a) => a.kind).sort()).toEqual(["outbox_failed", "run_held"]);
  });

  it("a token Slack refuses pauses the offer's Slack: its posts wait, with one alert, and go once it is fixed", async () => {
    b.fake.failNext({ method: "chat.postMessage", error: "invalid_auth" });
    await b.ingest("acme", "appointment.booked", booked());
    expect((await db().select().from(connections))[0]).toMatchObject({ port: "slack", status: "paused" });
    expect((await db().select().from(outbox)).map((r) => r.status).sort()).toEqual(["queued", "queued"]);
    expect((await db().select().from(alerts)).map((a) => a.kind)).toEqual(["connection_auth"]);
    const { resumeConnection } = await import("@/engine/dispatcher");
    await resumeConnection(b.store, b.offerId, "slack", b.clock.now());
    await b.drain();
    expect((await db().select().from(outbox)).map((r) => r.status)).toEqual(["sent", "sent"]);
  });

  it("a network failure after the request may have reached Slack is unknown: never sent again", async () => {
    b.fake.failNext({ method: "chat.postMessage", network: "after" });
    await b.ingest("acme", "appointment.booked", booked());
    const rows = await db().select().from(outbox);
    expect(rows.filter((r) => r.status === "unknown")).toHaveLength(1);
    b.clock.advance("1h"); await b.drain();
    expect(b.fake.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(2);
    expect((await db().select().from(alerts)).map((a) => a.kind).sort()).toEqual(["outbox_unknown", "run_held"]);
  });

  it("a network failure before anything reached Slack is tried again", async () => {
    b.fake.failNext({ method: "chat.postMessage", network: "before" });
    await b.ingest("acme", "appointment.booked", booked());
    b.clock.advance("2m"); await b.drain();
    expect((await db().select().from(outbox)).map((r) => r.status)).toEqual(["sent", "sent"]);
  });

  it("refreshes a rotating bot token about to expire, and keeps the new one sealed", async () => {
    await db().update(slackWorkspaces).set({ refreshTokenEnc: seal("xoxe-1-old"), tokenExpiresAt: new Date(b.clock.now().getTime() + 60_000) });
    await b.ingest("acme", "appointment.booked", booked());
    const refresh = b.fake.ok("oauth.v2.access");
    expect(refresh).toHaveLength(1);
    expect(refresh[0]!.body).toMatchObject({ grant_type: "refresh_token", refresh_token: "xoxe-1-old", client_id: TEST_ENV.clientId });
    expect(b.fake.ok("chat.postMessage").every((c) => c.token === "xoxe.xoxb-refreshed")).toBe(true);
    const ws = (await db().select().from(slackWorkspaces))[0]!;
    expect(open(ws.botTokenEnc)).toBe("xoxe.xoxb-refreshed");
    expect(ws.botTokenEnc).not.toContain("xoxe");
    expect(ws.tokenExpiresAt!.getTime()).toBeGreaterThan(b.clock.now().getTime() + 3_600_000);
  });

  it("an offer with no Slack installed holds its posts (auth), never drops them", async () => {
    await db().delete((await import("@/db/schema")).slackChannels);
    await db().delete((await import("@/db/schema")).slackOfferLinks);
    await b.ingest("acme", "appointment.booked", booked());
    expect(b.fake.ok("chat.postMessage")).toHaveLength(0);
    expect((await db().select().from(outbox)).every((r) => r.status === "queued")).toBe(true);
    expect((await db().select().from(alerts))[0]!.message).toMatch(/not connected/);
  });

  it("react and unreact are idempotent: an emoji already there, or already gone, is not a failure", async () => {
    await b.ingest("acme", "appointment.booked", booked());
    const card = b.fake.ok("chat.postMessage")[0]!;
    const ts = b.fake.messages.size ? [...b.fake.messages.values()][0]!.ts : "";
    const c = { offerId: b.offerId, idempotencyKey: "k-react" };
    await b.app.port.react(c, { channel: String(card.body.channel), ts, emojis: ["white_check_mark"] });
    await b.app.port.react(c, { channel: String(card.body.channel), ts, emojis: [":white_check_mark:"] });
    await b.app.port.unreact(c, { channel: String(card.body.channel), ts, emojis: ["white_check_mark"] });
    await b.app.port.unreact(c, { channel: String(card.body.channel), ts, emojis: ["white_check_mark"] });
    expect(b.fake.message(String(card.body.channel), ts)!.reactions).toEqual([]);
  });
});
