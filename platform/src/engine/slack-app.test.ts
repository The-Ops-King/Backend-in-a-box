/** D251: the shared Slack app: the install link, the install, which offer a request belongs to, and the doors answering for that one offer only. */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHmac } from "node:crypto";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "./crypto";
import { setBinding } from "./settings";
import { installCompany } from "./install";
import { fakeAdapters } from "./test-install";
import { finishInstall, installState, readInstallState, routeSlack, sharedManifest, slackGone, type SharedApp } from "./slack-app";

const pending: (() => Promise<unknown>)[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<unknown>) => { pending.push(fn); } }));
const teamAsked: string[] = [], said: { url: string; body: Record<string, unknown> }[] = [];
vi.mock("@/engine/team-command", async (orig) => ({ ...(await orig<typeof import("@/engine/team-command")>()), teamCommand: async (_c: unknown, a: { companyId: string }) => { teamAsked.push(a.companyId); return `team of ${a.companyId}`; } }));
vi.mock("@/engine/webhooks/slack", async (orig) => ({ ...(await orig<typeof import("@/engine/webhooks/slack")>()), respondToSlack: async (url: string, body: Record<string, unknown>) => { said.push({ url, body }); } }));

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.SLACK_CLIENT_SECRET = "client-secret";
const APP: SharedApp = { clientId: "123.456", clientSecret: "client-secret", signingSecret: "shared-signing-secret" };
const ENV = { SLACK_CLIENT_SECRET: APP.clientSecret };
const T = `T-SH-${Date.now()}`, STAMP = Date.now();
let a = "", b = "", solo = "";

