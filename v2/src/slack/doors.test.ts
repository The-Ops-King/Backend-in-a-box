import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db/client";
import { alerts, connections, inbox, outbox, slackAudit, slackChannels, slackOfferLinks, slackOutbox, slackWorkspaces } from "@/db/schema";
import { mapChannel } from "./data";
import { open } from "@/lib/secrets";
import { BOT_SCOPES } from "./env";
import { booked, postContent, postFlow } from "./fixtures";
import { slackDoor } from "./http";
import { completeInstall, installLink, installRedirect } from "./oauth";
import { signRequest } from "./signature";
import { signValue } from "./signed";
import { type Bench, TEST_ENV, slackBench } from "./testkit";

/**
 * The doors: every request is checked with Slack's signature and five-minute window before it is read, kept once in the
 * inbox, acked at once and worked as a job; Slack's retries are acked and dropped. And the install: the signed state,
 * the code exchange, the workspace kept with its token sealed, reused for a second offer; uninstall holds its posts.
 */
const SETTINGS = { "slack.channel.bookings": "C-BOOK" };

describe.skipIf(!process.env.DATABASE_URL)("the Slack doors", () => {
  afterAll(closeDb);
  let b: Bench;
  beforeEach(async () => {
    b = await slackBench({ offers: [{ slug: "acme", settings: SETTINGS, content: postContent, workflows: [postFlow()] }, { slug: "pmu", settings: { "slack.channel.bookings": "C-PMU" } }] });
    await b.workspace();
    await b.channel("acme", "C-BOOK", ["bookings"]);
  });
  const slackRows = () => db().select().from(inbox).where(eq(inbox.source, "slack"));

  it("refuses a request whose signature is wrong, stale or missing, before reading it, and logs no body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "Ev-secret-body", event: { type: "app_mention" } });
    for (const h of [{ "x-slack-signature": "v0=00" }, { "x-slack-request-timestamp": String(Math.floor(b.clock.now().getTime() / 1000) - 301) }, { "x-slack-signature": "" }] as Record<string, string>[]) {
      const r = await b.send("events", body, h);
      expect(r.status).toBe(401);
    }
    const stale = String(Math.floor(b.clock.now().getTime() / 1000) - 400);
    const replay = await slackDoor(b.app, "events", new Request("https://x/slack/events", { method: "POST", headers: { "x-slack-request-timestamp": stale, "x-slack-signature": signRequest(TEST_ENV.signingSecret, stale, body) }, body }));
    expect(replay.status).toBe(401);
    expect(await slackRows()).toHaveLength(0);
    expect(b.queue).toHaveLength(0);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("Ev-secret-body");
    warn.mockRestore();
  });

  it("answers Slack's URL check with its challenge", async () => {
    const r = await b.send("events", JSON.stringify({ type: "url_verification", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" }));
    expect(await r.json()).toEqual({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
  });

  it("keeps an event once by its event_id, acks at once, and works it as a job", async () => {
    const event = { type: "channel_rename", channel: { id: "C-BOOK", name: "acme-bookings" } };
    const first = await b.event(event, { eventId: "Ev01" });
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("");
    expect(b.queue.map((j) => j.task)).toEqual(["slack_inbox"]);
    const again = await b.event(event, { eventId: "Ev01" });
    expect(again.status).toBe(200);
    expect(await slackRows()).toHaveLength(1);
    expect(b.queue).toHaveLength(1);
    await b.drain();
    expect(b.results).toEqual(["renamed"]);
  });

  it("acks a retry Slack marks with X-Slack-Retry-Num and drops it", async () => {
    const r = await b.event({ type: "channel_rename", channel: { id: "C-BOOK", name: "x" } }, { eventId: "Ev02" });
    expect(r.status).toBe(200);
    const body = JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "Ev03", event: { type: "channel_rename", channel: { id: "C-BOOK", name: "y" } } });
    const retry = await b.send("events", body, { "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" });
    expect(retry.status).toBe(200);
    expect((await slackRows()).map((x) => x.deliveryId)).toEqual(["event:Ev02"]);
  });

  it("keeps a slash command once by its trigger id, and a press once by its action", async () => {
    const form = new URLSearchParams({ team_id: "T1", user_id: "U1", command: "/help", text: "", channel_id: "C-BOOK", response_url: "https://hooks.slack.com/commands/1", trigger_id: "trig-1" }).toString();
    await b.send("commands", form);
    await b.send("commands", form);
    const press = new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C-BOOK" }, container: { channel_id: "C-BOOK", message_ts: "1.1" }, trigger_id: "t2", actions: [{ action_id: "alert_resolve", value: "x", action_ts: "1700.1" }] }) }).toString();
    await b.send("interactions", press);
    await b.send("interactions", press);
    expect((await slackRows()).map((x) => x.deliveryId)).toEqual(["command:T1:trig-1", "action:T1:U1:1700.1:alert_resolve"]);
    expect(b.queue).toHaveLength(2);
  });

  it("is quick: the request does no Slack call and no engine work for an event, only the record and the job", async () => {
    const t0 = Date.now();
    await b.event({ type: "app_mention", channel: "C-BOOK", user: "U1", text: "<@UBOT> hi", ts: "1.2" });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(b.fake.calls).toHaveLength(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("channel events", () => {
  afterAll(closeDb);
  let b: Bench;
  beforeEach(async () => {
    b = await slackBench({ offers: [{ slug: "acme", settings: { "slack.channel.bookings": "C-BOOK" } }] });
    await b.workspace();
    await mapChannel(db(), { teamId: "T1", channelId: "C-BOOK", offerId: b.offerId, slots: ["bookings"], name: "bookings", isPrivate: true, botMember: false, by: "test", now: b.clock.now() });
  });
  const row = async () => (await db().select().from(slackChannels))[0]!;

  it("the bot joining a mapped channel marks it a member; someone else joining changes nothing", async () => {
    await b.event({ type: "member_joined_channel", channel: "C-BOOK", user: "U-SOMEONE" });
    await b.drain();
    expect((await row()).botMember).toBe(false);
    await b.event({ type: "member_joined_channel", channel: "C-BOOK", user: "UBOT" });
    await b.event({ type: "member_joined_channel", channel: "C-ELSE", user: "UBOT" });
    await b.drain();
    expect((await row()).botMember).toBe(true);
    expect(b.results).toEqual(["someone else joined", "bot member", "unmapped channel"]);
  });

  it("an archived channel is a broken slot: an alert on its offer, which closes once the slot is given a channel again", async () => {
    await b.event({ type: "channel_archive", channel: "C-BOOK", user: "U1" });
    await b.drain();
    const a = (await db().select().from(alerts))[0]!;
    expect(a).toMatchObject({ offerId: b.offerId, kind: "slack_channel_archived" });
    expect(a.message).toMatch(/#bookings \(bookings\) was archived/);
    expect((await row()).archivedAt).not.toBeNull();
    const { CAUSE_CHECKS } = await import("./alerts");
    expect(await CAUSE_CHECKS.slack_channel_archived!(b.app, a as never)).toBe("open");
    await mapChannel(db(), { teamId: "T1", channelId: "C-BOOK", offerId: b.offerId, slots: ["bookings"], by: "test", now: b.clock.now() });
    expect(await CAUSE_CHECKS.slack_channel_archived!(b.app, a as never)).toBe("fixed");
  });

  it("a channel belongs to one offer: mapping it to a second is refused", async () => {
    const other = await (await import("@/engine/testkit")).setupOffer(b.store, { slug: "pmu", zone: "America/Denver" });
    await db().insert(slackOfferLinks).values({ offerId: other, teamId: "T1", linkedAt: b.clock.now() });
    await expect(mapChannel(db(), { teamId: "T1", channelId: "C-BOOK", offerId: other, slots: ["bookings"], by: "test", now: b.clock.now() })).rejects.toThrow(/belongs to another offer/);
    await expect(mapChannel(db(), { teamId: "T1", channelId: "C-X", offerId: b.offerId, slots: ["lunch"], by: "test", now: b.clock.now() })).rejects.toThrow(/not a Slack slot/);
    const { settings } = await import("@/db/schema");
    expect((await db().select().from(settings)).find((s) => s.key === "slack.channel.bookings")!.value).toBe("C-BOOK");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("installing the app (Add to Slack)", () => {
  afterAll(closeDb);
  let b: Bench;
  beforeEach(async () => { b = await slackBench({ offers: [{ slug: "acme", settings: SETTINGS, content: postContent, workflows: [postFlow()] }, { slug: "pmu" }] }); });
  const stateFrom = (link: string) => new URL(link).searchParams.get("offer")!;

  it("the Connect Slack link goes to Slack's authorize page with the spec's scopes, the fixed redirect and the signed state", () => {
    const link = installLink(TEST_ENV, b.offerId, b.clock.now());
    expect(link.startsWith("https://biab.test/slack/install?offer=")).toBe(true);
    const r = installRedirect(TEST_ENV, new URL(link), b.clock.now());
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(to.searchParams.get("client_id")).toBe(TEST_ENV.clientId);
    expect(to.searchParams.get("scope")!.split(",")).toEqual([...BOT_SCOPES]);
    expect(to.searchParams.get("redirect_uri")).toBe("https://biab.test/slack/oauth/callback");
    expect(to.searchParams.get("state")).toBe(stateFrom(link));
  });

  it("refuses a link that is not ours or has expired", () => {
    expect(installRedirect(TEST_ENV, new URL("https://biab.test/slack/install?offer=forged.value"), b.clock.now()).status).toBe(400);
    const link = installLink(TEST_ENV, b.offerId, b.clock.now());
    expect(installRedirect(TEST_ENV, new URL(link), new Date(b.clock.now().getTime() + 2 * 3600_000)).status).toBe(400);
  });

  it("exchanges the code, keeps the workspace with its tokens sealed, and links the offer", async () => {
    const r = await completeInstall(b.app, { code: "code-1", state: stateFrom(installLink(TEST_ENV, b.offerId, b.clock.now())) });
    expect(r).toMatchObject({ teamId: "T1", teamName: "Acme", offerId: b.offerId, reused: false });
    const ex = b.fake.ok("oauth.v2.access")[0]!;
    expect(ex.body).toEqual({ client_id: TEST_ENV.clientId, client_secret: TEST_ENV.clientSecret, code: "code-1", redirect_uri: "https://biab.test/slack/oauth/callback" });
    const ws = (await db().select().from(slackWorkspaces))[0]!;
    expect(ws).toMatchObject({ teamId: "T1", botUserId: "UBOT", appId: "A1", installedBy: "UADMIN", revokedAt: null });
    expect(ws.botTokenEnc).not.toContain("xoxb");
    expect(open(ws.botTokenEnc)).toBe("xoxe.xoxb-1");
    expect(open(ws.refreshTokenEnc!)).toBe("xoxe-1-r");
    expect(ws.tokenExpiresAt!.getTime()).toBe(b.clock.now().getTime() + 43200_000);
    expect(await db().select().from(slackOfferLinks)).toMatchObject([{ offerId: b.offerId, teamId: "T1" }]);
    expect((await db().select().from(slackAudit)).map((a) => a.action)).toEqual(["slack.installed"]);
  });

  it("installing the same workspace for a second offer reuses its row and only links that offer", async () => {
    await completeInstall(b.app, { code: "c1", state: stateFrom(installLink(TEST_ENV, b.offers.acme!, b.clock.now())) });
    const r = await completeInstall(b.app, { code: "c2", state: stateFrom(installLink(TEST_ENV, b.offers.pmu!, b.clock.now())) });
    expect(r.reused).toBe(true);
    expect(await db().select().from(slackWorkspaces)).toHaveLength(1);
    expect((await db().select().from(slackOfferLinks)).map((l) => [l.offerId, l.teamId]).sort()).toEqual([[b.offers.acme, "T1"], [b.offers.pmu, "T1"]].sort());
  });

  it("refuses a state used once already, a forged one, Slack's error, and a code Slack refuses", async () => {
    const state = stateFrom(installLink(TEST_ENV, b.offerId, b.clock.now()));
    await completeInstall(b.app, { code: "c1", state });
    await expect(completeInstall(b.app, { code: "c1", state })).rejects.toThrow(/already used/);
    await expect(completeInstall(b.app, { code: "c1", state: signValue("not-ours", "install", { o: b.offerId, n: "x" }) })).rejects.toThrow(/not valid/);
    await expect(completeInstall(b.app, { code: "c1", state: signValue(TEST_ENV.stateSecret, "button", { o: b.offerId, n: "y" }) })).rejects.toThrow(/not valid/);
    await expect(completeInstall(b.app, { code: null, state: null, error: "access_denied" })).rejects.toThrow(/access_denied/);
    b.fake.failNext({ method: "oauth.v2.access", error: "invalid_code" });
    await expect(completeInstall(b.app, { code: "bad", state: stateFrom(installLink(TEST_ENV, b.offerId, b.clock.now())) })).rejects.toThrow(/invalid_code/);
  });

  it("an uninstall revokes the workspace, holds its posts in the outbox and tells the operator; installing again lets them go", async () => {
    await completeInstall(b.app, { code: "c1", state: stateFrom(installLink(TEST_ENV, b.offerId, b.clock.now())) });
    await b.channel("acme", "C-BOOK", ["bookings"]);
    await b.event({ type: "app_uninstalled" });
    await b.drain();
    expect((await db().select().from(slackWorkspaces))[0]!.revokedAt).not.toBeNull();
    expect((await db().select().from(connections)).filter((c) => c.offerId === b.offerId)).toMatchObject([{ port: "slack", status: "paused_auth" }]);
    const operatorAlert = (await db().select().from(alerts)).find((a) => a.kind === "slack_revoked")!;
    expect(operatorAlert).toMatchObject({ offerId: null });
    expect(operatorAlert.message).toMatch(/uninstalled/);
    await b.ingest("acme", "appointment.booked", booked());
    expect(b.fake.ok("chat.postMessage")).toHaveLength(0);
    expect((await db().select().from(outbox))[0]!.status).toBe("queued");
    await completeInstall(b.app, { code: "c2", state: stateFrom(installLink(TEST_ENV, b.offerId, b.clock.now())) });
    await b.drain();
    expect(b.fake.ok("chat.postMessage")).toHaveLength(1);
    expect((await db().select().from(outbox))[0]!.status).toBe("sent");
    expect((await db().select().from(alerts)).find((a) => a.kind === "slack_revoked")!.resolvedAt).not.toBeNull();
  });

  it("tokens_revoked for the bot revokes too; for user tokens only, nothing changes", async () => {
    await completeInstall(b.app, { code: "c1", state: stateFrom(installLink(TEST_ENV, b.offerId, b.clock.now())) });
    await b.event({ type: "tokens_revoked", tokens: { oauth: ["UADMIN"] } });
    await b.drain();
    expect((await db().select().from(slackWorkspaces))[0]!.revokedAt).toBeNull();
    await b.event({ type: "tokens_revoked", tokens: { bot: ["UBOT"] } });
    await b.drain();
    expect((await db().select().from(slackWorkspaces))[0]!.revokedReason).toBe("tokens revoked");
  });

  it("while revoked, the platform's own Slack rows wait too, and go after the install", async () => {
    await completeInstall(b.app, { code: "c1", state: stateFrom(installLink(TEST_ENV, b.offerId, b.clock.now())) });
    await b.channel("acme", "C-BOOK", ["bookings"]);
    await b.event({ type: "app_uninstalled" });
    await b.drain();
    const { post } = await import("./say");
    await post(b.app, { offerId: b.offerId, teamId: "T1", channel: "C-BOOK" }, "k1", { text: "hello", blocks: [] }, { kind: "bot" });
    await b.drain();
    expect((await db().select().from(slackOutbox)).filter((r) => r.idempotencyKey === "k1")).toMatchObject([{ status: "queued", nextAttemptAt: null }]);
    await completeInstall(b.app, { code: "c2", state: stateFrom(installLink(TEST_ENV, b.offerId, b.clock.now())) });
    await (await import("./app")).flushSlack(b.app);
    expect((await db().select().from(slackOutbox)).find((r) => r.idempotencyKey === "k1")!.status).toBe("sent");
  });
});
