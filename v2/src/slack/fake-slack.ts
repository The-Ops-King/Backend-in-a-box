import type { SlackFetch } from "./api";

/**
 * A fake Slack Web API for tests: a fetch that answers the methods the platform calls, records every call (method, token,
 * body) and plays back scripted failures (an HTTP status, a Slack error code, a 429 with Retry-After, a network failure
 * before or after sending). Nothing reaches Slack.
 */
export type FakeCall = { method: string; token: string | null; body: Record<string, unknown>; url: string };
type Failure = { method: string; times: number; status?: number; error?: string; retryAfter?: number; network?: "before" | "after" };

export class FakeSlack {
  calls: FakeCall[] = [];
  /** What oauth.v2.access answers (a code exchange or a token refresh). */
  oauth: (args: Record<string, string>) => Record<string, unknown> = (a) => (a.grant_type === "refresh_token"
    ? { ok: true, access_token: "xoxe.xoxb-refreshed", refresh_token: "xoxe-1-refreshed", expires_in: 43200, token_type: "bot" }
    : { ok: true, access_token: "xoxe.xoxb-1", refresh_token: "xoxe-1-r", expires_in: 43200, token_type: "bot", scope: "chat:write,commands", bot_user_id: "UBOT", app_id: "A1", team: { id: "T1", name: "Acme" }, authed_user: { id: "UADMIN" } });
  /** The messages as Slack holds them now (posted, then edited), by channel and ts. */
  messages = new Map<string, { channel: string; ts: string; text: string; blocks: unknown[]; threadTs?: string; reactions: string[] }>();
  message(channel: string, ts: string) { return this.messages.get(`${channel}:${ts}`); }
  private failures: Failure[] = [];
  private n = 0;

  failNext(f: Omit<Failure, "times"> & { times?: number }) { this.failures.push({ ...f, times: f.times ?? 1 }); }

  /** Successful calls to a method, in order. */
  ok(method: string): FakeCall[] { return this.calls.filter((c) => c.method === method && !(c as { failed?: boolean }).failed); }
  bodies(method: string): Record<string, unknown>[] { return this.ok(method).map((c) => c.body); }

  fetch: SlackFetch = async (url, init) => {
    const hook = url.startsWith("https://hooks.slack.com/");
    const method = hook ? "response_url" : url.replace(/^.*\/api\//, "");
    const token = init.headers.authorization?.replace(/^Bearer /, "") ?? null;
    const body = init.headers["content-type"]?.startsWith("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(init.body)) : (JSON.parse(init.body || "{}") as Record<string, unknown>);
    const call: FakeCall & { failed?: boolean } = { method, token, body, url };
    this.calls.push(call);
    const i = this.failures.findIndex((f) => f.method === method || f.method === "*");
    if (i >= 0) {
      const f = this.failures[i]!;
      if (--f.times <= 0) this.failures.splice(i, 1);
      call.failed = true;
      if (f.network) throw Object.assign(new Error("fetch failed"), { cause: { code: f.network === "before" ? "ECONNREFUSED" : "UND_ERR_SOCKET" } });
      if (f.status === 429) return new Response("", { status: 429, headers: { "retry-after": String(f.retryAfter ?? 1) } });
      if (f.status && f.status >= 500) return new Response("upstream", { status: f.status });
      return json({ ok: false, error: f.error ?? "unknown_error" });
    }
    if (hook) return new Response("ok", { status: 200 });
    switch (method) {
      case "oauth.v2.access": return json(this.oauth(body as Record<string, string>));
      case "chat.postMessage": {
        const ts = this.ts(), channel = String(body.channel);
        this.messages.set(`${channel}:${ts}`, { channel, ts, text: String(body.text ?? ""), blocks: (body.blocks as unknown[]) ?? [], ...(body.thread_ts ? { threadTs: String(body.thread_ts) } : {}), reactions: [] });
        return json({ ok: true, channel, ts, message: { text: body.text } });
      }
      case "chat.update": {
        const m = this.message(String(body.channel), String(body.ts));
        if (!m) return json({ ok: false, error: "message_not_found" });
        m.text = String(body.text ?? m.text); if (body.blocks) m.blocks = body.blocks as unknown[];
        return json({ ok: true, channel: body.channel, ts: body.ts });
      }
      case "conversations.history": case "conversations.replies": {
        const want = String(body.latest ?? body.ts ?? "");
        const m = this.message(String(body.channel), want);
        return json({ ok: true, messages: m ? [{ ts: m.ts, text: m.text, blocks: m.blocks }] : [] });
      }
      case "chat.postEphemeral": return json({ ok: true, message_ts: this.ts() });
      case "reactions.add": case "reactions.remove": {
        const m = this.message(String(body.channel), String(body.timestamp));
        if (m && method === "reactions.add") { if (m.reactions.includes(String(body.name))) return json({ ok: false, error: "already_reacted" }); m.reactions.push(String(body.name)); }
        if (m && method === "reactions.remove") { if (!m.reactions.includes(String(body.name))) return json({ ok: false, error: "no_reaction" }); m.reactions = m.reactions.filter((r) => r !== body.name); }
        return json({ ok: true });
      }
      case "conversations.open": return json({ ok: true, channel: { id: `D${String((body.users as string) ?? "").replace(/^U/, "")}` } });
      case "views.open": return json({ ok: true, view: { id: `V${++this.n}` } });
      case "auth.test": return json({ ok: true, team_id: "T1", user_id: "UBOT" });
      default: return json({ ok: false, error: "unknown_method" });
    }
  };

  private ts() { return `17000000${String(++this.n).padStart(2, "0")}.000${String(this.n).padStart(3, "0")}`; }
}

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