const sign = (raw: string, secret = APP.signingSecret) => { const ts = String(Math.floor(Date.now() / 1000)); return { "x-slack-request-timestamp": ts, "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}` }; };
const form = (o: Record<string, string>) => new URLSearchParams({ team_id: T, user_id: "U-OP", channel_name: "x", response_url: `https://hooks.slack.com/commands/${Math.random()}`, text: "", ...o }).toString();
const exchange = (team: string) => async () => ({ ok: true, access_token: "xoxb-shared", bot_user_id: "U-SHBOT", team: { id: team, name: "Two Offers HQ" } });

describe.skipIf(!process.env.DATABASE_URL)("D251: the shared Slack app", () => {
  beforeAll(async () => {
    await migrate();
    const make = async (name: string) => (await installCompany({ name, slug: `d251-${name.toLowerCase()}-${STAMP}`, timezone: "America/New_York", locationId: `LOC-${name}`, pit: "pit-fake", calendars: {}, templates: [], crm: {}, slack: {} }, fakeAdapters())).companyId;
    a = await make("Alpha"); b = await make("Bravo"); solo = await make("Solo");
    await asOperator(async (c) => {
      await setBinding(c, a, "slack.channel.reports", "channel", "C-ALPHA", "test");
      await setBinding(c, b, "slack.channel.reports", "channel", "C-BRAVO", "test");
      await c.query("insert into users (company_id, email, name, role, slack_user_id) values ($1,'al@x.test','Al','closer','U-AL'), ($2,'bo@x.test','Bo','setter','U-BO')", [a, b]);
      await c.query("insert into slack_posts (company_id, tag, channel, ts) values ($1,'eod:1','C-SHARED-ROOM','111.1')", [b]);
    });
  });

  it("the install link's state is signed and lasts an hour", () => {
    const st = installState("co-1", STAMP, ENV);
    expect(readInstallState(st, STAMP + 59 * 60_000, ENV)).toEqual({ companyId: "co-1" });
    expect(readInstallState(st, STAMP + 61 * 60_000, ENV)).toMatchObject({ error: expect.stringContaining("expired") });
    const [body] = st.split(".");
    const forged = `${Buffer.from(JSON.stringify({ c: "co-2", exp: 9e9 })).toString("base64url")}.${st.split(".")[1]}`;
    expect(readInstallState(forged, STAMP, ENV)).toMatchObject({ error: expect.stringContaining("not one the engine made") });
    expect(readInstallState(`${body}.x`, STAMP, { SLACK_CLIENT_SECRET: "another" })).toMatchObject({ error: expect.any(String) });
  });

  it("installing keeps the workspace's bot as the offer's Slack, on the shared app; another workspace is refused", async () => {
    for (const co of [a, b]) {
      const r = await asOperator((c) => finishInstall(c, { code: "code", state: installState(co), app: APP, base: "https://engine.test", exchange: exchange(T) }));
      expect(r).toMatchObject({ ok: true, companyId: co, team: "Two Offers HQ", replaced: null });
    }
    const rows = await asOperator((c) => many<{ company_id: string; app: string; bot_user_id: string }>(c, "select company_id, app, bot_user_id from slack_connections where team_id=$1 order by company_id", [T]));
    expect(rows.map((r) => [r.app, r.bot_user_id])).toEqual([["shared", "U-SHBOT"], ["shared", "U-SHBOT"]]);
    const other = await asOperator((c) => finishInstall(c, { code: "code", state: installState(a), app: APP, base: "https://engine.test", exchange: exchange("T-ELSEWHERE") }));
    expect(other).toMatchObject({ ok: false, why: expect.stringContaining("another workspace") });
    expect((await asOperator((c) => one<{ n: string }>(c, "select count(*) n from audit_log where company_id=$1 and action='slack.installed'", [a])))!.n).toBe("1");
  });

  it("which offer: the channel's, the post's, the person's; never a guess", async () => {
    await asOperator(async (c) => {
      expect(await routeSlack(c, { teamId: T, channel: "C-ALPHA", user: "U-BO" })).toEqual({ companyId: a });
      expect(await routeSlack(c, { teamId: T, channel: "C-BRAVO" })).toEqual({ companyId: b });
      expect(await routeSlack(c, { teamId: T, channel: "C-SHARED-ROOM", ts: "111.1" })).toEqual({ companyId: b });
      expect(await routeSlack(c, { teamId: T, channel: "D-DM", user: "U-AL" })).toEqual({ companyId: a });
      expect(await routeSlack(c, { teamId: T, channel: "C-RANDOM", user: "U-NOBODY" })).toEqual({ ambiguous: ["Alpha", "Bravo"] });
      expect(await routeSlack(c, { teamId: "T-UNKNOWN", channel: "C-ALPHA" })).toEqual({ none: true });
    });
  });

  it("/team from one offer's channel answers for that offer only; from a channel of neither, it asks", async () => {
    const { commandsDoor } = await import("@/api/slack-doors");
    const send = (o: Record<string, string>, secret?: string) => { const raw = form(o); return commandsDoor(new Request("http://x", { method: "POST", body: raw, headers: sign(raw, secret) }), { shared: APP }); };
    expect((await send({ command: "/team", channel_id: "C-BRAVO" })).status).toBe(200);
    await Promise.all(pending.splice(0).map((f) => f()));
    expect(teamAsked).toEqual([b]);
    expect(said.at(-1)!.body).toMatchObject({ text: `team of ${b}` });
    const lost = await (await send({ command: "/team", channel_id: "C-RANDOM", user_id: "U-NOBODY" })).json();
    expect(lost.text).toContain("more than one offer (Alpha, Bravo)");
    expect(pending).toHaveLength(0); expect(teamAsked).toEqual([b]);
    expect((await send({ command: "/team", channel_id: "C-ALPHA" }, "forged")).status).toBe(401);
  });

  it("an offer on the shared app no longer answers its own app", async () => {
    const { commandsDoor } = await import("@/api/slack-doors");
    const raw = form({ command: "/help", channel_id: "C-ALPHA" });
    const r = await (await commandsDoor(new Request("http://x", { method: "POST", body: raw, headers: sign(raw, "own-secret") }), { companyId: a })).json();
    expect(r.text).toContain("shared app now");
  });

  it("a workspace with one offer needs no channel to tell", async () => {
    await asOperator((c) => c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id, app) values ($1,$3,$2,'U-B','shared')", [solo, encrypt("xoxb-solo"), `${T}-SOLO`]));
    expect(await asOperator((c) => routeSlack(c, { teamId: `${T}-SOLO`, channel: "C-ANY" }))).toEqual({ companyId: solo });
  });

  it("uninstalled: that workspace's offers lose their Slack, and an alert says so", async () => {
    const { eventsDoor } = await import("@/api/slack-doors");
    const raw = JSON.stringify({ type: "event_callback", team_id: `${T}-SOLO`, event_id: `Ev-${STAMP}`, event: { type: "app_uninstalled" } });
    expect(await (await eventsDoor(new Request("http://x", { method: "POST", body: raw, headers: sign(raw) }), { shared: APP })).json()).toEqual({ ok: true, disconnected: [solo] });
    expect(await asOperator((c) => one(c, "select 1 from slack_connections where company_id=$1", [solo]))).toBeFalsy();
    expect(await asOperator((c) => one(c, "select level from alerts where company_id=$1 and key='slack:uninstalled' and resolved_at is null", [solo]))).toMatchObject({ level: "error" });
    expect(await asOperator((c) => slackGone(c, `${T}-SOLO`, "again"))).toEqual([]);
  });

  it("the manifest points every door at the shared paths and asks for the commands scope", () => {
    const m = sharedManifest("https://engine.test");
    for (const s of ['url: "https://engine.test/api/slack/commands"', 'request_url: "https://engine.test/api/slack/interactions"', 'request_url: "https://engine.test/api/slack/events"', '- "https://engine.test/api/slack/oauth"', "- commands", "- app_uninstalled", "command: /team"]) expect(m).toContain(s);
  });
});
