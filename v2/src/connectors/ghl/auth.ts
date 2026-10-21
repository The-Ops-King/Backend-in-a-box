import { PortError } from "@/engine/ports";
import { attemptOnce, TransportError } from "../framework/http";
import type { Hub } from "../framework/hub";
import type { GhlToken } from "../framework/state";
import { USER_AGENT, type GhlAuth, type GhlTarget } from "./api";

/**
 * GHL's two auth modes, behind one interface.
 *
 * oauth (the Marketplace app): the location's tokens live sealed in ghl_connections. Access tokens last about 24 hours;
 * the refresh job renews each one with less than 4 hours left, so a refresh never happens on a request's path unless
 * GHL refuses a token (a 401 forces one). Refresh tokens are single-use, so every refresh runs under the location's row
 * lock (select ... for update) and writes the new pair before the lock is let go: two workers can never both spend it.
 * A worker that finds the token already renewed by another uses the new one. A refresh whose answer is lost (it may
 * have been spent) leaves nothing to refresh with: the location goes to needs_reinstall, its offers' GHL connections
 * hold their work, and Tyler is told with the reinstall link.
 *
 * pit (a private integration token, for an offer past the 5-agency cap): the token is the connection's own; there is
 * nothing to refresh, so a refused token pauses the offer's GHL connection.
 */

export const TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
/** Renew a token with less than this left. */
export const REFRESH_BEFORE_MS = 4 * 3_600_000;

export class GhlTokens implements GhlAuth {
  constructor(private hub: Hub) {}

  async token(t: GhlTarget): Promise<string> {
    if (t.mode === "pit") return t.pit!;
    const row = await this.hub.state.ghlToken(t.locationId);
    if (!row) throw new PortError("auth", `the GHL app is not installed on location ${t.locationId}`);
    if (row.status !== "connected") throw new PortError("auth", `the GHL app on location ${t.locationId} is ${row.status.replace("_", " ")}`);
    if (row.expiresAt.getTime() <= this.hub.now().getTime() + 60_000) return (await this.refresh(t, row.accessToken)) ?? Promise.reject(new PortError("auth", `the GHL token for ${t.locationId} could not be renewed`));
    return row.accessToken;
  }

  async refresh(t: GhlTarget, stale: string): Promise<string | null> {
    if (t.mode === "pit") return null;
    return refreshLocation(this.hub, t.locationId, stale);
  }
}

/**
 * Renews one location's tokens under its row lock. `stale`: the access token the caller found wanting; when the row
 * already holds another (someone renewed it meanwhile) that one is used and nothing is spent.
 */
export async function refreshLocation(hub: Hub, locationId: string, stale: string | null): Promise<string | null> {
  const { ghlClientId: id, ghlClientSecret: secret } = hub.env;
  if (!id || !secret) throw new PortError("permanent", "GHL_CLIENT_ID and GHL_CLIENT_SECRET are not set");
  let lost: string | null = null;
  const token = await hub.state.lockGhlToken(locationId, async (row): Promise<{ set?: Partial<GhlToken>; result: string | null }> => {
    if (!row || row.status !== "connected") return { result: null };
    const now = hub.now().getTime();
    if (stale !== null && row.accessToken !== stale && row.expiresAt.getTime() > now + 60_000) return { result: row.accessToken };
    let res;
    try {
      // one attempt only: a refresh token is spent by the first request GHL receives, so it is never sent twice
      res = await attemptOnce(hub.http, TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": USER_AGENT },
        body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "refresh_token", refresh_token: row.refreshToken, user_type: "Location" }).toString(),
      }, 25_000);
    } catch (e) {
      if (e instanceof TransportError && !e.sent) throw new PortError("transient", `GHL token refresh did not leave: ${e.message}`);
      lost = `the answer to the token refresh was lost (${(e as Error).message}); the refresh token may be spent`;
      return { set: { status: "needs_reinstall" }, result: null };
    }
    if (res.status === 429 || res.status >= 500) throw new PortError("transient", `GHL token refresh: ${res.status}`, res.status);
    const b = res.body as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (res.status >= 400 || !b.access_token || !b.refresh_token) {
      lost = `GHL refused the refresh token (${res.status}): ${res.text.slice(0, 200)}`;
      return { set: { status: "needs_reinstall" }, result: null };
    }
    return {
      set: { accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt: new Date(now + (b.expires_in ?? 86_399) * 1000), ...(b.scope ? { scopes: b.scope } : {}) },
      result: b.access_token,
    };
  });
  if (lost) await hub.pause({ provider: "ghl", externalId: locationId }, "needs_reinstall", `${lost}. Reinstall the GHL app on location ${locationId} (Connect GHL in the offer's onboarding)`);
  return token;
}

/**
 * The refresh job: every connected location with less than 4 hours left is renewed. Gives back when it should run next
 * (four hours before the soonest expiry, at least a minute and at most an hour away).
 */
export async function refreshDue(hub: Hub): Promise<{ refreshed: string[]; next: Date }> {
  const now = hub.now().getTime();
  const due = await hub.state.ghlTokensExpiringBefore(new Date(now + REFRESH_BEFORE_MS));
  const refreshed: string[] = [];
  for (const t of due) {
    try { if (await refreshLocation(hub, t.locationId, t.accessToken)) refreshed.push(t.locationId); }
    catch { /* transient: the next run tries again */ }
  }
  const soonest = (await hub.state.ghlTokensExpiringBefore(new Date(now + 48 * 3_600_000))).map((t) => t.expiresAt.getTime() - REFRESH_BEFORE_MS);
  const next = Math.min(now + 3_600_000, Math.max(now + 60_000, ...(soonest.length ? [Math.min(...soonest)] : [now + 3_600_000])));
  await hub.enqueue("ghl_refresh", {}, { runAt: new Date(next), jobKey: "ghl_refresh" });
  return { refreshed, next: new Date(next) };
}

/**
 * The app installed again on a location (the OAuth callback stored fresh tokens): its offers' GHL connections that were
 * paused, needing a reinstall or uninstalled are connected again, and everything that waited on them is due now.
 */
export async function resumeLocation(hub: Hub, locationId: string): Promise<string[]> {
  const waiting = (await hub.state.connectionsOf("ghl", locationId)).filter((c) => c.status !== "connected");
  const offers = await hub.state.setStatus({ provider: "ghl", externalId: locationId }, "connected", null, hub.now());
  const { resumeConnection } = await import("@/engine/dispatcher");
  for (const c of waiting) await resumeConnection(hub.store, c.offerId, c.port, hub.now());
  for (const o of offers) await hub.resolve(o, "connection:ghl");
  return offers;
}
