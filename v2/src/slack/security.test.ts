import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { actions, card, sections, settled } from "./blocks";
import { COMMANDS } from "./commands";
import { BOT_EVENTS, BOT_SCOPES } from "./env";
import { checkSql } from "./query-views";
import { signRequest, verifySlackRequest } from "./signature";
import { openValue, signValue } from "./signed";
import { inHours } from "./alerts";

/** What needs no database: Slack's request signature, the platform's signed values, the manifest, the layouts, the bot's SQL check. */
const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const at = (sec: number) => new Date(sec * 1000);

describe("Slack's request signature", () => {
  const body = "token=x&team_id=T1&command=%2Fmtd&text=";
  const ts = "1792500000";
  it("accepts Slack's v0 signature over the exact raw body", () => {
    expect(verifySlackRequest(SECRET, { timestamp: ts, signature: signRequest(SECRET, ts, body) }, body, at(1792500010))).toEqual({ ok: true });
  });
  it("refuses another secret, a changed body, a changed timestamp, and missing headers", () => {
    const sig = signRequest(SECRET, ts, body);
    expect(verifySlackRequest("other", { timestamp: ts, signature: sig }, body, at(1792500010))).toMatchObject({ ok: false, why: "signature mismatch" });
    expect(verifySlackRequest(SECRET, { timestamp: ts, signature: sig }, `${body}x`, at(1792500010))).toMatchObject({ ok: false });
    expect(verifySlackRequest(SECRET, { timestamp: "1792500001", signature: sig }, body, at(1792500010))).toMatchObject({ ok: false, why: "signature mismatch" });
    expect(verifySlackRequest(SECRET, { timestamp: null, signature: sig }, body)).toMatchObject({ ok: false, why: "missing signature headers" });
    expect(verifySlackRequest(SECRET, { timestamp: ts, signature: null }, body)).toMatchObject({ ok: false });
    expect(verifySlackRequest(SECRET, { timestamp: ts, signature: "v0=short" }, body, at(1792500010))).toMatchObject({ ok: false });
    expect(verifySlackRequest(SECRET, { timestamp: "12ab", signature: sig }, body, at(1792500010))).toMatchObject({ ok: false, why: "the timestamp is not a number" });
  });
  it("refuses a request more than five minutes old or ahead, however well signed (a replay)", () => {
    const sig = signRequest(SECRET, ts, body);
    expect(verifySlackRequest(SECRET, { timestamp: ts, signature: sig }, body, at(1792500300))).toEqual({ ok: true });
    expect(verifySlackRequest(SECRET, { timestamp: ts, signature: sig }, body, at(1792500301))).toMatchObject({ ok: false, why: "timestamp outside the five-minute window" });
    expect(verifySlackRequest(SECRET, { timestamp: ts, signature: sig }, body, at(1792499699))).toMatchObject({ ok: false, why: "timestamp outside the five-minute window" });
  });
});

describe("signed values (install state, button values, modal metadata)", () => {
  const now = new Date("2026-10-26T16:00:00Z");
  it("reads back what it signed, for the purpose it was signed for", () => {
    const v = signValue(SECRET, "button", { o: "offer-1", a: "ask", v: "confirm", r: "run-1", s: "q1" }, { now });
    expect(openValue(SECRET, "button", v, now)).toMatchObject({ o: "offer-1", a: "ask", v: "confirm", r: "run-1", s: "q1", p: "button" });
    expect(v.length).toBeLessThan(2000);
  });
  it("refuses another purpose, another key, a changed payload or MAC, and garbage", () => {
    const v = signValue(SECRET, "button", { o: "offer-1" }, { now });
    expect(openValue(SECRET, "modal", v, now)).toBeNull();
    expect(openValue("another key", "button", v, now)).toBeNull();
    const [body, mac] = v.split(".");
    const forged = Buffer.from(JSON.stringify({ o: "offer-2", p: "button" })).toString("base64url");
    expect(openValue(SECRET, "button", `${forged}.${mac}`, now)).toBeNull();
    expect(openValue(SECRET, "button", `${body}.${mac!.slice(0, -2)}AA`, now)).toBeNull();
    expect(openValue(SECRET, "button", "not-a-value", now)).toBeNull();
    expect(openValue(SECRET, "button", `${v}.extra`, now)).toBeNull();
    expect(openValue(SECRET, "button", undefined, now)).toBeNull();
  });
  it("ends when its time is up", () => {
    const v = signValue(SECRET, "install", { o: "offer-1" }, { now, ttlSec: 3600 });
    expect(openValue(SECRET, "install", v, new Date(now.getTime() + 3_599_000))).not.toBeNull();
    expect(openValue(SECRET, "install", v, new Date(now.getTime() + 3_601_000))).toBeNull();
  });
});

