import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { slackWorkspaces, slackOfferLinks } from "@/db/schema";
import { Engine } from "@/engine/engine";
import { FakePorts } from "@/engine/fake-ports";
import type { CrmContact, Ports } from "@/engine/ports";
import type { VendorReads } from "@/engine/reads";
import { type ContentSeed, FakeClock, install, setupOffer } from "@/engine/testkit";
import type { CrmWrites, Delivery, WorkflowRow } from "@/engine/types";
import { seal } from "@/lib/secrets";
import { makeStore } from "@/test/harness";
import { type SlackApp, type SlackTask, createSlackPortFor } from "./app";
import { type BotModel } from "./bot";
import { confirmIdentity, mapChannel, setPlatformSetting } from "./data";
import type { SlackEnv } from "./env";
import { FakeSlack } from "./fake-slack";
import { processInbox, runSlackJob, slackDoor } from "./http";
import { signRequest } from "./signature";

/**
 * A Slack test bench on the Postgres test database: an offer (or several) with its workflows, the engine with fake
 * vendors except Slack, whose port is the real one over a fake Slack Web API (nothing reaches Slack), a fake clock,
 * and a job queue the test drains. Requests to the doors are signed as Slack signs them.
 */
export const TEST_ENV: SlackEnv = { clientId: "111.222", clientSecret: "client-secret", signingSecret: "signing-secret-8f1c", stateSecret: "state-secret-for-tests-0123456789abcdef", baseUrl: "https://biab.test" };
process.env.TOKEN_KEY ??= randomBytes(32).toString("base64");

const SLACK_TABLES = "slack_audit, slack_alert_state, slack_outbox, slack_messages, slack_bot_usage, person_identities, slack_channels, slack_offer_links, slack_workspaces, platform_settings";

export async function freshSlackDb() {
  await db().execute(sql.raw(`truncate ${SLACK_TABLES} restart identity cascade`));
  await db().execute(sql.raw(`delete from inbox where source like 'slack%'`));
  for (const [k, v] of Object.entries({ "alerts.repeat_minutes": 60, "alerts.repeat_hours": "07:00-17:00", "alerts.repeat_zone": "America/Phoenix", "bot.daily_token_budget": 200000 })) await setPlatformSetting(db(), k, v, "test");
}

type OfferSeed = { slug: string; name?: string; zone?: string; settings?: Record<string, unknown>; content?: ContentSeed; workflows?: unknown[]; reports?: Record<string, unknown> };

