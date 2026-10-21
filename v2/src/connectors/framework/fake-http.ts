import { type Fetch, type HttpDeps, TransportError } from "./http";

/**
 * A fake HTTP layer for connector tests: routes answer from recorded or constructed payloads, every request is kept,
 * and nothing leaves the process. A route can be answered once (a 429, then the real answer), made to time out after
 * the vendor received it (`sent`), or refused before it left.
 */

export type FakeRequest = { method: string; url: string; host: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: unknown; raw: string | undefined; at: Date };
export type FakeReply = { status?: number; body?: unknown; headers?: Record<string, string> } | { timeout: true; sent: boolean } | { refused: true };
type Handler = (req: FakeRequest) => FakeReply | Promise<FakeReply>;
type Route = { method: string; path: RegExp | string; handler: Handler; once: boolean };

const matches = (r: Route, method: string, path: string) =>
  (r.method === "*" || r.method === method) && (typeof r.path === "string" ? r.path === path : r.path.test(path));

export class FakeHttp {
  requests: FakeRequest[] = [];
  waits: number[] = [];
  private routes: Route[] = [];
  private t: number;

  constructor(start = "2026-10-26T14:00:00Z") { this.t = Date.parse(start); }

  now = () => new Date(this.t);
  /** The fake clock moves on by what was slept, so a rate limit's wait is time that passed. */
  sleep = async (ms: number) => { this.waits.push(ms); this.t += ms; };
  advance(ms: number) { this.t += ms; }
  setNow(iso: string | Date) { this.t = typeof iso === "string" ? Date.parse(iso) : iso.getTime(); }

  /** Answers every matching request (the newest matching route wins). */
  on(method: string, path: RegExp | string, handler: Handler | FakeReply): this {
    const firstStanding = this.routes.findIndex((r) => !r.once);
    this.routes.splice(firstStanding < 0 ? this.routes.length : firstStanding, 0, { method, path, handler: typeof handler === "function" ? handler : () => handler, once: false });
    return this;
  }
  /** Answers the next matching request only, ahead of the standing routes; several are used in the order given. */
  once(method: string, path: RegExp | string, handler: Handler | FakeReply): this {
    const firstStanding = this.routes.findIndex((r) => !r.once);
    this.routes.splice(firstStanding < 0 ? this.routes.length : firstStanding, 0, { method, path, handler: typeof handler === "function" ? handler : () => handler, once: true });
    return this;
  }

  /** Requests to a path (and method). */
  to(method: string, path: RegExp | string): FakeRequest[] {
    return this.requests.filter((r) => (method === "*" || r.method === method) && (typeof path === "string" ? r.path === path : path.test(r.path)));
  }

  fetch: Fetch = async (url, init) => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit | undefined).forEach((v, k) => { headers[k] = v; });
    const raw = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : undefined;
    let body: unknown = raw;
    if (raw && (headers["content-type"] ?? "").includes("json")) { try { body = JSON.parse(raw); } catch { /* kept raw */ } }
    if (raw && (headers["content-type"] ?? "").includes("x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(raw));
    const method = (init.method ?? "GET").toUpperCase();
    const req: FakeRequest = { method, url, host: u.host, path: u.pathname, query: u.searchParams, headers, body, raw, at: this.now() };
    const i = this.routes.findIndex((r) => matches(r, method, u.pathname));
    if (i < 0) { this.requests.push(req); return new Response(JSON.stringify({ message: `no fake route for ${method} ${u.pathname}` }), { status: 404, headers: { "content-type": "application/json" } }); }
    const route = this.routes[i]!;
    if (route.once) this.routes.splice(i, 1);
    const reply = await route.handler(req);
    if ("refused" in reply) throw new TransportError("ECONNREFUSED (fake)", false);
    this.requests.push(req);
    if ("timeout" in reply) throw new TransportError("no answer (fake timeout)", reply.sent);
    const text = reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text === "" ? null : text, { status: reply.status ?? 200, headers: { "content-type": "application/json", ...(reply.headers ?? {}) } });
  };

  deps(random = () => 0.5): HttpDeps { return { fetch: this.fetch, now: this.now, sleep: this.sleep, random }; }
}
