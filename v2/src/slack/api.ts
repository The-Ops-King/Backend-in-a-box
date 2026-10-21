/**
 * Slack's Web API, through an injectable fetch (a fake one in tests: nothing here reaches Slack unless a real fetch is
 * given). Every call answers its JSON, or throws a SlackApiError saying how it failed: the HTTP status, Slack's error
 * code, and Retry-After on a rate limit.
 */
export type SlackFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>;

export class SlackApiError extends Error {
  constructor(public method: string, public code: string, public status: number, public retryAfterSec?: number, public sent: "no" | "maybe" | "yes" = "yes") {
    super(`Slack ${method}: ${code}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "SlackApiError";
  }
}

/** Slack's error codes that mean the token or its scopes are wrong: nothing will go through until it is reinstalled. */
export const AUTH_CODES = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "no_permission", "missing_scope", "team_access_not_granted", "not_allowed_token_type", "ekm_access_denied", "org_login_required", "app_uninstalled"]);
/** Slack's own trouble: try again. */
export const TRANSIENT_CODES = new Set(["internal_error", "fatal_error", "service_unavailable", "request_timeout", "ratelimited", "rate_limited", "network"]);
/** A network failure that happened before anything reached Slack (so nothing was posted). */
const BEFORE_SENDING = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET_BEFORE", "UND_ERR_CONNECT_TIMEOUT"]);

export const SLACK_API = "https://slack.com/api/";

export class SlackApi {
  constructor(private fetcher: SlackFetch = (u, i) => fetch(u, i), private base = SLACK_API) {}

  /** A Web API method with the bot token, JSON in and out. */
  async call(method: string, token: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.send(method, { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, JSON.stringify(args));
  }

  /** A method that takes a form (oauth.v2.access): the client's credentials, no token. */
  async form(method: string, args: Record<string, string>): Promise<Record<string, unknown>> {
    return this.send(method, { "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams(args).toString());
  }

  private async send(method: string, headers: Record<string, string>, body: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.base}${method}`, { method: "POST", headers, body });
    } catch (e) {
      const code = String((e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as { code?: string }).code ?? "");
      throw new SlackApiError(method, "network", 0, undefined, BEFORE_SENDING.has(code) ? "no" : "maybe");
    }
    if (res.status === 429) throw new SlackApiError(method, "ratelimited", 429, Number(res.headers.get("retry-after") ?? "1") || 1, "no");
    if (res.status >= 500) throw new SlackApiError(method, "service_unavailable", res.status, undefined, "maybe");
    let data: Record<string, unknown>;
    try { data = (await res.json()) as Record<string, unknown>; } catch { throw new SlackApiError(method, "not_json", res.status, undefined, "maybe"); }
    if (data.ok !== true) throw new SlackApiError(method, String(data.error ?? "unknown_error"), res.status, undefined, "no");
    return data;
  }

  /** A reply through the response_url Slack gave a command or a press. Only Slack's own hooks are followed. */
  async respond(url: string, body: Record<string, unknown>): Promise<void> {
    if (!/^https:\/\/hooks\.slack\.com\//.test(url)) throw new SlackApiError("response_url", "not_a_slack_url", 0, undefined, "no");
    let res: Response;
    try { res = await this.fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
    catch { throw new SlackApiError("response_url", "network", 0, undefined, "maybe"); }
    if (res.status === 429) throw new SlackApiError("response_url", "ratelimited", 429, Number(res.headers.get("retry-after") ?? "1") || 1, "no");
    if (!res.ok) throw new SlackApiError("response_url", res.status >= 500 ? "service_unavailable" : "refused", res.status, undefined, res.status >= 500 ? "maybe" : "no");
  }
}
