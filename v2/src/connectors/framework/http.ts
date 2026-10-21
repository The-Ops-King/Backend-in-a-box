import { PortError } from "@/engine/ports";

/**
 * The HTTP layer every connector calls a vendor through. `fetch` is given, never global: production passes the real one,
 * tests a fake (fake-http.ts) that answers from recorded or constructed payloads and never leaves the process.
 *
 * The retry policy, the same for every vendor (the blueprint's "retry policy per connector"):
 * - 429: waited out (Retry-After when the vendor says, else jittered backoff), then tried again;
 * - 5xx and a timeout: a read is tried again with jittered backoff. A write may have been done: it is never sent again
 *   blind. When the connector can re-read whether it took effect (`confirm`), it does: done is success, not done is
 *   tried again; when it cannot, the call is `ambiguous` and the outbox marks it unknown, never re-sent;
 * - a request that never left (connection refused) is tried again, read or write;
 * - after the last try, transient: the dispatcher tries again later with its own backoff.
 * Everything else is the caller's to read (`failFor` classes a refusal).
 */

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type HttpDeps = {
  fetch: Fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** 0 to 1, for jitter. */
  random: () => number;
};

export type Res = { status: number; headers: Headers; text: string; body: unknown };
export type Outcome = { res: Res } | { confirmed: unknown };

export type Policy = { tries?: number; baseMs?: number; maxWaitMs?: number; timeoutMs?: number };
export const DEFAULT_POLICY: Required<Policy> = { tries: 3, baseMs: 500, maxWaitMs: 30_000, timeoutMs: 25_000 };

/** A request that never reached the vendor (refused, no route) as against one that may have (a timeout after sending). */
export class TransportError extends Error {
  constructor(message: string, public sent: boolean) { super(message); this.name = "TransportError"; }
}

const parse = (text: string): unknown => { if (!text) return {}; try { return JSON.parse(text); } catch { return text; } };

/** One attempt: the request, cut off at the timeout. A timeout is a request that may have been done. */
export async function attemptOnce(d: HttpDeps, url: string, init: RequestInit, timeoutMs: number): Promise<Res> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await d.fetch(url, { ...init, signal: ctl.signal });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, body: parse(text) };
  } catch (e) {
    if (e instanceof TransportError) throw e;
    const err = e as { name?: string; code?: string; cause?: { code?: string }; message?: string };
    const code = err.code ?? err.cause?.code;
    if (code && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET_BEFORE_SEND"].includes(code)) throw new TransportError(`${code}: ${err.message ?? ""}`, false);
    if (err.name === "AbortError" || err.name === "TimeoutError") throw new TransportError(`no answer after ${timeoutMs / 1000}s (it may have been done)`, true);
    throw new TransportError(err.message ?? String(e), true);
  } finally {
    clearTimeout(timer);
  }
}

export const jittered = (baseMs: number, n: number, random: () => number) => Math.round(baseMs * 2 ** (n - 1) * (0.5 + random()));

function retryAfterMs(h: Headers): number | undefined {
  const v = h.get("retry-after");
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s)) return s * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now());
}

/**
 * Runs `attempt` under the retry policy. `write`: the request changes something at the vendor. `confirm`: re-reads
 * whether a write that may have been done was done (undefined: not done; anything else: done, and what it made).
 */
export async function withPolicy(d: HttpDeps, vendor: string, attempt: () => Promise<Res>, o: { write: boolean; confirm?: () => Promise<unknown>; policy?: Policy }): Promise<Outcome> {
  const p = { ...DEFAULT_POLICY, ...o.policy };
  let last = "";
  for (let n = 1; n <= p.tries; n++) {
    let maybeDone = false;
    try {
      const res = await attempt();
      if (res.status < 400) return { res };
      if (res.status === 429) {
        const wait = retryAfterMs(res.headers) ?? jittered(p.baseMs, n, d.random);
        if (wait > p.maxWaitMs) throw new PortError("transient", `${vendor} rate limited for ${Math.round(wait / 1000)}s`, 429);
        last = `${vendor} 429`;
        if (n < p.tries) await d.sleep(wait);
        continue;
      }
      if (res.status < 500) return { res };
      last = `${vendor} ${res.status}: ${res.text.slice(0, 200)}`;
      maybeDone = o.write;
    } catch (e) {
      if (!(e instanceof TransportError)) throw e;
      last = `${vendor}: ${e.message}`;
      maybeDone = o.write && e.sent;
    }
    if (maybeDone) {
      if (!o.confirm) throw new PortError("ambiguous", `${last}; it may or may not have been done, and it is not sent again`);
      const done = await o.confirm();
      if (done !== undefined) return { confirmed: done };
    }
    if (n < p.tries) await d.sleep(jittered(p.baseMs, n, d.random));
  }
  throw new PortError("transient", `${last} (after ${p.tries} tries)`);
}

/** The class of a vendor's refusal (a 4xx the caller did not handle). */
export function failFor(vendor: string, res: Res, what: string): PortError {
  const said = res.text.slice(0, 300);
  if (res.status === 401) return new PortError("auth", `${vendor} refused the token on ${what}: ${said}`, 401);
  if (res.status === 403) {
    // Cloudflare in front of GHL refuses some clients outright (error 1010): not the token, the client
    if (/\b1010\b/.test(said)) return new PortError("permanent", `${vendor} refused the client (Cloudflare 1010) on ${what}: its user agent was blocked`, 403);
    return new PortError("auth", `${vendor} refused ${what} (403: the token lacks a scope or access): ${said}`, 403);
  }
  return new PortError("permanent", `${vendor} ${res.status} on ${what}: ${said}`, res.status);
}

/** The response of a call that went through, or the vendor's refusal as a PortError. */
export function okOr(vendor: string, out: Outcome, what: string): Res | { confirmed: unknown } {
  if ("confirmed" in out) return out;
  if (out.res.status >= 400) throw failFor(vendor, out.res, what);
  return out.res;
}

export const realHttp = (): HttpDeps => ({ fetch: (u, i) => fetch(u, i), now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random });
