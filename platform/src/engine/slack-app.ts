import { createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import { encrypt } from "./crypto";
import { setBinding } from "./settings";
import { raise } from "./alerts";
import { SHORTCUTS } from "./bot-format";
import { TEST_CHANNEL_KEY } from "./mode";

/**
 * D251 (Tyler: "installable shared app. one that does it all so we update once and it all gets it ... if i do /team on one account
 * for example I should Only get that team"): one Slack app, installed into each offer's workspace from a link, next to the per-offer
 * apps made by hand from a manifest (D174), which keep working until an offer moves. The app's three keys are the server's
 * (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET); every request to its doors is signed with the one secret and
 * belongs to the offer whose workspace sent it. Where one workspace runs several offers, the channel decides (the offer whose
 * channels or posts it is), a DM the person (the offer whose team they are on); when neither settles it, nothing is guessed.
 */
export type SharedApp = { clientId: string; clientSecret: string; signingSecret: string };
export function sharedSlackApp(env: Record<string, string | undefined> = process.env): SharedApp | null {
  const clientId = env.SLACK_CLIENT_ID?.trim(), clientSecret = env.SLACK_CLIENT_SECRET?.trim(), signingSecret = env.SLACK_SIGNING_SECRET?.trim();
  return clientId && clientSecret && signingSecret ? { clientId, clientSecret, signingSecret } : null;
}
export const publicBase = (env: Record<string, string | undefined> = process.env) => (env.PUBLIC_URL ?? env.TICK_URL ?? "").replace(/\/$/, "");
export const SLACK_PATHS = { events: "/api/slack/events", commands: "/api/slack/commands", interactions: "/api/slack/interactions", oauth: "/api/slack/oauth" } as const;

/** D174/D251: what every engine Slack app asks a workspace for and is told about; the commands scope only when it answers slash commands. */
export const BOT_SCOPES = ["chat:write", "chat:write.customize", "channels:read", "groups:read", "reactions:read", "reactions:write", "users:read.email", "users:read", "app_mentions:read", "im:history", "channels:history", "groups:history"];
export const BOT_EVENTS = ["reaction_added", "app_mention", "message.im", "message.channels", "message.groups"];
const SHARED_SCOPES = [...BOT_SCOPES, "commands"];
/** D203: the operator's /team, in the manifest but not in /help (the team cannot run it). */
export const TEAM_SHORTCUT = { command: "/team", description: "Operator only: add or remove a setter or closer, and what's left to set up", hint: "[add <email> <setter|closer>]" };
const SLASH_COMMANDS = () => [...SHORTCUTS.map((s) => ({ command: s.command, description: s.about, hint: s.hint ?? "" })), { command: "/help", description: "What the bot can answer", hint: "" }, TEAM_SHORTCUT];

const q = (s: string) => JSON.stringify(s);   // a JSON string is a YAML string
/** One Slack app manifest (YAML), the commands made from the bot's own list (SHORTCUTS) so it cannot drift from what the bot answers. */
export function manifestYaml(m: { notes: string[]; appName: string; botName: string; description: string; commandsUrl: string | null; interactionsUrl: string; eventsUrl: string; redirectUrl?: string; scopes: string[]; events: string[] }): string {
  return [
    ...m.notes.map((n) => `# ${n}`),
    "display_information:",
    `  name: ${q(m.appName)}`,
    `  description: ${q(m.description)}`,
    "features:",
    "  app_home:",
    "    messages_tab_enabled: true",
    "    messages_tab_read_only_enabled: false",
    "  bot_user:",
    `    display_name: ${q(m.botName)}`,
    "    always_online: true",
    ...(m.commandsUrl ? ["  slash_commands:", ...SLASH_COMMANDS().map((c) => `    - { command: ${c.command}, url: ${q(m.commandsUrl!)}, description: ${q(c.description.slice(0, 100))}${c.hint ? `, usage_hint: ${q(c.hint)}` : ""}, should_escape: false }`)] : []),
    "oauth_config:",
    ...(m.redirectUrl ? ["  redirect_urls:", `    - ${q(m.redirectUrl)}`] : []),
    "  scopes:",
    "    bot:",
    ...m.scopes.map((s) => `      - ${s}`),
    "settings:",
    "  interactivity:",
    "    is_enabled: true",
    `    request_url: ${q(m.interactionsUrl)}`,
    "  event_subscriptions:",
    `    request_url: ${q(m.eventsUrl)}`,
    "    bot_events:",
    ...m.events.map((e) => `      - ${e}`),
    "  org_deploy_enabled: false",
    "  socket_mode_enabled: false",
    "  token_rotation_enabled: false",
    "",
  ].join("\n");
}

// the install link carries the offer it is for, signed, for an hour: Slack hands the state back untouched on the way back
const stateKey = (env: Record<string, string | undefined>) => {
  const k = env.SLACK_CLIENT_SECRET?.trim() || env.CRON_SECRET?.trim();
  if (!k) throw new Error("no key to sign an install link with (SLACK_CLIENT_SECRET)");
  return k;
};
const sign = (body: string, env: Record<string, string | undefined>) => createHmac("sha256", stateKey(env)).update(`slack-install:${body}`).digest("base64url");
export function installState(companyId: string, now = Date.now(), env: Record<string, string | undefined> = process.env): string {
  const body = Buffer.from(JSON.stringify({ c: companyId, exp: Math.floor(now / 1000) + 3600 })).toString("base64url");
  return `${body}.${sign(body, env)}`;
}
export function readInstallState(state: string, now = Date.now(), env: Record<string, string | undefined> = process.env): { companyId: string } | { error: string } {
  const [body, sig] = state.split(".");
  if (!body || !sig) return { error: "the install link is not one the engine made" };
  const a = Buffer.from(sign(body, env)), b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { error: "the install link is not one the engine made" };
  const v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { c?: string; exp?: number };
  if (!v.c || !v.exp || v.exp < now / 1000) return { error: "the install link has expired (they last an hour): make a new one" };
  return { companyId: v.c };
}

/** The link that installs the shared app into the workspace the person is signed in to, for this offer. */
export function installUrl(companyId: string, app: SharedApp, base = publicBase(), now = Date.now()): string {
  const q = new URLSearchParams({ client_id: app.clientId, scope: SHARED_SCOPES.join(","), redirect_uri: `${base}${SLACK_PATHS.oauth}`, state: installState(companyId, now) });
  return `https://slack.com/oauth/v2/authorize?${q}`;
}

export type OAuthAccess = { ok: boolean; error?: string; access_token?: string; token_type?: string; bot_user_id?: string; team?: { id: string; name?: string } };
export const exchangeCode = async (app: SharedApp, code: string, redirectUri: string): Promise<OAuthAccess> => {
  const r = await fetch("https://slack.com/api/oauth.v2.access", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirectUri }) });
  return (await r.json()) as OAuthAccess;
};

