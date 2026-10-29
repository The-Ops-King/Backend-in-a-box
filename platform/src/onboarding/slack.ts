/**
 * D174 (#53 P1): the wizard's Slack step. The app's manifest is generated with this company's id in every request URL (it was
 * written by hand per client, installs/*-slack-manifest.yaml) and the slash commands from the bot's own list (SHORTCUTS), so
 * the manifest cannot drift from what the bot answers. Slack gives a slash command to the app installed last, so a workspace
 * that already has another engine app gets the manifest without commands (#43). Tyler creates the app from it, installs it,
 * and pastes the bot token (tested live with auth.test; kept encrypted as install keeps it) and the signing secret (Slack has
 * no call that checks one: only its shape is checked here, and the first event Slack sends proves it). Then each channel slot
 * the workflows post to is picked from the channels the bot can see, with the engine's alerts channel and the test channel
 * every post goes to before its workflow is live (D133).
 */
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { encrypt, decrypt } from "@/engine/crypto";
import { setBinding } from "@/engine/settings";
import { BOT_EVENTS, BOT_SCOPES, installUrl, manifestYaml, publicBase, sharedSlackApp, TEAM_SHORTCUT } from "@/engine/slack-app";
import { TEST_CHANNEL_KEY } from "@/engine/mode";
import { listSlackChannels, type SlackChannel } from "@/api/setup-data";
import type { Intake } from "./intake";

