import { eq } from "drizzle-orm";
import { slackWorkspaces } from "@/db/schema";
import { PortError } from "@/engine/ports";
import { open, seal } from "@/lib/secrets";
import { type SlackApi, SlackApiError } from "./api";
import { type Db, type Workspace, workspace, workspaceOf } from "./data";
import type { SlackEnv } from "./env";

/** A bot token is refreshed when it has less than this left (token rotation gives it 12 hours). */
export const REFRESH_BEFORE_MS = 5 * 60_000;

/**
 * The bot token to call Slack with for a workspace: the sealed one, refreshed first through the stored refresh token
 * when it is about to expire. A revoked workspace, or a refresh Slack refuses, is an auth failure: nothing goes through
 * it until it is installed again, and what was waiting is held, not lost.
 */
export async function botToken(d: { db: Db; api: SlackApi; env: Pick<SlackEnv, "clientId" | "clientSecret">; now: () => Date }, ws: Workspace): Promise<string> {
  if (ws.revokedAt) throw new PortError("auth", `Slack is ${ws.revokedReason ?? "revoked"} in workspace ${ws.teamName ?? ws.teamId}; posts are held until it is installed again`);
  const now = d.now();
  if (!ws.tokenExpiresAt || !ws.refreshTokenEnc || ws.tokenExpiresAt.getTime() - now.getTime() > REFRESH_BEFORE_MS) return open(ws.botTokenEnc);
  return d.db.transaction(async (t) => {
    const cur = (await t.select().from(slackWorkspaces).where(eq(slackWorkspaces.teamId, ws.teamId)).for("update"))[0]!;
    if (cur.tokenExpiresAt && cur.tokenExpiresAt.getTime() - now.getTime() > REFRESH_BEFORE_MS) return open(cur.botTokenEnc);   // another worker refreshed it
    let r: Record<string, unknown>;
    try {
      r = await d.api.form("oauth.v2.access", { client_id: d.env.clientId, client_secret: d.env.clientSecret, grant_type: "refresh_token", refresh_token: open(cur.refreshTokenEnc!) });
    } catch (e) {
      if (e instanceof SlackApiError && (e.code === "invalid_refresh_token" || e.code === "invalid_client_id" || e.code === "bad_client_secret" || e.code === "token_revoked")) throw new PortError("auth", `Slack refused to refresh the bot token: ${e.code}`);
      throw new PortError("transient", `the bot token could not be refreshed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const access = String(r.access_token ?? ""), refresh = String(r.refresh_token ?? "");
    if (!access) throw new PortError("transient", "Slack's refresh gave no token");
    await t.update(slackWorkspaces).set({
      botTokenEnc: seal(access), ...(refresh ? { refreshTokenEnc: seal(refresh) } : {}),
      tokenExpiresAt: typeof r.expires_in === "number" ? new Date(now.getTime() + r.expires_in * 1000) : null, updatedAt: now,
    }).where(eq(slackWorkspaces.teamId, ws.teamId));
    return access;
  });
}

/** Where a call goes: an offer's workspace (by its link), or a workspace by id (the operator's channel). */
export type Target = { offerId: string } | { teamId: string };

export async function workspaceFor(db: Db, t: Target): Promise<Workspace> {
  const ws = "offerId" in t ? await workspaceOf(db, t.offerId) : await workspace(db, t.teamId);
  if (!ws) throw new PortError("auth", "offerId" in t ? "Slack is not connected for this offer: install the app (Connect Slack)" : `the app is not installed in workspace ${t.teamId}`);
  return ws;
}