/**
 * Slack came back from the install with a code: the bot's token for that workspace is kept (encrypted) as this offer's Slack, marked
 * as the shared app's, in place of whatever app it had. The offer's own app, if any, stops being read (its doors ignore it from now).
 */
export async function finishInstall(c: PoolClient, args: { code: string; state: string; app: SharedApp; base?: string; exchange?: typeof exchangeCode; now?: number }):
  Promise<{ ok: true; companyId: string; slug: string; team: string; replaced: "own" | "shared" | null } | { ok: false; why: string }> {
  const st = readInstallState(args.state, args.now);
  if ("error" in st) return { ok: false, why: st.error };
  const co = await one<{ id: string; slug: string }>(c, "select id, slug from companies where id=$1", [st.companyId]);
  if (!co) return { ok: false, why: "the offer this link was made for is gone" };
  const a = await (args.exchange ?? exchangeCode)(args.app, args.code, `${args.base ?? publicBase()}${SLACK_PATHS.oauth}`);
  if (!a.ok || !a.access_token || !a.team?.id) return { ok: false, why: `Slack did not finish the install: ${a.error ?? "no token came back"}` };
  if (!/^xoxb-/.test(a.access_token)) return { ok: false, why: "Slack gave a token that is not a bot token" };
  const was = await one<{ app: "own" | "shared"; team_id: string }>(c, "select app, team_id from slack_connections where company_id=$1", [co.id]);
  if (was && was.team_id !== a.team.id) return { ok: false, why: `this offer's Slack is another workspace (${was.team_id}); install it in that one, or disconnect it first` };
  await c.query(`insert into slack_connections (company_id, team_id, bot_token, bot_user_id, app) values ($1,$2,$3,$4,'shared')
    on conflict (company_id) do update set team_id=excluded.team_id, bot_token=excluded.bot_token, bot_user_id=excluded.bot_user_id, app='shared', connected_at=now()`, [co.id, a.team.id, encrypt(a.access_token), a.bot_user_id ?? null]);
  if (a.team.name) await setBinding(c, co.id, "slack.team_name", "text", a.team.name, "shared Slack app install");
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1::uuid,'slack.installed','company',$1::text,$2,$3)",
    [co.id, JSON.stringify(was ? { app: was.app, team_id: was.team_id } : null), JSON.stringify({ app: "shared", team_id: a.team.id, team: a.team.name ?? null })]);
  return { ok: true, companyId: co.id, slug: co.slug, team: a.team.name ?? a.team.id, replaced: was?.app ?? null };
}