export type SlackOptions = { appName: string; botName: string; commands: boolean };
export type SlackAuth = { ok: true; team_id: string; team: string; bot_user_id: string | null } | { ok: false; error: string };
export const slackAuthTest = async (token: string): Promise<SlackAuth> => {
  try {
    const d = (await (await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${token}` } })).json()) as { ok: boolean; team_id?: string; team?: string; user_id?: string; error?: string };
    return d.ok && d.team_id ? { ok: true, team_id: d.team_id, team: d.team ?? d.team_id, bot_user_id: d.user_id ?? null } : { ok: false, error: d.error ?? "no team" };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 160) }; }
};

export { TEAM_SHORTCUT };

/** The app manifest (YAML), every request URL carrying this company's id. */
export function slackManifest(companyId: string, base: string, o: SlackOptions, offer: string): string {
  const url = (p = "") => `${base}/api/webhooks/slack/${companyId}${p}`;
  return manifestYaml({
    notes: [`${o.appName}: api.slack.com/apps → Create New App → From an app manifest → the workspace → YAML → paste this → Create.`,
      "Then Install to Workspace; the Bot User OAuth Token (OAuth & Permissions) and the Signing Secret (Basic Information) go in the wizard.",
      ...(o.commands ? [] : ["No slash commands: this workspace has another engine app, and Slack gives a command to the app installed last."])],
    appName: o.appName, botName: o.botName, description: `Sales ops engine for ${offer}`,
    commandsUrl: o.commands ? url("/commands") : null, interactionsUrl: url("/interactions"), eventsUrl: url(),
    scopes: [...BOT_SCOPES, ...(o.commands ? ["commands"] : [])], events: BOT_EVENTS,
  });
}

/** Where the workflows post, and what each slot is for; `instead`: what a post uses while the slot is empty (D58). */
export const CHANNEL_SLOTS: { key: string; label: string; about: string; instead?: string; when?: (a: Intake) => boolean }[] = [
  { key: "slack.channel.bookings", label: "Bookings", about: "every call booked, moved or cancelled, with its card" },
  { key: "slack.channel.calls", label: "Calls", about: "recordings, notes and scorecards" },
  { key: "slack.channel.setter_calls", label: "Setter calls", about: "what each setter dial found", when: (a) => a.setters === true },
  { key: "slack.channel.payments", label: "Payments", about: "payments in, and payments that failed" },
  { key: "slack.channel.deals", label: "Deals", about: "agreements signed, deals closed" },
  { key: "slack.channel.eod", label: "End of day", about: "closers' end-of-day reports" },
  { key: "slack.channel.reports", label: "Reports", about: "the daily, weekly and monthly wrap-ups and the leaderboard" },
  { key: "slack.channel.ops", label: "Ops", about: "the team's to-dos, and DMs until live", instead: "Reports" },
  { key: "slack.channel.attention", label: "Needs attention", about: "unclear replies, anything a person has to look at", instead: "Ops" },
  { key: "slack.channel.alerts", label: "Team alerts", about: "a payment or recording that matched nobody, a lead nobody called", instead: "Bookings" },
  { key: "alerts.slack_channel", label: "Engine alerts", about: "what broke: tokens, polls, failed steps (usually Tyler only)" },
  { key: TEST_CHANNEL_KEY, label: "Test channel", about: "every post goes here until its workflow is live (D133)" },
];

export type SlackState = {
  options: SlackOptions; manifest: string | null; manifestError?: string;
  connected: { team: string; at: string; app: "own" | "shared" } | null; signingSet: boolean;
  /** D251: the shared app's "Add to Slack" link for this offer (an hour), or why there is none */
  shared: { installUrl: string } | { installUrl: null; why: string };
  channels: { key: string; label: string; about: string; instead?: string; value: string | null }[];
  /** the channels the bot can see, once connected; null when Slack would not list them */
  visible: SlackChannel[] | null;
  ready: boolean;
};

const optionsOf = (s: Partial<SlackOptions>, offer: string): SlackOptions => ({ appName: s.appName?.trim() || `${offer} Ops Engine`, botName: s.botName?.trim() || `${offer} Ops`, commands: s.commands ?? true });

export async function slackState(c: PoolClient, companyId: string, opts: { listChannels?: (token: string) => Promise<SlackChannel[] | null> } = {}): Promise<SlackState | null> {
  const o = await one<{ slack: Partial<SlackOptions>; intake: Intake; name: string }>(c, "select o.slack, o.intake, co.name from onboarding o join companies co on co.id=o.company_id where o.company_id=$1", [companyId]);
  if (!o) return null;
  const options = optionsOf(o.slack, o.name);
  const base = publicBase();
  const conn = await one<{ team_id: string; bot_token: Buffer; connected_at: Date; app: "own" | "shared" }>(c, "select team_id, bot_token, connected_at, app from slack_connections where company_id=$1", [companyId]);
  const b = Object.fromEntries((await many<{ key: string; value: Buffer }>(c, "select key, value from bindings where company_id=$1 and (key like 'slack.channel.%' or key = any($2::text[]))", [companyId, ["alerts.slack_channel", TEST_CHANNEL_KEY, "secret.slack_signing", "slack.team_name"]]))
    .map((r) => [r.key, r.key.startsWith("secret.") ? "set" : r.value.toString("utf8")]));
  const channels = CHANNEL_SLOTS.filter((s) => !s.when || s.when(o.intake)).map((s) => ({ key: s.key, label: s.label, about: s.about, ...(s.instead ? { instead: s.instead } : {}), value: b[s.key] ?? null }));
  const visible = conn ? await (opts.listChannels ?? listSlackChannels)(decrypt(conn.bot_token)) : null;
  const connected = conn ? { team: b["slack.team_name"] ?? conn.team_id, at: conn.connected_at.toISOString(), app: conn.app } : null;
  const app = sharedSlackApp();
  const shared = !base ? { installUrl: null, why: "PUBLIC_URL is not set on the server" } : !app ? { installUrl: null, why: "the shared Slack app's keys are not on the server yet (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET)" } : { installUrl: installUrl(companyId, app, base) };
  // the shared app's requests are signed with the server's secret, so only an offer on its own app needs one stored
  const signed = conn?.app === "shared" || !!b["secret.slack_signing"];
  return {
    options, ...(base ? { manifest: slackManifest(companyId, base, options, o.name) } : { manifest: null, manifestError: "PUBLIC_URL is not set on the server: the manifest needs the engine's address" }),
    connected, signingSet: !!b["secret.slack_signing"], shared, channels, visible,
    ready: !!connected && signed && channels.every((ch) => ch.instead || ch.value),
  };
}

export type SlackResult = { ok: true; detail?: string } | { ok: false; status: number; why: string; problems?: string[] };

export async function saveSlackOptions(c: PoolClient, companyId: string, o: unknown): Promise<SlackResult> {
  if (!o || typeof o !== "object") return { ok: false, status: 400, why: "options: { appName, botName, commands }" };
  const x = o as Record<string, unknown>;
  const clean = { ...(typeof x.appName === "string" ? { appName: x.appName.trim().slice(0, 35) } : {}), ...(typeof x.botName === "string" ? { botName: x.botName.trim().slice(0, 80) } : {}), ...(typeof x.commands === "boolean" ? { commands: x.commands } : {}) };
  await c.query("update onboarding set slack = slack || $2::jsonb where company_id=$1", [companyId, clean]);
  return { ok: true };
}

/** The bot token tested with Slack and kept (encrypted) with the signing secret, as install keeps them: the offer is on its own app (again, if it was on the shared one). */
export async function connectSlack(c: PoolClient, companyId: string, args: { token?: unknown; signingSecret?: unknown; by?: string }, auth: (token: string) => Promise<SlackAuth> = slackAuthTest): Promise<SlackResult> {
  const token = typeof args.token === "string" ? args.token.trim() : "", secret = typeof args.signingSecret === "string" ? args.signingSecret.trim() : "";
  if (!/^xoxb-/.test(token)) return { ok: false, status: 400, why: "the Bot User OAuth Token starts with xoxb- (OAuth & Permissions)" };
  if (!/^[0-9a-f]{32}$/i.test(secret)) return { ok: false, status: 400, why: "the Signing Secret is 32 letters and digits (Basic Information → App Credentials)" };
  const a = await auth(token);
  if (!a.ok) return { ok: false, status: 422, why: `Slack refused the token, so nothing was kept: ${a.error}` };
  await c.query("insert into slack_connections (company_id, team_id, bot_token, bot_user_id, app) values ($1,$2,$3,$4,'own') on conflict (company_id) do update set team_id=excluded.team_id, bot_token=excluded.bot_token, bot_user_id=excluded.bot_user_id, app='own', connected_at=now()", [companyId, a.team_id, encrypt(token), a.bot_user_id]);
  await setBinding(c, companyId, "secret.slack_signing", "secret", secret, `onboarding (${args.by ?? "dashboard"})`);
  await setBinding(c, companyId, "slack.team_name", "text", a.team, `onboarding (${args.by ?? "dashboard"})`);
  await markStep(c, companyId, args.by ?? "dashboard");
  return { ok: true, detail: `Slack: ${a.team}` };
}

/** Each slot's channel, from the channels the bot can see (an id, C… or G…); "" empties a slot. */
export async function saveChannels(c: PoolClient, companyId: string, map: unknown, by = "dashboard"): Promise<SlackResult> {
  if (!map || typeof map !== "object") return { ok: false, status: 400, why: "channels: { slot key: channel id }" };
  const problems: string[] = [];
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    const slot = CHANNEL_SLOTS.find((s) => s.key === k);
    if (!slot) { problems.push(`${k}: not a channel slot`); continue; }
    if (v === "") { await c.query("delete from bindings where company_id=$1 and key=$2", [companyId, k]); continue; }
    if (typeof v !== "string" || !/^[CG][A-Z0-9]{6,}$/.test(v)) { problems.push(`${slot.label}: pick a channel`); continue; }
    await setBinding(c, companyId, k, "channel", v, `onboarding (${by})`);
  }
  await markStep(c, companyId, by);
  return problems.length ? { ok: false, status: 400, why: "some slots were not saved", problems } : { ok: true };
}

/** Done while the bot is connected, the signing secret kept, and every slot with nothing to fall back on has a channel. */
async function markStep(c: PoolClient, companyId: string, by: string) {
  const s = await slackState(c, companyId, { listChannels: async () => null });
  if (s?.ready) await c.query("update onboarding set steps = steps || jsonb_build_object('slack', jsonb_build_object('done_at', now(), 'by', $2::text)) where company_id=$1 and not steps ? 'slack'", [companyId, by]);
  else await c.query("update onboarding set steps = steps - 'slack' where company_id=$1", [companyId]);
}