export async function slackBench(o: {
  offers?: OfferSeed[]; start?: string; contacts?: CrmContact[]; delivery?: Delivery; crmWrites?: CrmWrites; operator?: { emails?: string[]; phones?: string[] };
  bot?: BotModel; reads?: VendorReads; maxWaitMs?: number;
} = {}) {
  const store = await makeStore("postgres");
  await freshSlackDb();
  const clock = new FakeClock(o.start ?? "2026-10-26T16:00:00Z");
  const fp = new FakePorts(clock.now);
  for (const c of o.contacts ?? [{ id: "c1", phone: "+15550101001", email: "ana@example.com", timezone: "America/New_York", dnd: {} }]) fp.contacts.set(c.id, c);
  const fake = new FakeSlack();
  const slept: number[] = [];
  const { api, port } = createSlackPortFor({ db: db(), env: TEST_ENV, fetch: fake.fetch, now: clock.now, sleep: async (ms) => { slept.push(ms); clock.advance(Math.ceil(ms)); }, maxWaitMs: o.maxWaitMs ?? 30_000 });
  const ports: Ports = { ...fp.ports(), slack: port };
  const offers: Record<string, string> = {};
  const wfs: Record<string, WorkflowRow> = {};
  for (const [i, s] of (o.offers ?? [{ slug: "acme" }]).entries()) {
    const id = await setupOffer(store, { slug: s.slug, name: s.name ?? s.slug, zone: s.zone ?? "America/Denver", settings: s.settings ?? {}, content: s.content ?? {}, ...(i === 0 ? { operator: o.operator ?? {} } : {}), ...(s.reports ? { reports: s.reports } : {}) });
    offers[s.slug] = id;
    for (const w of s.workflows ?? []) { const row = await install(store, id, w, { now: clock.now(), delivery: o.delivery ?? "live", crmWrites: o.crmWrites ?? "real" }); wfs[`${s.slug}/${row.key}`] = row; }
  }
  const engine = new Engine({ store, ports, now: clock.now, random: () => 0.5, ...(o.reads ? { reads: o.reads } : {}) });
  const queue: { task: SlackTask; payload: Record<string, unknown> }[] = [];
  const app: SlackApp = { db: db(), env: TEST_ENV, api, port, engine, now: clock.now, enqueue: async (task, payload) => { queue.push({ task, payload }); }, random: () => 0.5, ...(o.bot ? { bot: o.bot } : {}), ...(o.reads ? { reads: o.reads } : {}) };
  /** What each kept delivery's job did (events, presses, commands), in order. */
  const results: unknown[] = [];
  let n = 0;

  const b = {
    app, store, clock, fp, fake, engine, offers, wfs, queue, results, slept,
    offerId: Object.values(offers)[0]!,
    /** Runs every queued job, and everything the engine has due, until nothing is left. */
    drain: async () => {
      for (let i = 0; i < 200; i++) {
        await engine.runDue();
        const job = queue.shift();
        if (!job) { await engine.runDue(); if (!queue.length) return; continue; }
        const r = await runSlackJob(app, job.task, job.payload);
        if (job.task === "slack_inbox") results.push(r);
      }
      throw new Error("the Slack jobs did not settle");
    },
    /** The workspace installed and linked to these offers (as an install would leave it). */
    workspace: async (x: { teamId?: string; offers?: string[]; botUserId?: string; expiresAt?: Date | null; refresh?: string } = {}) => {
      const teamId = x.teamId ?? "T1";
      await db().insert(slackWorkspaces).values({ teamId, teamName: `Team ${teamId}`, appId: "A1", botUserId: x.botUserId ?? "UBOT", botTokenEnc: seal(`xoxb-${teamId}`), refreshTokenEnc: x.refresh ? seal(x.refresh) : null, tokenExpiresAt: x.expiresAt ?? null, scopes: "chat:write", installedBy: "UADMIN", installedAt: clock.now(), updatedAt: clock.now() }).onConflictDoNothing();
      for (const slug of x.offers ?? Object.keys(offers)) await db().insert(slackOfferLinks).values({ offerId: offers[slug]!, teamId, linkedAt: clock.now() }).onConflictDoNothing();
      return teamId;
    },
    channel: (slug: string, channelId: string, slots: string[], teamId = "T1", name?: string) => mapChannel(db(), { teamId, channelId, offerId: offers[slug]!, slots, name: name ?? channelId.toLowerCase(), botMember: true, by: "test", now: clock.now() }),
    /** A person on an offer's team with roles, confirmed as a Slack user. */
    person: async (slug: string, x: { id: string; name: string; roles: string[]; slack?: string; teamId?: string; crm?: string }) => {
      await engine.ingest({ offerId: offers[slug]!, type: "person.added", source: "test", dedupeKey: `person:${slug}:${x.id}:${++n}`, payload: { person: { id: x.id, name: x.name, roles: x.roles, ...(x.crm ? { crm_user_id: x.crm } : {}), ...(x.slack ? { slack_user_id: x.slack } : {}) } } });
      if (x.slack) await confirmIdentity(db(), { offerId: offers[slug]!, personId: x.id, teamId: x.teamId ?? "T1", userId: x.slack, by: "test", now: clock.now() });
    },
    operator: async (userId: string, teamId = "T1") => setPlatformSetting(db(), "slack.operators", [{ team_id: teamId, user_id: userId }], "test"),
    ingest: async (slug: string, type: string, x: { contact?: string | null; appointment?: string | null; deal?: string | null; payload?: Record<string, unknown>; key?: string } = {}) => {
      const r = await engine.ingest({ offerId: offers[slug]!, type, source: "test", dedupeKey: x.key ?? `t:${++n}`, contactId: x.contact === undefined ? "c1" : x.contact, appointmentId: x.appointment ?? null, dealId: x.deal ?? null, payload: x.payload ?? {} });
      await b.drain();
      return r;
    },
    /** A request to a door, signed as Slack signs it (now, by the fake clock), with headers to override. */
    request: (door: "events" | "interactions" | "commands" | "options", body: string, h: Record<string, string> = {}) => {
      const ts = String(Math.floor(clock.now().getTime() / 1000));
      return new Request(`https://biab.test/slack/${door}`, { method: "POST", headers: { "content-type": door === "events" ? "application/json" : "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": signRequest(TEST_ENV.signingSecret, ts, body), ...h }, body });
    },
    send: async (door: "events" | "interactions" | "commands" | "options", body: string, h: Record<string, string> = {}) => slackDoor(app, door, b.request(door, body, h)),
    event: async (event: Record<string, unknown>, x: { teamId?: string; eventId?: string } = {}) => b.send("events", JSON.stringify({ type: "event_callback", team_id: x.teamId ?? "T1", event_id: x.eventId ?? `Ev${++n}`, event_time: Math.floor(clock.now().getTime() / 1000), event })),
    command: async (command: string, text: string, x: { user: string; channel?: string; teamId?: string; trigger?: string } ) => b.send("commands", new URLSearchParams({ team_id: x.teamId ?? "T1", user_id: x.user, command, text, channel_id: x.channel ?? "D-none", response_url: `https://hooks.slack.com/commands/T1/${++n}`, trigger_id: x.trigger ?? `trig.${n}` }).toString()),
    interaction: async (payload: Record<string, unknown>) => b.send("interactions", new URLSearchParams({ payload: JSON.stringify(payload) }).toString()),
    /** A press on a button of a message Slack holds (its value as the platform signed it). */
    press: async (x: { user: string; channel: string; ts: string; actionId?: string; label?: string; teamId?: string; value?: string; trigger?: string }) => {
      const m = fake.message(x.channel, x.ts);
      const buttons = ((m?.blocks ?? []) as { type: string; elements?: { action_id: string; value: string; text: { text: string } }[] }[]).filter((bl) => bl.type === "actions").flatMap((bl) => bl.elements ?? []);
      const btn = x.value !== undefined ? { action_id: x.actionId ?? "ask", value: x.value, text: { text: x.label ?? "?" } } : buttons.find((e) => (x.label ? e.text.text === x.label : true) && (x.actionId ? e.action_id === x.actionId : true));
      if (!btn) throw new Error(`no such button on ${x.channel}/${x.ts}`);
      return b.interaction({ type: "block_actions", team: { id: x.teamId ?? "T1" }, user: { id: x.user }, channel: { id: x.channel }, container: { type: "message", channel_id: x.channel, message_ts: x.ts }, message: { ts: x.ts, text: m?.text ?? "", blocks: m?.blocks ?? [] }, response_url: `https://hooks.slack.com/actions/T1/${++n}`, trigger_id: x.trigger ?? `trig.${n}`, actions: [{ action_id: btn.action_id, value: btn.value, text: { type: "plain_text", text: btn.text.text }, action_ts: `${1700000000 + ++n}.1` }] });
    },
    /** The texts said privately back to people (through response_url or as ephemerals), in order. */
    privately: () => [...fake.bodies("response_url").map((x) => String((x as { text?: string }).text ?? "")), ...fake.bodies("chat.postEphemeral").map((x) => String(x.text ?? ""))],
    posts: () => fake.bodies("chat.postMessage"),
    processInbox: (id: number) => processInbox(app, id),
  };
  return b;
}
export type Bench = Awaited<ReturnType<typeof slackBench>>;