/** The app was uninstalled from a workspace, or its tokens revoked: every offer there that ran on the shared app has no Slack now, and says so. */
export async function slackGone(c: PoolClient, teamId: string, why: string): Promise<string[]> {
  const gone = await many<{ company_id: string }>(c, "delete from slack_connections where team_id=$1 and app='shared' returning company_id", [teamId]);
  for (const g of gone) {
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1::uuid,'slack.uninstalled','company',$1::text,$2)", [g.company_id, JSON.stringify({ team_id: teamId, why })]);
    await raise(c, { companyId: g.company_id, key: "slack:uninstalled", level: "error", source: "engine", text: `The Slack app was removed from this offer's workspace (${why}): nothing posts to Slack until it is installed again.` });
  }
  return gone.map((g) => g.company_id);
}

export type SlackWho = { teamId: string | null | undefined; channel?: string | null; ts?: string | null; user?: string | null };
export type SlackRoute = { companyId: string } | { none: true } | { ambiguous: string[] };
/**
 * Which offer a request to the shared app belongs to: the one whose workspace sent it. Several offers in one workspace: the offer
 * whose channels it is (a channel slot, or a post the engine made there; a reaction, that very post), else for a DM the offer whose
 * team the person is on. More than one, or none, is said, never guessed: an answer from the wrong offer is the one thing not allowed.
 */
export async function routeSlack(c: PoolClient, w: SlackWho): Promise<SlackRoute> {
  if (!w.teamId) return { none: true };
  const here = await many<{ company_id: string; name: string }>(c, "select s.company_id, co.name from slack_connections s join companies co on co.id=s.company_id where s.team_id=$1 and s.app='shared' order by co.name", [w.teamId]);
  if (!here.length) return { none: true };
  if (here.length === 1) return { companyId: here[0].company_id };
  const ids = here.map((h) => h.company_id);
  const narrow = async (sql: string, params: unknown[]) => (await many<{ company_id: string }>(c, sql, [ids, ...params])).map((r) => r.company_id);
  if (w.channel && w.ts) {
    const post = await narrow("select distinct company_id from slack_posts where company_id = any($1::uuid[]) and channel=$2 and ts=$3", [w.channel, w.ts]);
    if (post.length === 1) return { companyId: post[0] };
  }
  if (w.channel && !/^D/.test(w.channel)) {
    const slot = await narrow(`select distinct company_id from bindings where company_id = any($1::uuid[]) and (key like 'slack.channel.%' or key = any($3::text[])) and convert_from(value,'utf8')=$2`, [w.channel, ["alerts.slack_channel", TEST_CHANNEL_KEY]]);
    if (slot.length === 1) return { companyId: slot[0] };
    if (slot.length > 1) return { ambiguous: here.filter((h) => slot.includes(h.company_id)).map((h) => h.name) };
    const posted = await narrow("select distinct company_id from slack_posts where company_id = any($1::uuid[]) and channel=$2", [w.channel]);
    if (posted.length === 1) return { companyId: posted[0] };
  }
  if (w.user) {
    const team = await narrow("select distinct company_id from users where company_id = any($1::uuid[]) and slack_user_id=$2 and active", [w.user]);
    if (team.length === 1) return { companyId: team[0] };
    if (team.length > 1) return { ambiguous: here.filter((h) => team.includes(h.company_id)).map((h) => h.name) };
  }
  return { ambiguous: here.map((h) => h.name) };
}
export const ambiguousWords = (names: string[]) => names.length
  ? `This workspace runs more than one offer (${names.join(", ")}), and I can't tell which one you mean here. Ask in one of that offer's channels.`
  : "This workspace isn't connected to an offer.";

/** The shared app's manifest: made from the engine's own command list and doors, so an update reaches every workspace at once. */
export function sharedManifest(base: string, o: { appName: string; botName: string } = { appName: "Ops Engine", botName: "Ops Engine" }): string {
  return manifestYaml({
    notes: [`${o.appName}, the shared app (D251): api.slack.com/apps → Create New App → From an app manifest → your workspace → YAML → paste → Create.`,
      "Then: Manage Distribution → Activate Public Distribution (unlisted: no App Directory review). Then the three keys into the server:",
      "Basic Information → Client ID → SLACK_CLIENT_ID, Client Secret → SLACK_CLIENT_SECRET, Signing Secret → SLACK_SIGNING_SECRET."],
    appName: o.appName, botName: o.botName, description: "Sales ops engine: bookings, calls, payments and the team's day, in Slack",
    commandsUrl: `${base}${SLACK_PATHS.commands}`, interactionsUrl: `${base}${SLACK_PATHS.interactions}`, eventsUrl: `${base}${SLACK_PATHS.events}`, redirectUrl: `${base}${SLACK_PATHS.oauth}`,
    scopes: SHARED_SCOPES, events: [...BOT_EVENTS, "app_uninstalled", "tokens_revoked"],
  });
}
