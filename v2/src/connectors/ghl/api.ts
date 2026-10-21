import { PortError } from "@/engine/ports";
import { type Outcome, type Res, attemptOnce, failFor, withPolicy } from "../framework/http";
import type { Hub } from "../framework/hub";
import type { Connection, J } from "../framework/types";

/**
 * The GHL API client: one way every GHL request is made, whatever the auth mode.
 * - Base https://services.leadconnectorhq.com, `Authorization: Bearer`, and the `Version` header GHL wants for the
 *   endpoint's family (`versionFor`): 2021-04-15 for calendars and conversations, 2021-07-28 for everything else.
 * - A browser-like User-Agent: GHL's Cloudflare refuses some default clients outright (error 1010).
 * - The location's budget (100 per 10 s), waited for, never failed; `X-RateLimit-Remaining` heeded.
 * - The shared retry policy (framework/http.ts): 429, 5xx and timeouts with jitter; a write that may have been done is
 *   re-read (`confirm`), never sent again blind.
 * - 401: one forced token refresh, then the request once more; refused again, the offer's GHL connections pause.
 * Two auth modes sit behind it (auth.ts): the Marketplace app's OAuth tokens and a private integration token. Nothing
 * above the connector knows which an offer uses.
 */

export const GHL_BASE = "https://services.leadconnectorhq.com";
export const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 BackendInABox/2";

/** The Version header per endpoint family (verified in v1, ghl/02-api-facts.md). */
export function versionFor(path: string): "2021-04-15" | "2021-07-28" {
  return /^\/(calendars|conversations)(\/|$|\?)/.test(path) ? "2021-04-15" : "2021-07-28";
}

/** Who a request is for: the location, the auth mode, the token source. */
export type GhlTarget = { offerId: string; locationId: string; mode: "oauth" | "pit"; pit?: string };

export function targetOf(c: Connection): GhlTarget {
  if (!c.externalId) throw new PortError("permanent", "the GHL connection has no location id");
  const mode = c.mode === "pit" ? "pit" : "oauth";
  if (mode === "pit" && !c.credentials.token) throw new PortError("auth", "the GHL connection is in private-token mode with no token");
  return { offerId: c.offerId, locationId: c.externalId, mode, ...(mode === "pit" ? { pit: c.credentials.token } : {}) };
}

export type GhlRequest = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** The request changes something and is not safe to send twice (a create, a send). */
  write?: boolean;
  /** Re-reads whether a write that may have been done was done (undefined: not done). */
  confirm?: () => Promise<unknown>;
  /** Statuses the caller reads itself instead of failing (404 for a contact that is gone). */
  accept?: number[];
};

export type GhlAuth = {
  token(t: GhlTarget): Promise<string>;
  /** A new token after a 401 (null: none can be had; the connection is paused or needs a reinstall). */
  refresh(t: GhlTarget, stale: string): Promise<string | null>;
};

export class GhlApi {
  constructor(private hub: Hub, private auth: GhlAuth) {}

  /** The answer, or the confirmed result of a write that may have been done. Refusals are PortErrors by class. */
  async call(t: GhlTarget, r: GhlRequest): Promise<Res | { confirmed: unknown }> {
    const q = Object.entries(r.query ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
    const url = `${GHL_BASE}${r.path}${q ? `${r.path.includes("?") ? "&" : "?"}${q}` : ""}`;
    let token = await this.auth.token(t);
    for (let round = 0; ; round++) {
      const attempt = async () => {
        await this.hub.ghlLimiter.take(t.locationId);
        const res = await attemptOnce(this.hub.http, url, {
          method: r.method,
          headers: { authorization: `Bearer ${token}`, version: versionFor(r.path), accept: "application/json", "user-agent": USER_AGENT, ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
          ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
        }, 25_000);
        this.hub.ghlLimiter.observe(t.locationId, res.headers);
        return res;
      };
      const out: Outcome = await withPolicy(this.hub.http, "GHL", attempt, { write: !!r.write, ...(r.confirm ? { confirm: r.confirm } : {}) });
      if ("confirmed" in out) return out;
      if (out.res.status === 401 && round === 0) {
        const fresh = await this.auth.refresh(t, token);
        if (fresh) { token = fresh; continue; }
      }
      if (out.res.status === 401) {
        const reason = `GHL refused the ${t.mode === "pit" ? "private token" : "app's token"} for location ${t.locationId}`;
        await this.hub.pause(t.mode === "pit" ? { provider: "ghl", offerId: t.offerId } : { provider: "ghl", externalId: t.locationId }, "paused", reason);
        throw new PortError("auth", reason, 401);
      }
      if (out.res.status >= 400 && !(r.accept ?? []).includes(out.res.status)) throw failFor("GHL", out.res, `${r.method} ${r.path}`);
      return out.res;
    }
  }

  /** The answer's body (a write confirmed by a re-read gives back what the re-read found). */
  async json<T = J>(t: GhlTarget, r: GhlRequest): Promise<T> {
    const out = await this.call(t, r);
    return ("confirmed" in out ? out.confirmed : out.body) as T;
  }
}
