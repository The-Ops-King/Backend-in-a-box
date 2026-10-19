/**
 * D151: the Slack step. The manifest carries this company's id in every request URL and the bot's own command list (Dating's
 * hand-written manifest is the check), none when the workspace is shared; the token is kept only when Slack accepts it, with a
 * signing secret of the right shape; the step is done once every slot with nothing to fall back on has a channel.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { decrypt } from "@/engine/crypto";
import { createClient, onboardingState, saveIntake } from "@/onboarding/store";
import { connectSlack, saveChannels, saveSlackOptions, slackManifest, slackState, type SlackAuth } from "@/onboarding/slack";
import type { Intake } from "@/onboarding/intake";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const DATING = "eb8d10d2-bf83-4041-8f8a-560516504ddb";
const commandsOf = (y: string) => y.split("\n").filter((l) => l.includes("command: /")).map((l) => `${/command: (\/[a-z-]+)/.exec(l)![1]} ${/url: "([^"]+)"/.exec(l)![1]} ${/usage_hint: "([^"]*)"/.exec(l)?.[1] ?? ""}`).sort();
const scopesOf = (y: string) => y.split("bot:\n")[1].split("settings:")[0].match(/- [a-z:._]+/g)!.map((s) => s.slice(2)).sort();

describe("the Slack manifest", () => {
  const hand = fs.readFileSync(path.resolve(__dirname, "../../installs/dating-nelly-slack-manifest.yaml"), "utf8");
  const made = slackManifest(DATING, "https://backend-in-a-box.vercel.app", { appName: "Ops Engine", botName: "Ops Engine", commands: true }, "Dating (Nelly)");
  it("has Dating's hand-written commands, scopes and request URLs", () => {
    expect(commandsOf(made)).toEqual(commandsOf(hand));
    expect(scopesOf(made)).toEqual(scopesOf(hand));
    for (const u of [`https://backend-in-a-box.vercel.app/api/webhooks/slack/${DATING}/interactions"`, `request_url: "https://backend-in-a-box.vercel.app/api/webhooks/slack/${DATING}"`]) expect(made).toContain(u);
  });
  it("without commands when the workspace has another engine app, and says why", () => {
    const shared = slackManifest(DATING, "https://x.app", { appName: "PMU Ops Engine", botName: "PMU Ops", commands: false }, "PMU");
    expect(commandsOf(shared)).toEqual([]);
    expect(scopesOf(shared)).not.toContain("commands");
    expect(shared).toMatch(/# No slash commands: this workspace has another engine app/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D151: the Slack step", () => {
  let id: string;
  const intake: Intake = { business: "Slack Co", price: "5000", deposits: false, payment_plans: false, lead_paths: ["ads_direct_book"], application: "none", setters: false, triage: false, boards: "one",
    journey: "They book, the closer closes.", crm: "ghl", booking: "calendly", payments: "whop", recording: "fathom", agreement: "ghl_documents" };
  const auth = async (t: string): Promise<SlackAuth> => (t === "xoxb-good" ? { ok: true, team_id: "T1", team: "Slack Co HQ", bot_user_id: "UBOT" } : { ok: false, error: "invalid_auth" });
  beforeAll(async () => {
    await migrate();
    process.env.PUBLIC_URL ??= "https://engine.test";
    await asOperator(async (c) => { const co = await one<{ id: string }>(c, "select id from companies where slug='slack-co'"); if (co) { for (const t of ["onboarding", "bindings", "slack_connections", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]); await c.query("delete from companies where id=$1", [co.id]); } });
    id = (await asOperator((c) => createClient(c, { name: "Slack Co", timezone: "America/Phoenix" })) as { id: string }).id;
    await asOperator((c) => saveIntake(c, id, { intake }));
  });

  it("the manifest is named for the offer until Tyler renames it; no setter-calls slot without setters", async () => {
    const s = (await asOperator((c) => slackState(c, id, { listChannels: async () => null })))!;
    expect(s.options).toEqual({ appName: "Slack Co Ops Engine", botName: "Slack Co Ops", commands: true });
    expect(s.manifest).toContain(`/api/webhooks/slack/${id}/commands`);
    expect(s.channels.map((x) => x.key)).not.toContain("slack.channel.setter_calls");
    await asOperator((c) => saveSlackOptions(c, id, { appName: "Glow Ops", commands: false }));
    const t = (await asOperator((c) => slackState(c, id, { listChannels: async () => null })))!;
    expect(t.options).toEqual({ appName: "Glow Ops", botName: "Slack Co Ops", commands: false });
    expect(t.manifest).not.toContain("slash_commands");
  });

  it("a token Slack refuses is not kept; a good one is, encrypted, with the signing secret", async () => {
    expect(await asOperator((c) => connectSlack(c, id, { token: "xoxp-user", signingSecret: "a".repeat(32) }, auth))).toMatchObject({ ok: false, why: expect.stringMatching(/xoxb-/) });
    expect(await asOperator((c) => connectSlack(c, id, { token: "xoxb-good", signingSecret: "not-it" }, auth))).toMatchObject({ ok: false, why: expect.stringMatching(/Signing Secret/) });
    expect(await asOperator((c) => connectSlack(c, id, { token: "xoxb-bad", signingSecret: "a".repeat(32) }, auth))).toMatchObject({ ok: false, status: 422, why: "Slack refused the token, so nothing was kept: invalid_auth" });
    expect(await asOperator((c) => one(c, "select 1 from slack_connections where company_id=$1", [id]))).toBeUndefined();
    expect(await asOperator((c) => connectSlack(c, id, { token: "xoxb-good", signingSecret: "0123456789abcdef0123456789ABCDEF" }, auth))).toEqual({ ok: true, detail: "Slack: Slack Co HQ" });
    const row = (await asOperator((c) => one<{ bot_token: Buffer; bot_user_id: string }>(c, "select bot_token, bot_user_id from slack_connections where company_id=$1", [id])))!;
    expect(decrypt(row.bot_token)).toBe("xoxb-good"); expect(row.bot_user_id).toBe("UBOT");
    const s = (await asOperator((c) => slackState(c, id, { listChannels: async () => [{ id: "C1", name: "bookings", is_member: true, is_private: false }] })))!;
    expect(s).toMatchObject({ connected: { team: "Slack Co HQ" }, signingSet: true, ready: false, visible: [{ name: "bookings" }] });
    expect(JSON.stringify(s)).not.toContain("xoxb-good");
  });

  it("channels: a bad pick names the slot; done once every slot with nothing to fall back on has one", async () => {
    expect(await asOperator((c) => saveChannels(c, id, { "slack.channel.bookings": "#bookings", nope: "C1" }))).toMatchObject({ ok: false, problems: ["Bookings: pick a channel", "nope: not a channel slot"] });
    const must = ["slack.channel.bookings", "slack.channel.calls", "slack.channel.payments", "slack.channel.deals", "slack.channel.eod", "slack.channel.reports", "alerts.slack_channel"];
    expect(await asOperator((c) => saveChannels(c, id, Object.fromEntries(must.map((k) => [k, "C0BOOKINGS1"]))))).toEqual({ ok: true });
    expect((await asOperator((c) => onboardingState(c, "slack-co")))!.steps.find((x) => x.id === "slack")!.done).toBeNull();   // the test channel is still empty
    expect(await asOperator((c) => saveChannels(c, id, { "test.slack_channel": "C0TEST0001" }))).toEqual({ ok: true });
    expect((await asOperator((c) => onboardingState(c, "slack-co")))!.steps.find((x) => x.id === "slack")!.done).toBeTruthy();
    await asOperator((c) => saveChannels(c, id, { "slack.channel.eod": "" }));
    expect((await asOperator((c) => onboardingState(c, "slack-co")))!.steps.find((x) => x.id === "slack")!.done).toBeNull();
  });
});
