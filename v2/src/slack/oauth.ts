import { eq } from "drizzle-orm";
import { connections, inbox, slackOfferLinks, slackWorkspaces } from "@/db/schema";
import { resumeConnection } from "@/engine/dispatcher";
import { seal } from "@/lib/secrets";
import { SlackApiError } from "./api";
import type { SlackApp } from "./app";
import { audit, offerRow, offersOfTeam, workspace } from "./data";
import { BOT_SCOPES, type SlackEnv } from "./env";
import { resolveAlertKey, wakeSlackRows } from "./outbox";
import { nonce, openValue, signValue } from "./signed";

/**
 * "Add to Slack": one app, installed into a workspace by OAuth. The dashboard's Connect Slack link names the offer in a
 * signed, single-use state that ends in an hour; Slack sends the installer back to /slack/oauth/callback with a code and
 * that state; the platform checks the state, exchanges the code, and keeps the workspace with its bot token sealed. A
 * workspace already installed keeps its row (its tokens are replaced) and only gains the link to this offer. Installing
 * again after an uninstall lets everything held for it go.
 */
export const STATE_TTL_SEC = 3600;
export const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

export const redirectUri = (env: Pick<SlackEnv, "baseUrl">) => `${env.baseUrl}/slack/oauth/callback`;

/** The Connect Slack link for one offer. */
export function installLink(env: Pick<SlackEnv, "baseUrl" | "stateSecret">, offerId: string, now: Date = new Date()): string {
  return `${env.baseUrl}/slack/install?offer=${encodeURIComponent(signValue(env.stateSecret, "install", { o: offerId, n: nonce() }, { now, ttlSec: STATE_TTL_SEC }))}`;
}

export function authorizeUrl(env: SlackEnv, state: string): string {
  const q = new URLSearchParams({ client_id: env.clientId, scope: BOT_SCOPES.join(","), redirect_uri: redirectUri(env), state });
  return `${AUTHORIZE_URL}?${q}`;
}

/** GET /slack/install?offer=<signed state>: to Slack's authorize page, with the same state. */
export function installRedirect(env: SlackEnv, url: URL, now: Date): Response {
  const state = url.searchParams.get("offer") ?? "";
  if (!openValue(env.stateSecret, "install", state, now)) return new Response("This Connect Slack link is not valid or has expired. Make a new one from the offer's onboarding.", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(null, { status: 302, headers: { location: authorizeUrl(env, state) } });
}

export type Installed = { teamId: string; teamName: string | null; offerId: string; reused: boolean };

export async function completeInstall(app: SlackApp, x: { code: string | null; state: string | null; error?: string | null }): Promise<Installed> {
  const now = app.now();
  if (x.error) throw new InstallError(`Slack did not install the app: ${x.error}`);
  const st = openValue<{ o: string; n: string }>(app.env.stateSecret, "install", x.state, now);
  if (!st || typeof st.o !== "string" || typeof st.n !== "string") throw new InstallError("The install link is not valid or has expired.");
  if (!x.code) throw new InstallError("Slack sent no code.");
  if (!(await offerRow(app.db, st.o))) throw new InstallError("The offer in this install link does not exist.");
  // the state is used once: a second callback with it is refused
  const fresh = await app.db.insert(inbox).values({ source: "slack-install", deliveryId: st.n, headers: {}, body: "" }).onConflictDoNothing().returning({ id: inbox.id });
  if (!fresh.length) throw new InstallError("This install link was already used. Make a new one from the offer's onboarding.");
  let r: Record<string, unknown>;
  try {
    r = await app.api.form("oauth.v2.access", { client_id: app.env.clientId, client_secret: app.env.clientSecret, code: x.code, redirect_uri: redirectUri(app.env) });
  } catch (e) {
    throw new InstallError(`Slack refused the install code${e instanceof SlackApiError ? ` (${e.code})` : ""}.`);
  }
  const team = (r.team ?? {}) as { id?: string; name?: string };
  const access = String(r.access_token ?? ""), botUser = String(r.bot_user_id ?? "");
  if (!team.id || !access || !botUser) throw new InstallError("Slack's answer had no workspace, bot token or bot user.");
  const prior = await workspace(app.db, team.id);
  const row = {
    teamId: team.id, teamName: team.name ?? null, appId: typeof r.app_id === "string" ? r.app_id : null, botUserId: botUser, botTokenEnc: seal(access),
    refreshTokenEnc: typeof r.refresh_token === "string" && r.refresh_token ? seal(r.refresh_token) : null,
    tokenExpiresAt: typeof r.expires_in === "number" ? new Date(now.getTime() + r.expires_in * 1000) : null,
    scopes: String(r.scope ?? ""), installedBy: ((r.authed_user ?? {}) as { id?: string }).id ?? null, installedAt: prior?.installedAt ?? now,
    revokedAt: null, revokedReason: null, updatedAt: now,
  };
  await app.db.transaction(async (t) => {
    await t.insert(slackWorkspaces).values(row).onConflictDoUpdate({ target: slackWorkspaces.teamId, set: { ...row, installedAt: prior?.installedAt ?? now } });
    await t.insert(slackOfferLinks).values({ offerId: st.o, teamId: team.id!, linkedBy: row.installedBy, linkedAt: now }).onConflictDoUpdate({ target: slackOfferLinks.offerId, set: { teamId: team.id!, linkedBy: row.installedBy, linkedAt: now } });
  });
  await afterInstall(app, team.id, now);
  await audit(app.db, { offerId: st.o, teamId: team.id, userId: row.installedBy, action: prior ? "slack.reinstalled" : "slack.installed", detail: { scopes: row.scopes, reused: !!prior }, at: now });
  return { teamId: team.id, teamName: row.teamName, offerId: st.o, reused: !!prior };
}

/** A workspace is installed (again): what its offers' Slack held goes now, and the alerts about it close. */
async function afterInstall(app: SlackApp, teamId: string, now: Date) {
  const offers = await offersOfTeam(app.db, teamId);
  for (const o of offers) {
    const c = (await app.db.select().from(connections).where(eq(connections.offerId, o.id))).find((x) => x.port === "slack");
    if (c && c.status !== "connected") await resumeConnection(app.engine.store, o.id, "slack", now);
    await resolveAlertKey(app.db, o.id, "auth:slack", now);
  }
  await resolveAlertKey(app.db, null, `slack-revoked:${teamId}`, now);
  await wakeSlackRows(app.db, { offerIds: offers.map((o) => o.id), teamId }, now);
}

export class InstallError extends Error {}
