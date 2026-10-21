import { z } from "zod";
import { db } from "@/db/client";
import { ghlConnections } from "@/db/schema";
import { seal } from "@/lib/secrets";

const TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";

const tokenResponse = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive(),
  scope: z.string().default(""), locationId: z.string().min(1), companyId: z.string().optional(), userId: z.string().optional(),
});

/**
 * The install's code exchanged for the location's tokens (user_type Location), stored sealed. Installing again replaces the
 * tokens. A connection starts needing review: it is linked to an offer by Tyler, never by itself.
 */
export async function connectLocation(code: string, fetcher: typeof fetch = fetch): Promise<{ locationId: string }> {
  const { GHL_CLIENT_ID: id, GHL_CLIENT_SECRET: secret, GHL_REDIRECT_URI: redirect } = process.env;
  if (!id || !secret || !redirect) throw new Error("GHL_CLIENT_ID, GHL_CLIENT_SECRET and GHL_REDIRECT_URI must be set");
  const res = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "authorization_code", code, user_type: "Location", redirect_uri: redirect }),
  });
  if (!res.ok) throw new Error(`GHL refused the code (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const t = tokenResponse.parse(await res.json());
  const row = {
    locationId: t.locationId, companyId: t.companyId ?? null, installedBy: t.userId ?? null,
    accessTokenEnc: seal(t.access_token), refreshTokenEnc: seal(t.refresh_token),
    expiresAt: new Date(Date.now() + t.expires_in * 1000), scopes: t.scope, status: "connected",
  };
  await db().insert(ghlConnections).values(row).onConflictDoUpdate({ target: ghlConnections.locationId, set: row });
  return { locationId: t.locationId };
}