describe("the manifest (slack-manifest.yml)", () => {
  const raw = fs.readFileSync(path.resolve(__dirname, "../../slack-manifest.yml"), "utf8");
  const m = yaml.load(raw) as Record<string, any>;
  it("is valid YAML with every section Slack's manifest has", () => {
    expect(Object.keys(m).sort()).toEqual(["display_information", "features", "oauth_config", "settings"]);
    expect(m.display_information.name).toBe("Backend in a Box");
    expect(m.features.bot_user).toMatchObject({ display_name: "bib", always_online: true });
  });
  it("asks for exactly the spec's scopes and events, the same the code knows", () => {
    expect(m.oauth_config.scopes.bot).toEqual([...BOT_SCOPES]);
    expect(m.oauth_config.scopes.user).toBeUndefined();
    expect(m.settings.event_subscriptions.bot_events).toEqual([...BOT_EVENTS]);
  });
  it("has fixed URLs under ${BASE_URL}: one for events, interactions, options, commands and the OAuth redirect", () => {
    expect(m.oauth_config.redirect_urls).toEqual(["${BASE_URL}/slack/oauth/callback"]);
    expect(m.settings.event_subscriptions.request_url).toBe("${BASE_URL}/slack/events");
    expect(m.settings.interactivity).toEqual({ is_enabled: true, request_url: "${BASE_URL}/slack/interactions", message_menu_options_url: "${BASE_URL}/slack/options" });
    const urls = raw.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n").match(/https?:\/\/\S+/g) ?? [];
    expect(urls).toEqual([]);
  });
  it("lists every slash command, simple names with no prefix, all at /slack/commands", () => {
    const cmds = m.features.slash_commands as { command: string; url: string; description: string }[];
    expect(cmds.map((c) => c.command.slice(1)).sort()).toEqual(Object.keys(COMMANDS).sort());
    for (const c of cmds) {
      expect(c.command).toMatch(/^\/[a-z-]+$/);
      expect(c.url).toBe("${BASE_URL}/slack/commands");
      expect(c.description.length).toBeLessThanOrEqual(100);
    }
  });
  it("rotates tokens, is not an org-wide deploy and uses HTTP, not socket mode", () => {
    expect(m.settings.token_rotation_enabled).toBe(true);
    expect(m.settings.org_deploy_enabled).toBe(false);
    expect(m.settings.socket_mode_enabled).toBe(false);
  });
});

describe("the layouts", () => {
  it("a card in sandbox says so first, in its fallback text and its blocks", () => {
    const m = card({ text: "Booked: Ana", sandbox: true, buttons: [{ actionId: "ask", label: "Confirm", value: "v" }] });
    expect(m.text).toBe("🧪 sandbox · Booked: Ana");
    expect(m.blocks[0]).toMatchObject({ type: "context" });
    expect(m.blocks.at(-1)).toMatchObject({ type: "actions", elements: [{ action_id: "ask", value: "v", text: { text: "Confirm" } }] });
    expect(card({ text: "Booked: Ana" }).text).toBe("Booked: Ana");
  });
  it("settling removes every button and says who pressed what", () => {
    const m = settled(card({ text: "Hi", buttons: [{ actionId: "ask", label: "Go", value: "v" }] }), "*Go* · pressed by <@U1>");
    expect(m.blocks.some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(m.blocks.at(-1))).toContain("pressed by <@U1>");
  });
  it("long words are split into sections under Slack's limit; at most five buttons", () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const s = sections(long);
    expect(s.length).toBeGreaterThan(1);
    expect(s.every((b) => ((b.text as { text: string }).text.length <= 3000))).toBe(true);
    expect((actions(Array.from({ length: 7 }, (_, i) => ({ actionId: `a${i}`, label: "x", value: "v" }))).elements as unknown[]).length).toBe(5);
  });
});

describe("the operator's working hours", () => {
  it("is inside HH:MM-HH:MM on the zone's clock, and handles a window across midnight", () => {
    expect(inHours(new Date("2026-10-26T14:00:00Z"), "07:00-17:00", "America/Phoenix")).toBe(true);   // 07:00 in Arizona
    expect(inHours(new Date("2026-10-26T13:59:00Z"), "07:00-17:00", "America/Phoenix")).toBe(false);
    expect(inHours(new Date("2026-10-27T00:00:00Z"), "07:00-17:00", "America/Phoenix")).toBe(false);  // 17:00
    expect(inHours(new Date("2026-10-27T06:00:00Z"), "22:00-02:00", "America/Phoenix")).toBe(true);   // 23:00
    expect(() => inHours(new Date(), "all day", "America/Phoenix")).toThrow();
  });
});

describe("the bot's SQL check (query_views)", () => {
  it("lets one SELECT over the views through", () => {
    for (const q of ["select count(*) from appointments where status = 'booked'", "with x as (select closer_key, count(*) n from appointments group by 1) select * from x order by n desc limit 5", "select date_trunc('day', paid_at) d, sum(amount) from payments group by 1;"])
      expect(checkSql(q)).toEqual({ ok: true });
  });
  it("refuses writes, several statements, other schemas, catalogs, settings, role changes, comments and unknown functions", () => {
    const refused = [
      "delete from payments", "update people set roles = '{}'", "select 1; select 2", "select * from public.events", "select * from pg_catalog.pg_authid",
      "select set_config('role', 'postgres', true)", "select current_setting('is_superuser')", "select pg_sleep(10)", "select * from information_schema.tables",
      "select 1 -- hi", "select /* x */ 1", "select \"x\" from calls", "select U&\"\\0073et_config\"('a','b',true)", "select dblink('x')", "select * into t from calls",
      "reset role", "set role postgres", "select lo_import('/etc/passwd')", "select pg_read_file('/etc/passwd')", "select a.b.c from calls a", "select $$x$$",
      "select generate_series(1, 1000000000)",
    ];
    for (const q of refused) expect(checkSql(q).ok, q).toBe(false);
  });
});
