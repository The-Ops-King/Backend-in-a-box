/**
 * The operator's session: one password (DASHBOARD_PASSWORD), a signed cookie that says "signed in until <when>".
 * Web Crypto so the same code runs in the edge middleware and in a route. The closer's end-of-day link is not a session:
 * its token is the door, and it opens on that page only.
 */
export const COOKIE = "bib_session";
export const SESSION_DAYS = 30;

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

export const sessionSecret = (env: Record<string, string | undefined> = process.env) => env.SESSION_SECRET || env.CRON_SECRET || "";
export const dashboardPassword = (env: Record<string, string | undefined> = process.env) => env.DASHBOARD_PASSWORD || "";

/** A token for a session that ends `days` from now. */
export async function issueSession(secret: string, now = Date.now(), days = SESSION_DAYS): Promise<string> {
  const exp = String(now + days * 86_400_000);
  return `${exp}.${await hmac(secret, exp)}`;
}

/** True when the token was signed with this secret and has not expired. */
export async function verifySession(token: string | undefined | null, secret: string, now = Date.now()): Promise<boolean> {
  if (!token || !secret) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false;
  const want = await hmac(secret, exp);
  if (want.length !== sig.length) return false;
  let diff = 0; for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** Constant-time compare of the typed password with the configured one. */
export function passwordMatches(typed: string, configured: string): boolean {
  if (!configured || typed.length !== configured.length) return false;
  let diff = 0; for (let i = 0; i < typed.length; i++) diff |= typed.charCodeAt(i) ^ configured.charCodeAt(i);
  return diff === 0;
}

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) { const [k, ...v] = part.trim().split("="); if (k === name) return decodeURIComponent(v.join("=")); }
  return undefined;
}

/** Paths that have their own door: the clock, the admin endpoints, the webhooks, the closer's link, the login itself, the app shell. */
export function openPath(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/app") || pathname.startsWith("/eod/") || pathname.startsWith("/api/eod/")
    || pathname.startsWith("/api/tick") || pathname.startsWith("/api/admin") || pathname.startsWith("/api/webhooks") || pathname === "/api/health"
    || pathname === "/api/v1/session" || pathname.startsWith("/_next") || pathname === "/favicon.ico";
}
